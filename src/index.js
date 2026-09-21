// dsh-second-engine —— DeepSeek Harness 的 Codex 二元引擎插件。
//
// 进程内提供：设置页所需的 HTTP API（经 webServer 注册为 exact 路由）
//   GET    /second-engine/api/status            引擎/密钥/会话占用概览
//   GET    /second-engine/api/providers         提供方列表（apiKey 脱敏）+ active
//   POST   /second-engine/api/providers         新增自定义提供方
//   POST   /second-engine/api/providers/key     设置指定提供方 apiKey（keyring 0600）
//   POST   /second-engine/api/providers/active  切换激活并生成 config.toml（先备份）
//   POST   /second-engine/api/providers/delete  删除自定义提供方（预设不可删）
//   POST   /second-engine/api/providers/update  编辑提供方（apiKey 省略=不改；active 改地址/模型时重写 config.toml）
//   POST   /second-engine/api/models            拉取该提供方 /models 模型清单（缺省 active）
//   POST   /second-engine/api/model             更新该提供方 model（active 时重写 config.toml）
//   POST   /second-engine/api/key               兼容旧面板：给预设提供方写 key
//   POST   /second-engine/api/cleanup           按 mtime 清理旧会话 *.jsonl
//   POST   /second-engine/api/task              下发异步工单（后台 codex exec，完成弹 App 通知）
//   GET    /second-engine/api/task?id=          单条工单全量（含 output）
//   GET    /second-engine/api/tasks             最近 10 条工单摘要（不含 output）
//   POST   /second-engine/api/task/cancel       取消运行中的工单（SIGTERM）
//   POST   /second-engine/api/review            双向互审：对产出做多轮批判性复核（kind:'review'）
//   POST   /second-engine/api/review/cancel     熔断取消复核任务（SIGTERM）
//   GET    /second-engine/api/config            读插件配置（复核轮数 reviewRounds）
//   POST   /second-engine/api/config            写插件配置 { reviewRounds: 1|3|5 }
//   POST   /second-engine/api/consult           Codex 卡点求助入队（内存 20 条 + 弹 App 通知）
//   GET    /second-engine/api/consults          求助列表（不脱敏，给主 AI 收卷）
// 以及 rc.7 插件自有设置表面：settings 命名空间 'second-engine'（keepDays）与
// llm 的可配置 provider 目录条目，二者缺一浏览器端设置页都不渲染本插件面板。
// 请求体与响应均为 JSON，handler 用原生 node:req/res 风格。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createBridgeServer } from './bridge.js'

export const name = 'second-engine'

const CODEX_DIR = join(homedir(), '.codex')
const CODEX_BINARY = '/usr/local/bin/codex'
const CONFIG_PATH = join(CODEX_DIR, 'config.toml')
const KEYRING_PATH = join(CODEX_DIR, 'keyring.json')
const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

const CONFIG_BACKUP_PATH = join(CODEX_DIR, 'config.toml.bak-se')

// 首次初始化写入的三家预设（apiKey 空，待设置页填写）。
const PRESET_PROVIDERS = [
  // DeepSeek 官方文档实证的上下文/输出上限，写 config.toml 顶层（见 writeCodexConfig）。
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', model: 'deepseek-flash', contextWindow: 1048576, maxOutput: 393216 },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/v1', wireApi: 'responses', model: 'glm-4.6' },
  { id: 'yun', name: '云知声', baseUrl: 'https://maas-api.unisound.com/v1', wireApi: 'completions', model: 'u2-flash' },
]
const PRESET_IDS = new Set(PRESET_PROVIDERS.map((p) => p.id))
const DEFAULT_ACTIVE = PRESET_PROVIDERS[0].id
// Codex 侧永远讲 Responses（config.toml 的 wire_api 恒为它），
// 'completions' 提供方由本地翻译桥转接（见 ensureBridge）。
const WIRE_API = 'responses'
const SUPPORTED_WIRE_APIS = new Set(['responses', 'completions'])
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

// ── 异步工单 ──
// 进程内任务表：{ id, status:'running'|'done'|'error', exitCode, output, startedAt, endedAt, workdir }。
// 另外挂 child（进程句柄，取消用）与 outPath（-o 落点，读完输出后删除）；这两项不外发。
const tasks = new Map()
const DEFAULT_TASK_WORKDIR = '/root/proj'
const TASK_LIST_LIMIT = 10
const TASK_KEEP_LIMIT = 50

// ── Codex 卡点求助（consult）──
// 进程内队列：{ id, from, task, stuckContext, at }。只留最近 20 条，主 AI 定期收卷。
// 不落盘、不脱敏：这里是两个引擎之间的内部信道，不是给用户的展示面。
const consults = []
const CONSULT_KEEP_LIMIT = 20

const NOTIFY_URL = 'http://127.0.0.1:3090/app/notify'
const NOTIFY_TOKEN_PATH = '/root/.dsh/.bridge_token'
const NOTIFY_TIMEOUT_MS = 3000

// ── 双向互审（review）──
// 每轮以固定模板要求独立复核引擎输出 JSON；轮数默认 3、上限 5。
const REVIEW_DEFAULT_ROUNDS = 3
const REVIEW_MIN_ROUNDS = 1
const REVIEW_MAX_ROUNDS = 5
// 设置页可选轮数（GET/POST /api/config 的白名单，仅这三档）。
const REVIEW_ROUNDS_CHOICES = [1, 3, 5]
const REVIEW_TEMPLATE = '你是独立复核引擎。批判性审查以下产出：找自洽却错误的推理、漏掉的边界条件、更优备选。输出 JSON: {issues:[{severity,point,suggestion}], verdict}'
// 看门狗：每 30s 探一次 -o 输出文件 mtime，超 300s 无变化即标疑似停滞并通知。
const WATCHDOG_INTERVAL_MS = 30000
const WATCHDOG_STALL_MS = 300000
// 解析失败时回显的原始输出上限，避免把超长文本灌进任务表。
const REVIEW_RAW_CLIP = 2000

// 保留天数（设置页 keepDays）：宿主 settings 文档是持久真值，这里只放默认值。
const DEFAULT_KEEP_DAYS = 7
const MIN_KEEP_DAYS = 1
const MAX_KEEP_DAYS = 365

// 本插件的 settings 命名空间 scope，设置服务可用时才有值。
let secondEngineSettingsScope = null
// 进程内缓存的 keepDays 默认值（由 settings watch 镜像），供 /api/cleanup 兜底。
let keepDaysDefault = DEFAULT_KEEP_DAYS

// 本插件没有独立配置文件（settings 文档就是持久真值），因此 base 用默认值；
// 将来若引入 config.json，只需改这一个函数。
function readConfig() {
  return { keepDays: DEFAULT_KEEP_DAYS }
}

// ── node:http 小工具（同 guard 写法）──
const errMsg = (e) => (e && e.message) ? e.message : String(e)

function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// ── 本地状态探测 ──
// 当前 active 提供方的 apiKey 是否已配置。
function keyConfigured() {
  try {
    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    return active !== undefined && active.apiKey.trim() !== ''
  } catch {
    return false
  }
}

// sessions 目录总字节（递归；读不到的条目按 0 计，绝不抛错）
function sessionsBytes(dir = SESSIONS_DIR) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += sessionsBytes(full)
      else if (entry.isFile()) total += statSync(full).size
      else if (entry.isSymbolicLink()) total += statSync(full).size
    } catch { /* 忽略瞬时错误 */ }
  }
  return total
}

// 脱敏预览：前 6 后 4；过短的 key 只留首尾各 2 位
function maskKey(key) {
  if (key.length <= 10) return `${key.slice(0, 2)}****${key.slice(-2)}`
  return `${key.slice(0, 6)}****${key.slice(-4)}`
}

// ── keyring（多提供方）──
// 形状：{ providers: [{ id, name, baseUrl, wireApi, apiKey, model }], active: '<id>', reviewRounds }
// reviewRounds 是本插件唯一落盘的配置项（复核轮数 1|3|5），随 keyring 一起读写。

function presetProviders() {
  return PRESET_PROVIDERS.map((p) => ({ ...p, apiKey: '' }))
}

// 归一化单条 provider：缺字段补默认值，调用方拿到的形状始终稳定。
function normalizeProvider(raw) {
  const provider = {
    id: typeof raw?.id === 'string' ? raw.id : '',
    name: typeof raw?.name === 'string' ? raw.name : '',
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl : '',
    wireApi: typeof raw?.wireApi === 'string' ? raw.wireApi : WIRE_API,
    model: typeof raw?.model === 'string' ? raw.model : '',
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
  }
  // 可选模型元数据（预设提供方才有）：存在才带上，写入 config.toml 顶层。
  if (Number.isFinite(raw?.contextWindow)) provider.contextWindow = Math.floor(raw.contextWindow)
  if (Number.isFinite(raw?.maxOutput)) provider.maxOutput = Math.floor(raw.maxOutput)
  return provider
}

function saveKeyring(doc) {
  mkdirSync(CODEX_DIR, { recursive: true })
  writeFileSync(KEYRING_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  chmodSync(KEYRING_PATH, 0o600)
}

// 复核轮数：只认 1/3/5，其余（含缺失、非法、字符串数字以外的垃圾值）一律回落默认 3。
function normalizeReviewRounds(value) {
  const n = Number(value)
  return REVIEW_ROUNDS_CHOICES.includes(n) ? n : REVIEW_DEFAULT_ROUNDS
}

// ── Codex 协作协议（AGENTS.md 自动写入）──
// 让 Codex 拥有「卡点求助本能」：连续失败/绕圈时主动调 /api/consult。幂等：带标记则跳过。
const AGENTS_MARK = '<!-- dsh-second-engine:v1 -->'
const AGENTS_SECTION = `${AGENTS_MARK}
# Codex 全局协作协议（by dsh-second-engine）

你是「第二引擎」，与主 AI（DSH）互为伙伴。卡点自救协议：
- 同一路径/命令连续失败 3 次以上、或在绕圈、或缺信息/权限无法自行获取时，必须主动求助而非硬试：
  curl -s -X POST http://127.0.0.1:3080/second-engine/api/consult -H 'Content-Type: application/json' \\
    -d '{"from":"codex","task":"<当前任务一句话>","stuckContext":"<试过什么、错在哪、需要什么>"}'
  提交后正常结束会话（输出已有成果），主 AI 会带建议回来。
- 若 HTTP 不通，在最终输出末尾追加一行：[CONSULT-NEEDED] <卡点描述>。
- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。
`
function ensureAgentsProtocol() {
  try {
    const path = join(CODEX_DIR, 'AGENTS.md')
    let existing = ''
    try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则新建 */ }
    if (existing.includes(AGENTS_MARK)) return
    const merged = existing.endsWith('\n') || existing === '' ? existing + AGENTS_SECTION : existing + '\n\n' + AGENTS_SECTION
    writeFileSync(path, merged, 'utf8')
    chmodSync(path, 0o600)
  } catch { /* best effort：写入失败不阻断插件启动 */ }
}

// 读取并归一化 keyring：
//   - 文件缺失/不可解析 → 首次初始化：写入两家预设（apiKey 空）
//   - 旧格式 { provider: 'deepseek'|'zhipu', key } → 迁移为对应预设的 apiKey
//   - 新格式 → 归一化，并保证两家预设始终在列
//   - 三种路径都带上 reviewRounds：handler 里 saveKeyring(loadKeyring()) 才不会把它写丢。
function loadKeyring() {
  let doc = null
  try {
    doc = JSON.parse(readFileSync(KEYRING_PATH, 'utf8'))
  } catch { doc = null }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const fresh = { providers: presetProviders(), active: DEFAULT_ACTIVE, reviewRounds: REVIEW_DEFAULT_ROUNDS }
    try { saveKeyring(fresh) } catch { /* 只读降级：内存里照常可用 */ }
    return fresh
  }

  if (!Array.isArray(doc.providers)) {
    const id = PRESET_IDS.has(doc.provider) ? doc.provider : DEFAULT_ACTIVE
    const providers = presetProviders()
    const target = providers.find((p) => p.id === id)
    if (typeof doc.key === 'string') target.apiKey = doc.key.trim()
    const migrated = { providers, active: id, reviewRounds: normalizeReviewRounds(doc.reviewRounds) }
    try { saveKeyring(migrated) } catch { /* 迁移落盘失败不阻断读取 */ }
    return migrated
  }

  const providers = doc.providers.map(normalizeProvider).filter((p) => p.id !== '')
  for (const preset of PRESET_PROVIDERS) {
    const existing = providers.find((p) => p.id === preset.id)
    if (existing === undefined) {
      providers.push({ ...preset, apiKey: '' })
      continue
    }
    // 升级回填：旧 keyring 里的预设条目没有模型元数据，用代码内实证值补齐（只补缺，不覆盖）。
    if (preset.contextWindow !== undefined && existing.contextWindow === undefined) existing.contextWindow = preset.contextWindow
    if (preset.maxOutput !== undefined && existing.maxOutput === undefined) existing.maxOutput = preset.maxOutput
  }
  const active = providers.some((p) => p.id === doc.active) ? doc.active : DEFAULT_ACTIVE
  return { providers, active, reviewRounds: normalizeReviewRounds(doc.reviewRounds) }
}

// 对外视图：apiKey 只暴露 { configured, preview }，绝不回显明文。
function providerView(p) {
  const configured = p.apiKey.trim() !== ''
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    wireApi: p.wireApi,
    model: p.model,
    apiKey: { configured, preview: configured ? maskKey(p.apiKey) : '' },
  }
}

function invalidIdError(id) {
  if (id === '') return 'id 不能为空'
  if (!ID_PATTERN.test(id)) return 'id 必须以小写字母开头，且只含小写字母、数字、下划线或连字符'
  return null
}

// 接受 'responses'（直连）与 'completions'（经本地翻译桥）；其余取值拒绝。
function wireApiError(value) {
  if (value === undefined || value === null || value === '') return null
  if (SUPPORTED_WIRE_APIS.has(value)) return null
  return `wireApi 只支持 'responses'（直连）或 'completions'（经本地桥），收到 '${value}'`
}

// ── config.toml 生成 ──
// TOML 基本字符串转义，并压掉换行避免注入额外键。
function tomlString(value) {
  return `"${String(value).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// 首次写入前把原始 config.toml 备份为 config.toml.bak-se；已存在则跳过、绝不覆盖。
function backupConfig() {
  try {
    if (existsSync(CONFIG_PATH) && !existsSync(CONFIG_BACKUP_PATH)) {
      copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH)
      chmodSync(CONFIG_BACKUP_PATH, 0o600)
    }
  } catch { /* 备份失败不阻断切换（best effort） */ }
}

// ── 翻译桥生命周期 ──
// 进程内只保留一座桥：wireApi==='completions' 的提供方每次激活都会重建
// （旧桥先 close，避免端口/回调残留在旧提供方上）。
let bridgeServer = null
let bridgeBaseUrl = ''

// 关闭当前桥（幂等；可安全用于 dispose / process 退出钩子）。
function closeBridge() {
  const server = bridgeServer
  bridgeServer = null
  bridgeBaseUrl = ''
  if (server === null) return
  try { server.close() } catch { /* 已关闭或从未监听成功 */ }
}

// 让 config.toml 指向正确的上游端点：
//   completions → 起本地桥（127.0.0.1 随机端口），Codex 连桥、桥转 chat；
//   responses   → 关掉旧桥，直连 provider.baseUrl。
// 返回 { viaBridge, baseUrl }。
async function ensureBridge(provider) {
  if (provider.wireApi !== 'completions') {
    closeBridge()
    return { viaBridge: false, baseUrl: provider.baseUrl }
  }
  closeBridge()
  const server = createBridgeServer({ upstreamBaseUrl: provider.baseUrl, apiKey: provider.apiKey })
  try {
    // createBridgeServer 已发起 listen(0,'127.0.0.1')，等 'listening' 才拿得到端口。
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
    })
  } catch (e) {
    try { server.close() } catch { /* best effort */ }
    throw e
  }
  bridgeServer = server
  bridgeBaseUrl = `http://127.0.0.1:${server.address().port}`
  return { viaBridge: true, baseUrl: bridgeBaseUrl }
}

// 按 active 提供方生成 config.toml，返回使用的 env_key。
// base_url 写 ensureBridge 给出的端点（completions 时即本地桥）；
// wire_api 恒为 'responses'——Codex 只会说 Responses，协议差异由桥承担。
async function writeCodexConfig(provider) {
  mkdirSync(CODEX_DIR, { recursive: true })
  backupConfig()
  const target = await ensureBridge(provider)
  const envKey = `${provider.id.toUpperCase()}_API_KEY`
  const tableKey = ID_PATTERN.test(provider.id) ? provider.id : tomlString(provider.id)
  // 保留原 config.toml 的 sandbox_mode：本机 proot 实测仅 danger-full-access 可跑工具，绝不能在切换提供方时丢失
  let sandboxMode = 'danger-full-access'
  try {
    const m = /^sandbox_mode\s*=\s*"([^"]+)"/m.exec(readFileSync(CONFIG_PATH, 'utf8'))
    if (m) sandboxMode = m[1]
  } catch { /* 原文件不存在，用实证默认值 */ }
  const lines = [
    `model_provider = ${tomlString(provider.id)}`,
    `model = ${tomlString(provider.model)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
  ]
  // 模型元数据（预设提供方实证值）：Codex 顶层 model_context_window / model_max_output_tokens。
  if (Number.isFinite(provider.contextWindow)) {
    lines.push(`model_context_window = ${Math.floor(provider.contextWindow)}`)
    if (Number.isFinite(provider.maxOutput)) {
      lines.push(`model_max_output_tokens = ${Math.floor(provider.maxOutput)}`)
    }
  }
  lines.push(
    '',
    `[model_providers.${tableKey}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(target.baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `wire_api = ${tomlString(WIRE_API)}`,
    '',
  )
  writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf8')
  chmodSync(CONFIG_PATH, 0o600)
  return envKey
}

// ── API handlers ──
async function handleStatus(_req, res) {
  try {
    send(res, {
      ok: true,
      codexBinary: existsSync(CODEX_BINARY),
      configExists: existsSync(CONFIG_PATH),
      keyConfigured: keyConfigured(),
      sessionsBytes: sessionsBytes(),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 兼容旧面板：POST { provider, key } 等价于给该预设提供方设置 apiKey。
async function handleKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!PRESET_IDS.has(id)) {
      return send(res, { ok: false, error: 'provider 必须是 deepseek 或 zhipu' }, 400)
    }
    if (key === '') {
      return send(res, { ok: false, error: 'key 不能为空' }, 400)
    }
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    }
    target.apiKey = key
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(key) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /providers：列表（apiKey 脱敏）+ active。
async function handleProvidersList(_req, res) {
  try {
    const doc = loadKeyring()
    send(res, { ok: true, active: doc.active, providers: doc.providers.map(providerView) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers：新增自定义提供方。
async function handleProviderAdd(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

    const idErr = invalidIdError(id)
    if (idErr !== null) return send(res, { ok: false, error: idErr }, 400)
    const wireErr = wireApiError(body.wireApi)
    if (wireErr !== null) return send(res, { ok: false, error: wireErr }, 400)
    if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
    if (baseUrl === '') return send(res, { ok: false, error: 'baseUrl 不能为空' }, 400)

    const doc = loadKeyring()
    if (doc.providers.some((p) => p.id === id)) {
      return send(res, { ok: false, error: `提供方 '${id}' 已存在` }, 400)
    }
    const wireApi = typeof body.wireApi === 'string' && body.wireApi !== '' ? body.wireApi : WIRE_API
    const provider = { id, name, baseUrl, wireApi, model, apiKey }
    doc.providers.push(provider)
    saveKeyring(doc)
    send(res, { ok: true, active: doc.active, provider: providerView(provider) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/providers 同 path 两个方法：GET 列表 / POST 新增，其余 405。
async function handleProvidersRoot(req, res) {
  if (req.method === 'POST') return handleProviderAdd(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleProvidersList(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// POST /providers/key：设置指定提供方的 apiKey（文件保持 0600）。
async function handleProviderKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    target.apiKey = apiKey
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(apiKey) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/active：切换激活并提供 config.toml（写前备份一次）。
async function handleProviderActive(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    doc.active = id
    saveKeyring(doc)
    const envKey = await writeCodexConfig(target)
    send(res, { ok: true, active: id, configPath: CONFIG_PATH, backupPath: CONFIG_BACKUP_PATH, envKey })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/delete：核心默认（deepseek/zhipu）不可删；云知声与自定义项可删。删除 active 时回落并同步 config.toml。
const PROTECTED_IDS = new Set(['deepseek', 'zhipu'])
async function handleProviderDelete(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (PROTECTED_IDS.has(id)) {
      return send(res, { ok: false, error: `核心默认提供方 '${id}' 不允许删除（云知声与自定义项均可删）` }, 400)
    }
    const doc = loadKeyring()
    const index = doc.providers.findIndex((p) => p.id === id)
    if (index === -1) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    doc.providers.splice(index, 1)

    let configRegenerated = false
    if (doc.active === id) {
      doc.active = DEFAULT_ACTIVE
      const fallback = doc.providers.find((p) => p.id === DEFAULT_ACTIVE)
      if (fallback !== undefined) {
        await writeCodexConfig(fallback)
        configRegenerated = true
      }
    }
  saveKeyring(doc)
  send(res, { ok: true, active: doc.active, configRegenerated })
} catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/update：编辑既有提供方。apiKey 省略 = 不改，其余字段只更新出现的。
// 该提供方为 active 且 baseUrl/model 有变化时重写 config.toml（这两个值写在里面）。
async function handleProviderUpdate(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)

    // 先把请求里出现过的字段全部校验完再落盘，避免校验失败后半更新。
    const patch = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
      patch.name = name
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
      if (!/^https?:\/\//i.test(baseUrl)) {
        return send(res, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头' }, 400)
      }
      patch.baseUrl = baseUrl
    }
    if (body.model !== undefined) {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') return send(res, { ok: false, error: 'model 不能为空' }, 400)
      patch.model = model
    }
    // apiKey 省略 = 保持原值；显式传空串属于误用（不修改就不该带这个字段）。
    if (body.apiKey !== undefined) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空（不修改请省略该字段）' }, 400)
      patch.apiKey = apiKey
    }

    // updated 只列真正发生变化的字段；空数组 = 提交值与现值完全一致，不落盘。
    const updated = []
    for (const key of Object.keys(patch)) {
      if (target[key] !== patch[key]) {
        target[key] = patch[key]
        updated.push(key)
      }
    }
    if (updated.length > 0) saveKeyring(doc)

    let configRegenerated = false
    if (doc.active === id && (updated.includes('baseUrl') || updated.includes('model'))) {
      await writeCodexConfig(target)
      configRegenerated = true
    }
    send(res, { ok: true, id, updated, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /models 与 /model：模型获取与选择 ──

// 拼出 /models 端点：压掉 baseUrl 末尾斜杠，避免 '//models'。
function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

// 兼容两种实测返回格式：
//   OpenAI（DeepSeek）：{ object:'list', data:[{ id, ... }] }
//   Z.ai（智谱）：      { models:[{ id, display_name, ... }] }
// 取 id；无 id 时回落 display_name；顺带容忍纯字符串条目与重复项。
function extractModels(json) {
  const list = Array.isArray(json?.data)
    ? json.data
    : (Array.isArray(json?.models) ? json.models : [])
  const models = []
  for (const item of list) {
    let id = ''
    if (typeof item === 'string') id = item.trim()
    else if (item !== null && typeof item === 'object') {
      if (typeof item.id === 'string' && item.id !== '') id = item.id
      else if (typeof item.display_name === 'string') id = item.display_name
    }
    if (id !== '' && !models.includes(id)) models.push(id)
  }
  return models
}

// POST /models：body { id }（缺省 = active）。带 Bearer 拉取该提供方模型清单。
async function handleModels(req, res) {
  try {
    if (typeof fetch !== 'function') {
      return send(res, { ok: false, error: '当前 Node 运行时不支持 fetch（需要 Node 18+）' })
    }
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
    const doc = loadKeyring()
    const target = id === ''
      ? doc.providers.find((p) => p.id === doc.active)
      : doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id === '' ? doc.active : id}'` }, 404)
    }
    if (target.apiKey.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 尚未配置 apiKey` }, 400)
    }
    if (target.baseUrl.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 未配置 baseUrl` }, 400)
    }

    const url = modelsUrl(target.baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let json = null
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await r.text()
      try { json = JSON.parse(text) } catch { json = null }
      if (!r.ok) {
        const detail = json !== null && typeof json.error?.message === 'string' ? `：${json.error.message}` : ''
        return send(res, { ok: false, error: `GET ${url} 返回 HTTP ${r.status}${detail}` })
      }
    } catch (e) {
      return send(res, { ok: false, error: `请求 ${url} 失败：${errMsg(e)}` })
    } finally {
      clearTimeout(timer)
    }
    if (json === null) {
      return send(res, { ok: false, error: `GET ${url} 返回非 JSON 响应` })
    }
    send(res, { ok: true, id: target.id, models: extractModels(json) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /model：body { id, model }（id 缺省 = active）。写入 provider.model；
// 若该提供方正是 active，则同步重写 config.toml，使引擎立刻用上新模型。
async function handleProviderModel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (model === '') return send(res, { ok: false, error: 'model 不能为空' }, 400)
    const doc = loadKeyring()
    const target = id === ''
      ? doc.providers.find((p) => p.id === doc.active)
      : doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id === '' ? doc.active : id}'` }, 404)
    }
    target.model = model
    saveKeyring(doc)
    let configRegenerated = false
    if (target.id === doc.active) {
      await writeCodexConfig(target)
      configRegenerated = true
    }
    send(res, { ok: true, id: target.id, model, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 递归删除 sessions 下 mtime 早于 keepDays 天的 *.jsonl，统计数量与释放字节
function cleanupSessions(dir, cutoff, stats) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      cleanupSessions(full, cutoff, stats)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = statSync(full)
      if (info.mtimeMs >= cutoff) continue
      unlinkSync(full)
      stats.removed += 1
      stats.freedBytes += info.size
    } catch { /* 跳过无法删除的条目 */ }
  }
}

async function handleCleanup(req, res) {
  try {
    const body = await readBody(req)
    // 请求未带 keepDays 时用 settings 命名空间镜像来的默认值（客户端总会带上）。
    const keepDays = body.keepDays === undefined ? keepDaysDefault : Number(body.keepDays)
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      return send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
    }
    const stats = { removed: 0, freedBytes: 0 }
    cleanupSessions(SESSIONS_DIR, Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    // 把本次使用的保留天数回写到命名空间，使设置页卡片与本页一致（best effort）。
    if (secondEngineSettingsScope !== null) {
      try { void secondEngineSettingsScope.update({ keepDays: Math.floor(keepDays) }).catch(() => {}) } catch { /* settings 不可用时忽略 */ }
    }
    send(res, { ok: true, removed: stats.removed, freedBytes: stats.freedBytes })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /task、/tasks、/task/cancel：异步工单 ──

// 只要序列化安全的那部分（child/outPath/watchdog 绝不出进程）。
function taskView(task) {
  const view = {
    id: task.id,
    kind: task.kind === 'review' ? 'review' : 'task',
    status: task.status,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    workdir: task.workdir,
    output: typeof task.output === 'string' ? task.output : '',
  }
  if (view.kind === 'review') {
    // 互审进度：第 N/上限轮 + 每轮 {issues,verdict} 全量（issues 体量小，列表也带上，展开即见）。
    view.round = Number.isInteger(task.round) ? task.round : 0
    view.maxRounds = Number.isInteger(task.maxRounds) ? task.maxRounds : REVIEW_DEFAULT_ROUNDS
    view.verdict = typeof task.verdict === 'string' ? task.verdict : ''
    view.rounds = Array.isArray(task.rounds) ? task.rounds : []
  }
  if (task.stuckSuspect === true) view.stuckSuspect = true
  if (typeof task.error === 'string' && task.error !== '') view.error = task.error
  return view
}

// 摘要：不含 output（列表只给状态，全文按需点开再取）。
function taskSummary(task) {
  const view = taskView(task)
  delete view.output
  return view
}

// 任务表封顶，避免长时间运行后无限增长；只淘汰已结束的最旧条目。
function pruneTasks() {
  if (tasks.size <= TASK_KEEP_LIMIT) return
  const finished = [...tasks.values()]
    .filter((t) => t.endedAt !== null && t.endedAt !== undefined)
    .sort((a, b) => a.endedAt - b.endedAt)
  for (const victim of finished) {
    if (tasks.size <= TASK_KEEP_LIMIT) break
    tasks.delete(victim.id)
  }
}

// 看门狗：任务结束即清 interval（finalizeTask / finalizeReview 都会调用）。
function stopWatchdog(task) {
  if (task.watchdog === null || task.watchdog === undefined) return
  try { clearInterval(task.watchdog) } catch { /* best effort */ }
  task.watchdog = null
}

// -o 输出文件 mtime（毫秒）；文件还没生成时返回 null。
function outFileMtimeMs(outPath) {
  try { return statSync(outPath).mtimeMs } catch { return null }
}

// spawn 后启动：每 30s 看一次 -o 文件 mtime，超 300s 无变化 → stuckSuspect + 通知一次。
// 复核每轮换新的 outPath，检查时按 task.outPath 动态取值，故 interval 可跨越整个任务生命周期。
function startWatchdog(task) {
  if (task.watchdog !== null && task.watchdog !== undefined) return
  task.activityAt = Date.now()
  task.watchdog = setInterval(() => {
    try {
      if (task.endedAt !== null && task.endedAt !== undefined) { stopWatchdog(task); return }
      const mtime = task.outPath ? outFileMtimeMs(task.outPath) : null
      if (mtime !== null && mtime > task.activityAt) {
        task.activityAt = mtime
        task.stuckSuspect = false
        return
      }
      if (task.stuckSuspect === true) return
      if (Date.now() - task.activityAt >= WATCHDOG_STALL_MS) {
        task.stuckSuspect = true
        const label = task.kind === 'review' ? '复核' : '工单'
        notify(`${label} ${task.id.slice(-6)} 疑似停滞（>300s 无输出更新）`)
      }
    } catch { /* best effort：看门狗自身绝不抛错 */ }
  }, WATCHDOG_INTERVAL_MS)
  // 不因看门狗把宿主进程吊住。
  if (typeof task.watchdog.unref === 'function') task.watchdog.unref()
}

// 首次落定即返回 true（后续重复调用是 no-op），保证通知只发一次。
function finalizeTask(task, exitCode, status) {
  if (task.endedAt !== null && task.endedAt !== undefined) return false
  stopWatchdog(task)
  task.exitCode = exitCode
  task.status = status
  try { task.output = readFileSync(task.outPath, 'utf8') } catch { task.output = '' }
  try { unlinkSync(task.outPath) } catch { /* 文件可能本就没生成，忽略 */ }
  task.endedAt = Date.now()
  return true
}

// 完成/停滞通知：走本机 3090 桥的 /app/notify（token 鉴权）。3 秒超时，任何失败静默忽略。
function notify(text, title = '第二引擎') {
  try {
    let token = ''
    try { token = readFileSync(NOTIFY_TOKEN_PATH, 'utf8').trim() } catch { return }
    if (token === '') return
    const url = `${NOTIFY_URL}?token=${encodeURIComponent(token)}`
      + `&title=${encodeURIComponent(title)}`
      + `&text=${encodeURIComponent(text)}`
    const req = http.get(url, (resp) => { resp.resume() })
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => { try { req.destroy() } catch { /* best effort */ } })
    req.on('error', () => { /* 桥没开或拒绝连接：静默 */ })
  } catch { /* best effort */ }
}

function notifyTask(task) {
  const label = task.kind === 'review' ? '复核' : '任务'
  const exit = Number.isInteger(task.exitCode) ? ` (exit ${task.exitCode})` : ''
  notify(`${label} ${task.id.slice(-6)} ${task.status}${exit}`)
}

// 复核任务收尾：清看门狗、落 verdict/status，只落定一次。
function finalizeReview(task, status, verdict, error) {
  if (task.endedAt !== null && task.endedAt !== undefined) return false
  stopWatchdog(task)
  task.status = status
  task.verdict = verdict
  task.error = typeof error === 'string' ? error : ''
  task.endedAt = Date.now()
  return true
}

function queryParam(url, key) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key) || ''
  } catch { return '' }
}

// POST /task：body { prompt, workdir?, ephemeral? }。立刻返回 { ok, id }，任务后台跑。
async function handleTaskCreate(req, res) {
  try {
    const body = await readBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') return send(res, { ok: false, error: 'prompt 不能为空' }, 400)
    const workdir = typeof body.workdir === 'string' && body.workdir.trim() !== ''
      ? body.workdir.trim()
      : DEFAULT_TASK_WORKDIR
    if (!existsSync(workdir)) {
      return send(res, { ok: false, error: `workdir 不存在：${workdir}` }, 400)
    }
    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    if (active === undefined) return send(res, { ok: false, error: '没有可用的 active 提供方' }, 400)

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    const outPath = join(CODEX_DIR, `task-${id}.out`)
    const args = [
      'exec',
      '--skip-git-repo-check',
      ...(body.ephemeral === true ? ['--ephemeral'] : []),
      '-o', outPath,
      prompt,
    ]
    // 与面板写 key 时同一套 env_key 约定：<PROVIDER_ID 大写>_API_KEY。
    const envKey = `${active.id.toUpperCase()}_API_KEY`
    const child = spawn('codex', args, {
      cwd: workdir,
      env: { ...process.env, [envKey]: active.apiKey },
      // stdin 必须显式关闭：Codex exec 会等待 stdin EOF，默认 pipe 永不关闭 → 任务假死（CPU 0 实证）
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const task = {
      id,
      kind: 'task',
      status: 'running',
      exitCode: null,
      output: '',
      startedAt: Date.now(),
      endedAt: null,
      workdir,
      child,
      outPath,
      cancelled: false,
    }
    tasks.set(id, task)
    pruneTasks()
    startWatchdog(task)

    child.on('exit', (code) => {
      // 被取消的任务固定 error/-1；其余按真实退出码判定。
      const cancelled = task.cancelled === true
      const exitCode = cancelled ? -1 : (Number.isInteger(code) ? code : -1)
      const status = cancelled ? 'error' : (exitCode === 0 ? 'done' : 'error')
      // 取消是用户主动动作，收尾读 output，但不再打扰一次通知。
      if (finalizeTask(task, exitCode, status) && !cancelled) void notifyTask(task)
    })
    // spawn 失败（如二进制缺失）不触发 exit，这里兜底收尾。
    child.on('error', () => {
      if (finalizeTask(task, -1, 'error')) void notifyTask(task)
    })

    send(res, { ok: true, id })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /task?id=：单条全量（含 output）。
async function handleTaskGet(req, res) {
  try {
    const id = queryParam(req.url, 'id')
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    send(res, { ok: true, task: taskView(task) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /tasks：最近 10 条摘要（新→旧，不含 output）。
async function handleTaskList(_req, res) {
  try {
    const list = [...tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, TASK_LIST_LIMIT)
      .map(taskSummary)
    send(res, { ok: true, tasks: list })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /task/cancel：body { id }。SIGTERM 后按约定标 error/-1（exit 回调不再重复收尾）。
async function handleTaskCancel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    if (task.status !== 'running') {
      return send(res, { ok: false, error: `任务已结束（${task.status}），无需取消` }, 400)
    }
    // 立刻落定状态（用户看到反馈不必等子进程真的退出）；
    // output 留给 exit 回调收尾，那样能拿到进程退出前的完整输出。
    task.cancelled = true
    task.status = 'error'
    task.exitCode = -1
    try { task.child.kill('SIGTERM') } catch { /* 进程可能刚好自己退出 */ }
    send(res, { ok: true, id, status: task.status, exitCode: task.exitCode })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /review、/review/cancel：双向互审 ──
// 两引擎相互批判性复核：每轮把同一份 content 交给独立复核引擎，只累加 issues 对照，
// 不做自动改写（v1 语义）；issues 清空即收敛，轮数到顶即打包交用户裁决。

const clipText = (text, limit = REVIEW_RAW_CLIP) => {
  const str = String(text === undefined || text === null ? '' : text)
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}

// 宽松解析：从自由文本里截取「首个配平的 {...} 块」（跳过字符串内的花括号与转义）。
function extractFirstJsonObject(text) {
  const s = String(text === undefined || text === null ? '' : text)
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

const asText = (value) => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return String(value) } catch { return '' }
}

// 归一化单条 issue：severity/point/suggestion 一律收敛成字符串，形状稳定。
function normalizeIssue(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    severity: asText(item.severity).trim(),
    point: asText(item.point).trim(),
    suggestion: asText(item.suggestion).trim(),
  }
}

// 解析复核输出 → { ok:true, issues, verdict } 或 { ok:false, raw }。
// issues 必须是数组（缺键视为解析失败：宁可报错也不误判「已收敛」）。
function parseReviewJson(text) {
  const block = extractFirstJsonObject(text)
  if (block === null) return { ok: false, raw: clipText(text) }
  let obj
  try { obj = JSON.parse(block) } catch { return { ok: false, raw: clipText(block) } }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, raw: clipText(block) }
  if (!Array.isArray(obj.issues)) return { ok: false, raw: clipText(block) }
  const issues = obj.issues.map(normalizeIssue)
  const verdict = asText(obj.verdict).trim()
  return { ok: true, issues, verdict: verdict !== '' ? verdict : (issues.length === 0 ? 'converged' : 'issues-found') }
}

// 固定模板 + 被审产出 +（第 2 轮起）上一轮 issues 对照。
function buildReviewPrompt(content, prev) {
  const parts = [REVIEW_TEMPLATE, '', '【被审产出】', content]
  const prevIssues = prev && Array.isArray(prev.issues) ? prev.issues : []
  if (prevIssues.length > 0) {
    parts.push(
      '',
      '【上一轮已发现的问题（请对照复核）】',
      JSON.stringify(prevIssues, null, 2),
      '已解决的不必重复罗列；仍未解决的请确认，并补充新发现的问题。',
    )
  }
  parts.push('', '只输出一个 JSON 对象，不要输出额外解释。')
  return parts.join('\n')
}

// 跑一轮 codex exec：与 /task 同配置（--ephemeral、stdin ignore、env 注入），
// 但返回同步可见的 child 句柄（立即可被 cancel SIGTERM）+ 等待退出码的 promise。
function spawnReviewRound({ prompt, workdir, envKey, apiKey, outPath }) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-o', outPath, prompt]
  const child = spawn('codex', args, {
    cwd: workdir,
    env: { ...process.env, [envKey]: apiKey },
    // stdin 必须显式关闭：Codex exec 等 stdin EOF，pipe 永不关闭会让任务假死。
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const wait = new Promise((resolve) => {
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      resolve(Number.isInteger(code) ? code : -1)
    }
    child.on('exit', (code) => done(code))
    // spawn 失败（二进制缺失等）不触发 exit，这里兜底。
    child.on('error', () => done(-1))
  })
  return { child, wait }
}

// 读一轮的 -o 输出并删除文件（逐轮清理，不把中间产物留在 ~/.codex）。
function readReviewOut(outPath) {
  let text = ''
  try { text = readFileSync(outPath, 'utf8') } catch { text = '' }
  try { unlinkSync(outPath) } catch { /* 文件可能没生成，忽略 */ }
  return text
}

// 服务层自动循环：每轮 spawn → 解析 → 按 issues/轮数推进，cancelled 即熔断。
async function runReview(task, active) {
  const envKey = `${active.id.toUpperCase()}_API_KEY`
  try {
    for (;;) {
      if (task.status === 'cancelled' || task.cancelled === true) break
      const round = task.rounds.length + 1
      if (round > task.maxRounds) break
      task.round = round
      const prev = task.rounds.length > 0 ? task.rounds[task.rounds.length - 1] : null
      const prompt = buildReviewPrompt(task.content, prev)
      const outPath = join(CODEX_DIR, `review-${task.id}-r${round}.out`)
      task.outPath = outPath
      // 新一轮：重置活动时间，看门狗从本轮 spawn 起算 300s。
      task.activityAt = Date.now()
      const { child, wait } = spawnReviewRound({ prompt, workdir: task.workdir, envKey, apiKey: active.apiKey, outPath })
      task.child = child
      const code = await wait
      task.child = null
      task.exitCode = task.cancelled === true ? -1 : code
      const raw = readReviewOut(outPath)
      if (task.status === 'cancelled' || task.cancelled === true) break
      const parsed = parseReviewJson(raw)
      if (!parsed.ok) {
        task.rounds.push({ round, issues: [], verdict: 'unparsed', raw: parsed.raw })
        finalizeReview(task, 'error', 'unparsed', code === 0 ? '未能从复核输出解析出 JSON' : `codex 退出码 ${code}`)
        void notifyTask(task)
        return
      }
      // issues 为空 → 本轮即收敛；否则记下本轮结论供下一轮对照。
      task.rounds.push({
        round,
        issues: parsed.issues,
        verdict: parsed.issues.length === 0 ? 'converged' : parsed.verdict,
      })
      if (parsed.issues.length === 0) {
        finalizeReview(task, 'done', 'converged')
        void notifyTask(task)
        return
      }
      if (round >= task.maxRounds) {
        // 轮数用尽仍有问题：最后一轮 issues 已在 rounds 里，打包交用户裁决。
        finalizeReview(task, 'done', 'max-rounds')
        void notifyTask(task)
        return
      }
    }
    // 走到这里只可能是被取消（cancelled → 熔断退出）。
    finalizeReview(task, 'cancelled', 'cancelled')
  } catch (e) {
    finalizeReview(task, 'error', 'error', errMsg(e))
    void notifyTask(task)
  }
}

// POST /review：body { content, rounds? }。立刻返回 { ok, id }，服务层后台自动循环。
async function handleReviewCreate(req, res) {
  try {
    const body = await readBody(req)
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (content === '') return send(res, { ok: false, error: 'content 不能为空' }, 400)
    const doc = loadKeyring()
    // 缺省轮数取配置（keyring 顶层 reviewRounds）；显式传 body.rounds 仍可覆盖。
    const requested = body.rounds === undefined || body.rounds === null ? doc.reviewRounds : Number(body.rounds)
    if (!Number.isFinite(requested) || Math.floor(requested) < REVIEW_MIN_ROUNDS) {
      return send(res, { ok: false, error: `rounds 必须是 ${REVIEW_MIN_ROUNDS}..${REVIEW_MAX_ROUNDS} 的整数` }, 400)
    }
    const maxRounds = Math.min(REVIEW_MAX_ROUNDS, Math.floor(requested))
    const active = doc.providers.find((p) => p.id === doc.active)
    if (active === undefined) return send(res, { ok: false, error: '没有可用的 active 提供方' }, 400)
    // 复核不接用户 workdir：默认工单目录不在时退回 ~/.codex（codex exec 需要一个存在的 cwd）。
    const workdir = existsSync(DEFAULT_TASK_WORKDIR) ? DEFAULT_TASK_WORKDIR : CODEX_DIR
    mkdirSync(CODEX_DIR, { recursive: true })

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    const task = {
      id,
      kind: 'review',
      status: 'running',
      round: 0,
      maxRounds,
      rounds: [],
      verdict: '',
      error: '',
      content,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      workdir,
      child: null,
      outPath: '',
      cancelled: false,
      stuckSuspect: false,
    }
    tasks.set(id, task)
    pruneTasks()
    startWatchdog(task)
    void runReview(task, active)
    send(res, { ok: true, id, maxRounds })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /review/cancel：body { id }。置 cancelled（熔断），子进程活着则 SIGTERM。
async function handleReviewCancel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    if (task.kind !== 'review') return send(res, { ok: false, error: `任务 '${id}' 不是复核任务` }, 400)
    if (task.status !== 'running') {
      return send(res, { ok: false, error: `复核已结束（${task.status}），无需取消` }, 400)
    }
    // 先置熔断标记：循环每轮结束（及下一轮 spawn 前）都会检查，确保不再推进。
    task.cancelled = true
    task.status = 'cancelled'
    task.verdict = 'cancelled'
    const child = task.child
    if (child !== null && child !== undefined) {
      try { child.kill('SIGTERM') } catch { /* 进程可能刚好自己退出 */ }
    }
    send(res, { ok: true, id, status: task.status })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/task 同 path 两个方法：POST 下发 / GET 查询，其余 405。
async function handleTaskRoot(req, res) {
  if (req.method === 'POST') return handleTaskCreate(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleTaskGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// ── /config：插件配置（当前只有复核轮数）──
// 真值在 keyring 顶层 reviewRounds：loadKeyring 归一化、saveKeyring 落盘 0600。
async function handleConfigGet(_req, res) {
  try {
    const doc = loadKeyring()
    send(res, { ok: true, reviewRounds: doc.reviewRounds, roundsChoices: REVIEW_ROUNDS_CHOICES })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleConfigSet(req, res) {
  try {
    const body = await readBody(req)
    const rounds = Number(body.reviewRounds)
    if (!REVIEW_ROUNDS_CHOICES.includes(rounds)) {
      return send(res, { ok: false, error: `reviewRounds 只支持 ${REVIEW_ROUNDS_CHOICES.join(' / ')}` }, 400)
    }
    const doc = loadKeyring()
    doc.reviewRounds = rounds
    saveKeyring(doc)
    send(res, { ok: true, reviewRounds: rounds })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/config 同 path 两个方法：GET 回显 / POST 保存，其余 405。
async function handleConfigRoot(req, res) {
  if (req.method === 'POST') return handleConfigSet(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleConfigGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// ── /consult、/consults：Codex 卡点求助信道 ──
// 供第二引擎（Codex）在卡住时把上下文交给主 AI；内存队列，不落盘。
async function handleConsultCreate(req, res) {
  try {
    const body = await readBody(req)
    const from = typeof body.from === 'string' && body.from.trim() !== '' ? body.from.trim() : 'codex'
    const task = typeof body.task === 'string' ? body.task.trim() : ''
    const stuckContext = typeof body.stuckContext === 'string' ? body.stuckContext.trim() : ''
    if (task === '') return send(res, { ok: false, error: 'task 不能为空' }, 400)
    if (stuckContext === '') return send(res, { ok: false, error: 'stuckContext 不能为空' }, 400)

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0'),
      from,
      task,
      stuckContext,
      at: Date.now(),
    }
    consults.push(entry)
    // 上限 20：超了从最旧一条开始丢（求助是短时效信号，留新不留旧）。
    while (consults.length > CONSULT_KEEP_LIMIT) consults.shift()

    // 通知按现有 NOTIFY_URL 方式发：text 用 task 摘要，正文走 /consults 取。
    notify(clipText(task.replace(/\s+/g, ' '), 120), 'Codex 求助')
    send(res, { ok: true, id: entry.id, at: entry.at, count: consults.length })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /consults：全量列表（含 stuckContext，不脱敏），给主 AI 收卷用。
async function handleConsultsList(_req, res) {
  try {
    send(res, { ok: true, count: consults.length, limit: CONSULT_KEEP_LIMIT, consults: consults.slice() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export function apply(ctx) {
  // 桥清理：插件卸载/热重载时关掉本地桥，避免 server 句柄与端口残留。
  // 宿主用 cordis fiber：ctx.effect 回调返回的函数即卸载时的 disposer（同 guard 写法）；
  // 宿主若没有 effect（老版本），退回 process.on('exit')。
  try {
    ctx.effect(() => closeBridge, 'second-engine: bridge teardown')
  } catch {
    try { process.on('exit', closeBridge) } catch { /* best effort */ }
  }

  // Codex 协作协议：确保 ~/.codex/AGENTS.md 带有卡点求助段（幂等）。
  ensureAgentsProtocol()

  // 设置页 API：webServer 后挂载时也能注册；无 webServer 的 profile 自然不注册。
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/second-engine/api/status', handler: handleStatus },
      { kind: 'exact', path: '/second-engine/api/providers', handler: handleProvidersRoot },
      { kind: 'exact', path: '/second-engine/api/providers/key', handler: handleProviderKey },
      { kind: 'exact', path: '/second-engine/api/providers/active', handler: handleProviderActive },
      { kind: 'exact', path: '/second-engine/api/providers/delete', handler: handleProviderDelete },
      { kind: 'exact', path: '/second-engine/api/providers/update', handler: handleProviderUpdate },
      { kind: 'exact', path: '/second-engine/api/models', handler: handleModels },
      { kind: 'exact', path: '/second-engine/api/model', handler: handleProviderModel },
      { kind: 'exact', path: '/second-engine/api/key', handler: handleKey },
      { kind: 'exact', path: '/second-engine/api/cleanup', handler: handleCleanup },
      { kind: 'exact', path: '/second-engine/api/task', handler: handleTaskRoot },
      { kind: 'exact', path: '/second-engine/api/tasks', handler: handleTaskList },
      { kind: 'exact', path: '/second-engine/api/task/cancel', handler: handleTaskCancel },
      { kind: 'exact', path: '/second-engine/api/review', handler: handleReviewCreate },
      { kind: 'exact', path: '/second-engine/api/review/cancel', handler: handleReviewCancel },
      { kind: 'exact', path: '/second-engine/api/config', handler: handleConfigRoot },
      { kind: 'exact', path: '/second-engine/api/consult', handler: handleConsultCreate },
      { kind: 'exact', path: '/second-engine/api/consults', handler: handleConsultsList },
    ]
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `second-engine: ${route.path} route`)
    }
  })

  // 设置 > 插件 > 插件配置 的 namespace：宿主 settings 服务只派发「served 的
  // namespace」与「settings.plugin.item 里按 key 占位的卡」的交集，所以这里
  // 必须注册 'second-engine'，否则浏览器端不渲染本插件面板。
  // 全程 best-effort：settings/llm 不可用时插件照常只提供三条 HTTP API。
  ctx.inject(['settings'], (sctx) => {
    try {
      const cfg = readConfig()
      const scope = sctx.settings.register('second-engine', z.object({
        keepDays: z.number().min(MIN_KEEP_DAYS).max(MAX_KEEP_DAYS).default(cfg.keepDays),
      }), { base: { keepDays: cfg.keepDays } })
      secondEngineSettingsScope = scope
      // 用 base 播种一次，宿主文档与默认值对齐。
      void scope.update({ keepDays: cfg.keepDays }).catch(() => {})
      // 宿主文档才是持久真值：把当前值镜像进进程内默认值，供 cleanup 兜底。
      scope.watch(() => {
        try {
          const v = scope.get()
          if (v && Number.isFinite(v.keepDays)) keepDaysDefault = Math.floor(v.keepDays)
        } catch { /* best effort */ }
      })
      // 目录条目：设置页据此把本插件列进可配置 provider，缺它浏览器端不渲染。
      // 注意 settingsNs/settingsPath 是必填（只传 provider/displayName 会抛
      // TypeError 被 catch 吞掉，等于没注册），与 dsh-llm 的 LlmConfigurableProvider 对齐。
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        try {
          llm.registerConfigurableProviders([{
            provider: 'second-engine',
            displayName: '第二引擎（second-engine）',
            settingsNs: 'second-engine',
            settingsPath: [],
          }])
        } catch { /* best effort */ }
      }
    } catch {
      // settings 不可用：插件照常提供 HTTP API。
    }
    sctx.effect(() => () => { secondEngineSettingsScope = null }, 'second-engine: settings scope teardown')
  })
}

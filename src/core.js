// src/core.js — 最底层工具与纯常量（2026-11-02 从 index.js 拆出，第二刀；2026-11-07 第三刀并入叶子）
// 不得 import index.js / 路由 / 任务模块（防循环）；只依赖 constants.js、parse.js、engine/pi-probe.js 这类叶子。
import { writeFileSync, chmodSync, renameSync, unlinkSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { CONFIG_PATH, CODEX_DIR } from './constants.js'
import { parseVersion } from './parse.js'
import { resolvePiProvider as resolvePiProviderRaw } from './engine/pi-probe.js'

export const ERR_LOG = []

const ERR_LOG_LIMIT = 50

const ERR_REDACT_RE = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._~+\/=-]{6,}|(?:(?:api[_-]?key|key|token|password|secret)["']?\s*[:=]\s*)["']?[A-Za-z0-9._~+\/=-]{6,})/gi

export function noteErr(tag, err) {
  let msg = err instanceof Error ? String(err.message ?? err) : String(err ?? '')
  msg = String(msg).replace(ERR_REDACT_RE, '[redacted]').slice(0, 300)
  ERR_LOG.push({ t: Date.now(), tag: String(tag), msg })
  while (ERR_LOG.length > ERR_LOG_LIMIT) ERR_LOG.shift()
}

export function atomicWriteFileSync(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw e
  }
}

export function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

export function readConfigRaw() {
  try { return readFileSync(CONFIG_PATH, 'utf8') } catch { return '' }
}


export const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

// 首次初始化写入的三家预设（apiKey 空，待设置页填写）。
export const PRESET_PROVIDERS = [
  // DeepSeek 官方文档实证的上下文/输出上限，写 config.toml 顶层（见 writeCodexConfig）。
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', model: 'deepseek-flash', contextWindow: 1048576, maxOutput: 393216 },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/v1', wireApi: 'responses', model: 'glm-4.6' },
]
export const PRESET_IDS = new Set(PRESET_PROVIDERS.map((p) => p.id))
export const DEFAULT_ACTIVE = PRESET_PROVIDERS[0].id
// Codex 侧永远讲 Responses（config.toml 的 wire_api 恒为它），
// 'completions' 提供方由本地翻译桥转接（见 ensureBridge）。
export const SUPPORTED_WIRE_APIS = new Set(['responses', 'completions'])
export const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

// config.toml 顶层 web_search：Codex 原生联网搜索档位（二进制 WebSearchMode 枚举实证）。
// disabled=关闭，live=开启；cached/indexed 是中间档，面板只暴露 disabled/live 两档。
export const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live']

// MCP 段名：限定字符集堵住段头注入（换行/']'/引号都进不来）。
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export const TASK_LIST_LIMIT = 10

export const CONSULT_KEEP_LIMIT = 20

export const ENGINE_EVENTS_LIMIT = 20

export const ENGINE_EVENTS_META_BYTES = 4096

export const PROGRESS_LIMIT = 20

export const INDEPENDENT_SOURCES = 1

export const QUORUM_NOTE = '1 个独立复核家族 < 建议下限 3，converged 仅代表单来源自洽'

export const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const REVIEW_MIN_ROUNDS = 1

export const REVIEW_MAX_ROUNDS = 5

export const errMsg = (e) => (e && e.message) ? e.message : String(e)

// status 轮询缓存：递归 stat 整棵 sessions 树不便宜（设置页/浮球会反复刷），
// TTL 内复用上次结果；runAutoCleanup 仍用新鲜的 sessionsBytes()。
const SESSIONS_BYTES_TTL_MS = 10000
let sessionsBytesCache = { at: 0, value: 0 }
export function sessionsBytesCached() {
  if (Date.now() - sessionsBytesCache.at < SESSIONS_BYTES_TTL_MS) return sessionsBytesCache.value
  sessionsBytesCache = { at: Date.now(), value: sessionsBytes() }
  return sessionsBytesCache.value
}

export function invalidIdError(id) {
  if (id === '') return 'id 不能为空'
  if (!ID_PATTERN.test(id)) return 'id 必须以小写字母开头，且只含小写字母、数字、下划线或连字符'
  return null
}

// 接受 'responses'（直连）与 'completions'（经本地翻译桥）；其余取值拒绝。
export function wireApiError(value) {
  if (value === undefined || value === null || value === '') return null
  if (SUPPORTED_WIRE_APIS.has(value)) return null
  return `wireApi 只支持 'responses'（直连）或 'completions'（经本地桥），收到 '${value}'`
}

export function countPiJsonl(dir) {
  let count = 0
  let sizeBytes = 0
  const walk = (current) => {
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try { count += 1; sizeBytes += statSync(full).size } catch { /* skip transient file errors */ }
    }
  }
  walk(dir)
  return { count, sizeBytes }
}

export const PI_CHANNEL_APIS = new Set([
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'azure-openai-responses', 'bedrock-converse-stream',
])

// 协议选项：由后端下发，前端不写死。Codex 只有两种（completions 需经本地桥翻译），
// Pi 直连六种原生 api，没有桥的概念 —— 写死两选项会让 Pi 用户缺 anthropic/gemini。
export const CODEX_WIRE_OPTIONS = [
  { value: 'responses', label: 'responses（直连）', bridged: false },
  { value: 'completions', label: 'chat（经本地桥）', bridged: true },
]
export const PI_WIRE_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI 兼容（chat completions）', bridged: false },
  { value: 'openai-responses', label: 'OpenAI Responses', bridged: false },
  { value: 'anthropic-messages', label: 'Anthropic Messages', bridged: false },
  { value: 'google-generative-ai', label: 'Google Generative AI', bridged: false },
  { value: 'azure-openai-responses', label: 'Azure OpenAI Responses', bridged: false },
  { value: 'bedrock-converse-stream', label: 'AWS Bedrock Converse', bridged: false },
]

// ── Pi 引擎下的 providers/models 兼容层（P4.11）──
// 目的：前端 ProviderCard 一行都不改。把 Pi 的 models.json + settings.json 映射成
// Codex 的 { ok, active, providers:[{id,name,baseUrl,model,apiKey:{configured,preview}}] }。
// 这样「编辑 / 删除 / 填 Key / 拉模型 / 切当前」全部沿用既有实现 —— 不再维护第二套 UI。
export const PI_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')
// per-provider 模型记忆（2026-11-02）：Pi 的 settings.json 只有一对全局 defaultProvider/defaultModel，
// 切提供方时模型不跟着换（实测：当前是 deepseek 但仍显示 glm-5.2）。按 provider 各记一份。
// ⚠️ 不写进 models.json —— 那是 Pi 的配置且有 schema 校验，塞未知字段可能整份被拒。
const PI_MODEL_MEMORY_PATH = join(homedir(), '.dsh', 'second-engine', 'pi-model-memory.json')

export function readPiModelMemory() {
  try {
    const parsed = JSON.parse(readFileSync(PI_MODEL_MEMORY_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

export function rememberPiModel(id, model) {
  if (id === '' || model === '') return
  try {
    // 目录不会自动创建：atomicWriteFileSync 只写文件，父目录缺失会 ENOENT（真实事故：
    // ~/.dsh/second-engine/ 不存在时每次写记忆都失败，异常被 catch 吞掉，表现为"选了模型又回默认"）。
    mkdirSync(dirname(PI_MODEL_MEMORY_PATH), { recursive: true })
    const mem = readPiModelMemory()
    mem[id] = model
    atomicWriteFileSync(PI_MODEL_MEMORY_PATH, `${JSON.stringify(mem, null, 2)}\n`, 0o600)
  } catch (e) { noteErr('pi-model-memory', e) }
}

export function readPiJson(path) {
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    return doc !== null && typeof doc === 'object' ? doc : {}
  } catch { return {} }
}

// ── Pi 配置文件写入的并发保护（2026-10-29 任务 1）────────────────────────
// 问题：六个写入口（piProviderAdd / piProviderKey / piProviderDelete / piProviderUpdate /
// piProviderActive / piProviderModel）各自都是「读整份 → 改一个键 → 写整份」，入口之间
// 没有任何互斥。面板与浮球并发点两下 = 后一次用自己的**旧读**覆盖前一次的结果（丢写）；
// 两个 handler 同毫秒抢同一份 `${path}.tmp-${process.pid}`（同进程同 pid，名字**必然撞**），
// rename 之后 tmp 已被顶走 → ENOENT 半途失败；`.bak-<ts>` 同毫秒也互相覆盖。
// 做法：per-path  promise 链（进程内串行队列）。只在本进程内串行，不是跨进程文件锁
// （那需要新依赖，本轮禁止）；跨进程仍靠原子 rename 保证「不出现半截文件」。
export const PI_WRITE_QUEUES = new Map()

// 严格读（写基线专用）：坏 JSON / 读不到 → 抛 PiWriteAborted，**绝不**拿 {} 当基线。
// 与旧 readPiJsonForWrite 同一口径（紫东审查 P0-2/P0-3），只是把「已发响应」改成抛错，
// 好让它在 piWriteJson 的锁内闭包里复用。
class PiWriteAborted extends Error {
  constructor(message, status) { super(message); this.status = status === undefined ? 409 : status }
}
export function readPiJsonStrict(path) {
  if (!existsSync(path)) return {}
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch (e) {
    throw new PiWriteAborted(`读不到 ${path}：${errMsg(e)}`, 500)
  }
  let doc = null
  try { doc = JSON.parse(raw) } catch {
    throw new PiWriteAborted(`${path} 不是合法 JSON，已中止（未改动文件）。请先手工修好再加。`, 409)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PiWriteAborted(`${path} 顶层不是对象，已中止（未改动文件）。`, 409)
  }
  return doc
}

// wireApi（Codex 术语）↔ api（Pi 术语）
// 接受三种输入：Codex 的 responses/completions，或 Pi 自己的 api 值（原样直通）。
export const PI_API_SET = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses', 'bedrock-converse-stream'])

/** Pi 快照 → Codex 形状。内置只预设 deepseek（用户要求），其余全在 models.json 里。 */
/** 模型名不该长成 API Key 的样子（智谱是 id.secret，49 字符）。
 *  用户实测把 key 填进「模型名」，结果被当模型名写进 models.json 并显示在面板上。 */

// Pi 写入口统一错误出口：PiWriteAborted 带自己的 status（409/500），其余按 200 + ok:false（与历史一致）。
// ── Pi JSON 备份轮转（D4，2026-10-29）────────────────────────────────
// Codex 侧早有这套：backupConfig() 按 CONFIG_BACKUP_NAME_RE 只认自己那套文件名，
// 排序后 slice 掉超出 CONFIG_BACKUP_KEEP 的旧份（:759-774）。Pi 侧这几个 JSON 之前
// 每次真写都留一份 .bak-<ts>，永远不清 → ~/.pi/agent 下无限增长。
// 这里复用同一个保留数，以及同一套「只按自己的文件名模式轮转」的纪律：
// 只匹配 ^<本文件名>\.bak- ，别的一律不碰（用户手放的备份、别的文件都安全）。
// 备份名是 <文件>.bak-<毫秒>-<pid>-<8hex>，时间戳定长在最前 → 字典序即时间序，sort() 就够。

// ── Pi 提供方/渠道 id 白名单（D1，2026-10-29）──────────────────────────
// 原来只有 piProviderAdd / handlePiChannelCreate 各写了一份同样的字面量正则，
// piProviderKey / piProviderDelete / piProviderModel 只判非空 —— 见缺陷表 D1。
// 注意：`__proto__` 本来就被首字符 [A-Za-z0-9] 挡掉，真正能穿过去的是
// constructor / prototype / toString 这类**首字符合法**的 Object.prototype 键名，
// 所以正则之外还要显式列出要拒绝的键。
export const PI_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
export const PI_PROVIDER_ID_BLOCKED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']
// providers 容器的安全取法：一律 hasOwnProperty 判存在，读到的是对象自己的键才算数，
// 继承链上的 constructor/toString 不会被当成「已存在的提供方」。
// 另外把已存在的普通对象换成原型为 null 的副本（原对象属性逐个 own-key 拷过来，
// 值引用不变，所以 piWriteJson 的内容比对仍等价 → 不会因此多写一份备份）。
export function piProvidersBag(doc) {
  if (doc.providers === null || typeof doc.providers !== 'object') {
    doc.providers = Object.create(null)
    return doc.providers
  }
  if (Object.getPrototypeOf(doc.providers) !== null) {
    const safe = Object.create(null)
    for (const k of Object.keys(doc.providers)) safe[k] = doc.providers[k]
    doc.providers = safe
  }
  return doc.providers
}
export function piHasProvider(bag, id) {
  return Object.prototype.hasOwnProperty.call(bag, id)
}

export function sendPiWriteError(res, e) {
  const status = e instanceof PiWriteAborted ? e.status : 200
  send(res, { ok: false, error: errMsg(e) }, status)
}

export const PROTECTED_IDS = new Set(['deepseek', 'zhipu'])

// 拼出 /models 端点：压掉 baseUrl 末尾斜杠，避免 '//models'。
export function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

// 智谱：open.bigmodel.cn 上 /api/v1 是 **Codex 专用适配端点**（模型清单只列 codex 适配好的几个），
// 而 /api/coding/paas/v4 是编程端点、列出全量模型；两者共用同一把 key（2026-09-28 实测）。
// 这里给它一个辅助清单 URL，与主端点求并集展示，避免"面板只显示 3 个模型"的误判。
export function bigmodelAuxModelsUrl(baseUrl) {
  return /open\.bigmodel\.cn/i.test(baseUrl)
    ? 'https://open.bigmodel.cn/api/coding/paas/v4/models'
    : null
}

export const PI_MCP_PATH = join(homedir(), '.pi', 'agent', 'mcp.json')

export function readPiMcp() {
  if (!existsSync(PI_MCP_PATH)) return { mcpServers: {} }
  try {
    const doc = JSON.parse(readFileSync(PI_MCP_PATH, 'utf8'))
    if (doc === null || typeof doc !== 'object') return { mcpServers: {} }
    if (doc.mcpServers === null || typeof doc.mcpServers !== 'object') doc.mcpServers = {}
    return doc
  } catch { return { mcpServers: {} } }
}

export const MCP_ROUTE_PREFIX = '/second-engine/api/mcp'

// 三段数字比较：a>b → 1，a<b → -1，相等或任一侧不可解析 → 0。
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return 0
  const [ax, ay, az] = left.split('.').map(Number)
  const [bx, by, bz] = right.split('.').map(Number)
  if (ax !== bx) return ax > bx ? 1 : -1
  if (ay !== by) return ay > by ? 1 : -1
  if (az !== bz) return az > bz ? 1 : -1
  return 0
}

// Provider selection is runtime/request (via preferredId) then Pi config default;
// the keyring is consulted by the probe only to fill the selected provider's key.
export function resolvePiProvider(preferredId = '') {
  if (preferredId !== '') return resolvePiProviderRaw(preferredId)
  let configured = ''
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'))
    configured = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : ''
  } catch { /* optional */ }
  return resolvePiProviderRaw(configured)
}

// 递归统计目录字节数（原在 pi-misc.js，sessionsBytesCached 要用，搬到这里；pi-misc 重导出）。
export function sessionsBytes(dir = SESSIONS_DIR) {
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

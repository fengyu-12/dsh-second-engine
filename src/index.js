// dsh-second-engine —— DeepSeek Harness 的 Codex 二元引擎插件。
//
// 进程内提供：设置页所需的 HTTP API（经 webServer 注册为 exact 路由）
//   GET    /second-engine/api/status            引擎/密钥/会话占用概览
//   GET    /second-engine/api/providers         提供方列表（apiKey 脱敏）+ active
//   POST   /second-engine/api/providers         新增自定义提供方
//   POST   /second-engine/api/providers/key     设置指定提供方 apiKey（keyring 0600）
//   POST   /second-engine/api/providers/active  切换激活并生成 config.toml（先备份）
//   POST   /second-engine/api/providers/delete  删除自定义提供方（预设不可删）
//   POST   /second-engine/api/models            拉取该提供方 /models 模型清单（缺省 active）
//   POST   /second-engine/api/model             更新该提供方 model（active 时重写 config.toml）
//   POST   /second-engine/api/key               兼容旧面板：给预设提供方写 key
//   POST   /second-engine/api/cleanup           按 mtime 清理旧会话 *.jsonl
// 以及 rc.7 插件自有设置表面：settings 命名空间 'second-engine'（keepDays）与
// llm 的可配置 provider 目录条目，二者缺一浏览器端设置页都不渲染本插件面板。
// 请求体与响应均为 JSON，handler 用原生 node:req/res 风格。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

export const name = 'second-engine'

const CODEX_DIR = join(homedir(), '.codex')
const CODEX_BINARY = '/usr/local/bin/codex'
const CONFIG_PATH = join(CODEX_DIR, 'config.toml')
const KEYRING_PATH = join(CODEX_DIR, 'keyring.json')
const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

const CONFIG_BACKUP_PATH = join(CODEX_DIR, 'config.toml.bak-se')

// 首次初始化写入的两家预设（apiKey 空，待设置页填写）。
const PRESET_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', model: 'deepseek-flash' },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/v1', wireApi: 'responses', model: 'glm-4.6' },
]
const PRESET_IDS = new Set(PRESET_PROVIDERS.map((p) => p.id))
const DEFAULT_ACTIVE = PRESET_PROVIDERS[0].id
// 目前只支持 Responses 协议；其它协议需要「翻译桥」，暂不支持。
const WIRE_API = 'responses'
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

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
// 形状：{ providers: [{ id, name, baseUrl, wireApi, apiKey, model }], active: '<id>' }

function presetProviders() {
  return PRESET_PROVIDERS.map((p) => ({ ...p, apiKey: '' }))
}

// 归一化单条 provider：缺字段补默认值，调用方拿到的形状始终稳定。
function normalizeProvider(raw) {
  return {
    id: typeof raw?.id === 'string' ? raw.id : '',
    name: typeof raw?.name === 'string' ? raw.name : '',
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl : '',
    wireApi: typeof raw?.wireApi === 'string' ? raw.wireApi : WIRE_API,
    model: typeof raw?.model === 'string' ? raw.model : '',
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
  }
}

function saveKeyring(doc) {
  mkdirSync(CODEX_DIR, { recursive: true })
  writeFileSync(KEYRING_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  chmodSync(KEYRING_PATH, 0o600)
}

// 读取并归一化 keyring：
//   - 文件缺失/不可解析 → 首次初始化：写入两家预设（apiKey 空）
//   - 旧格式 { provider: 'deepseek'|'zhipu', key } → 迁移为对应预设的 apiKey
//   - 新格式 → 归一化，并保证两家预设始终在列
function loadKeyring() {
  let doc = null
  try {
    doc = JSON.parse(readFileSync(KEYRING_PATH, 'utf8'))
  } catch { doc = null }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const fresh = { providers: presetProviders(), active: DEFAULT_ACTIVE }
    try { saveKeyring(fresh) } catch { /* 只读降级：内存里照常可用 */ }
    return fresh
  }

  if (!Array.isArray(doc.providers)) {
    const id = PRESET_IDS.has(doc.provider) ? doc.provider : DEFAULT_ACTIVE
    const providers = presetProviders()
    const target = providers.find((p) => p.id === id)
    if (typeof doc.key === 'string') target.apiKey = doc.key.trim()
    const migrated = { providers, active: id }
    try { saveKeyring(migrated) } catch { /* 迁移落盘失败不阻断读取 */ }
    return migrated
  }

  const providers = doc.providers.map(normalizeProvider).filter((p) => p.id !== '')
  for (const preset of PRESET_PROVIDERS) {
    if (!providers.some((p) => p.id === preset.id)) providers.push({ ...preset, apiKey: '' })
  }
  const active = providers.some((p) => p.id === doc.active) ? doc.active : DEFAULT_ACTIVE
  return { providers, active }
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

// 只接受 'responses'；其它取值一律拒绝（需要翻译桥，暂不支持）。
function wireApiError(value) {
  if (value === undefined || value === null || value === '') return null
  if (value === WIRE_API) return null
  return `wireApi 只支持 '${WIRE_API}'，'${value}' 需要翻译桥，暂不支持`
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

// 按 active 提供方生成 config.toml，返回使用的 env_key。
function writeCodexConfig(provider) {
  mkdirSync(CODEX_DIR, { recursive: true })
  backupConfig()
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
    '',
    `[model_providers.${tableKey}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `wire_api = ${tomlString(WIRE_API)}`,
    '',
  ]
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
    const provider = { id, name, baseUrl, wireApi: WIRE_API, model, apiKey }
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
    const envKey = writeCodexConfig(target)
    send(res, { ok: true, active: id, configPath: CONFIG_PATH, backupPath: CONFIG_BACKUP_PATH, envKey })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/delete：预设不可删；删除 active 时回落到第一家预设并同步 config.toml。
async function handleProviderDelete(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (PRESET_IDS.has(id)) {
      return send(res, { ok: false, error: `预设提供方 '${id}' 不允许删除` }, 400)
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
        writeCodexConfig(fallback)
        configRegenerated = true
      }
    }
    saveKeyring(doc)
    send(res, { ok: true, active: doc.active, configRegenerated })
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
      writeCodexConfig(target)
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

export function apply(ctx) {
  // 设置页 API：webServer 后挂载时也能注册；无 webServer 的 profile 自然不注册。
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/second-engine/api/status', handler: handleStatus },
      { kind: 'exact', path: '/second-engine/api/providers', handler: handleProvidersRoot },
      { kind: 'exact', path: '/second-engine/api/providers/key', handler: handleProviderKey },
      { kind: 'exact', path: '/second-engine/api/providers/active', handler: handleProviderActive },
      { kind: 'exact', path: '/second-engine/api/providers/delete', handler: handleProviderDelete },
      { kind: 'exact', path: '/second-engine/api/models', handler: handleModels },
      { kind: 'exact', path: '/second-engine/api/model', handler: handleProviderModel },
      { kind: 'exact', path: '/second-engine/api/key', handler: handleKey },
      { kind: 'exact', path: '/second-engine/api/cleanup', handler: handleCleanup },
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

// Pi 的本地探测（P4.5，2026-10-28）
//
// 与 Codex 的探测对称：Codex 有 `codex --version` + GitHub release；
// Pi 有 `pi --version` + npm，而且**能自己报模型列表** —— 这是 Codex 那边靠 provider 的
// `/models` 端点才做到的事，Pi 用 RPC 的 `get_available_models`（rpc.md「Model」节）。
//
// 全部带 TTL 缓存：status 是高频接口，每次 spawn 一两个进程不可接受。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TTL_MS = 60_000
const MODELS_TTL_MS = 300_000   // 模型列表变得慢，缓存久一点

let versionCache = { at: 0, value: null }
let modelsCache = { at: 0, value: null, promise: null }

export const PI_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json')
const KEYRING = process.env.CODEX_KEYRING || join(homedir(), '.codex', 'keyring.json')
/** Pi 只认这 7 家（providers.md 的 <PROVIDER>_API_KEY 表） */
export const PI_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'gemini', 'openrouter', 'kimi', 'moonshot']

/**
 * 从 keyring 取 Pi 可用的 provider（active 不被 Pi 认时回落到第一个 Pi 认的）。
 * 与 index.js 的 rtOf 同一规则 —— 两处必须一致，否则「面板显示」与「实际跑的」会分叉。
 */
export function resolvePiProvider(preferredId = '') {
  try {
    let kr = {}
    try { kr = JSON.parse(readFileSync(KEYRING, 'utf8')) } catch { /* keyring is optional for custom Pi channels */ }
    const keyringProviders = Array.isArray(kr.providers) ? kr.providers : []
    let settings = {}
    try { settings = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')) } catch { /* optional */ }
    let models = {}
    try { models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8')) } catch { /* optional */ }
    const customProviders = models && typeof models.providers === 'object' ? models.providers : {}
    const preferred = preferredId || (typeof settings.defaultProvider === 'string' && settings.defaultProvider !== '' ? settings.defaultProvider : kr.active)
    const keyringById = new Map(keyringProviders.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]))
    const candidates = preferredId
      ? [preferredId]
      : [preferred, ...keyringProviders.map((p) => p?.id)].filter((id, i, all) => typeof id === 'string' && all.indexOf(id) === i)
    for (const id of candidates) {
      if (!PI_PROVIDERS.includes(id) && customProviders[id] === undefined) continue
      const fromKeyring = keyringById.get(id) || {}
      const fromModels = customProviders[id] && typeof customProviders[id] === 'object' ? customProviders[id] : {}
      const key = fromKeyring.apiKey || fromKeyring.key || fromModels.apiKey || process.env[`${id.toUpperCase()}_API_KEY`] || ''
      if (!key) continue
      const model = id === settings.defaultProvider && typeof settings.defaultModel === 'string' && settings.defaultModel !== ''
        ? settings.defaultModel
        : (fromKeyring.model || '')
      return { id, model, key }
    }
    return null
  } catch { return null }
}

function whichPi() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('sh', ['-lc', 'command -v pi'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return resolve('') }
    let out = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } resolve('') }, 3000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('exit', () => { clearTimeout(timer); resolve(out.trim()) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

function readVersion(bin) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return resolve('') }
    let out = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } resolve('') }, 8000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { out += c.toString('utf8') })
    child.on('exit', () => {
      clearTimeout(timer)
      const m = /(\d+\.\d+\.\d+)/.exec(out)
      resolve(m === null ? '' : m[1])
    })
    child.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

/**
 * 用 RPC 的 `get_available_models` 拿 Pi 认识的模型。
 * 起一次性 `pi --mode rpc`，发一条命令，读回执后立刻 KILL —— 不常驻（status 不是常驻位点）。
 * 失败（没 key / 超时 / 命令不存在）返回 null，调用方退回 keyring 回落，不猜。
 */
function fetchAvailableModels(bin) {
  if (bin === '') return Promise.resolve(null)
  return new Promise((resolve) => {
    // 认证后才列得出模型：与 pi-env / rtOf 同规则注入 <PROVIDER>_API_KEY。
    const prov = resolvePiProvider()
    const args = ['--mode', 'rpc', '--no-session']
    const env = { ...process.env }
    if (prov !== null) {
      args.push('--provider', prov.id)
      if (prov.model !== '') args.push('--model', prov.model)
      env[`${prov.id.toUpperCase()}_API_KEY`] = prov.key
    }
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch { return resolve(null) }
    let buf = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), 6000)
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.trim() === '') continue
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        if (rec.type === 'response' && rec.command === 'get_available_models') {
          clearTimeout(timer)
          if (rec.success === false) return finish(null)
          const data = rec.data
          const list = Array.isArray(data) ? data : (data?.models ?? data?.available ?? null)
          finish(Array.isArray(list) ? list : null)
        }
      }
    })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    try { child.stdin.write(`${JSON.stringify({ id: 'probe', type: 'get_available_models' })}\n`) }
    catch { clearTimeout(timer); finish(null) }
  })
}

/** 同步部分（PATH / models.json）用短 TTL；异步部分（版本、模型）各自缓存。 */
export async function piProbe() {
  if (versionCache.value !== null && Date.now() - versionCache.at < TTL_MS) return versionCache.value
  const bin = await whichPi()
  const version = bin === '' ? '' : await readVersion(bin)
  let modelsJsonExists = false
  let modelsJsonDefault = ''
  try {
    modelsJsonExists = existsSync(PI_MODELS_PATH)
    if (modelsJsonExists) {
      const j = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'))
      if (typeof j?.defaultModel === 'string') modelsJsonDefault = j.defaultModel
    }
  } catch { /* 非 JSON / 不可读：当作缺失，不猜 */ }
  const value = { inPath: bin !== '', path: bin, version, modelsJsonPath: PI_MODELS_PATH, modelsJsonExists, modelsJsonDefault }
  versionCache = { at: Date.now(), value }
  return value
}

/** 模型列表单独缓存（起进程较贵）。返回 null 表示拿不到。 */
/** 切换默认模型 / 手改 models.json 后调用：置空缓存，下次重新问 Pi，别拿旧名单。 */
export function invalidatePiModelsCache() {
  modelsCache.value = null
  modelsCache.at = 0
}

export async function piAvailableModels() {
  // value === null 也必须命中缓存：否则「拉不到模型」的机器上每次调用都重开子进程，
  // 而 handlePiPanel / piModels / engineView 都会调它、/api/status 是高频接口
  //（紫东审查 P1-15）。用 at > 0 表示「已经查过一次」，null 也是有效缓存值。
  if (modelsCache.at > 0 && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value
  if (modelsCache.promise !== null) return modelsCache.promise
  const bin = versionCache.value !== null ? versionCache.value.path : await whichPi()
  modelsCache.promise = fetchAvailableModels(bin).then((v) => {
    modelsCache = { at: Date.now(), value: v, promise: null }
    return v
  }).catch(() => { modelsCache = { at: Date.now(), value: null, promise: null }; return null })
  return modelsCache.promise
}

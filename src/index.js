// dsh-second-engine —— DeepSeek Harness 的 Codex 二元引擎插件。
//
// 进程内提供：设置页所需的三条 HTTP API（经 webServer 注册为 exact 路由）
//   GET  /second-engine/api/status   引擎/密钥/会话占用概览
//   POST /second-engine/api/key      写入 keyring.json（0600）
//   POST /second-engine/api/cleanup  按 mtime 清理旧会话 *.jsonl
// 请求体与响应均为 JSON，handler 用原生 node:req/res 风格。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'second-engine'

const CODEX_DIR = join(homedir(), '.codex')
const CODEX_BINARY = '/usr/local/bin/codex'
const CONFIG_PATH = join(CODEX_DIR, 'config.toml')
const KEYRING_PATH = join(CODEX_DIR, 'keyring.json')
const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

const PROVIDERS = new Set(['deepseek', 'zhipu'])

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
// keyring 里已有可用 key（文件存在且 key 非空）
function keyConfigured() {
  try {
    const doc = JSON.parse(readFileSync(KEYRING_PATH, 'utf8'))
    return typeof doc?.key === 'string' && doc.key.trim() !== ''
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

async function handleKey(req, res) {
  try {
    const body = await readBody(req)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!PROVIDERS.has(provider)) {
      return send(res, { ok: false, error: 'provider 必须是 deepseek 或 zhipu' }, 400)
    }
    if (key === '') {
      return send(res, { ok: false, error: 'key 不能为空' }, 400)
    }
    mkdirSync(CODEX_DIR, { recursive: true })
    writeFileSync(KEYRING_PATH, `${JSON.stringify({ provider, key }, null, 2)}\n`, 'utf8')
    chmodSync(KEYRING_PATH, 0o600)
    send(res, { ok: true, preview: maskKey(key) })
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
    const keepDays = Number(body.keepDays)
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      return send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
    }
    const stats = { removed: 0, freedBytes: 0 }
    cleanupSessions(SESSIONS_DIR, Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    send(res, { ok: true, removed: stats.removed, freedBytes: stats.freedBytes })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export function apply(ctx) {
  // 设置页 API：webServer 后挂载时也能注册；无 webServer 的 profile 自然不注册。
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/second-engine/api/status', handler: handleStatus },
      { kind: 'exact', path: '/second-engine/api/key', handler: handleKey },
      { kind: 'exact', path: '/second-engine/api/cleanup', handler: handleCleanup },
    ]
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `second-engine: ${route.path} route`)
    }
  })
}

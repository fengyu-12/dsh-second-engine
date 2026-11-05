/**
 * Claude 聊天桥的进程控制（插件侧）。
 *
 * 桥本体是独立进程 `bridge/claude/server.mjs`（端口 8789，双向 NDJSON）。
 * 这里只做三件事：拉起、探活、停掉。不碰 stdin/stdout —— 转发由桥自己走 SSE。
 *
 * pid 落 `~/.dsh/second-engine/claude-bridge.pid`；探活用 process.kill(pid, 0)，
 * 不靠"文件在就认为在跑"（进程崩了 pid 文件会残留）。
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_DIR = join(homedir(), '.dsh', 'second-engine')
const PID_PATH = join(STATE_DIR, 'claude-bridge.pid')
// 用户意图：点过「启动桥」就留这个文件，Web 重启后据此自动拉起（否则重启就把桥带走了）
const ENABLED_PATH = join(STATE_DIR, 'claude-bridge.enabled')
// 2026-11-06：原来 stdio:'ignore'，桥崩了不留任何痕迹（用户「跑着跑着桥停了」无从查证）。
// 现在把子进程 stderr 追加到这里；出问题先看它，别猜。
const LOG_PATH = join(STATE_DIR, 'claude-bridge.log')
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bridge', 'claude', 'server.mjs')
export const CLAUDE_BRIDGE_PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8789)

function readPid() {
  try {
    const n = Number(readFileSync(PID_PATH, 'utf8').trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function claudeBridgeStatus() {
  const pid = readPid()
  const running = alive(pid)
  return {
    ok: true,
    running,
    pid: running ? pid : null,
    port: CLAUDE_BRIDGE_PORT,
    url: `http://127.0.0.1:${CLAUDE_BRIDGE_PORT}`,
    serverPath: SERVER,
  }
}

export function startClaudeBridge() {
  const cur = claudeBridgeStatus()
  if (cur.running) return { ok: true, note: '已在运行', ...cur }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
  } catch { /* ignore */ }
  // stderr 落日志：拿不到句柄就退回 ignore，不因记日志失败而挡住启动
  let errFd = null
  try { errFd = openSync(LOG_PATH, 'a', 0o600) } catch { errFd = null }
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd === null ? 'ignore' : errFd],
    env: { ...process.env, CLAUDE_BRIDGE_PORT: String(CLAUDE_BRIDGE_PORT) },
  })
  child.unref()
  // 子进程已继承该 fd，父进程这份关掉，否则每启一次就漏一个句柄
  if (errFd !== null) { try { closeSync(errFd) } catch { /* ignore */ } }
  if (!child.pid) return { ok: false, error: '启动失败：没有拿到 pid' }
  try {
    writeFileSync(PID_PATH, String(child.pid), { mode: 0o600 })
    writeFileSync(ENABLED_PATH, '1', { mode: 0o600 })
  } catch { /* pid 写不进去也不影响进程，状态会显示未运行 */ }
  return { ok: true, note: '已启动', ...claudeBridgeStatus() }
}

// Web 启动时调用：上次是用户主动开的，就恢复；主动关过（无 enabled 文件）则不动。
export function autoStartIfEnabled() {
  let on = false
  try { on = readFileSync(ENABLED_PATH, 'utf8').trim() === '1' } catch { on = false }
  if (!on) return { ok: true, note: '未启用自动启动' }
  const st = claudeBridgeStatus()
  if (st.running) return { ok: true, note: '已在运行', ...st }
  return startClaudeBridge()
}

export function stopClaudeBridge() {
  const pid = readPid()
  if (!alive(pid)) {
    try { unlinkSync(PID_PATH) } catch { /* ignore */ }
    return { ok: true, note: '未运行' }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    return { ok: false, error: `结束进程失败：${e.message}` }
  }
  try { unlinkSync(PID_PATH) } catch { /* ignore */ }
  try { unlinkSync(ENABLED_PATH) } catch { /* ignore */ }
  return { ok: true, note: '已停止', pid }
}

export async function handleClaudeBridge(req, res) {
  const send = (body, status = 200) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  try {
    if (req.method === 'GET') return send(claudeBridgeStatus())
    const chunks = []
    await new Promise((resolve) => {
      req.on('data', (c) => chunks.push(c))
      req.on('end', resolve)
      req.on('error', resolve)
    })
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
    const action = String(body.action || '')
    if (action === 'start') return send(startClaudeBridge())
    if (action === 'stop') return send(stopClaudeBridge())
    if (action === 'status' || action === '') return send(claudeBridgeStatus())
    return send({ ok: false, error: `未知 action：${action}` }, 400)
  } catch (e) {
    return send({ ok: false, error: e && e.message ? e.message : '桥控制失败' }, 500)
  }
}

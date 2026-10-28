import { existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const PI_BRIDGE_PORT = Number(process.env.PI_BRIDGE_PORT || 8788)
let child = null

async function probe() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1200)
  try {
    const response = await fetch(`http://127.0.0.1:${PI_BRIDGE_PORT}/api/health`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function piBridgeStatus() {
  const running = await probe()
  return { running, port: PI_BRIDGE_PORT, ...(running && child?.exitCode === null ? { pid: child.pid } : {}) }
}

export async function startPiBridge() {
  if (await probe()) return { ok: true, running: true, port: PI_BRIDGE_PORT, note: '已在运行' }
  const script = join(PLUGIN_ROOT, 'bridge', 'pi', 'server.mjs')
  if (!existsSync(script)) return { ok: false, error: `找不到聊天桥脚本：${script}` }
  // P4.26（2026-10-29）：桥的 cwd 决定两件事——会话落盘分区（sessions/<cwd 编码>/）
  // 与项目级 AGENTS.md 的向上查找起点。默认给独立工作区，避免落进 DSH 进程 cwd（可能是 ~ 或插件目录）；
  // 需要换目录时设 PI_BRIDGE_CWD（与 Codex 的工程工作区混用会让两引擎改同一批文件）。
  const bridgeCwd = process.env.PI_BRIDGE_CWD || join(homedir(), 'pi-workspace')
  try { mkdirSync(bridgeCwd, { recursive: true }) } catch { /* best effort */ }
  const proc = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PI_BRIDGE_PORT: String(PI_BRIDGE_PORT), PI_BRIDGE_HOST: '127.0.0.1', PI_BRIDGE_CWD: bridgeCwd },
  })
  proc.unref()
  child = proc
  await new Promise((resolve) => setTimeout(resolve, 700))
  const running = await probe()
  return running
    ? { ok: true, running: true, port: PI_BRIDGE_PORT, url: `http://127.0.0.1:${PI_BRIDGE_PORT}/` }
    : { ok: false, error: `已拉起但 ${PI_BRIDGE_PORT} 无响应` }
}

export async function stopPiBridge() {
  let stoppedByApi = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const headers = process.env.PI_BRIDGE_TOKEN ? { 'x-bridge-token': process.env.PI_BRIDGE_TOKEN } : undefined
    const response = await fetch(`http://127.0.0.1:${PI_BRIDGE_PORT}/api/shutdown`, { method: 'POST', headers, signal: controller.signal })
    stoppedByApi = response.ok
  } catch {
    stoppedByApi = false
  } finally {
    clearTimeout(timer)
  }
  if (child !== null) {
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    child = null
  }
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (!(await probe())) return { ok: true, output: '已停止' }
  }
  return { ok: false, error: stoppedByApi ? `已发出关机指令但 ${PI_BRIDGE_PORT} 仍在响应` : '无法停止：聊天桥仍在响应' }
}

export function piBridgeUrl() {
  return `http://127.0.0.1:${PI_BRIDGE_PORT}/`
}

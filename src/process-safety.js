// Resource limits and append-only audit are observability, not a filesystem sandbox.
import { spawn } from 'node:child_process'
import { openSync, closeSync, fchmodSync, writeSync, mkdirSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const warn = (message) => console.warn(`[second-engine safety] ${message}`)
const sensitive = /(?:key|token|password|passwd|secret|credential|authorization)/i
export function redactArgv(argv) {
  let hideNext = false
  return argv.map((arg) => {
    const text = String(arg)
    if (hideNext) { hideNext = false; return '[REDACTED]' }
    // Covers --api-key value, --token=value, and nested -c api_key=value.
    if (sensitive.test(text)) {
      const equals = text.indexOf('=')
      if (equals >= 0 && /^--?[\w-]+=/.test(text)) return `${text.slice(0, equals)}=[REDACTED]`
      hideNext = true
      return text.startsWith('-') ? text : '[REDACTED]'
    }
    // URLs can contain userinfo or credentials in query parameters.
    return text.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
  })
}
function limit(env, suffix, fallback) {
  const value = env[`SECOND_ENGINE_ULIMIT_${suffix}`]
  if (value === undefined) return fallback
  if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value) * 2)) return Number(value)
  warn(`invalid SECOND_ENGINE_ULIMIT_${suffix}; using ${fallback}`)
  return fallback
}
function append(record) {
  let fd
  try {
    const dir = join(homedir(), '.codex')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    fd = openSync(join(dir, 'second-engine-audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    writeSync(fd, `${JSON.stringify(record)}\n`)
  } catch (error) { warn(`audit append failed (${error.code || 'unknown'})`) }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}
export function finishSpawnAudit(child, exitCode, signal = null, endedAt = new Date().toISOString()) {
  child?.finishSpawnAudit?.(exitCode, signal, endedAt)
}
// detached 后子进程自成进程组，终端 Ctrl-C 不再波及它；宿主正常退出时靠此登记表兜底清组。
const liveGroups = new Set()
let exitHookInstalled = false
function signalGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(-pid, sig); return true } catch { return false } // ESRCH：组已空
}
function auditCleanupFailure(pid, sig, phase) {
  const record = { at: new Date().toISOString(), type: 'process-group-cleanup-failure', pid, signal: sig, phase }
  append(record)
  try { process.stderr.write(`[second-engine safety] process-group cleanup failed pid=${pid} signal=${sig} phase=${phase}\n`) } catch {}
}
function cleanupLiveGroups(sig, phase) {
  for (const pid of liveGroups) {
    if (!signalGroup(pid, sig)) auditCleanupFailure(pid, sig, phase)
  }
}
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => cleanupLiveGroups('SIGKILL', 'exit'))
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      cleanupLiveGroups('SIGKILL', sig)
      // Restore the default action so the host keeps its normal signal exit semantics.
      process.removeListener(sig, handler)
      process.kill(process.pid, sig)
    }
    process.once(sig, handler)
  }
}
export function spawnLimited(command, args = [], options = {}, engine = 'unknown') {
  const env = options.env || process.env
  const f = limit(env, 'F', 102400)
  const u = limit(env, 'U', 512)
  const t = limit(env, 'T', 3600)
  // POSIX sh -f uses 512-byte blocks. Convert the public KB setting to blocks.
  // Probe -u in a subshell: dash treats an unsupported special builtin as fatal.
  const script = `ulimit -f ${f * 2} || printf '%s\\n' '[second-engine safety] ulimit -f failed' >&2; ulimit -t ${t} || printf '%s\\n' '[second-engine safety] ulimit -t failed' >&2; if (ulimit -u ${u}) 2>/dev/null; then ulimit -u ${u}; elif command -v bash >/dev/null 2>&1; then exec bash -c 'ulimit -u "$1" || printf "%s\\n" "[second-engine safety] ulimit -u failed" >&2; shift; exec "$@"' second-engine ${u} "$@"; else printf '%s\\n' '[second-engine safety] ulimit -u unavailable' >&2; fi; exec "$@"`
  const workdir = resolve(options.cwd || process.cwd())
  const record = { id: randomUUID(), at: new Date().toISOString(), engine, workdir,
    argv: redactArgv([command, ...args]), pid: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null }
  const child = spawn('sh', ['-c', script, 'second-engine', command, ...args], { ...options, cwd: workdir, shell: false, detached: true })
  record.pid = child.pid ?? null
  // 对整个进程组发信号；leader 已退出（exitCode/signalCode 非 null）则不发，避免 pgid 被复用后误杀。
  child.killGroup = (sig = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false
    // The guard and kill are separate operations: the leader may exit (or its PGID
    // be reused) between them. A false result is observable and audited by callers.
    const sent = signalGroup(child.pid, sig)
    if (!sent) auditCleanupFailure(child.pid, sig, 'killGroup')
    return sent
  }
  if (Number.isInteger(child.pid)) { liveGroups.add(child.pid); installExitHook() }
  append(record)
  let finished = false
  child.finishSpawnAudit = (code, signal, endedAt) => {
    if (finished) return
    finished = true
    append({ ...record, endedAt: endedAt || new Date().toISOString(), exitCode: code ?? null, signal: signal || null })
  }
  child.once('exit', (code, signal) => {
    finishSpawnAudit(child, code, signal)
    // Leader 已退，仍清掉可能残留的孙进程；此处必须绕过 killGroup 的守卫，
    // 因为 exitCode 已置位，但 check-then-kill 仍可能撞上 PGID 消失/复用竞态。
    if (!signalGroup(child.pid, 'SIGKILL')) auditCleanupFailure(child.pid, 'SIGKILL', 'child-exit')
    liveGroups.delete(child.pid)
  })
  child.once('error', () => { finishSpawnAudit(child, -1); liveGroups.delete(child.pid) })
  return child
}

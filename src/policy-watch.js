import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { noteErr, atomicWriteFileSync } from './core.js'
// ── 绕圈自动提醒（policy-watch）：检测在 turn/end，投递只追加到当次 pre-step ──
const POLICY_WATCH_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'policy-watch.py')
const POLICY_WATCH_PYTHON = process.env.SECOND_ENGINE_PYTHON || 'python3'
const POLICY_WATCH_STATE_PATH = join(homedir(), '.dsh', 'policy-watch', 'last.json')
const POLICY_WATCH_TIMEOUT_MS = 5000
export const POLICY_WATCH_DELIVERY_COOLDOWN_MS = 10 * 60 * 1000
// 送达时效：pending 从算出到送达最多等这么久，超过就作废重扫（2×扫描间隔 + 一轮延迟余量）。
export const POLICY_WATCH_FRESH_MS = 120_000
const POLICY_WATCH_KEEP_LIMIT = 50
export const policyWatchPending = new Map()
export const policyWatchDelivered = new Map()
export const policyWatchHitKeys = new Map()
export const policyWatchFlights = new Map()
export const policyWatchLastStart = new Map()
export const policyWatchLastStat = new Map()
const POLICY_WATCH_MIN_INTERVAL_MS = 30_000
export let policyWatchPythonReady = false
export let policyWatchPythonUnavailable = false
export let policyWatchErrAt = 0
function policyWatchSessionFile(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  try {
    for (const group of readdirSync(root)) {
      const candidate = join(root, group, String(sessionId), 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}
export function policyWatchErr(tag, err) {
  const now = Date.now()
  if (now - policyWatchErrAt < 60_000) return
  policyWatchErrAt = now
  noteErr(tag, err)
}

export function loadPolicyWatchState() {
  try {
    const saved = JSON.parse(readFileSync(POLICY_WATCH_STATE_PATH, 'utf8'))
    for (const [id, entry] of Object.entries(saved.pending || {})) {
      if (entry && typeof entry.at === 'number' && typeof entry.summary === 'string') policyWatchPending.set(id, entry)
    }
    for (const [id, at] of Object.entries(saved.delivered || {})) if (Number.isFinite(at)) policyWatchDelivered.set(id, at)
    for (const [id, keys] of Object.entries(saved.hitKeys || {})) if (Array.isArray(keys)) policyWatchHitKeys.set(id, new Set(keys))
    trimPolicyWatchMaps()
  } catch { /* absent/corrupt state is a silent cold start */ }
}
function trimPolicyWatchMaps() {
  for (const map of [policyWatchPending, policyWatchDelivered, policyWatchHitKeys]) {
    while (map.size > POLICY_WATCH_KEEP_LIMIT) map.delete(map.keys().next().value)
  }
}
export function persistPolicyWatchState() {
  try {
    const dir = dirname(POLICY_WATCH_STATE_PATH)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const payload = {
      pending: Object.fromEntries(policyWatchPending),
      delivered: Object.fromEntries(policyWatchDelivered),
      hitKeys: Object.fromEntries([...policyWatchHitKeys].map(([id, keys]) => [id, [...keys]])),
    }
    atomicWriteFileSync(POLICY_WATCH_STATE_PATH, JSON.stringify(payload), 0o600)
  } catch (e) { policyWatchErr('policy-watch-state', e) }
}
function policyWatchSummary(json) {
  const labels = []
  if (Array.isArray(json.m1) && json.m1.length) labels.push(`M1 同命令同输出重复 ${json.m1.length} 处`)
  if (Array.isArray(json.m2) && json.m2.length) labels.push(`M2 文件编辑 A→B→A 振荡 ${json.m2.length} 处`)
  if (Array.isArray(json.m3) && json.m3.length) labels.push(`M3 连续无状态推进 ${json.m3.length} 处`)
  return labels.join('；')
}
function runPolicyWatch(sessionId, snapshot) {
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolveResult(value) } }
    let child
    try {
      child = execFile(POLICY_WATCH_PYTHON, [POLICY_WATCH_PATH, '--json', '--session', String(sessionId)], { timeout: POLICY_WATCH_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
        const code = error ? (Number.isInteger(error.code) ? error.code : null) : 0
        if (code !== 0 && code !== 10) return finish({ error, snapshot })
        try { finish({ code, json: JSON.parse(stdout), snapshot }) } catch (e) { finish({ error: e, snapshot }) }
      })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish(null) }, POLICY_WATCH_TIMEOUT_MS)
      timer.unref?.()
    } catch (e) { finish({ error: e, snapshot }) }
  })
}
export function startPolicyWatch(sessionId) {
  if (policyWatchPythonUnavailable) return
  if (policyWatchFlights.has(sessionId)) return
  let snapshot
  try {
    const path = policyWatchSessionFile(sessionId)
    if (!path) return
    const stat = statSync(path)
    snapshot = { path, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch { return }
  const prior = policyWatchLastStat.get(sessionId)
  if (prior && (prior.mtimeMs !== snapshot.mtimeMs || prior.size !== snapshot.size)) {
    // 2026-11-03 修：文件变化只更新快照，**不删 pending**。
    // 原逻辑每轮都把上一轮算好的 pending 清掉，导致活跃会话永远收不到提醒——
    // 而「会话还在动」恰恰是停滞检测要抓的场景。过期改由送达侧按时间校验（见 POLICY_WATCH_FRESH_MS）。
    policyWatchLastStat.set(sessionId, snapshot)
  } else if (!prior) policyWatchLastStat.set(sessionId, snapshot)
  const started = policyWatchLastStart.get(sessionId) || 0
  if (Date.now() - started < POLICY_WATCH_MIN_INTERVAL_MS) return
  policyWatchLastStart.set(sessionId, Date.now())
  if (!policyWatchPythonReady) {
    const probe = spawnSync(POLICY_WATCH_PYTHON, ['--version'], { encoding: 'utf8', timeout: 3000 })
    if (probe.error || probe.status !== 0) {
      policyWatchPythonUnavailable = true
      policyWatchErr('policy-watch-python', probe.error || new Error(probe.stderr || 'python interpreter unavailable'))
      return
    }
    policyWatchPythonReady = true
  }
  const flight = runPolicyWatch(sessionId, snapshot)
  policyWatchFlights.set(sessionId, flight)
  void flight.then((result) => {
    if (result?.error) { policyWatchErr('policy-watch-scan', result.error); return }
    if (result.code === 0) {
      // 竞态防护：只有「扫描所用快照仍是当前快照」才认为问题真的消失并清 pending。
      // 否则一次慢扫描（基于旧快照、返回 0）会清掉另一状态下刚生成的 pending。
      const latest = policyWatchLastStat.get(sessionId)
      if (!latest || (latest.mtimeMs === snapshot.mtimeMs && latest.size === snapshot.size)) {
        policyWatchPending.delete(sessionId)
        persistPolicyWatchState()
      }
      return
    }
    if (result.code !== 10) return
    const summary = policyWatchSummary(result.json)
    if (!summary) return
    const now = Date.now()
    const key = createHash('sha256').update(JSON.stringify({ m1: result.json.m1 || [], m2: result.json.m2 || [], m3: result.json.m3 || [] })).digest('hex')
    const keys = policyWatchHitKeys.get(sessionId) || new Set()
    const previous = policyWatchPending.get(sessionId)
    if (keys.has(key) || previous?.key === key) return
    // Identical hit keys stay suppressed for this session; new keys replace the one-shot pending notice.
    keys.add(key)
    while (keys.size > POLICY_WATCH_KEEP_LIMIT) keys.delete(keys.values().next().value)
    policyWatchHitKeys.delete(sessionId)
    policyWatchHitKeys.set(sessionId, keys)
    policyWatchPending.delete(sessionId)
    const hitSeq = (result.json.m1 || []).reduce((mx, x) => Math.max(mx, Number(x.seq) || 0), 0)
    policyWatchPending.set(sessionId, { summary, key, at: now, hitSeq })
    trimPolicyWatchMaps()
    persistPolicyWatchState()
  }).catch((e) => policyWatchErr('policy-watch-scan', e)).finally(() => policyWatchFlights.delete(sessionId))
}

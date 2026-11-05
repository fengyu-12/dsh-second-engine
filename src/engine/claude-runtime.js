// src/engine/claude-runtime.js —— Claude Code 的 TaskRuntime 实现（2026-11-05 新增）
//
// 形态：**一次性子进程**（`claude -p <prompt>` 跑完即退），不是长驻 RPC。
// 双向 NDJSON 模式（`--input-format stream-json`）留作后续会话桥的升级路径，
// 本版先满足 executor：启动 / 事件 / 取消 / 收尾 / 验收。
//
// 方法集与 createRuntime / createPiRpcRuntime **逐个对齐**（合同见 docs/task-runtime-contract.md）：
//   五面 descriptor / start / cancel / heartbeat / snapshot / events / artifacts / finalize
//   + index.js 仍在调的 setChild/child/pid/kill/setApp/interrupt + 字段访问器 + watchdog
//
// 协议解析在 claude-protocol.js，参数构造在 claude-args.js —— 本文件只管生命周期。

import { spawnLimited } from '../process-safety.js'
import { statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeFrameSplitter, parseEvent, pickFinalText } from './claude-protocol.js'
import { buildArgs } from './claude-args.js'

const WATCHDOG_INTERVAL_MS = 30000
const WATCHDOG_STALL_MS = 300000
const STDERR_TAIL_BYTES = 8192
const EVENT_KEEP = 200

export function createClaudeRuntime(task, deps = {}) {
  const { readProcStartTime, stallMs = WATCHDOG_STALL_MS, intervalMs = WATCHDOG_INTERVAL_MS } = deps
  let child = null
  let app = null
  let timer = null
  let ended = false
  let doneResolve = null
  let runOutPath = null
  let assistantText = ''
  let lastResult = null
  let stderrTail = []
  let stderrBytes = 0
  let eventSeq = 0
  const eventBuf = []

  const rt = {
    descriptor: { id: 'claude', transport: 'process' },

    async start(spec = {}) {
      if (child !== null) throw new Error('claude runtime 已启动')
      const args = buildArgs(spec)
      // 提示词走 argv（一次性模式无法避免）；但**API key 绝不进 argv**，只经 env。
      child = spawnLimited('claude', args, {
        cwd: spec.workdir || process.cwd(),
        env: { ...process.env, ...(spec.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      }, 'claude')
      rt.setChild(child)
      runOutPath = typeof spec.outPath === 'string' && spec.outPath !== '' ? spec.outPath : null
      assistantText = ''
      lastResult = null
      ended = false
      eventSeq = 0
      eventBuf.length = 0

      // 子进程身份在 spawn 后立即固定：看门狗在 handled 路径上不会启动，放这里两条路都有值。
      // 判据必须同时覆盖 undefined 与 null —— 3.8.9 的 Pi 教训（只判 undefined ⇒ 失联分支成死代码）。
      if (task.childPid === undefined || task.childPid === null) {
        task.childPid = Number.isInteger(child.pid) ? child.pid : null
        task.childStart = typeof readProcStartTime === 'function' ? readProcStartTime(task.childPid) : null
      }

      const frames = makeFrameSplitter((line) => {
        const evt = parseEvent(line)
        if (evt === null) return
        rt.heartbeat()
        pushEvent(evt)
        if (evt.kind === 'assistant') {
          if (evt.text) assistantText += evt.text
          for (const t of evt.toolUses) rt.pushProgress({ t: Date.now(), tag: 'tool', msg: t.name })
        } else if (evt.kind === 'result') {
          lastResult = evt
        }
      })
      child.stdout?.on('data', (c) => frames.feed(c))
      child.stdout?.on('end', () => { const tail = frames.flush(); if (tail !== '') frames.feed(tail + '\n') })
      // stderr 只攒尾巴排障；**不喂心跳**（引擎噪声会掩盖真停滞）
      child.stderr?.on('data', (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')
        stderrTail.push(b); stderrBytes += b.length
        while (stderrBytes > STDERR_TAIL_BYTES && stderrTail.length > 0) stderrBytes -= stderrTail.shift().length
      })

      child.on('error', (e) => {
        // spawn 失败不会触发 exit：这里兜底，否则 donePromise 永挂
        rt.setAppError(`claude spawn 失败：${e?.message ?? e}`)
        rt.stopWatchdog()
        void rt.finalize({ exitCode: -1, error: `spawn 失败：${e?.message ?? e}` })
      })
      child.on('exit', (code, signal) => {
        rt.setLastSignal(signal)
        rt.stopWatchdog()
        void rt.finalize({ exitCode: Number.isInteger(code) ? code : -1, signal })
      })
      return { pid: child.pid }
    },

    /** 一次性模式没有优雅中断协议：SIGTERM，超时由 finalize 的 SIGKILL 兜底。 */
    async cancel() {
      if (task.cancelled !== true) rt.setCancelled()
      try { if (child !== null) child.kill('SIGTERM') } catch { /* 可能已退出 */ }
    },

    heartbeat(at) {
      const v = at ?? Date.now()
      if (!(v > (Number.isFinite(task.activityAt) ? task.activityAt : 0))) return task.activityAt
      task.activityAt = v
      return v
    },

    snapshot() {
      const cancelled = task.cancelled === true
      return {
        status: cancelled && task.status === 'running' ? 'cancelled' : task.status,
        exitCode: task.exitCode,
        mode: task.mode,
        progress: task.progress,
        liveBytes: task.live !== undefined && task.live !== null ? (task.live.bytes ?? 0) : undefined,
        activityAt: Number.isFinite(task.activityAt) ? task.activityAt : 0,
        stuckSuspect: task.stuckSuspect === true,
        lastSignal: task.lastSignal,
        reconcileLost: task.reconcileLost,
        appError: task.appError,
        error: task.error,
      }
    },

    events(afterSeq = 0) {
      return eventBuf.filter((e) => e.seq > afterSeq)
    },

    artifacts() {
      return { outPath: runOutPath, stderrTail: Buffer.concat(stderrTail).toString('utf8') }
    },

    async finalize(evidence = {}) {
      if (ended) return false
      ended = true
      rt.stopWatchdog()
      // 正文落盘：result.resultText 优先，回退到最后一个 assistant 文本
      const finalText = pickFinalText(lastResult, assistantText)
      if (runOutPath !== null && finalText !== '') {
        try { mkdirSync(dirname(runOutPath), { recursive: true }); writeFileSync(runOutPath, finalText, 'utf8') } catch { /* 落盘失败留给调用方判断 */ }
      }
      if (typeof evidence.error === 'string' && evidence.error !== '') task.error = evidence.error
      if (typeof evidence.lost === 'string' && evidence.lost !== '') rt.setReconcileLost(evidence.lost)
      if (evidence.signal) rt.setLastSignal(evidence.signal)
      const cancelled = evidence.cancelled === true || task.cancelled === true
      // 取消压倒一切（Pi 的教训：显式 exitCode 不能压过取消态）
      const finalCode = cancelled ? -1
        : (lastResult !== null && lastResult.isError === true ? -1
          : (Number.isInteger(evidence.exitCode) ? evidence.exitCode
            : (typeof task.error === 'string' && task.error !== '' ? -1 : 0)))
      rt.setExitCode(finalCode)
      if (child !== null) {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        const t = setTimeout(() => {
          try { if (child !== null && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); rt.setForcedKill() } } catch { /* 已退出 */ }
        }, 5000)
        if (typeof t.unref === 'function') t.unref()
      }
      if (doneResolve !== null) {
        const r = doneResolve; doneResolve = null
        r({ exitCode: finalCode, aborted: cancelled, error: typeof task.error === 'string' ? task.error : '' })
      }
      return true
    },

    // ── 句柄与字段访问器（与 runtime.js / pi-rpc-runtime.js 逐个对齐）──
    setChild(c) { child = c ?? null },
    child() { return child },
    setApp(a) { app = a ?? null },
    pid() { return child !== null && Number.isInteger(child.pid) ? child.pid : null },
    kill(signal) { try { if (child !== null) child.kill(signal) } catch { /* 已退出 */ } },
    interrupt() { void rt.cancel() },
    isCancelled() { return task.cancelled === true },
    setCancelled() { task.cancelled = true },
    setForcedKill() { task.forcedKill = true },
    setLastSignal(sig) { if (sig) task.lastSignal = sig },
    getExitCode() { return task.exitCode },
    setExitCode(code) { task.exitCode = code },
    getOutPath() { return task.outPath },
    setOutPath(p) { task.outPath = p },
    getChildPid() { return task.childPid },
    setChildPid(pid) { task.childPid = pid },
    getChildStart() { return task.childStart },
    setChildStart(st) { task.childStart = st },
    setAppError(e) { task.appError = e },
    setReconcileLost(why) { task.reconcileLost = why },
    pushProgress(entry, limit = 20) {
      task.progress.push(entry)
      while (task.progress.length > limit) task.progress.shift()
    },
    startWatchdog() {
      if (timer !== null) return
      timer = setInterval(() => {
        const now = Date.now()
        const at = Number.isFinite(task.activityAt) ? task.activityAt : 0
        if (now - at > stallMs && task.stuckSuspect !== true) {
          task.stuckSuspect = true
          if (typeof deps.notify === 'function') deps.notify(`claude 任务疑似停滞：${task.id ?? ''}`)
        }
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    stopWatchdog() { if (timer !== null) { try { clearInterval(timer) } catch { /* noop */ } timer = null } },

    /** 供上层等待终态（与 Pi 的 donePromise 同语义）。 */
    done() {
      return new Promise((resolve) => { doneResolve = resolve })
    },
  }

  function pushEvent(evt) {
    eventSeq += 1
    eventBuf.push({ seq: eventSeq, kind: evt.kind, at: Date.now(), evt })
    while (eventBuf.length > EVENT_KEEP) eventBuf.shift()
  }

  return rt
}

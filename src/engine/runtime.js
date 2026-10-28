// TaskRuntime 第一块落地（P3.2，2026-10-28）
//
// 目的：把「公共代码直读引擎字段」逐步收编成方法调用。本合同只搬看门狗与活性相关，
// 其余面（状态/事件/产物/收尾）在 P3.3-P3.7 搬。设计见 docs/task-runtime-contract.md。
//
// 依赖注入：本文件不 import 主模块（避免循环依赖），需要的外部能力由 createRuntime 传入。
import { statSync } from 'node:fs'

export const WATCHDOG_INTERVAL_MS = 30000
export const WATCHDOG_STALL_MS = 300000

/**
 * 产物 mtime（毫秒）：**同时看 `-o` 与 `-o.live` 取最大**；两者都不存在返回 null。
 *
 * 2026-10-28 修：原实现只看 `-o`，但 exec 模式下 codex 的 `-o` 只在**结束时**写一次，
 * 运行期间唯一的实时写入是 `.live`（child.stdout → writeLive）。只看 `-o` 会让长任务
 * 在 300s 后必被误判停滞 —— 实测：任务跑 60s，`-o` 文件压根不存在，`.live` 488B 且没变。
 */
export function outFileMtimeMs(outPath) {
  if (outPath === undefined || outPath === null || outPath === '') return null
  let best = null
  for (const p of [outPath, `${outPath}.live`]) {
    try {
      const m = statSync(p).mtimeMs
      if (best === null || m > best) best = m
    } catch { /* 该文件还没生成 */ }
  }
  return best
}

/**
 * @param {object} task  任务记录（runtime 直接读它，直到 P3 全部收编完）
 * @param {object} deps  { notify(text), readProcStartTime(pid), stallMs?, intervalMs? }
 */
export function createRuntime(task, deps) {
  const { notify, readProcStartTime, stallMs = WATCHDOG_STALL_MS, intervalMs = WATCHDOG_INTERVAL_MS } = deps
  let timer = null
  // P3.3：子进程与 app-server 句柄由 runtime 私有持有 —— 公共代码不再摸 task.child / task.app。
  let child = null
  let app = null

  const rt = {
    descriptor: { id: 'codex', transport: task.app !== undefined && task.app !== null ? 'in-process' : 'process' },

    /**
     * 活性心跳：只抬升 activityAt，**不动 stuckSuspect**。
     * 这与改动前的语义一致 —— 旧代码里事件只写 activityAt，stuckSuspect 的恢复只发生在
     * 看门狗 tick 里发现 mtime 抬升时。若在这里顺手清掉 stuckSuspect，会改变告警行为。
     */
    // ── P3.3：子进程 / app-server 句柄（公共代码只通过这些方法操作）──
    setChild(c) { child = c ?? null },
    child() { return child },
    setApp(a) { app = a ?? null },
    pid() { return child !== null && Number.isInteger(child.pid) ? child.pid : null },
    /** 发信号；进程可能已退出，失败吞掉（与旧 try/catch 语义一致）。 */
    kill(signal) { try { if (child !== null) child.kill(signal) } catch { /* 进程可能刚好自己退出 */ } },
    /** app-server 优雅结束当前 turn；失败吞掉，取消路径靠 SIGTERM/SIGKILL 兜底。 */
    interrupt() {
      if (app !== null && typeof app.interrupt === 'function') {
        void Promise.resolve(app.interrupt()).catch(() => { /* 连接已断等 */ })
      }
    },

    /**
     * 视图投影（P3.6）：公共代码（taskView / taskSummary / 看板）只调它，不再直读字段。
     * cancelled 映射也在这里做 —— 外部看到 'cancelled'，内部 status 仍是 'running'，
     * 直到 finalize 落定（这正是 P2.1 要的「意图 vs 事实」）。
     */
    // ── 字段访问器（P3.4-P3.7）：公共代码只经这些方法读写，不再摸 task.<字段> ──
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
    /** 环形 20 条的进度的唯一写入口（上限与 index.js 的 PROGRESS_LIMIT 保持一致）。 */
    pushProgress(entry, limit = 20) {
      task.progress.push(entry)
      while (task.progress.length > limit) task.progress.shift()
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

    heartbeat(at) {
      const v = at ?? Date.now()
      if (!(v > (Number.isFinite(task.activityAt) ? task.activityAt : 0))) return task.activityAt
      task.activityAt = v
      return v
    },

    /** 每 intervalMs 看一次活性（心跳 ∨ mtime 兜底），超 stallMs 无变化 → stuckSuspect + 通知一次。 */
    startWatchdog() {
      if (timer !== null) return
      // 顺带固定子进程身份（对账 tick 判失联用）：只在首次记录，重复调用不覆盖。
      if (task.childPid === undefined && child !== null) {
        task.childPid = Number.isInteger(child.pid) ? child.pid : null
        task.childStart = readProcStartTime(task.childPid)
      }
      task.activityAt = Date.now()
      timer = setInterval(() => {
        try {
          if (task.endedAt !== null && task.endedAt !== undefined) { rt.stopWatchdog(); return }
          const mtime = task.outPath ? outFileMtimeMs(task.outPath) : null
          if (mtime !== null && mtime > task.activityAt) {
            task.activityAt = mtime
            task.stuckSuspect = false
            return
          }
          if (task.stuckSuspect === true) return
          if (Date.now() - task.activityAt >= stallMs) {
            task.stuckSuspect = true
            const label = task.kind === 'review' ? '复核' : '工单'
            notify(`${label} ${task.id.slice(-6)} 疑似停滞（>${Math.round(stallMs / 1000)}s 无输出更新）`)
          }
        } catch { /* best effort：看门狗自身绝不抛错 */ }
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    },

    stopWatchdog() {
      if (timer === null) return
      try { clearInterval(timer) } catch { /* best effort */ }
      timer = null
    },
  }
  return rt
}

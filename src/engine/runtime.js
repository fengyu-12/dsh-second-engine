// TaskRuntime 第一块落地（P3.2，2026-10-28）
//
// 目的：把「公共代码直读引擎字段」逐步收编成方法调用。本合同只搬看门狗与活性相关，
// 其余面（状态/事件/产物/收尾）在 P3.3-P3.7 搬。设计见 docs/task-runtime-contract.md。
//
// 依赖注入：本文件不 import 主模块（避免循环依赖），需要的外部能力由 createRuntime 传入。
import { statSync } from 'node:fs'

export const WATCHDOG_INTERVAL_MS = 30000
export const WATCHDOG_STALL_MS = 300000

/** -o 输出文件 mtime（毫秒）；文件还没生成时返回 null。 */
export function outFileMtimeMs(outPath) {
  if (outPath === undefined || outPath === null || outPath === '') return null
  try { return statSync(outPath).mtimeMs } catch { return null }
}

/**
 * @param {object} task  任务记录（runtime 直接读它，直到 P3 全部收编完）
 * @param {object} deps  { notify(text), readProcStartTime(pid), stallMs?, intervalMs? }
 */
export function createRuntime(task, deps) {
  const { notify, readProcStartTime, stallMs = WATCHDOG_STALL_MS, intervalMs = WATCHDOG_INTERVAL_MS } = deps
  let timer = null

  const rt = {
    descriptor: { id: 'codex', transport: task.app !== undefined && task.app !== null ? 'in-process' : 'process' },

    /**
     * 活性心跳：只抬升 activityAt，**不动 stuckSuspect**。
     * 这与改动前的语义一致 —— 旧代码里事件只写 activityAt，stuckSuspect 的恢复只发生在
     * 看门狗 tick 里发现 mtime 抬升时。若在这里顺手清掉 stuckSuspect，会改变告警行为。
     */
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
      if (task.childPid === undefined && task.child !== null && task.child !== undefined) {
        task.childPid = Number.isInteger(task.child.pid) ? task.child.pid : null
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

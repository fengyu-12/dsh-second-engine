// src/engine/pi-rpc-runtime.js —— Pi 引擎的 **RPC 长驻** TaskRuntime 实现（P4.2，2026-10-28）
//
// 与 json 版（`pi-runtime.js`）的关系：**事件映射完全复用** `mapPiEvent`，本文件不重写映射表。
// 形态差别：
//   · json 版 —— 每次 `pi --print --mode json` 起一次性子进程，stdout 跑完即退出；
//   · RPC 版 —— **一个长驻 `pi --mode rpc --no-session` 子进程**：stdin 发命令，
//     stdout 同时收 `response`（命令回执）与 session event
//     （rpc.md「Protocol records」四类记录里 stdout 的那两类）。
//
// 方法集与 `runtime.js` 的 `createRuntime` **逐个对齐**（那是接口形状的唯一标准）：
//   合同五面 —— descriptor / capabilities / start / cancel / heartbeat / snapshot /
//               events / artifacts / finalize
//   index.js 仍在调的 —— setChild / child / pid / kill / setApp / interrupt
//                       + 字段访问器（isCancelled … pushProgress）+ start/stopWatchdog
// 合同见 docs/task-runtime-contract.md。依赖注入方式同 runtime.js：不 import 主模块
// （避免循环依赖），外部能力由 createPiRpcRuntime 的 deps 传入。
//
// 只用 node 标准库：node:child_process、node:fs。无第三方、**无 readline**（原因见帧格式）。

import { spawn } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { mapPiEvent } from './pi-runtime.js'

// ── 常量（阈值与 Codex 侧对齐，便于公共代码统一处理）──
const WATCHDOG_INTERVAL_MS = 30000
const WATCHDOG_STALL_MS = 300000
/** 命令回执超时：只覆盖「命令有没有被处理」，**不覆盖模型跑多久**（rpc.md「Run lifecycle」）。 */
const COMMAND_TIMEOUT_MS = 60000
/** 优雅取消：`abort` 回执等待上限；拿不到才升级到 SIGTERM。 */
const ABORT_TIMEOUT_MS = 15000
/** SIGTERM → SIGKILL 宽限（与 index.js 的 KILL_GRACE_MS 同语义）。 */
const KILL_GRACE_MS = 3000
/** 对外 progress / 事件缓冲的环形上限（与 index.js 的 PROGRESS_LIMIT 一致）。 */
const PROGRESS_LIMIT = 20
/** 排障原文环形上限（不对外；对齐 task.engineEvents 的定位）。 */
const RAW_LIMIT = 50
/** 未回执命令数上限：超过即视为对端异常，拒绝继续下发（防泄漏）。 */
const PENDING_LIMIT = 64
/** stderr 环形尾巴字节数：只在排障时读，不参与任何状态判定。 */
const STDERR_TAIL_BYTES = 8192
/** stdin 在写队列字节上限（背压保护，见「写命令」）。 */
const STDIN_QUEUE_BYTES = 1024 * 1024
/** events() 无新事件时的最长等待（避免忙等，也保证 ended 能被观察到）。 */
const EVENT_POLL_MS = 1000

// ── 命令白名单（rpc-commands.md 的 22 个 stdin 命令；未知类型一律不发）──
const COMMAND_TYPES = [
  // Prompting（rpc-commands.md「## Prompting」）
  'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session',
  // State（「## State」）
  'get_state', 'get_messages',
  // Model（「## Model」）
  'set_model', 'cycle_model', 'get_available_models',
  // Thinking（「## Thinking」）
  'set_thinking_level', 'cycle_thinking_level', 'get_available_thinking_levels',
  // Queue modes（「## Queue modes」）
  'set_steering_mode', 'set_follow_up_mode',
  // Compaction / Retry（「## Compaction」「## Retry」）
  'compact', 'set_auto_compaction', 'set_auto_retry', 'abort_retry',
  // Bash（「## Bash」）
  'bash', 'abort_bash',
  // Session（「## Session」）
  'get_session_stats', 'export_html', 'switch_session', 'fork', 'clone',
  'get_fork_messages', 'get_entries', 'get_tree', 'get_last_assistant_text', 'set_session_name',
  // Discoverable commands（「## Discoverable commands」）
  'get_commands',
]
const COMMAND_SET = new Set(COMMAND_TYPES)

/**
 * RPC 专有事件的 kind 补充。
 * 为什么只有三条：`mapPiEvent` 的 KIND_BY_TYPE 覆盖 json 模式一次跑完会见的 15 类；RPC
 * 长驻还多出 tool_execution_* / queue_update / entry_appended / session_info_changed /
 * thinking_level_changed / compaction_* / auto_retry_* / summarization_retry_* /
 * extension_error / bash_execution_update（json.md「Tool execution events」「Queue and
 * state events」「Compaction events」「Retry events」「RPC-only events」）。
 * mapPiEvent 对**未列出的 type 已降级为 'status'**（合同要求：绝不把引擎专有 type 外发），
 * 所以这里不重写映射表，只把 RPC 才有、语义上确属 tool 的三条显式标出来。
 */
const RPC_KIND_OVERRIDE = {
  tool_execution_start: 'tool',
  tool_execution_update: 'tool',
  tool_execution_end: 'tool',
}

/**
 * UTF-8 安全的 **只按 LF 分帧** 切分器（带 `flush()` 取尾记录）。
 *
 * 协议依据（rpc.md「Framing」/ json.md「Framing and process I/O」）：
 *   · 严格 JSONL：一条记录一个完整 JSON 对象，以 LF(`\n`) 结尾；
 *   · **只按 LF 切**，可选的前置 CR 要剥掉（接受 CRLF）；
 *   · **明确禁止 Node `readline`** —— 它还会把 U+2028 / U+2029 当行边界，而这两个字符在
 *     JSON 字符串里合法 ⇒ 一条记录会被从中间切开。
 * 实现口径：按 **字节** 缓冲找 0x0A。LF 在 UTF-8 里永不会作为多字节序列的后续字节出现，
 * 所以按字节定位记录边界既安全又天然规避「chunk 落在多字节字符中间」的坏码问题；
 * 每条完整记录再单独 utf8 解码。
 */
function makeFrameSplitter(onLine) {
  let buf = Buffer.alloc(0)
  return {
    feed(chunk) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      buf = buf.length === 0 ? part : Buffer.concat([buf, part])
      let idx = buf.indexOf(0x0a)
      while (idx >= 0) {
        let rec = buf.subarray(0, idx)
        buf = buf.subarray(idx + 1)
        // 剥掉可选前置 CR（rpc.md「Strip an optional preceding carriage return」）
        if (rec.length > 0 && rec[rec.length - 1] === 0x0d) rec = rec.subarray(0, rec.length - 1)
        if (rec.length > 0) onLine(rec.toString('utf8'))
        idx = buf.indexOf(0x0a)
      }
    },
    /** 进程 stdout 结束时取走没有换行的尾记录（可能半截，解析失败由调用方兜）。 */
    flush() {
      if (buf.length === 0) return ''
      let rec = buf
      buf = Buffer.alloc(0)
      if (rec.length > 0 && rec[rec.length - 1] === 0x0d) rec = rec.subarray(0, rec.length - 1)
      return rec.length === 0 ? '' : rec.toString('utf8')
    },
  }
}

/**
 * 产物 mtime（毫秒）：同时看 `outPath` 与 `outPath.live`，取最大；都没有 → null。
 * 与 runtime.js 的 outFileMtimeMs 同语义（那份注释解释了为什么两个都必须看：exec 侧
 * `-o` 只在结束时写一次，运行期间唯一实时写入是 `.live`）。Pi 侧通常两者都没有，
 * 于是判据自然退化成「只看显式心跳」—— 这正是 P1.1 要的效果。
 */
function outFileMtimeMs(outPath) {
  if (typeof outPath !== 'string' || outPath === '') return null
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
 * @param {object} task  任务记录（与 runtime.js 一致：P3 全部收编前仍直接读写它）
 * @param {object} deps  { notify?, readProcStartTime?, piBinary?, provider?, model?,
 *                         extraArgs?, env?, stallMs?, intervalMs?, commandTimeoutMs?,
 *                         abortTimeoutMs?, killGraceMs?, now? }
 */
export function createPiRpcRuntime(task, deps = {}) {
  const {
    notify,
    readProcStartTime,
    piBinary = 'pi',
    provider,
    model,
    extraArgs = [],
    env = {},
    stallMs = WATCHDOG_STALL_MS,
    intervalMs = WATCHDOG_INTERVAL_MS,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    abortTimeoutMs = ABORT_TIMEOUT_MS,
    killGraceMs = KILL_GRACE_MS,
    now = () => Date.now(),
  } = deps

  // ── runtime 私有状态（合同：公共代码不得持有子进程，也不得自己 kill）──
  let child = null
  let app = null                 // 与 Codex 版对齐的槽位；RPC 无独立连接句柄，只存不读
  void app
  let timer = null
  let seq = 0                    // 事件单调序号（合同 §五.1 的游标语义：选 seq，缓冲内可重放）
  let ended = false              // finalize 幂等哨兵（等价 index.js 的 endedAt 哨兵）
  let stdinEnded = false
  let idCounter = 0

  // ── A 方案（2026-10-28）：runtime 只上报证据，终态由 index.js 的 finalizeJob 唯一落定 ──
  // 原实现自己写 task.status/endedAt，会让 finalizeJob 的幂等哨兵直接 return false，
  // 于是「读 output / 删产物 / 发通知」三件事全被跳过。这里改成 resolve 一个 Promise。
  let doneResolve = null
  const donePromise = new Promise((res) => { doneResolve = res })
  let stdinQueueBytes = 0
  let stderrBytes = 0
  let stateInFlight = false
  let stateDirty = false
  let runEpoch = 0
  const pending = new Map()      // id → { resolve, reject, timer, command }
  const stderrTail = []
  const listeners = new Set()    // events() 的订阅者
  // events() 的兜底唤醒表：事件驱动（listeners）之外的最后防线 —— 环形缓冲丢条目、
  // 或 ended 在两次事件之间翻转时，等待者不会睡死到 EVENT_POLL_MS 之后。
  const pollers = new Set()
  const viewEvents = []          // 对外 progress：{kind,text,at,seq}，环形 PROGRESS_LIMIT
  const rawEvents = []           // 排障原文（**不进 snapshot().progress**）

  // get_state 是异步的，而 snapshot() 是同步签名（合同明写「别在里面 await」）：
  // 只维护「最近一次**已知**状态」缓存，由 start / 看门狗 tick / 事件推断三处刷新。
  let stateCache = {
    model: undefined, thinkingLevel: undefined, isStreaming: false, isCompacting: false,
    sessionId: undefined, sessionFile: undefined, messageCount: 0, pendingMessageCount: 0,
    usage: undefined, promptDisposition: undefined, at: 0,
  }
  let statsCache = null          // get_session_stats 缓存（tokens / cost / contextUsage）
  // 终局证据缓存（json.md「Agent and turn events」：agent_settled.aborted / agent_end.willRetry）
  let settled = null             // { aborted, at }
  let agentEnd = null            // { willRetry, at, messageCount, stopReason, errorMessage }

  // 2026-10-31（Pi 自证 + 包内源码核实）：一次 prompt **只会 emit 一次** `agent_settled`
  //（`dist/core/agent-session.js` 的 `_startRun()` 在 finally 里 emit，正常/重试/压缩恢复/抛错
  // 都只收尾一次）⇒ settle 就是本轮终点，收到即收尾，**不等进程退出**（`pi --mode rpc` 是长驻
  // 进程，永远不退 —— 2026-10-31 04:0x 实机复现过「跑完仍 running」）。drain 窗口只挡
  // 「extension 在 settle 期间又起一个新 run」这一种情况（本机无 extensions 目录，实际不触发）。
  let drainTimer = null
  const SETTLE_DRAIN_MS = 1500

  // settle 后调度收尾。drain 窗口内若又来了 agent_start，由下方 handleRecord 取消。
  function scheduleSettle() {
    if (ended || drainTimer !== null) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      if (ended) return
      // 成败**不看 settle**：settle 只说明"不再自动继续"，不说明成功。看最后一条 assistant
      // message 的 stopReason（message-types.md：pending|stop|length|toolUse|error|aborted|deferred）。
      // 2026-10-31 修（Codex 审核）：原来是**黑名单**（只有 error/length 判失败），于是
      // pending / deferred / 空值 / 将来新增的枚举都静默记成成功 —— "不知道是否成功"绝不能
      // 写成成功。改成**正向白名单**：只有明确终态 `stop` 才算成功，其余一律按失败收尾并带原因。
      const stop = typeof agentEnd?.stopReason === 'string' ? agentEnd.stopReason : ''
      const aborted = settled?.aborted === true || stop === 'aborted'
      const ok = !aborted && stop === 'stop'
      const bad = !aborted && !ok
      void rt.finalize({
        exitCode: aborted || bad ? -1 : 0,
        cancelled: aborted,
        error: bad ? (agentEnd?.errorMessage || `未识别的终态 stopReason=${stop === '' ? '(空)' : stop}`) : undefined,
      })
    }, SETTLE_DRAIN_MS)
    if (typeof drainTimer.unref === 'function') drainTimer.unref()
  }

  const nextId = (prefix) => `${prefix || 'cmd'}-${String(task.id ?? 't')}-${++idCounter}`

  function pushRaw(rec) {
    rawEvents.push({ at: now(), seq, type: rec?.type, raw: rec })
    while (rawEvents.length > RAW_LIMIT) rawEvents.shift()
  }

  // ── P4：把最后一条 assistant 正文落到 spec.outPath（对齐 Codex 的产物约定）──
  // Pi 不写 `-o`，而 index.js 的 finalizeJob 会 readHeadTail(task.outPath)。
  // 不补这一步，切到 Pi 之后每单 output 都是空的（外部模型在交付里点名的第一个风险）。
  let runOutPath = null
  let lastAssistantText = ''

  function textOfMessage(m) {
    const c = m?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
    return ''
  }

  async function captureAssistantText(epoch = runEpoch) {
    const outPath = runOutPath
    if (outPath === null) return
    try {
      const data = await sendCommand('get_messages', {}, Math.min(commandTimeoutMs, 8000))
      if (epoch !== runEpoch || outPath !== runOutPath) return
      const list = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : [])
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i]?.role === 'assistant') { lastAssistantText = textOfMessage(list[i]); return }
      }
    } catch { /* 进程已退出 / 超时：宁可留空，不伪造 */ }
  }

  function flushAssistantToOut() {
    if (runOutPath === null || lastAssistantText === '') return
    try { writeFileSync(runOutPath, lastAssistantText, 'utf8') } catch { /* 目录不存在等 */ }
  }

  // ── 写命令（rpc.md「Honor stdin backpressure when writing commands」）──
  function writeRecord(rec) {
    // child.error 要先于 stdin 状态判：ENOENT 时 stdin 已毁但**不会触发 exit**
    // （Node 语义），若只等 exit 就会挂到命令超时才报错。错误原因由 'error' 监听器先记。
    if (child?.error !== undefined && child.error !== null) return false
    if (child === null || child.stdin === null || child.stdin.destroyed || stdinEnded) return false
    const line = `${JSON.stringify(rec)}\n`
    const bytes = Buffer.byteLength(line)
    // 有界排队：超限直接拒发（命令层会 reject），不无界堆积把宿主内存吃掉。
    if (stdinQueueBytes + bytes > STDIN_QUEUE_BYTES) return false
    stdinQueueBytes += bytes
    // 数据交给 stream 内部队列即算已发；回调确认落pipe后才出账。write() 返回 false 时
    // **不丢数据、也不额外缓冲** —— 队列账本已覆盖，'drain' 无需特殊处理。
    child.stdin.write(line, 'utf8', () => { stdinQueueBytes -= bytes })
    return true
  }

  /**
   * 发命令并等回执。
   * 协议依据（rpc.md「Correlate commands and responses」）：命令处理是**异步**的，必须按
   * `id` 关联而不是按响应顺序；session event 一般无 id，**唯一例外是 `bash_execution_update`**
   * （json.md「RPC-only events」：它复用发起 `bash` 命令的 id）—— 所以下面分发时，带 id 的
   * session event 绝不能被当成命令回执吃掉。
   */
  function sendCommand(type, fields = {}, timeoutMs = commandTimeoutMs) {
    if (!COMMAND_SET.has(type)) return Promise.reject(new Error(`未知的 pi RPC 命令：${type}`))
    if (child === null || stdinEnded) return Promise.reject(new Error('pi rpc 子进程不可用'))
    if (pending.size >= PENDING_LIMIT) return Promise.reject(new Error('待回执命令过多，暂停下发'))
    const id = nextId(type)
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, command: type, timer: null }
      // 超时只说明「回执没来」，不代表模型没在跑（rpc.md「Run lifecycle」）。
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`pi RPC 命令超时：${type}`))
        }, timeoutMs)
        if (typeof entry.timer.unref === 'function') entry.timer.unref()
      }
      pending.set(id, entry)
      if (!writeRecord({ id, type, ...fields })) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        pending.delete(id)
        // 优先报 spawn 失败原因（ENOENT 之类），其次才是 stdin 状态。
        const reason = typeof child?.error?.message === 'string' ? child.error.message
          : (stdinEnded ? 'stdin 已关闭' : (child?.stdin?.destroyed === true ? 'stdin 已毁' : '背压超限'))
        reject(new Error(`pi rpc 命令下发失败：${reason}`))
      }
    })
  }

  function settle(id, ok, payload) {
    const entry = pending.get(id)
    if (entry === undefined) return false      // 迟到回执 / 无主回执
    pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (ok) entry.resolve(payload)
    else entry.reject(new Error(typeof payload?.error === 'string' ? payload.error : `命令失败：${entry.command}`))
    return true
  }

  /** 子进程消失时唤醒所有等待者，避免 start()/cancel() 永久挂起。 */
  function rejectAllPending(reason) {
    for (const entry of pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      try { entry.reject(new Error(reason)) } catch { /* 已 settle */ }
    }
    pending.clear()
  }

  // ── 记录分发（rpc.md「Protocol records」：stdin=command；stdout=response / session event；双向=extension UI）──
  function handleRecord(line) {
    let rec
    try { rec = JSON.parse(line) } catch {
      // rpc.md「Errors」：对端遇到畸形 JSON 会自己回 {"type":"response","command":"parse",...}。
      // 我方解析失败只留痕；**绝不把 stderr 当协议数据**（rpc.md「Do not parse stderr as
      // protocol data」），也不因此改状态。
      pushRaw({ type: '__parse_error__' })
      return
    }
    if (rec === null || typeof rec !== 'object') return
    const type = rec.type

    // (1) response：按 id 回显关联；失败形态见 rpc.md「Errors」（success:false + error）。
    if (type === 'response') {
      const ok = rec.success === true
      if (typeof rec.id === 'string' && pending.has(rec.id)) {
        settle(rec.id, ok, ok ? rec.data : rec)
      } else {
        // 无 id 的 parse 回执 / 已超时后的迟到回执：只留痕。
        pushRaw({ type: '__response_orphan__', command: rec.command, error: rec.error })
      }
      return
    }

    // (2) extension UI（rpc.md 第四类）。本实现 **capabilities.approvals = false**：
    //     不应答 extension_ui_request（rpc.md 明确它按请求自身 id 回 extension_ui_response，
    //     不产生普通 command response）。只留痕，让「有扩展在问、我方没答」这件事看得见。
    if (type === 'extension_ui_request' || type === 'extension_ui_response') { pushRaw(rec); return }

    // (3) session event：映射**复用 mapPiEvent**（不重写映射表；未知 type 由它兜底降 'status'）。
    const at = now()
    const mapped = mapPiEvent(rec, at)
    const kind = RPC_KIND_OVERRIDE[type] ?? mapped.kind
    seq += 1
    const entry = { kind, text: mapped.text, at, seq }

    // 终局 / 用量 / 运行态证据：进私有缓存，**不塞进对外 progress 条目**
    //（progress 是封闭三元组 + seq；mapPiEvent 附带的 usage/aborted/willRetry 属引擎形状）。
    if (type === 'agent_settled') {
      settled = { aborted: rec.aborted === true, at }
      stateCache = { ...stateCache, isStreaming: false, at }
      void captureAssistantText()   // 进程还活着，这是取正文最可靠的时机
    } else if (type === 'agent_end') {
      // 2026-10-31：顺带取最后一条 message 的 stopReason / errorMessage —— 这是**唯一**能判
      // 本轮成败的依据（RPC 模式没有退出码语义，print 模式的非 0 退出码在这里不适用）。
      const msgs = Array.isArray(rec.messages) ? rec.messages : []
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
      agentEnd = {
        willRetry: rec.willRetry === true, at, messageCount: msgs.length,
        stopReason: typeof last?.stopReason === 'string' ? last.stopReason : '',
        errorMessage: typeof last?.errorMessage === 'string' ? last.errorMessage : '',
      }
    } else if (type === 'agent_start') {
      stateCache = { ...stateCache, isStreaming: true, at }
      // 2026-10-31 修（Codex 审核）：新 run 开始必须**清掉上一轮的终局证据**。原先只清
      // drain 计时器，`settled` / `agentEnd` 留着 —— 若新 run 在 drain 内开始、1.5s 后还没
      // 结束，旧 `agentEnd.stopReason='stop'` 会被当成本轮的成功证据，把未完成记成 done。
      settled = null
      agentEnd = null
    } else if (type === 'compaction_start') {
      stateCache = { ...stateCache, isCompacting: true, at }
    } else if (type === 'compaction_end') {
      stateCache = { ...stateCache, isCompacting: false, at }
    }
    if (type === 'agent_settled') {
      // Refresh after every settled turn to update session metadata and usage state.
      void refreshState()
      // 2026-10-31 修：原先这里什么都不做 —— 长驻进程不会 exit，于是任务永远 running
      //（实机复现：任务跑完、产物有内容、`GET /task` 一直 running）。settle 即终点，调度收尾。
      scheduleSettle()
    }
    // drain 窗口里的新 run（extension 延后启动）⇒ 取消收尾，等下一次 settle。
    if (type === 'agent_start' && drainTimer !== null) {
      try { clearTimeout(drainTimer) } catch { /* noop */ }
      drainTimer = null
    }
    // 用量：json.md 说 message_update.usage 是「该 assistant 响应的最新累计 provider 用量」
    // ⇒ 直接覆盖缓存（跨会话总量另问 get_session_stats，见 fetchStats）。
    if (mapped.usage !== undefined) stateCache = { ...stateCache, usage: mapped.usage, at }

    viewEvents.push(entry)
    while (viewEvents.length > PROGRESS_LIMIT) viewEvents.shift()
    pushRaw(rec)
    for (const fn of listeners) { try { fn() } catch { /* 消费方异常不影响引擎 */ } }
    // 心跳：事件即活性。**不在这里清 stuckSuspect** —— 与 runtime.js 的 heartbeat 同一条
    // 铁律（清了会改告警行为：恢复只发生在看门狗 tick 里）。
    touchActivity(at)
  }

  // ── 活性（对齐 P1.1：显式心跳为主，产物 mtime 只作兜底项）──
  function touchActivity(v) {
    const cur = Number.isFinite(task.activityAt) ? task.activityAt : 0
    if (!(v > cur)) return cur
    task.activityAt = v
    return v
  }

  // ── get_state 刷新（异步；snapshot() 只读缓存）──
  async function refreshState() {
    if (ended) return stateCache
    if (stateInFlight) { stateDirty = true; return stateCache }
    stateInFlight = true
    try {
      do {
        stateDirty = false
        try {
          const data = await sendCommand('get_state', {}, commandTimeoutMs)
          if (data !== null && typeof data === 'object') {
            stateCache = {
              ...stateCache,
              model: data.model,
              thinkingLevel: data.thinkingLevel,
              isStreaming: data.isStreaming === true,
              isCompacting: data.isCompacting === true,
              sessionId: data.sessionId,
              sessionFile: data.sessionFile,
              messageCount: Number.isFinite(data.messageCount) ? data.messageCount : stateCache.messageCount,
              pendingMessageCount: Number.isFinite(data.pendingMessageCount) ? data.pendingMessageCount : stateCache.pendingMessageCount,
              at: now(),
            }
          }
        } catch { /* retain prior snapshot */ }
      } while (stateDirty && !ended)
    } finally { stateInFlight = false }
    return stateCache
  }

  /** rpc.md「Shutdown」：关闭子进程 stdin 即请求有序退出（Pi 先 dispose 活跃 runtime）。 */
  function closeStdin() {
    if (stdinEnded) return
    stdinEnded = true
    try { child?.stdin?.end() } catch { /* 已关闭 */ }
  }

  // 帧切分器（stdout 唯一入口）；尾记录在 'end'/'exit' 时经 flush() 取一次。
  const frames = makeFrameSplitter(handleRecord)
  let tailFlushed = false
  function flushTail() {
    if (tailFlushed) return
    tailFlushed = true
    const tail = frames.flush()
    if (tail !== '') handleRecord(tail)
  }

  // events() 兜底 tick：只在有等待者时存在，清空后自动 unref 停掉（不常驻吊住宿主）。
  let pollTimer = null
  function ensurePollTimer() {
    if (pollers.size === 0) {
      if (pollTimer !== null) { try { clearInterval(pollTimer) } catch { /* noop */ } pollTimer = null }
      return
    }
    if (pollTimer !== null) return
    pollTimer = setInterval(() => {
      for (const fn of pollers) { try { fn() } catch { /* 消费方异常不影响引擎 */ } }
      if (pollers.size === 0) ensurePollTimer()
    }, EVENT_POLL_MS)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  const rt = {
    // ── 合同面 1：描述符 + 能力 ──
    // transport='process'（子进程 + 管道）。合同强调这是**实现方式**，不是能力。
    /** A 方案：finalize 只 resolve 本 Promise；终态写入归 index.js 的 finalizeJob。 */
    done: donePromise,
    descriptor: { id: 'pi', transport: 'process' },
    // 能力按**已实现**如实声明（§3.2 的教训：协议支持 ≠ 已接通）。
    capabilities: {
      eventStream: 'fine',   // json.md：delta 级 message_update + 工具/队列/压缩/重试事件
      approvals: false,      // 不应答 extension_ui_request（见 handleRecord 分支 2）
      resume: false,         // 跑 --no-session，且不发 switch_session / fork / new_session
      checkpoint: false,     // Pi 侧无 file-checkpoint 对应物
      usage: true,           // message_update.usage + get_session_stats
    },

    // ── 合同面 2：生命周期 ──
    /**
     * 起长驻子进程并下发 prompt。**不阻塞等模型跑完**：
     * rpc.md「Run lifecycle」—— prompt 的 response 只代表「已受理 / 已入队 / 已处理」，
     * `data.disposition` ∈ started | queued | handled（取值见 rpc-commands.md「prompt」）。
     * **handled 时不会跑模型、也就不会有 agent_settled**（rpc.md 明说「don't wait for
     * agent_settled」）；`success:true` 只覆盖命令被处理，接受后的 provider 失败/中止走事件流，
     * 不会再回同一个 id 的 response。
     */
    async start(spec = {}) {
      if (child !== null) throw new Error('pi rpc runtime 已启动')
      const args = ['--mode', 'rpc', '--no-session']
      if (provider) args.push('--provider', provider)
      if (model) args.push('--model', model)
      args.push(...extraArgs)
      // rpc.md「Start RPC mode」：RPC 模式**拒绝 @file 形式的 prompt 参数** ⇒ 提示词只经
      // stdin 的 prompt 命令下发，绝不进 argv（顺带避免 /proc/cmdline 泄提示词，同 exec 支）。
      child = spawn(piBinary, args, {
        cwd: spec.workdir || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      rt.setChild(child)
      runEpoch += 1
      runOutPath = typeof spec.outPath === 'string' && spec.outPath !== '' ? spec.outPath : null
      lastAssistantText = ''
      // 每次 spawn 都要复位这两个标志：closeStdin() 置过 stdinEnded、上一次 run 可能
      // 置过 tailFlushed —— 不复位的话，同一个 runtime 再 start() 会在 writeRecord 里
      // 静默判定「stdin 不可用」（实测踩过：第二次 start 直接 reject 子进程不可用）。
      stdinEnded = false
      tailFlushed = false
      // 子进程身份**在 spawn 后立即固定**，不等 startWatchdog（runtime.js 是在 startWatchdog
      // 里顺带做的）：对账 tick 判失联要用 pid+start，而看门狗在 disposition='handled' 那条
      // 路径上根本不会启动 —— 放这里两条路径都有值。
      // 2026-10-31 修（Codex 复核发现）：原判据是 `=== undefined`，而 index.js 的
      // startPiTask 把 childPid 初始化为 **null** ⇒ 这里永远不登记；probeTaskLost 对非整数
      // 又直接返回 null ⇒ Pi 任务永远判不出失联，reconcile 的收尾分支成了死代码。
      // 两种"未登记"（undefined / null）都要覆盖，写成显式双判而非 == 以免 lint 争议。
      if (task.childPid === undefined || task.childPid === null) {
        task.childPid = Number.isInteger(child.pid) ? child.pid : null
        task.childStart = typeof readProcStartTime === 'function' ? readProcStartTime(task.childPid) : null
      }

      // 背压（rpc.md「Read stdout continuously… a client that stops reading can stall the
      // process」）：stdout/stderr **一律连续读**，onLine 内不做同步重活（映射 + 环形 push）。
      // 不用 readline —— 帧格式一节已说明 U+2028/U+2029 的原因。
      child.stdout?.on('data', (chunk) => { frames.feed(chunk) })
      child.stdout?.on('end', flushTail)
      // stderr：只攒尾巴供排障（rpc.md「Do not parse stderr as protocol data」）；
      // **不喂心跳** —— 否则引擎的噪声日志会掩盖真停滞。
      child.stderr?.on('data', (chunk) => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        stderrTail.push(b)
        stderrBytes += b.length
        while (stderrBytes > STDERR_TAIL_BYTES && stderrTail.length > 0) {
          stderrBytes -= stderrTail.shift().length
        }
      })

      // 订阅先于 prompt（rpc.md「Subscribe before sending a prompt to avoid missing a fast
      // completion」）：监听器在 spawn 后立刻挂好，天然满足，不需要 RpcClient 那套 promptAndWait。
      child.on('error', (e) => {
        // 启动失败（ENOENT / 无权限）**不会触发 exit** —— 这里兜底，语义同 index.js。
        rt.setAppError(`pi rpc spawn 失败：${e?.message ?? e}`)
        rejectAllPending('pi rpc 子进程错误')
        // 2026-10-31 修：spawn 失败走不到 exit，漏 finalize 会让 donePromise 一直挂着等上层
        // 超时（子进程根本不存在，wait 永不 resolve）。finalize 有 ended 幂等哨兵，之后即便
        // 真来了 exit 也不会重复落定，所以这里放心收尾。
        flushTail()
        rt.stopWatchdog()
        void rt.finalize({ exitCode: -1 })
      })
      child.on('exit', (code, signal) => {
        flushTail()
        rt.setLastSignal(signal)
        rejectAllPending('pi rpc 子进程已退出')
        rt.stopWatchdog()
        // 唯一收尾入口仍是 finalize（合同铁律：runtime 不在事件回调里自己落定状态）。
        void rt.finalize({ exitCode: Number.isInteger(code) ? code : -1, signal: signal ?? undefined })
      })

      // 先拉一份 get_state 填缓存（await 的是**命令回执**，不是模型完成）。
      await refreshState()

      // 字段名以 rpc-commands.md「prompt」为准：message（+ 可选 images / streamingBehavior）。
      const data = await sendCommand('prompt', { message: spec.prompt ?? '' }, commandTimeoutMs)
      const disposition = data?.disposition
      stateCache = { ...stateCache, promptDisposition: disposition, at: now() }
      rt.startWatchdog()
      if (disposition === 'handled') {
        // A handler consumed the prompt without invoking a model; leave an explicit artifact.
        pushRaw({ type: '__prompt_handled_no_run__' })
        if (runOutPath !== null && lastAssistantText === '') {
          lastAssistantText = '[Pi 已处理该提示，但没有生成 assistant 回复。]'
          flushAssistantToOut()
        }
        void rt.finalize({ exitCode: 0 })
      }
      return undefined
    },

    /**
     * 取消：**先发 `abort` 命令（优雅中断），不是 SIGTERM**
     * （rpc-commands.md「abort」：中止当前操作并**等 session 空闲后**才回执）。
     * 信号只是 abort 拿不到回执时的兜底；完整终止链在 finalize 里。
     * 幂等：重复调用只重发 abort，不叠加 kill 计时器。
     */
    async cancel() {
      rt.setCancelled()          // 只写意图；终局仍由 finalize 落定（合同 P2.1）
      if (child === null || stdinEnded) return
      try {
        await sendCommand('abort', {}, abortTimeoutMs)
      } catch {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
    },

    heartbeat(at) { return touchActivity(at ?? now()) },

    // ── 合同面 3：状态视图（同步；异步状态来自缓存）──
    snapshot() {
      const cancelled = task.cancelled === true
      // 三态（合同 §一）：running / cancelling（意图已发、事实未落定）/ finished。
      const status = ended ? 'finished' : (cancelled ? 'cancelling' : 'running')
      let outcome = null
      if (ended) {
        if (typeof task.reconcileLost === 'string' && task.reconcileLost !== '') {
          outcome = { kind: 'lost', why: task.reconcileLost }
        } else if (cancelled || settled?.aborted === true || task.status === 'cancelled') {
          outcome = { kind: 'cancelled' }
        } else if (typeof task.error === 'string' && task.error !== '') {
          outcome = { kind: 'failed', error: task.error }
        } else if (Number.isInteger(task.exitCode) && task.exitCode !== 0) {
          outcome = { kind: 'failed', error: `pi rpc 退出码 ${task.exitCode}` }
        } else {
          outcome = { kind: 'succeeded' }
        }
      }
      const errMsg = typeof task.error === 'string' && task.error !== '' ? task.error
        : (typeof task.appError === 'string' && task.appError !== '' ? task.appError : undefined)
      return {
        status,
        outcome,
        // 2026-10-31（Pi 评审 + 实机证据）：补齐与 Codex `runtime.snapshot()` 同名的字段 ——
        // 缺了它们 `taskView()` 取不到，Pi 的终态响应既没有 exitCode、也没有 reconcileLost
        // （实机：卡住那单 `mode` 与 `exitCode` 都是 None）。
        exitCode: task.exitCode,
        mode: 'rpc',
        lastSignal: task.lastSignal,
        reconcileLost: task.reconcileLost,
        appError: typeof task.appError === 'string' && task.appError !== '' ? task.appError : undefined,
        activityAt: Number.isFinite(task.activityAt) ? task.activityAt : 0,
        stuckSuspect: task.stuckSuspect === true,
        // 封闭投影（同 progress 那一刀的规矩）：只发 {kind,text,at}；mapPiEvent 附带的
        // usage/aborted/willRetry 与 pi 原始 type 都不外发。
        progress: viewEvents.map((e) => ({ kind: e.kind, text: e.text, at: e.at })),
        // 不伪造 liveBytes：Pi 侧没有 .live 过程流，合同要求事件粒度与实际一致。
        error: errMsg,
        details: {
          pid: rt.pid(),
          lastSignal: task.lastSignal,
          forcedKill: task.forcedKill === true,
          state: stateCache,        // get_state 缓存（model / isStreaming / usage / promptDisposition）
          stats: statsCache,        // get_session_stats 缓存（tokens / cost / contextUsage）
          settled,                  // {aborted} ← json.md agent_settled
          agentEnd,                 // {willRetry} ← json.md agent_end
          pendingCommands: pending.size,
          stdinQueuedBytes: stdinQueueBytes,
          stderrTail: Buffer.concat(stderrTail).toString('utf8'),
        },
      }
    },

    /**
     * 增量事件（可选能力；游标 = 单调 seq，缓冲内可重放）。
     * 缓冲是环形 PROGRESS_LIMIT：**落后超过 20 条的条目取不回**（如实，不伪造历史）。
     */
    events(afterSeq = 0) {
      let cursor = Number.isFinite(afterSeq) ? afterSeq : 0
      let closed = false
      const wake = []
      const wakeAll = () => { while (wake.length > 0) wake.shift()() }
      const listener = () => wakeAll()
      const close = () => { if (!closed) { closed = true; listeners.delete(listener); pollers.delete(wakeAll); wakeAll() } }
      listeners.add(listener)
      pollers.add(wakeAll)
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              for (;;) {
                const fresh = viewEvents.filter((e) => e.seq > cursor)
                if (fresh.length > 0) {
                  cursor = fresh[0].seq
                  return { value: { kind: fresh[0].kind, text: fresh[0].text, at: fresh[0].at }, done: false }
                }
                if (closed || ended) { close(); return { value: undefined, done: true } }
                // 无新事件：等订阅唤醒；同时挂上兜底 tick，保证 ended / 缓冲推进都能被看见。
                ensurePollTimer()
                await new Promise((r) => { wake.push(r) })
              }
            },
            return() { close(); return { value: undefined, done: true } },
          }
        },
        close,
      }
    },

    // ── 合同面 4：产物（路径语义归 runtime；公共代码不得从文件名反解 id）──
    artifacts() {
      const out = []
      const p = rt.getOutPath()
      if (typeof p === 'string' && p !== '') out.push({ path: p, kind: 'output' })
      // get_state 的 sessionFile（rpc-commands.md「get_state」）：跑 --no-session 时通常缺省，
      // 有就带上 —— 那是引擎自己声明的产物路径，不是我猜出来的。
      if (typeof stateCache.sessionFile === 'string' && stateCache.sessionFile !== '') {
        out.push({ path: stateCache.sessionFile, kind: 'output' })
      }
      return out
    },

    /**
     * 唯一收尾入口（重复调用 no-op → false）。终局判定（实现要点 8）：
     *   · evidence.lost                            → 'lost'
     *   · agent_settled.aborted / cancel 意图      → 'cancelled'
     *   · evidence.error 或 非 0 退出码            → 'failed'
     *   · 其余                                      → 'succeeded'
     * 落定后的终止链是**兜底**：关 stdin（有序退出）→ SIGTERM → 宽限后 SIGKILL。
     */
    async finalize(evidence = {}) {
      if (ended) return false
      ended = true
      // 收尾即取消待执行的 settle drain —— 清理点唯一放在这里，别指望 stopWatchdog 顺带做。
      if (drainTimer !== null) { try { clearTimeout(drainTimer) } catch { /* noop */ } drainTimer = null }
      rt.stopWatchdog()
      // P4：收尾前尽力补一次正文（agent_settled 的异步抓取可能没赶上 exit），再落盘。
      if (runOutPath !== null && lastAssistantText === '' && child !== null && child.exitCode === null) {
        try { await captureAssistantText() } catch { /* 忽略 */ }
      }
      flushAssistantToOut()
      if (typeof evidence.lost === 'string' && evidence.lost !== '') rt.setReconcileLost(evidence.lost)
      if (typeof evidence.error === 'string' && evidence.error !== '') task.error = evidence.error
      if (evidence.signal) rt.setLastSignal(evidence.signal)
      const cancelled = evidence.cancelled === true || task.cancelled === true || settled?.aborted === true
      // 2026-10-31 修（Pi 评审指出）：原先是"显式 exitCode 优先"，于是 settle 分支若图省事传
      // `{ exitCode: 0 }`，**取消态也会被记成 0**（Codex 那边记 -1）。取消必须压倒一切。
      const finalCode = cancelled ? -1
        : (Number.isInteger(evidence.exitCode) ? evidence.exitCode
          : (typeof task.error === 'string' && task.error !== '' ? -1 : 0))
      rt.setExitCode(finalCode)
      // A 方案：**不写 status / endedAt**。写 endedAt 会让 finalizeJob 的幂等哨兵 return false，
      // 跳过「读 output / 删产物 / 发通知」。终态一律交给调用方（index.js）落定。
      closeStdin()
      if (child !== null) {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        const t = setTimeout(() => {
          try {
            if (child !== null && child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL')
              rt.setForcedKill()
            }
          } catch { /* 已退出 */ }
        }, killGraceMs)
        if (typeof t.unref === 'function') t.unref()
      }
      rejectAllPending('任务已收尾')
      if (doneResolve !== null) {
        const payload = { exitCode: finalCode, aborted: cancelled, error: typeof task.error === 'string' ? task.error : '' }
        const r = doneResolve
        doneResolve = null
        r(payload)
      }
      return true
    },

    // ── index.js 仍在调的句柄 / 字段访问器（与 runtime.js 逐个对齐）──
    setChild(c) { child = c ?? null },
    child() { return child },
    pid() { return child !== null && Number.isInteger(child.pid) ? child.pid : null },
    kill(signal) { try { if (child !== null) child.kill(signal) } catch { /* 进程可能刚好自己退出 */ } },
    setApp(a) { app = a ?? null },   // RPC 无独立连接句柄：槽位保留以兼容调用方（只存不读）
    /** 优雅中断 = `abort` 命令（不是信号）；失败吞掉，取消路径靠信号兜底。 */
    interrupt() {
      void sendCommand('abort', {}, abortTimeoutMs).catch(() => { /* 连接已断等 */ })
    },

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
    /** 环形 20 条进度的唯一写入口（上限与 index.js 的 PROGRESS_LIMIT 一致）。 */
    pushProgress(entry, limit = PROGRESS_LIMIT) {
      task.progress.push(entry)
      while (task.progress.length > limit) task.progress.shift()
    },

    // ── 看门狗：与 Codex 版同构，但活性源 = 显式心跳 ∨ 产物 mtime 兜底 ──
    startWatchdog() {
      if (timer !== null) return
      // 兜底：正常路径下 start() 已在 spawn 后固定过身份；这里只照顾「外部只给了
      // setChild、没走 start」的用法。只在首次记录，重复调用不覆盖。
      if ((task.childPid === undefined || task.childPid === null) && child !== null) {
        task.childPid = Number.isInteger(child.pid) ? child.pid : null
        task.childStart = typeof readProcStartTime === 'function' ? readProcStartTime(task.childPid) : null
      }
      task.activityAt = now()
      timer = setInterval(() => {
        try {
          if (task.endedAt !== null && task.endedAt !== undefined) { rt.stopWatchdog(); return }
          const beat = Number.isFinite(task.activityAt) ? task.activityAt : 0
          const mtime = outFileMtimeMs(rt.getOutPath())
          const active = Math.max(beat, mtime ?? 0)
          if (active > task.activityAt) { task.activityAt = active; task.stuckSuspect = false; return }
          if (task.stuckSuspect === true) return
          if (now() - task.activityAt >= stallMs) {
            task.stuckSuspect = true
            const label = task.kind === 'review' ? '复核' : '工单'
            if (typeof notify === 'function') {
              notify(`${label} ${String(task.id ?? '').slice(-6)} 疑似停滞（>${Math.round(stallMs / 1000)}s 无输出更新）`)
            }
          }
        } catch { /* best effort：看门狗自身绝不抛错 */ }
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      // 注意：**不在 tick 里发 get_state**。30s 一次的 RPC 命令会挤占对端命令队列，
      // 而活性判据完全不需要它。缓存刷新点只有三处：start / agent_settled / 显式 refreshState()。
    },
    stopWatchdog() {
      if (timer === null) return
      try { clearInterval(timer) } catch { /* best effort */ }
      timer = null
    },

    // ── 可选扩展 ──
    /** capabilities.usage=true 时「跨会话总量」的唯一可靠口径（get_session_stats）。 */
    async fetchStats() {
      try { statsCache = await sendCommand('get_session_stats', {}, commandTimeoutMs) } catch { /* 保留旧缓存 */ }
      return statsCache
    },
    /** 排障用（**不对外返回**）：原始事件 / 异常回执的环形留痕，对齐 task.engineEvents 定位。 */
    debugEvents() { return rawEvents.slice() },
    /** 通用命令出口（白名单校验 + id 关联 + 超时都在 sendCommand 里）。
     *  给上层用那些本 runtime 没包成方法的命令：get_messages / get_tree / export_html …
     *  注意：`prompt` 的完成仍只看事件流，别把这里的 resolve 当「跑完了」
     *  （rpc.md「Run lifecycle」）。 */
    sendCommand,
    /** 直接问一次状态并返回（不等缓存）；要不要 await 由调用方决定。 */
    refreshState,
  }

  return rt
}

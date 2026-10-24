/**
 * app-server 客户端（stdio JSON-RPC，零依赖）—— second-engine 的 app-server 执行模式。
 *
 * 协议事实来源：/root/proj/appserver-spike/FINDINGS.md + run1.log（Codex T4 实测，2026-09-27）
 *   initialize → initialized → thread/start → turn/start → 事件流 → turn/completed
 *   interrupt: turn/interrupt {threadId, turnId}
 *
 * 设计要点（对齐 T5 规格）：
 *   · agentMessage 增量【直接 append 到 -o 输出文件】—— 让既有的 output 读取与
 *     看门狗 mtime 判据原样可用，不必改 finalizeTask / startWatchdog。
 *   · 事件归一化为 {kind, text|itemType|usage|status}，供上层投影成进度。
 *   · 失败/退出都会 resolve/reject 一次（settled 幂等），绝不让子进程悬空。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const REQUEST_TIMEOUT_MS = 60_000
// 首 token 看门狗：turn/start 已应答但 app-server 长时间无任何通知（典型 401/403/额度耗尽）
const FIRST_EVENT_TIMEOUT_MS = 180_000
const TERMINAL_METHODS = new Set([
  'turn/completed', 'turn/failed', 'turn/error', 'turn/interrupted', 'turn/cancelled', 'turn/aborted',
])

// 多版本字段兜底（A: codex-driver.ts readScopedId / readTurnId / readRequestId / firstNonEmptyString）
const readId2 = (o, keys, nestedKey) => {
  if (!o || typeof o !== 'object') return null
  for (const k of keys) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim()
  const n = nestedKey ? o[nestedKey] : undefined
  return n && typeof n === 'object' && typeof n.id === 'string' && n.id.trim() ? n.id.trim() : null
}
const readTurnId = (msg) => {
  if (!msg || typeof msg !== 'object') return null
  const p = msg.params && typeof msg.params === 'object' ? msg.params : msg
  for (const k of ['turnId', 'turn_id']) if (typeof p[k] === 'string' && p[k]) return p[k]
  if (p.turn && typeof p.turn === 'object' && typeof p.turn.id === 'string' && p.turn.id) return p.turn.id
  return null
}
const firstStr = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
// A: codexUsageChunk —— tokenUsage / usage 两种形状 + camel|snake 全量兜底
const usageChunk = (p) => {
  const tu = p.tokenUsage && typeof p.tokenUsage === 'object' ? p.tokenUsage
    : p.token_usage && typeof p.token_usage === 'object' ? p.token_usage : null
  const ru = p.usage && typeof p.usage === 'object' ? p.usage : null
  if (tu === null && ru === null) return null
  const src = tu ?? ru
  const last = ['last', 'lastUsage', 'last_token_usage'].map((k) => src[k])
    .find((v) => v && typeof v === 'object')
    ?? (typeof src.total === 'object' ? src.total : undefined)
  const lastUsage = last ?? src
  const ctxWin = num(src.contextWindow ?? src.context_window ?? src.modelContextWindow ?? src.model_context_window
    ?? lastUsage.contextWindow ?? lastUsage.context_window
    ?? lastUsage.modelContextWindow ?? lastUsage.model_context_window
    ?? p.contextWindow ?? p.context_window)
  const total = typeof src.total === 'object' && src.total !== null ? src.total : undefined
  const pick = (o, camel, snake) => (o ? o[camel] ?? o[snake] : undefined)
  const inputTokens = num(pick(lastUsage, 'inputTokens', 'input_tokens')) ?? 0
  const cacheReadTokens = num(pick(lastUsage, 'cachedInputTokens', 'cached_input_tokens'))
  const outputTokens = num(pick(lastUsage, 'outputTokens', 'output_tokens'))
  const totalTokens = num(pick(lastUsage, 'totalTokens', 'total_tokens'))
  return {
    inputTokens,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(ctxWin === undefined ? {} : { contextWindow: ctxWin, contextTokens: inputTokens,
      contextUsageRatio: Number(Math.min(1, inputTokens / ctxWin).toFixed(6)) }),
    // 累计值单独透传：total 与 last 不得相加（我方 MAPPING §1 规则）
    ...(total === undefined ? {} : { total: {
      inputTokens: num(total.inputTokens ?? total.input_tokens) ?? 0,
      ...(num(total.outputTokens ?? total.output_tokens) === undefined ? {}
        : { outputTokens: num(total.outputTokens ?? total.output_tokens) }),
    } }),
  }
}
// A: isMethodNotFound —— 只有「服务端不认识这个方法」才永久关闭某个能力，瞬时失败保留重试
const isMethodNotFound = (err) => {
  const code = err && typeof err === 'object' ? err.code : undefined
  if (code === -32601) return true
  const d = err && typeof err === 'object' && err.data && typeof err.data === 'object' ? err.data : null
  if (d && d.code === -32601) return true
  const m = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /method\s*not\s*found|unknown method/i.test(m) || /method\s*not\s*found/i.test((d && d.message) || '')
}
// A: isContextWindowError / hasContextWindowError
const hasCtxWinErr = (v) => {
  if (typeof v === 'string') return /context[_-]?window[_-]?exceeded|context window exceeded/i.test(v)
  if (!v || typeof v !== 'object') return false
  return Object.entries(v).some(([k, c]) => /context.?window.?exceeded/i.test(k) || hasCtxWinErr(c))
}
// A: buildCodexCompletionNotification —— 终态直接放在 turn/start 响应里时合成终态通知
const terminalFromResponse = (value, tid) => {
  if (!value || typeof value !== 'object' || !value.turn || typeof value.turn !== 'object') return null
  const st = value.turn.status
  if (st !== 'completed' && st !== 'failed' && st !== 'interrupted' && st !== 'cancelled') return null
  return { method: 'turn/completed', params: { threadId: tid, turn: value.turn } }
}

// A: isProviderDefaultModel —— 这些取值表示「沿用 codex 配置里的模型」，不得下发
const PROVIDER_DEFAULT_MODELS = new Set(['', 'default', 'auto', 'codex-default', 'provider-default'])
const isProviderDefaultModel = (m) => m === undefined || m === null || PROVIDER_DEFAULT_MODELS.has(String(m).trim().toLowerCase())

export function startAppServerTurn({ cwd, env, prompt, outPath, onEvent, codexArgs = [], model }) {
  const desiredModel = typeof model === 'string' ? model.trim() : ''
  // codexArgs：可选的 codex 全局参数（如 -c model_provider=... ），便于离线/多 provider 测试；
  // 生产路径留空，走 ~/.codex/config.toml 的 active provider。
  const child = spawn('codex', [...codexArgs, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  // stdin EPIPE 兜底：app-server 早退后 write() 触发的 error 是异步事件，try/catch
  // 接不住；不挂监听器就是 uncaughtException（write() 外层的 try/catch 防不了这个）。
  child.stdin.on('error', () => { /* 已退出：exit/error 回调负责收尾 */ })
  let buffer = ''
  let nextId = 1
  let threadId = null
  let turnId = null
  let settled = false
  const pending = new Map()

  let doneResolve
  let doneReject
  const done = new Promise((res, rej) => { doneResolve = res; doneReject = rej })

  const emit = (evt) => { try { onEvent?.(evt) } catch { /* 进度回调绝不打断执行 */ } }
  let sawEvent = false
  let firstEventTimer = null
  // A: thread/settings/update 能力开关（codex-driver.ts:643-700）
  let settingsUpdateUnsupported = false
  let threadModel = null
  let contextTokens = null
  let contextWindow = null
  const serverRequestHandlers = []
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result })
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })
  // item 级文本状态（MAPPING §1 规则 4）：delta 是 append-only 预览，
  // 对应 item/completed 到达时用**权威最终 item**替换累积缓冲。
  const itemText = new Map()
  const flushOut = () => {
    const parts = []
    for (const it of itemText.values()) parts.push(it.text)
    try { writeFileSync(outPath, parts.join('')) } catch { /* best effort */ }
  }
  // delta 高频到达（逐 token）：每次全量重写 outPath 是 O(n²) 同步 IO，按 200ms
  // 节流合并；权威替换（item/completed、终态、finish）仍即时落盘。
  let flushScheduled = false
  const flushOutSoon = () => {
    if (flushScheduled) return
    flushScheduled = true
    const timer = setTimeout(() => { flushScheduled = false; flushOut() }, 200)
    timer.unref?.()
  }
  const write = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch { /* 已退出 */ } }

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时（${REQUEST_TIMEOUT_MS}ms）`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer, method })
    write({ jsonrpc: '2.0', id, method, params })
  })

  function finish(err, status) {
    if (settled) return
    settled = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('turn 已结束'))
    }
    pending.clear()
    flushOut()
    try { child.kill('SIGTERM') } catch { /* 可能已退出 */ }
    // SIGTERM 兜底：app-server 偶有不理 TERM 的挂死，3s 后强杀，防子进程残留。
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 3000)
    killTimer.unref?.()
    if (err) doneReject(err)
    else doneResolve({ threadId, turnId, status })
  }

  const baseFor = (msg, p) => ({
    threadId: p.threadId ?? threadId,
    turnId: p.turnId ?? turnId,
    eventType: msg.method,
    raw: p,
  })
  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let msg
    try { msg = JSON.parse(text) } catch { return }
    // 服务端发起的 JSON-RPC 请求（权限审批 / request_user_input / 动态工具）：带 method 又带 id。
    // 不能让它落到 pending 分支，否则 provider 永久等待，turn 挂到超时（A: json-rpc-process.ts:243-258）
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
      let handled = false
      for (const h of serverRequestHandlers) { try { if (h(msg, (r) => respond(msg.id, r)) === true) handled = true } catch { /* 单个处理器异常不杀读取循环 */ } }
      if (handled) return
      const rid = msg.id
      const method = String(msg.method)
      const marker = `${method} ${params.item && params.item.type ? params.item.type : ''}`.toLowerCase()
      if (/(tool[/_-]?call|dynamictool)/.test(marker)) {
        // 我方不执行反向动态工具：必须显式回绝，不能挂起（A: codex-driver.ts:998-1005）
        respond(rid, { success: false, contentItems: [{ type: 'inputText', text: 'second-engine 不支持由 codex 反向调用动态工具' }] })
      } else {
        // 未识别的服务端请求：先投影给上层，同时立即回 error，避免 provider 侧无限等待
        emit({ kind: 'status', text: `未支持的 provider 请求：${method}`.slice(0, 200), done: false, meta: baseFor(msg, params) })
        respondError(rid, -32601, 'unsupported in second-engine')
      }
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${p.method} 失败：${JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    if (!msg.method) return
    const p = msg.params || {}
    // turn 归属过滤（A: isCodexNotificationForTurn, codex-driver.ts:1681-1700）：
    // 只接收当前 thread/turn 的终态，避免 thread/resume 迟到的旧 turn/completed 提前结束本轮。
    if (TERMINAL_METHODS.has(msg.method)) {
      const ntId = readId2(p, ['threadId', 'thread_id'], 'thread')
      const nTurnId = readTurnId(msg)
      if (ntId !== null && threadId !== null && ntId !== threadId) return
      if (turnId === null && nTurnId !== null) return
      if (nTurnId !== null && turnId !== null && nTurnId !== turnId) return
    }
    sawEvent = true
    if (firstEventTimer) { clearTimeout(firstEventTimer); firstEventTimer = null }
    // 归一化 envelope 按 T6 的 appserver-spike/MAPPING.md：{kind,text,tool,usage,done,meta}
    const base = {
      threadId: p.threadId ?? threadId,
      turnId: p.turnId ?? turnId,
      eventType: msg.method,
      // T7 复核：MAPPING envelope 还要求这三个可缺省字段
      ...(p.contentIndex !== undefined ? { contentIndex: p.contentIndex } : {}),
      ...(p.summaryIndex !== undefined ? { summaryIndex: p.summaryIndex } : {}),
      ...(p.willRetry !== undefined ? { willRetry: p.willRetry } : {}),
      raw: p,
    }
    switch (msg.method) {
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string') {
          const key = p.itemId ?? 'stream'
          const cur = itemText.get(key) ?? { text: '', done: false }
          cur.text += p.delta
          itemText.set(key, cur)
          flushOutSoon()   // 实时预览（节流）
          emit({ kind: 'text', text: p.delta, done: false, meta: { ...base, itemId: p.itemId } })
        }
        break
      case 'item/reasoning/summaryTextDelta':
        emit({ kind: 'reasoning', text: p.delta ?? '', done: false,
          meta: { ...base, itemId: p.itemId, summaryIndex: p.summaryIndex } })
        break
      case 'item/reasoning/summaryPartAdded':
        emit({ kind: 'reasoning', text: '', done: false,
          meta: { ...base, itemId: p.itemId, summaryIndex: p.summaryIndex } })
        break
      case 'item/commandExecution/outputDelta':
        // 命令输出预览：只进进度投影，不进 -o 正文文件
        emit({ kind: 'tool', tool: { type: 'commandExecution', itemId: p.itemId,
          aggregatedOutput: p.delta ?? '' }, done: false,
          meta: { ...base, itemId: p.itemId } })
        break
      case 'item/reasoning/textDelta':
        emit({ kind: 'reasoning', text: p.delta ?? '', done: false,
          meta: { ...base, itemId: p.itemId, contentIndex: p.contentIndex } })
        break
      case 'item/started':
      case 'item/completed': {
        // A: isCodexCompactionItemType —— 自动压缩以 contextCompaction item 出现时投影成进度，
        // 否则压缩期间（可达数分钟）上层看到零输出。
        const item = p.item ?? {}
        if (String(item.type ?? '').replace(/[_-]/g, '').toLowerCase() === 'contextcompaction') {
          emit({ kind: 'status', text: `compaction ${msg.method === 'item/started' ? 'start' : 'summary'}`,
            done: false, meta: { ...base, itemId: item.id ?? p.itemId, status: item.type } })
          break
        }
        const type = String(item.type ?? p.itemType ?? '')
        const isTool = /commandExecution|fileChange|mcpToolCall|dynamicToolCall|Tool/.test(type)
        const kind = isTool ? 'tool' : (type === 'reasoning' ? 'reasoning' : (type === 'agentMessage' ? 'text' : 'status'))
        if (msg.method === 'item/completed' && type === 'agentMessage' && typeof item.text === 'string') {
          // 权威替换：以最终 item 文本为准，丢弃该 item 的流式累积（MAPPING §1 规则 4）
          itemText.set(item.id ?? p.itemId ?? 'item', { text: item.text, done: true })
          flushOut()
        }
        emit({
          kind,
          ...(typeof item.text === 'string' ? { text: item.text } : {}),
          ...(isTool ? { tool: {
            type,
            itemId: item.id ?? p.itemId,
            status: item.status,
            command: item.command,
            exitCode: item.exitCode ?? null,
            aggregatedOutput: item.aggregatedOutput ?? null,
            // T7 复核：MAPPING §1 的 tool 字段全量对齐
            changes: item.changes,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            progress: item.progress ?? null,
            diff: item.diff ?? null,
          } } : {}),
          done: false,
          meta: { ...base, itemId: item.id ?? p.itemId, status: item.status ?? type },
        })
        break
      }
      case 'thread/tokenUsage/updated': {
        // total 累计 / last 增量：分开承载，不做相加（MAPPING §1 规则）
        const u = usageChunk(p)
        let un = u
        if (u && u.contextWindow !== undefined) {
          if (contextWindow === null) contextWindow = u.contextWindow
          else if (contextWindow !== u.contextWindow) {
            // 首个已确认窗口优先（A: stabilizeCodexUsage, codex-driver.ts:1024-1043）
            un = { ...u, contextWindow,
              contextUsageRatio: Number(Math.min(1, (u.contextTokens ?? 0) / contextWindow).toFixed(6)) }
          }
        }
        if (un && typeof un.contextTokens === 'number') contextTokens = un.contextTokens
        emit({ kind: 'usage', usage: { tokens: p.tokenUsage, ...(un ? { normalized: un } : {}) },
          done: false, meta: base })
        break
      }
      case 'thread/compacted':
        // A: 压缩完成信号（codex 0.158 起 thread/compacted 已废弃，只可能来自旧版运行时）：
        // 我方一个 turn 一个线程，不需要 compaction 事务闭环，只需投影 + 清零用量记账。
        contextTokens = 0
        emit({ kind: 'status', text: 'context compacted', done: false, meta: base })
        break
      case 'thread/status/changed':
        emit({ kind: 'status', text: String(p.status?.type ?? p.status ?? ''), done: false,
          meta: { ...base, status: p.status?.type } })
        break
      case 'turn/started':
        turnId = p.turnId ?? p.turn?.id ?? turnId
        emit({ kind: 'status', text: 'turn started', done: false, meta: { ...base, status: p.status } })
        break
      case 'turn/completed':
      case 'turn/failed':
      case 'turn/error':
      case 'turn/interrupted':
      case 'turn/cancelled':
      case 'turn/aborted': {
        const turn = p.turn ?? {}
        const status = turn.status ?? p.status ?? (msg.method === 'turn/completed' ? null : 'failed')
        // 权威终态内容：流式 delta 可能全缺，用 turn.items 里的 agentMessage 覆盖落盘（MAPPING §1 规则 4）
        const items = Array.isArray(turn.items) ? turn.items : []
        const finalText = items.filter((i) => i?.type === 'agentMessage' && typeof i.text === 'string')
          .map((i) => i.text).join('')
        if (finalText !== '') {
          itemText.clear()
          itemText.set('final', { text: finalText, done: true })
          flushOut()
        }
        emit({ kind: 'done', ...(finalText !== '' ? { text: finalText } : {}), done: true,
          meta: { ...base, status, raw: p } })
        // T7 复核：status=failed 属失败终态，必须让上层拿到 reject（而不是 resolve 后靠状态字符串判断）
        // A: readCodexTerminalReason —— interrupted/cancelled 与 failed 分开记账
        const failed = status === 'failed' || msg.method === 'turn/failed' || msg.method === 'turn/error'
          || (turn.error !== undefined && turn.error !== null && status === null)
        const cancelled = status === 'interrupted' || status === 'cancelled'
          || msg.method === 'turn/interrupted' || msg.method === 'turn/cancelled' || msg.method === 'turn/aborted'
        const err = turn.error ?? p.error ?? null
        const errMsg = (err && typeof err === 'object')
          ? firstStr(err.message, err.detail, err.description, err.type) ?? JSON.stringify(err) : String(err ?? '')
        if (failed) {
          finish(new Error(`turn 失败：${(errMsg || msg.method).slice(0, 2000)}` +
            (hasCtxWinErr(err) ? ' [contextWindowExceeded]' : '')), 'failed')
        } else finish(null, cancelled ? 'cancelled' : status)
        break
      }
      case 'error': {
        // willRetry=true 是可重试告警：保持 turn 活动，只投影（A: readCodexTerminalReason）
        const willRetry = p.willRetry === true || p.will_retry === true
        emit({ kind: 'status', text: JSON.stringify(p).slice(0, 200), done: false,
          meta: { ...base, willRetry } })
        if (!willRetry) {
          const errMsg = firstStr(p.error?.message, p.message, p.error) ?? 'provider error'
          finish(new Error(`provider 不可重试错误：${String(errMsg).slice(0, 2000)}`), 'error')
        }
        break
      }
      default:
        emit({ kind: 'status', done: false, meta: base })
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      handleLine(line)
    }
  })
  child.stderr.on('data', () => { /* 排空，防管道写满阻塞 */ })
  child.on('exit', (code) => { if (!settled) finish(new Error(`app-server 退出 code=${code}`), 'error') })
  child.on('error', (e) => finish(e, 'error'))

  const run = (async () => {
    await request('initialize', {
      clientInfo: { name: 'second-engine', title: 'second-engine app-server mode', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    write({ jsonrpc: '2.0', method: 'initialized' })
    // A: codexThreadParams(codex-driver.ts:1815-1838) 的最小安全子集 —— 只带 cwd，
    // 不带 sandbox / approvalPolicy / developerInstructions，保持与现网 exec 路径同权限语义。
    const t = await request('thread/start', { cwd, ...(!isProviderDefaultModel(desiredModel) ? { model: desiredModel } : {}) })
    // 实测（2026-09-27）：真实响应是 result.thread.id；FINDINGS 里写的 result.threadId
    // 是 spike 自己的摘要格式，不是原文——两种都兼容，避免再被二手总结误导。
    threadId = t?.thread?.id ?? t?.threadId ?? null
    threadModel = (t && t.thread && typeof t.thread.model === 'string') ? t.thread.model : null
    // A: alignThreadModel —— 调用方显式指定模型且与线程回显不一致时纠正一次（best effort）
    if (desiredModel && threadModel !== null && threadModel !== desiredModel && !settingsUpdateUnsupported) {
      try { await request('thread/settings/update', { threadId, model: desiredModel })
      } catch (e) { if (isMethodNotFound(e)) settingsUpdateUnsupported = true /* 其他失败不阻断本轮 */ }
    }
    const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
    turnId = turn?.turn?.id ?? turn?.turnId ?? turnId
    // A: buildCodexCompletionNotification —— 有的 app-server 直接在响应里给终态
    const terminal = terminalFromResponse(turn, threadId)
    if (terminal) { handleLine(JSON.stringify(terminal)); return { threadId, turnId, terminalInResponse: true } }
    // A: 终态兜底 —— turn/start 已应答却长时间零通知（401/403/额度）时明确失败
    firstEventTimer = setTimeout(() => {
      if (settled || sawEvent) return
      finish(new Error(`turn 已开始但 ${FIRST_EVENT_TIMEOUT_MS}ms 内无任何事件（疑似鉴权/额度失败）`), 'error')
    }, FIRST_EVENT_TIMEOUT_MS)
    firstEventTimer.unref?.()
    return { threadId, turnId }
  })()
  // initialize / thread/start / turn/start 失败或超时时 run 拒绝 —— 原来 child 不会
  // 被杀（firstEventTimer 只在 turn/start 之后才装），codex app-server 进程就此泄漏。
  // 这里接住并走 finish（SIGTERM + SIGKILL 兜底 + done reject）。
  void run.catch((e) => { if (!settled) finish(e, 'error') })

  return {
    child,
    run,
    done,
    ids: () => ({ threadId, turnId }),
    // 供 index.js（未来）注册交互应答；本次补丁内默认无人注册 → 走上面的显式回绝/立即 error
    addServerRequestHandler: (fn) => { serverRequestHandlers.push(fn); return () => {
      const i = serverRequestHandlers.indexOf(fn); if (i >= 0) serverRequestHandlers.splice(i, 1) } },
    interrupt: async () => {
      const ids = { threadId, turnId }
      if (!ids.threadId || !ids.turnId) return false
      try { await request('turn/interrupt', ids); return true } catch { return false }
    },
    kill: () => { try { child.kill('SIGTERM') } catch { /* noop */ } },
  }
}

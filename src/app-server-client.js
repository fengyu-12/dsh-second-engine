/**
 * app-server 客户端（stdio JSON-RPC，零依赖）—— second-engine 的 app-server 执行模式。
 *
 * 协议事实来源：~/proj/appserver-spike/FINDINGS.md + run1.log（Codex T4 实测，2026-09-27）
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

export function startAppServerTurn({ cwd, env, prompt, outPath, onEvent, codexArgs = [] }) {
  // codexArgs：可选的 codex 全局参数（如 -c model_provider=... ），便于离线/多 provider 测试；
  // 生产路径留空，走 ~/.codex/config.toml 的 active provider。
  const child = spawn('codex', [...codexArgs, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  // item 级文本状态（MAPPING §1 规则 4）：delta 是 append-only 预览，
  // 对应 item/completed 到达时用**权威最终 item**替换累积缓冲。
  const itemText = new Map()
  const flushOut = () => {
    const parts = []
    for (const it of itemText.values()) parts.push(it.text)
    try { writeFileSync(outPath, parts.join('')) } catch { /* best effort */ }
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
    try { child.kill('SIGTERM') } catch { /* 可能已退出 */ }
    if (err) doneReject(err)
    else doneResolve({ threadId, turnId, status })
  }

  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let msg
    try { msg = JSON.parse(text) } catch { return }
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
          flushOut()   // 实时预览
          emit({ kind: 'text', text: p.delta, done: false, meta: { ...base, itemId: p.itemId } })
        }
        break
      case 'item/reasoning/textDelta':
        emit({ kind: 'reasoning', text: p.delta ?? '', done: false,
          meta: { ...base, itemId: p.itemId, contentIndex: p.contentIndex } })
        break
      case 'item/started':
      case 'item/completed': {
        const item = p.item ?? {}
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
      case 'thread/tokenUsage/updated':
        // total 累计 / last 增量：分开承载，不做相加（MAPPING §1 规则）
        emit({ kind: 'usage', usage: { tokens: p.tokenUsage }, done: false, meta: base })
        break
      case 'thread/status/changed':
        emit({ kind: 'status', text: String(p.status?.type ?? p.status ?? ''), done: false,
          meta: { ...base, status: p.status?.type } })
        break
      case 'turn/started':
        turnId = p.turnId ?? p.turn?.id ?? turnId
        emit({ kind: 'status', text: 'turn started', done: false, meta: { ...base, status: p.status } })
        break
      case 'turn/completed': {
        const turn = p.turn ?? {}
        const status = turn.status ?? p.status ?? null
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
        if (status === 'failed') finish(new Error(`turn 失败：${JSON.stringify(turn.error ?? {})}`), 'failed')
        else finish(null, status)
        break
      }
      case 'turn/failed':
        // MAPPING §6：v2 schema 通知集里没有 turn/failed（FINDINGS 的说法不成立）；按 legacy 兼容处理
        emit({ kind: 'done', done: true, meta: { ...base, status: 'failed' } })
        finish(new Error('turn failed'), 'failed')
        break
      case 'error':
        emit({ kind: 'status', text: JSON.stringify(p).slice(0, 200), done: false, meta: base })
        break
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
    const t = await request('thread/start', {})
    // 实测（2026-09-27）：真实响应是 result.thread.id；FINDINGS 里写的 result.threadId
    // 是 spike 自己的摘要格式，不是原文——两种都兼容，避免再被二手总结误导。
    threadId = t?.thread?.id ?? t?.threadId ?? null
    const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
    turnId = turn?.turn?.id ?? turn?.turnId ?? turnId
    return { threadId, turnId }
  })()

  return {
    child,
    run,
    done,
    ids: () => ({ threadId, turnId }),
    interrupt: async () => {
      const ids = { threadId, turnId }
      if (!ids.threadId || !ids.turnId) return false
      try { await request('turn/interrupt', ids); return true } catch { return false }
    },
    kill: () => { try { child.kill('SIGTERM') } catch { /* noop */ } },
  }
}

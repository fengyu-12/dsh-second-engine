// Pi 引擎适配（P4 第一个真实第二引擎，2026-10-28）
//
// 形态：`pi --print --mode json` 子进程，stdout 是 **JSONL 事件流**（一行一个事件）。
// 与 Codex 的差别：
//   · exec    —— 无事件，只有结束时 `-o` 文件
//   · appsvr  —— JSON-RPC 通知
//   · **Pi**  —— 15 种 JSONL 事件，含 turn/message 边界、usage 增量、aborted
// 本文件只做一件事：把 Pi 的事件收敛成 TaskRuntime 期望的 ViewEvent（{kind,text,at}）。
// 不含状态机 —— 状态归属仍由 index.js 的 runtime + finalizeJob 负责。
import { spawn } from 'node:child_process'

/** Pi 事件类型 → 我们的封闭 kind（6 个）。未列出的降级为 status，绝不透传。 */
const KIND_BY_TYPE = {
  session: 'status',
  agent_start: 'status',
  turn_start: 'status',
  message_start: 'status',
  message_end: 'status',
  message_update: 'text',
  turn_end: 'tool',
  agent_end: 'done',
  agent_settled: 'done',
}

const TEXT_LIMIT = 2000

function pickText(evt) {
  // message_update：正文在 assistantMessageEvent 里（delta 是增量）
  if (evt.type === 'message_update') {
    const a = evt.assistantMessageEvent || {}
    const t = a.delta ?? a.text ?? a.content
    if (typeof t === 'string') return t
  }
  // turn_end：工具结果
  if (evt.type === 'turn_end' && Array.isArray(evt.toolResults)) {
    return evt.toolResults.map((r) => r?.output ?? r?.content ?? '').join('\n')
  }
  // 其余：message.content（可能是字符串或数组）
  const c = evt.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  return ''
}

/**
 * 单条 Pi 事件 → 我们的 ViewEvent。
 * 关键：**kind 走白名单**，未知类型降 'status'；不把 pi 的原始 type 外发。
 */
export function mapPiEvent(evt, at = Date.now()) {
  const kind = KIND_BY_TYPE[evt?.type] ?? 'status'
  const text = String(pickText(evt) ?? '').slice(0, TEXT_LIMIT)
  const out = { kind, text, at }
  if (evt?.type === 'message_update' && evt.usage) out.usage = evt.usage
  if (evt?.type === 'agent_settled') out.aborted = evt.aborted === true
  if (evt?.type === 'agent_end') out.willRetry = evt.willRetry === true
  return out
}

/**
 * 起一次 Pi 运行。
 * @returns {{ child, done: Promise<{code:number, aborted:boolean, events:string[]}>, cancel():void }}
 */
export function runPi({ prompt, workdir, env = {}, provider, model, extraArgs = [], onEvent }) {
  const args = ['--print', '--mode', 'json', '--no-session']
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  args.push(...extraArgs, prompt)

  const child = spawn('pi', args, { cwd: workdir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  let aborted = false

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line === '') continue
      let evt
      try { evt = JSON.parse(line) } catch { continue }
      events.push(evt.type)
      if (evt.type === 'agent_settled' && evt.aborted === true) aborted = true
      if (typeof onEvent === 'function') { try { onEvent(mapPiEvent(evt)) } catch { /* 消费方异常不影响引擎 */ } }
    }
  })
  child.stderr.on('data', () => { /* 由调用方通过 exit code 判失败 */ })

  const done = new Promise((resolve) => {
    child.on('exit', (code) => {
      // 尾行可能没换行
      const tail = buf.trim()
      if (tail !== '') {
        try { const evt = JSON.parse(tail); events.push(evt.type); if (typeof onEvent === 'function') onEvent(mapPiEvent(evt)) } catch { /* 忽略残行 */ }
      }
      resolve({ code: Number.isInteger(code) ? code : -1, aborted, events })
    })
    child.on('error', () => resolve({ code: -1, aborted, events }))
  })

  return {
    child,
    done,
    cancel() { try { child.kill('SIGTERM') } catch { /* 已退出 */ } },
  }
}

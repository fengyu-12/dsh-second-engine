// src/engine/claude-protocol.js —— Claude Code 的 stream-json 协议层（2026-11-05 新增）
//
// 只做三件事：分帧、解析、归一化。**不持有状态、不碰 task、不 spawn**。
// 拆出来是为了让 claude-runtime.js 保持小（Pi 那份 889 行就是因为协议与生命周期混在一起）。
//
// 协议事实来源（实测 + 第三方逆向文档，无官方文档）：
//   · 传输是 NDJSON：一行一个完整 JSON 对象，\n 分隔
//   · `--output-format stream-json` **必须配 `--verbose`**，否则 CLI 直接报错退出
//   · 事件类型：system(subtype=init) / assistant / result；assistant 内嵌 tool_use
//   · result 里带 is_error / total_cost_usd / usage / session_id

import { Buffer } from 'node:buffer'

/**
 * 按换行切帧（与 pi-rpc-runtime 的实现同源）。
 * 不用 readline：它把 \u2028/\u2029 也当行界，而 JSON 字符串里可以合法出现这两个字符。
 */
export function makeFrameSplitter(onLine) {
  /** @type {Buffer} */
  let buf = Buffer.alloc(0)
  return {
    feed(chunk) {
      /** @type {Buffer} */
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      buf = buf.length === 0 ? part : Buffer.concat([buf, part])
      let idx = buf.indexOf(0x0a)
      while (idx >= 0) {
        let rec = buf.subarray(0, idx)
        buf = buf.subarray(idx + 1)
        // 剥掉可选前置 CR（Windows 行尾）
        if (rec.length > 0 && rec[rec.length - 1] === 0x0d) rec = rec.subarray(0, rec.length - 1)
        if (rec.length > 0) onLine(rec.toString('utf8'))
        idx = buf.indexOf(0x0a)
      }
    },
    /** stdout 结束时取走没有换行的尾记录。 */
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
 * 把一行 JSON 归一化成事件。解析失败返回 null —— 调用方只攒尾巴排障，不中断流。
 *
 * 返回形状：
 *   { kind: 'init',        sessionId, model, cwd, tools[] }
 *   { kind: 'assistant',   text, toolUses[] }     // 可能有 thinking 块
 *   { kind: 'tool_result', ok, raw }
 *   { kind: 'result',      isError, costUsd, usage, resultText }
 *   { kind: 'system',      raw }                  // 其它 system 子类型（thinking_tokens 等）
 *   { kind: 'unknown',     raw }
 */
export function parseEvent(line) {
  let d
  try { d = JSON.parse(line) } catch { return null }
  if (d === null || typeof d !== 'object') return null
  const type = d.type

  if (type === 'system') {
    if (d.subtype === 'init') {
      return {
        kind: 'init',
        sessionId: str(d.session_id),
        model: str(d.model),
        cwd: str(d.cwd),
        tools: Array.isArray(d.tools) ? d.tools : [],
        permissionMode: str(d.permissionMode),
      }
    }
    return { kind: 'system', raw: d }
  }

  if (type === 'assistant') {
    const content = (d.message && Array.isArray(d.message.content)) ? d.message.content : []
    const texts = []
    const toolUses = []
    for (const c of content) {
      if (c === null || typeof c !== 'object') continue
      if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text)
      else if (c.type === 'tool_use') toolUses.push({ name: str(c.name), id: str(c.id), input: c.input })
    }
    return { kind: 'assistant', text: texts.join(''), toolUses, raw: d }
  }

  if (type === 'result') {
    const u = (d.usage && typeof d.usage === 'object') ? d.usage : {}
    return {
      kind: 'result',
      isError: d.is_error === true,
      costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
      usage: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheCreation: num(u.cache_creation_input_tokens),
      },
      resultText: typeof d.result === 'string' ? d.result : '',
      sessionId: str(d.session_id),
      raw: d,
    }
  }

  if (type === 'user') return { kind: 'tool_result', raw: d }

  return { kind: 'unknown', raw: d }
}

/** 从 result.resultText 里抽正文；空则回退到最后一个 assistant 文本。 */
export function pickFinalText(resultEvt, assistantText) {
  const r = resultEvt !== null && resultEvt !== undefined ? str(resultEvt.resultText) : ''
  return r !== '' ? r : assistantText
}

function str(v) { return typeof v === 'string' ? v : '' }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }

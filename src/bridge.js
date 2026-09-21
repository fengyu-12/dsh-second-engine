// dsha-second-engine —— Responses → Chat 翻译桥核心模块。
//
// 背景：Codex 0.155.1 只会说 Responses 协议（POST /responses，SSE 回放），
// 而上游（云知声 maas-api.unisound.com/v1 等）只说 Chat Completions。
// 本模块提供两块可单测的能力：
//   1. 纯函数转换器：responsesToChat / chatToResponses（无 IO，无副作用）
//   2. createBridgeServer：本地 node:http 桥，收 Responses 请求 → 转 Chat →
//      请求上游（非流式）→ 转回 Responses → 用 Responses 事件流回放给 Codex。
import http from 'node:http'

// ── Responses 请求 → Chat Completions 请求（纯函数）──
// 映射要点：
//   instructions        → 首条 system message
//   input 字符串        → 单条 user message
//   input 数组          → 逐项转换（message / function_call / function_call_output）
//   tools[]             → { type:'function', function:{ name, description, parameters } }
//   tool_choice         → 直传
//   max_output_tokens   → max_tokens
//   stream              → 忽略（桥内部总是非流式请求上游）
//   model               → 透传
export function responsesToChat(reqObj) {
  const req = reqObj && typeof reqObj === 'object' ? reqObj : {}
  const messages = []

  // instructions：Responses 的顶层系统提示，落到 chat 的第一条 system。
  const instructions = toText(req.instructions)
  if (instructions !== '') messages.push({ role: 'system', content: instructions })

  // input：字符串是「单条 user」，数组则逐项转换。
  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
  } else if (Array.isArray(req.input)) {
    for (const message of inputItemsToMessages(req.input)) messages.push(message)
  }

  const chat = {
    // model 透传：请求里没带就交给调用方（handler 里用 getModel 兜底）。
    model: req.model,
    messages,
    // 桥内部永远非流式：忽略 Codex 传进来的 stream。
    stream: false,
  }

  if (req.tools !== undefined) chat.tools = toolsToChat(req.tools)
  if (req.tool_choice !== undefined) chat.tool_choice = req.tool_choice
  if (req.max_output_tokens !== undefined) chat.max_tokens = req.max_output_tokens
  if (req.max_tokens !== undefined) chat.max_tokens = req.max_tokens
  if (req.temperature !== undefined) chat.temperature = req.temperature
  if (req.top_p !== undefined) chat.top_p = req.top_p
  if (req.parallel_tool_calls !== undefined) chat.parallel_tool_calls = req.parallel_tool_calls
  if (req.stop !== undefined) chat.stop = req.stop
  return chat
}

// Responses tools[] → chat tools[]。非 function 类型（如 web_search）上游不认识，丢弃。
function toolsToChat(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type !== undefined && tool.type !== 'function') continue
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool
    const name = fn.name ?? tool.name
    if (typeof name !== 'string' || name === '') continue
    const entry = { type: 'function', function: { name } }
    const description = fn.description ?? tool.description
    if (description !== undefined) entry.function.description = description
    const parameters = fn.parameters ?? tool.parameters
    if (parameters !== undefined) entry.function.parameters = parameters
    out.push(entry)
  }
  return out
}

// input 数组 → chat messages。连续多个 function_call 合并进同一条 assistant
// （chat 语义里一轮可并行多工具），function_call_output 按 call_id 回填 tool 消息。
function inputItemsToMessages(items) {
  const messages = []
  let pendingCalls = null

  const flushCalls = () => {
    if (pendingCalls) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls })
      pendingCalls = null
    }
  }

  for (const item of items) {
    if (typeof item === 'string') {
      flushCalls()
      messages.push({ role: 'user', content: item })
      continue
    }
    if (!item || typeof item !== 'object') continue

    if (item.type === 'function_call') {
      const callId = item.call_id ?? item.id
      if (!pendingCalls) pendingCalls = []
      pendingCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      })
      continue
    }

    if (item.type === 'function_call_output') {
      flushCalls()
      const toolCallId = item.call_id ?? item.tool_call_id ?? item.id
      const message = { role: 'tool', content: toText(item.output) }
      if (toolCallId !== undefined) message.tool_call_id = toolCallId
      messages.push(message)
      continue
    }

    // type:'message'（或没写 type 但带 role 的宽松写法）
    if (item.type === 'message' || item.type === undefined || item.role !== undefined) {
      flushCalls()
      messages.push({
        role: roleToChat(item.role),
        content: contentToChat(item.content),
      })
    }
  }

  flushCalls()
  return messages
}

// Responses 的 developer 角色 chat 侧统一降级为 system。
function roleToChat(role) {
  if (role === 'developer') return 'system'
  if (typeof role === 'string' && role !== '') return role
  return 'user'
}

// content：字符串原样；数组逐项映射（output_text / input_text → { type:'text', text }）。
function contentToChat(content) {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  if (!Array.isArray(content)) return toText(content)
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part })
      continue
    }
    if (!part || typeof part !== 'object') continue
    const text = toText(part.text ?? part.content)
    if (text !== '') parts.push({ type: 'text', text })
  }
  // 全是文本且只有一段时退化成字符串，兼容更挑剔的上游。
  if (parts.length === 1) return parts[0].text
  return parts
}

// 把任意 output / content 值折成纯文本。
function toText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((v) => toText(v && typeof v === 'object' ? (v.text ?? v.content ?? v.output) : v)).join('')
  }
  if (typeof value === 'object') return toText(value.text ?? value.content ?? value.output)
  return String(value)
}

// ── Chat Completions 响应 → Responses 响应（纯函数）──
// message.content   → output 里的 { type:'message', role:'assistant', content:[{type:'output_text',text}] }
// message.tool_calls→ output 里的 { type:'function_call', name, arguments, call_id }
// usage             → prompt_tokens/completion_tokens/total_tokens → input/output/total_tokens
// id 用 chatResp.id（缺失时回落到 reqId），object:'response'，status:'completed'。
export function chatToResponses(chatResp, reqId) {
  const resp = chatResp && typeof chatResp === 'object' ? chatResp : {}
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : undefined
  const message = choice && typeof choice === 'object' && choice.message && typeof choice.message === 'object'
    ? choice.message
    : {}

  const output = []

  const text = toText(message.content)
  if (text !== '') {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue
    const fn = call.function && typeof call.function === 'object' ? call.function : {}
    output.push({
      type: 'function_call',
      name: typeof fn.name === 'string' ? fn.name : (typeof call.name === 'string' ? call.name : ''),
      arguments: typeof fn.arguments === 'string'
        ? fn.arguments
        : JSON.stringify(fn.arguments ?? call.arguments ?? {}),
      call_id: call.id ?? call.call_id,
    })
  }

  return {
    id: resp.id ?? reqId,
    object: 'response',
    status: 'completed',
    output,
    usage: usageToResponses(resp.usage),
  }
}

function usageToResponses(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const input = num(u.prompt_tokens ?? u.input_tokens)
  const output = num(u.completion_tokens ?? u.output_tokens)
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: num(u.total_tokens) || input + output,
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// output 里取第一段 assistant 文本（用于回放 output_text.delta）。
function firstText(response) {
  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const part of item.content) {
      if (part.type === 'output_text' && part.text !== '') return part.text
    }
  }
  return ''
}

// ── 本地桥 server ──
// createBridgeServer({ upstreamBaseUrl, apiKey, getModel })
//   只接 POST /responses，其余 404；监听 127.0.0.1 随机端口（server.address().port）。
//   流程：responsesToChat → fetch ${upstreamBaseUrl}/chat/completions（非流式）
//         → chatToResponses → Responses SSE 回放 → 收尾 data: [DONE]
//   上游 fetch 抛错或非 2xx → 回一条 SSE error 事件并 close。
export function createBridgeServer({ upstreamBaseUrl, apiKey, getModel } = {}) {
  const base = String(upstreamBaseUrl ?? '').replace(/\/+$/, '')

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { base, apiKey, getModel }).catch((err) => {
      // 兜底：handler 自己已处理过的错误不会再走到这里。
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: { message: errMsg(err) } }))
      } else {
        res.end()
      }
    })
  })

  server.on('listening', () => { server.port = server.address().port })
  server.listen(0, '127.0.0.1')
  return server
}

const errMsg = (e) => (e && e.message) ? e.message : String(e)

async function handleRequest(req, res, { base, apiKey, getModel }) {
  const url = (req.url || '').split('?')[0]
  if (req.method !== 'POST' || url !== '/responses') {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url}` } }))
    return
  }

  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: { message: 'invalid json body' } }))
    return
  }

  const reqId = `resp_bridge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const fallbackModel = typeof getModel === 'function' ? getModel() : getModel
  const chatReq = responsesToChat({ ...body, model: body.model ?? fallbackModel })
  if (chatReq.model === undefined || chatReq.model === null || chatReq.model === '') delete chatReq.model

  try {
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(chatReq),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      writeSseError(res, `upstream ${upstream.status} ${upstream.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
      return
    }

    const chatResp = await upstream.json()
    const response = chatToResponses(chatResp, reqId)
    replayAsSse(res, response)
  } catch (err) {
    writeSseError(res, `upstream fetch failed: ${errMsg(err)}`)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Responses SSE 回放：created → (output_text.delta) → completed → [DONE]。
function replayAsSse(res, response) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  writeEvent(res, 'response.created', {
    type: 'response.created',
    response: { id: response.id, object: 'response', status: 'in_progress', output: [] },
  })

  const text = firstText(response)
  if (text !== '') {
    writeEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      delta: text,
      item_id: `msg_${response.id}`,
      output_index: 0,
      content_index: 0,
    })
  }

  writeEvent(res, 'response.completed', { type: 'response.completed', response })
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeSseError(res, message) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.flushHeaders?.()
  writeEvent(res, 'error', { type: 'error', error: { type: 'upstream_error', message } })
  res.end()
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ── 自测：node src/bridge.js（或 pnpm 直接跑本文件）──
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
  const { once } = await import('node:events')

  let seenChatReq = null
  const upstream = http.createServer(async (req, res) => {
    seenChatReq = JSON.parse(await readBody(req))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      id: 'chatcmpl-selftest-1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_selftest_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"上海"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')

  const bridge = createBridgeServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: 'test-key',
    getModel: () => 'unisound-test-model',
  })
  await once(bridge, 'listening')

  try {
    // 纯函数自测：字符串 input + instructions + tools + 限额映射。
    const converted = responsesToChat({
      instructions: '你是助手。',
      input: '北京天气如何？',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' }, description: '查天气' }],
      tool_choice: 'auto',
      max_output_tokens: 42,
      stream: true,
      model: 'm1',
    })
    assert(converted.messages[0].role === 'system' && converted.messages[0].content === '你是助手。', 'instructions 应为首条 system')
    assert(converted.messages[1].role === 'user' && converted.messages[1].content === '北京天气如何？', '字符串 input 应为单条 user')
    assert(converted.tools[0].type === 'function' && converted.tools[0].function.name === 'get_weather', 'tools 应转成 chat function 形状')
    assert(converted.tool_choice === 'auto' && converted.max_tokens === 42 && converted.stream === false, 'tool_choice/max_tokens/stream 映射错误')

    // 端到端自测：带 tools 的 Responses 请求打进桥，看 SSE 回放。
    const resp = await fetch(`http://127.0.0.1:${bridge.address().port}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'unisound-test-model',
        instructions: 'You are a helper.',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '上海天气？' }] },
        ],
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } }, description: '查天气' }],
        tool_choice: 'auto',
      }),
    })
    assert(resp.status === 200, `桥应回 200，实得 ${resp.status}`)
    assert((resp.headers.get('content-type') || '').includes('text/event-stream'), 'Content-Type 应为 text/event-stream')
    const sse = await resp.text()

    assert(seenChatReq && seenChatReq.tools && seenChatReq.tools[0].type === 'function', '上游应收到 chat tools')
    assert(seenChatReq.tools[0].function.name === 'get_weather', '上游 tools 的 function.name 丢失')
    assert(seenChatReq.tools[0].function.parameters.properties.city.type === 'string', '上游 tools 的 parameters 应透传')
    assert(seenChatReq.messages[0].role === 'system' && seenChatReq.messages[1].role === 'user', '上游 messages 顺序错误')
    assert(seenChatReq.messages[1].content === '上海天气？', 'input 数组里的文本应转成 chat content')
    assert(seenChatReq.stream === false, '请求上游必须非流式')

    assert(sse.includes('event: response.created'), 'SSE 缺少 response.created')
    assert(sse.includes('event: response.completed'), 'SSE 缺少 response.completed')
    assert(sse.includes('"function_call"'), 'SSE 缺少 function_call 输出')
    assert(sse.includes('get_weather') && sse.includes('call_selftest_1'), 'SSE 里的 function_call 内容不完整')
    assert(sse.includes('"total_tokens":18'), 'completed 里 usage 映射错误')
    assert(sse.trimEnd().endsWith('data: [DONE]'), 'SSE 应以 data: [DONE] 收尾')

    // 404 边界：非 /responses 或非 POST。
    const nf = await fetch(`http://127.0.0.1:${bridge.address().port}/other`, { method: 'POST' })
    assert(nf.status === 404, `未知路由应 404，实得 ${nf.status}`)

    // 上游非 2xx：应回 SSE error 事件。
    const badBridge = createBridgeServer({ upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'k', getModel: () => 'm' })
    await once(badBridge, 'listening')
    const bad = await fetch(`http://127.0.0.1:${badBridge.address().port}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    const badSse = await bad.text()
    assert(badSse.includes('event: error'), '上游失败时应回 SSE error 事件')
    badBridge.close()

    console.log('BRIDGE-SELFTEST-PASS')
  } catch (err) {
    console.error(`BRIDGE-SELFTEST-FAIL: ${errMsg(err)}`)
    process.exitCode = 1
  } finally {
    bridge.close()
    upstream.close()
  }
}

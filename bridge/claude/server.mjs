#!/usr/bin/env node
/**
 * Claude 聊天桥（独立进程，端口 8789）。
 *
 * 两条实测结论决定它的形态：
 *   1. `claude -p --input-format stream-json --output-format stream-json --verbose`
 *      收到第一行 user 消息后不退出，第二轮仍回同一 session_id（2026-11-06 实测
 *      两轮均 2a20329f），关 stdin 后 rc=0 ⇒ 天然双工，不需要 --bg / 日志解析。
 *   2. `system/thinking_tokens` 单轮数百条、每轮重发一次 `system/init`（session_id 不变）
 *      ⇒ thinking 只累计按 250ms 合并广播；init 记 turn 边界，不当新会话。
 *
 * 页面复用 Pi 桥的同一条路：直接读 `bridge/web/public/index.html`，只补它需要的端点。
 * 差别在事件源 —— 本桥是 claude 的 NDJSON，不是 Codex 的 app-server、也不是 Pi 的 RPC。
 *
 * 端点（与共用前端契约对齐）：
 *   GET  /                     → 聊天页（注入 token 占位，与 Pi 一致）
 *   GET  /api/health           → { ok, running, pid, web:{running,port}, as:{running:false} }
 *   GET  /api/config           → { engine:'claude', provider, model, cwd }
 *   GET/POST /api/runtime-settings → 只接受 {model}
 *   GET  /api/lock-info        → { ok, held:false, holders:[] }
 *   GET  /api/stamp            → { ok, stamp:'' }
 *   GET  /api/threads          → 单条当前会话
 *   GET  /api/transcript       → { ok, entries:[{t:'me'|'ai', text}] }
 *   POST /api/send { text }    → NDJSON: {kind:'meta'|'text'|'end'}
 *   POST /api/stop             → 关 stdin
 *   GET  /api/events           → SSE（程序化接入用，页面不走它）
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 2026-11-06：桥以前没有任何异常兜底，未捕获异常会静默退出（用户「跑着跑着桥停了」查无实证）。
// stderr 现在由插件侧重定向到 ~/.dsh/second-engine/claude-bridge.log，这里只要保证崩溃留痕。
process.on('uncaughtException', (e) => {
  try { console.error(`[fatal] uncaughtException: ${e && e.stack ? e.stack : e}`) } catch { /* ignore */ }
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  try { console.error(`[fatal] unhandledRejection: ${e && e.stack ? e.stack : e}`) } catch { /* ignore */ }
})

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8789)
const HOST = '127.0.0.1'
const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || ''
const THINKING_FLUSH_MS = 250
const TURN_TIMEOUT_MS = 180000
const CWD = process.env.CLAUDE_BRIDGE_CWD || join(homedir(), 'claude-workspace')
const PAGE = join(import.meta.dirname, '..', 'web', 'public', 'index.html')

// ── 凭据：只从插件自己的 provider 存储读，绝不进 argv / 日志 ──────────────
function loadCredentials() {
  const p = join(homedir(), '.dsh', 'second-engine', 'claude-providers.json')
  let doc
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(`读不到 ${p}：${e.message}`)
  }
  const list = Array.isArray(doc.providers) ? doc.providers : []
  // 顶层 doc.active 是 provider 的 id（不是每个条目上的布尔 active）。
  // 原来只认布尔字段，找不到就回落 list[0]，导致「provider=DeepSeek 官方、模型列表却是中转的 claude-*」错配。
  const activeId = typeof doc.active === 'string' ? doc.active : ''
  const active = list.find((x) => x && x.id === activeId)
    || list.find((x) => x && x.active)
    || list[0]
  if (!active || !active.apiKey) throw new Error('claude-providers.json 里没有可用的 provider/apiKey')
  const env = {}
  if (active.baseUrl) env.ANTHROPIC_BASE_URL = String(active.baseUrl)
  env.ANTHROPIC_AUTH_TOKEN = String(active.apiKey)
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return {
    env,
    model: active.model || 'sonnet',
    provider: active.name || active.id || 'active',
  }
}

// 用户在页面选的模型落 ~/.dsh/second-engine/claude-model.txt —— 与插件 handleProviderModel 同一份文件，
// 这样桥重启/进程重建都不会回落到凭据里的默认模型。
const MODEL_PATH = join(homedir(), '.dsh', 'second-engine', 'claude-model.txt')
function loadModelOverride() {
  try { return readFileSync(MODEL_PATH, 'utf8').trim() } catch { return '' }
}

// ── 状态 ────────────────────────────────────────────────────────────────
const state = {
  child: null,
  running: false,
  sessionId: null,
  model: '',
  provider: '',
  turns: 0,
  startedAt: 0,
  pendingThinking: 0,
  thinkingTimer: null,
  entries: [],
  busy: false,
  // --effort 是进程启动参数（low/medium/high/xhigh/max），改了要重建进程
  effort: process.env.CLAUDE_BRIDGE_EFFORT || '',
  restartAfterExit: false,
  pendingResume: '',
  pendingText: '',
}
const clients = new Set()

// 模型列表照 Codex 桥的做法：不自己拼，调插件侧 /second-engine/api/models
// （bridge/web/server.mjs:752 就是这么拿的）。失败时回落当前 provider 的单个模型。
const HOST_API = process.env.DSH_WEB_URL || 'http://127.0.0.1:43309'
let modelsCache = { at: 0, list: [] }
async function fetchModels() {
  if (Date.now() - modelsCache.at < 60000 && modelsCache.list.length) return modelsCache.list
  try {
    const r = await fetch(`${HOST_API}/second-engine/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'claude' }),
    })
    const d = await r.json()
    const list = Array.isArray(d.models) ? d.models.filter((x) => typeof x === 'string' && x) : []
    if (list.length) {
      modelsCache = { at: Date.now(), list }
      return list
    }
  } catch { /* 插件不可达时回落 */ }
  return state.model ? [state.model] : []
}
let activeSend = null

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`
  for (const res of clients) {
    try { res.write(line) } catch { clients.delete(res) }
  }
}

function flushThinking() {
  state.thinkingTimer = null
  if (!state.pendingThinking) return
  broadcast({ type: 'thinking', tokens: state.pendingThinking })
  state.pendingThinking = 0
}

function noteThinking(n) {
  state.pendingThinking += Number(n) || 0
  if (!state.thinkingTimer) {
    state.thinkingTimer = setTimeout(flushThinking, THINKING_FLUSH_MS)
    if (typeof state.thinkingTimer.unref === 'function') state.thinkingTimer.unref()
  }
}

function finishSend(kind) {
  const cur = activeSend
  if (!cur || cur.finished) return
  cur.finished = true
  activeSend = null
  if (cur.timer) clearTimeout(cur.timer)
  try { cur.res.write(JSON.stringify({ kind: kind || 'end' }) + '\n') } catch { /* 已断开 */ }
  try { cur.res.end() } catch { /* 同上 */ }
  state.busy = false
}

function writeChunk(text) {
  const cur = activeSend
  if (!cur || cur.finished) return
  try { cur.res.write(JSON.stringify({ kind: 'text', text }) + '\n') } catch { /* 断开 */ }
}

function handleEvent(obj) {
  const type = obj && obj.type
  const sid = obj && (obj.session_id || (obj.message && obj.message.session_id))
  if (sid) state.sessionId = String(sid)

  if (type === 'system' && obj.subtype === 'init') {
    state.turns += 1
    broadcast({ type: 'init', sessionId: state.sessionId, model: obj.model || state.model, turn: state.turns })
    if (state.pendingText) {
      const t = state.pendingText
      state.pendingText = ''
      try { sendToChild(t) } catch { /* 下一轮再试 */ }
    }
    return
  }
  if (type === 'system' && obj.subtype === 'thinking_tokens') {
    noteThinking(obj.amount || obj.tokens || 1)
    return
  }
  if (type === 'assistant') {
    const content = (obj.message && obj.message.content) || []
    for (const block of content) {
      if (block && block.type === 'text' && block.text) {
        writeChunk(block.text)
        broadcast({ type: 'assistant', text: block.text, sessionId: state.sessionId })
      }
      if (block && block.type === 'thinking' && block.thinking) {
        // 预览 240 字 + 全文走 full：前端点一下展开，数据不丢（2026-11-06）。
        const text = String(block.thinking)
        const detail = text.slice(0, 240)
        const cur = activeSend
        if (cur && !cur.finished) {
          try { cur.res.write(JSON.stringify({ kind: 'activity', name: '思考', detail, full: text }) + '\n') } catch { /* 断开 */ }
        }
      }
    }
    return
  }
  if (type === 'result') {
    flushThinking()
    const text = typeof obj.result === 'string' ? obj.result : ''
    state.entries.push({ t: 'ai', text: text || '（空回复）' })
    broadcast({ type: 'result', ok: !obj.is_error, durationMs: obj.duration_ms || 0, sessionId: state.sessionId })
    finishSend('end')
    return
  }
  if (type === 'user') broadcast({ type: 'tool', sessionId: state.sessionId })
}

function start() {
  if (state.running) return
  const cred = loadCredentials()
  // 不能直接覆盖：state.model 可能是用户在页面选的（且落盘在 claude-model.txt）。
  // 原来这里写 `state.model = cred.model`，导致每次重建都切回默认模型 —— 下拉看着改了、实际没变。
  state.model = state.model || cred.model
  state.provider = cred.provider
  // 模型以 state.model 为准：下拉里切换后要真生效，不能永远用凭据里的那个
  const model = state.model || cred.model
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Bash',
  ]
  if (state.pendingResume) args.push('--resume', state.pendingResume)
  // 2026-11-06 实测（Claude 自查自己 CLI）：不传 --effort 时模型只是偶尔才想，
  // --effort low 2/2 无思考、--effort high 4/4 带非空 thinking 块。
  // 用户要看到思考 ⇒ 没设档位时默认 high（可由前端档位按钮覆盖）。
  args.push('--effort', state.effort || 'high')
  const child = spawn('claude', args, {
    cwd: CWD,
    env: { ...process.env, ...cred.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  state.child = child
  state.running = true
  state.startedAt = Date.now()

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try { handleEvent(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) broadcast({ type: 'stderr', text: text.slice(0, 500) })
  })
  child.on('exit', (code, signal) => {
    flushThinking()
    state.running = false
    state.child = null
    if (!state.restartAfterExit) finishSend('end')
    broadcast({ type: 'exit', code, signal })
    if (state.restartAfterExit) {
      state.restartAfterExit = false
      setTimeout(() => { try { start() } catch { /* ignore */ } }, 100)
    }
  })
  child.on('error', (e) => {
    state.running = false
    state.child = null
    finishSend('end')
    broadcast({ type: 'error', error: e.message })
  })
}

// 历史会话：~/.claude/projects/<cwd 的 / 换成 ->/*.jsonl，一个文件一个 session。
function encodeCwd(dir) {
  return String(dir || '').replace(/\//g, '-')
}

function sessionDir() {
  return join(homedir(), '.claude', 'projects', encodeCwd(CWD))
}

// 解析一个会话文件（Claude 的 jsonl：每行 {type, message:{role,content}, sessionId}）。
// 只留纯文本 —— 与 Codex 桥 itemToEntry 的口径一致：tool 调用不塞进对话流。
function readSession(id) {
  const file = join(sessionDir(), `${id}.jsonl`)
  const entries = []
  let title = ''
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { entries, title } }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const m = o && o.message
    if (!m || typeof m !== 'object') continue
    let body = ''
    if (typeof m.content === 'string') body = m.content
    else if (Array.isArray(m.content)) {
      body = m.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
    }
    if (!body) continue
    if (m.role === 'user') {
      // <system-reminder>、命令注入等以 < 开头的内容不是用户原话，会话回放里剔除
      if (body.trimStart().startsWith('<')) continue
      if (!title) title = body.replace(/\s+/g, ' ').slice(0, 40)
      entries.push({ t: 'me', text: body })
    } else if (m.role === 'assistant') {
      entries.push({ t: 'ai', text: body })
    }
  }
  return { entries, title }
}

function listHistory() {
  const dir = sessionDir()
  const out = []
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const st = statSync(join(dir, name))
      out.push({ id: name.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, bytes: st.size })
    } catch { /* 并发消失 */ }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function sendToChild(text) {
  if (!state.running || !state.child) throw new Error('桥未启动')
  const stdin = state.child.stdin
  // 2026-11-06 崩桥实证：切会话时先 stdin.end() 再写 → ERR_STREAM_WRITE_AFTER_END。
  // 这个错误是**异步 emit 的 error 事件**，外层 try/catch 抓不住，会把整个桥带走。
  // 所以写之前先看流还开不开；关了就抛同步错，让调用方走 finishSend。
  if (stdin === null || stdin === undefined || stdin.destroyed || !stdin.writable) {
    throw new Error('子进程 stdin 已关闭（会话正在切换）')
  }
  stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n')
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────
function json(res, body, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function authorized(req) {
  if (!TOKEN) return true
  const remote = req.socket.remoteAddress || ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  return req.headers['x-bridge-token'] === TOKEN
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = readFileSync(PAGE, 'utf8')
        const injected = html.replace(
          '</head>',
          "<script>try{if(!localStorage.getItem('bridge_token'))localStorage.setItem('bridge_token','local')}catch(e){}</script></head>",
        )
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(injected)
      } catch {
        return json(res, { ok: false, error: `首页读取失败：${PAGE}` }, 500)
      }
    }

    if (!authorized(req)) return json(res, { ok: false, error: 'unauthorized' }, 401)

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, {
        ok: true,
        running: state.running,
        pid: state.child ? state.child.pid : null,
        port: PORT,
        sessionId: state.sessionId,
        model: state.model,
        turns: state.turns,
        // 兼容共用前端的两种读法（Codex 桥读 web/as，Pi 桥读平铺字段）
        web: { running: state.running, port: PORT, pid: state.child ? state.child.pid : null },
        as: { running: false, connected: false },
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, { ok: true, engine: 'claude', provider: state.provider, model: state.model, cwd: CWD })
    }
    if (req.method === 'GET' && url.pathname === '/api/lock-info') {
      return json(res, { ok: true, held: false, holders: [], hint: 'Claude 引擎没有写锁概念' })
    }
    if (req.method === 'GET' && url.pathname === '/api/stamp') {
      return json(res, { ok: true, stamp: '' })
    }
    if (url.pathname === '/api/runtime-settings') {
      if (req.method === 'GET') {
        return json(res, {
          ok: true,
          engine: 'claude',
          provider: state.provider,
          model: state.model,
          models: await fetchModels(),
          // 2026-11-06 实测 `claude --help`：--effort <level>（low/medium/high/xhigh/max）
          // 另有 MAX_THINKING_TOKENS 环境变量控制思考 token 预算（0 = 关）
          levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          effort: state.effort,
        })
      }
      const body = await readJson(req)
      if (body.effort !== undefined) {
        const lv = String(body.effort).trim()
        const allowed = ['low', 'medium', 'high', 'xhigh', 'max']
        if (!allowed.includes(lv)) return json(res, { ok: false, error: `effort 只能是 ${allowed.join('/')}` }, 400)
        state.effort = lv
        // 启动参数变了必须重建进程；会话上下文会重来（前端会看到新的一轮）
        if (state.running && state.child) {
          state.restartAfterExit = true
          try { state.child.stdin.end() } catch { /* ignore */ }
        }
      }
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !body.model.trim()) {
          return json(res, { ok: false, error: 'model 不能为空' }, 400)
        }
        state.model = body.model.trim()
        try { writeFileSync(MODEL_PATH, state.model, { mode: 0o644 }) } catch { /* 落盘失败不回滚内存值 */ }
        // --model 是启动参数，与 effort 同理：进程在跑就重建，否则下次启动生效
        if (state.running && state.child) {
          state.restartAfterExit = true
          try { state.child.stdin.end() } catch { /* ignore */ }
        }
      }
      return json(res, { ok: true, engine: 'claude', provider: state.provider, model: state.model, effort: state.effort })
    }
    if (req.method === 'GET' && url.pathname === '/api/threads') {
      // 形状照 Codex 桥的 threadRow（bridge/web/server.mjs:198）：id/title/source/updatedAt/busy/cwd/pending
      const hist = listHistory().map((h) => {
        const meta = readSession(h.id)
        return {
          id: h.id,
          title: meta.title || CWD,
          source: 'bridge',
          updatedAt: new Date(h.mtime).toISOString(),
          busy: h.id === state.sessionId ? state.busy : false,
          cwd: CWD,
          pending: false,
        }
      })
      if (state.sessionId && !hist.some((h) => h.id === state.sessionId)) {
        hist.unshift({
          id: state.sessionId, title: `${CWD} · 当前`, source: 'bridge',
          updatedAt: new Date().toISOString(), busy: state.busy, cwd: CWD, pending: false,
        })
      }
      if (!hist.length) hist.push({ id: 'session', title: CWD, source: 'bridge', updatedAt: new Date().toISOString(), busy: state.busy, cwd: CWD, pending: false })
      return json(res, { ok: true, threads: hist })
    }
    if (req.method === 'GET' && url.pathname === '/api/transcript') {
      const id = url.searchParams.get('id') || state.sessionId || ''
      if (!id) return json(res, { ok: true, entries: [] })
      const meta = readSession(id)
      return json(res, { ok: true, entries: meta.entries })
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readJson(req)
      const text = typeof body.text === 'string' ? body.text
        : (typeof body.message === 'string' ? body.message : '')
      if (text === '') return json(res, { ok: false, error: 'text 不能为空' }, 400)
      // 前端「新会话」只做本地清屏并把 threadId 置 null（index.html:newThread）。
      // 收到 null 必须真的丢掉旧会话，否则下一条消息会继续发进上一个 session —— 这就是
      // 「新建后反而接到旧会话」的根因。
      const wantNew = body.threadId === null
      const wantThread = typeof body.threadId === 'string' ? body.threadId : ''
      // 只有「看起来是会话 UUID」的 id 才当历史切换。新会话时前端拿到的是占位
      // `claude-session` / `claude-<旧id>`，那不是可 resume 的 id，误当切换会去 resume 一个不存在的会话。
      const isSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wantThread)
      const switchTo = isSessionId && wantThread !== state.sessionId ? wantThread : ''
      let queued = false
      try {
        if (wantNew) {
          state.pendingResume = ''
          if (state.running && state.child) {
            state.pendingText = text
            state.restartAfterExit = true
            try { state.child.stdin.end() } catch { /* ignore */ }
            queued = true
          } else {
            state.sessionId = null
            state.entries = []
            start()
          }
        } else if (switchTo) {
          // 切到历史会话：--resume 是启动参数，只能重建进程；文本等 init 后由 state.pendingText 发出
          state.pendingResume = switchTo
          state.pendingText = text
          if (state.running && state.child) {
            state.restartAfterExit = true
            try { state.child.stdin.end() } catch { /* ignore */ }
          } else {
            start()
          }
        } else if (!state.running) {
          start()
        }
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500)
      }
      const threadId = `claude-${state.sessionId || 'session'}`
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
      res.write(JSON.stringify({ kind: 'meta', threadId }) + '\n')
      state.entries.push({ t: 'me', text })
      state.busy = true
      const timer = setTimeout(() => finishSend('end'), TURN_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      activeSend = { res, finished: false, timer }
      req.on('close', () => {
        if (activeSend && activeSend.res === res && !activeSend.finished) {
          activeSend.finished = true
          activeSend = null
          state.busy = false
        }
      })
      if (!queued) {
        try {
          sendToChild(text)
        } catch (e) {
          writeChunk(`[发送失败] ${e.message}`)
          finishSend('end')
        }
      }
      return
    }
    // 独立会话端点（2026-11-06）：不带消息，只做「新建 / 切到历史」。
    // /api/send 的 threadId 语义保持不动 —— 这个端点是给外部脚本/编排放的，
    // 免得为了切个会话得先编一条假消息。
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : ''
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (action === 'new') {
        state.pendingResume = ''
        state.sessionId = null
        state.entries = []
        if (state.running && state.child) {
          // 与 /api/send 的 wantNew 分支同路：结束当前进程，exit 后按空 resume 重启
          state.restartAfterExit = true
          try { state.child.stdin.end() } catch { /* ignore */ }
        } else {
          start()
        }
        return json(res, { ok: true, action: 'new', sessionId: null })
      }
      if (action === 'switch') {
        const id = typeof body.threadId === 'string' ? body.threadId.trim() : ''
        if (!isUuid.test(id)) return json(res, { ok: false, error: 'threadId 必须是会话 UUID' }, 400)
        state.pendingResume = id
        state.sessionId = id
        if (state.running && state.child) {
          // --resume 是启动参数，只能重建进程
          state.restartAfterExit = true
          try { state.child.stdin.end() } catch { /* ignore */ }
        } else {
          start()
        }
        return json(res, { ok: true, action: 'switch', sessionId: id })
      }
      return json(res, { ok: false, error: "action 只支持 'new' 或 'switch'" }, 400)
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!state.running || !state.child) return json(res, { ok: true, note: '未运行' })
      try { state.child.stdin.end() } catch { /* ignore */ }
      const child = state.child
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGTERM') } catch { /* ignore */ } }, 5000)
      return json(res, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      json(res, { ok: true, message: 'shutting down' })
      setTimeout(() => process.exit(0), 120)
      return
    }
    return json(res, { ok: false, error: `未知端点 ${url.pathname}` }, 404)
  } catch (e) {
    return json(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500)
  }
})

// 启动时先读一次凭据：模型下拉与 /api/config 在「还没发过消息」时也要有值
try {
  const cred0 = loadCredentials()
  state.model = loadModelOverride() || cred0.model
  state.provider = cred0.provider
} catch { /* 凭据缺失时保持空，send 时再报错 */ }

server.listen(PORT, HOST, () => {
  process.stdout.write(`claude-bridge listening on http://${HOST}:${PORT}\n`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (state.child) { try { state.child.stdin.end() } catch { /* ignore */ } }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500)
  })
}

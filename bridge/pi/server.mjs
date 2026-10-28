// Pi 浏览器聊天桥（P5 雏形，2026-10-28）
//
// 形态：起一个长驻 `pi --mode rpc` 子进程 + 一个 HTTP 服务，把 HTTP 请求翻成 RPC 命令。
// 与 Codex 桥（bridge/web/server.mjs）的区别：
//   · Codex 桥连的是**已经在跑**的 app-server，做 Responses↔chat 协议翻译
//   · Pi 桥**自己管进程**，不做协议翻译（Pi 原生支持 15+ provider）
// 端点契约与 Codex 前端一致，所以 public/index.html 可直接复用：
//   GET  /api/config            当前 provider/model
//   GET  /api/threads           Pi 的会话（先用当前这一个）
//   GET  /api/transcript?id=    get_messages
//   POST /api/send              prompt
//   POST /api/stop              abort
//   GET  /api/health            健康状况（本桥自加）
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { resolvePiProvider, PI_MODELS_PATH } from '../../src/engine/pi-probe.js'

const PORT = Number(process.env.PI_BRIDGE_PORT || 8788)
const HOST = process.env.PI_BRIDGE_HOST || '127.0.0.1'
const CWD = process.env.PI_BRIDGE_CWD || process.cwd()
const TOKEN = process.env.PI_BRIDGE_TOKEN || ''
const PI_BIN = process.env.PI_BIN || 'pi'

const log = (...a) => console.log(new Date().toISOString(), ...a)

const resolveProvider = () => resolvePiProvider()

// ── RPC 客户端：严格 JSONL，命令 id 关联（rpc.md「Correlate commands and responses」）──
class PiRpc {
  constructor({ provider, model, key, cwd }) {
    // P4.26（2026-10-29）：去掉 --no-session —— 网页对话也要落盘，
    // 与 CLI 会话同源（~/.pi/agent/sessions/<cwd 编码>/*.jsonl），便于事后回溯。
    // 会话目录默认即 agentDir/sessions；需要隔离时用 --session-dir 覆盖。
    const args = ['--mode', 'rpc']
    if (provider) args.push('--provider', provider)
    if (model) args.push('--model', model)
    const env = { ...process.env }
    if (provider && key) env[`${provider.toUpperCase()}_API_KEY`] = key
    this.child = spawn(PI_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.seq = 0
    this.pending = new Map()   // id → {resolve, reject, timer}
    this.listeners = new Set()
    this.stderrTail = ''
    this.buf = ''
    this.child.stdout.on('data', (c) => this.feed(c))
    this.child.stderr.on('data', (c) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-4000) })
    this.child.on('exit', (code) => { this.exitCode = code; for (const [,p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`pi rpc 退出 code=${code}`)) } this.pending.clear() })
    this.child.on('error', (e) => { for (const [,p] of this.pending) { clearTimeout(p.timer); p.reject(e) } this.pending.clear() })
  }

  // rpc.md「Framing」：只按 LF 切；**不用 readline**（它还会按 U+2028/U+2029 切）
  feed(chunk) {
    this.buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      if (line.trim() === '') continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type === 'response' && rec.id !== undefined && this.pending.has(rec.id)) {
        const p = this.pending.get(rec.id); clearTimeout(p.timer); this.pending.delete(rec.id)
        if (rec.success === false) p.reject(new Error(rec.error?.message || rec.error || 'rpc 命令失败'))
        else p.resolve(rec.data)
      } else {
        for (const fn of this.listeners) { try { fn(rec) } catch { /* 监听器异常不影响协议 */ } }
      }
    }
  }

  command(type, payload = {}, timeoutMs = 60000) {
    const id = `c-${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 超时`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.child.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n') }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  kill() { try { this.child.kill('SIGTERM') } catch { /* 已退出 */ } }
}

// ── HTTP ──
const prov = resolveProvider()
if (!prov) {
  console.error('[pi-bridge] 没有可用的 Pi provider/API Key，请先配置 ~/.pi/agent/models.json 或 keyring。')
  process.exit(2)
}
const rpc = new PiRpc({ provider: prov.id, model: prov.model, key: prov.key, cwd: CWD })
log(`[pi-bridge] provider=${prov.id} model=${prov.model || '<默认>'} cwd=${CWD} port=${PORT} pid=${rpc.child.pid}`)

const messages = []          // 简易 transcript（真实实现应读 session 文件）
rpc.onEvent((rec) => {
  messages.push({ at: Date.now(), rec })
  if (messages.length > 500) messages.shift()
})

function send(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('body 过大')); req.destroy() } })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function authed(req) {
  if (TOKEN === '') return true
  return req.headers['x-bridge-token'] === TOKEN
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, engine: 'pi', provider: prov.id, model: prov.model, cwd: CWD, pid: rpc.child.pid, exitCode: rpc.exitCode ?? null })
    }

    // 首页：直接复用 Codex 聊天桥的前端（单文件，无外部资源）。
    // 它要的 8 个端点本服务已覆盖：config/send/stop/threads/transcript/lock-info/stamp(+thread)。
    // 用户实测：点「打开网页」跳到 8788 根路径只看到 {"ok":false,"error":"未知端点 /"}。
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // 不带 t 参数时重定向到 ?t=local：前端只在「URL 有 ?t=」时才写 localStorage，
      // 注入 <script> 依赖页面不被缓存 —— 实测用户刷新后仍报「没有 token」（磁盘/代理缓存）。
      // 302 不依赖脚本执行，也不依赖缓存策略。前端读完会用 history.replaceState 把 t 抹掉。
      if (url.searchParams.get('t') === null) {
        res.writeHead(302, { Location: '/?t=local', 'cache-control': 'no-store' })
        return res.end()
      }
      // 只用已导入的 readFileSync + import.meta.dirname（Node 20.11+），
      // 避免再引 readFile/dirname/fileURLToPath —— node --check 查不出未定义标识符。
      const page = join(import.meta.dirname, '..', 'web', 'public', 'index.html')
      try {
        const html = readFileSync(page, 'utf8')
        // 前端从 URL 的 ?t= 或 localStorage 的 bridge_token 取 token，取不到就
        // `if (!TOKEN) { 提示"没有 token"; return }` —— 直接拦掉发送（用户截图那条红条）。
        // Codex 桥靠"启动时打印带 token 的网址"；Pi 桥默认无 token（authed 恒 true），
        // 所以这里种一个占位值，让页面不再自锁。已有真实值时不覆盖。
        const injected = html.replace(
          '</head>',
          `<script>try{if(!localStorage.getItem('bridge_token'))localStorage.setItem('bridge_token','local')}catch(e){}</script></head>`,
        )
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(injected)
      } catch (e) {
        return send(res, 500, { ok: false, error: `首页读取失败：${page}` })
      }
    }
    if (!authed(req)) return send(res, 401, { ok: false, error: 'token' })

    // Shutdown is privileged just like other bridge operations.
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true, message: 'shutting down' })
      setTimeout(() => {
        try { rpc.kill() } catch { /* 已退出 */ }
        server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 1500)
      }, 100)
      return
    }

    if (!authed(req)) return send(res, 401, { ok: false, error: 'token' })

    if (url.pathname === '/api/config') {
      return send(res, 200, { ok: true, engine: 'pi', provider: prov.id, model: prov.model, cwd: CWD })
    }
    if (url.pathname === '/api/runtime-settings') {
      if (req.method === 'GET') {
        const state = await rpc.command('get_state', {}, 10000)
        const models = await rpc.command('get_available_models', {}, 10000).catch(() => [])
        // ⚠️ Pi 没有 get_available_thinking_levels 这条命令（docs/rpc-commands.md 只有
        // set_thinking_level 与 cycle_thinking_level）。原稿调它 → method not found →
        // catch 返回 [] → 前端档位按钮被清空，只剩空容器（用户实测「只显示关」）。
        // Pi 的档位是固定 7 档（同文档 :282），直接给常量。
        const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        // ⚠️ get_state 的 model 是**对象**（{id,name,provider,cost,...}），
        // 直接透传会让前端 input.value 变成 [object Object]（用户实测）。
        const modelObj = state.model
        const modelId = typeof modelObj === 'string'
          ? modelObj
          : (modelObj !== null && typeof modelObj === 'object' && typeof modelObj.id === 'string' ? modelObj.id : '')
        return send(res, 200, {
          engine: 'pi', provider: prov.id, model: modelId || prov.model || '',
          effort: state.thinkingLevel || '',
          models: (Array.isArray(models) ? models : (models?.models || []))
            .filter((m) => !m.provider || m.provider === prov.id)
            .map((m) => (typeof m === 'string' ? m : m.id))
            .filter(Boolean),
          levels: PI_THINKING_LEVELS,
        })
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      const keys = Object.keys(body).filter((k) => k !== 'threadId')
      if (!keys.length || keys.some((k) => !['model', 'effort'].includes(k))) return send(res, 400, { ok: false, error: '只接受 model / effort' })
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !body.model.trim()) return send(res, 400, { ok: false, error: 'model 不能为空' })
        await rpc.command('set_model', { provider: prov.id, modelId: body.model.trim() }, 15000)
      }
      if (body.effort !== undefined) {
        if (typeof body.effort !== 'string' || !/^[a-z]+$/.test(body.effort)) return send(res, 400, { ok: false, error: 'effort 不合法' })
        await rpc.command('set_thinking_level', { level: body.effort }, 15000)
      }
      const state = await rpc.command('get_state', {}, 10000)
      const m2 = state.model
      const modelId2 = typeof m2 === 'string' ? m2
        : (m2 !== null && typeof m2 === 'object' && typeof m2.id === 'string' ? m2.id : '')
      return send(res, 200, { ok: true, engine: 'pi', model: modelId2, effort: state.thinkingLevel || '' })
    }
    // Codex 桥的两个专有端点：Pi 无写锁、无 app-server stamp。
    // 前端用法已核对：lock-info 只要 { held:false } 就安全（走"无锁持有者"分支）；
    // stamp 取 s.stamp || ''，空串安全。给虚假的 held:true 反而会让前端去读 holders 数组。
    if (url.pathname === '/api/lock-info') {
      return send(res, 200, { ok: true, held: false, holders: [], hint: 'Pi 引擎没有 Codex 的写锁概念' })
    }
    if (url.pathname === '/api/stamp') {
      return send(res, 200, { ok: true, stamp: '' })
    }
    if (url.pathname === '/api/threads') {
      const st = await rpc.command('get_state', {}, 10000).catch(() => ({}))
      return send(res, 200, { ok: true, threads: [{ id: st.sessionId || 'session', title: CWD, messageCount: st.messageCount ?? 0, pending: !!st.isStreaming }] })
    }
    if (url.pathname === '/api/transcript') {
      const st = await rpc.command('get_messages', {}, 10000).catch(() => ({ messages: [] }))
      return send(res, 200, { ok: true, messages: st.messages || [] })
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const body = await readBody(req)
      const text = typeof body.text === 'string' ? body.text : (typeof body.message === 'string' ? body.message : '')
      if (text === '') return send(res, 400, { ok: false, error: 'text 不能为空' })

      // ⚠️ 前端（bridge/web/public/index.html 的 send()）读的是 **NDJSON 流**，逐行 {kind:...}：
      //    meta → 设 threadId；text → addAgentChunk；activity → addActivity；
      //    其它 → 忽略；流结束即认为本轮完成。
      // 之前返回一次性 JSON：前端拿不到 kind，三个分支全不匹配 → 界面「聊天没反应」（P4.26 事故）。
      const threadId = 'pi-' + String(rpc.child.pid || 'session')
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
      res.write(JSON.stringify({ kind: 'meta', threadId }) + '\n')

      let finished = false
      let off = () => {}
      let timer = null
      const finish = () => {
        if (finished) return
        finished = true
        try { off() } catch { /* 已解绑 */ }
        if (timer !== null) clearTimeout(timer)
        try { res.write(JSON.stringify({ kind: 'end' }) + '\n') } catch { /* 客户端已断开 */ }
        try { res.end() } catch { /* 同上 */ }
      }

      // 实测 Pi 的事件：message_update.assistantMessageEvent = { type:'text_delta', delta:'…' }
      // 结束信号用 agent_settled（比 agent_end 更晚，aborted 字段也在其中）。
      off = rpc.onEvent((rec) => {
        if (rec.type === 'message_update') {
          const ev = rec.assistantMessageEvent || {}
          if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta !== '') {
            try { res.write(JSON.stringify({ kind: 'text', text: ev.delta }) + '\n') } catch { /* 断开 */ }
          }
          return
        }
        if (rec.type === 'agent_settled' || rec.type === 'agent_end') finish()
      })
      timer = setTimeout(finish, 180000)
      req.on('close', () => { if (!finished) { finished = true; try { off() } catch { /**/ } if (timer !== null) clearTimeout(timer) } })

      try {
        await rpc.command('prompt', { message: text }, 30000)
      } catch (e) {
        try { res.write(JSON.stringify({ kind: 'text', text: `[发送失败] ${e && e.message ? e.message : e}` }) + '\n') } catch { /* 断开 */ }
        finish()
      }
      return
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      await rpc.command('abort', {}, 30000).catch(() => null)
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { ok: false, error: `未知端点 ${url.pathname}` })
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
})
server.listen(PORT, HOST, () => log(`[pi-bridge] 就绪 http://${HOST}:${PORT}`))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { rpc.kill(); server.close(() => process.exit(0)) })

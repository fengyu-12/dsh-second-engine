// src/pi-panel.js —— Pi 面板 / 渠道 / 桥 / 清理路由（2026-11-03 拆出）
// import 头由主控预置，Pi 只负责追加函数体。
import { errMsg, loadKeyring, piHasProvider, piProvidersBag, readPiJson, resolvePiProvider, sendPiWriteError, PI_PROVIDER_ID_RE, PI_CHANNEL_APIS, MCP_NAME_PATTERN } from './index.js'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PI_MODELS_PATH, PI_PROVIDERS, invalidatePiModelsCache, piAvailableModels } from './engine/pi-probe.js'
import { piBridgeStatus, piBridgeUrl, startPiBridge, stopPiBridge } from './engine/pi-bridge.js'
import { piMcpServers, piWriteJson } from './pi-providers.js'
import { readBody } from './io.js'
import { send } from './core.js'
import { countPiJsonl, writePiMcp, engineGateFor } from './index.js'


export async function handlePiPanel(_req, res) {
  try {
    // 提供方：以 keyring 为准 —— Pi 的 key 由 rtOf/pi-env 从 keyring 注入，
    // 插件进程自身的 env 未必带；env 只作补充，避免「明明配了却显示未配」。
    const krById = new Map()
    try {
      const doc = loadKeyring()
      for (const p of doc.providers) {
        if (typeof p.id === 'string' && (p.apiKey || p.key)) krById.set(p.id, p)
      }
    } catch { /* 读不到 keyring 就当作全没配，不编数 */ }
    const models = await piAvailableModels().catch(() => null)
    const modelIds = Array.isArray(models) ? models.map((m) => m && m.id).filter(Boolean) : []
    const activePi = resolvePiProvider()
    const providers = PI_PROVIDERS.map((id) => {
      const env = `${id.toUpperCase()}_API_KEY`
      const hit = krById.get(id)
      return {
        id,
        label: (hit && hit.name) || id,
        hasKey: Boolean(hit) || Boolean(process.env[env]),
        keyEnv: env,
        // Pi 自报的清单只对当前生效 provider 有效；其余报 0，不把数字张冠李戴。
        modelCount: activePi !== null && activePi.id === id ? modelIds.length : 0,
      }
    })

    // MCP：Pi 读 ~/.pi/agent/mcp.json（docs/mcp.md:32），与 Codex 的 config.toml 无关。
    const mcpPath = join(homedir(), '.pi', 'agent', 'mcp.json')
    const mcpExists = existsSync(mcpPath)
    let mcpServers = []
    if (mcpExists) {
      try {
        const doc = JSON.parse(readFileSync(mcpPath, 'utf8'))
        const bag = (doc && (doc.mcpServers || doc.servers)) || {}
        mcpServers = Object.keys(bag).map((name) => {
          const one = bag[name] || {}
          return { name, type: one.type || one.transport || 'unknown' }
        })
      } catch { mcpServers = [] }
    }

    // 聊天桥：Pi 用自建 bridge（8788），不是 Codex 的 ctl.sh。
    const bridgeStatus = await piBridgeStatus()
    const bridge = {
      port: bridgeStatus.port,
      running: bridgeStatus.running,
      url: bridgeStatus.running ? piBridgeUrl() : null,
    }

    // 会话：Pi 存 ~/.pi/agent/sessions/<cwd 分组>/*.jsonl（docs/sessions.md:50），按目录递归统计。
    const sessRoot = join(homedir(), '.pi', 'agent', 'sessions')
    let sessTotal = { count: 0, sizeBytes: 0 }
    try {
      for (const entry of readdirSync(sessRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const one = countPiJsonl(join(sessRoot, entry.name))
        sessTotal = { count: sessTotal.count + one.count, sizeBytes: sessTotal.sizeBytes + one.sizeBytes }
      }
    } catch { /* 不存在 = 0 */ }

    // 模型渠道：Pi 的自定义 provider 落 ~/.pi/agent/models.json（与 PiHub 同位置）。
    // 渠道除了 id 还要给 baseUrl/api/models —— 前端「设为当前模型」需要具体 model id，
    // 只给 id 的话下拉里没东西可点（第一版就是这么漏的）。
    const channels = { path: PI_MODELS_PATH, exists: existsSync(PI_MODELS_PATH), ids: [], list: [] }
    if (channels.exists) {
      try {
        const doc = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'))
        const bag = doc !== null && typeof doc === 'object' ? doc.providers : null
        if (bag !== null && typeof bag === 'object') {
          for (const cid of Object.keys(bag)) {
            const one = bag[cid] !== null && typeof bag[cid] === 'object' ? bag[cid] : {}
            const mids = Array.isArray(one.models)
              ? one.models.map((m) => (typeof m === 'string' ? m : (m !== null && typeof m === 'object' ? m.id : ''))).filter((x) => typeof x === 'string' && x !== '')
              : []
            channels.ids.push(cid)
            channels.list.push({ id: cid, name: typeof one.name === 'string' ? one.name : cid, baseUrl: typeof one.baseUrl === 'string' ? one.baseUrl : '', api: typeof one.api === 'string' ? one.api : '', models: mids, hasApiKey: typeof one.apiKey === 'string' && one.apiKey !== '' })
          }
        }
      } catch { channels.ids = []; channels.list = [] }
    }

    // 默认模型：Pi 的 settings.json（docs/settings.md:13-14 的 defaultProvider/defaultModel）。
    // 本机此前没有这个文件 → Pi 走 Automatic，落到列表里较前的 deepseek-v4-pro（用户实测报「每次都是 pro」）。
    const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json')
    const piSettings = { path: settingsPath, exists: existsSync(settingsPath), defaultProvider: '', defaultModel: '' }
    if (piSettings.exists) {
      try {
        const doc = JSON.parse(readFileSync(settingsPath, 'utf8'))
        if (doc !== null && typeof doc === 'object') {
          if (typeof doc.defaultProvider === 'string') piSettings.defaultProvider = doc.defaultProvider
          if (typeof doc.defaultModel === 'string') piSettings.defaultModel = doc.defaultModel
        }
      } catch { /* 坏 JSON 就报空值，不猜也不修 */ }
    }

    send(res, {
      ok: true,
      providers,
      mcp: { path: mcpPath, exists: mcpExists, servers: mcpServers },
      bridge,
      sessions: { dir: sessRoot, exists: existsSync(sessRoot), count: sessTotal.count, sizeBytes: sessTotal.sizeBytes },
      channels,
      settings: piSettings,
      model: activePi,
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiChannelCreate(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!PI_PROVIDER_ID_RE.test(id)) {
      send(res, { ok: false, error: 'id 只能用字母/数字/连字符/下划线（首字符不能是符号），最长 40 位' }, 400)
      return
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
      send(res, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头' }, 400)
      return
    }
    const api = typeof body.api === 'string' && body.api.trim() !== '' ? body.api.trim() : 'openai-completions'
    if (!PI_CHANNEL_APIS.has(api)) {
      send(res, { ok: false, error: `api 只能是：${[...PI_CHANNEL_APIS].join(' / ')}` }, 400)
      return
    }
    const modelsRaw = Array.isArray(body.models) ? body.models : []
    const models = []
    for (const one of modelsRaw) {
      const mid = typeof one === 'string' ? one.trim() : (one !== null && typeof one === 'object' && typeof one.id === 'string' ? one.id.trim() : '')
      if (mid !== '' && !models.some((m) => m.id === mid)) models.push({ id: mid })
    }
    if (models.length === 0) {
      send(res, { ok: false, error: '至少要给一个模型 id' }, 400)
      return
    }

    // 读-改-写：保留文件里其它 provider 与未知字段（该文件用户可能手改过，不许整份覆盖）。
    // 整段已搬进锁内：基线读取、其它 provider 的保留、apiKey 沿用均以**当前最新**那份为准。
    const entry = { baseUrl, api, models }
    if (typeof body.name === 'string' && body.name.trim() !== '') entry.name = body.name.trim()
    if (models.length === 0) {
      send(res, { ok: false, error: 'models 不能为空：至少给一个模型 id（空 models 会让 pi 报 Unknown provider）' }, 400)
      return
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    await piWriteJson(PI_MODELS_PATH, (doc) => {
      const bag = piProvidersBag(doc)   // D1：null 原型 + 一律 hasOwnProperty 判存在
      const prev = piHasProvider(bag, id) ? bag[id] : undefined
      // 留空 = 沿用已有 key（编辑场景）或走 $ENV 插值（新建场景），不把空串写进文件。
      if (apiKey !== '') entry.apiKey = apiKey
      else if (prev !== null && typeof prev === 'object' && prev.apiKey !== undefined) entry.apiKey = prev.apiKey
      bag[id] = entry
      return doc
    })
    send(res, { ok: true, id, providers: Object.keys(readPiJson(PI_MODELS_PATH).providers || {}), hasApiKey: entry.apiKey !== undefined })
  } catch (e) { sendPiWriteError(res, e) }
}

export async function handlePiModelSet(req, res) {
  try {
    const body = await readBody(req)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (provider === '' || model === '') {
      send(res, { ok: false, error: 'provider 和 model 都不能为空' }, 400)
      return
    }
    if (!PI_PROVIDERS.includes(provider) && !PI_PROVIDER_ID_RE.test(provider)) {
      send(res, { ok: false, error: 'provider 不合法' }, 400)
      return
    }
    const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json')
    // 整段进锁（与 provider/model 写入口共用同一把 settings.json 锁）：
    // 旧版这里用 `${settingsPath}.tmp-${process.pid}` 与 writePiJson 的临时文件**同进程必撞名**。
    await piWriteJson(settingsPath, (doc) => {
      doc.defaultProvider = provider
      doc.defaultModel = model
      return doc
    })

    send(res, { ok: true, provider, model, note: '对新建会话生效；已在跑的会话不受影响' })
  } catch (e) { sendPiWriteError(res, e) }
}

export async function handlePiBridge(req, res) {
  try {
    const body = await readBody(req)
    const result = body.action === 'stop' ? await stopPiBridge() : await startPiBridge()
    send(res, result, result.ok ? 200 : 500)
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiCleanup(req, res) {
  try {
    // D8-① 对称门禁：Codex 激活时不该能清 Pi 的会话（两个方向的跨引擎误删都挡）。
    const gate = engineGateFor('pi')
    if (gate !== null) { send(res, { ok: false, ...gate }, 409); return }
    const body = await readBody(req)
    if (body.confirm !== true) {
      send(res, { ok: false, error: '需要 confirm:true 才执行（不可撤销）' }, 400)
      return
    }
    // D8-②（2026-10-29）：旧版无条件全删（`walk` 里连 mtime 都不看），而 Codex 那条
    // 支持 keepDays —— 同一个「清理」按钮在两个引擎下语义不同，用户以为在「清 30 天前的」，
    // 实际把当天会话也删了。现在两边一致：keepDays 按 mtime 过滤；**未传仍保持全删**
    // （旧调用方行为不变），但响应里用 keepDays:null + note 明说这次没按天过滤。
    let keepDays = null
    if (body.keepDays !== undefined && body.keepDays !== null && body.keepDays !== '') {
      const n = Number(body.keepDays)
      if (!Number.isFinite(n) || n < 0) {
        send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
        return
      }
      keepDays = n
    }
    const cutoff = keepDays === null ? Infinity : Date.now() - keepDays * 24 * 60 * 60 * 1000
    const sessRoot = join(homedir(), '.pi', 'agent', 'sessions')
    let removed = 0
    let freedBytes = 0
    let kept = 0
    const walk = (dir) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.jsonl')) continue
        try {
          const st = statSync(full)
          // mtime 晚于 cutoff = 还在保留窗口内 → 留。keepDays 为 null 时 cutoff=Infinity，
          // 任何 mtime 都 < Infinity，等价旧行为（全删）。
          if (st.mtimeMs >= cutoff) { kept += 1; continue }
          unlinkSync(full)
          removed += 1
          freedBytes += st.size
        } catch { /* 单个文件失败不阻断整体 */ }
      }
    }
    walk(sessRoot)
    send(res, {
      ok: true, removed, freedBytes, kept, keepDays,
      note: keepDays === null ? '本次未按天过滤，删除了全部会话记录' : `已保留 ${keepDays} 天内的会话`,
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiChannelDelete(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') { send(res, { ok: false, error: '缺少 id' }, 400); return }
    if (!existsSync(PI_MODELS_PATH)) { send(res, { ok: false, error: `${PI_MODELS_PATH} 不存在，无可删` }, 404); return }
    // 同上：整段进锁，不再用锁外 JSON.parse + `${path}.tmp-${pid}`（同进程名字必撞）。
    const out = await piWriteJson(PI_MODELS_PATH, (doc) => {
      const bag = piProvidersBag(doc)   // D1：null 原型 + 一律 hasOwnProperty 判存在
      if (doc.providers === null || typeof doc.providers !== 'object') {
        return { __piAbort: { status: 409, error: 'models.json 结构不对，已中止（未改动文件）' } }
      }
      if (!piHasProvider(bag, id)) return { __piAbort: { status: 404, error: `没有渠道 ${id}` } }
      delete bag[id]
      return doc
    })
    if (out.__piAbort !== undefined) { send(res, { ok: false, error: out.__piAbort.error }, out.__piAbort.status); return }
    invalidatePiModelsCache()
    send(res, { ok: true, id, providers: Object.keys(readPiJson(PI_MODELS_PATH).providers || {}) })
  } catch (e) { sendPiWriteError(res, e) }
}

export function handlePiMcpList(_req, res) {
  try { send(res, { ok: true, servers: piMcpServers() }) }
  catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiMcpAdd(req, res) {
  try {
    const body = await readBody(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (name === '') { send(res, { ok: false, error: 'name 不能为空' }, 400); return }
    if (!MCP_NAME_PATTERN.test(name)) {
      send(res, { ok: false, error: 'name 只允许字母、数字、下划线和连字符' }, 400)
      return
    }
    if (!/^https?:\/\//.test(url)) {
      send(res, { ok: false, error: 'url 必须以 http:// 或 https:// 开头' }, 400)
      return
    }
    // 查重进锁：锁外 readPiMcp 判「不存在」→ 两个并发 add 都放行，后者静默覆盖前者。
    await writePiMcp((doc) => {
      if (Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) {
        return { __piAbort: { status: 409, error: `已存在同名 MCP 服务器 '${name}'` } }
      }
      doc.mcpServers[name] = { url }
      return doc
    })
    send(res, { ok: true, servers: piMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiMcpDelete(res, name) {
  try {
    if (name === '') { send(res, { ok: false, error: `未找到 MCP 服务器 '${name}'` }, 404); return }
    await writePiMcp((doc) => {
      if (!Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) {
        return { __piAbort: { status: 404, error: `未找到 MCP 服务器 '${name}'` } }
      }
      delete doc.mcpServers[name]
      return doc
    })
    send(res, { ok: true, servers: piMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handlePiMcpToggle(req, res, name) {
  try {
    const body = await readBody(req)
    const enabled = body.enabled === true
    await writePiMcp((doc) => {
      const one = Object.prototype.hasOwnProperty.call(doc.mcpServers, name) ? doc.mcpServers[name] : undefined
      if (one === undefined) return { __piAbort: { status: 404, error: `未找到 MCP 服务器 '${name}'` } }
      const entry = one !== null && typeof one === 'object' ? one : {}
      entry.enabled = enabled
      doc.mcpServers[name] = entry
      return doc
    })
    send(res, { ok: true, servers: piMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

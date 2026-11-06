
import { CODEX_DIR, CONFIG_PATH, WIRE_API } from './constants.js'
import { ERR_LOG, noteErr, send, CODEX_WIRE_OPTIONS, DEFAULT_ACTIVE, PRESET_IDS, PROTECTED_IDS, errMsg, invalidIdError, sessionsBytesCached, wireApiError } from './core.js'
import { activeEngineId } from './engine/registry.js'
import { loadClaudeProviders, handleClaudeProvider } from './claude-providers.js'
import { readBody, saveKeyring } from './io.js'
import { keyConfigured } from './pi-misc.js'
import { piProviderActive, piProviderDelete, piProviderKey, piProviderUpdate, piProvidersRoot } from './pi-providers.js'
import { resolveCodexBinary } from './review-core.js'
import { existsSync } from 'node:fs'
import { collabStatus, engineView, loadKeyring, maskKey, providerView, writeCodexConfig } from './index.js'

export async function handleStatus(_req, res) {
  try {
    send(res, {
      ok: true,
      codexBinary: existsSync(resolveCodexBinary()),
      // 实际解析到的路径（与 spawn 同一来源）：排查「灯是绿的、跑的却是另一个二进制」。
      codexBinaryPath: resolveCodexBinary(),
      configExists: existsSync(CONFIG_PATH),
      keyConfigured: keyConfigured(),
      sessionsBytes: sessionsBytesCached(),
      // D（2026-10-25）：最近 10 条吞错留痕（已脱敏）——「配置没写进去」类问题从这里查。
      lastErrors: ERR_LOG.slice(-10),
      // 协作两位 + 派生预设（主 AI 派单前查这里；preset 派生点在 collabPreset）。
      collab: collabStatus(),
      // P4.3/P4.5：当前引擎 + 能力 + 探测 + 实际模型（面板据此条件渲染）。
      engine: await engineView(),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleExperimentalWake(ctx, req, res) {
  let body = {}
  let handle
  try {
    body = await readBody(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const text = typeof body?.text === 'string' ? body.text : ''
    if (sessionId === '' || text.trim() === '') {
      send(res, { ok: false, resumed: null, live: null, error: 'sessionId 和 text 都不能为空' }, 400)
      return
    }

    const agents = ctx.get('agents')
    if (agents === undefined || agents === null) {
      send(res, { ok: false, resumed: null, live: null, error: 'agents 服务不可用' })
      return
    }

    let createUserMessage
    let SessionId
    try {
      const llm = await import('@deepseek-ai/dsh-llm')
      const session = await import('@deepseek-ai/dsh-session')
      createUserMessage = llm.createUserMessage
      SessionId = session.SessionId
    } catch (e) {
      send(res, { ok: false, resumed: null, live: null, error: `唤醒依赖不可用: ${errMsg(e)}` })
      return
    }
    if (typeof createUserMessage !== 'function') {
      send(res, { ok: false, resumed: null, live: null, error: '唤醒依赖不可用: createUserMessage 不可用' })
      return
    }

    // SessionId 是 dsh-session 的类型/运行时导出（按包版本可能不存在）；字符串 ID 直接交给 agents。
    void SessionId
    // 会话 id 需要 DSH 的 `session-<uuid>` 形态；裸 uuid 会 not found。
    const resolvedId = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
    const liveAgent = agents.get(resolvedId)
    // ⚠ agentOptions 必须是 **DSH 侧**的 provider，不能用 Codex keyring 的 provider id
    // （实测：传 ziluo 会让回合 fail 在 NO_ADAPTER）。默认不传 = 用会话自身日志里的 config。
    let options
    if (typeof body?.provider === 'string' && body.provider.trim() !== '' &&
        typeof body?.model === 'string' && body.model.trim() !== '') {
      options = { provider: body.provider.trim(), model: body.model.trim() }
    }
    if (liveAgent === undefined) {
      handle = await agents.resume({ resumeSessionId: resolvedId, ...(options ? { agentOptions: options } : {}) })
    }
    const agent = liveAgent ?? handle?.agent
    if (agent === undefined || agent === null) throw new Error('agents 未返回可用 agent')
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await idle
    send(res, { ok: true, resumed: liveAgent === undefined ? true : null, live: liveAgent !== undefined ? true : null, error: null })
  } catch (e) {
    send(res, { ok: false, resumed: null, live: null, error: errMsg(e) })
  } finally {
    try { await handle?.dispose() } catch (e) { noteErr('exp-wake-dispose', e) }
  }
}

export async function handleKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!PRESET_IDS.has(id)) {
      return send(res, { ok: false, error: 'provider 必须是 deepseek 或 zhipu' }, 400)
    }
    if (key === '') {
      return send(res, { ok: false, error: 'key 不能为空' }, 400)
    }
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    }
    target.apiKey = key
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(key) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProvidersList(_req, res) {
  try {
    if (activeEngineId() === 'claude') {
      // Claude 用自己的 provider 配置（Anthropic 协议端点），不是 Codex 的 keyring。
      const doc = loadClaudeProviders()
      // 形状必须与 providerView 一致：前端读 p.apiKey.configured / p.apiKey.preview，
      // 给 hasKey 布尔值会导致「填了 Key 仍显示未配置」（2026-11-05 实机确认）。
      const view = (doc.providers || []).map((x) => {
        const raw = typeof x.apiKey === 'string' ? x.apiKey.trim() : ''
        const configured = raw !== ''
        return {
          id: x.id, name: x.name, baseUrl: x.baseUrl, model: x.model || '',
          wireApi: x.wireApi || 'anthropic',
          apiKey: { configured, preview: configured ? maskKey(raw) : '' },
        }
      })
      return send(res, { ok: true, active: doc.active, providers: view, wireApiOptions: [{ value: 'anthropic', label: 'anthropic（Claude 原生）', bridged: false }] })
    }
    const doc = loadKeyring()
    send(res, { ok: true, active: doc.active, providers: doc.providers.map(providerView), wireApiOptions: CODEX_WIRE_OPTIONS })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProviderAdd(req, res) {
  if (activeEngineId() === 'claude') return handleClaudeProvider('add', req, res, { readBody, send, errMsg })
  // Codex 分支（wireApi 只认 responses/completions）
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

    const idErr = invalidIdError(id)
    if (idErr !== null) return send(res, { ok: false, error: idErr }, 400)
    const wireErr = wireApiError(body.wireApi)
    if (wireErr !== null) return send(res, { ok: false, error: wireErr }, 400)
    if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
    if (baseUrl === '') return send(res, { ok: false, error: 'baseUrl 不能为空' }, 400)

    const doc = loadKeyring()
    if (doc.providers.some((p) => p.id === id)) {
      return send(res, { ok: false, error: `提供方 '${id}' 已存在` }, 400)
    }
    const wireApi = typeof body.wireApi === 'string' && body.wireApi !== '' ? body.wireApi : WIRE_API
    const provider = { id, name, baseUrl, wireApi, model, apiKey }
    doc.providers.push(provider)
    saveKeyring(doc)
    send(res, { ok: true, active: doc.active, provider: providerView(provider) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProvidersRoot(req, res) {
  if (activeEngineId() === 'pi') return piProvidersRoot(req, res)
  if (req.method === 'POST') return handleProviderAdd(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleProvidersList(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

export async function handleProviderKey(req, res) {
  if (activeEngineId() === 'pi') return piProviderKey(req, res)
  if (activeEngineId() === 'claude') return handleClaudeProvider('key', req, res, { readBody, send, errMsg })
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    target.apiKey = apiKey
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(apiKey) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProviderActive(req, res) {
  if (activeEngineId() === 'claude') return handleClaudeProvider('active', req, res, { readBody, send, errMsg })
  if (activeEngineId() === 'pi') return piProviderActive(req, res)
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    // 先落 keyring，config 重写失败时回滚 active：避免「active 已持久化、
    // config.toml 还指着旧提供方」的两处不一致（对账 tick 只自愈桥，不自愈直连配置）。
    const previousActive = doc.active
    doc.active = id
    saveKeyring(doc)
    let envKey = ''
    try {
      envKey = await writeCodexConfig(target)
    } catch (e) {
      doc.active = previousActive
      try { saveKeyring(doc) } catch { /* 回滚失败：用户重试兜底 */ }
      throw e
    }
    send(res, { ok: true, active: id, configPath: CONFIG_PATH, backupDir: CODEX_DIR, envKey })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProviderDelete(req, res) {
  if (activeEngineId() === 'claude') return handleClaudeProvider('delete', req, res, { readBody, send, errMsg })
  if (activeEngineId() === 'pi') return piProviderDelete(req, res)
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (PROTECTED_IDS.has(id)) {
      return send(res, { ok: false, error: `核心默认提供方 '${id}' 不允许删除（自定义提供方均可删）` }, 400)
    }
    const doc = loadKeyring()
    const index = doc.providers.findIndex((p) => p.id === id)
    if (index === -1) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    doc.providers.splice(index, 1)
    let configRegenerated = false
    let fallback = null
    if (doc.active === id) {
      doc.active = DEFAULT_ACTIVE
      fallback = doc.providers.find((p) => p.id === DEFAULT_ACTIVE) ?? null
    }
    // 先落 keyring 再重写 config.toml：saveKeyring 一旦放到 await 之后，
    // 窗口期内其它 handler（如 /providers/key）落盘的修改会被这份旧 doc 整体覆盖（丢 key）。
    saveKeyring(doc)
    if (fallback !== null) {
      await writeCodexConfig(fallback)
      configRegenerated = true
    }
    send(res, { ok: true, active: doc.active, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleProviderUpdate(req, res) {
  if (activeEngineId() === 'claude') return handleClaudeProvider('update', req, res, { readBody, send, errMsg })
  if (activeEngineId() === 'pi') return piProviderUpdate(req, res)
  try {
    const body = await readBody(req)
    const ignored = Object.keys(body)
      .filter((key) => !['id', 'name', 'baseUrl', 'wireApi', 'model', 'apiKey'].includes(key))
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空', ignored }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'`, ignored }, 404)

    // 先把请求里出现过的字段全部校验完再落盘，避免校验失败后半更新。
    const patch = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return send(res, { ok: false, error: 'name 不能为空', ignored }, 400)
      patch.name = name
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
      if (!/^https?:\/\//i.test(baseUrl)) {
        return send(res, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头', ignored }, 400)
      }
      patch.baseUrl = baseUrl
    }
    if (body.wireApi !== undefined) {
      const wireApi = typeof body.wireApi === 'string' ? body.wireApi.trim() : ''
      const wireErr = wireApiError(wireApi)
      if (wireErr !== null) return send(res, { ok: false, error: wireErr, ignored }, 400)
      // 空串 = 未指定（与 wireApiError 的放行语义一致），不写进 patch：
      // 否则原为 completions 的提供方会被空串切成直连，错误还随 saveKeyring 固化。
      if (wireApi !== '') patch.wireApi = wireApi
    }
    if (body.model !== undefined) {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') return send(res, { ok: false, error: 'model 不能为空', ignored }, 400)
      patch.model = model
    }
    // apiKey 省略 = 保持原值；显式传空串属于误用（不修改就不该带这个字段）。
    if (body.apiKey !== undefined) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空（不修改请省略该字段）', ignored }, 400)
      patch.apiKey = apiKey
    }

    // updated 只列真正发生变化的字段；空数组 = 提交值与现值完全一致，不落盘。
    const updated = []
    for (const key of Object.keys(patch)) {
      if (target[key] !== patch[key]) {
        target[key] = patch[key]
        updated.push(key)
      }
    }
    if (updated.length > 0) saveKeyring(doc)

    let configRegenerated = false
    if (doc.active === id && (updated.includes('baseUrl') || updated.includes('wireApi') || updated.includes('model'))) {
      await writeCodexConfig(target)
      configRegenerated = true
    }
    send(res, { ok: true, id, updated, ignored, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

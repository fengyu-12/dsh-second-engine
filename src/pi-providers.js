// src/pi-providers.js —— Pi 自定义渠道的读写与快照（2026-11-03 拆出）
// 只放函数体；import 头由主控预置，Pi 只负责追加函数体。
import { chmodSync, copyFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extractModels } from './parse.js'
import { invalidatePiModelsCache, piAvailableModels } from './engine/pi-probe.js'
import { prunePiBackups } from './cleanup.js'
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

import { piHasProvider, piProvidersBag, readPiJson, readPiJsonStrict, readPiModelMemory, resolvePiProvider, sendPiWriteError, readPiMcp, modelsUrl, bigmodelAuxModelsUrl, rememberPiModel, PI_API_SET, PI_SETTINGS_PATH, PI_WIRE_OPTIONS, PI_WRITE_QUEUES, PI_PROVIDER_ID_RE, PI_PROVIDER_ID_BLOCKED, PI_MCP_PATH, errMsg, send } from './core.js'
import { PI_MODELS_PATH, PI_PROVIDERS } from './engine/pi-probe.js'
import { PI_BRIDGE_PORT } from './engine/pi-bridge.js'
import { readBody } from './io.js'

// ===== 以下 12 个函数自 src/index.js 拆出（按原行号顺序），供 pi 渠道读写复用 =====

// --- 来自 src/index.js（段 1/12）---
export async function piRuntimeModel() {
  try {
    const headers = process.env.PI_BRIDGE_TOKEN ? { 'x-bridge-token': process.env.PI_BRIDGE_TOKEN } : undefined
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 900)
    const r = await fetch(`http://127.0.0.1:${PI_BRIDGE_PORT}/api/runtime-settings`, { headers, signal: ctl.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const j = await r.json()
    if (j && j.engine === 'pi' && typeof j.model === 'string' && j.model !== '') {
      return { providerId: typeof j.provider === 'string' ? j.provider : '', model: j.model, fallback: false, source: 'runtime' }
    }
    return null
  } catch { return null }
}

// --- 来自 src/index.js（段 2/12）---
export function piWithPathLock(path, fn) {
  const prev = PI_WRITE_QUEUES.get(path) || Promise.resolve()
  // 前一个任务无论成败都要放行下一个 —— 失败不能让队列永久卡死。
  const run = prev.then(fn, fn)
  PI_WRITE_QUEUES.set(path, run.then(() => undefined, () => undefined))
  return run
}

// --- 来自 src/index.js（段 3/12）---
export function piWriteJson(path, mutate) {
  return piWithPathLock(path, () => {
    const doc = readPiJsonStrict(path)
    const next = mutate(doc)
    if (next !== null && typeof next === 'object' && next.__piAbort !== undefined) return next
    const out = JSON.stringify(next, null, 2)
    // 内容没变 → 不写、不备份、不作废缓存（连续两次「设为当前」不再刷出一串同内容 .bak）。
    let unchanged = false
    if (existsSync(path)) {
      try { unchanged = readFileSync(path, 'utf8') === out } catch { unchanged = false }
    }
    if (!unchanged) {
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path)) {
        try {
          copyFileSync(path, `${path}.bak-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`)
          prunePiBackups(path)
        } catch { /* 备份失败不阻断写入 */ }
      }
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
      writeFileSync(tmp, out, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      try {
        renameSync(tmp, path)
      } catch (e) {
        try { unlinkSync(tmp) } catch { /* best effort */ }
        throw e
      }
    }
    invalidatePiModelsCache()
    return { __piOk: true, unchanged }
  })
}

// --- 来自 src/index.js（段 4/12）---
export function piApiFromWire(wire) {
  if (PI_API_SET.has(wire)) return wire
  return wire === 'responses' ? 'openai-responses' : 'openai-completions'
}

// --- 来自 src/index.js（段 5/12）---
export function piWireFromApi(api) {
  return api === 'openai-responses' ? 'responses' : 'chat'
}

// --- 来自 src/index.js（段 6/12）---
export function piLooksLikeApiKey(v) {
  return typeof v === 'string' && /^[A-Za-z0-9]{16,}\.[A-Za-z0-9]{10,}$/.test(v)
}

// --- 来自 src/index.js（段 7/12）---
export function piRejectKeyAsModel(value) {
  return piLooksLikeApiKey(value)
    ? '这看起来是 API Key，不是模型名 —— Key 请填在「API Key」字段（留空=不改）'
    : ''
}

// --- 来自 src/index.js（段 8/12）---
export function piProvidersSnapshot() {
  const modelsDoc = readPiJson(PI_MODELS_PATH)
  const bag = modelsDoc.providers !== null && typeof modelsDoc.providers === 'object' ? modelsDoc.providers : {}
  const settings = readPiJson(PI_SETTINGS_PATH)
  const active = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : ''
  const curModel = typeof settings.defaultModel === 'string' ? settings.defaultModel : ''
  const kr = resolvePiProvider()
  // 每行显示「该提供方自己的当前模型」：激活的用 settings 的 current，其余优先用记忆值，
  // 没记忆才退回默认。旧写法非激活行给空串 / models[0]，于是 DeepSeek 显示"未设模型"、
  // 智谱显示 models.json 里的第一个（不是用户选过的那个）。
  const mem = readPiModelMemory()
  // 内置 deepseek 可能与 models.json 里的 providers.deepseek 同时存在：
  // 后者是我们自己写 key/baseUrl 的落点（piProviderKey 就写这儿）。
  // 若不合并，面板会出现两条 DeepSeek（用户实测），必须并进内置行、且遍历时跳过。
  const builtin = bag.deepseek !== null && typeof bag.deepseek === 'object' ? bag.deepseek : {}
  const builtinKey = typeof builtin.apiKey === 'string' ? builtin.apiKey : ''
  const providers = [{
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: typeof builtin.baseUrl === 'string' && builtin.baseUrl !== '' ? builtin.baseUrl : 'https://api.deepseek.com',
    model: active === 'deepseek' ? curModel : (typeof mem.deepseek === 'string' && mem.deepseek !== '' ? mem.deepseek : 'deepseek-flash'),
    apiKey: {
      configured: (kr !== null && kr.id === 'deepseek') || builtinKey !== '' || Boolean(process.env.DEEPSEEK_API_KEY),
      preview: builtinKey !== '' ? '已配置' : '',
    },
  }]
  for (const cid of Object.keys(bag)) {
    if (cid === 'deepseek') continue
    const one = bag[cid] !== null && typeof bag[cid] === 'object' ? bag[cid] : {}
    const key = typeof one.apiKey === 'string' ? one.apiKey : ''
    providers.push({
      id: cid,
      name: typeof one.name === 'string' && one.name !== '' ? one.name : cid,
      baseUrl: typeof one.baseUrl === 'string' ? one.baseUrl : '',
      // 非激活渠道显示它自己的第一个模型（不是空）：编辑表单用它预填，
      // 预填空会让「随手点保存」把清单清掉（P4.19 真实事故）。
      model: active === cid ? curModel : (typeof mem[cid] === 'string' && mem[cid] !== ''
        ? mem[cid]
        : (Array.isArray(one.models) && one.models.length > 0
          ? String((typeof one.models[0] === 'string' ? one.models[0] : (one.models[0] && one.models[0].id)) || '')
          : '')),
      apiKey: { configured: key !== '', preview: key === '' ? '' : '已配置' },
    })
  }
  return { providers, active, channels: bag, modelsDoc, settings }
}

// --- 来自 src/index.js（段 9/12）---
export function piChannelApiOf(id, snap) {
  const one = Object.prototype.hasOwnProperty.call(snap.channels, id) && snap.channels[id] !== null && typeof snap.channels[id] === 'object' ? snap.channels[id] : {}
  return { one, api: typeof one.api === 'string' ? one.api : 'openai-completions' }
}

// --- 来自 src/index.js（段 10/12）---
export async function piProvidersList(_req, res) {
  try {
    const snap = piProvidersSnapshot()
    send(res, { ok: true, active: snap.active, providers: snap.providers, wireApiOptions: PI_WIRE_OPTIONS })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// --- 来自 src/index.js（段 11/12）---
export async function piProviderAdd(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!PI_PROVIDER_ID_RE.test(id)) {
      send(res, { ok: false, error: '提供方 id 只能用字母/数字/连字符/下划线（首字符不能是符号）' }, 400)
      return
    }
    if (id === 'deepseek') {
      send(res, { ok: false, error: 'deepseek 是内置预设，不能重复添加；要改模型请编辑该行' }, 409)
      return
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    // 只要求 baseUrl：知道地址就能先建渠道，模型留空 → 展开该行填 Key →
    // 点「获取模型列表」从远端拉再选。强制先填模型名等于逼用户背服务商的模型 id。
    if (baseUrl === '') {
      send(res, { ok: false, error: 'baseUrl 必填（模型可留空，建好后点「获取模型列表」选）' }, 400)
      return
    }
    const keyAsModel = piRejectKeyAsModel(model)
    if (keyAsModel !== '') {
      send(res, { ok: false, error: keyAsModel }, 400)
      return
    }
    // 查重交给锁内闭包（见下），这里不再用锁外读做准入判断。
    const entry = {
      name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : id,
      baseUrl,
      api: piApiFromWire(typeof body.wireApi === 'string' ? body.wireApi : 'openai-completions'),
      models: model !== '' ? [{ id: model }] : [],
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') entry.apiKey = body.apiKey.trim()
    // 锁内重读基线再查「已存在」：snap 是锁外快照，并发下拿它查重会误判/漏判。
    const out = await piWriteJson(PI_MODELS_PATH, (doc) => {
      const bag = piProvidersBag(doc)   // D1：null 原型 + 一律 hasOwnProperty 判存在
      if (piHasProvider(bag, id)) return { __piAbort: { status: 409, error: `提供方 ${id} 已存在` } }
      bag[id] = entry
      return doc
    })
    if (out.__piAbort !== undefined) { send(res, { ok: false, error: out.__piAbort.error }, out.__piAbort.status); return }
    send(res, { ok: true, id, providers: Object.keys(readPiJson(PI_MODELS_PATH).providers || {}) })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 来自 src/index.js（段 12/12）---
export function piProviderIdError(id) {
  if (id === '') return '缺少 id'
  if (!PI_PROVIDER_ID_RE.test(id)) return 'id 格式不合法（只允许字母数字开头，后接字母数字下划线连字符，最长 40）'
  if (PI_PROVIDER_ID_BLOCKED.includes(id)) return `id 「${id}」是保留名，不能作为提供方 id`
  return ''
}

// --- 追加自 src/index.js（段 1/9）---
export async function piProviderKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const idErr = piProviderIdError(id)
    if (idErr !== '') { send(res, { ok: false, error: idErr }, 400); return }
    if (apiKey === '') { send(res, { ok: false, error: 'apiKey 不能为空' }, 400); return }
    // 内置 deepseek 也写 models.json：Pi 支持用 models.json 覆盖原生 provider 的凭据，
    // 只写 apiKey 不写 models 时会保留内置模型清单（docs/custom-provider.md「Redirect an existing provider」）。
    const out = await piWriteJson(PI_MODELS_PATH, (doc) => {
      const bag = piProvidersBag(doc)   // D1：null 原型 + 一律 hasOwnProperty 判存在
      // 只允许给**已存在**的提供方补 Key：hasOwnProperty 判存在，继承键（constructor 等）不算，
      // 于是这条入口也不能再给不存在的 id 凭空写条目。
      if (!piHasProvider(bag, id) && id !== 'deepseek') {
        return { __piAbort: { status: 404, error: `没有提供方 ${id}` } }
      }
      const prevSrc = piHasProvider(bag, id) ? bag[id] : {}
      const prev = prevSrc !== null && typeof prevSrc === 'object' ? prevSrc : {}
      bag[id] = Object.assign(Object.create(null), prev, { apiKey })
      return doc
    })
    // 闭包里返回的 __piAbort 只是值，**不会**自己变成错误响应；漏了下面这行就会
    // 「中止了但照样回 200」，前端以为写成功了（本轮 D1 实测踩过一次，故写明）。
    if (out.__piAbort !== undefined) { send(res, { ok: false, error: out.__piAbort.error }, out.__piAbort.status); return }
    send(res, { ok: true, id, preview: '已配置' })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 追加自 src/index.js（段 2/9）---
export async function piProviderActive(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') { send(res, { ok: false, error: '缺少 id' }, 400); return }
    const snap = piProvidersSnapshot()
    // 写基线必须严格读：snap.settings 来自宽松读，坏 JSON 时是 {}，
    // 直接写回会把用户 settings.json 里其它键（不止 defaultProvider/Model）全丢掉（P0-3）。
    await piWriteJson(PI_SETTINGS_PATH, (settings) => {
      settings.defaultProvider = id
      // 切提供方时把 defaultModel 落到「该提供方上次选的模型」；没记忆才用默认。
      // 旧写法在 deepseek 分支只在 defaultModel 为空时才设，导致切回 deepseek 仍留着上一个厂商的模型。
      const mem = readPiModelMemory()
      const remembered = typeof mem[id] === 'string' ? mem[id].trim() : ''
      if (remembered !== '') {
        settings.defaultModel = remembered
      } else if (id === 'deepseek') {
        settings.defaultModel = 'deepseek-flash'
      } else {
        const one = Object.prototype.hasOwnProperty.call(snap.channels, id) && snap.channels[id] !== null && typeof snap.channels[id] === 'object' ? snap.channels[id] : {}
        const first = Array.isArray(one.models) && one.models.length > 0
          ? (typeof one.models[0] === 'string' ? one.models[0] : (one.models[0] && one.models[0].id))
          : ''
        if (typeof first === 'string' && first !== '') settings.defaultModel = first
      }
      return settings
    })
    const savedModel = readPiJson(PI_SETTINGS_PATH).defaultModel
    send(res, { ok: true, active: id, model: typeof savedModel === 'string' ? savedModel : '' })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 追加自 src/index.js（段 3/9）---
export async function piProviderDelete(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idErr = piProviderIdError(id)
    if (idErr !== '') { send(res, { ok: false, error: idErr }, 400); return }
    if (id === 'deepseek') {
      send(res, { ok: false, error: 'deepseek 是内置预设，不能删除' }, 400)
      return
    }
    // models.json 与 settings.json 是两把锁，不能合并成一次持锁（piWriteJson 只接一个 path），
    // 所以按**固定顺序**取锁（models → settings）：只有乱序才会死锁，固定序不会。
    const out = await piWriteJson(PI_MODELS_PATH, (doc) => {
      if (doc.providers !== null && typeof doc.providers === 'object') {
        const bag = piProvidersBag(doc)   // D1：null 原型 + 一律 hasOwnProperty 判存在
        if (!piHasProvider(bag, id)) return { __piAbort: { status: 404, error: `没有提供方 ${id}` } }
        delete bag[id]
      }
      return doc
    })
    if (out.__piAbort !== undefined) { send(res, { ok: false, error: out.__piAbort.error }, out.__piAbort.status); return }
    // 删掉的正好是当前激活的 → 回落到 deepseek，避免 settings 指向不存在的 provider。
    let fellBack = false
    if (readPiJsonStrict(PI_SETTINGS_PATH).defaultProvider === id) {
      await piWriteJson(PI_SETTINGS_PATH, (doc) => { doc.defaultProvider = 'deepseek'; return doc })
      fellBack = true
    }
    send(res, { ok: true, id, providers: Object.keys(readPiJson(PI_MODELS_PATH).providers || {}), fellBackToDefault: fellBack })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 追加自 src/index.js（段 4/9）---
export async function piProviderUpdate(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idErr = piProviderIdError(id)
    if (idErr !== '') { send(res, { ok: false, error: idErr }, 400); return }
    const snap = piProvidersSnapshot()
    if (id !== 'deepseek' && !Object.prototype.hasOwnProperty.call(snap.channels, id)) {
      send(res, { ok: false, error: `没有提供方 ${id}` }, 404)
      return
    }
    // 准入查重与字段合并全交给下面的锁内闭包：锁外 snap / 锁外 prev 与锁内基线
    // 可能已经不一致（并发建删/并发改同一 id），所以这里**不预读基线**，只校验入参。
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const keyAsModel = piRejectKeyAsModel(model)
    if (keyAsModel !== '') {
      send(res, { ok: false, error: keyAsModel }, 400)
      return
    }
    // （字段合并与内置无 models 的 P0-5 语义已挪进锁内闭包，见下）
    const out = await piWriteJson(PI_MODELS_PATH, (fresh) => {
      const bag = piProvidersBag(fresh)   // D1：null 原型 + 一律 hasOwnProperty 判存在
      if (id !== 'deepseek' && !piHasProvider(bag, id) && !PI_PROVIDERS.includes(id)) {
        return { __piAbort: { status: 404, error: `没有提供方 ${id}` } }
      }
      // prev 语义（内置无 models 不生成 models）以**锁内基线**为准，不用锁外那份 entry 直接顶：
      // 否则并发下会用旧 prev 把别人刚写的 models/apiKey 擦掉。
      const prevSrc = piHasProvider(bag, id) ? bag[id] : {}
      const prev = prevSrc !== null && typeof prevSrc === 'object' ? prevSrc : {}
      const merged = { ...prev }
      if (typeof body.name === 'string' && body.name.trim() !== '') merged.name = body.name.trim()
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') merged.baseUrl = body.baseUrl.trim()
      if (typeof body.wireApi === 'string' && body.wireApi !== '') merged.api = piApiFromWire(body.wireApi)
      if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') merged.apiKey = body.apiKey.trim()
      if (model !== '') {
        const existing = Array.isArray(prev.models)
          ? prev.models.map((m) => String((typeof m === 'string' ? m : (m && m.id)) || ''))
          : []
        const isBuiltin = PI_PROVIDERS.includes(id)
        const hasOwnModels = Array.isArray(prev.models)
        if (isBuiltin && !hasOwnModels) {
          // 保留覆盖层原样（可能只有 apiKey/baseUrl），不添加 models（紫东审查 P0-5）
        } else if (!existing.includes(model)) {
          merged.models = [{ id: model }]
        }
      }
      bag[id] = merged
      return fresh
    })
    if (out.__piAbort !== undefined) { send(res, { ok: false, error: out.__piAbort.error }, out.__piAbort.status); return }
    // 改了当前激活项的模型 → 同步 defaultModel，否则 Pi 还用旧 model 名。
    if (model !== '' && readPiJsonStrict(PI_SETTINGS_PATH).defaultProvider === id) {
      await piWriteJson(PI_SETTINGS_PATH, (settings) => { settings.defaultModel = model; return settings })
    }
    send(res, { ok: true, id })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 追加自 src/index.js（段 5/9）---
export async function piModels(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''

    if (id === '' || id === 'deepseek') {
      // 内置：问 Pi 自己（RPC get_available_models），拿不到给空数组，不编造。
      // ⚠️ 必须返回字符串数组：ProviderCard 用 h('option', { value: m }, m) 直接渲染元素，
      // 传对象会让 React 抛 "Objects are not valid as a React child"，整个设置面板被弹掉（真实事故）。
      // ⚠️ get_available_models 返回的是**全局**清单（含所有 provider 的模型）。
      // 实测：deepseek 行会混进 zhi 的 glm-5.3 —— 必须按每项的 provider 字段过滤，
      // 否则「拉 DeepSeek 的模型」等于「列出 Pi 认识的所有模型」（P4.20 真实事故）。
      const want = id === '' ? ((resolvePiProvider() || {}).id || 'deepseek') : id
      const list = await piAvailableModels().catch(() => null)
      const raw = Array.isArray(list) ? list : []
      const models = raw
        .filter((m) => m !== null && typeof m === 'object' && typeof m.provider === 'string' && m.provider === want)
        .map((m) => String(m.id === undefined ? '' : m.id))
        .filter((x) => x !== '')
      send(res, { ok: true, id: want, models })
      return
    }

    const snap = piProvidersSnapshot()
    const one = Object.prototype.hasOwnProperty.call(snap.channels, id) && snap.channels[id] !== null && typeof snap.channels[id] === 'object' ? snap.channels[id] : {}
    const baseUrl = typeof one.baseUrl === 'string' ? one.baseUrl.trim() : ''
    const apiKey = typeof one.apiKey === 'string' ? one.apiKey.trim() : ''
    const localModels = Array.isArray(one.models)
      ? one.models
          .map((m) => (typeof m === 'string' ? m : (m !== null && typeof m === 'object' && m.id !== undefined ? String(m.id) : '')))
          .filter((x) => x !== '')
      : []

    // 从远端拉：复用 Codex 的 modelsUrl / bigmodelAuxModelsUrl / extractModels（三者都返回字符串），
    // 不再另写一套解析 —— 上一版就是另写才把对象数组漏进了 option。
    if (typeof fetch === 'function' && baseUrl !== '' && apiKey !== '') {
      const urls = [modelsUrl(baseUrl)]
      const auxUrl = bigmodelAuxModelsUrl(baseUrl)
      if (auxUrl !== null && auxUrl !== urls[0]) urls.push(auxUrl)
      const models = []
      let primaryError = ''
      for (let k = 0; k < urls.length; k += 1) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)
        try {
          const r = await fetch(urls[k], {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: controller.signal,
          })
          const text = await r.text()
          clearTimeout(timer)
          let json = null
          try { json = JSON.parse(text) } catch { json = null }
          if (json !== null) {
            for (const mid of extractModels(json)) {
              if (typeof mid === 'string' && mid !== '' && !models.includes(mid)) models.push(mid)
            }
          }
          // 不 break：智谱同时有两个端点 —— /api/v1/models 只回 3 个旧模型，
          // /api/coding/paas/v4/models 回完整清单。拿到第一个就停会少一半（用户实测 3 vs 11）。
          // 两个都拉、合并去重，宁多不丢。
          // 只在「还没拿到任何模型」时记录首个错误 —— 用于两个端点都失败时的回落提示。
          if (models.length === 0 && primaryError === '') {
            primaryError = r.ok ? '接口成功但未解析出模型（可能不是 OpenAI 兼容的 /models）' : `HTTP ${r.status}`
          }
        } catch (e) {
          clearTimeout(timer)
          if (k === 0) primaryError = errMsg(e)
        }
      }
      if (models.length > 0) {
        send(res, { ok: true, id, models, sources: urls })
        return
      }
      // 远端拉不到 → 回落本地已配，并把失败原因说清楚（不假装成功、不编模型名）。
      // 文案与下面「没得可查」那一支共用 piModelsEmptyReason，不再两处各写一份。
      send(res, {
        ok: true,
        id,
        models: localModels,
        ...piModelsEmptyReason({ baseUrl, apiKey, localCount: localModels.length, fetchError: primaryError }),
      })
      return
    }

    // baseUrl / apiKey 缺一个就没法问远端。旧版这里只给人读 note，且**两者都缺时只报 baseUrl**、
    // 两者都配了（走到不到这里）不管。现在统一走 piModelsEmptyReason()：人读 note + 机读 code/hint。
    send(res, {
      ok: true,
      id,
      models: localModels,
      ...piModelsEmptyReason({ baseUrl, apiKey, localCount: localModels.length, fetchError: '' }),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// --- 追加自 src/index.js（段 6/9）---
export function piModelsEmptyReason({ baseUrl, apiKey, localCount, fetchError }) {
  if (baseUrl === '') {
    return {
      code: 'no_base_url',
      note: '未配置 baseUrl，无法从远端拉取，也无法确定可用模型',
      hint: '编辑该渠道补上 baseUrl（形如 https://api.example.com/v1），保存后重试',
    }
  }
  if (apiKey === '') {
    return {
      code: 'no_api_key',
      note: '未配置 apiKey，无法从远端拉取',
      hint: '展开该行填入 API Key 后重试（Key 只写进 0600 的 models.json）',
    }
  }
  const err = fetchError === '' ? '未知原因' : fetchError
  if (localCount > 0) {
    return {
      code: 'remote_failed',
      note: `远端拉取失败（${err}），下面显示 models.json 里已配置的模型`,
      hint: '下面列的是 models.json 本地清单，不代表远端实际可用',
    }
  }
  return {
    code: 'empty_everywhere',
    note: `远端拉取失败（${err}），且 models.json 里也没配模型`,
    hint: '先在渠道里手写模型 id，或确认 baseUrl 的路径层级是不是少了 /v1',
  }
}

// --- 追加自 src/index.js（段 7/9）---
export async function piProviderModel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (model === '') { send(res, { ok: false, error: 'id 和 model 都必填' }, 400); return }
    const idErr = piProviderIdError(id)
    if (idErr !== '') { send(res, { ok: false, error: idErr }, 400); return }
    const keyAsModel = piRejectKeyAsModel(model)
    if (keyAsModel !== '') { send(res, { ok: false, error: keyAsModel }, 400); return }
    await piWriteJson(PI_SETTINGS_PATH, (settings) => {
      settings.defaultProvider = id
      settings.defaultModel = model
      return settings
    })
    rememberPiModel(id, model)
    send(res, { ok: true, id, model })
  } catch (e) { sendPiWriteError(res, e) }
}

// --- 追加自 src/index.js（段 8/9）---
export async function piProvidersRoot(req, res) {
  if (req.method === 'POST') return piProviderAdd(req, res)
  return piProvidersList(req, res)
}

// --- 追加自 src/index.js（段 9/9）---
export function piMcpServers() {
  const doc = readPiMcp()
  const out = []
  for (const name of Object.keys(doc.mcpServers)) {
    const one = doc.mcpServers[name] !== null && typeof doc.mcpServers[name] === 'object' ? doc.mcpServers[name] : {}
    let url = ''
    if (typeof one.url === 'string' && one.url !== '') url = one.url
    else if (typeof one.command === 'string' && one.command !== '') url = `stdio: ${one.command}`
    out.push({ name, url, enabled: one.enabled !== false })
  }
  return out
}

// D2（2026-10-29）：本函数原先自己写一份「备份 + tmp + rename」，三个 MCP 写入口
// （handlePiMcpAdd / Delete / Toggle）全在它外面各自 readPiMcp → 改 → 写，既无互斥，
// tmp 名又只带 pid（同进程两个入口并发时名字必撞），.bak 只带 Date.now()（同毫秒互相覆盖）。
// 现在统一走 piWriteJson：与 settings.json / models.json 同一把锁队列、同一套严格读与
// 随机后缀 tmp/备份；mcp.json 坏 JSON 同样中止而不是拿 { mcpServers: {} } 当基线覆盖掉用户的 MCP 配置。
// 读侧 readPiMcp 保留原样：它是**展示用**的宽松读（坏文件要让面板照常渲染并提示），
// 写基线一律用锁内的严格读，两者语义不同、不再共用。
export async function writePiMcp(mutate) {
  const out = await piWriteJson(PI_MCP_PATH, (doc) => {
    if (doc.mcpServers === null || typeof doc.mcpServers !== 'object') doc.mcpServers = Object.create(null)
    return mutate(doc)
  })
  prunePiBackups(PI_MCP_PATH)
  return out
}

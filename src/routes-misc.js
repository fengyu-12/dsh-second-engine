import { send } from './core.js'
import { activeEngineId } from './engine/registry.js'
import { readHintToggles, writeHintToggles } from './hint-toggles.js'
import { addClaudeMcp, listClaudeMcp, removeClaudeMcp, toggleClaudeMcp } from './claude-mcp.js'
import { queryParam, readBody } from './io.js'
import { REVIEW_MIN_TOKEN_LIMIT, REVIEW_MIN_WALL_MS, REVIEW_ROUNDS_CHOICES } from './normalize.js'
import { handlePiMcpAdd, handlePiMcpDelete, handlePiMcpList, handlePiMcpToggle } from './pi-panel.js'
import { tasks } from './state.js'

import { CONSULT_KEEP_LIMIT, MCP_NAME_PATTERN, MCP_ROUTE_PREFIX, TASK_LIST_LIMIT, WEB_SEARCH_MODES, addMcpServer, collabStatus, compareVersions, consults, engineView, errMsg, handleConfigSet, handleTaskCreate, latestPluginVersion, listMcpServers, loadKeyring, ownPluginVersion, readWebSearch, removeMcpServer, setMcpServerEnabled, taskSummary, taskView, writeTopLevelString } from './index.js'

export async function handleTaskGet(req, res) {
  try {
    const id = queryParam(req.url, 'id')
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    send(res, { ok: true, task: taskView(task) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleTaskList(_req, res) {
  try {
    const list = [...tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, TASK_LIST_LIMIT)
      .map(taskSummary)
    send(res, { ok: true, tasks: list })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleTaskRoot(req, res) {
  if (req.method === 'POST') return handleTaskCreate(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleTaskGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

export async function handleConfigGet(_req, res) {
  try {
    const doc = loadKeyring()
    send(res, { ok: true, reviewRounds: doc.reviewRounds, roundsChoices: REVIEW_ROUNDS_CHOICES, reviewWallMs: doc.reviewWallMs, reviewTokenLimit: doc.reviewTokenLimit, wallMsMin: REVIEW_MIN_WALL_MS, tokenLimitMin: REVIEW_MIN_TOKEN_LIMIT, collab: collabStatus(), engine: await engineView() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleConfigRoot(req, res) {
  if (req.method === 'POST') return handleConfigSet(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleConfigGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

export async function handleHintToggles(req, res) {
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') {
    return send(res, { ok: true, toggles: readHintToggles() })
  }
  if (req.method !== 'POST') return send(res, { ok: false, error: 'method not allowed' }, 405)
  try {
    const body = await readBody(req)
    const fields = ['vocabulary', 'interruption', 'mechanical']
    if (!fields.some((field) => body[field] !== undefined)) {
      return send(res, { ok: false, error: '至少提供一个提示开关字段' }, 400)
    }
    for (const field of fields) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return send(res, { ok: false, error: `${field} 必须是布尔值` }, 400)
      }
    }
    return send(res, { ok: true, toggles: writeHintToggles({ ...readHintToggles(), ...body }) })
  } catch (e) { return send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleConsultsList(_req, res) {
  try {
    send(res, { ok: true, count: consults.length, limit: CONSULT_KEEP_LIMIT, consults: consults.slice() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleWebSearchGet(_req, res) {
  if (activeEngineId() === 'pi') {
    return send(res, { ok: true, value: 'disabled', note: 'Pi 没有 web_search 开关；联网搜索请通过下方 MCP 接入' })
  }
  if (activeEngineId() === 'claude') {
    return send(res, { ok: true, value: 'builtin', note: 'Claude 自带 WebSearch 工具，无需 config.toml 开关' })
  }
  try { send(res, { ok: true, value: readWebSearch() }) }
  catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleWebSearchSet(req, res) {
  if (activeEngineId() === 'pi') {
    return send(res, { ok: false, error: 'Pi 没有 web_search 开关（联网能力走 MCP），此项对 Pi 引擎不适用' }, 400)
  }
  if (activeEngineId() === 'claude') {
    return send(res, { ok: true, value: 'builtin', note: 'Claude 的 WebSearch 是内置工具，没有可写开关' })
  }
  try {
    const body = await readBody(req)
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    if (!WEB_SEARCH_MODES.includes(value)) {
      return send(res, { ok: false, error: `value 只支持 ${WEB_SEARCH_MODES.join(' / ')}` }, 400)
    }
    writeTopLevelString('web_search', value)
    send(res, { ok: true, value })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleWebSearchRoot(req, res) {
  if (req.method === 'POST') return handleWebSearchSet(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleWebSearchGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

export function handleMcpList(_req, res) {
  if (activeEngineId() === 'pi') return handlePiMcpList(_req, res)
  if (activeEngineId() === 'claude') {
    try { return send(res, { ok: true, servers: listClaudeMcp() }) }
    catch (e) { return send(res, { ok: false, error: errMsg(e) }) }
  }
  try { send(res, { ok: true, servers: listMcpServers() }) }
  catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleMcpAdd(req, res) {
  if (activeEngineId() === 'pi') return handlePiMcpAdd(req, res)
  try {
    const body = await readBody(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
    if (!MCP_NAME_PATTERN.test(name)) {
      return send(res, { ok: false, error: 'name 只允许字母、数字、下划线和连字符' }, 400)
    }
    if (!/^https?:\/\//.test(url)) {
      return send(res, { ok: false, error: 'url 必须以 http:// 或 https:// 开头' }, 400)
    }
    if (activeEngineId() === 'claude') {
      const r = await addClaudeMcp(name, url)
      if (r.error !== undefined) return send(res, { ok: false, error: r.error }, r.status)
      return send(res, { ok: true, servers: listClaudeMcp() })
    }
    if (listMcpServers().some((s) => s.name === name)) {
      return send(res, { ok: false, error: `已存在同名 MCP 服务器 '${name}'` }, 409)
    }
    addMcpServer(name, url)
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleMcpDelete(res, name) {
  // Pi 分支现在是 async（写 mcp.json 要排队拿锁）：这里必须 await，
  // 否则返回的是 promise，调用方 catch 不到里面的异常，错误响应会丢。
  if (activeEngineId() === 'pi') return handlePiMcpDelete(res, name)
  if (activeEngineId() === 'claude') {
    try {
      const r = name === '' ? { status: 404, error: `未找到 MCP 服务器 '${name}'` } : await removeClaudeMcp(name)
      if (r.error !== undefined) return send(res, { ok: false, error: r.error }, r.status)
      return send(res, { ok: true, servers: listClaudeMcp() })
    } catch (e) { return send(res, { ok: false, error: errMsg(e) }) }
  }
  try {
    if (name === '' || !removeMcpServer(name)) {
      return send(res, { ok: false, error: `未找到 MCP 服务器 '${name}'` }, 404)
    }
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleMcpToggle(req, res, name) {
  if (activeEngineId() === 'pi') return handlePiMcpToggle(req, res, name)
  try {
    const body = await readBody(req)
    if (typeof body.enabled !== 'boolean') {
      return send(res, { ok: false, error: 'enabled 必须是布尔值' }, 400)
    }
    if (activeEngineId() === 'claude') {
      const r = name === '' ? { status: 404, error: `未找到 MCP 服务器 '${name}'` } : await toggleClaudeMcp(name, body.enabled)
      if (r.error !== undefined) return send(res, { ok: false, error: r.error }, r.status)
      return send(res, { ok: true, servers: listClaudeMcp() })
    }
    if (name === '' || !setMcpServerEnabled(name, body.enabled)) {
      return send(res, { ok: false, error: `未找到 MCP 服务器 '${name}'` }, 404)
    }
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleMcpRoot(req, res) {
  // 防御：req.url 非法（如 '*'）时 new URL 抛 TypeError —— 本函数是 async，
  // 不接住就是 unhandledRejection（queryParam 对同样操作包了 try/catch，这里补齐）。
  let pathname = ''
  try {
    pathname = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1').pathname
  } catch {
    return send(res, { ok: false, error: 'bad request url' }, 400)
  }
  const rest = pathname.slice(MCP_ROUTE_PREFIX.length)
  const method = req.method === undefined ? 'GET' : req.method
  if (rest !== '' && rest !== '/') {
    let name = rest.replace(/^\//, '')
    try { name = decodeURIComponent(name) } catch { /* 非法百分号编码：按原文处理 */ }
    if (method === 'DELETE') return await handleMcpDelete(res, name)
    if (method === 'POST') return handleMcpToggle(req, res, name)
    return send(res, { ok: false, error: 'not found' }, 404)
  }
  if (method === 'POST') return handleMcpAdd(req, res)
  if (method === 'GET' || method === 'HEAD') return handleMcpList(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

export async function handlePluginVersion(_req, res) {
  const current = ownPluginVersion()
  try {
    const hit = await latestPluginVersion()
    send(res, {
      ok: true,
      current,
      latest: hit.latest,
      updateAvailable: compareVersions(hit.latest, current) > 0,
      htmlUrl: hit.htmlUrl,
      checkedAt: hit.at,
    })
  } catch {
    // 离线/限流 = 「当没有更新」，不带 error —— 静默是本端点的语义
    send(res, { ok: true, current, latest: '', updateAvailable: false, checkedAt: Date.now() })
  }
}

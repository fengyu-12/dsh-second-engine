import { startAppServerTurn } from './app-server-client.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { send } from './core.js'
import { activeEngineId } from './engine/registry.js'
import { CANCEL_FORCE_FINALIZE_MESSAGE, CANCEL_FORCE_FINALIZE_MS, CANCEL_RETRY_MS, readBody } from './io.js'
import { extractModels } from './parse.js'
import { piModels } from './pi-providers.js'
import { resolveCodexBinary } from './review-core.js'
import { tasks } from './state.js'
import { tokenTotal } from './token-ledger.js'
import { claudeCredentialsFromConfig } from './claude-providers.js'

import { ENGINE_EVENTS_LIMIT, ENGINE_EVENTS_META_BYTES, PROGRESS_LIMIT, bigmodelAuxModelsUrl, errMsg, finalizeTask, loadKeyring, modelsUrl, notifyTask, persistBoardChild, progressEntry, pruneTasks, rtOf, startWatchdog, viewStatus } from './index.js'

export async function handleModels(req, res) {
  if (activeEngineId() === 'pi') return piModels(req, res)
  if (activeEngineId() === 'claude') {
    // Claude 只支持 Anthropic 协议（无标准 /models 端点），但**大多数厂商同时开 OpenAI 兼容端点**。
    // 所以拉列表走 OpenAI 的 /v1/models，发请求仍走 Anthropic 端点（2026-11-05 实测 DeepSeek 两者都通）。
    // 推导：去掉结尾的 /anthropic，再拼 /v1/models。
    try {
      const { loadClaudeProviders } = await import('./claude-providers.js')
      const doc = loadClaudeProviders()
      const act = (doc.providers || []).find((x) => x.id === doc.active)
      const cur = act && typeof act.model === 'string' && act.model !== '' ? [act.model] : []
      const base = act && typeof act.baseUrl === 'string' ? act.baseUrl.replace(/\/+$/, '') : ''
      const modelsBase = base.endsWith('/anthropic') ? base.slice(0, -'/anthropic'.length) : base
      if (modelsBase === '' || !act || !act.apiKey) {
        return send(res, { ok: true, models: cur, note: '未配置 Key 或地址；先填 Key 再拉列表' })
      }
      const r = await fetch(`${modelsBase}/v1/models`, { headers: { authorization: `Bearer ${act.apiKey}` }, signal: AbortSignal.timeout(15000) })
      const j = await r.json().catch(() => null)
      const list = Array.isArray(j && j.data) ? j.data.map((x) => x && x.id).filter((x) => typeof x === 'string') : []
      return send(res, { ok: true, models: list.length > 0 ? list : cur, note: list.length > 0 ? '' : '该端点未列模型，可用手填' })
    } catch (e) { return send(res, { ok: false, error: errMsg(e) }) }
  }
  try {
    if (typeof fetch !== 'function') {
      return send(res, { ok: false, error: '当前 Node 运行时不支持 fetch（需要 Node 18+）' })
    }
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
    const doc = loadKeyring()
    const target = id === ''
      ? doc.providers.find((p) => p.id === doc.active)
      : doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id === '' ? doc.active : id}'` }, 404)
    }
    if (target.apiKey.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 尚未配置 apiKey` }, 400)
    }
    if (target.baseUrl.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 未配置 baseUrl` }, 400)
    }

    const urls = [modelsUrl(target.baseUrl)]
    const auxUrl = bigmodelAuxModelsUrl(target.baseUrl)
    if (auxUrl !== null && auxUrl !== urls[0]) urls.push(auxUrl)

    const models = []
    let primaryError = ''
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        const text = await r.text()
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        if (!r.ok) {
          const detail = json !== null && typeof json.error?.message === 'string' ? `：${json.error.message}` : ''
          // 主端点失败才算失败；辅助端点失败静默（它只是锦上添花）
          if (i === 0) primaryError = `GET ${url} 返回 HTTP ${r.status}${detail}`
        } else if (json !== null) {
          for (const m of extractModels(json)) if (!models.includes(m)) models.push(m)
        } else if (i === 0) {
          primaryError = `GET ${url} 返回非 JSON 响应`
        }
      } catch (e) {
        if (i === 0) primaryError = `请求 ${url} 失败：${errMsg(e)}`
      } finally {
        clearTimeout(timer)
      }
    }
    if (models.length === 0 && primaryError !== '') {
      return send(res, { ok: false, error: primaryError })
    }
    // sources 回显实际拉取的端点，便于核对"为什么是这个清单"
    send(res, { ok: true, id: target.id, models, sources: urls })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export function startAppServerTask({ res, id, outPath, workdir, prompt, envKey, apiKey, boardId, model }) {
  const env = { ...process.env, [envKey]: apiKey }
  const task = {
    id,
    boardId,
    kind: 'task',
    status: 'running',
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    endedAt: null,
    workdir,
    outPath,
    cancelled: false,
    mode: 'appserver',
    progress: [],
    // 排障用（不对外返回）：归一化事件的 meta 原文，环形上限 ENGINE_EVENTS_LIMIT。
    engineEvents: [],
    // P1.1 心跳：引擎活性显式时间戳（看门狗判据主项；0 = 尚未收到任何事件）。
  }
  const handle = startAppServerTurn({
    cwd: workdir,
    env,
    prompt,
    outPath,
    model: typeof model === 'string' ? model : '',
    codexBinary: resolveCodexBinary(),
    onEvent: (evt) => {
      if (evt.kind === 'usage') {
        const total = evt.usage?.normalized?.total
        task.accountedTokens = tokenTotal(total)
      }
      if (evt.kind === 'appserverParseFailure') {
        // 独立累计快照：不会被 engineEvents 环形挤掉，也不算有效协议活动。
        task.appServerParseFailures = {
          count: evt.count, firstSample: evt.firstSample, lastSample: evt.lastSample,
        }
        return
      }
      // progress 封闭投影（2026-10-28）：不再 `{...evt}` 展开 —— 原先除 meta.raw 之外的
      // 引擎专有字段（tool/usage/done/meta.eventType/itemId/…）会整条漏进对外响应。
      rtOf(task).pushProgress(progressEntry(evt, Date.now()), PROGRESS_LIMIT)
      // meta 原文另存一份给排障（task.engineEvents）：不进 taskView，只在直读 tasks Map 的
      // 诊断路径可见。meta.raw 是原始 JSON-RPC 帧（可能很大）且是模型/工具正文的副本
      // （-o 文件与 output 字段已有），故同样剔除；其余（eventType/itemId/status/…）保留。
      if (evt.meta !== undefined && evt.meta !== null) {
        const meta = { ...evt.meta }
        delete meta.raw
        // 字节上限：单条 meta 超阈就按字段截断（eventType 等短字段优先保留）。
        let encoded = JSON.stringify(meta) ?? ''
        if (encoded.length > ENGINE_EVENTS_META_BYTES) {
          const slim = {}
          for (const [k, v] of Object.entries(meta)) {
            let piece
            try { piece = JSON.stringify(v) ?? '' } catch { piece = String(v) }
            if (piece.length <= 200) slim[k] = v
          }
          slim.truncated = true
          encoded = JSON.stringify(slim)
        }
        if (!Array.isArray(task.engineEvents)) task.engineEvents = []
        task.engineEvents.push({ at: Date.now(), kind: progressEntry(evt, 0).kind, meta: encoded })
        if (task.engineEvents.length > ENGINE_EVENTS_LIMIT) task.engineEvents.shift()
      }
      // P1.1（2026-10-28）：原先此处 utimesSync(outPath) 给看门狗续命，现在直接抬升
      // task.activityAt（看门狗判据用的同一个值），**不再碰文件**。
      // 不碰文件的第二个理由：该 mtime 同时是 cleanupLiveFiles 的判据（statSync(...).mtimeMs
      // 对 cutoff 比较），持续 utimesSync 会把长跑任务的 -o 钉在「永不超期」上，
      // 崩溃没走 finalize 时就再也清不掉。
      rtOf(task).heartbeat()
    },
  })
  rtOf(task).setChild(handle.child)
  rtOf(task).setChildPid(Number.isInteger(handle.child?.pid) ? handle.child.pid : null)
  void persistBoardChild(task)
  rtOf(task).setApp(handle)
  tasks.set(id, task)
  pruneTasks()
  startWatchdog(task)

  handle.run.catch((e) => {
    rtOf(task).setAppError(errMsg(e))
    // P1.2（2026-10-28 补漏）：取消在 appserver 分支走的是 handle.done 的 reject，
    // 不经过 exec 的 child.on('exit')。三处收尾都要认 task.cancelled，否则取消仍落 'error'。
    const cancelled = rtOf(task).isCancelled()
    if (finalizeTask(task, -1, cancelled ? 'cancelled' : 'error') && !cancelled) void notifyTask(task)
  })
  handle.done
    .then((r) => {
      const cancelled = rtOf(task).isCancelled()
      const ok = r.status === 'completed' && !cancelled
      if (finalizeTask(task, cancelled ? -1 : (ok ? 0 : 1), cancelled ? 'cancelled' : (ok ? 'done' : 'error')) && !cancelled) void notifyTask(task)
    })
    .catch((e) => {
      rtOf(task).setAppError(errMsg(e))
      const cancelled = rtOf(task).isCancelled()
      if (finalizeTask(task, -1, cancelled ? 'cancelled' : 'error') && !cancelled) void notifyTask(task)
    })

  send(res, { ok: true, id, mode: 'appserver' })
}

/**
 * Claude 的凭证来源（2026-11-05）：环境变量优先，其次 `~/.claude/settings.json` 的 env 段。
 * 两者都没有 → null，由 startClaudeTask 回 400 并指明配置位置。
 * ⚠️ 凭证只经 env 传给子进程，**绝不进 argv**（同 Pi/Codex 的红线）。
 */
function claudeCredentials() {
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
    return { baseUrl: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, from: 'env' }
  }
  try {
    const p = join(homedir(), '.claude', 'settings.json')
    const s = JSON.parse(readFileSync(p, 'utf8'))
    const e = (s !== null && typeof s === 'object' && s.env !== null && typeof s.env === 'object') ? s.env : {}
    if (e.ANTHROPIC_BASE_URL && e.ANTHROPIC_AUTH_TOKEN) {
      return { baseUrl: e.ANTHROPIC_BASE_URL, token: e.ANTHROPIC_AUTH_TOKEN, from: p }
    }
  } catch { /* 文件不存在或坏 JSON：继续看预设 */ }
  // Claude 自己的 provider 配置优先（设置页写入 claude-providers.json）
  try {
    const fromCfg = claudeCredentialsFromConfig()
    if (fromCfg !== null) return fromCfg
  } catch { /* 继续下面的兜底 */ }
  // 预设（2026-11-05 实测可用）：DeepSeek 官方 Anthropic 端点。
  // 用户只需在现有 keyring 里有 deepseek 的 key，无需另配。
  try {
    const doc = loadKeyring()
    const ds = (doc.providers || []).find((x) => x.id === 'deepseek')
    if (ds && typeof ds.apiKey === 'string' && ds.apiKey !== '') {
      return { baseUrl: 'https://api.deepseek.com/anthropic', token: ds.apiKey, from: 'preset:deepseek' }
    }
  } catch { /* 无 keyring：走报错 */ }
  return null
}

/** Claude 的默认模型：设置页写入的 claude-model.txt，没有就 haiku。 */
function claudeDefaultModel() {
  try {
    const v = readFileSync(join(homedir(), '.dsh', 'second-engine', 'claude-model.txt'), 'utf8').trim()
    if (v !== '') return v
  } catch { /* 未配置 */ }
  return 'haiku'
}

/** Claude Code 的按引擎启动（形状照 startPiTask；差异只在凭证来源与 runtime 的 done() 调用）。 */
export function startClaudeTask({ res, id, outPath, workdir, prompt, model, boardId }) {
  const cred = claudeCredentials()
  if (cred === null) {
    return send(res, {
      ok: false,
      error: 'Claude 未配置：在 ~/.claude/settings.json 的 env 里设 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN，或在本机环境变量里设同名项',
    }, 400)
  }
  const task = {
    id,
    boardId,
    kind: 'task',
    engine: 'claude',
    status: 'running',
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    endedAt: null,
    workdir,
    outPath,
    cancelled: false,
    progress: [],
    activityAt: Date.now(),
    stuckSuspect: false,
    signal: null,
    forcedKill: false,
    childPid: null,
    childStart: null,
  }
  tasks.set(id, task)
  pruneTasks()
  const rt = rtOf(task)
  startWatchdog(task)
  void (async () => {
    try {
      await rt.start({
        prompt,
        workdir,
        outPath,
        model: (typeof model === 'string' && model !== '') ? model : claudeDefaultModel(),
        env: {
          ANTHROPIC_BASE_URL: cred.baseUrl,
          ANTHROPIC_AUTH_TOKEN: cred.token,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      })
      await persistBoardChild(task)
    } catch (e) {
      rt.setAppError(errMsg(e))
      if (finalizeTask(task, -1, 'error')) void notifyTask(task)
      send(res, { ok: false, error: errMsg(e) })
      return
    }
    send(res, { ok: true, id, engine: 'claude' })
    // 终态唯一落定点（state 与 exitCode 由 index.js 的 finalizeJob 写）
    try {
      const ev = await rt.done()
      const status = ev.aborted || task.cancelled === true ? 'cancelled' : (ev.exitCode === 0 ? 'done' : 'error')
      if (finalizeTask(task, ev.exitCode, status) && status !== 'cancelled') void notifyTask(task)
    } catch { /* 上面 catch 已收尾 */ }
  })()
}

export function startPiTask({ res, id, outPath, workdir, prompt, model, provider, boardId }) {
  const task = {
    id,
    boardId,
    kind: 'task',
    engine: 'pi',
    status: 'running',
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    endedAt: null,
    workdir,
    outPath,
    cancelled: false,
    progress: [],
    activityAt: Date.now(),
    stuckSuspect: false,
    signal: null,
    forcedKill: false,
    childPid: null,
    childStart: null,
    // Pi 的 provider/model 来自统一 resolver，避免设置页与任务实际运行脱节。
    piProvider: provider,
    piModel: model,
  }
  tasks.set(id, task)
  pruneTasks()
  const rt = rtOf(task)
  startWatchdog(task)
  void (async () => {
    try {
      await rt.start({ prompt, workdir, outPath })
      await persistBoardChild(task)
    } catch (e) {
      rt.setAppError(errMsg(e))
      if (finalizeTask(task, -1, 'error')) void notifyTask(task)
      send(res, { ok: false, error: errMsg(e) })
      return
    }
    send(res, { ok: true, id, engine: 'pi' })
    // 事件流 → 进度（封闭投影由 pi-runtime 的 mapPiEvent 负责，这里只入环）
    void (async () => {
      try {
        for await (const ev of rt.events()) rt.pushProgress(ev)
      } catch { /* 流随进程关闭，正常 */ }
    })()
    // 终态唯一落定点
    try {
      const ev = await rt.done
      const status = ev.aborted || task.cancelled === true ? 'cancelled' : (ev.exitCode === 0 ? 'done' : 'error')
      if (finalizeTask(task, ev.exitCode, status) && status !== 'cancelled') void notifyTask(task)
    } catch { /* 已在上面 catch 收尾 */ }
  })()
}

export async function handleTaskCancel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    if (task.status !== 'running') {
      return send(res, { ok: false, error: `任务已结束（${task.status}），无需取消` }, 400)
    }
    // P2（2026-10-28）：这里只写「取消意图」，不预置终态 —— 终态唯一由 finalizeJob 写。
    // 用户反馈靠 viewStatus() 立刻可见（cancelled 信号 + 仍是 running → 对外显示 cancelled）；
    // output 留给 exit 回调收尾，那样能拿到进程退出前的完整输出。
    rtOf(task).setCancelled()
    // T5：app-server 模式先发 turn/interrupt（优雅结束当前 turn），kill 作为兜底。
    rtOf(task).interrupt()
    rtOf(task).kill('SIGTERM')
    const child = rtOf(task).child()
    const timers = { retry: null, kill: null, forceFinalize: null }
    task.cancelTimers = timers
    const forceKillAndScheduleFinalize = () => {
      if (task.endedAt !== null && task.endedAt !== undefined) return
      try {
        if (child !== null && child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          rtOf(task).setForcedKill()
        }
      } catch { /* best effort */ }
      timers.forceFinalize = setTimeout(() => {
        if (task.endedAt !== null && task.endedAt !== undefined) return
        if (finalizeTask(task, -1, 'error')) {
          task.output = `${task.output === '' ? '' : `${task.output}\n`}${CANCEL_FORCE_FINALIZE_MESSAGE}`
          void notifyTask(task)
        }
      }, CANCEL_FORCE_FINALIZE_MS)
      if (typeof timers.forceFinalize.unref === 'function') timers.forceFinalize.unref()
    }
    // T1 内仍未终态时只重发一次对应传输的取消请求。
    timers.retry = setTimeout(() => {
      if (task.endedAt !== null && task.endedAt !== undefined) return
      if (task.status !== 'running' || !rtOf(task).isCancelled()) return
      if (task.mode === 'appserver') rtOf(task).interrupt()
      else rtOf(task).kill('SIGTERM')
    }, CANCEL_RETRY_MS)
    // SIGKILL 保持原有 3 秒兜底；其后 T2 内仍未收到退出事件则统一强制 finalize。
    timers.kill = setTimeout(forceKillAndScheduleFinalize, 3000)
    if (typeof timers.retry.unref === 'function') timers.retry.unref()
    if (typeof timers.kill.unref === 'function') timers.kill.unref()
    send(res, { ok: true, id, status: viewStatus(task), exitCode: -1 })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// src/claude-providers.js —— Claude 自己的 provider 配置（2026-11-05 新增）
//
// 为什么不能复用 Codex 的 keyring：keyring 里的 provider 是 **OpenAI 协议**（wireApi:
// responses，baseUrl 以 /v1 结尾）。Claude Code 要的是 **Anthropic 协议**端点
// （DeepSeek 的 /anthropic、中转的根路径），路径与请求形状都不同。
// 面板结构复用同一张 ProviderCard，数据由后端按引擎分流 —— 与 Pi 的做法一致。
//
// 存储：~/.dsh/second-engine/claude-providers.json（0600）
// 预设：DeepSeek 官方 Anthropic 端点（2026-11-05 实测跑通，模型 deepseek-flash）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const CLAUDE_PROVIDERS_PATH = join(homedir(), '.dsh', 'second-engine', 'claude-providers.json')
export const CLAUDE_MODEL_PATH = join(homedir(), '.dsh', 'second-engine', 'claude-model.txt')

/** 预设：DeepSeek 官方 Anthropic 端点。apiKey 留空，由用户填或从 keyring 借。 */
const PRESET = {
  active: 'deepseek',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: '',
      model: 'deepseek-flash',
      wireApi: 'anthropic',
    },
  ],
}

/** 读配置；不存在或坏 JSON 都回预设（不抛，UI 要能开）。 */
export function loadClaudeProviders() {
  try {
    const raw = readFileSync(CLAUDE_PROVIDERS_PATH, 'utf8')
    const d = JSON.parse(raw)
    if (d !== null && typeof d === 'object' && Array.isArray(d.providers) && d.providers.length > 0) {
      return d
    }
  } catch { /* 走预设 */ }
  return JSON.parse(JSON.stringify(PRESET))
}

/** 写配置（0600；目录不存在则建）。 */
export function saveClaudeProviders(doc) {
  mkdirSync(dirname(CLAUDE_PROVIDERS_PATH), { recursive: true })
  writeFileSync(CLAUDE_PROVIDERS_PATH, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/** 取当前 provider 的凭证；没有 apiKey 时回 null（调用方回 400 说明要填）。 */
export function claudeCredentialsFromConfig() {
  const doc = loadClaudeProviders()
  const p = (doc.providers || []).find((x) => x && x.id === doc.active) || null
  if (p === null) return null
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : ''
  const token = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''
  if (baseUrl === '' || token === '') return null
  return { baseUrl, token, model: typeof p.model === 'string' ? p.model.trim() : '', providerId: p.id }
}

/**
 * Claude 的 provider 写操作统一入口（2026-11-05）。
 * routes-a.js 的 5 个接口在 claude 引擎下分流到这里，避免它们落进 Codex 的
 * wireApi('responses'/'completions') 校验 —— 那正是「协议显示 undefined」的来源。
 */
export async function handleClaudeProvider(op, req, res, io) {
  const { readBody, send, errMsg } = io
  try {
    const doc = loadClaudeProviders()
    if (op === 'list') {
      return send(res, { ok: true, active: doc.active, providers: doc.providers, wireApiOptions: [{ value: 'anthropic', label: 'anthropic（Claude 原生）', bridged: false }] })
    }
    const body = await readBody(req)
    if (op === 'add') {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
      if (doc.providers.some((p) => p.id === id)) return send(res, { ok: false, error: `provider 已存在：${id}` }, 400)
      doc.providers.push({
        id,
        name: typeof body.name === 'string' ? body.name.trim() : id,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
        model: typeof body.model === 'string' ? body.model.trim() : '',
        wireApi: 'anthropic',
      })
      saveClaudeProviders(doc)
      return send(res, { ok: true, providers: doc.providers })
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const idx = doc.providers.findIndex((p) => p.id === id)
    if (op === 'key') {
      if (idx < 0) return send(res, { ok: false, error: `未找到 ${id}` }, 404)
      const k = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (k === '') return send(res, { ok: false, error: 'apiKey 不能为空' }, 400)
      doc.providers[idx].apiKey = k
      saveClaudeProviders(doc)
      return send(res, { ok: true })
    }
    if (op === 'update') {
      if (idx < 0) return send(res, { ok: false, error: `未找到 ${id}` }, 404)
      for (const f of ['name', 'baseUrl', 'model']) {
        if (typeof body[f] === 'string') doc.providers[idx][f] = body[f].trim()
      }
      saveClaudeProviders(doc)
      return send(res, { ok: true, providers: doc.providers })
    }
    if (op === 'delete') {
      if (idx < 0) return send(res, { ok: false, error: `未找到 ${id}` }, 404)
      doc.providers.splice(idx, 1)
      if (doc.active === id && doc.providers.length > 0) doc.active = doc.providers[0].id
      saveClaudeProviders(doc)
      return send(res, { ok: true, providers: doc.providers })
    }
    if (op === 'active') {
      if (idx < 0) return send(res, { ok: false, error: `未找到 ${id}` }, 404)
      doc.active = id
      saveClaudeProviders(doc)
      // 切 provider 必须联动模型：只切地址不切模型，会把上一个 provider 的模型名发到新端点。
      // 2026-11-05 实测：切到 DeepSeek 官方后，任务仍发 `--model claude-haiku-5-5`。
      const m = typeof doc.providers[idx].model === 'string' ? doc.providers[idx].model.trim() : ''
      if (m !== '') {
        try { writeFileSync(CLAUDE_MODEL_PATH, m + '\n', { mode: 0o600 }) } catch { /* 写失败不回滚 active：模型可由设置页再设 */ }
      }
      return send(res, { ok: true, active: id, model: m })
    }
    return send(res, { ok: false, error: `未知操作：${op}` }, 400)
  } catch (e) { return send(res, { ok: false, error: errMsg(e) }) }
}

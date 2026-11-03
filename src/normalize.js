// src/normalize.js — review 与 issue 归一化（2026-11-02 从 index.js 拆出）
import { createHash } from 'node:crypto'
import { canonicalIssueText } from './review-core.js'
import { WIRE_API } from './constants.js'

export const REVIEW_DEFAULT_ROUNDS = 3

export const REVIEW_ROUNDS_CHOICES = [1, 3, 5]

export const REVIEW_DEFAULT_WALL_MS = 30 * 60 * 1000   // 墙钟 30 分钟

export const REVIEW_DEFAULT_TOKEN_LIMIT = 400000       // 累计 40 万 token（按 codex 自报的 tokens used 累加）

export const REVIEW_MIN_WALL_MS = 60 * 1000

export const REVIEW_MIN_TOKEN_LIMIT = 1000

export const asText = (value) => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return String(value) } catch { return '' }
}

export const ISSUE_REF_RE = /^(?:i\d+|[0-9a-f]{4,64})$/

export const REPLY_REASON_CLIP = 2000

export const RESPONSE_REASON_CLIP = 2000

export const LEDGER_ID_RE = /^i\d+$/

export function normalizeProvider(raw) {
  const provider = {
    id: typeof raw?.id === 'string' ? raw.id : '',
    name: typeof raw?.name === 'string' ? raw.name : '',
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl : '',
    wireApi: typeof raw?.wireApi === 'string' ? raw.wireApi : WIRE_API,
    model: typeof raw?.model === 'string' ? raw.model : '',
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
  }
  // 可选模型元数据（预设提供方才有）：存在才带上，写入 config.toml 顶层。
  if (Number.isFinite(raw?.contextWindow)) provider.contextWindow = Math.floor(raw.contextWindow)
  if (Number.isFinite(raw?.maxOutput)) provider.maxOutput = Math.floor(raw.maxOutput)
  return provider
}

export function normalizeReviewRounds(value) {
  const n = Number(value)
  return REVIEW_ROUNDS_CHOICES.includes(n) ? n : REVIEW_DEFAULT_ROUNDS
}

export function normalizeReviewWallMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= REVIEW_MIN_WALL_MS ? Math.floor(n) : REVIEW_DEFAULT_WALL_MS
}

export function normalizeReviewTokenLimit(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= REVIEW_MIN_TOKEN_LIMIT ? Math.floor(n) : REVIEW_DEFAULT_TOKEN_LIMIT
}

export function normalizeIssue(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  const issue = {
    fingerprint: issueFingerprintOf(item),
    severity: asText(item.severity).trim(),
    point: asText(item.point).trim(),
    suggestion: asText(item.suggestion).trim(),
    // 信息字段（2026-10-25）：区分"跑过"与"目测猜的"。
    // 刻意不参与收敛判定与 issuesHash —— 自报字段不可信，且状态迁移会被误判为振荡。
    verified: item.verified === true,
  }
  const continues = asText(item.continuesIssueId).trim()
  const replaces = asText(item.replacesIssueId).trim()
  const ref = (continues !== '' ? continues : replaces).toLowerCase()
  if (ref !== '' && ISSUE_REF_RE.test(ref)) issue.continuesIssueId = ref
  return issue
}

export function normalizeReply(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  raw.forEach((entry, position) => {
    if (entry === null || typeof entry !== 'object') return
    const n = Math.trunc(Number(entry.issueIndex ?? position))
    const indexOk = Number.isFinite(n) && n >= 0
    const id = asText(entry.issueId).trim().toLowerCase()
    const idOk = ISSUE_REF_RE.test(id)
    if (!indexOk && !idOk) return
    out.push({
      ...(idOk ? { issueId: id } : {}),
      ...(indexOk ? { issueIndex: n } : {}),
      decision: asText(entry.decision).trim().toLowerCase().slice(0, 100),
      reason: asText(entry.reason).trim().slice(0, REPLY_REASON_CLIP),
    })
  })
  return out
}

export function normalizeResponses(raw) {
  if (!Array.isArray(raw)) return []
  const byKey = new Map()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const n = Math.trunc(Number(entry.issueIndex))
    const indexOk = Number.isFinite(n) && n >= 0
    const id = asText(entry.issueId).trim().toLowerCase()
    const idOk = ISSUE_REF_RE.test(id)
    if (!indexOk && !idOk) continue
    byKey.set(idOk ? `id:${id}` : `#${n}`, {
      ...(idOk ? { issueId: id } : {}),
      ...(indexOk ? { issueIndex: n } : {}),
      verdict: asText(entry.verdict).trim().toLowerCase().slice(0, 100),
      reason: asText(entry.reason).trim().slice(0, RESPONSE_REASON_CLIP),
    })
  }
  return [...byKey.values()]
}

export function normalizeLedgerEntries(raw) {
  const ledger = (Array.isArray(raw) ? raw : []).filter((e) => e !== null && typeof e === 'object')
  let seq = 0
  for (const e of ledger) {
    if (typeof e.id === 'string' && LEDGER_ID_RE.test(e.id)) {
      seq = Math.max(seq, Number(e.id.slice(1)) || 0)
      continue
    }
    // v1 条目（哈希 id 或缺 id）：按首现顺序分配新号；原哈希收进 aliases 供旧引用命中。
    const legacy = typeof e.id === 'string' ? e.id.trim().toLowerCase() : ''
    seq += 1
    e.id = `i${seq}`
    if (/^[0-9a-f]{4,64}$/.test(legacy)) {
      if (!Array.isArray(e.aliases)) e.aliases = []
      if (!e.aliases.includes(legacy)) e.aliases.push(legacy)
    }
  }
  for (const e of ledger) {
    if (typeof e.fingerprint !== 'string' || !/^[0-9a-f]{12}$/.test(e.fingerprint)) e.fingerprint = issueFingerprintOf(e)
    if (!Array.isArray(e.aliases)) e.aliases = []
    if (!Array.isArray(e.mergedFrom)) e.mergedFrom = []
    if (!Array.isArray(e.textHistory) || e.textHistory.length === 0) {
      e.textHistory = [{ round: Number.isFinite(e.firstRound) ? e.firstRound : 0, severity: asText(e.severity), point: asText(e.point), suggestion: asText(e.suggestion) }]
    }
    if (e.status !== 'open' && e.status !== 'resolved' && e.status !== 'disputed') e.status = 'open'
    if (!Number.isFinite(e.firstRound)) e.firstRound = 0
    if (!Number.isFinite(e.lastRound)) e.lastRound = e.firstRound
  }
  return ledger
}

export function issueFingerprintOf(issue) {
  return createHash('sha256')
    .update(`${canonicalIssueText(issue?.severity)}\u0000${canonicalIssueText(issue?.point)}`)
    .digest('hex')
    .slice(0, 12)
}


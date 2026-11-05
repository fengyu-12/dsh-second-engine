// 解析/提取组（第 5 刀，从 index.js 原样搬出）。
// 零状态、无副作用：只读 CONFIG_PATH，或纯文本进/结构出。
// 留在 index.js 的依赖（consultsForTask / canonicalIssueText / isBlockedVerdict / clipText）
// 一律走参数注入，不 import './index.js'（避免循环）。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CONFIG_PATH } from './constants.js'
import { normalizeIssue, normalizeResponses, asText } from './normalize.js'

// 下面两个常量原样搬自 index.js（原本紧贴 extractPreserved* 的上方，函数体直接读它们）。


// 提取原 config.toml 中全部 [mcp_servers.*] 段（段体直到下一个段头或文件尾）。
// 插件模板不生成这些段；切换提供方时原样保留，避免用户经 codex mcp add 挂载的
// 外部 MCP（如 exa）在重写中丢失。原文件不存在或读取失败时返回空数组。
export function extractMcpServerBlocks() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const blocks = []
    const re = /^\[mcp_servers\.[^\]\n]+\][^\n]*$/gm
    let m
    while ((m = re.exec(raw)) !== null) {
      const next = raw.indexOf('\n[', m.index)
      const end = next === -1 ? raw.length : next + 1
      blocks.push(raw.slice(m.index, end).replace(/\n*$/, ''))
    }
    return blocks
  } catch { /* 原文件不存在：无可保留 */ return [] }
}

const TEMPLATE_OWNED_SECTION = /^\[(?:model_providers\.[^\]\n]+|memories)\][^\n]*$/

// 提取原 config.toml 中「除模板自有段之外」的全部段（段体直到下一个段头或文件尾）。
// 原文件不存在或读取失败时返回空数组。
export function extractPreservedSections() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const blocks = []
    const re = /^\[[^\]\n]+\][^\n]*$/gm
    let m
    while ((m = re.exec(raw)) !== null) {
      if (TEMPLATE_OWNED_SECTION.test(m[0])) continue   // 模板每次自己会生成
      const next = raw.indexOf('\n[', m.index)
      const end = next === -1 ? raw.length : next + 1
      blocks.push(raw.slice(m.index, end).replace(/\n*$/, ''))
    }
    return blocks
  } catch { /* 原文件不存在：无可保留 */ return [] }
}

const TEMPLATE_OWNED_TOP_LEVEL = new Set([
  'model_provider', 'model', 'sandbox_mode', 'web_search', 'approval_policy',
  'model_context_window', 'model_max_output_tokens', 'model_reasoning_summary',
])

// 首个段头之前的非模板顶层 key = value 行（原样保留；TOML 顶层键必须在首个 [table] 前）。
export function extractPreservedTopLevelLines() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const lines = raw.split('\n')
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
    const head = firstTable === -1 ? lines : lines.slice(0, firstTable)
    const kept = []
    for (const line of head) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)
      if (m === null || TEMPLATE_OWNED_TOP_LEVEL.has(m[1])) continue
      kept.push(line.trim())
    }
    return kept
  } catch { /* 原文件不存在：无可保留 */ return [] }
}

// 兼容两种实测返回格式：
//   OpenAI（DeepSeek）：{ object:'list', data:[{ id, ... }] }
//   Z.ai（智谱）：      { models:[{ id, display_name, ... }] }
// 取 id；无 id 时回落 display_name；顺带容忍纯字符串条目与重复项。
export function extractModels(json) {
  const list = Array.isArray(json?.data)
    ? json.data
    : (Array.isArray(json?.models) ? json.models : [])
  const models = []
  for (const item of list) {
    let id = ''
    if (typeof item === 'string') id = item.trim()
    else if (item !== null && typeof item === 'object') {
      if (typeof item.id === 'string' && item.id !== '') id = item.id
      else if (typeof item.display_name === 'string') id = item.display_name
    }
    if (id !== '' && !models.includes(id)) models.push(id)
  }
  return models
}

// 宽松解析：从自由文本里截取「首个配平的 {...} 块」（跳过字符串内的花括号与转义）。
export function extractFirstJsonObject(text) {
  const s = String(text === undefined || text === null ? '' : text)
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

// 字符 3-gram 集合（规范化后切）；不足 3 字符按整串单 gram 计。
export function issueTrigrams(text, canonicalize) {
  const s = canonicalize(text)
  if (s === '') return new Set()
  if (s.length < 3) return new Set([s])
  const out = new Set()
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
  return out
}

// 三字段文本指纹（severity/point/suggestion 原文拼接）：textHistory 变化检测用——
// 归并进同一账本条目但措辞/建议微调时追记一条历史，而不是无感覆盖。
export function issueTextFingerprint(issue) {
  return [
    String(issue?.severity ?? '').trim(),
    String(issue?.point ?? '').trim(),
    String(issue?.suggestion ?? '').trim(),
  ].join('\u0000')
}

// id/alias → 条目 的索引（回辩与 responses 解析共用：旧哈希引用经 aliases 命中）。
export function ledgerIndex(ledger) {
  const byRef = new Map()
  for (const e of Array.isArray(ledger) ? ledger : []) {
    byRef.set(e.id, e)
    for (const a of e.aliases) if (!byRef.has(a)) byRef.set(a, e)
  }
  return byRef
}

export function ledgerEntryOf(id, issue, chainRound, inheritedFrom) {
  return {
    id,
    fingerprint: issue.fingerprint,
    severity: issue.severity,
    point: issue.point,
    suggestion: issue.suggestion,
    firstRound: chainRound,
    lastRound: chainRound,
    status: 'open',
    aliases: [],
    mergedFrom: [],
    textHistory: [{ round: chainRound, severity: issue.severity, point: issue.point, suggestion: issue.suggestion }],
    ...(inheritedFrom !== undefined ? { inheritedFrom } : {}),
  }
}

// ledger 终止判据（纯函数）：open/disputed 清零 且 本轮 responses 无 upheld → converged。
// 取代旧的下标版 dialogueConverged（「issues 无新增且无 upheld」）：旧判据下「原样重列
// 但不坚持」也算收敛；账本口径更严——问题还挂在 issues 里就是未了结。
export function ledgerConverged(ledger, responses) {
  const open = (Array.isArray(ledger) ? ledger : []).some((e) => e?.status === 'open' || e?.status === 'disputed')
  const upheld = (Array.isArray(responses) ? responses : []).some((r) => r?.verdict === 'upheld')
  return !open && !upheld
}

// 解析复核输出 → { ok:true, issues, verdict, responses } 或 { ok:false, raw }。
// issues 必须是数组（缺键视为解析失败：宁可报错也不误判「已收敛」）。
// responses 可缺省：旧格式（无该键）照常解析，缺失 = 未回应，恒为 []。
// blocked 时返回值另带 blocked:true，verdict 恒为归一化后的 'blocked'。
export function parseReviewJson(text, deps = {}) {
  const { isBlockedVerdict = () => false, clipText = (t) => String(t ?? '') } = deps
  const block = extractFirstJsonObject(text)
  if (block === null) return { ok: false, raw: clipText(text) }
  let obj
  try { obj = JSON.parse(block) } catch { return { ok: false, raw: clipText(block) } }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, raw: clipText(block) }
  if (!Array.isArray(obj.issues)) {
    // 容错（2026-10-26 实测）：第 2 轮 prompt 带上一轮 issues 时，模型可能直接输出
    // 单条 issue 对象 {"severity":..,"point":..} 而不是 {issues:[..],verdict} 容器。
    // 这是合法 JSON、信息也完整，只是缺外壳 —— 判 unparsed 会让整轮复核白跑。
    if (obj !== null && typeof obj === 'object' && obj.point !== undefined) {
      const issues = [normalizeIssue(obj)]
      const blocked = isBlockedVerdict(obj.verdict, issues)
      return { ok: true, issues, verdict: blocked ? 'blocked' : 'issues-found', ...(blocked ? { blocked: true } : {}) }
    }
    if (obj !== null && typeof obj === 'object' && obj.issues !== null && typeof obj.issues === 'object') {
      const issues = [normalizeIssue(obj.issues)]
      const blocked = isBlockedVerdict(obj.verdict, issues)
      return { ok: true, issues, verdict: blocked ? 'blocked' : 'issues-found', ...(blocked ? { blocked: true } : {}) }
    }
    return { ok: false, raw: clipText(block) }
  }
  const issues = obj.issues.map(normalizeIssue)
  const verdict = asText(obj.verdict).trim()
  const blocked = isBlockedVerdict(verdict, issues)
  // 回辩通道：responses 缺失 = 未回应；旧格式（无该键）照常解析，恒为 []。
  const responses = normalizeResponses(obj.responses)
  return {
    ok: true,
    issues,
    verdict: blocked ? 'blocked' : (verdict !== '' ? verdict : (issues.length === 0 ? 'converged' : 'issues-found')),
    ...(blocked ? { blocked: true } : {}),
    responses,
  }
}

// 从 codex exec 输出尾部抽 "tokens used\nN"（codex 自报的累计用量）。
// 抽不到返回 0 —— 宁可少算也不误停（硬预算语义是"到量才停"，不是"猜一个"）。
export function parseTokensUsed(text) {
  if (typeof text !== 'string' || text === '') return 0
  const m = /tokens used\s*\n?\s*([\d,]+)/i.exec(text)
  if (m === null) return 0
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 振荡检测用的稳定指纹：只取 issues 的三个语义字段，排序后哈希（顺序无关）。
// 两个 AI 在「主张 X / 反对 X」之间来回时，同一批 issues 会原样回来 → 命中即判循环。
export function issuesHash(issues) {
  const norm = (Array.isArray(issues) ? issues : []).map((i) => [
    String(i?.severity ?? '').trim(),
    String(i?.point ?? '').trim(),
    String(i?.suggestion ?? '').trim(),
  ])
  norm.sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1))
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16)
}

export function appendConsultBlock(task, consultsForTask) {
  const fresh = consultsForTask(task)
  if (fresh.length === 0) return
  const block = fresh.map(c =>
    `- ${new Date(c.at).toISOString()} ｜ ${c.task}${c.stuckContext ? ` ｜ 上下文：${c.stuckContext}` : ''}`,
  ).join('\n')
  const base = typeof task.output === 'string' ? task.output : ''
  task.output = `${base === '' ? '' : `${base}\n\n`}---\n`
    + `[SECOND_ENGINE_CONSULT] 本任务期间收到 ${fresh.length} 条卡点求助：\n${block}\n`
}

// ── #8-10（2026-10-25）：复核接力链 ──
// ③ 摘要进 output：主 AI 收单必读 output（与 appendConsultBlock 同通道同先例），
// 它即使不知道 /api/reviews，下一次 GET /task?id= 也能看到未决问题与接力入口。
// （dual-board 收件箱被否决：inbox-append --sender 只允许 {lead,codex}，插件写入=冒充协议方。）
export function appendReviewIssuesBlock(task, deps = {}) {
  const { clipText } = deps
  const rounds = Array.isArray(task.rounds) ? task.rounds : []
  const last = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const issues = last !== null && Array.isArray(last.issues) ? last.issues : []
  const stopReason = typeof task.stopReason === 'string' ? task.stopReason : ''
  // 阻断硬档（2026-10-26）：blocked 时首行换成醒目档头（对齐 secondop-panel 的 BLOCK
  // 语义：不可上线）。且 issues 为空也照发——「verdict=blocked 但没列条目」必须仍可见，
  // 不能被空列表的提前 return 静默吞掉；其余行（接力入口、问题清单）照旧。
  const blocked = stopReason === 'blocked'
  if (issues.length === 0 && !blocked) return
  const lines = issues.slice(0, 20).map((i) => {
    // 稳定 id（2026-10-26）：主 AI 就凭这里看到的 id 组织 reply，无需再查别的接口。
    const id = typeof i?.id === 'string' && i.id !== '' ? `<${i.id}> ` : ''
    const sev = clipText(String(i?.severity ?? ''), 40)
    const point = clipText(String(i?.point ?? ''), 200)
    const sugg = clipText(String(i?.suggestion ?? ''), 200)
    return `- ${id}[${sev}] ${point}${sugg !== '' ? ` → ${sugg}` : ''}${i?.verified === true ? '（verified）' : ''}`
  })
  const base = typeof task.output === 'string' ? task.output : ''
  task.output = `${base === '' ? '' : `${base}\n\n`}---\n`
    + (blocked
      ? `[REVIEW_BLOCKED] 存在阻断级问题，禁止上线：末轮问题 ${issues.length} 条（stopReason=${stopReason}）。\n`
      : `[REVIEW_ISSUES] 末轮未决问题 ${issues.length} 条（stopReason=${stopReason}）。\n`)
    + `接力复核：POST /second-engine/api/review {"content":"…","prev":"${task.id}","reply":[{"issueId":"<上方 i<N>>","decision":"accepted|partial|rejected","reason":"…"}]}（reply 任意轮可用，issueId 用上方 i<N>（旧哈希 id 亦可）；不回辩可省略）；历史：GET /second-engine/api/reviews\n`
    + `${lines.join('\n')}\n`
}

// 取首个 x.y.z：'codex-cli 0.155.1'、'OpenAI Codex v0.155.1'、'v0.156.0' 都能吃。
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text === undefined || text === null ? '' : text))
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`
}

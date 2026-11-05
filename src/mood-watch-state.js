// src/mood-watch-state.js — mood-watch 的「回执校验状态机」（工单 Z1，2026-11-06）
//
// 外部复核意见要修的是控制流，不是文案：
//   「只改注入文案不改控制流 —— 没有回执校验时，模型输出了套话也照样继续原计划。」
// 所以本模块把 mood-watch 从「注入一次提醒」升级为「注入 → 校验回执 → 缺字段就再插一条 →
// 连续两次缺就把后续计划标记为待确认」的闭环。
//
// 设计约束（按工单「纯函数优先」）：
//   ① 注入判定   → mood-watch.js 的 diagnoseMood（本模块只决定何时注入、带哪个事件 ID）
//   ② 回执解析   → parseAcknowledgement / verifyAcknowledgement（纯文本进，结构出）
//   ③ 状态迁移   → stepTurn（(state, turn) → { state, actions }，不碰 fs；now / ids 由调用方注入）
//   ④ 持久化     → loadState / saveState（唯一有 IO 的部分，路径由调用方传入）
//
// 零第三方依赖；Node >= 18。回执字段是**机器可读标记**，不是自由散文：
// 「已核对」这类无证据结论一律判失败（quote 必须是用户上一条原话的短引文）。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/* ------------------------------------------------------------------ *
 * 常量与工具
 * ------------------------------------------------------------------ */

export const MW_STATE_VERSION = 1
export const MW_ACK_HEADER = '[MW_ACK]'
export const MW_EVENT_PREFIX = 'mw'
export const MW_MISSING_LIMIT = 2 // 连续两次缺回执 ⇒ 后续计划标记为待确认
export const MW_MAX_ACTIVE = 8 // 每个会话最多挂多少个待回执事件（防无界增长）
export const MW_MAX_HISTORY = 20
export const MW_MAX_MISSING_LOG = 10
const MW_PLAGIAT_MIN = 20 // 整段复读用户原话（>=20 字符且与原话全等）不算「短引文」

// 套话（无回执时用来撑场面的话）。只用于**诊断信息**，不作为判失败的必要条件：
// 判失败靠「缺哪些必填字段」，避免误伤真写了回执的回复。
const PLAUSIVE_FILLER = new RegExp('(?:\u6536\u5230|\u660e\u767d|\u4e86\u89e3|\u597d\u7684|\u6211\u77e5\u9053\u4e86|\u5df2\u6838\u5bf9|\u5df2\u786e\u8ba4|\u786e\u8ba4\u65e0\u8bef|\u65e0\u8bef|\u62b1\u6b49|\u4e0d\u597d\u610f\u601d|\u4f60\u8bf4\u5f97\u5bf9|\u6709\u9053\u7406|\u9a6c\u4e0a\u8c03\u6574|\u7acb\u5373\u8c03\u6574|\u5df2\u6ce8\u610f|\u6ce8\u610f\u5230\u4e86|\u611f\u8c22\u63d0\u9192|\u653e\u5fc3)')

function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 12)
}

/** 引文指纹：判「同一条原话重复开事件」用，避免每次换随机后缀都算新事件。 */
export function anchorFingerprint(text) {
  const norm = String(text == null ? '' : text).replace(/\s+/g, '').toLowerCase()
  return norm === '' ? '' : `a-${hash(norm)}`
}

function snippet(s, n = 48) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** 事件 ID：mw-<ts36>-<rand>，可带 kind 便于日志人读。 */
export function makeEventId({ kind = 'correction', now = Date.now(), rand } = {}) {
  const r = rand || randomBytes(3).toString('hex')
  return `${MW_EVENT_PREFIX}-${now.toString(36)}-${r}-${String(kind).slice(0, 4)}`
}

/* ------------------------------------------------------------------ *
 * ② 回执解析（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 引文比对前的归一化：全角/半角标点归一 + 去空白 + 小写。
 * 引号类字符一律写成 \uXXXX：它们既是内容又是字符串定界符，
 * 直接写进字面量迟早把定界符吃掉（少一个反斜杠就静默改变语义）。
 */
const PUNCT_MAP = [
  ["\u201c\u201d\u201e\u201f\uff02", "\u0022"],
  ["\u2018\u2019\u201b", "\u0027"],
  ["\u3010", "["],
  ["\u3011", "]"],
  ["\u300a", "<"],
  ["\u300b", ">"],
  ["\uff08", "("],
  ["\uff09", ")"],
  ["\uff0c\u3001", ","],
  ["\u3002", "."],
  ["\uff1b", ";"],
  ["\uff1a", ":"],
  ["\uff01", "!"],
  ["\uff1f", "?"],
  ["\uff0f", "/"],
]
const QUOTE_CHARS = ["\u0022", "\u0027", "\u201c", "\u201d", "\u2018", "\u2019", "\u300c", "\u300d", "\u300e", "\u300f", "\u3010", "\u3011", "\u300a", "\u300b"]
const SEG_SPLIT = ["\n", "\r", "\uff0c", ",", "\u3002", ".", "\uff1b", ";", "\uff1a", ":", "\uff01", "!", "\uff1f", "?", "\u3001", "(", ")", "\uff08", "\uff09", "[", "]", "\u3010", "\u3011", "\u0022", "\u0027", "\u201c", "\u201d", "\u2018", "\u2019"]

const RX_META = ["[](){}^$.|?*+", "\\"].join('')
const RX_BS = "\\"

/** 字符数组 -> 正则字符类（正则元字符加反斜杠）。 */
function rx(chars) {
  return '[' + chars.map((c) => (RX_META.includes(c) ? RX_BS + c : c)).join('') + ']'
}

/** 「无冲突」的中文写法；写成 \uXXXX + i 旗标，不依赖源码文件编码。 */
const NO_CONFLICT_CN = [
  '\u65e0',
  '\u6ca1\u6709',
  '\u4e0d\u5b58\u5728',
  '\u4e0d\u6d89\u53ca',
  '\u65e0\u51b2\u7a81',
  '\u6ca1\u51b2\u7a81',
]
// 显式「没有冲突」的写法。na / no 不单独当「无冲突」——太容易误判成模型随口写的字母。
// 注意：不要在这行里用反斜杠（如 n\/a）——本工作区的文件写入会抛掉正则字面量里的单个反斜杠，
// 所以分隔符用字符类拼：[/] 等价于 /，无需转义。
const NO_CONFLICT_NONE = ["\u006e\u006f\u006e\u0065"].join('')
const NO_CONFLICT_RE = new RegExp("\u005e\u0028\u003f\u003a" + ["\u006e\u006f\u006e\u0065"].join('') + "\u007c\u006e\u005b\u002f\u005d\u0061\u007c\u006e\u006f\u0074\u0020\u0061\u0070\u0070\u006c\u0069\u0063\u0061\u0062\u006c\u0065\u007c\u006e\u006f\u0020\u0063\u006f\u006e\u0066\u006c\u0069\u0063\u0074\u007c" + NO_CONFLICT_CN.join('|') + "\u0029\u005b\u002e\u005d\u003f\u0024", 'i')


function normalizeCjk(s) {
  let t = String(s == null ? '' : s)
  for (const [from, to] of PUNCT_MAP) for (const ch of from) t = t.split(ch).join(to)
  return t.replace(/\s+/g, '').toLowerCase()
}

/** 去掉引文两端的引号/破折号/项目符号，只留引文本体。 */
function stripQuoteWrappers(s) {
  let t = String(s == null ? '' : s).trim()
  // 连字符必须转义后再进字符类：裸 '-' 紧挨下一个成员（这里是全角破折号 U+2014）会被读成
  // 区间「U+002D-U+2014」，那一段把全部 ASCII 字母数字符号都圈了进去，于是 conflict=none、
  // action=stop 这类 ASCII 值会被整串剥成空字符串。放在数组第一位并从 rx 走转义即可避开。
  const lead = rx(["-", " ", "\t", "\u2014", "\u2013", "*", "\u00b7"].concat(QUOTE_CHARS))
  const trail = rx([".", ",", ":", ";", "\u3002", "\uff0c", "\u3001"].concat(QUOTE_CHARS))
  let guard = 0
  while (guard++ < 6) {
    const next = t
      .replace(new RegExp('^' + lead + '+'), '')
      .replace(new RegExp(trail + '+$'), '')
      .trim()
    if (next === t) break
    t = next
  }
  return t
}

/** 用户上一条原话按句/子句切成候选片段（供「引文必须来自原话」比对）。 */
function segments(text) {
  return String(text == null ? '' : text)
    .split(new RegExp(rx(SEG_SPLIT) + '+'))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

/** 归一化后的引文是否确实出自归一化后的原话（整段包含，或 6 字以上子串互相包含）。 */
function quoteMatchesSource(qn, srcNorm, srcSegments) {
  if (qn === '' || srcNorm === '') return false
  if (srcNorm.includes(qn)) return true
  if (qn.length >= 6) {
    for (const raw of srcSegments) {
      const sn = normalizeCjk(raw)
      if (sn.length >= 6 && (sn.includes(qn) || qn.includes(sn))) return true
    }
  }
  return false
}

const FIELD_ALIAS = {
  quote: ['quote', 'citations', 'citation', 'q', '原文', '原话', '引文', '引用'],
  verdict: ['verdict', 'v', 'class', 'category', 'kind', '判定', '类别', '分类'],
  conflict: ['conflict', 'c', '冲突', '计划冲突'],
  action: ['action', 'a', 'handling', '处理', '处理方式', '本轮处理'],
}

// 判定类别只认这五个（工单第 3 步：拒绝「已核对」这类无证据结论）。
// 中文别名靠「包含」匹配，顺序即优先级：越靠前越具体，避免「停止并纠正」被乱归。
const VERDICT_CANON = ['stop', 'correction', 'reject', 'reconcile', 'supplement']
const VERDICT_CN = [
  ['stop', /叫停|停止|暂停|中止|停手|停一下/],
  ['reject', /否决|驳回|否定|不采纳|推翻|作废/],
  ['reconcile', /冲突|不一致|矛盾|对不上|打架/],
  ['correction', /纠错|纠正|指正|理解错|答非所问|做法不对|说法不对/],
  ['supplement', /补充|新要求|新增|追加|额外需求/],
]

/** 把自由文本判定归一到五类；归不到 ⇒ 返回 null（等于该字段缺失）。 */
export function normalizeVerdict(value) {
  const s = String(value == null ? '' : value).trim()
  if (s === '') return null
  const lower = s.toLowerCase()
  for (const v of VERDICT_CANON) {
    if (new RegExp(`(?:^|[^a-z])${v}(?:$|[^a-z])`).test(lower)) return v
  }
  for (const [v, re] of VERDICT_CN) if (re.test(s)) return v
  return null
}

const ACK_LINE_RE = new RegExp(String.raw`\s*\[MW_ACK\]([^\n]*)$`, 'i')
const ID_RE = /\b(mw|pending)-[A-Za-z0-9_-]+/

// 字段键/值的正则片段（写成字符串常量，便于拼两个正则）。
// 键 = 汉字/字母开头，不含 = 与分号；值 = 不含分号的连续段（可含空格）。
// ⇒ 单行分号分隔用 KVP_HEAD 逐个取字段；一行一个字段用 KVP_LINE 直接取到行尾。
const KV_KEY_SRC = "\u005b\u0041\u002d\u005a\u0061\u002d\u007a\u4e00\u002d\u9fa5\u005d\u005b\u0041\u002d\u005a\u0061\u002d\u007a\u0030\u002d\u0039\u005f\u005c\u002d\u4e00\u002d\u9fa5\u005d\u002a"
const KV_BODY_SRC = "\u005b\u005e\u005c\u0073\u003b\uff1b\u005d\u002b\u0028\u003f\u003a\u005c\u0073\u002b\u005b\u005e\u005c\u0073\u003b\uff1b\u005d\u002b\u0029\u002a"
const KVP_HEAD = new RegExp("\u0028" + KV_KEY_SRC + "\u0029\u005c\u0073\u002a\u003d\u005c\u0073\u002a\u0028" + KV_BODY_SRC + "\u0029", 'g')
const KVP_LINE = new RegExp("\u005e\u005c\u0073\u002a\u0028" + KV_KEY_SRC + "\u0029\u005c\u0073\u002a\u003d\u005c\u0073\u002a\u0028" + KV_BODY_SRC + "\u0029")

/**
 * 从模型回复里抽取**最后一条** [MW_ACK] 回执。
 * 支持三种写法：单行 `[MW_ACK] event=…; quote=…`；只写 ID `[MW_ACK] mw-…` + 缩进字段；
 * 多行 `[MW_ACK] event=…` 换行缩进 `quote=…`。
 */
export function parseAcknowledgement(reply) {
  const lines = String(reply == null ? '' : reply).split(/\r?\n/)
  let start = -1
  let header = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = ACK_LINE_RE.exec(lines[i])
    if (m) {
      start = i
      header = m[1]
      break
    }
  }
  if (start === -1) return null

  const pairs = [] // [key | null(续行), value]
  const addPair = (k, v) => pairs.push([k === null ? null : String(k).trim().toLowerCase(), v])
  // 一行里可能塞了多个 k=v（单行写法）；整行只有一个 k=v 时值取到行尾（多行写法）。
  const scanLine = (line, allowMulti) => {
    let m
    const hits = []
    KVP_HEAD.lastIndex = 0 // g 正则跨调用复用 ⇒ 每次用前必须复位 lastIndex
    while ((m = KVP_HEAD.exec(line)) !== null) {
      if (m[0] === '') { KVP_HEAD.lastIndex += 1; continue } // 防零宽匹配死循环
      hits.push([m[1], m[2].trim()])
    }
    KVP_HEAD.lastIndex = 0
    if (allowMulti) { // 单行写法：该行所有 k=v 依次入账
      for (const [k, v] of hits) addPair(k, v)
      return hits.length
    }
    // 多行写法：整行就是一个 k=v ⇒ 值取到行尾（值里可以带分号/逗号）
    const whole = KVP_LINE.exec(line)
    if (whole) {
      addPair(whole[1], whole[2].trim())
      return 1
    }
    if (hits.length === 1) {
      addPair(hits[0][0], hits[0][1])
      return 1
    }
    if (hits.length > 1) { // 没缩进但一行塞了多个字段：兜底按多字段入账
      for (const [k, v] of hits) addPair(k, v)
      return hits.length
    }
    return 0
  }

  if (scanLine(header, true) === 0) {
    const idm = ID_RE.exec(header.trim()) // 头部只有事件 ID：`[MW_ACK] mw-…`
    if (idm) addPair('event', idm[0])
  }
  let lastKey = pairs.length > 0 ? pairs[pairs.length - 1][0] : null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') break // 空行结束回执块
    if (ACK_LINE_RE.test(line)) break // 新回执块开始
    if (scanLine(line, false) > 0) {
      lastKey = pairs[pairs.length - 1][0]
    } else if (lastKey !== null && /^\s+\S/.test(line)) {
      addPair(null, line.trim()) // 缩进续行：并入上一个键
    } else break
  }

  const fields = {}
  let eventId = ''
  let pendingKey = null
  for (const [k, raw] of pairs) {
    const key = k === null ? pendingKey : k
    if (key === null) continue
    if (k !== null) pendingKey = k
    if (key === 'event' || key === 'id') {
      const v = String(raw).trim()
      const m = ID_RE.exec(v)
      eventId = m ? m[0] : v
      continue
    }
    for (const [canon, aliases] of Object.entries(FIELD_ALIAS)) {
      if (aliases.includes(key)) {
        fields[canon] = fields[canon] === undefined ? String(raw) : `${fields[canon]}${raw}`
        break
      }
    }
  }
  return { eventId, fields, lineIndex: start }
}

/**
 * 校验回执是否**有证据**。required 默认 quote + verdict + action
 * （conflict 允许显式写「无」，所以不强制非空）。
 */
export function verifyAcknowledgement(ack, { required = ['quote', 'verdict', 'action'] } = {}) {
  const missing = []
  const violations = []
  if (!ack) {
    return {
      ok: false, missing: required.slice(), violations: ['ack_missing'],
      quoteOk: false, quotes: [], verdict: null, conflict: '', action: '',
    }
  }
  const anchorText = ack.anchorText
  const srcNorm = normalizeCjk(anchorText)
  const srcSegments = segments(anchorText)

  const rawQuote = ack.fields.quote
  const quotes = rawQuote === undefined
    ? []
    : stripQuoteWrappers(rawQuote).split(/\s*(?:\|\||｜|∥)\s*/).map(stripQuoteWrappers).filter(Boolean)
  if (quotes.length === 0) {
    missing.push('quote')
    violations.push('quote_missing')
  } else {
    let okCount = 0
    for (const q of quotes) {
      const qn = normalizeCjk(q)
      if (qn.length === 0) continue
      // 整段复读用户原话（>=MW_PLAGIAT_MIN 字且与原话全等）不算「短引文」：那是复读，不是核对
      if (qn.length >= MW_PLAGIAT_MIN && srcNorm !== '' && srcNorm === qn) violations.push('quote_too_long_use_snippet')
      else if (quoteMatchesSource(qn, srcNorm, srcSegments)) okCount += 1
      else violations.push('quote_not_in_user_turn')
    }
    if (okCount === 0) {
      if (!missing.includes('quote')) missing.push('quote')
      violations.push('quote_not_verifiable')
    }
  }

  const verdict = normalizeVerdict(ack.fields.verdict)
  if (verdict === null) {
    missing.push('verdict')
    violations.push('verdict_unclear')
  }

  const rawConflict = ack.fields.conflict === undefined ? '' : stripQuoteWrappers(ack.fields.conflict)
  // conflict 的三种填法：写出具体那条计划 / 显式写「无」（归一化成 NO_CONFLICT_NONE）/ 不填（=未核对，不判失败但也不归为「无」）
  const conflict = rawConflict === '' ? '' : (NO_CONFLICT_RE.test(rawConflict) ? NO_CONFLICT_NONE : rawConflict)
  const conflictIsNone = conflict === NO_CONFLICT_NONE
  if (conflict !== '' && !conflictIsNone && normalizeCjk(conflict).length < 2) violations.push('conflict_unclear')

  const action = ack.fields.action === undefined ? '' : stripQuoteWrappers(ack.fields.action)
  if (normalizeCjk(action).length < 2) {
    missing.push('action')
    violations.push('action_missing')
  }

  for (const f of required) if (!missing.includes(f) && ack.fields[f] === undefined) missing.push(f)
  const filler = PLAUSIVE_FILLER.test(String(ack.replyText || ''))
  return {
    ok: missing.length === 0 && violations.length === 0,
    missing: [...new Set(missing)],
    violations: [...new Set(violations)],
    quoteOk: quotes.length > 0 && !violations.includes('quote_not_in_user_turn') && !violations.includes('quote_not_verifiable'),
    quotes,
    verdict,
    conflict,
    conflictIsNone,
    action,
    filler,
  }
}

/** 从模型回复里抽纯文本（content 支持 string 或 parts 数组）。 */
export function assistantText(message) {
  if (message === null || typeof message !== 'object') return ''
  const c = message.content
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
  }
  return typeof c === 'string' ? c : ''
}

/* ------------------------------------------------------------------ *
 * ③ 状态迁移（纯函数）
 * ------------------------------------------------------------------ */

function eventKey(ev, anchorText) {
  return ev.anchor && ev.anchor !== '' ? ev.anchor : anchorFingerprint(anchorText)
}

function normalizeState(raw, { sessionId = '', now = Date.now() } = {}) {
  const s = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    version: MW_STATE_VERSION,
    sessionId: typeof s.sessionId === 'string' ? s.sessionId : sessionId,
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : now,
    active: Array.isArray(s.active) ? s.active.slice(-MW_MAX_ACTIVE) : [],
    history: Array.isArray(s.history) ? s.history.slice(-MW_MAX_HISTORY) : [],
    pendingConfirm: Array.isArray(s.pendingConfirm) ? s.pendingConfirm : [],
    lastAnchorFp: typeof s.lastAnchorFp === 'string' ? s.lastAnchorFp : '',
    consecutiveMissing: typeof s.consecutiveMissing === 'number' ? s.consecutiveMissing : 0,
    missingLog: Array.isArray(s.missingLog) ? s.missingLog.slice(-MW_MAX_MISSING_LOG) : [],
  }
}

function closeEvent(state, ev, outcome, now) {
  state.active = state.active.filter((e) => e.id !== ev.id)
  state.history.push({
    id: ev.id, kind: ev.kind, outcome, at: now,
    missing: outcome === 'verified' ? [] : (ev.lastMissing || []),
    nudges: ev.nudges || 0,
  })
  if (state.history.length > MW_MAX_HISTORY) state.history = state.history.slice(-MW_MAX_HISTORY)
}

function markPending(state, { eventId, reason, at, anchorText, missing, verdict }) {
  const plan = {
    id: `pending-${at.toString(36)}-${String(eventId).slice(-6)}`,
    eventId,
    reason,
    at,
    anchorSnippet: snippet(anchorText, 60),
    missing: Array.isArray(missing) ? missing.slice() : [],
    verdict: verdict || null,
  }
  state.pendingConfirm = [...state.pendingConfirm, plan].slice(-10)
  return plan
}

/**
 * 一轮的完整状态迁移。纯函数：now / ids 由调用方注入，便于单测。
 *
 * @param state  loadState() 的结果（可为 null）
 * @param turn   { anchorText, replyText, hit, now, ids, buildMessage }
 *                - anchorText 用户上一条原话（回执引文的比对基准）
 *                - replyText  本轮模型回复（undefined ⇒ 本轮没有模型回复，不校验）
 *                - hit        diagnoseMood() 的命中（可为 null）
 *                - ids        { event, nudge } 预生成 ID（缺省则内部用 crypto 随机）
 *                - buildMessage 可选：mood-watch.js 的 buildMoodMessage(hit, id, opts)，用于复用现有文案
 * @returns { state, actions }
 *   actions: inject[]（按序注入）/ verified[] / failed[] / pendingConfirm[] / stats
 */
export function stepTurn(state, turn = {}) {
  const now = typeof turn.now === 'number' ? turn.now : Date.now()
  const s = normalizeState(state, { sessionId: turn.sessionId, now })
  const anchorText = typeof turn.anchorText === 'string' ? turn.anchorText : ''
  const fp = anchorFingerprint(anchorText)
  // 2026-11-06（用户定）：待确认项要的是「用户拍板」，不是模型再回执。
  // 所以只要本轮出现了**新的**用户原话（与上次锚点不同），就视为用户已经回答过，
  // 清单直接清空；不再依赖模型补交 [MW_ACK]。
  if (s.pendingConfirm.length > 0 && anchorText !== '' && fp !== s.lastAnchorFp) {
    s.pendingConfirm = []
  }
  const ids = turn.ids && typeof turn.ids === 'object' ? turn.ids : {}
  const actions = { inject: [], verified: [], failed: [], pendingConfirm: [], stats: {} }
  let idSeq = 0
  const nextId = (kind, supplied) => supplied || makeEventId({ kind, now, rand: (idSeq++).toString(16).padStart(6, '0') })

  const pushInject = (kind, phase, eventId, reason, prevEventId) => {
    const message = buildMoodReminder({ kind, phase, reason, eventId, prevEventId, buildMessage: turn.buildMessage })
    actions.inject.push({ phase, eventId, kind, reason, prevEventId, message })
  }

  // ---- 1) 有模型回复 ⇒ 先校验上一批待回执事件 ------------------------
  if (typeof turn.replyText === 'string') {
    const ack = parseAcknowledgement(turn.replyText)
    let consumed = false
    for (const ev of [...s.active]) {
      if (consumed) break // 一条回复只校验一个事件（第一个未满足的）
      const matchesAck = ack !== null && (ack.eventId === '' || ack.eventId === ev.id)
      const res = verifyAcknowledgement(
        // 无回执也走一次校验：missing 三件套一致，filler 也能记到诊断里
        // 锚用事件自己的 anchorSnippet：回执引用的是「注入那条提醒对应的用户原话」，
        // 而本轮 anchorText 往往已经是新的一句话（用户又说话了）——用当前 anchor 会永远判 quote 不匹配。
        matchesAck
          ? { ...ack, anchorText: ev.anchorSnippet || anchorText, replyText: turn.replyText }
          : { anchorText: ev.anchorSnippet || anchorText, replyText: turn.replyText, fields: {} },
      )
      if (matchesAck && res.ok) {
        consumed = true
        closeEvent(s, ev, 'verified', now)
        s.consecutiveMissing = 0
        actions.verified.push({ id: ev.id, kind: ev.kind, verdict: res.verdict, quotes: res.quotes })
        continue
      }
      // 缺字段 / 引文对不上 ⇒ 计一次缺失
      const missing = res.missing.length > 0 ? res.missing : ['ack_missing']
      const violations = matchesAck ? res.violations : ['ack_missing']
      const at = now
      ev.missing = (ev.missing || 0) + 1
      ev.nudges = (ev.nudges || 0) + 1
      ev.lastMissing = missing
      ev.lastViolations = violations
      ev.lastSeenAt = at
      s.missingLog.push({ at, id: ev.id, kind: ev.kind, missing, violations, filler: !!res.filler })
      if (s.missingLog.length > MW_MAX_MISSING_LOG) s.missingLog = s.missingLog.slice(-MW_MAX_MISSING_LOG)
      s.consecutiveMissing += 1
      actions.failed.push({ id: ev.id, kind: ev.kind, missing, violations, missingTimes: ev.missing, filler: !!res.filler })

      if (ev.missing >= MW_MISSING_LIMIT) {
        // 连续两次缺回执 ⇒ 后续计划标记为待确认，事件关闭（不再无限插提醒）
        const plan = markPending(s, {
          eventId: ev.id,
          reason: `连续 ${ev.missing} 次未提交可校验回执（缺 ${missing.join('/')}），该事件之后的推进未经确认`,
          at, anchorText: ev.anchorSnippet || anchorText, missing, verdict: res.verdict,
        })
        closeEvent(s, ev, 'escalated', at)
        actions.pendingConfirm.push(plan)
      } else {
        // 第 1 次缺 ⇒ 再插一条提醒（更硬的措辞 + 可复制模板）
        pushInject(ev.kind, 'nudge', nextId(ev.kind, ids.nudge), ev.reason, ev.id)
      }
      consumed = true // 一条回复只对应一个事件，其余事件留到下一轮
    }
    // 无挂起事件时出现的孤立回执 ⇒ 只记诊断，不改变状态
    if (s.active.length === 0 && ack !== null) {
      s.missingLog.push({ at: now, id: ack.eventId || '(no-id)', kind: 'orphan-ack', missing: [], violations: ['ack_without_open_event'], filler: false })
      if (s.missingLog.length > MW_MAX_MISSING_LOG) s.missingLog = s.missingLog.slice(-MW_MAX_MISSING_LOG)
    }
    // 补交回执（2026-11-06 补）：事件已 escalated 关闭、只留在待确认清单里。
    // 原实现没有任何删除 pendingConfirm 的路径 ⇒ 提醒会每 90s 挂一轮、永远清不掉。
    // 这里允许合格回执销账，比对基准用条目里存的 anchorSnippet（保守：只看前 60 字）。
    if (ack !== null && typeof ack.eventId === 'string' && ack.eventId !== '') {
      const idx = s.pendingConfirm.findIndex((p) => p && p.eventId === ack.eventId)
      if (idx !== -1) {
        const plan = s.pendingConfirm[idx]
        const res2 = verifyAcknowledgement({ ...ack, anchorText: plan.anchorSnippet || '', replyText: turn.replyText })
        if (res2.ok) {
          s.pendingConfirm.splice(idx, 1)
          actions.verified.push({ id: ack.eventId, kind: 'pending-confirm', verdict: res2.verdict, quotes: res2.quotes })
        }
      }
    }
  }

  // ---- 2) 本轮命中 ⇒ 注入带事件 ID 的提醒 -----------------------------
  const hit = turn.hit && typeof turn.hit === 'object' ? turn.hit : null
  if (hit !== null) {
    const key = fp
    const dup = s.active.find((e) => eventKey(e, anchorText) === key)
    if (dup !== undefined) {
      // 同一条原话重复命中（模型仍未回应）⇒ 当作一次缺失，而不是再开新事件
      dup.missing = (dup.missing || 0) + 1
      dup.nudges = (dup.nudges || 0) + 1
      dup.lastSeenAt = now
      s.consecutiveMissing += 1
      s.missingLog.push({ at: now, id: dup.id, kind: dup.kind, missing: ['no_ack_on_repeat_turn'], violations: ['repeat_hit_same_anchor'], filler: false })
      if (dup.missing >= MW_MISSING_LIMIT) {
        const plan = markPending(s, {
          eventId: dup.id,
          reason: `同一条用户消息连续 ${dup.missing} 次命中且始终无可校验回执`,
          at: now, anchorText: dup.anchorSnippet || anchorText, missing: ['no_ack_on_repeat_turn'],
        })
        closeEvent(s, dup, 'escalated', now)
        actions.pendingConfirm.push(plan)
      } else {
        pushInject(dup.kind, 'nudge', nextId(dup.kind, ids.nudge), dup.reason, dup.id)
      }
    } else {
      if (s.active.length >= MW_MAX_ACTIVE) s.active.shift()
      const eventId = nextId(hit.kind, ids.event)
      s.active.push({
        id: eventId,
        kind: hit.kind,
        reason: hit.reason,
        createdAt: now,
        anchor: key,
        anchorSnippet: snippet(anchorText, 60),
        missing: 0,
        nudges: 0,
      })
      s.lastAnchorFp = key
      pushInject(hit.kind, 'initial', eventId, hit.reason, null)
    }
  }

  s.updatedAt = now
  actions.stats = {
    active: s.active.length,
    consecutiveMissing: s.consecutiveMissing,
    pendingConfirm: s.pendingConfirm.length,
  }
  return { state: s, actions }
}

/* ------------------------------------------------------------------ *
 * 注入文案（回执要求部分全部是固定串，禁止回填用户输入）
 * ------------------------------------------------------------------ */

const ACK_SPEC = [
  '本轮回复必须另起一行，以 [MW_ACK] 开头提交可校验回执，四个字段用分号分隔：',
  '  event=本轮提醒对应的事件 ID（照抄本条给出的 ID）',
  '  quote=你正在回应的用户原话短引文（必须逐字摘自用户上一条消息，只取最小片段，多处用 || 分隔）',
  '  verdict=判定类别，只能取 stop | correction | reject | reconcile | supplement',
  '  conflict=该纠正与哪条既有计划/待办/在跑任务冲突；确实没有就写「无」，有冲突必须写出具体那条',
  '  action=本轮实际采取的处理（停止/修正/改向/继续，并写清作用对象）',
  '只写「收到」「已核对」「确认无误」不算回执；quote 不是用户原话、或 verdict 写成自由描述，都算没交。',
  '没有这条回执，本轮视为未处理，下一轮会再次提醒；连续两次没有，后续计划会被标记为待确认。',
].join('\n')

/**
 * 构造注入消息（与 mood-watch.js 的 buildMoodMessage 同形：{ id, role, source, content }）。
 * 状态机只负责「什么时候注入、带哪个事件 ID」；三种 kind 的动作约束文案仍归 mood-watch.js，
 * 这样注入判定 / 回执解析 / 状态迁移三块各自可测。
 * 安全红线：这段文本是 role=user 注入，模型无法与真实用户发言区分 ⇒
 * 只允许回填**本模块生成的**事件 ID 与固定 reason，禁止回填任何用户输入或外部内容。
 */
export function buildMoodReminder({ kind = 'correction', phase = 'initial', reason = '', eventId = '', prevEventId = null, buildMessage } = {}) {
  const opts = { ack: true, eventId, phase, prevEventId, withTail: false }
  const msg = typeof buildMessage === 'function'
    ? buildMessage({ kind, reason }, `mood-watch-${eventId}`, opts)
    : {
      id: `mood-watch-${eventId}`,
      role: 'user',
      source: { kind: 'mood-watch' },
      content: [{
        type: 'text',
        text: `[SECOND_ENGINE:MOOD_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n机械信号：${reason}（${kind}）。\n事件 ID：${eventId}\n${ACK_SPEC}`,
      }],
    }
  // 状态机给出的回执规格必须出现在文本里（buildMessage 的 ack 块已包含时不重复追加）
  if (!String(msg.content[0].text).includes('[MW_ACK]')) {
    msg.content[0].text += `\n${ACK_SPEC}`
  }
  return msg
}

/** 待确认清单的注入文案（同样只回填本模块生成的串）。 */
export function buildPendingReminder(state) {
  const s = normalizeState(state)
  const n = s.pendingConfirm.length
  return {
    id: `mw-pending-${s.updatedAt.toString(36)}`,
    role: 'user',
    source: { kind: 'mood-watch' },
    content: [{
      type: 'text',
      text: `[SECOND_ENGINE:MOOD_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n`
        + `有 ${n} 项后续计划因连续两轮未提交可校验回执被标记为「待确认」。\n`
        + '本轮开头先逐项列出：计划内容 + 对应事件 ID + 缺的是哪个回执字段，并明确询问用户是否继续；'
        + '未获确认前不要执行这些计划，也不要把它们当作已批准继续推进。\n'
        + '不要在本轮回复中提及这条提醒本身。',
    }],
  }
}

/* ------------------------------------------------------------------ *
 * ④ 持久化（唯一有 IO 的部分）
 * ------------------------------------------------------------------ */

export function loadState(path, { sessionId = '', now = Date.now() } = {}) {
  if (typeof path !== 'string' || path === '') return normalizeState(null, { sessionId, now })
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const st = normalizeState(parsed, { sessionId, now })
    if (sessionId !== '' && st.sessionId !== '' && st.sessionId !== sessionId) {
      // 状态文件属于别的会话 ⇒ 当作空状态，不跨会话串事件
      return normalizeState(null, { sessionId, now })
    }
    if (sessionId !== '') st.sessionId = sessionId
    return st
  } catch {
    return normalizeState(null, { sessionId, now })
  }
}

export function saveState(path, state) {
  if (typeof path !== 'string' || path === '') return state
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return state
}

/** 待确认项是否值得再次提醒（由调用方决定节流窗口，纯函数便于单测）。 */
export function shouldRemindPending(state, { now = Date.now(), minIntervalMs = 90 * 1000, lastAt = 0 } = {}) {
  const s = normalizeState(state, { now })
  if (s.pendingConfirm.length === 0) return false
  if (typeof lastAt !== 'number' || lastAt === 0) return true
  return now - lastAt >= minIntervalMs
}

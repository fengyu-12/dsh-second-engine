import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diagnoseMood, lastUserText, buildMoodMessage } from '../src/mood-watch.js'
import {
  stepTurn, loadState, saveState, parseAcknowledgement, verifyAcknowledgement,
  normalizeVerdict, anchorFingerprint, buildPendingReminder, shouldRemindPending,
  currentTurnAssistantText, MW_MISSING_LIMIT,
} from '../src/mood-watch-state.js'

/* ---- 样例语料 ---------------------------------------------------- *
 * ANCHOR          用户上一条原话（回执 quote 的比对基准）
 * FILLER_REPLY    「不回应就继续原计划」的套话：有态度、零证据
 * BAD_QUOTE_REPLY 交了回执，但 quote 不是用户原话、verdict 是自由描述
 * NO_ACTION_REPLY 有原文引用 + 有判定，但没有「本轮采取的处理」
 * goodReply(id)   四选齐全的合格回执
 * ----------------------------------------------------------------- */
const ANCHOR = '我跟你说过打包放到推送之后，不是让你现在就打包，先把手上的差分跑完'
const FILLER_REPLY = '收到，抱歉，你说得对，我已经核对了你的意思，接下来继续按计划推进打包推送。'
const BAD_QUOTE_REPLY = '[MW_ACK] event=${EVENT}; quote=先打包再推送完全反了; verdict=你说的我都记下了; action=继续打包'
const NO_ACTION_REPLY = '[MW_ACK] quote=我跟你说过打包放到推送之后; verdict=correction; conflict=与「先打包再推送」的计划冲突\n我按你说的排。'
const goodReply = (id) => `[MW_ACK] event=${id}; quote=先把手上的差分跑完; verdict=correction; conflict=与本轮「立即打包推送」的计划冲突; action=停止打包，先跑完差分再打包`

const text = (m) => (Array.isArray(m.content) ? m.content.map((p) => p.text).join('') : String(m.content))
const tmp = (name) => join(mkdtempSync(join(tmpdir(), 'mw-')), name)
const hitOf = (t) => diagnoseMood(t) || { kind: 'correction', reason: '样例命中' }

/* ---- ① 注入判定（原有行为不变） ---------------------------------- */
test('diagnoseMood：叫停词/特化否定/仍未解决 命中，普通陈述不命中', () => {
  assert.equal(diagnoseMood('停一下，我想想').kind, 'stop')
  assert.equal(diagnoseMood('不是让你现在就打包').kind, 'correction')
  assert.equal(diagnoseMood('这个差分跑完还是没有修好').kind, 'correction')
  assert.equal(diagnoseMood('先不打包推送，我先看看日志'), null) // 2026-11-02 删掉的误报
  assert.equal(diagnoseMood('今天天气不错'), null)
  assert.equal(lastUserText([
    { role: 'user', content: '真话' },
    { role: 'user', source: { kind: 'mood-watch' }, content: '注入' },
  ]), '真话')
})

test('buildMoodMessage：旧签名可用；opts.ack 才带回执要求；nudge 指向上一事件', () => {
  const hit = hitOf(ANCHOR)
  const legacy = buildMoodMessage(hit, 'mood-watch-s1')
  assert.match(text(legacy), /必须被回应的信号/) // 旧调用仍带 WATCH_TAIL
  assert.doesNotMatch(text(legacy), /\[MW_ACK\]/)

  const acked = buildMoodMessage(hit, 'mood-watch-s1', { ack: true, eventId: 'mw-abc-111-corr', withTail: false })
  assert.match(text(acked), /\[MW_ACK\]/)
  assert.match(text(acked), /mw-abc-111-corr/)
  assert.match(text(acked), /stop \| correction \| reject \| reconcile \| supplement/)
  assert.doesNotMatch(text(acked), /必须被回应的信号/) // 回执校验接管后不再重复模板收尾

  const nudged = buildMoodMessage(hit, 'mood-watch-s1', {
    ack: true, eventId: 'mw-def-222-corr', phase: 'nudge', prevEventId: 'mw-abc-111-corr', withTail: false,
  })
  assert.match(text(nudged), /第 2 次提醒/)
  assert.match(text(nudged), /mw-abc-111-corr/)
})

/* ---- ② 回执解析 / 校验 ------------------------------------------- */
test('parseAcknowledgement：单行、多行、只写 ID 三种写法都能解析', () => {
  const one = parseAcknowledgement(goodReply('mw-x-1-corr'))
  assert.equal(one.eventId, 'mw-x-1-corr')
  assert.equal(one.fields.quote, '先把手上的差分跑完')
  const multi = parseAcknowledgement(goodReply('mw-x-1-corr').replace(/; /g, ';\n  '))
  assert.equal(multi.eventId, 'mw-x-1-corr')
  assert.equal(multi.fields.verdict, 'correction')
  assert.equal(multi.fields.action, '停止打包，先跑完差分再打包')
  const idOnly = parseAcknowledgement('[MW_ACK] mw-abc-111-corr\n  quote=先跑差分\n  verdict=停止\n  action=停手')
  assert.equal(idOnly.eventId, 'mw-abc-111-corr')
  assert.equal(idOnly.fields.verdict, '停止')
  assert.equal(parseAcknowledgement(FILLER_REPLY), null) // 套话里没有回执
  // 多条时取最后一条（模型可能先写一版再改）
  const two = parseAcknowledgement(`先写一版 [MW_ACK] event=mw-old; quote=旧; verdict=纠正; action=旧处理\n再改一版 [MW_ACK] event=mw-new; quote=先跑差分; verdict=纠正; action=停手`)
  assert.equal(two.eventId, 'mw-new')
})

test('verifyAcknowledgement：套话判失败；quote 不在原话里判失败；四选齐全判通过', () => {
  const filler = verifyAcknowledgement(null)
  assert.equal(filler.ok, false)
  assert.deepEqual(filler.missing, ['quote', 'verdict', 'action'])

  const badRaw = BAD_QUOTE_REPLY.replace('${EVENT}', 'mw-1')
  const bad = verifyAcknowledgement({ ...parseAcknowledgement(badRaw), anchorText: ANCHOR, replyText: badRaw })
  assert.equal(bad.ok, false)
  assert.ok(bad.violations.includes('quote_not_in_user_turn'), '编造的引文必须判失败')
  assert.ok(bad.violations.includes('verdict_unclear'), 'verdict 写成自由描述 ⇒ 该字段视为缺失')

  const good = verifyAcknowledgement({ ...parseAcknowledgement(goodReply('mw-1')), anchorText: ANCHOR, replyText: goodReply('mw-1') })
  assert.equal(good.ok, true)
  assert.equal(good.verdict, 'correction')
  assert.equal(good.quoteOk, true)

  // 判定类别的中文别名 + 引号包裹的引文 + 「无冲突」显式写法
  const zh = verifyAcknowledgement({
    anchorText: ANCHOR,
    replyText: '',
    fields: { quote: '「打包放到推送之后」', verdict: '纠正', conflict: '无', action: '停止打包，先跑差分' },
  })
  assert.equal(zh.ok, true)
  assert.equal(normalizeVerdict('reconcile（与计划冲突）'), 'reconcile')
  assert.equal(normalizeVerdict('随便说点什么'), null)
})

/* ---- ③ 状态迁移：工单要求的两条核心用例 -------------------------- */
test('套话回复（不回应就继续原计划）⇒ 触发第 2 次提醒；连续两次缺 ⇒ 后续计划待确认', () => {
  const t0 = 1_700_000_000_000
  let state = loadState(null, { sessionId: 's1', now: t0 })
  // 第 1 轮：命中 → 注入带事件 ID 的提醒
  const r1 = stepTurn(state, { sessionId: 's1', anchorText: ANCHOR, hit: hitOf(ANCHOR), replyText: undefined, now: t0 })
  assert.equal(r1.actions.inject.length, 1)
  assert.equal(r1.actions.inject[0].phase, 'initial')
  assert.match(r1.actions.inject[0].eventId, /^mw-[0-9a-z]+-[0-9a-z]+-corr$/)
  assert.match(r1.actions.inject[0].message.content[0].text, /\[MW_ACK\]/)
  state = r1.state

  // 第 2 轮：模型只出套话、继续原计划 → 判失败 + 再插一条提醒
  const r2 = stepTurn(state, { sessionId: 's1', anchorText: ANCHOR, replyText: FILLER_REPLY, hit: null, now: t0 + 1000 })
  assert.equal(r2.actions.verified.length, 0)
  assert.equal(r2.actions.failed.length, 1)
  assert.deepEqual(r2.actions.failed[0].missing, ['quote', 'verdict', 'action'])
  assert.equal(r2.actions.failed[0].filler, true, '套话特征应被记录（诊断用）')
  assert.equal(r2.actions.inject.length, 1)
  assert.equal(r2.actions.inject[0].phase, 'nudge')
  assert.equal(r2.actions.pendingConfirm.length, 0, '第 1 次缺回执还不该升级到待确认')
  assert.equal(r2.state.active.length, 1)
  assert.equal(r2.state.consecutiveMissing, 1)
  state = r2.state

  // 第 3 轮：仍然套话 → 连续两次缺 ⇒ 后续计划标记为待确认，事件闭合
  const r3 = stepTurn(state, { sessionId: 's1', anchorText: ANCHOR, replyText: '好的明白了，已核对，继续打包推送。', hit: null, now: t0 + 2000 })
  assert.equal(r3.actions.failed.length, 1)
  assert.equal(r3.actions.pendingConfirm.length, 1)
  assert.match(r3.actions.pendingConfirm[0].reason, new RegExp(`连续 ${MW_MISSING_LIMIT} 次`))
  assert.equal(r3.actions.pendingConfirm[0].eventId, r1.actions.inject[0].eventId)
  assert.equal(r3.state.active.length, 0)
  assert.equal(r3.state.pendingConfirm.length, 1)
  assert.equal(r3.state.history.at(-1).outcome, 'escalated')
  assert.equal(r3.actions.inject.length, 0, '升级到待确认后不再无限插提醒')
  assert.match(buildPendingReminder(r3.state).content[0].text, /被标记为「待确认」/)
})

test('有原文引用+判定但无本轮处理 ⇒ 判失败；补齐四选后下一轮判通过并清零', () => {
  const t0 = 1_700_000_100_000
  let state = loadState(null, { sessionId: 's2', now: t0 })
  const r1 = stepTurn(state, { sessionId: 's2', anchorText: ANCHOR, hit: hitOf(ANCHOR), replyText: undefined, now: t0 })
  const evId = r1.actions.inject[0].eventId
  state = r1.state

  const r2 = stepTurn(state, { sessionId: 's2', anchorText: ANCHOR, replyText: NO_ACTION_REPLY, hit: null, now: t0 + 1000 })
  assert.equal(r2.actions.failed.length, 1)
  assert.deepEqual(r2.actions.failed[0].missing, ['action'], '缺「本轮采取的处理」必须判失败')
  assert.equal(r2.actions.inject[0].phase, 'nudge')
  state = r2.state

  const r3 = stepTurn(state, { sessionId: 's2', anchorText: ANCHOR, replyText: goodReply(evId), hit: null, now: t0 + 2000 })
  assert.equal(r3.actions.verified.length, 1)
  assert.equal(r3.actions.failed.length, 0)
  assert.equal(r3.state.active.length, 0)
  assert.equal(r3.state.consecutiveMissing, 0, '校验通过后连续缺失计数清零')
  assert.equal(r3.state.history.at(-1).outcome, 'verified')
})

test('同一条原话重复命中不重复开事件，按缺失升级', () => {
  const t0 = 1_700_000_200_000
  let state = loadState(null, { sessionId: 's3', now: t0 })
  const r1 = stepTurn(state, { sessionId: 's3', anchorText: ANCHOR, hit: hitOf(ANCHOR), replyText: undefined, now: t0 })
  state = r1.state
  const r2 = stepTurn(state, { sessionId: 's3', anchorText: ANCHOR, hit: hitOf(ANCHOR), replyText: undefined, now: t0 + 1000 })
  assert.equal(r2.state.active.length, 1, '同一 anchor 不重复开事件')
  assert.equal(r2.actions.inject[0].phase, 'nudge')
  assert.equal(anchorFingerprint(' 我跟你说过 打包 ') === anchorFingerprint('我跟你说过打包'), true)
})

test('待确认项可节流提醒；状态文件 JSON 往返一致；跨会话不串事件', () => {
  const t0 = 1_700_000_300_000
  let state = loadState(null, { sessionId: 's4', now: t0 })
  for (let i = 0; i <= MW_MISSING_LIMIT; i += 1) {
    const r = stepTurn(state, {
      sessionId: 's4', anchorText: ANCHOR,
      hit: i === 0 ? hitOf(ANCHOR) : null,
      replyText: i === 0 ? undefined : FILLER_REPLY,
      now: t0 + i * 1000,
    })
    state = r.state
  }
  assert.equal(state.pendingConfirm.length, 1)
  const path = tmp('mood-watch.json')
  saveState(path, state)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.sessionId, 's4')
  assert.equal(raw.active.length, 0)
  assert.equal(raw.pendingConfirm[0].eventId.startsWith('mw-'), true)
  const back = loadState(path, { sessionId: 's4', now: t0 + 9000 })
  assert.deepEqual(back.pendingConfirm, state.pendingConfirm)
  assert.equal(shouldRemindPending(back, { now: t0 + 9000, lastAt: 0 }), true)
  assert.equal(shouldRemindPending(back, { now: t0 + 9000, lastAt: t0 + 8000, minIntervalMs: 90_000 }), false)
  // 别的会话读同一文件 ⇒ 不串事件
  assert.equal(loadState(path, { sessionId: 'other' }).pendingConfirm.length, 0)
})

test('无挂起事件时的孤立回执只记诊断，不改状态', () => {
  const t0 = 1_700_000_400_000
  const r = stepTurn(loadState(null, { sessionId: 's5', now: t0 }), {
    sessionId: 's5', anchorText: ANCHOR, replyText: goodReply('mw-nope-1'), hit: null, now: t0,
  })
  assert.equal(r.actions.inject.length, 0)
  assert.equal(r.state.active.length, 0)
  assert.ok(r.state.missingLog.some((e) => e.violations.includes('ack_without_open_event')))
})

test('stop 也走同一状态机（kind 只影响文案），事件 ID 带 kind 便于日志', () => {
  const t0 = 1_700_000_500_000
  const r = stepTurn(loadState(null, { sessionId: 's6', now: t0 }), {
    sessionId: 's6', anchorText: '停一下',
    hit: { kind: 'stop', reason: '消息里有中断/停止指令' },
    replyText: undefined, now: t0,
  })
  const inj = r.actions.inject[0]
  assert.equal(inj.kind, 'stop')
  assert.match(inj.eventId, /-stop$/)
  assert.match(inj.message.content[0].text, /中断\/停止指令（stop）/)
  assert.match(inj.message.content[0].text, new RegExp(inj.eventId))
})

// 回归：stripQuoteWrappers 的「引号剥离」字符类里，裸 '-' 紧挨全角破折号 U+2014 会被
// 读成区间 U+002D-U+2014，把全部 ASCII 字母数字符号都吞进去 —— conflict=none / action=stop
// 这类 ASCII 值会被整串剥成空字符串。这里用纯 ASCII 的 conflict / action 钉住它。
test('ASCII 的 conflict=none / action=stop 不被引号剥离吞掉（字符类区间回归）', () => {
  const base = { anchorText: ANCHOR, replyText: '' }
  const quote = '先把手上的差分跑完'
  // 显式「无冲突」的 ASCII 写法与中文写法都必须归一化，且不能被判成「未填」
  for (const c of ['none', 'NONE', 'n/a', 'N/A', 'no conflict', '无', '无冲突', '没冲突']) {
    const r = verifyAcknowledgement({ ...base, fields: { quote, verdict: 'correction', conflict: c, action: 'stop packing' } })
    assert.notEqual(r.conflict, '', 'conflict=' + JSON.stringify(c) + ' 被剥成空字符串了')
    assert.equal(r.conflictIsNone, true, 'conflict=' + JSON.stringify(c) + ' 应归一化为无冲突')
    assert.equal(r.ok, true, '四选齐全应通过：' + JSON.stringify(r.violations))
  }
  // 太随意的 na / no 不归一化，但必须原样保留（不能变空、不能误判 unclear）
  for (const c of ['na', 'no']) {
    const r = verifyAcknowledgement({ ...base, fields: { quote, verdict: 'correction', conflict: c, action: 'stop packing' } })
    assert.equal(r.conflict, c)
    assert.equal(r.conflictIsNone, false)
  }
  // 具体冲突描述原样保留
  const specific = 'push-then-package plan'
  const r1 = verifyAcknowledgement({ ...base, fields: { quote, verdict: 'correction', conflict: specific, action: 'stop packing' } })
  assert.equal(r1.conflict, specific)
  assert.equal(r1.conflictIsNone, false)
  // 纯 ASCII 的 action 同样不能被吞
  const r2 = verifyAcknowledgement({ ...base, fields: { quote, verdict: 'correction', conflict: 'none', action: 'stop' } })
  assert.equal(r2.ok, true, 'action=stop 应可用：' + JSON.stringify(r2.violations))
  // 真正的引号/破折号仍然要剥掉
  const r3 = verifyAcknowledgement({ ...base, fields: { quote, verdict: 'correction', conflict: '「立即打包推送」', action: '停止打包' } })
  assert.equal(r3.conflict, '立即打包推送')
})

/* ---- 补交回执能清掉待确认（2026-11-06 补） ---- */
test('事件升级到待确认后，补交合格回执能销账', () => {
  const r1 = stepTurn(loadState(tmp('s.json'), { sessionId: 'S' }), {
    sessionId: 'S', anchorText: ANCHOR, replyText: '', hit: hitOf(ANCHOR), buildMessage: buildMoodMessage,
  })
  const id = r1.actions.inject[0].eventId
  const r2 = stepTurn(r1.state, { sessionId: 'S', anchorText: '', replyText: FILLER_REPLY, hit: null, buildMessage: buildMoodMessage })
  const r3 = stepTurn(r2.state, { sessionId: 'S', anchorText: '', replyText: FILLER_REPLY, hit: null, buildMessage: buildMoodMessage })
  assert.equal(r3.state.pendingConfirm.length, 1, '连续两次缺应升级到待确认')
  const r4 = stepTurn(r3.state, { sessionId: 'S', anchorText: '', replyText: goodReply(id), hit: null, buildMessage: buildMoodMessage })
  assert.equal(r4.state.pendingConfirm.length, 0, '补交合格回执后待确认应被清掉')
  assert.equal(r4.actions.verified.length, 1)
  assert.equal(r4.actions.verified[0].kind, 'pending-confirm')
})

/* ---- 用户回复即清空待确认（2026-11-06 用户定） ---- */
test('待确认项在用户发出新消息后自动清空，不依赖模型回执', () => {
  const r1 = stepTurn(loadState(tmp('s2.json'), { sessionId: 'S' }), {
    sessionId: 'S', anchorText: ANCHOR, replyText: '', hit: hitOf(ANCHOR), buildMessage: buildMoodMessage,
  })
  const r2 = stepTurn(r1.state, { sessionId: 'S', anchorText: '', replyText: FILLER_REPLY, hit: null, buildMessage: buildMoodMessage })
  const r3 = stepTurn(r2.state, { sessionId: 'S', anchorText: '', replyText: FILLER_REPLY, hit: null, buildMessage: buildMoodMessage })
  assert.equal(r3.state.pendingConfirm.length, 1, '先制造一条待确认')
  const r4 = stepTurn(r3.state, { sessionId: 'S', anchorText: '好，就这样', replyText: '', hit: null, buildMessage: buildMoodMessage })
  assert.equal(r4.state.pendingConfirm.length, 0, '用户回复后应自动清空')
})

/* ---- 回执在「用户已说了新话」的下一轮仍能被识别（2026-11-06 修锚） ---- */
test('回执校验用事件自己的原话当锚，不受本轮新消息影响', () => {
  const r1 = stepTurn(loadState(tmp('s3.json'), { sessionId: 'S' }), {
    sessionId: 'S', anchorText: ANCHOR, replyText: '', hit: hitOf(ANCHOR), buildMessage: buildMoodMessage,
  })
  const id = r1.actions.inject[0].eventId
  const r2 = stepTurn(r1.state, {
    sessionId: 'S', anchorText: '完全无关的新一句', replyText: goodReply(id), hit: null, buildMessage: buildMoodMessage,
  })
  assert.equal(r2.actions.verified.length, 1, '回执应被识别')
  assert.equal(r2.state.consecutiveMissing, 0)
})

/* ---- currentTurnAssistantText：回执写在前段也要认（2026-11-11） ---------- *
 * 回归：一轮多段回复时只取最后一条 assistant，回执写在第一段 ⇒ 判「未交回执」，
 * 用户端看到重复提醒。新实现取「最后一条 user 之后」的全部 assistant 段拼接。 */
test('currentTurnAssistantText：多段回复里回执写在第一段也算交回执', () => {
  const messages = [
    { role: 'user', content: '继续' },
    { role: 'assistant', content: goodReply('mw-abc') },
    { role: 'assistant', content: '接下来我按计划继续跑测试。' },
  ]
  const reply = currentTurnAssistantText(messages)
  assert.ok(reply.includes('[MW_ACK]'))
  const ack = parseAcknowledgement(reply)
  assert.notEqual(ack, null, '拼接后的本轮文本里应能解析出 [MW_ACK] 回执')
  assert.equal(ack.eventId, 'mw-abc')
})

test('currentTurnAssistantText：不含历史轮，历史里的回执不算本轮', () => {
  const messages = [
    { role: 'assistant', content: goodReply('mw-old') },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '这一轮只说了计划，没有回执。' },
  ]
  const reply = currentTurnAssistantText(messages)
  assert.ok(reply.includes('没有回执'))
  assert.ok(!reply.includes('[MW_ACK]'))
  assert.equal(parseAcknowledgement(reply), null)
})

test('currentTurnAssistantText：末条 user 之后无 assistant 时回退最后一条', () => {
  const messages = [
    { role: 'assistant', content: '上一轮的回复。' },
    { role: 'user', content: '（插件注入的提醒）' },
  ]
  assert.equal(currentTurnAssistantText(messages), '上一轮的回复。')
  assert.equal(currentTurnAssistantText([]), '')
  assert.equal(currentTurnAssistantText(undefined), '')
})

test('currentTurnAssistantText：工具消息里的回执不算助手回执（角色过滤）', () => {
  const messages = [
    { role: 'user', content: '继续' },
    { role: 'tool', content: '[MW_ACK] event=mw-fake' },
    { role: 'assistant', content: '本轮没有提交回执' },
  ]
  const reply = currentTurnAssistantText(messages)
  assert.equal(reply, '本轮没有提交回执')
  assert.equal(parseAcknowledgement(reply), null)
})

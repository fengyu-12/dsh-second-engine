const assert = require('node:assert/strict')
const { test } = require('node:test')
const modules = Promise.all([import('./mood-watch.js'), import('./mood-watch-state.js')])
const anchorText = '请停止当前操作并检查结果'
const hit = kind => ({ kind, reason: '固定测试信号' })
const turn = (kind, extra = {}) => ({ anchorText, hit: hit(kind), now: 1000, ids: { event: 'mw-test-event', nudge: 'mw-test-nudge' }, ...extra })

test('requiresAck: known kinds and conservative fallback', async () => {
  const [m] = await modules
  for (const [kind, expected] of [['stop', true], ['correction', true], ['supplement', false], ['reject', false], [undefined, true], ['', true], ['unknown', true]]) assert.equal(m.requiresAck(kind), expected)
})
for (const kind of ['supplement', 'reject', 'stop', 'correction', undefined, 'unknown']) {
  test(`reminder ACK content: ${kind}`, async () => {
    const [m, s] = await modules
    for (const buildMessage of [undefined, m.buildMoodMessage, (_hit, id) => ({ id, content: [{ type: 'text', text: '自定义固定文案' }] })]) {
      const msg = s.buildMoodReminder({ kind, eventId: 'mw-test-event', buildMessage })
      assert.equal(JSON.stringify(msg.content).includes('[MW_ACK]'), m.requiresAck(kind))
    }
  })
}
for (const kind of ['supplement', 'reject']) {
  test(`${kind}: handled once, no reply/repeat nudge or escalation (including legacy active)`, async () => {
    const [, s] = await modules
    const initial = s.stepTurn(null, turn(kind))
    assert.equal(initial.actions.inject.length, 1)
    assert.equal(initial.state.active.length, 0)
    for (const replyText of [undefined, '正常处理']) {
      const again = s.stepTurn(initial.state, turn(kind, { now: 2000, replyText }))
      assert.equal(again.actions.inject.length, 0)
      assert.equal(again.actions.failed.length, 0)
      assert.equal(again.state.pendingConfirm.length, 0)
      const legacy = { active: [{ id: 'mw-test-event', kind, anchor: s.anchorFingerprint(anchorText), anchorSnippet: anchorText }] }
      const migrated = s.stepTurn(legacy, turn(kind, { replyText }))
      assert.equal(migrated.actions.inject.length, 0)
      assert.equal(migrated.state.active.length, 0)
      assert.equal(migrated.state.consecutiveMissing, 0)
    }
  })
}
for (const kind of ['stop', 'correction', 'unknown']) {
  test(`${kind}: missing ACK nudges; valid ACK closes and repeat hit stays closed`, async () => {
    const [, s] = await modules
    const initial = s.stepTurn(null, turn(kind))
    const missing = s.stepTurn(initial.state, { anchorText, replyText: '收到', now: 2000 })
    // 2026-11-18 用户定：第 2 次提醒已恢复（同事件 ID）
    assert.equal(missing.actions.inject.length, 1)
    assert.equal(missing.actions.inject[0].eventId, 'mw-test-event')
    const replyText = '[MW_ACK] event=mw-test-event; quote=停止当前操作; verdict=stop; conflict=none; action=停止操作'
    const done = s.stepTurn(initial.state, turn(kind, { replyText, now: 3000 }))
    assert.equal(done.actions.verified.length, 1)
    assert.equal(done.state.active.length, 0)
    assert.equal(done.actions.inject.length, 0)
    assert.equal(s.stepTurn(done.state, turn(kind)).actions.inject.length, 0)
  })
}
test('foreign ACK ID cannot close an active event', async () => {
  const [, s] = await modules
  const initial = s.stepTurn(null, turn('stop'))
  const result = s.stepTurn(initial.state, { anchorText, replyText: '[MW_ACK] event=mw-foreign-id; quote=停止当前操作; verdict=stop; conflict=none; action=停止操作', now: 2000 })
  assert.equal(result.actions.verified.length, 0)
  assert.equal(result.state.active[0].id, 'mw-test-event')
  // 第 2 次提醒已恢复
  assert.equal(result.actions.inject.length, 1)
})
for (const kind of ['stop', 'correction']) {
  test(`${kind}: repeat hit nudges and two missing replies escalate`, async () => {
    const [, s] = await modules
    const initial = s.stepTurn(null, turn(kind))
    const repeat = s.stepTurn(initial.state, turn(kind, { now: 2000 }))
    // 第 2 次提醒已恢复
    assert.equal(repeat.actions.inject.length, 1)
    // stepTurn's existing active-event objects are shallow-copied; start afresh.
    const fresh = s.stepTurn(null, turn(kind))
    const first = s.stepTurn(fresh.state, { anchorText, replyText: '收到', now: 2000 })
    const second = s.stepTurn(first.state, { anchorText, replyText: '收到', now: 3000 })
    assert.equal(second.actions.pendingConfirm.length, 1)
    assert.equal(second.state.active.length, 0)
    assert.equal(second.actions.inject.length, 0)
  })
}

// Execute the actual apply() hook registration without starting bridges or reading host state.
async function hookHarness() {
  const fs = require('node:fs')
  const [, s] = await modules
  const source = fs.readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8')
  const body = source.slice(source.indexOf('export function apply(ctx) {') + 'export function apply(ctx) {'.length, source.indexOf('  // 桥清理：'))
  const hooks = new Map()
  let state = s.stepTurn(null, turn('stop')).state
  let observed
  const deps = {
    ctx: { on: (name, fn) => hooks.set(name, fn) },
    registerNativeTools() {}, loadPolicyWatchState() {},
    readHintToggles: () => ({ mechanical: false, vocabulary: true, interruption: false }),
    policyWatchPending: new Map(), moodWatchAborts: new Map(), moodWatchLastAt: new Map(),
    MOOD_KEEP_LIMIT: 50, MOOD_ABORT_WINDOW_MS: 60000, MOOD_ABORT_TRIGGER: 3, MOOD_COOLDOWN_MS: 120000,
    diagnoseMood: () => null, lastUserText: () => anchorText, MOOD_STATE_DIR: '/unused',
    join: require('node:path').join, loadState: () => state,
    saveState: (_path, value) => { state = value },
    stepTurn: (prev, input) => { const result = s.stepTurn(prev, input); observed = { input, result }; return result },
    buildMoodMessage: undefined, shouldRemindPending: () => false,
    currentTurnAssistantText: s.currentTurnAssistantText,
    noteErr: (_tag, error) => { throw error },
  }
  // The extracted body ends after both ctx.on calls and needs no closing apply brace.
  new Function(...Object.keys(deps), body)(...Object.values(deps))
  return {
    event: (id, text) => hooks.get('session/event')({ id }, { type: 'assistant/message', data: { message: { role: 'assistant', content: Array.isArray(text) ? text : [{ type: 'text', text }] } } }),
    end: id => hooks.get('session/event')({ id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } }),
    pre: async id => { const decision = await hooks.get('agent/pre-step')({ agent: { id } }, async () => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: anchorText }] }] })); return { ...observed, decision } },
  }
}
const validAck = '[MW_ACK] event=mw-test-event; quote=停止当前操作; verdict=stop; conflict=none; action=停止操作'

test('assistant/message survives turn/end and reaches pre-step replyText once', async () => {
  const h = await hookHarness()
  await h.event('session-a', [{ type: 'text', text: '最终' }, { type: 'reasoning', text: '不可采信' }, { type: 'text', text: '回复' }])
  await h.end('session-a')
  assert.equal((await h.pre('session-a')).input.replyText, '最终回复')
  assert.equal((await h.pre('session-a')).input.replyText, '')
})
test('cached legal ACK validates true', async () => {
  const h = await hookHarness()
  await h.event('session-a', validAck)
  const { result } = await h.pre('session-a')
  assert.equal(result.actions.verified.length === 1, true)
  assert.equal(result.actions.failed.length, 0)
})
test('cached no ACK and absent text validate false and nudge once', async () => {
  for (const text of ['正常回复', []]) {
    const h = await hookHarness()
    await h.event('session-a', text)
    const { result, decision } = await h.pre('session-a')
    assert.equal(result.actions.verified.length > 0, false)
    assert.equal(result.actions.failed.length, 1)
    assert.equal(result.actions.inject.length, 1)
    assert.equal(decision.messages.length, 2)
  }
})
test('reply cache isolates complete session IDs', async () => {
  const h = await hookHarness()
  await h.event('same-prefix-a', '甲')
  await h.event('same-prefix-b', '乙')
  assert.equal((await h.pre('same-prefix-a')).input.replyText, '甲')
  assert.equal((await h.pre('same-prefix-b')).input.replyText, '乙')
})
test('reply cache keeps one latest message and evicts oldest above 50 sessions', async () => {
  const h = await hookHarness()
  for (let i = 0; i < 50; i++) await h.event(`session-${i}`, `reply-${i}`)
  await h.event('session-0', 'updated')
  await h.event('session-50', 'newest')
  assert.equal((await h.pre('session-1')).input.replyText, '')
  assert.equal((await h.pre('session-0')).input.replyText, 'updated')
  assert.equal((await h.pre('session-50')).input.replyText, 'newest')
})

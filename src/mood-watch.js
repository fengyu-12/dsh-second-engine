// src/mood-watch.js — 用户纠错/打断的机械信号 → 注入 [USER_MOOD] 提示（2026-11-02）
// 形态照抄 policy-watch：只在 agent/pre-step 追加一条模拟用户消息，不下结论、不强制。
// 目的不是"识别情绪"，而是让「用户可能在纠正我」这件事在每轮开头可见一次。
// 信号只取高特化词组（通用否定词如"不对/错了"误报高，不做）。
// 「先不」已删除（2026-11-02 实测误报）："先不打包推送"是陈述计划，不是叫停。
// 保留的都是祈使/当下的叫停词。
const INTERRUPT = /(?:^|[，。；！？、\s])(?:停一下|停停|等下|等等|先别|先停|暂停|别做了|别做吧|打住)/
// STRONG：词本身已指向上一轮，命中即触发（不需要再配 POINTER）
// STRONG：自带指向/自带否定的表达，命中即触发（2026-11-02 按真实打断语料校准）
// 三类：① 「不/别+动词」祈使否定 ② 「你+质问」 ③ 「是让你…」指令重述
const STRONG = /(我说的是|不是这个|别解释|你又|我没说|不是让你|谁让你|^\s*别(?:做|改|动|碰|写|加|自己)|^\s*不要(?:自己|自作|再|乱)|^\s*不(?:必|需要|登记|写|加|改|拆|动|碰)|你怎么|你明白|你确定是|是让你|我是让你)/
// WEAK：语义偏弱，必须同时出现指向词才算
const WEAK = /(还是没|我说了)/
const POINTER = /(你|刚才|之前|上面|上一轮|又)/
// 明确描述问题仍未解决时，即使没有显式指向词也属于纠错信号。
// 刻意只覆盖「修好/解决/完成」类结果词，避免把普通提问、请求或泛化否定算进来。
const UNRESOLVED = /还是没(?:有)?(?:修好|修复好|解决|完成|改好|弄好|搞定)/
export const MOOD_COOLDOWN_MS = 90 * 1000

/** 命中返回 { kind, reason }，否则 null。纯函数，便于单测。 */
export function diagnoseMood(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (t === '') return null
  if (INTERRUPT.test(t)) return { kind: 'stop', reason: '消息里有中断/停止指令' }
  if (STRONG.test(t)) return { kind: 'correction', reason: '特化否定词（自带指向）' }
  if (UNRESOLVED.test(t)) return { kind: 'correction', reason: '明确指出问题仍未解决' }
  if (WEAK.test(t) && POINTER.test(t)) return { kind: 'correction', reason: '弱否定词 + 指向上一轮' }
  return null
}

/** 从 decision.messages 里找最后一条真实用户消息（排除我们自己注入的）。 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m === null || typeof m !== 'object' || m.role !== 'user') continue
    const kind = m.source && typeof m.source === 'object' ? m.source.kind : undefined
    if (kind === 'policy-watch' || kind === 'mood-watch') continue
    const c = m.content
    if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
    return typeof c === 'string' ? c : ''
  }
  return ''
}

/** 构造注入消息（文案带动作约束，不是"你是不是不满意"）。 */
export function buildMoodMessage(hit, id) {
  // 文案形状照抄 policy-watch（2026-11-02 用户校准）：只报机械量 + 给出两种可能 + 指向判据，不下结论。
  const lines = {
    stop: '消息里含中断/停止指令（stop）。',
    interrupt: '短期连续被打断（interrupt）。',
    correction: '用户消息命中纠正形态（correction）。',
  }
  const possibility = hit.kind === 'stop'
    ? '这可能只是叫你暂停手头动作，也可能是在否决当前方向。'
    : hit.kind === 'interrupt'
    ? '这可能只是他在逐步补全信息（打断是因为话没说完），也可能是我在绕弯或方向错了。'
    : '这可能是在纠正我的具体做法，也可能是他在陈述或提新要求。'
  return {
    id,
    role: 'user',
    source: { kind: 'mood-watch' },
    content: [{
      type: 'text',
      text: `[MOOD_WATCH] ${lines[hit.kind] || ''}机械信号：${hit.reason}。${possibility}`
        + '**本提醒只是机械量，不下结论** —— 真正决定「派不派 / 改不改」的是 skill 的「用户否了我时」二分自答 +「什么时候该派它」A/B 两分法。'
        + '第二引擎可做独立审计（复核最近动作）或派单执行：`POST /second-engine/api/task {prompt, workdir, engine, ephemeral}`。',
    }],
  }
}

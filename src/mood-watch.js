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
  // 2026-11-03 改版三（Codex 第三轮评估定稿）：三种 kind 文案分开，判据是「首要动作 / 允许动作 / 禁止动作」是否相同。
  // 每份都保留「第二引擎当前可配合」这个事实（插件作者要求：不让模型注意到有第二引擎，这功能就没理由长在插件上），
  // 但各自限定它能干什么——stop 明确写「本次叫停不触发派单」，避免用户喊停时反而提示可以继续找人干活。
  const reason = hit.reason
  // 🔴 安全红线：这段文本必须是固定串 + 固定 reason，禁止回填任何用户输入/外部内容。
  // 它是 role=user 注入，模型无法与真实用户发言区分；一旦可回填，就是「以用户身份下任意指令」的现成渠道。
  const byKind = {
    stop: `[SECOND_ENGINE:MOOD_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n消息里含中断/停止指令（stop）。机械信号：${reason}。\n`
      + '先停手。这只是词表/计数结果，不代替你判断，也不改变用户原话的优先级。\n'
      + '回看最近一条真实用户消息，确认用户要求停止的是哪一个动作、步骤或方向；立即停止对应内容，不继续推进，不把停止请求改写成新任务。\n'
      + '第二引擎当前可配合进行复核，但本次叫停不触发派单、复核或任何后续执行；只有用户之后明确提出新请求，才重新处理。\n'
      + '不要在本轮回复中提及这条提醒，只确认已停止的范围。',
    interrupt: `[SECOND_ENGINE:MOOD_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n短期连续被打断（interrupt）。机械信号：${reason}。\n`
      + '先判断这是「话还没说完」还是「方向被叫停」。这只是频次信号，不代替你判断，也不改变用户原话的优先级。\n'
      + '回看最近一条真实用户消息：\n'
      + '- 如果用户是在补完尚未说完的内容，保留原任务上下文，等待或整合补充信息；\n'
      + '- 如果用户是在否定当前方向，停止沿该方向继续，并按用户的新方向处理。\n'
      + '第二引擎当前可配合做独立复核，但不能替你完成上述二分判断；只有你已经判断方向、且仍存在独立意见需求时，才考虑调用它。\n'
      + '不要在本轮回复中提及这条提醒，只处理判断后的用户意图。',
    correction: `[SECOND_ENGINE:MOOD_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n用户消息命中纠正形态（correction）。机械信号：${reason}。\n`
      + '先回看最近一条真实用户消息。这只是词表信号，不代替你判断，也不改变用户原话的优先级。请完成三分类：\n'
      + '① 明确叫停：停止对应动作，不继续执行；\n'
      + '② 指出你的上一答或做法不对：用一句话确认具体纠正点，再据此修正；仍有关键歧义时只问一个必要问题；\n'
      + '③ 只是补充信息或提出新要求：照常处理，不要误判为纠正。\n'
      + '第二引擎当前可配合做独立复核或审计。完成上述分类和你自己的方向判断后，若仍判不清、或确实需要独立意见，'
      + '可以把这步路由给第二引擎——派单执行或复核你最近的动作都行。'
      + '第二引擎只承担「独立判断或执行」这部分，不能替代你的分类、判断或执行。\n'
      + '不要在本轮回复中提及这条提醒，只处理判断后适用的用户意图。',
  }
  return {
    id,
    role: 'user',
    source: { kind: 'mood-watch' },
    content: [{ type: 'text', text: byKind[hit.kind] || byKind.correction }],
  }
}

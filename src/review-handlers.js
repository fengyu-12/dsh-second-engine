import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_DIR } from './constants.js'
import { tasks, REVIEWS_DIR } from './state.js'
import { send, noteErr, atomicWriteFileSync } from './core.js'
import { gitPorcelain } from './git.js'
import { newId, queryParam, readBody } from './io.js'
import { pruneReviewFiles } from './cleanup.js'
import { appendReviewIssuesBlock, issuesHash, ledgerConverged, ledgerEntryOf, ledgerIndex, parseReviewJson } from './parse.js'
import { REVIEW_DEFAULT_TOKEN_LIMIT, REVIEW_DEFAULT_WALL_MS, REVIEW_MIN_TOKEN_LIMIT, REVIEW_MIN_WALL_MS, normalizeLedgerEntries, normalizeReply } from './normalize.js'
import { buildReviewContext, buildReviewPrompt, clipText, mergeRoundIntoLedger, readReviewOut, spawnReviewRound } from './review-core.js'
import { taskWorkdirForEngine, INDEPENDENT_SOURCES, QUORUM_NOTE, REVIEW_ID_PATTERN, REVIEW_MAX_ROUNDS, REVIEW_MIN_ROUNDS, checkTokenBudget, ensureGitBaseline, ensureIssueIds, errMsg, finalizeJob, isBlockedVerdict, loadKeyring, notify, notifyTask, pruneTasks, readProcStartTime, resolveResponseIds, rtOf, startWatchdog, taskView, viewStatus } from './index.js'

export function finalizeReview(task, status, verdict, error) {
  const first = finalizeJob(task, undefined, status, {
    verdict,
    error: typeof error === 'string' ? error : '',
  })
  // 首次落定才做的复核专属动作（#8-10）：摘要进 output（主 AI 必经通道）+ 落盘留档。
  if (first) {
    try { appendReviewIssuesBlock(task, { clipText }) } catch (e) { noteErr('review-issues-block', e) }
    try { persistReviewRecord(task) } catch (e) { noteErr('review-persist', e) }
  }
  return first
}

export async function captureReviewDirty(task) {
  try {
    if (task.dirtyAtStart === null || task.dirtyAtStart === undefined) return
    const end = await gitPorcelain(task.workdir)
    if (end === null) return
    const start = new Set(task.dirtyAtStart)
    const fresh = [...new Set(end)].filter((p) => !start.has(p)).sort()
    if (fresh.length === 0) return
    task.reviewDirty = { total: fresh.length, files: fresh.slice(0, 50) }
  } catch (e) { noteErr('review-dirty', e) }
}

export async function finishReview(task, status, verdict, error, notifyDone = true) {
  await captureReviewDirty(task)
  if (finalizeReview(task, status, verdict, error) && notifyDone) void notifyTask(task)
}

export function reviewRecord(task) {
  return {
    id: task.id,
    kind: 'review',
    status: viewStatus(task),
    verdict: typeof task.verdict === 'string' ? task.verdict : '',
    stopReason: typeof task.stopReason === 'string' ? task.stopReason : '',
    prevId: typeof task.prevId === 'string' ? task.prevId : '',
    // 回辩通道：本次调用的主 AI 回应原样留档（稳定 id 已解析、原文随行）；Codex 的逐轮
    // 裁决在 rounds[].responses，一问一答逐轮可追溯。不传 reply 的记录不含该键，形状与旧记录一致。
    ...(Array.isArray(task.reply) && task.reply.length > 0 ? { reply: task.reply } : {}),
    workdir: task.workdir,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    rounds: Array.isArray(task.rounds) ? task.rounds : [],
    // 独立来源可见性（2026-10-26，同 taskView）：只读证据，不参与任何判定。
    // 旧记录无这两键，读侧（handleReviewCreate 接力）一律按缺省容忍。
    independentSources: INDEPENDENT_SOURCES,
    quorumNote: QUORUM_NOTE,
    // 跨轮 ledger（2026-10-26）：稳定 id 的讨论状态账本（含接力种子与继承链），落盘可追溯。
    // ledgerBase = 链上轮号基数（接力时接续上一调用的最大 lastRound）。
    // 旧记录无这两键，读侧（handleReviewCreate 接力）一律按缺省 []/0 容忍。
    issueLedger: Array.isArray(task.issueLedger) ? task.issueLedger : [],
    ledgerBase: Number.isFinite(task.ledgerBase) ? task.ledgerBase : 0,
    // v2：i<N> 序号水位（单调递增，接力时接续上链最大号，防跨调用重号）。
    issueSeq: Number.isFinite(task.issueSeq) ? task.issueSeq : 0,
    reviewDirty: task.reviewDirty ?? null,
    error: typeof task.error === 'string' ? task.error : '',
  }
}

export function persistReviewRecord(task) {
  mkdirSync(REVIEWS_DIR, { recursive: true })
  atomicWriteFileSync(join(REVIEWS_DIR, `${task.id}.json`), `${JSON.stringify(reviewRecord(task), null, 2)}\n`)
  pruneReviewFiles()
}

export function cleanupReviewFiles(cutoff, stats) {
  let names
  try { names = readdirSync(REVIEWS_DIR) } catch { return }
  const running = new Set()
  for (const t of tasks.values()) {
    if (t !== null && typeof t === 'object' && t.kind === 'review' && t.status === 'running' && typeof t.id === 'string') running.add(t.id)
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (running.has(id)) continue
    const full = join(REVIEWS_DIR, name)
    try {
      const info = statSync(full)
      if (!info.isFile() || info.mtimeMs >= cutoff) continue
      unlinkSync(full)
      stats.removed += 1
      stats.freedBytes += info.size
    } catch { /* 跳过瞬时错误 */ }
  }
}

export function loadReviewRecord(id) {
  if (typeof id !== 'string' || !REVIEW_ID_PATTERN.test(id)) return null
  try {
    const doc = JSON.parse(readFileSync(join(REVIEWS_DIR, `${id}.json`), 'utf8'))
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.rounds)) return null
    return doc
  } catch { return null }
}

export async function handleReviewsList(req, res) {
  try {
    const limitRaw = Number(queryParam(req.url, 'limit'))
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 20
    const records = []
    let names
    try { names = readdirSync(REVIEWS_DIR) } catch { names = [] }
    for (const name of names) {
      if (typeof name !== 'string' || !name.endsWith('.json')) continue
      const rec = loadReviewRecord(name.slice(0, -'.json'.length))
      if (rec !== null) records.push(rec)
    }
    records.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))
    send(res, { ok: true, count: records.length, limit, reviews: records.slice(0, limit) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function runReview(task, active) {
  const envKey = `${active.id.toUpperCase()}_API_KEY`
  // 硬预算（2026-10-03 补）：墙钟与累计 token 任一先到即停。
  // "无新增即收敛"降级为**提前停止的一种**，不再是唯一终止条件。
  const wallMs = Number.isFinite(task.wallMs) && task.wallMs >= REVIEW_MIN_WALL_MS ? task.wallMs : REVIEW_DEFAULT_WALL_MS
  const tokenLimit = Number.isFinite(task.tokenLimit) && task.tokenLimit >= REVIEW_MIN_TOKEN_LIMIT ? task.tokenLimit : REVIEW_DEFAULT_TOKEN_LIMIT
  const startedAt = Date.now()
  const seenHashes = new Map()   // issuesHash → round，振荡检测用
  let tokensUsed = 0
  // #6：复核窗口的起点快照（null=非 git 仓库/探测失败，收尾时无从比对则静默跳过）。
  task.dirtyAtStart = await gitPorcelain(task.workdir)
  try {
    for (;;) {
      if (task.status === 'cancelled' || rtOf(task).isCancelled()) break
      const round = task.rounds.length + 1
      if (round > task.maxRounds) break
      task.round = round
      // ── 进轮前先判硬预算（第一轮不拦：连一轮都没跑就停没有意义）──
      if (round > 1) {
        if (Date.now() - startedAt >= wallMs) {
          task.stopReason = 'wallclock'
          await finishReview(task, 'done', 'wallclock')
          return
        }
        if (tokensUsed >= tokenLimit) {
          task.stopReason = 'tokens'
          await finishReview(task, 'done', 'tokens')
          return
        }
      }
      // ① 接力链（#8-10）：首轮 prev 用上一轮复核任务带来的种子（task.prevSeed，
      // 由 handleReviewCreate 从 body.prev 解析）；确认上轮问题 ≠ 振荡，种子不进 seenHashes。
      const prev = task.rounds.length > 0 ? task.rounds[task.rounds.length - 1] : (task.prevSeed ?? null)
      const prevIssues = prev && Array.isArray(prev.issues) ? prev.issues : []
      // 回辩通道（稳定 id 版）：reply 条目带稳定 issueId，第 2 轮起 prev 换批后仍对得上
      // 号，故每轮都注入（旧版只注首轮——轮内下标第 2 轮就失配，这是本次修的病根）。
      const prompt = buildReviewPrompt(task.content, prev, task.reviewContext, task.dialogue === true ? task.reply : undefined)
      const outPath = join(CODEX_DIR, `review-${task.id}-r${round}.out`)
      rtOf(task).setOutPath(outPath)
      // 新一轮：重置活动时间，看门狗从本轮 spawn 起算 300s。
      rtOf(task).heartbeat()
      const { child, wait, getUsage } = spawnReviewRound({ prompt, workdir: task.workdir, envKey, apiKey: active.apiKey, outPath })
      rtOf(task).setChild(child)
      // 互审的探活身份：startWatchdog 在首轮 spawn 前就启动（那时 child 还是 null）记不到
      // pid —— 每轮 spawn 后补记；轮间空窗（child 已退、下一轮未起）清掉，
      // 否则对账 tick 会把已退出的旧 pid 误判成失联、误杀多轮复核。
      rtOf(task).setChildPid(Number.isInteger(child.pid) ? child.pid : null)
      rtOf(task).setChildStart(rtOf(task).getChildPid() === null ? null : readProcStartTime(rtOf(task).getChildPid()))
      // 单轮墙钟兜底：硬预算只在循环顶部检查，若首轮 codex 挂死（进程活着不退出），
      // await wait 永不返回 → 30 分钟硬预算形同虚设。到点强杀本轮子进程。
      const roundWallMs = wallMs - (Date.now() - startedAt)
      let wallTimer = null
      if (roundWallMs > 0) {
        wallTimer = setTimeout(() => {
          task.wallHit = true
          try { child.kill('SIGKILL') } catch { /* best effort */ }
        }, roundWallMs)
        if (typeof wallTimer.unref === 'function') wallTimer.unref()
      } else {
        // 2026-10-31 修：预算在本轮开始前就已耗尽（轮间把 30 分钟吃满）时，原先"不装 timer
        // 直接 await wait"等于零兜底 —— 子进程一挂死，硬预算就彻底失效。这里立即按墙钟到点
        // 处理；下面 task.wallHit === true 的分支会正常收尾（stopReason='wallclock'）。
        task.wallHit = true
        try { child.kill('SIGKILL') } catch { /* best effort */ }
      }
      const code = await wait
      if (wallTimer !== null) clearTimeout(wallTimer)
      // 本轮 codex 自报用量累加进总账（抽不到记 0 —— 宁可少算也不误停）。
      const roundTokens = getUsage()
      tokensUsed += roundTokens
      task.reviewTokens = tokensUsed
      if (roundTokens === 0) task.usageUnknown = true
      rtOf(task).setChild(null)
      rtOf(task).setChildPid(null)
      rtOf(task).setChildStart(null)
      rtOf(task).setExitCode(rtOf(task).isCancelled() ? -1 : code)
      const raw = readReviewOut(outPath)
      // 墙钟到点被强杀：按 wallclock 正常收尾（而非落进下面的 unparsed 解析失败分支）。
      if (task.wallHit === true) {
        task.stopReason = 'wallclock'
        await finishReview(task, 'done', 'wallclock')
        return
      }
      if (task.status === 'cancelled' || rtOf(task).isCancelled()) break
      const parsed = parseReviewJson(raw, { isBlockedVerdict, clipText })
      if (!parsed.ok) {
        task.rounds.push({ round, issues: [], verdict: 'unparsed', raw: parsed.raw })
        await finishReview(task, 'error', 'unparsed', code === 0 ? '未能从复核输出解析出 JSON' : `codex 退出码 ${code}`)
        return
      }
      // 跨轮 ledger 并账（先并再判收敛）：本轮 issues 先归并（i<N> 沿用/分配）再按
      // responses 做状态迁移，落盘记录与终止判据用的是同一份状态。非回辩调用同样记账
      //（纯留痕，不参与判定）。responses 先过 resolveResponseIds：issueIndex 兼容下标
      // 就地补上账本 id（v1 哈希 id 在落账时经 aliases 命中）。
      const responses = resolveResponseIds(parsed.responses, prevIssues)
      mergeRoundIntoLedger(task, round, parsed.issues, responses)
      // issues 为空 → 本轮即收敛；否则记下本轮结论供下一轮对照。
      task.rounds.push({
        round,
        issues: parsed.issues,
        // 口径统一（2026-10-26）：issues 非空时不得记 converged —— 否则账本里出现
        // 「round.verdict=converged 却挂着 N 条问题」，与终止判据（按 issues.length 判）自相矛盾。
        // 阻断硬档优先记档：含「verdict=blocked 但 issues 为空」的形态——轮里也必须
        // 看得见是阻断，不得落成 converged。
        verdict: parsed.blocked === true
          ? 'blocked'
          : (parsed.issues.length === 0
            ? 'converged'
            : (parsed.verdict === 'converged' ? 'issues-found' : parsed.verdict)),
        // 回辩轮的逐条裁决：无 responses（旧式输出/非回辩轮）不写该键，轮次形状与旧版一致。
        ...(responses.length > 0 ? { responses } : {}),
      })
      // ── 阻断硬档（2026-10-26，secondop-panel BLOCK 档）：不可上线级问题必须停手，
      // 不是「再来一轮看看」。与 loop 同级：立即收尾、不再进后续轮次，也不走下面的
      // converged/回辩收敛判据。既有四档（converged/issues-found/rounds/unparsed）判定
      // 一行未动——block 是新增档，不是替换。
      if (parsed.blocked === true) {
        task.stopReason = 'blocked'
        await finishReview(task, 'done', 'blocked')
        return
      }
      if (parsed.issues.length === 0) {
        task.stopReason = 'converged'
        await finishReview(task, 'done', 'converged')
        return
      }
      // ── 回辩终止判据（稳定 id/ledger 版）：open 清零 且 无 upheld → converged ──
      // 只在带 reply 的调用里生效（task.dialogue），旧调用行为零改变。issues 里还挂着
      // 的条目就是 open，比旧下标判据（「无新增即收敛」）更严；仍受下方 maxRounds 与
      // 既有墙钟/token/振荡刹车约束。裁决与证据留在 rounds[].responses 与 issueLedger，
      // 主 AI 下一次带 reply 的调用就是下一句对话。
      if (task.dialogue === true && ledgerConverged(task.issueLedger, responses)) {
        task.stopReason = 'converged'
        await finishReview(task, 'done', 'converged')
        return
      }
      // ── 振荡检测：本轮 issues 与历史某轮完全一致 → 判循环、立即停 ──
      const h = issuesHash(parsed.issues)
      if (seenHashes.has(h)) {
        task.stopReason = 'loop'
        task.loopWithRound = seenHashes.get(h)
        await finishReview(task, 'done', `loop(与第 ${seenHashes.get(h)} 轮相同)`)
        return
      }
      seenHashes.set(h, round)
      if (round >= task.maxRounds) {
        // 轮数用尽仍有问题：最后一轮 issues 已在 rounds 里，打包交用户裁决。
        task.stopReason = 'rounds'
        await finishReview(task, 'done', 'max-rounds')
        return
      }
    }
    // 走到这里只可能是被取消（cancelled → 熔断退出）。取消是用户主动动作，不补通知。
    task.stopReason = 'cancelled'
    await finishReview(task, 'cancelled', 'cancelled', undefined, false)
  } catch (e) {
    // 经 finishReview 收口：重复落定不再重复通知（旧版 catch 里是无条件 notify）。
    await finishReview(task, 'error', 'error', errMsg(e))
  }
}

export async function handleReviewCreate(req, res) {
  try {
    if (!checkTokenBudget(res)) return
    const body = await readBody(req)
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (content === '') return send(res, { ok: false, error: 'content 不能为空' }, 400)
    const doc = loadKeyring()
    // 缺省轮数取配置（keyring 顶层 reviewRounds）；显式传 body.rounds 仍可覆盖。
    const requested = body.rounds === undefined || body.rounds === null ? doc.reviewRounds : Number(body.rounds)
    if (!Number.isFinite(requested) || Math.floor(requested) < REVIEW_MIN_ROUNDS) {
      return send(res, { ok: false, error: `rounds 必须是 ${REVIEW_MIN_ROUNDS}..${REVIEW_MAX_ROUNDS} 的整数` }, 400)
    }
    const maxRounds = Math.min(REVIEW_MAX_ROUNDS, Math.floor(requested))
    const active = doc.providers.find((p) => p.id === doc.active)
    if (active === undefined) return send(res, { ok: false, error: '没有可用的 active 提供方' }, 400)
    // 复核与 task 对齐（2026-10-25 修复）：接受 body.workdir，缺目录直接 400。
    // 旧版缺目录时静默退回 ~/.codex —— 那里是 keyring.json / sessions / *.sqlite，
    // 评审进程的 cwd 会落进密钥目录：语境错位，且"不读凭据"只能靠提示词去防。
    // 固定 'codex'（2026-11-04）：复核恒走 codex exec（registry.js:50 review:true，
    // pi 侧 review:false），不能跟 activeEngineId() —— 否则 activeEngine=pi 时
    // 工作区指向 ~/pi-workspace，但真正执行复核的仍是 Codex，二者错位。
    const workdir = typeof body.workdir === 'string' && body.workdir.trim() !== ''
      ? body.workdir.trim()
      : taskWorkdirForEngine('codex')
    if (!existsSync(workdir)) {
      return send(res, { ok: false, error: `workdir 不存在：${workdir}` }, 400)
    }
    // #6（2026-10-25）：与 task 路径对齐——无版本控制的 workdir 先打基线 commit
    //（幂等；已有 .git 的活仓库这里是空操作，窗口证据改由快照差集负责，见 runReview）。
    await ensureGitBaseline(workdir)
    mkdirSync(CODEX_DIR, { recursive: true })

    // ① 接力链（#8-10）：body.prev = 上一轮复核任务 id → 取其末个非空 issues 轮作首轮对照。
    // 查找顺序：内存 tasks Map → ~/.codex/reviews 落盘记录（跨重启接力）。
    const prevId = typeof body.prev === 'string' ? body.prev.trim() : ''
    let prevSeed = null
    // 跨轮 ledger 接力（2026-10-26 v2）：上一调用的账本随 prev 一起带过来——open/disputed
    // 条目继续挂账，轮号接续（ledgerBase = 上链最大 lastRound）、序号接续（issueSeq =
    // 上链最大 i<N>），讨论跨调用一条线。v1 记录就地迁移：哈希 id → i<N>，原哈希进 aliases。
    let issueLedger = []
    let ledgerBase = 0
    let issueSeq = 0
    if (prevId !== '') {
      if (!REVIEW_ID_PATTERN.test(prevId)) {
        return send(res, { ok: false, error: 'prev 必须是复核任务 id（时间戳-十六进制串）' }, 400)
      }
      const prevTask = tasks.get(prevId)
      if (prevTask !== undefined && prevTask.kind !== 'review') {
        return send(res, { ok: false, error: `任务 '${prevId}' 不是复核任务，不能作为 prev` }, 400)
      }
      const prevRecord = prevTask !== undefined ? null : loadReviewRecord(prevId)
      const prevRounds = prevTask !== undefined
        ? (Array.isArray(prevTask.rounds) ? prevTask.rounds : null)
        : (prevRecord?.rounds ?? null)
      if (prevRounds === null) {
        return send(res, { ok: false, error: `prev 复核任务不存在：${prevId}` }, 400)
      }
      // 从末轮往前找第一个还有未决问题的轮；全收敛 = 无可接力，种子留空照常开跑。
      // 种子 issues 一律 ensureIssueIds 归一化：v1 记录的哈希 id 留在 legacyId，
      // 开账时收进 aliases；账本 id（i<N>）由开账/归并指派（见下）。
      for (let i = prevRounds.length - 1; i >= 0; i -= 1) {
        const r = prevRounds[i]
        if (r !== null && typeof r === 'object' && Array.isArray(r.issues) && r.issues.length > 0) {
          prevSeed = { issues: ensureIssueIds(r.issues) }
          break
        }
      }
      const prevLedgerRaw = prevTask !== undefined
        ? (Array.isArray(prevTask.issueLedger) ? prevTask.issueLedger : [])
        : (prevRecord !== null && Array.isArray(prevRecord.issueLedger) ? prevRecord.issueLedger : [])
      if (prevLedgerRaw.length > 0) {
        // 全量迁移（含 resolved）后再滤：水位（ledgerBase/issueSeq）按整本账算，
        // 只把未了结条目挂进本任务账本。
        const normalized = normalizeLedgerEntries(prevLedgerRaw.map((e) => ({
          ...e,
          textHistory: Array.isArray(e?.textHistory) ? e.textHistory.slice() : [],
          aliases: Array.isArray(e?.aliases) ? e.aliases.slice() : [],
          mergedFrom: Array.isArray(e?.mergedFrom) ? e.mergedFrom.slice() : [],
        })))
        ledgerBase = normalized.reduce((mx, e) => Math.max(mx, Number(e?.lastRound) || 0), 0)
        issueSeq = normalized.reduce((mx, e) => Math.max(mx, Number(String(e?.id ?? '').slice(1)) || 0), 0)
        issueLedger = normalized.filter((e) => e.status !== 'resolved')
      } else if (prevSeed !== null) {
        // 旧格式记录没有 ledger：用种子 issues 现开账（轮号 0 = 接力种子轮）；
        // 种子自带的 v1 哈希 id 收进 aliases——用旧哈希 ID 回辩仍命中。
        issueLedger = normalizeLedgerEntries(prevSeed.issues.map((issue) => {
          const entry = ledgerEntryOf('', issue, 0)
          if (typeof issue.legacyId === 'string' && issue.legacyId !== '') entry.aliases.push(issue.legacyId)
          return entry
        }))
      }
      // 种子 issues 的 id 统一换成账本 id（i<N>）：首轮 prompt 与回辩池从此只见序号 id；
      // 已了结（不在账上）的种子保留原 id 不动。
      if (prevSeed !== null && Array.isArray(prevSeed.issues)) {
        const seedByRef = ledgerIndex(issueLedger)
        for (const issue of prevSeed.issues) {
          const key = typeof issue.id === 'string' && issue.id !== ''
            ? issue.id
            : (typeof issue.legacyId === 'string' ? issue.legacyId : '')
          const entry = key !== '' ? seedByRef.get(key) : undefined
          if (entry !== undefined) issue.id = entry.id
          delete issue.legacyId
        }
      }
    }

    // ── 回辩通道（稳定 id 版）：body.reply = 主 AI 对既有意见的逐条回应 ──
    // 形状 [{issueId, decision:'accepted|partial|rejected', reason}]（issueId 优先；
    // 兼容旧 issueIndex = prev 末轮未决意见的下标，缺省用数组下标，二者同时给且冲突
    // 时以 issueId 为准）。可用 id 池 = 种子 issues 的 id ∪ 接力 ledger 里未了结
    // （open/disputed）条目的 id——任意轮提出、任意一次调用留下的意见都对得上号。
    // 形态不对一律 400 明说，不静默忽略——主 AI 必须知道它的回应有没有被讨论通道接住。
    // 空数组视为未传。
    let reply = null
    if (body.reply !== undefined && body.reply !== null) {
      if (!Array.isArray(body.reply)) {
        return send(res, { ok: false, error: 'reply 必须是数组：[{issueId, decision, reason}]（兼容 issueIndex）' }, 400)
      }
      if (body.reply.length > 0) {
        const openCount = issueLedger.filter((e) => e.status !== 'resolved').length
        if (prevId === '' || (prevSeed === null && openCount === 0)) {
          return send(res, { ok: false, error: 'reply 需要配合 prev（上一轮仍有未决问题的复核 id）' }, 400)
        }
        const seedIssues = prevSeed !== null && Array.isArray(prevSeed.issues) ? prevSeed.issues : []
        const seedIds = seedIssues.map((i) => i.id).filter((id) => typeof id === 'string' && id !== '')
        const replyByRef = ledgerIndex(issueLedger)
        // 可用 id 池 = 种子 id ∪ 未了结条目的 i<N> 及其 aliases（v1 哈希）——任意轮
        // 提出、任意一次调用留下的意见都对得上号。
        const pool = new Set(seedIds)
        for (const e of issueLedger) {
          if (e.status === 'resolved') continue
          pool.add(e.id)
          for (const a of e.aliases) pool.add(a)
        }
        const byId = new Map()
        for (const entry of normalizeReply(body.reply)) {
          let ref = typeof entry.issueId === 'string' && pool.has(entry.issueId) ? entry.issueId : ''
          if (ref === '' && Number.isInteger(entry.issueIndex) && entry.issueIndex >= 0 && entry.issueIndex < seedIds.length) {
            ref = seedIds[entry.issueIndex]
          }
          if (ref === '') continue
          // 命中后统一收敛到账本 id（i<N>）：prompt 与 ledger 从此只见序号 id。
          const canonical = replyByRef.get(ref)?.id ?? ref
          byId.set(canonical, {
            issueId: canonical,
            ...(Number.isInteger(entry.issueIndex) ? { issueIndex: entry.issueIndex } : {}),
            decision: entry.decision,
            reason: entry.reason,
            // 原文随行：第 2 轮起 prev 换批后，prompt 里仍能显示该 id 指什么。
            point: clipText(String(replyByRef.get(canonical)?.point ?? ''), 300),
          })
        }
        if (byId.size === 0) {
          const ids = [...new Set([...seedIds, ...issueLedger.filter((e) => e.status !== 'resolved').map((e) => e.id)])]
          const sample = ids.slice(0, 8).map((x) => `<${x}>`).join('、')
          const indexHint = seedIds.length > 0 ? `；或 issueIndex #0..#${seedIds.length - 1}` : '（本次种子为空，只能用 issueId）'
          return send(res, { ok: false, error: `reply 没有能对上 prev 意见的条目（可用 issueId：${sample}${ids.length > 8 ? '…' : ''}${indexHint}）` }, 400)
        }
        reply = [...byId.values()]
      }
    }

    const id = newId()
    const task = {
      id,
      kind: 'review',
      status: 'running',
      round: 0,
      maxRounds,
      rounds: [],
      verdict: '',
      error: '',
      content,
      // ① 接力链：谱系（prevId 进 taskView 与落盘记录）+ 首轮对照种子。
      prevId,
      prevSeed,
      // 跨轮 ledger（2026-10-26）：稳定 id 的讨论账本（含接力种子与继承链）；
      // ledgerBase = 链上轮号基数（接力时接续上一调用的最大 lastRound）。
      issueLedger,
      ledgerBase,
      // v2：i<N> 序号水位（接力时已接续上链最大号；mergeRoundIntoLedger 内自增分配）。
      issueSeq,
      // 回辩通道：主 AI 的逐条回应（已按稳定 id 解析、原文随行）；dialogue 标记本次
      // 调用启用回辩终止判据（见 runReview）。不传 reply 时两键都不存在。
      ...(reply !== null ? { reply, dialogue: true } : {}),
      reviewContext: buildReviewContext({ workdir, maxRounds }),
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      workdir,
      child: null,
      outPath: '',
      cancelled: false,
      stuckSuspect: false,
      // P1.1 心跳：复核逐轮走 exec，活性由该轮 -o 文件 mtime 兜底（此值保持 0）。
        // 硬预算（可由配置覆盖）—— runReview 里再用缺省值兜底。
      wallMs: doc.reviewWallMs,
      tokenLimit: doc.reviewTokenLimit,
    }
    tasks.set(id, task)
    pruneTasks()
    startWatchdog(task)
    void runReview(task, active)
    // 不传 reply 时键集与旧版完全一致（replyAccepted 只在回辩调用出现）。
    send(res, {
      ok: true,
      id,
      maxRounds,
      ...(prevId !== '' ? { prev: prevId, prevSeeded: prevSeed !== null } : {}),
      ...(reply !== null ? { replyAccepted: reply.length } : {}),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export async function handleReviewCancel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    if (task.kind !== 'review') return send(res, { ok: false, error: `任务 '${id}' 不是复核任务` }, 400)
    if (task.status !== 'running') {
      return send(res, { ok: false, error: `复核已结束（${task.status}），无需取消` }, 400)
    }
    // 先置熔断标记：循环每轮结束（及下一轮 spawn 前）都会检查，确保不再推进。
    rtOf(task).setCancelled()
    // P2：不预置 status（终态归 finalizeJob）；verdict 是复核裁决标记，与任务状态无关，保留。
    task.verdict = 'cancelled'
    const child = rtOf(task).child()
    if (child !== null && child !== undefined) {
      try { child.kill('SIGTERM') } catch { /* 进程可能刚好自己退出 */ }
      // 同 /task/cancel：codex 偶有 SIGTERM 后残留，3s 兜底 SIGKILL，防子进程泄漏。
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch { /* best effort */ }
      }, 3000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }
    send(res, { ok: true, id, status: viewStatus(task) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

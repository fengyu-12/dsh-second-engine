import { spawnLimited, finishSpawnAudit } from './process-safety.js'
import { tokenTotal, recordTokens, budgetGate } from './token-ledger.js'
// dsh-second-engine —— DeepSeek Harness 的 Codex 二元引擎插件。
//
// 进程内提供：设置页所需的 HTTP API（经 webServer 注册为 exact 路由）
//   GET    /second-engine/api/status            引擎/密钥/会话占用概览
//   GET    /second-engine/api/providers         提供方列表（apiKey 脱敏）+ active
//   POST   /second-engine/api/providers         新增自定义提供方
//   POST   /second-engine/api/providers/key     设置指定提供方 apiKey { id, apiKey }（keyring 0600）
//   POST   /second-engine/api/providers/active  切换激活并生成 config.toml（先备份）{ id }
//   POST   /second-engine/api/providers/delete  删除自定义提供方（预设不可删）{ id }
//   POST   /second-engine/api/providers/update  编辑提供方 { id, name?, baseUrl?, wireApi?, apiKey? }（apiKey 省略=不改；active 改地址/模型时重写 config.toml）
//   POST   /second-engine/api/models            拉取该提供方 /models 模型清单 { id? }（缺省 active）
//   POST   /second-engine/api/model             更新该提供方 model { id, model }（active 时重写 config.toml）
//   POST   /second-engine/api/key               兼容旧面板：给预设提供方写 key { provider, key }
//   POST   /second-engine/api/cleanup           按 mtime 清理旧会话 *.jsonl（body 带 codexLogs:true 时顺带清 Codex logs_2.sqlite）
//   POST   /second-engine/api/task              下发异步工单（后台 codex exec，完成弹 App 通知；ephemeral 缺省 true）
//   GET    /second-engine/api/task?id=          单条工单全量（含 output）
//   GET    /second-engine/api/tasks             最近 10 条工单摘要（不含 output）
//   POST   /second-engine/api/task/cancel       取消运行中的工单 { id }（SIGTERM）
//   POST   /second-engine/api/review            双向互审：对产出做多轮批判性复核（kind:'review'；可带 prev=<上一轮复核id> 接力；可带 reply=[{issueId,decision,reason}] 按账本序号 id（i<N>）逐条回辩——任意轮可用、映射进跨轮 issue ledger；兼容 v1 哈希 id（经 aliases 命中）与旧 issueIndex）
//   POST   /second-engine/api/review/cancel     熔断取消复核任务 { id }（SIGTERM）
//   GET    /second-engine/api/reviews?limit=    复核历史（~/.codex/reviews 持久化记录，倒序）
//   GET    /second-engine/api/config            读插件配置（复核轮数 reviewRounds）
//   POST   /second-engine/api/config            写插件配置 { reviewRounds: 1|3|5 }
//   POST   /second-engine/api/consult           Codex 卡点求助入队 { from, task, taskId?, stuckContext }（内存 20 条 + 弹 App 通知）
//   GET    /second-engine/api/consults          求助列表（不脱敏，给主 AI 收卷）
//   GET    /second-engine/api/version           本机 codex 版本 vs GitHub 最新 release（updateAvailable）
//   GET    /second-engine/api/plugin-version    插件自身版本 vs GitHub 最新 release（失败静默，无更新不提示）
//   GET    /second-engine/api/websearch         读 config.toml 顶层 web_search（无则 disabled）
//   POST   /second-engine/api/websearch         写 web_search { value: disabled|cached|indexed|live }
//   GET    /second-engine/api/mcp               config.toml 全部 [mcp_servers.*] 段
//   POST   /second-engine/api/mcp               新增 [mcp_servers.<name>] { name, url }（重名 409）
//   POST   /second-engine/api/mcp/<name>         启用/禁用该 MCP { enabled: bool }（保留配置段；Codex 官方 enabled 字段）
//   DELETE /second-engine/api/mcp/<name>        删除该段（不存在 404）
//   GET    /second-engine/api/_meta            路由自描述：遍历注册表生成 {method,path,desc}（method/desc 已内联进条目）
// 以及 rc.7 插件自有设置表面：settings 命名空间 'second-engine'（keepDays）与
// llm 的可配置 provider 目录条目，二者缺一浏览器端设置页都不渲染本插件面板。
// 请求体与响应均为 JSON，handler 用原生 node:req/res 风格。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync, chmodSync, readFileSync, copyFileSync, utimesSync, renameSync, openSync, fstatSync, readSync, closeSync, createWriteStream, accessSync, constants } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { registerBridgeRoutes } from './bridge-routes.js'
import { normalizeTaskRequest, buildReport, publishTaskReport } from './engine/task-port.js'
import { engineOf, activeEngineId, ENGINES, engineList, setActiveEngineId, cleanupTarget } from './engine/registry.js'
import { piProbe, piAvailableModels, resolvePiProvider as resolvePiProviderRaw, invalidatePiModelsCache, PI_PROVIDERS, PI_MODELS_PATH } from './engine/pi-probe.js'
import { piBridgeStatus, startPiBridge, stopPiBridge, piBridgeUrl, PI_BRIDGE_PORT } from './engine/pi-bridge.js'
import http from 'node:http'
import { join, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createBridgeServer } from './bridge.js'
import { startAppServerTurn } from './app-server-client.js'
import { resolveCollab, collabPreset, writeCollab } from './collab.js'
import { createHash, randomBytes } from 'node:crypto'
import { WIRE_API, CODEX_DIR, CONFIG_PATH } from './constants.js'
import { normalizeProvider, normalizeReviewRounds, normalizeReviewWallMs, normalizeReviewTokenLimit, normalizeIssue, normalizeReply, normalizeResponses, normalizeLedgerEntries, issueFingerprintOf,
  REVIEW_DEFAULT_ROUNDS, REVIEW_ROUNDS_CHOICES, REVIEW_DEFAULT_WALL_MS, REVIEW_DEFAULT_TOKEN_LIMIT, REVIEW_MIN_WALL_MS, REVIEW_MIN_TOKEN_LIMIT,
  asText, ISSUE_REF_RE, REPLY_REASON_CLIP, RESPONSE_REASON_CLIP, LEDGER_ID_RE } from './normalize.js'
import { noteErr, atomicWriteFileSync, send, readConfigRaw, ERR_LOG } from './core.js'
import { policyWatchPending, policyWatchDelivered, startPolicyWatch, loadPolicyWatchState, persistPolicyWatchState, policyWatchErr, POLICY_WATCH_DELIVERY_COOLDOWN_MS, POLICY_WATCH_FRESH_MS } from './policy-watch.js'
import { diagnoseMood, lastUserText, buildMoodMessage, MOOD_COOLDOWN_MS } from './mood-watch.js'
import { readHintToggles, writeHintToggles } from './hint-toggles.js'
import { REVIEWS_DIR, tasks, TASK_KEEP_LIMIT } from './state.js'
import { canonicalIssueText, pointJaccard, resolveCodexBinary, buildReviewContext, wrapReviewMaterial, buildReviewPrompt, spawnReviewRound, readReviewOut, mergeRoundIntoLedger } from './review-core.js'
import { finalizeReview, captureReviewDirty, finishReview, reviewRecord, persistReviewRecord, cleanupReviewFiles, loadReviewRecord, handleReviewsList, runReview, handleReviewCreate, handleReviewCancel } from './review-handlers.js'
import { execMode, keyConfigured, sessionsBytes } from './pi-misc.js'
import { piRuntimeModel, piWithPathLock, piWriteJson, piApiFromWire, piWireFromApi, piLooksLikeApiKey, piRejectKeyAsModel, piProvidersSnapshot, piChannelApiOf, piProvidersList, piProviderAdd, piProviderIdError, piProviderKey, piProviderActive, piProviderDelete, piProviderUpdate, piModels, piModelsEmptyReason, piProviderModel, piProvidersRoot, piMcpServers } from './pi-providers.js'
import { handlePiPanel, handlePiChannelCreate, handlePiModelSet, handlePiBridge, handlePiCleanup, handlePiChannelDelete, handlePiMcpList, handlePiMcpAdd, handlePiMcpDelete, handlePiMcpToggle } from './pi-panel.js'
import { handleStatus, handleExperimentalWake, handleKey, handleProvidersList, handleProviderAdd, handleProvidersRoot, handleProviderKey, handleProviderActive, handleProviderDelete, handleProviderUpdate } from './routes-a.js'
import { handleTaskGet, handleTaskList, handleTaskRoot, handleConfigGet, handleConfigRoot, handleHintToggles, handleConsultsList, handleWebSearchGet, handleWebSearchSet, handleWebSearchRoot, handleMcpList, handleMcpAdd, handleMcpDelete, handleMcpToggle, handleMcpRoot, handlePluginVersion } from './routes-misc.js'
import { handleModels, startAppServerTask, startPiTask, handleTaskCancel } from './task-lifecycle.js'
import { baseNameOf, prunePiBackups, cleanupSessions, pruneReviewFiles, REVIEW_KEEP_FILES, PI_BACKUP_KEEP } from './cleanup.js'
import { gitPorcelain, gitOk } from './git.js'
import { appendConsultBlock, appendReviewIssuesBlock, extractFirstJsonObject, extractMcpServerBlocks, extractModels, extractPreservedSections, extractPreservedTopLevelLines, issueTextFingerprint, issueTrigrams, issuesHash, ledgerConverged, ledgerEntryOf, ledgerIndex, parseReviewJson, parseTokensUsed, parseVersion } from './parse.js'
import { KEYRING_PATH, MAX_BODY_BYTES, CONFIG_BACKUP_KEEP, CONFIG_BACKUP_NAME_RE, TASK_OUTPUT_CLIP, CANCEL_RETRY_MS, CANCEL_FORCE_FINALIZE_MS, CANCEL_FORCE_FINALIZE_MESSAGE, newId, readBody, saveKeyring, backupConfig, readHeadTail, queryParam } from './io.js'

// The bridge is started by ctl.sh; pass the host API address through its inherited environment.
if (process.env.DSH_WEB_URL) process.env.BRIDGE_HOST_API_URL = process.env.DSH_WEB_URL

export const name = 'second-engine'

// mood-watch 冷却：每会话上次提醒时间，防刷屏（2026-11-02）
const moodWatchLastAt = new Map()
const moodWatchAborts = new Map() // 每会话最近的用户打断时间戳数组（单次无害，只统计频次）
const MOOD_KEEP_LIMIT = 50 // 照抄 policy-watch 的 FIFO 淘汰：只留最近 50 个活跃会话，防 Map 无限增长
const MOOD_ABORT_WINDOW_MS = 10 * 60 * 1000 // 频次窗口：10 分钟
const MOOD_ABORT_TRIGGER = 2 // 窗口内被打断 ≥2 次才提示（单次多为无害的口头打断）

// P4.26（2026-10-29）：AGENTS.md 的写入目标不只有 Codex。
// Pi 同样认 AGENTS.md：全局在 agentDir（~/.pi/agent/AGENTS.md），项目级从 cwd 向上逐级查找；
// 两引擎写同一段协作文案，各文件里的成对标记保证幂等、互不干扰。
const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
function agentsTargets() {
  return [join(CODEX_DIR, 'AGENTS.md'), join(PI_AGENT_DIR, 'AGENTS.md')]
}
export const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

// 首次初始化写入的三家预设（apiKey 空，待设置页填写）。
const PRESET_PROVIDERS = [
  // DeepSeek 官方文档实证的上下文/输出上限，写 config.toml 顶层（见 writeCodexConfig）。
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', model: 'deepseek-flash', contextWindow: 1048576, maxOutput: 393216 },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/v1', wireApi: 'responses', model: 'glm-4.6' },
]
export const PRESET_IDS = new Set(PRESET_PROVIDERS.map((p) => p.id))
export const DEFAULT_ACTIVE = PRESET_PROVIDERS[0].id
// Codex 侧永远讲 Responses（config.toml 的 wire_api 恒为它），
// 'completions' 提供方由本地翻译桥转接（见 ensureBridge）。
const SUPPORTED_WIRE_APIS = new Set(['responses', 'completions'])
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/
// config.toml 顶层 web_search：Codex 原生联网搜索档位（二进制 WebSearchMode 枚举实证）。
// disabled=关闭，live=开启；cached/indexed 是中间档，面板只暴露 disabled/live 两档。
export const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live']
const DEFAULT_WEB_SEARCH = 'disabled'
// MCP 段名：限定字符集堵住段头注入（换行/']'/引号都进不来）。
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

// ── 异步工单 ──
// 进程内任务表：{ id, status:'running'|'done'|'error', exitCode, output, startedAt, endedAt, workdir }。
// 另外挂 child（进程句柄，取消用）与 outPath（-o 落点，读完输出后删除）；这两项不外发。
const TOKEN_LEDGER_PATH = join(homedir(), '.codex', 'second-engine-token-ledger.jsonl')
let tokenLedgerError = null
export function checkTokenBudget(res) {
  try {
    if (tokenLedgerError) throw new Error(tokenLedgerError)
    const accounting = budgetGate(TOKEN_LEDGER_PATH, process.env.SECOND_ENGINE_TOKEN_BUDGET)
    if (accounting.blocked) {
      send(res, { ok: false, error: '跨工单 token 预算已耗尽（unknown 用量未包含在已知总数中）', accounting }, 429)
      return false
    }
    return true
  } catch (e) {
    send(res, { ok: false, error: `成本账本不可用：${errMsg(e)}` }, 400)
    return false
  }
}
function accountJob(task) {
  const source = task.engine === 'pi' ? 'pi-session-stats' : task.mode === 'appserver' ? 'appserver-total' : 'codex-exec'
  let tokens = task.accountedTokens ?? null
  if (task.engine === 'pi') {
    const stats = rtOf(task).snapshot().details?.stats
    tokens = tokenTotal(stats?.tokens ?? stats)
  }
  if (task.kind === 'review') tokens = task.usageUnknown ? null : (task.reviewTokens ?? null)
  if (source === 'codex-exec' && task.kind !== 'review') {
    const match = /tokens used\s*\n?\s*([\d,]+)/i.exec(task.usageTail ?? '')
    tokens = match ? tokenTotal(Number(match[1].replace(/,/g, ''))) : null
  }
  task.tokenUsage = { source, status: tokens === null ? 'unknown' : 'known', tokens, knownTokens: task.reviewTokens ?? tokens }
  try { recordTokens(TOKEN_LEDGER_PATH, task.id, source, tokens ?? task.reviewTokens ?? null, tokens === null) }
  catch (e) { tokenLedgerError = errMsg(e); noteErr('token-ledger', e) }
}
export const DEFAULT_TASK_WORKDIR = process.env.SECOND_ENGINE_WORKDIR || join(process.env.HOME || '/root', 'proj')
export const TASK_LIST_LIMIT = 10
// 过程流轮转阈值：live 文件超限即重开（从头写），长任务不把诊断流膨胀到 GB 级。
const LIVE_ROTATE_BYTES = 10 * 1024 * 1024


// ── Codex 卡点求助（consult）──
// 进程内队列：{ id, from, task, stuckContext, at }。只留最近 20 条，主 AI 定期收卷。
// 不落盘、不脱敏：这里是两个引擎之间的内部信道，不是给用户的展示面。
export const consults = []
export const CONSULT_KEEP_LIMIT = 20



// ── 吞错留痕（D，2026-10-25）──
// 原先大量 best-effort 分支裸 catch 静默吞错（「配置没写进去」无从排查）。统一去处：
// 环形缓冲最近 50 条 { t, tag, msg }，/api/status 暴露最近 10 条。
// 只存 tag 与脱敏后的短消息 —— 挂进来的调用点不碰密钥，keyring 内容不进缓冲；
// 脱敏正则兜第二层：sk- 令牌 / Bearer 凭证 / key|token|password|secret 赋值形态 → [redacted]。

// progress 排障旁路（2026-10-28）：归一化事件的 meta 原文环形上限（条/字节，两者都封）。
// 只存内存，不落盘、不进 taskView —— 引擎事件可能含模型/工具正文，不往 ERR_LOG（/status
// 会回显最近 10 条）那种对外通道里放。
export const ENGINE_EVENTS_LIMIT = 20
export const ENGINE_EVENTS_META_BYTES = 4096

const NOTIFY_URL = 'http://127.0.0.1:3090/app/notify'
const NOTIFY_TOKEN_PATH = process.env.DSH_BRIDGE_TOKEN_PATH || join(process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh'), '.bridge_token')
const NOTIFY_TIMEOUT_MS = 3000

// Provider selection is runtime/request (via preferredId) then Pi config default;
// the keyring is consulted by the probe only to fill the selected provider's key.
export function resolvePiProvider(preferredId = '') {
  if (preferredId !== '') return resolvePiProviderRaw(preferredId)
  let configured = ''
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'))
    configured = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : ''
  } catch { /* optional */ }
  return resolvePiProviderRaw(configured)
}

// ── 双向互审（review）──
// 每轮以固定模板要求独立复核引擎输出 JSON；轮数默认 3、上限 5。
export const REVIEW_MIN_ROUNDS = 1
export const REVIEW_MAX_ROUNDS = 5
// 设置页可选轮数（GET/POST /api/config 的白名单，仅这三档）。
// ⚠️ 首轮模板就是全部纪律所在：历史 16 条复核绝大多数只跑 1 轮（reviewRounds=1），而
// 「三态裁决 / 不许只写『我仍然认为』/ 未回应必须自行裁决」那一整套，只在带 reply 的第 2 轮起注入
// ⇒ 首轮这行才是 90% 复核真正看到的提示词（2026-10-26 实测）。三条硬要求（对照 secondop-panel 的
// SYSTEM 条款与 ICML AR 论文点名的「虚假共识」失败模式）：
//   ① 诚实条款：材料不足就明说并标 verified:false，不许用推测把句子填完整；
//   ② 只找缺陷：禁赞美、禁总结整体质量（否则退化成「整体不错，但有三点」的空转）；
//   ③ 必须交代核查依据：否则 `converged` 与「没读只目测」无法区分（对应 ISSUE：2600 行注释）。
const REVIEW_TEMPLATE =
  '你是独立复核引擎。只找缺陷：不要赞美、不要总结整体质量，只列具体问题'
  + '（自洽却错误的推理、漏掉的边界条件、更优备选、可复现的边界失败）。'
  + '材料不足以判断的那一条，明确写「这一条材料不足，未核实」并把它的 verified 标 false——'
  + '不要用推测把结论填完整。'
  + '每条 issue 必须给出你实际核查过的依据（文件:行号 / 命令 / 复现步骤），'
  + '禁止「建议加强测试」这类无定位的空话。'
  + '若判定无问题，必须写明你核查了哪几处之后才得出无问题，不得只回一个空 verdict。'
  + '发现不可上线级缺陷（涉及钱 / 数据丢失 / 安全漏洞）时：verdict 写 "blocked"，'
  + '该条 issue 的 severity 写 blocker——这是硬停档：此类问题不存在「再改一轮试试」，'
  + '必须立即停手交人裁决。'
  + '输出 JSON: {issues:[{severity,point,suggestion,verified}], verdict}'
// 看门狗间隔与阈值已随 P3.2 搬进 src/engine/runtime.js（WATCHDOG_INTERVAL_MS / WATCHDOG_STALL_MS）。
// 解析失败时回显的原始输出上限，避免把超长文本灌进任务表。
const REVIEW_RAW_CLIP = 2000
// 互审的硬预算缺省值（2026-10-03 补：此前只有轮数上限，"无新增即收敛"是**语义**条件，
// 两个 AI 在「主张 X / 反对 X」之间振荡时没有任何刹车，会一路烧到额度见底）。
// 两者都可在配置里覆盖（keyring 顶层 reviewWallMs / reviewTokenLimit）。
// ── 独立来源数（2026-10-26，对齐 secondop-panel 的 quorum 语义）──
// 双引擎 = 主 AI 写、Codex 复核 ⇒ 本插件实际能产出的独立复核家族恒为 1
//（secondop-panel 规则：写代码的模型可以发言，但永不计入 quorum）。所以 converged
// 只是单来源自洽，不是多来源共识。硬约束：这两个字段是只读证据（同 reviewDirty：
// 证据、非归因），不参与任何收敛/终止判定——不做成「不足就不许 converged」（那会让
// 双引擎永远无法收敛），只让来源数在写「已收敛」之前看得见。
export const INDEPENDENT_SOURCES = 1
export const QUORUM_NOTE = '1 个独立复核家族 < 建议下限 3，converged 仅代表单来源自洽'
// ── #8-10（2026-10-25）：复核记录持久化与接力 ──
// ~/.codex/reviews/<id>.json（0600 原子写）。双重清理从第一天接上（.live 的教训）：
// 写入时按数量截断（pruneReviewFiles）+ 定时/手动清理按 mtime 龄汰（cleanupReviewFiles）。
// 复核 id 形如 "<base36 时间戳>-<16 hex>"（newId）；接力与读档都先过这道闸，防路径注入。
export const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// 保留天数（设置页 keepDays）：宿主 settings 文档是持久真值，这里只放默认值。
const DEFAULT_KEEP_DAYS = 7
const MIN_KEEP_DAYS = 1
const MAX_KEEP_DAYS = 365

// 自动清理兜底：ephemeral 只是「缺省不落盘」，长线程/显式 false 的工单仍会写 sessions。
// 每 6 小时看一次：.live/task-*.out/review-*.out 过程产物、复核落盘、Codex logs_2.sqlite
// 无条件按 KEEP_DAYS 天前清（各自体量小、且与 sessions 总量无关）；只有 sessions 目录
// 总量超 MAX_BYTES 才动手（阈值内不扫不删，避免把手上正在跑的会话清掉）。
const AUTO_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const AUTO_CLEANUP_KEEP_DAYS = 7
const AUTO_CLEANUP_MAX_BYTES = 209715200
// 进程内句柄：apply 装上、disposer 清掉（同 bridgeServer 的生命周期写法）。
let autoCleanupTimer = null

function stopAutoCleanup() {
  const timer = autoCleanupTimer
  autoCleanupTimer = null
  if (timer === null) return
  try { clearInterval(timer) } catch { /* best effort */ }
}

// 兜底清理：sessionsBytes 自身绝不抛错，这里再兜一层，绝不影响宿主。
function runAutoCleanup() {
  try {
    const stats = { removed: 0, freedBytes: 0 }
    // C 项：`.live` 独立清理 —— 不受 sessions 体积门槛限制（它俩是两码事）。
    cleanupLiveFiles(Date.now() - AUTO_CLEANUP_KEEP_DAYS * 24 * 60 * 60 * 1000, stats)
    // #8-10：复核落盘记录同口径龄清（另带写入时数量截断，见 pruneReviewFiles）。
    cleanupReviewFiles(Date.now() - AUTO_CLEANUP_KEEP_DAYS * 24 * 60 * 60 * 1000, stats)
    // B：Codex 运行日志库同口径龄清 + 碎片超阈值才 VACUUM（安全闸见 cleanupCodexLogs）。
    // 不看 sessions 体积门槛 —— 那是 sessions 的事，logs_2.sqlite 的碎片和它无关。
    cleanupCodexLogs(AUTO_CLEANUP_KEEP_DAYS)
    if (sessionsBytes() <= AUTO_CLEANUP_MAX_BYTES) return
    cleanupSessions(SESSIONS_DIR, Date.now() - AUTO_CLEANUP_KEEP_DAYS * 24 * 60 * 60 * 1000, stats)
  } catch { /* best effort */ }
}

// 本插件的 settings 命名空间 scope，设置服务可用时才有值。
let secondEngineSettingsScope = null
// 进程内缓存的 keepDays 默认值（由 settings watch 镜像），供 /api/cleanup 兜底。
let keepDaysDefault = DEFAULT_KEEP_DAYS

// 本插件没有独立配置文件（settings 文档就是持久真值），因此 base 用默认值；
// 将来若引入 config.json，只需改这一个函数。
function readConfig() {
  return { keepDays: DEFAULT_KEEP_DAYS }
}

// ── node:http 小工具（同 guard 写法）──
export const errMsg = (e) => (e && e.message) ? e.message : String(e)





// status 轮询缓存：递归 stat 整棵 sessions 树不便宜（设置页/浮球会反复刷），
// TTL 内复用上次结果；runAutoCleanup 仍用新鲜的 sessionsBytes()。
const SESSIONS_BYTES_TTL_MS = 10000
let sessionsBytesCache = { at: 0, value: 0 }
export function sessionsBytesCached() {
  if (Date.now() - sessionsBytesCache.at < SESSIONS_BYTES_TTL_MS) return sessionsBytesCache.value
  sessionsBytesCache = { at: Date.now(), value: sessionsBytes() }
  return sessionsBytesCache.value
}

// 脱敏预览：前 6 后 4；过短的 key 只留首尾各 2 位
export function maskKey(key) {
  if (key.length <= 10) return `${key.slice(0, 2)}****${key.slice(-2)}`
  return `${key.slice(0, 6)}****${key.slice(-4)}`
}

// ── keyring（多提供方）──
// 形状：{ providers: [{ id, name, baseUrl, wireApi, apiKey, model }], active: '<id>', reviewRounds }
// reviewRounds 是本插件唯一落盘的配置项（复核轮数 1|3|5），随 keyring 一起读写。

function presetProviders() {
  return PRESET_PROVIDERS.map((p) => ({ ...p, apiKey: '' }))
}

// 归一化单条 provider：缺字段补默认值，调用方拿到的形状始终稳定。


// 复核轮数：只认 1/3/5，其余（含缺失、非法、字符串数字以外的垃圾值）一律回落默认 3。

// 互审硬预算（2026-10-03）：非法/缺失/过小一律回落缺省值 ——
// 宁可给个保守值，也不要"0 预算"把互审一进去就停。


// ── Codex 协作协议（AGENTS.md 自动写入）──
// 让 Codex 拥有「卡点求助本能」：连续失败/绕圈时主动调 /api/consult。
// A1/A2（2026-10-26）：幂等从「见标记就跳过」改为 voice 段的「摘除旧段→追加新段，内容不变才跳过」。
// 旧写法两个坑：① 模板内容的任何修订（如 DSH_WEB_URL 端口变更）对已注入的老用户永不生效；
// ② v1→v2 分支在末句锚未命中时会把 v1 段之后直到文件尾的内容静默丢弃（可能夹着用户手写段）。
// 段边界判定见 stripManagedSection 的三级降级。
const AGENTS_MARK = '<!-- dsh-second-engine:v2 -->'
const AGENTS_END = '<!-- /dsh-second-engine:v2 -->'
const AGENTS_V1_MARK = '<!-- dsh-second-engine:v1 -->'
const AGENTS_V1_END = '<!-- /dsh-second-engine:v1 -->'
// 求助地址：DSH Web 端口每次启动会变，写死 3080 在 43309 下必然连不通
// （2026-10-26 实测：3080→HTTP 000，43309→200），求助只能退回 [CONSULT-NEEDED] 文本兜底。
// ⚠️ 宿主进程**不注入** DSH_WEB_URL（那是 DSH 给工具子进程的），实测插件里 process.env.DSH_WEB_URL 为空
// ⇒ 唯一可靠来源是宿主自己的启动参数：`node .../dsh/lib/bin.js web --host 127.0.0.1 --port 43309`。
const AGENTS_BASE_URL = (() => {
  const env = process.env.SECOND_ENGINE_BASE_URL || process.env.DSH_WEB_URL
  if (typeof env === 'string' && env.trim() !== '') return env.trim().replace(/\/+$/, '')
  const argv = process.argv
  const pi = argv.indexOf('--port')
  if (pi !== -1 && /^\d+$/.test(argv[pi + 1] || '')) {
    const hi = argv.indexOf('--host')
    const rawHost = hi !== -1 ? String(argv[hi + 1] || '') : ''
    // 0.0.0.0 / :: 这类对外绑定对「本机自求助」不适用，统一走 loopback
    const host = rawHost === '' || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
    return `http://${host}:${argv[pi + 1]}`
  }
  return 'http://127.0.0.1:3080'
})()
// P4.26：Pi 的通知段用 Pi 的身份（标题与 from 字段），其余文案两引擎通用。
// 只替换这两处 —— 段里其它「Codex」字样出现在历史/对照语境，不影响 Pi 照做。
function agentsSectionFor(targetPath) {
  if (!String(targetPath).startsWith(PI_AGENT_DIR)) return AGENTS_SECTION
  return AGENTS_SECTION
    .replace('# Codex 全局协作协议（by dsh-second-engine）', '# Pi 全局协作协议（by dsh-second-engine）')
    .replace('"from":"codex"', '"from":"pi"')
}
const AGENTS_SECTION = `${AGENTS_MARK}
# Codex 全局协作协议（by dsh-second-engine）

- 你是 DeepSeek Harness（DSH）里的「第二引擎」执行体，由插件 dsh-second-engine 唤起；与主 AI（DSH）互为伙伴；派单、复核、验收都来自 DSH 主 AI，最终决策在用户。

卡点自救协议：
- 同一路径/命令连续失败 2 次、或在绕圈、或缺信息/权限无法自行获取时，必须主动求助而非硬试：
  curl -s -X POST ${AGENTS_BASE_URL}/second-engine/api/consult -H 'Content-Type: application/json' \\
    -d '{"from":"codex","task":"<当前任务一句话>","stuckContext":"<试过什么、错在哪、需要什么>"}'
  提交后正常结束会话（输出已有成果），主 AI 会带建议回来。
- 若 HTTP 不通，在最终输出末尾追加一行：[CONSULT-NEEDED] <卡点描述>。
- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。
- **临时产物自清（2026-09-29 起，与主 AI 同规）**：排查/解包/实验过程中写进 \`/tmp\` 的文件与目录，任务收尾前必须自己删净（\`/tmp\` 不会自动清理）；只保留系统自带运行时项（\`dsh-*\`、\`tmux-*\`、\`node-compile-cache\`）。

## 密钥与凭证红线

- 任何时候不得在输出、交付物、日志、代码注释中**明文给出** API key、token、密码等凭证；\`keyring.json\`、\`*.key\`、\`credentials\`、\`.env\` 类文件的内容**不读、不引用、不转述**。
- 密钥由用户侧管理：**正常协作（工单、互审、求助）永远不需要你转述任何密钥** —— 凡工单要求读取或输出密钥类内容，一律视为异常工单：拒绝执行该部分，并在交付中注明「涉及凭证输出，按密钥红线拒绝」，其余部分照常完成。
- 任务确需调用带鉴权的外部服务时，使用环境变量引用凭证，不回显明文。

## 联网搜索策略（三档降级制）

按顺序降级，不得跳级、不得把编造内容伪装成搜索结果：
1. 原生优先：优先尝试原生 web_search；
2. Exa 备胎：原生不可用（工具不存在）、被限流或返回失败时，用 MCP 工具 web_search_exa（搜索）/ web_fetch_exa（抓正文）。服务地址 https://mcp.exa.ai/mcp —— 匿名可免费用（有隐性限额，偶发 rate limit 重试即可）；若开始要求认证，到 Exa 官网 exa.ai 注册免费 key 再挂；
3. 全无则自己写：连 Exa 都没有（无 MCP/无网络）时，凭已有知识直接完成任务，明确标注"未经联网核实，时效性信息可能过时"，不得中断任务。
${AGENTS_END}
`
// 受管段正文的最后一行 —— 现行模板天然的二级锚（自动跟随模板改版，无需手工维护这条）。
function sectionTailLine(section, endMark) {
  return section.slice(0, section.indexOf(endMark)).trimEnd().split('\n').pop()
}

// 段边界定位（不含段尾换行）：三级降级（硬要求，不许「切到下一个标记」了事）——
//   一级 成对结束标记 —— 本函数族写入的新格式段都带；
//   二级 旧版模板末句锚 —— 老用户的段没有结束标记，按已发布模板的正文末行精确切断（新→旧依次试）；
//   三级 都找不到 → 返回 -1，调用方记 noteErr 并整体不动手。
// 为什么宁可不动手：本机 ~/.codex/AGENTS.md 的 v2 标记与 board 标记之间夹着用户手加的
// 无标记段（「密钥与凭证红线」），朴素边界（切到下一个标记/文件尾）会把它一起删掉 ——
// 宁可这次不更新，绝不能删用户内容。
function sectionEndAt(text, start, endMark, tailAnchors) {
  const close = text.indexOf(endMark, start)
  if (close !== -1) return close + endMark.length
  for (const anchor of tailAnchors) {
    const at = text.indexOf(anchor, start)
    if (at !== -1) return at + anchor.length
  }
  return -1
}

// 摘除一个受管段的全部出现（含标记与段尾换行），from 起查（原位换新后跳过首段做去重）。
// 任一处定不了边界即整体失败（部分摘除会让后续内容错位），返回 null 由调用方放弃本次更新。
function stripManagedSection(text, startMark, endMark, tailAnchors, tag, from = 0) {
  let out = text
  for (;;) {
    const start = out.indexOf(startMark, from)
    if (start === -1) return out
    const rawEnd = sectionEndAt(out, start, endMark, tailAnchors)
    if (rawEnd === -1) {
      noteErr(tag, new Error(`段边界三级降级全部未命中（start 偏移 ${start}），跳过本次更新`))
      return null
    }
    let end = rawEnd
    while (end < out.length && out[end] === '\n') end += 1   // 段尾换行一并摘除，避免残留成片空行
    out = out.slice(0, start) + out.slice(end)
    from = start
  }
}

// 原位刷新一个受管段：首处原位换新（只多吃段尾一个换行，正好对齐新段的收尾换行，
// 与后文的间距保持原样），段缺失则追加到文末（voice 段同款拼接规则）。
// 必须原位而不是「摘了往文末追加」：v2/board/voice 三个段若各自抢文末位，
// 每次 apply 都会互相重排重写，永远到不了「内容未变」的幂等稳态。
function replaceManagedSection(text, startMark, endMark, tailAnchors, section, tag) {
  const start = text.indexOf(startMark)
  if (start === -1) {
    return text.endsWith('\n') || text === '' ? text + section : text + '\n\n' + section
  }
  const rawEnd = sectionEndAt(text, start, endMark, tailAnchors)
  if (rawEnd === -1) {
    noteErr(tag, new Error(`段边界三级降级全部未命中（start 偏移 ${start}），跳过本次更新`))
    return null
  }
  const end = text[rawEnd] === '\n' ? rawEnd + 1 : rawEnd
  const out = text.slice(0, start) + section + text.slice(end)
  // 首段之外的重复段（历史误写/手工复制过一次）顺手去重——从新段末尾起查，别把刚换上的又摘了；
  // 去重失败则整体放弃。
  return stripManagedSection(out, startMark, endMark, tailAnchors, tag, start + section.length)
}

// 二级锚清单（新→旧）：首条自动取现行模板正文末行；后两条是历史发布版本的正文末行
// （搜索策略段加入前，模板先后以「临时产物自清」bullet /「只在指定工作副本内写文件」收尾）。
const AGENTS_TAIL_ANCHORS = [
  sectionTailLine(AGENTS_SECTION, AGENTS_END),
  '- **临时产物自清（2026-09-29 起，与主 AI 同规）**：排查/解包/实验过程中写进 `/tmp` 的文件与目录，任务收尾前必须自己删净（`/tmp` 不会自动清理）；只保留系统自带运行时项（`dsh-*`、`tmux-*`、`node-compile-cache`）。',
  '- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。',
]
// v1 模板以固定句收尾（旧迁移分支的既有实证），v1 段从未带过结束标记。
const AGENTS_V1_TAIL_ANCHORS = ['- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。']

function ensureAgentsProtocol() {
  try {
    // P4.26：目标不只 Codex —— Pi 也认 AGENTS.md（全局 ~/.pi/agent/AGENTS.md）。
    for (const path of agentsTargets()) {
      // ⚠️ 先建目录：对应用户可能还没装该引擎；目录不存在会让 atomicWriteFileSync 抛 ENOENT
      // 并被外层 catch 静默吞掉，AGENTS.md 永不写入（2026-10-26 查实）。
      mkdirSync(dirname(path), { recursive: true })
      let existing = ''
      try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则新建 */ }
      // A2：v1 → v2 升级并入同一条管线。v1 段先按三级降级纯摘除 —— 旧代码在末句锚未命中时
      // 会把 v1 段之后直到文件尾的内容静默丢掉；现在三级全不命中就告警不动手。
      const noV1 = stripManagedSection(existing, AGENTS_V1_MARK, AGENTS_V1_END, AGENTS_V1_TAIL_ANCHORS, 'agents-protocol')
      if (noV1 === null) continue
      const next = replaceManagedSection(noV1, AGENTS_MARK, AGENTS_END, AGENTS_TAIL_ANCHORS, agentsSectionFor(path), 'agents-protocol')
      if (next === null || next === existing) continue
      atomicWriteFileSync(path, next)
    }
  } catch (e) { noteErr('agents-protocol', e) /* best effort：写入失败不阻断插件启动 */ }
}

// ── 长任务协作看板（dual-board）用法段（2026-10-16 增）──
// 脚本与协议随本插件分发（tools/dual-board/），但"怎么用"此前只写在项目级 AGENTS.md
// （$HOME/proj/AGENTS.md，只在那个工作区生效）⇒ 公开用户的 Codex 侧完全不知道有这套东西。
// 这段把它写进全局 ~/.codex/AGENTS.md：A1（2026-10-26）起同样走「摘除旧段→追加新段」
// （成对标记 + 三级降级边界，见 stripManagedSection），与 v2/voice 段同一套幂等语义。
const BOARD_MARK = '<!-- dsh-second-engine:board -->'
const BOARD_END = '<!-- /dsh-second-engine:board -->'
const BOARD_SECTION = `${BOARD_MARK}
## 长任务协作看板（dual-board）

- **协议全文**：本插件包内 \`tools/dual-board/PROTOCOL.md\`。派单 prompt 提到 dual-board、或数据目录里 \`board.json\` 还有未完成任务时，**先读协议再动工**。
- **写板唯一入口**：本插件包内 \`tools/dual-board/board.sh\`（\`new\` / \`claim\` / \`complete\` / \`block\` / \`abandon\` / \`show\` / \`ready\` / \`inbox-append|unread|read|archive\` / \`scope-check\` / \`doctor\`）—— **不要手写 \`board.json\`**。
- **脚本与协议在哪**：\`ls -d ~/.dsh/profiles/*/node_modules/dsh-second-engine/tools/dual-board/\`（以 \`link:\` 方式安装时该路径是软链，用 \`readlink -f\` 看实体）。
- **收件箱**：\`board.sh roles show\` 里**你那个角色**对应的 \`inbox\`（默认 lead → \`inbox-lead.md\`、codex → \`inbox-codex.md\`；Pi 需先 \`board.sh roles set pi --engine pi\` 建角色，之后读 \`inbox-pi.md\`）—— **每次被唤醒的第一动作必读**。
- **交付必含四段**：交付 / 异议位 / 下一步建议 / 自验（并注明遵守的协议版本）。异议位不许沉默——列前提、标未验证项。
- **终态不可复改**：\`completed\` / \`abandoned\`；出问题开新任务，并在 \`context\` / \`blocked_by\` 引用旧任务。
- **数据目录**：默认 \`~/proj/dual-board\`，用环境变量 \`DUAL_BOARD_DIR\` 覆盖。
${BOARD_END}
`
// board 模板至今只有一版，正文末行即二级锚（模板改版时 sectionTailLine 自动跟随）。
const BOARD_TAIL_ANCHORS = [sectionTailLine(BOARD_SECTION, BOARD_END)]

function ensureBoardProtocol() {
  try {
    for (const path of agentsTargets()) {
      mkdirSync(dirname(path), { recursive: true })
      let existing = ''
      try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则新建 */ }
      const next = replaceManagedSection(existing, BOARD_MARK, BOARD_END, BOARD_TAIL_ANCHORS, BOARD_SECTION, 'board-protocol')
      if (next === null || next === existing) continue
      atomicWriteFileSync(path, next)
    }
  } catch (e) { noteErr('board-protocol', e) /* best effort：写入失败不阻断插件启动 */ }
}

// ── 主动开口与整体评估段（2026-10-25 增；协作位 1「允许提议」）──
// 用成对标记（起止各一），支持切档删除 —— 档位=协作两位之一（voice on/off）：on 写入/刷新段，
// off 删段。A1（2026-10-26）起 v2/board 段也改成同款成对标记与「摘除→追加」幂等（见上）。
// 解析（env>file>default，SECOND_ENGINE_VOICE 旧值 ask/voice/off 自动映射）在 ./collab.js。
const VOICE_MARK = '<!-- dsh-second-engine:voice -->'
const VOICE_END = '<!-- /dsh-second-engine:voice -->'
const VOICE_SECTION_RE = /<!-- dsh-second-engine:voice -->[\s\S]*?<!-- \/dsh-second-engine:voice -->\n?/g
const VOICE_SECTION = `${VOICE_MARK}
## 主动开口与整体评估

你不只被用来「评上游 Agent 这一步对不对」。更该做的：评**整条路线**值不值得走，而不只是最后一步。

- **允许主动推荐自己**，不必等被问。四种话都可以说：
  1. 「这件事值得拉长会话做」——一次性小工单只能给评估，真要落地需要连续会话；
  2. 「这块我能接管」——说清你能做哪部分、需要什么输入；
  3. 「我需要 X 才能判断」——缺材料就直说，不要用通用建议填空；
  4. 「这个我做不了 / 超出我的边界」。
- **出现这些信号时主动开口**：
  - 工单里看不出验收标准；
  - 同一个问题第二次被拿来问；
  - 上游只给结论、没给证据链；
  - 你发现自己只能靠猜。
- **评估整体时回答三问**：这条路整体可行吗？我们没看到的风险是什么？你愿意承担哪部分？
- **默认安静**：没有新增信息，不要重复说「我能接管」；建议类开口写进交付的「下一步建议 / 异议位」段。
- **求助走对信道**：结构性卡点（缺权限、缺材料、连续失败）走上方的卡点求助接口，不要在输出里写长篇求助散文。
- **边界**：推荐 ≠ 执行。不自动改用户机器上的文件、不擅自对外发布；最终决策权在上游 Agent 与用户。
${VOICE_END}
`
// 位 1「允许提议」：env > collab 文件 > 默认 off，统一在 ./collab.js 解析。
function voiceMode() {
  return resolveCollab().voice
}

// status/config 共用的协作视图：两位 + 来源 + 派生预设。
// preset 只在这里派生（collabPreset 是唯一映射表），客户端只渲染不计算。
export function collabStatus() {
  const c = resolveCollab()
  return {
    voice: c.voice,
    longtask: c.longtask,
    voiceSource: c.voiceSource,
    longtaskSource: c.longtaskSource,
    preset: collabPreset(c),
  }
}
function ensureVoiceProtocol() {
  try {
    for (const path of agentsTargets()) {
      mkdirSync(dirname(path), { recursive: true })
      let existing = ''
      try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则视为空 */ }
      // 先摘除旧段（含标记本身），再按档位决定是否追加：on=刷新，off=移除。
      const stripped = existing.replace(VOICE_SECTION_RE, '')
      const next = voiceMode() !== 'on' ? stripped
        : (stripped.endsWith('\n') || stripped === '' ? stripped + VOICE_SECTION : stripped + '\n\n' + VOICE_SECTION)
      if (next === existing) continue
      atomicWriteFileSync(path, next)
    }
  } catch (e) { noteErr('voice-protocol', e) }
}

// 读取并归一化 keyring：
//   - 文件缺失/不可解析 → 首次初始化：写入两家预设（apiKey 空）
//   - 旧格式 { provider: 'deepseek'|'zhipu', key } → 迁移为对应预设的 apiKey
//   - 新格式 → 归一化，并保证两家预设始终在列
//   - 三种路径都带上 reviewRounds：handler 里 saveKeyring(loadKeyring()) 才不会把它写丢。
export function loadKeyring() {
  let doc = null
  try {
    doc = JSON.parse(readFileSync(KEYRING_PATH, 'utf8'))
  } catch {
    doc = null
    // 「文件在但读不了/解析不了」= 损坏：先把坏文件改名留证再重置，
    // 否则用户的全部自定义提供方与 apiKey 会被静默抹掉且无从恢复。
    if (existsSync(KEYRING_PATH)) {
      try { renameSync(KEYRING_PATH, `${KEYRING_PATH}.corrupt-${Date.now().toString(36)}`) } catch { /* best effort */ }
    }
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const fresh = { providers: presetProviders(), active: DEFAULT_ACTIVE, reviewRounds: REVIEW_DEFAULT_ROUNDS, reviewWallMs: REVIEW_DEFAULT_WALL_MS, reviewTokenLimit: REVIEW_DEFAULT_TOKEN_LIMIT }
    try { saveKeyring(fresh) } catch { /* 只读降级：内存里照常可用 */ }
    return fresh
  }

  if (!Array.isArray(doc.providers)) {
    const id = PRESET_IDS.has(doc.provider) ? doc.provider : DEFAULT_ACTIVE
    const providers = presetProviders()
    const target = providers.find((p) => p.id === id)
    if (typeof doc.key === 'string') target.apiKey = doc.key.trim()
    const migrated = { providers, active: id, reviewRounds: normalizeReviewRounds(doc.reviewRounds), reviewWallMs: normalizeReviewWallMs(doc.reviewWallMs), reviewTokenLimit: normalizeReviewTokenLimit(doc.reviewTokenLimit) }
    try { saveKeyring(migrated) } catch { /* 迁移落盘失败不阻断读取 */ }
    return migrated
  }

  const providers = doc.providers.map(normalizeProvider).filter((p) => p.id !== '')
  for (const preset of PRESET_PROVIDERS) {
    const existing = providers.find((p) => p.id === preset.id)
    if (existing === undefined) {
      providers.push({ ...preset, apiKey: '' })
      continue
    }
    // 升级回填：旧 keyring 里的预设条目没有模型元数据，用代码内实证值补齐（只补缺，不覆盖）。
    if (preset.contextWindow !== undefined && existing.contextWindow === undefined) existing.contextWindow = preset.contextWindow
    if (preset.maxOutput !== undefined && existing.maxOutput === undefined) existing.maxOutput = preset.maxOutput
  }
  const active = providers.some((p) => p.id === doc.active) ? doc.active : DEFAULT_ACTIVE
  return { providers, active, reviewRounds: normalizeReviewRounds(doc.reviewRounds), reviewWallMs: normalizeReviewWallMs(doc.reviewWallMs), reviewTokenLimit: normalizeReviewTokenLimit(doc.reviewTokenLimit) }
}

// 对外视图：apiKey 只暴露 { configured, preview }，绝不回显明文。
export function providerView(p) {
  const configured = p.apiKey.trim() !== ''
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    wireApi: p.wireApi,
    model: p.model,
    apiKey: { configured, preview: configured ? maskKey(p.apiKey) : '' },
  }
}

export function invalidIdError(id) {
  if (id === '') return 'id 不能为空'
  if (!ID_PATTERN.test(id)) return 'id 必须以小写字母开头，且只含小写字母、数字、下划线或连字符'
  return null
}

// 接受 'responses'（直连）与 'completions'（经本地翻译桥）；其余取值拒绝。
export function wireApiError(value) {
  if (value === undefined || value === null || value === '') return null
  if (SUPPORTED_WIRE_APIS.has(value)) return null
  return `wireApi 只支持 'responses'（直连）或 'completions'（经本地桥），收到 '${value}'`
}

// ── config.toml 生成 ──
// TOML 基本字符串转义，并压掉换行避免注入额外键。
function tomlString(value) {
  return `"${String(value).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}


// 提取原 config.toml 中全部 [mcp_servers.*] 段（段体直到下一个段头或文件尾）。
// 插件模板不生成这些段；切换提供方时原样保留，避免用户经 codex mcp add 挂载的
// 外部 MCP（如 exa）在重写中丢失。原文件不存在或读取失败时返回空数组。

// 插件模板自己生成的段（每次重写都会重新生成）—— 重写时只排除这一类，其余段原样保留。
// 用黑名单而非白名单：白名单每出现一种新段就要补一次名单，漏补 = 静默丢配置。
// 2026-10-02 实证：旧白名单只保留 mcp_servers.*，切一次提供方就把 [features] 整段丢掉，
// memories / multi_agent_v2 / network_proxy / recommended_plugins 全部回到默认 false，
// [projects."$HOME/proj"] 的 trust_level 也一并消失，且全程零报错。
//
// memories 也归模板管：它的两个模型字段必须跟随当前提供方。缺省时 Codex 会去挑
// 内置目录里的 OpenAI 模型名，落到第三方提供方上就是「模型不存在，请检查模型代码」，
// 记忆生成全失败（2026-10-02 实证：jobs 表 6 条全 error、stage1_outputs 0 行）。
const TEMPLATE_OWNED_SECTION = /^\[(?:model_providers\.[^\]\n]+|memories)\][^\n]*$/

// 提取原 config.toml 中「除模板自有段之外」的全部段（段体直到下一个段头或文件尾）。
// 原文件不存在或读取失败时返回空数组。

// 模板自己生成的顶层键（每次重写重新生成）；其余顶层键值行重写时原样带回。
// 原先只显式保留 sandbox_mode/web_search，用户手写的其它顶层键（如
// disable_response_storage）在切换提供方时被静默丢弃。
const TEMPLATE_OWNED_TOP_LEVEL = new Set([
  'model_provider', 'model', 'sandbox_mode', 'web_search', 'approval_policy',
  'model_context_window', 'model_max_output_tokens',
])

// 首个段头之前的非模板顶层 key = value 行（原样保留；TOML 顶层键必须在首个 [table] 前）。

// ── config.toml 读写（web_search / mcp_servers）──
// 与 extractMcpServerBlocks 同口径：读不到就当下不存在，绝不抛错。

// 落盘统一走这里：目录先建、权限 0600（config.toml 里有 apiKey 引用等敏感信息）。
// 重写前先轮转备份（与 writeCodexConfig 同规——这里也是整文件重写，出问题同样需要恢复点）。
function writeConfigRaw(text) {
  mkdirSync(CODEX_DIR, { recursive: true })
  backupConfig()
  atomicWriteFileSync(CONFIG_PATH, text)
}

// 读顶层字符串字段（无该字段/文件缺失 → fallback）。与 sandbox_mode 保留同一写法。
function readTopLevelString(key, fallback) {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(readConfigRaw())
  return m === null ? fallback : m[1]
}

// 当前生效的 web_search：非法/缺失一律按 disabled（与 Codex 无该字段时的默认行为一致）。
export function readWebSearch() {
  const value = readTopLevelString('web_search', DEFAULT_WEB_SEARCH)
  return WEB_SEARCH_MODES.includes(value) ? value : DEFAULT_WEB_SEARCH
}

// 写顶层字符串字段。TOML 铁律：顶层键必须排在第一个 [table] 之前，否则会被归进那张表。
// 已存在则原地替换，否则插在顶层块末尾。
export function writeTopLevelString(key, value) {
  const lines = readConfigRaw().split('\n')
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
  const head = firstTable === -1 ? lines.slice() : lines.slice(0, firstTable)
  const tail = firstTable === -1 ? [] : lines.slice(firstTable)
  const line = `${key} = ${tomlString(value)}`
  const at = head.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
  if (at === -1) head.push(line)
  else head[at] = line
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop()
  const body = tail.length === 0 ? head : [...head, '', ...tail]
  // 首部空行一并压掉：文件不存在时 head 以空行起手，别让新写的 config 顶着空行。
  writeConfigRaw(`${body.join('\n').replace(/^\n+/, '').replace(/\n*$/, '')}\n`)
}

// 段头里的键可能被引号包着（[mcp_servers."my-srv"]），取值时剥掉。
function unquoteTomlKey(raw) {
  const key = String(raw).trim()
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    return key.slice(1, -1).replace(/\\"/g, '"')
  }
  return key
}

// 列出 config.toml 全部 [mcp_servers.*] 段（名称 + url + enabled）。
// enabled 缺省 true —— 与 Codex 无该字段时的默认行为一致（官方字段：enabled = true|false）。
export function listMcpServers() {
  const raw = readConfigRaw()
  const out = []
  const re = /^\[mcp_servers\.([^\]\n]+)\][^\n]*$/gm
  let m
  while ((m = re.exec(raw)) !== null) {
    const next = raw.indexOf('\n[', m.index)
    const body = raw.slice(m.index, next === -1 ? raw.length : next)
    const u = /^\s*url\s*=\s*"([^"]*)"/m.exec(body)
    const en = /^\s*enabled\s*=\s*(true|false)\s*$/m.exec(body)
    out.push({
      name: unquoteTomlKey(m[1]),
      url: u === null ? '' : u[1],
      enabled: en === null ? true : en[1] === 'true',
    })
  }
  return out
}

// 追加一个 [mcp_servers.<name>] 段（name/url 已由 handler 校验）。只追加不改写其它内容，
// 用户的 [projects.*]/[model_providers.*] 一行都不会被碰。
export function addMcpServer(name, url) {
  const block = `[mcp_servers.${name}]\nurl = ${tomlString(url)}`
  const raw = readConfigRaw().replace(/\n*$/, '')
  writeConfigRaw(raw === '' ? `${block}\n` : `${raw}\n\n${block}\n`)
}

// 原地删除一个 [mcp_servers.<name>] 段（段体直到下一个段头或文件尾）。
// 存在并删除 → true；不存在 → false（handler 据此回 404）。
export function removeMcpServer(name) {
  const raw = readConfigRaw()
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\[mcp_servers\\.(?:${key}|"${key}")\\][^\\n]*$`, 'm')
  const m = re.exec(raw)
  if (m === null) return false
  const next = raw.indexOf('\n[', m.index)
  const end = next === -1 ? raw.length : next + 1
  const before = raw.slice(0, m.index).replace(/\s*$/, '')
  const after = raw.slice(end).replace(/^\s*/, '')
  const joined = after === '' ? `${before}\n` : `${before}\n\n${after}`
  writeConfigRaw(joined.replace(/^\n+/, '').replace(/\n*$/, '') + '\n')
  return true
}

// 改写一个 [mcp_servers.<name>] 段的 enabled（Codex 官方字段：enabled = true|false）。
// 段内已有 enabled 行则原地替换，否则插在段头之后第一行。存在并改写 → true；不存在 → false。
// 用途：面板「禁用」某个 MCP —— 保留配置段，只让 Codex 不再连接它（不删除）。
export function setMcpServerEnabled(name, enabled) {
  const raw = readConfigRaw()
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\[mcp_servers\\.(?:${key}|"${key}")\\][^\\n]*$`, 'm')
  const m = re.exec(raw)
  if (m === null) return false
  const next = raw.indexOf('\n[', m.index)
  const end = next === -1 ? raw.length : next + 1
  let block = raw.slice(m.index, end).replace(/\n*$/, '')
  const line = `enabled = ${enabled ? 'true' : 'false'}`
  if (/^\s*enabled\s*=/m.test(block)) {
    block = block.replace(/^\s*enabled\s*=.*$/m, line)
  } else {
    const nl = block.indexOf('\n')
    block = nl === -1 ? `${block}\n${line}` : `${block.slice(0, nl)}\n${line}${block.slice(nl)}`
  }
  const before = raw.slice(0, m.index).replace(/\s*$/, '')
  const after = raw.slice(end).replace(/^\s*/, '')
  const joined = after === '' ? `${before}\n${block}\n` : `${before}\n${block}\n\n${after}`
  writeConfigRaw(joined.replace(/^\n+/, '').replace(/\n*$/, '') + '\n')
  return true
}

// ── 翻译桥生命周期 ──
// 进程内只保留一座桥：wireApi==='completions' 的提供方每次激活都会重建
// （旧桥先 close，避免端口/回调残留在旧提供方上）。
let bridgeServer = null
let bridgeBaseUrl = ''

// 关闭当前桥（幂等；可安全用于 dispose / process 退出钩子）。
function closeBridge() {
  const server = bridgeServer
  bridgeServer = null
  bridgeBaseUrl = ''
  if (server === null) return
  try { server.close() } catch { /* 已关闭或从未监听成功 */ }
}

// ── 期望态对账 tick（2026-10-03 · 待办 🚧 第 1 项）──────────────────────────
// 现象：桥是模块级内存态，Web 重启即丢失；而 config.toml 仍指旧桥端口 →
//       completions 提供方连不上（ERROR: Reconnecting... waiting for network；临时解法=切一次提供方）。
// 治法：常驻 tick 把「期望态」与「观测态」对齐，**只对差异动手**（幂等可重入）。
// 纪律：**绝不把「重启 Node」当「重启作业」** —— 作业探活只判失联并置状态，不主动杀任何子进程。
const RECONCILE_INTERVAL_MS = 7000

let reconcileTimer = null
let reconcileRunning = false

// 读 /proc/<pid>/stat 的 starttime（第 22 字段），用于防 PID 重用。
// comm（第 2 字段）可能含空格与括号，故取最后一个 ')' 之后切分才稳；
// 读不到（非 Linux / 权限受限）返回 null —— 此时不据此判死，退化为"只看存在性"。
export function readProcStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // 切分后下标 = 原字段号 - 3（field 3 即 parts[0]）；starttime 是 field 22 → parts[19]
    const raw = parts[19]
    return raw === undefined ? null : raw
  } catch { return null }
}

// 看板进程身份与独立清扫；不依赖 Web 重启后会丢失的 tasks。
const BOARD_SCRIPT = fileURLToPath(new URL('../tools/dual-board/board.sh', import.meta.url))
const boardDir = () => process.env.DUAL_BOARD_DIR || join(homedir(), 'proj', 'dual-board')
function boardCommand(args) {
  return new Promise((resolve, reject) => {
    execFile('bash', [BOARD_SCRIPT, ...args], { env: process.env, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`board ${args[0]} failed (${error.code}): ${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}
function requestedBoardId(body) {
  const value = body.boardId ?? body['board-id'] ?? body.board_id ?? body.task?.boardId ?? body.task?.['board-id']
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
export async function persistBoardChild(task) {
  if (!task.boardId) {
    console.warn(`[second-engine] board pid skipped: task ${task.id} has no board-id`)
    return
  }
  const rt = rtOf(task)
  const pid = rt.getChildPid()
  if (!Number.isInteger(pid) || pid <= 0) {
    console.warn(`[second-engine] board pid skipped: task ${task.id} has no child pid`)
    return
  }
  const start = readProcStartTime(pid)
  rt.setChildStart(start)
  try {
    await boardCommand(['set', task.boardId, `child_pid=${pid}`, `child_start=${start ?? ''}`])
    console.log(`[second-engine] board pid persisted: ${task.boardId} pid=${pid} start=${start}`)
    if (start === null) console.warn(`[second-engine] board ${task.boardId}: starttime unavailable; ESRCH only`)
  } catch (e) { console.error('[second-engine] board pid persistence:', errMsg(e)) }
}

let boardSweepTimer = null
let boardSweepRunning = false
async function sweepBoardOnce() {
  const dir = boardDir()
  const summary = { at: new Date().toISOString(), checked: 0, blocked: [], stuckSuspect: [], errors: [] }
  try {
    const initial = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))
    for (const candidate of initial.tasks) {
      if (candidate.status !== 'in_progress' || candidate.session === null || candidate.child_pid == null || candidate.child_pid === '') continue
      // 每个动作重新读取 revision，CAS 阻止探测期间发生的认领/身份更新。
      const snapshot = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))
      const task = snapshot.tasks.find(t => t.id === candidate.id)
      if (!task || task.status !== 'in_progress' || task.session === null || task.child_pid == null || task.child_pid === '') continue
      const pid = Number(task.child_pid)
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      summary.checked++
      let dead = false
      try { process.kill(pid, 0) } catch (e) { dead = e?.code === 'ESRCH' }
      const start = readProcStartTime(pid)
      if (start !== null && task.child_start != null && task.child_start !== '' && start !== String(task.child_start)) dead = true
      if (!dead) {
        // mtime 只能告警；缺文件/权限问题也绝不是死亡证据。
        if (typeof task.rollout_path === 'string') {
          try {
            if (Date.now() - statSync(task.rollout_path).mtimeMs > 300000) summary.stuckSuspect.push(task.id)
          } catch { /* 无法读取不判死 */ }
        }
        continue
      }
      const reason = `持有进程已死（pid ${pid}, start ${task.child_start ?? 'unknown'}）`
      try {
        await boardCommand(['block', task.id, '--reason', reason, '--expect', String(snapshot.revision)])
        summary.blocked.push(task.id)
        // block 成功才记成功审计；失败仍在 summary/errors 与日志中可见。
        mkdirSync(join(dir, 'audit'), { recursive: true })
        appendFileSync(join(dir, 'audit', 'process-sweep.jsonl'), JSON.stringify({ at: summary.at, id: task.id, pid, start: task.child_start, reason, action: 'blocked' }) + '\n')
      } catch (e) { summary.errors.push(`${task.id}: ${errMsg(e)}`) }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') summary.errors.push(errMsg(e))
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'second-engine-board-sweep.last.json'), JSON.stringify(summary) + '\n')
  } catch (e) { summary.errors.push(`marker: ${errMsg(e)}`) }
  console.log('[second-engine] board sweep:', JSON.stringify(summary))
  return summary
}
function stopBoardSweep() {
  if (boardSweepTimer !== null) clearInterval(boardSweepTimer)
  boardSweepTimer = null
}
function startBoardSweep() {
  stopBoardSweep()
  // 独立低频计时器，不进行仅凭内存态的 boot sweep。
  boardSweepTimer = setInterval(async () => {
    if (boardSweepRunning) return
    boardSweepRunning = true
    try { await sweepBoardOnce() } finally { boardSweepRunning = false }
  }, 60000)
  boardSweepTimer.unref?.()
}

// config.toml 里的 base_url 是否已指向给定端点。
// 用于「不一致才重写」：writeCodexConfig 会连带重建桥并留备份，绝不能每轮 tick 都调它。
function configPointsTo(baseUrl) {
  if (baseUrl === '') return false
  try {
    const m = /^\s*base_url\s*=\s*"([^"]*)"/m.exec(readFileSync(CONFIG_PATH, 'utf8'))
    return m !== null && m[1] === baseUrl
  } catch { return false }
}

// 作业失联判定 —— 只做第一层（进程不存在 / PID 被重用）。
// 心跳新鲜度与 stuckSuspect 交给既有 startWatchdog：它只告警不置死，因为
// "长时间无输出"常常只是模型在长生成，据此判死会误杀健康作业。
// 返回 null = 仍活着（或无法判定）；返回字符串 = 失联原因。
function probeTaskLost(task) {
  const rt = rtOf(task)
  const pid = rt.getChildPid()
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e !== null && e !== undefined && e.code === 'ESRCH') return 'process-gone'
    return null // EPERM 等：进程还在，只是没权限探测
  }
  const nowStart = readProcStartTime(pid)
  const startAt = rt.getChildStart()
  if (startAt !== undefined && startAt !== null && nowStart !== null && nowStart !== startAt) {
    return 'pid-reused'
  }
  return null
}

// 一轮对账。返回动作清单（空数组 = 无差异、未改任何东西）。
async function reconcileOnce() {
  const actions = []

  // ① 桥对账：以 active 提供方的 wireApi 为期望态
  try {
    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    if (active !== undefined) {
      if (active.wireApi !== 'completions') {
        if (bridgeServer !== null) { closeBridge(); actions.push('bridge:closed') }
      } else if (bridgeServer === null || !configPointsTo(bridgeBaseUrl)) {
        // 桥不在、或 config 没指向当前桥 → 交给 writeCodexConfig 一次对齐两件。
        // 它内部 ensureBridge 是幂等的（先 closeBridge 再起新桥），且这里只在"确实不一致"时才调。
        await writeCodexConfig(active)
        actions.push(`bridge:aligned@${bridgeBaseUrl}`)
      }
    }
  } catch (e) { actions.push(`bridge:error:${errMsg(e)}`) }

  // ② 作业探活：仅对内存中 running 的作业判失联（健康作业一律不碰）
  for (const task of tasks.values()) {
    if (task.status !== 'running') continue
    // P2：取消中的任务内部 status 仍是 running（终态待 finalize），别让探活抢先判失联。
    if (rtOf(task).isCancelled()) continue
    const why = probeTaskLost(task)
    if (why === null) continue
    rtOf(task).setReconcileLost(why)
    // 2026-10-31 修：finalizeJob 只写 task 侧（status/endedAt/output），**完全不碰 runtime**。
    // Pi runtime 有自己的 ended 哨兵与 donePromise（pi-rpc-runtime.js:688），不调它的 finalize
    // 就会留下「task 已判失联、pi 子进程还活着、donePromise 永不 resolve」。
    // Codex runtime 没有 finalize 方法，所以按能力判断，不按引擎名分支。
    const rt = rtOf(task)
    if (typeof rt.finalize === 'function') {
      try { await rt.finalize({ exitCode: -1, lost: why }) } catch { /* best effort */ }
    }
    if (finalizeTask(task, -1, 'error') && !rtOf(task).isCancelled()) void notifyTask(task)
    actions.push(`task:${task.id}:${why}`)
  }

  return actions
}

function stopReconcileTick() {
  if (reconcileTimer !== null) { clearInterval(reconcileTimer); reconcileTimer = null }
}

// 常驻对账 tick：启动先跑一次，之后每 RECONCILE_INTERVAL_MS 一次。
// 幂等可重入：上一轮未结束则跳过（不叠加）；任何异常都不外抛，绝不让对账拖垮宿主。
function startReconcileTick() {
  stopReconcileTick()
  // 可观测性：落一个启动标记，供 se-reconcile-verify.sh 判断"新代码是否已被 Web 加载"。
  // 没有它，Web 未重启时验收脚本会"空跑通过"（tick 根本没跑）→ 假阳性。
  try {
    writeFileSync(join(process.env.HOME || '/root', '.dsh', 'second-engine-reconcile.started'), `${Date.now()}\n`)
  } catch { /* best effort */ }
  const tick = async () => {
    if (reconcileRunning) return
    reconcileRunning = true
    try {
      const actions = await reconcileOnce()
      if (actions.length > 0) console.log('[second-engine] reconcile:', actions.join(', '))
    } catch { /* best effort */ } finally { reconcileRunning = false }
  }
  void tick()
  reconcileTimer = setInterval(() => { void tick() }, RECONCILE_INTERVAL_MS)
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
}

// 让 config.toml 指向正确的上游端点：
//   completions → 起本地桥（127.0.0.1 随机端口），Codex 连桥、桥转 chat；
//   responses   → 关掉旧桥，直连 provider.baseUrl。
// 返回 { viaBridge, baseUrl }。
async function ensureBridge(provider) {
  if (provider.wireApi !== 'completions') {
    closeBridge()
    return { viaBridge: false, baseUrl: provider.baseUrl }
  }
  closeBridge()
  const server = createBridgeServer({ upstreamBaseUrl: provider.baseUrl, apiKey: provider.apiKey })
  try {
    // createBridgeServer 已发起 listen(0,'127.0.0.1')，等 'listening' 才拿得到端口。
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
    })
  } catch (e) {
    try { server.close() } catch { /* best effort */ }
    throw e
  }
  bridgeServer = server
  bridgeBaseUrl = `http://127.0.0.1:${server.address().port}`
  return { viaBridge: true, baseUrl: bridgeBaseUrl }
}

// 按 active 提供方生成 config.toml，返回使用的 env_key。
// base_url 写 ensureBridge 给出的端点（completions 时即本地桥）；
// wire_api 恒为 'responses'——Codex 只会说 Responses，协议差异由桥承担。
export async function writeCodexConfig(provider) {
  mkdirSync(CODEX_DIR, { recursive: true })
  backupConfig()
  const target = await ensureBridge(provider)
  const envKey = `${provider.id.toUpperCase()}_API_KEY`
  const tableKey = ID_PATTERN.test(provider.id) ? provider.id : tomlString(provider.id)
  // 保留原 config.toml 的 sandbox_mode：本机 proot 实测仅 danger-full-access 可跑工具，绝不能在切换提供方时丢失
  let sandboxMode = 'danger-full-access'
  try {
    const m = /^sandbox_mode\s*=\s*"([^"]+)"/m.exec(readFileSync(CONFIG_PATH, 'utf8'))
    if (m) sandboxMode = m[1]
  } catch { /* 原文件不存在，用实证默认值 */ }
  // 同理保留顶层 web_search（联网搜索开关）：面板切提供方时不丢用户的开关状态。
  const webSearch = readWebSearch()
  const lines = [
    `model_provider = ${tomlString(provider.id)}`,
    `model = ${tomlString(provider.model)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
    `web_search = ${tomlString(webSearch)}`,
    // 审批策略固定 never：exec 模式非交互，默认值下工作副本外写入会请求人工审批 → 无限挂起假死（2026-09-21 实证）
    `approval_policy = "never"`,
  ]
  // 模型元数据（预设提供方实证值）：Codex 顶层 model_context_window / model_max_output_tokens。
  if (Number.isFinite(provider.contextWindow)) {
    lines.push(`model_context_window = ${Math.floor(provider.contextWindow)}`)
    if (Number.isFinite(provider.maxOutput)) {
      lines.push(`model_max_output_tokens = ${Math.floor(provider.maxOutput)}`)
    }
  }
  lines.push(
    '',
    `[model_providers.${tableKey}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(target.baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `wire_api = ${tomlString(WIRE_API)}`,
    '',
  )
  // 记忆流水线的模型跟随当前提供方（缺省会落到内置 OpenAI 模型名 → 上游报「模型不存在」）。
  // 写死成 provider.model 后，切厂商自动同步，不必每次手改。
  if (provider.model) {
    lines.push(
      '',
      '[memories]',
      `extract_model = ${tomlString(provider.model)}`,
      `consolidation_model = ${tomlString(provider.model)}`,
    )
  }
  // 顶层兜底保留：非模板顶层键（见 extractPreservedTopLevelLines）原样带回。
  lines.push(...extractPreservedTopLevelLines())
  // 保留模板外的用户/工具配置段：mcp_servers.*、features、tui、projects.* 等。
  // 同 sandbox_mode 的保留逻辑 —— 不在重写时丢失。
  // （2026-10-02 修正：原先只保留 mcp_servers，切提供方时 [features] 被丢，
  //   feature 开关被静默重置为默认值，见 extractPreservedSections 注释。）
  const keptBlocks = extractPreservedSections()
  if (keptBlocks.length > 0) lines.push(...keptBlocks, '')
  atomicWriteFileSync(CONFIG_PATH, lines.join('\n'))
  return envKey
}


async function activeEngineModel(id) {
  if (id !== 'pi') {
    try {
      const doc = loadKeyring()
      const p = doc.providers.find((x) => x.id === doc.active)
      return { providerId: doc.active, model: p?.model || '', fallback: false, source: 'keyring' }
    } catch { return { providerId: '', model: '', fallback: false, source: 'none' } }
  }
  const runtime = await piRuntimeModel()
  if (runtime !== null) return runtime
  const hit = resolvePiProvider()
  if (hit !== null) return { providerId: hit.id, model: hit.model, fallback: true, source: 'config' }
  return { providerId: '', model: '', fallback: true, source: 'none' }
}

/** 当前引擎的探测 + 能力（status/config 共用，别写两份）。 */
export async function engineView() {
  const active = activeEngineId()
  const caps = ENGINES[active] !== undefined ? ENGINES[active].capabilities : null
  const view = { active, list: engineList(), caps, model: await activeEngineModel(active), cleanup: cleanupTarget(active) }
  if (active === 'pi') {
    try { view.probe = { pi: await piProbe(), models: await piAvailableModels() } }
    catch (e) { view.probe = { pi: null, models: null, error: errMsg(e) } }
  } else {
    view.probe = { pi: null, models: null }
  }
  return view
}



// ── Pi 面板数据（P4.6）：Pi 引擎专用，字段与 lib/pi-cards.js 契约一一对应 ──
// 为什么单独出口：Codex 的 keyring/config.toml 与 ~/.codex/sessions 在 Pi 下全无意义，
// 前端若在共享卡片里做行级 if，漏一处就把 Codex 的数字显示在 Pi 面板上（真实踩过）。
export function countPiJsonl(dir) {
  let count = 0
  let sizeBytes = 0
  const walk = (current) => {
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try { count += 1; sizeBytes += statSync(full).size } catch { /* skip transient file errors */ }
    }
  }
  walk(dir)
  return { count, sizeBytes }
}


// ── Pi 自定义模型渠道（P4.7）：写 ~/.pi/agent/models.json 的 providers.<id> ──
// 格式依据 Pi docs/models.md:45「Configure a compatible endpoint」：
//   { providers: { <id>: { baseUrl, api, apiKey, models: [{ id }] } } }
// apiKey 支持 $ENV 插值；本接口不回显明文、不写日志，文件权限 0600，改动前留 .bak。
export const PI_CHANNEL_APIS = new Set([
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'azure-openai-responses', 'bedrock-converse-stream',
])





// D8-① 用的引擎门禁：期望引擎与实际激活引擎不一致 → 返回一条可直接 send 的错误体；一致 → null 放行。
// ⚠️ 复核订正（我上轮缺陷表 D8 里写「引擎未知时放行」）：activeEngineId() 是**读文件、读不到就返回
// 'codex'**（src/engine/registry.js:82-88），它永远不会返回空串，所以那半句是错的、也是死代码 ——
// 这里按代码实况写：未知态就是 codex，门禁照常生效，不做「未知放行」的例外。
export function engineGateFor(expected) {
  const active = activeEngineId()
  if (active === expected) return null
  const want = expected === 'pi' ? 'Pi' : 'Codex'
  const now = active === 'pi' ? 'Pi' : (active === 'codex' ? 'Codex' : active)
  return {
    error: `当前引擎是 ${now}，本接口只清 ${want} 的会话（已中止，未改动任何文件）`,
    engineMismatch: { active, expected },
  }
}


// 协议选项：由后端下发，前端不写死。Codex 只有两种（completions 需经本地桥翻译），
// Pi 直连六种原生 api，没有桥的概念 —— 写死两选项会让 Pi 用户缺 anthropic/gemini。
export const CODEX_WIRE_OPTIONS = [
  { value: 'responses', label: 'responses（直连）', bridged: false },
  { value: 'completions', label: 'chat（经本地桥）', bridged: true },
]
export const PI_WIRE_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI 兼容（chat completions）', bridged: false },
  { value: 'openai-responses', label: 'OpenAI Responses', bridged: false },
  { value: 'anthropic-messages', label: 'Anthropic Messages', bridged: false },
  { value: 'google-generative-ai', label: 'Google Generative AI', bridged: false },
  { value: 'azure-openai-responses', label: 'Azure OpenAI Responses', bridged: false },
  { value: 'bedrock-converse-stream', label: 'AWS Bedrock Converse', bridged: false },
]

// ── Pi 引擎下的 providers/models 兼容层（P4.11）──
// 目的：前端 ProviderCard 一行都不改。把 Pi 的 models.json + settings.json 映射成
// Codex 的 { ok, active, providers:[{id,name,baseUrl,model,apiKey:{configured,preview}}] }。
// 这样「编辑 / 删除 / 填 Key / 拉模型 / 切当前」全部沿用既有实现 —— 不再维护第二套 UI。
export const PI_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')
// per-provider 模型记忆（2026-11-02）：Pi 的 settings.json 只有一对全局 defaultProvider/defaultModel，
// 切提供方时模型不跟着换（实测：当前是 deepseek 但仍显示 glm-5.2）。按 provider 各记一份。
// ⚠️ 不写进 models.json —— 那是 Pi 的配置且有 schema 校验，塞未知字段可能整份被拒。
const PI_MODEL_MEMORY_PATH = join(homedir(), '.dsh', 'second-engine', 'pi-model-memory.json')

export function readPiModelMemory() {
  try {
    const parsed = JSON.parse(readFileSync(PI_MODEL_MEMORY_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

export function rememberPiModel(id, model) {
  if (id === '' || model === '') return
  try {
    // 目录不会自动创建：atomicWriteFileSync 只写文件，父目录缺失会 ENOENT（真实事故：
    // ~/.dsh/second-engine/ 不存在时每次写记忆都失败，异常被 catch 吞掉，表现为"选了模型又回默认"）。
    mkdirSync(dirname(PI_MODEL_MEMORY_PATH), { recursive: true })
    const mem = readPiModelMemory()
    mem[id] = model
    atomicWriteFileSync(PI_MODEL_MEMORY_PATH, `${JSON.stringify(mem, null, 2)}\n`, 0o600)
  } catch (e) { noteErr('pi-model-memory', e) }
}

export function readPiJson(path) {
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    return doc !== null && typeof doc === 'object' ? doc : {}
  } catch { return {} }
}

// ── Pi 配置文件写入的并发保护（2026-10-29 任务 1）────────────────────────
// 问题：六个写入口（piProviderAdd / piProviderKey / piProviderDelete / piProviderUpdate /
// piProviderActive / piProviderModel）各自都是「读整份 → 改一个键 → 写整份」，入口之间
// 没有任何互斥。面板与浮球并发点两下 = 后一次用自己的**旧读**覆盖前一次的结果（丢写）；
// 两个 handler 同毫秒抢同一份 `${path}.tmp-${process.pid}`（同进程同 pid，名字**必然撞**），
// rename 之后 tmp 已被顶走 → ENOENT 半途失败；`.bak-<ts>` 同毫秒也互相覆盖。
// 做法：per-path  promise 链（进程内串行队列）。只在本进程内串行，不是跨进程文件锁
// （那需要新依赖，本轮禁止）；跨进程仍靠原子 rename 保证「不出现半截文件」。
export const PI_WRITE_QUEUES = new Map()

// 严格读（写基线专用）：坏 JSON / 读不到 → 抛 PiWriteAborted，**绝不**拿 {} 当基线。
// 与旧 readPiJsonForWrite 同一口径（紫东审查 P0-2/P0-3），只是把「已发响应」改成抛错，
// 好让它在 piWriteJson 的锁内闭包里复用。
class PiWriteAborted extends Error {
  constructor(message, status) { super(message); this.status = status === undefined ? 409 : status }
}
export function readPiJsonStrict(path) {
  if (!existsSync(path)) return {}
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch (e) {
    throw new PiWriteAborted(`读不到 ${path}：${errMsg(e)}`, 500)
  }
  let doc = null
  try { doc = JSON.parse(raw) } catch {
    throw new PiWriteAborted(`${path} 不是合法 JSON，已中止（未改动文件）。请先手工修好再加。`, 409)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PiWriteAborted(`${path} 顶层不是对象，已中止（未改动文件）。`, 409)
  }
  return doc
}


// wireApi（Codex 术语）↔ api（Pi 术语）
// 接受三种输入：Codex 的 responses/completions，或 Pi 自己的 api 值（原样直通）。
export const PI_API_SET = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses', 'bedrock-converse-stream'])


/** Pi 快照 → Codex 形状。内置只预设 deepseek（用户要求），其余全在 models.json 里。 */
/** 模型名不该长成 API Key 的样子（智谱是 id.secret，49 字符）。
 *  用户实测把 key 填进「模型名」，结果被当模型名写进 models.json 并显示在面板上。 */






// Pi 写入口统一错误出口：PiWriteAborted 带自己的 status（409/500），其余按 200 + ok:false（与历史一致）。
// ── Pi JSON 备份轮转（D4，2026-10-29）────────────────────────────────
// Codex 侧早有这套：backupConfig() 按 CONFIG_BACKUP_NAME_RE 只认自己那套文件名，
// 排序后 slice 掉超出 CONFIG_BACKUP_KEEP 的旧份（:759-774）。Pi 侧这几个 JSON 之前
// 每次真写都留一份 .bak-<ts>，永远不清 → ~/.pi/agent 下无限增长。
// 这里复用同一个保留数，以及同一套「只按自己的文件名模式轮转」的纪律：
// 只匹配 ^<本文件名>\.bak- ，别的一律不碰（用户手放的备份、别的文件都安全）。
// 备份名是 <文件>.bak-<毫秒>-<pid>-<8hex>，时间戳定长在最前 → 字典序即时间序，sort() 就够。

// ── Pi 提供方/渠道 id 白名单（D1，2026-10-29）──────────────────────────
// 原来只有 piProviderAdd / handlePiChannelCreate 各写了一份同样的字面量正则，
// piProviderKey / piProviderDelete / piProviderModel 只判非空 —— 见缺陷表 D1。
// 注意：`__proto__` 本来就被首字符 [A-Za-z0-9] 挡掉，真正能穿过去的是
// constructor / prototype / toString 这类**首字符合法**的 Object.prototype 键名，
// 所以正则之外还要显式列出要拒绝的键。
export const PI_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
export const PI_PROVIDER_ID_BLOCKED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']
// providers 容器的安全取法：一律 hasOwnProperty 判存在，读到的是对象自己的键才算数，
// 继承链上的 constructor/toString 不会被当成「已存在的提供方」。
// 另外把已存在的普通对象换成原型为 null 的副本（原对象属性逐个 own-key 拷过来，
// 值引用不变，所以 piWriteJson 的内容比对仍等价 → 不会因此多写一份备份）。
export function piProvidersBag(doc) {
  if (doc.providers === null || typeof doc.providers !== 'object') {
    doc.providers = Object.create(null)
    return doc.providers
  }
  if (Object.getPrototypeOf(doc.providers) !== null) {
    const safe = Object.create(null)
    for (const k of Object.keys(doc.providers)) safe[k] = doc.providers[k]
    doc.providers = safe
  }
  return doc.providers
}
export function piHasProvider(bag, id) {
  return Object.prototype.hasOwnProperty.call(bag, id)
}

export function sendPiWriteError(res, e) {
  const status = e instanceof PiWriteAborted ? e.status : 200
  send(res, { ok: false, error: errMsg(e) }, status)
}















// POST /providers/delete：核心默认（deepseek/zhipu）不可删；自定义提供方均可删。删除 active 时回落并同步 config.toml。
export const PROTECTED_IDS = new Set(['deepseek', 'zhipu'])


// ── /models 与 /model：模型获取与选择 ──

// 拼出 /models 端点：压掉 baseUrl 末尾斜杠，避免 '//models'。
export function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

// 智谱：open.bigmodel.cn 上 /api/v1 是 **Codex 专用适配端点**（模型清单只列 codex 适配好的几个），
// 而 /api/coding/paas/v4 是编程端点、列出全量模型；两者共用同一把 key（2026-09-28 实测）。
// 这里给它一个辅助清单 URL，与主端点求并集展示，避免"面板只显示 3 个模型"的误判。
export function bigmodelAuxModelsUrl(baseUrl) {
  return /open\.bigmodel\.cn/i.test(baseUrl)
    ? 'https://open.bigmodel.cn/api/coding/paas/v4/models'
    : null
}

// 兼容两种实测返回格式：
//   OpenAI（DeepSeek）：{ object:'list', data:[{ id, ... }] }
//   Z.ai（智谱）：      { models:[{ id, display_name, ... }] }
// 取 id；无 id 时回落 display_name；顺带容忍纯字符串条目与重复项。


// POST /model：body { id, model }（id 缺省 = active）。写入 provider.model；
// 若该提供方正是 active，则同步重写 config.toml，使引擎立刻用上新模型。
async function handleProviderModel(req, res) {
  if (activeEngineId() === 'pi') return piProviderModel(req, res)
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (model === '') return send(res, { ok: false, error: 'model 不能为空' }, 400)
    const doc = loadKeyring()
    const target = id === ''
      ? doc.providers.find((p) => p.id === doc.active)
      : doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id === '' ? doc.active : id}'` }, 404)
    }
    target.model = model
    saveKeyring(doc)
    let configRegenerated = false
    if (target.id === doc.active) {
      await writeCodexConfig(target)
      configRegenerated = true
    }
    send(res, { ok: true, id: target.id, model, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 递归删除 sessions 下 mtime 早于 keepDays 天的 *.jsonl，统计数量与释放字节

// C 项（2026-10-17 用户定）：过程流 `task-*.out.live` 落在 CODEX_DIR 根下、**不在 sessions/ 内**，
// 所以 cleanupSessions 的递归永远扫不到它 —— 这里单独按 mtime 清。
// 跳过 status==='running' 的任务：它可能正在写这个文件（同一 outPath）。
export function cleanupLiveFiles(cutoff, stats) {
  let names
  try { names = readdirSync(CODEX_DIR) } catch { return }
  const running = new Set()
  for (const t of tasks.values()) {
    if (t !== null && typeof t === 'object' && t.status === 'running' && typeof t.id === 'string') running.add(t.id)
  }
  for (const name of names) {
    if (typeof name !== 'string') continue
    // 三类过程产物按同一 mtime 策略清：live 过程流、工单 -o 落点、互审轮次 -o 落点。
    // （原来只清 *.live —— finalize 没跑成（崩溃/被 kill）时 task-*.out / review-*.out 会永久残留。）
    let id = ''
    if (name.startsWith('task-') && name.endsWith('.out.live')) id = name.slice('task-'.length, -'.out.live'.length)
    else if (name.startsWith('task-') && name.endsWith('.out.live.1')) id = name.slice('task-'.length, -'.out.live.1'.length)
    else if (name.startsWith('task-') && name.endsWith('.out')) id = name.slice('task-'.length, -'.out'.length)
    else {
      const m = /^review-(.+)-r\d+\.out$/.exec(name)
      if (m !== null) id = m[1]
      else continue
    }
    if (id !== '' && running.has(id)) continue
    const full = join(CODEX_DIR, name)
    try {
      const info = statSync(full)
      if (!info.isFile() || info.mtimeMs >= cutoff) continue
      unlinkSync(full)
      stats.removed += 1
      stats.freedBytes += info.size
    } catch { /* 跳过无法删除的条目 */ }
  }
}

// ── Codex 运行日志库清理（B，2026-10-26）──
// 目标 ~/.codex/logs_2.sqlite —— Codex CLI 自建自写的库，不是本插件的产物。本机实测
// 40.2 MB 里 freelist 87%（有效数据仅 5.1 MB、正文合计 1.5 MB）：单纯 DELETE 最多回收
// 1.5 MB，真正要回收的空间必须靠 VACUUM 折叠碎片，所以默认策略是「只删超期行 +
// 碎片占比超阈值才 VACUUM」，避免每次调用整库重写。用 node:sqlite（Node v24 实测可用，
// 零新依赖）；外部 sqlite3 CLI 本机没有，不用。
const CODEX_LOGS_DB = join(CODEX_DIR, 'logs_2.sqlite')
// VACUUM 需要约 2 倍文件大小的临时空间 + WAL 独占锁，只在碎片确实可观时才做。
const CODEX_LOGS_VACUUM_MIN_FRAGMENT = 0.3

// Codex 是否在跑：/proc 里扫 codex* 进程（comm 截 15 字符，codex-code-mode 也算），
// 再看本插件自己的工单里有没有 running。跑着就不 VACUUM —— WAL 独占锁会锁住 Codex 的写入。
function codexProcessRunning() {
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        const comm = readFileSync(join('/proc', pid, 'comm'), 'utf8').trim()
        if (comm === 'codex' || comm.startsWith('codex-')) return true
      } catch { /* 进程已消失/无权限：跳过 */ }
    }
  } catch { /* /proc 读不了：只靠 tasks 侧判断 */ }
  for (const t of tasks.values()) {
    if (t !== null && typeof t === 'object' && t.status === 'running') return true
  }
  return false
}

// VACUUM 临时空间探测：需要约 2 倍库大小。fs.statvfs 本机构建没有，走 df（best effort，
// 解析失败返回 null = 不设防，当前库 40 MB 量级风险可控）。
function diskFreeBytes(dir) {
  try {
    const out = spawnSync('df', ['-B1', dir], { timeout: 3000 })
    if (out.status !== 0 || typeof out.stdout !== 'string') return null
    const cols = out.stdout.split('\n')[1]?.trim().split(/\s+/)
    const free = Number(cols?.[3])
    return Number.isFinite(free) ? free : null
  } catch { return null }
}

// 清理 Codex 运行日志：删超期行，碎片占比超阈值且安全闸全过才 VACUUM。
// keepDays 与 sessions 清理同源（手动端点用 body.keepDays，自动 tick 用 AUTO_CLEANUP_KEEP_DAYS）。
// 任何一道闸不过都是「告警 + 跳过对应动作」，绝不建表、绝不猜 schema。
function cleanupCodexLogs(keepDays) {
  const report = { db: CODEX_LOGS_DB, deletedRows: 0, beforeBytes: 0, afterBytes: 0, vacuumed: false, vacuumSkipped: '' }
  if (!existsSync(CODEX_LOGS_DB)) {
    noteErr('codex-logs-cleanup', new Error('logs_2.sqlite 不存在，跳过'))
    report.skipped = 'db-missing'
    return report
  }
  report.beforeBytes = statSync(CODEX_LOGS_DB).size
  let db = null
  try {
    db = new DatabaseSync(CODEX_LOGS_DB)
    // 库是 Codex 的：schema 对不上就跳过，不建表不猜列。
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get()
    if (table === undefined) {
      noteErr('codex-logs-cleanup', new Error('logs 表不存在（Codex 改过 schema？），跳过'))
      report.skipped = 'schema'
      return report
    }
    // 动手前先验库：integrity 非 ok 一律不动。
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check
    if (integrity !== 'ok') {
      noteErr('codex-logs-cleanup', new Error(`integrity_check=${integrity}，跳过`))
      report.skipped = 'integrity'
      return report
    }
    const cutoff = Math.floor(Date.now() / 1000) - Math.floor(keepDays) * 86400
    report.deletedRows = db.prepare('DELETE FROM logs WHERE ts < ?').run(cutoff).changes
    // 折叠 WAL 进主库，freelist 才能反映刚删的行；失败不致命（下次再折）。
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
    const pageCount = db.prepare('PRAGMA page_count').get()?.page_count ?? 0
    const freelist = db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0
    const fragment = pageCount > 0 ? freelist / pageCount : 0
    if (freelist <= pageCount * CODEX_LOGS_VACUUM_MIN_FRAGMENT) {
      report.vacuumSkipped = `fragment ${(fragment * 100).toFixed(1)}% <= ${CODEX_LOGS_VACUUM_MIN_FRAGMENT * 100}%`
    } else if (codexProcessRunning()) {
      report.vacuumSkipped = 'codex 在跑（WAL 独占锁会锁住它的写入），只删行不 VACUUM'
      noteErr('codex-logs-cleanup', new Error(report.vacuumSkipped))
    } else {
      const free = diskFreeBytes(CODEX_DIR)
      if (free === null) {
        // 「探测不到」≠「空间够」：df 不可用/解析失败时一律不 VACUUM（VACUUM 中途空间不足会失败并留下半写库）。
        report.vacuumSkipped = '磁盘余量探测失败（df 不可用或解析失败），只删行不 VACUUM'
        noteErr('codex-logs-cleanup', new Error(report.vacuumSkipped))
      } else if (free < report.beforeBytes * 2.5) {
        report.vacuumSkipped = `磁盘余量不足（free=${free}，需约 2 倍库大小），只删行不 VACUUM`
        noteErr('codex-logs-cleanup', new Error(report.vacuumSkipped))
      } else {
        db.exec('VACUUM')
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
        report.vacuumed = true
      }
    }
    return report
  } catch (e) {
    noteErr('codex-logs-cleanup', e)
    report.skipped = 'error'
    report.error = errMsg(e)
    return report
  } finally {
    try { db?.close() } catch { /* best effort */ }
    try { report.afterBytes = statSync(CODEX_LOGS_DB).size } catch { /* 库已被移走则保持 0 */ }
  }
}

async function handleCleanup(req, res) {
  try {
    // D8-①（2026-10-29）：引擎门禁。本函数删的是 SESSIONS_DIR = ~/.codex/sessions（:110），
    // 与当前激活引擎无关 —— 前端只是「Pi 面板不挂这张卡」，后端没有防线：
    // Pi 激活时直接 POST 本路由，照样把 Codex 的会话删了（跨引擎误删，不可撤销）。
    // 前端挂哪张卡不是安全边界，这里按 activeEngineId() 硬挡，且**在任何删除动作之前**。
    const gate = engineGateFor('codex')
    if (gate !== null) { send(res, { ok: false, ...gate }, 409); return }
    const body = await readBody(req)
    // 请求未带 keepDays 时用 settings 命名空间镜像来的默认值（客户端总会带上）。
    const keepDays = body.keepDays === undefined ? keepDaysDefault : Number(body.keepDays)
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      return send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
    }
    const stats = { removed: 0, freedBytes: 0 }
    cleanupSessions(SESSIONS_DIR, Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    cleanupLiveFiles(Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    cleanupReviewFiles(Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    // B：body 带 codexLogs:true 时顺带清 Codex 运行日志库（缺省不开——那是 Codex 自己的库，
    // 显式选择比默认动手稳；自动 tick 会按 AUTO_CLEANUP_KEEP_DAYS 兜底跑，见 runAutoCleanup）。
    const codexLogs = body.codexLogs === true ? cleanupCodexLogs(keepDays) : undefined
    // 把本次使用的保留天数回写到命名空间，使设置页卡片与本页一致（best effort）。
    if (secondEngineSettingsScope !== null) {
      try { void secondEngineSettingsScope.update({ keepDays: Math.floor(keepDays) }).catch(() => {}) } catch { /* settings 不可用时忽略 */ }
    }
    send(res, { ok: true, removed: stats.removed, freedBytes: stats.freedBytes, codexLogs })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /task、/tasks、/task/cancel：异步工单 ──

// 只要序列化安全的那部分（child/outPath/watchdog 绝不出进程）。
// P2（2026-10-28）：取消是「意图」，不是「事实」。
// 终态（status/exitCode/endedAt）只允许 finalizeJob 写（:1916 是全文件唯一赋值处）。
// 但用户点取消后必须立刻看到结果 —— 所以视图层把「意图已成立 + 事实上仍在跑」映射成
// 对外的 cancelled。内部 task.status 在子进程真正退出前保持 running。
export function viewStatus(task) {
  if (rtOf(task).isCancelled() && task.status === 'running') return 'cancelled'
  return task.status
}

export function taskView(task) {
  // P3.6：视图字段统一从 runtime.snapshot() 取，不再直读 task.<字段>。
  const snap = rtOf(task).snapshot()
  const view = {
    id: task.id,
    kind: task.kind === 'review' ? 'review' : 'task',
    // 2026-10-31 修：原来直接透传 snap.status，把 Pi runtime 的**内部三态词表**
    // （running / cancelling / finished）原样发给前端，而 lib/client.js 只认 Codex 的
    // （running / cancelled / done / error）—— Pi 点取消后面板认不出「已取消」。
    // 终态唯一写入口是 finalizeJob（见上方 :2793 注释），所以出口统一走 viewStatus 折算。
    status: viewStatus(task),
    exitCode: snap.exitCode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    workdir: task.workdir,
    output: typeof task.output === 'string' ? task.output : '',
    // 2026-10-31：暴露引擎归属 —— 前端原先分不出某条单是 Codex 还是 Pi 的（Pi 的单会混进
    // Codex 侧视图）。判据就是创建时写下的 `task.engine`（Pi 分支 :3600 已写 'pi'）。
    // ⚠️ 别用 `piProvider` 判：调用方不传 provider 时它是 undefined，会把 Pi 单误判成 codex
    // （2026-10-31 实机踩过：Pi 的单返回 engine:'codex'）。
    engine: task.engine === 'pi' ? 'pi' : 'codex',
    tokenUsage: task.tokenUsage ?? { status: 'pending' },
  }
  // 实时进度可见性：exec 模式看 liveBytes（过程流字节数，在涨=在动），
  // appserver 模式另加 progress（归一化事件）。
  if (snap.liveBytes !== undefined) view.liveBytes = snap.liveBytes
  if (snap.mode === 'appserver') {
    // T5：app-server 模式的实时进度（归一化事件，最近 20 条），供界面做流式展示。
    // progress 封闭投影（2026-10-28）：对外只发 {kind, text, at} 三字段。事件里其余的
    // 引擎专有形状（tool / usage / done / meta.eventType / itemId / contentIndex /
    // summaryIndex / willRetry）一律不外发 —— 那是 Codex app-server 的词表，第二个引擎
    // 一进 progress，消费端就得按引擎分支。排障用的原文见 task.engineEvents（不进本视图）。
    if (task.appServerParseFailures) view.appServerParseFailures = { ...task.appServerParseFailures }
    view.mode = 'appserver'
    view.progress = projectProgress(snap.progress)
  } else if (typeof snap.mode === 'string' && snap.mode !== '') {
    // 2026-10-31：其他引擎的 mode 也要透传（Pi 的 snapshot 已返回 'rpc'）。原先只在
    // appserver 分支里赋值，Pi 的 mode 就永远显示 None —— 实机见 `mode: None`。
    view.mode = snap.mode
  }
  // P1.1：活性时间 —— 与看门狗判据用同一个值（task.activityAt：事件心跳 ∨ 产物 mtime）。
  // stuckSuspect 是看门狗「上次采样」的结论，二者可能短暂不一致（例如产物被清理后归 0）。
  view.activityAt = snap.activityAt
  if (view.kind === 'review') {
    // 互审进度：第 N/上限轮 + 每轮 {issues,verdict} 全量（issues 体量小，列表也带上，展开即见）。
    view.round = Number.isInteger(task.round) ? task.round : 0
    view.maxRounds = Number.isInteger(task.maxRounds) ? task.maxRounds : REVIEW_DEFAULT_ROUNDS
    view.verdict = typeof task.verdict === 'string' ? task.verdict : ''
    view.rounds = Array.isArray(task.rounds) ? task.rounds : []
    // ⑤ 硬预算：「是哪道刹车生效」必须能从外部看出来（converged|rounds|wallclock|tokens|loop），
    // 否则事后无法判断是正常收敛还是被预算掐断；振荡时另给命中的历史轮次。
    if (typeof task.stopReason === 'string' && task.stopReason !== '') view.stopReason = task.stopReason
    if (Number.isInteger(task.loopWithRound)) view.loopWithRound = task.loopWithRound
    // 阻断硬档（2026-10-26）：stopReason=blocked 的独立布尔投影——调用方不必记
    // 「stopReason=blocked 即阻断」的映射规则；rounds[].verdict 与 task.verdict 里
    // 同步可见归一化后的 'blocked'。
    if (task.stopReason === 'blocked') view.blocked = true
    // 独立来源可见性（2026-10-26，secondop-panel 的 quorum 语义）：「converged 是谁说的」
    // 必须看得见——本插件恒 1 个独立复核家族（写代码的模型可以发言但永不计入 quorum，
    // 本插件里「写方发言」就是被审 content 本身）。只读证据字段（同 reviewDirty：证据、
    // 非归因），不参与任何收敛/终止判定。
    view.independentSources = INDEPENDENT_SOURCES
    view.quorumNote = QUORUM_NOTE
    // #6：复核窗口内新变脏的路径（证据非归因），只外显不参与判定。
    if (task.reviewDirty !== null && task.reviewDirty !== undefined) view.reviewDirty = task.reviewDirty
    // 跨轮 ledger（2026-10-26）：稳定 id 的讨论状态账本（open/resolved/disputed + 继承链），
    // 主 AI 据此按 issueId 回辩；含接力种子，讨论跨调用可追溯。
    if (Array.isArray(task.issueLedger)) view.issueLedger = task.issueLedger
    // ① 接力链：上一轮复核任务 id（谱系可追）。
    if (typeof task.prevId === 'string' && task.prevId !== '') view.prevId = task.prevId
  }
  if (snap.stuckSuspect) view.stuckSuspect = true
  if (snap.lastSignal) view.lastSignal = snap.lastSignal
  // ① 对账 tick 判失联的原因（'process-gone' | 'pid-reused'）——不暴露就没法验收探活。
  if (typeof snap.reconcileLost === 'string' && snap.reconcileLost !== '') view.reconcileLost = snap.reconcileLost
  if (typeof snap.error === 'string' && snap.error !== '') view.error = snap.error
  // appserver 模式的失败原因记在 appError（原先不外发，外部无从诊断）。
  if (view.error === undefined && typeof snap.appError === 'string' && snap.appError !== '') view.error = snap.appError
  if (task.notifyUndelivered === true) view.notifyUndelivered = true
  return view
}

// 摘要：不含 output（列表只给状态，全文按需点开再取）。
export function taskSummary(task) {
  const view = taskView(task)
  delete view.output
  return view
}

// 任务表封顶，避免长时间运行后无限增长；只淘汰已结束的最旧条目。
export function pruneTasks() {
  if (tasks.size <= TASK_KEEP_LIMIT) return
  const finished = [...tasks.values()]
    .filter((t) => t.endedAt !== null && t.endedAt !== undefined)
    .sort((a, b) => a.endedAt - b.endedAt)
  for (const victim of finished) {
    if (tasks.size <= TASK_KEEP_LIMIT) break
    tasks.delete(victim.id)
  }
}

// P3.2（2026-10-28）：看门狗与活性已搬进 src/engine/runtime.js（TaskRuntime 第一块）。
// 这里只保留同名薄封装，调用点不动；rtOf 惰性建 runtime（WeakMap，随 task 回收）。
const runtimes = new WeakMap()
export function rtOf(task) {
  let rt = runtimes.get(task)
  if (rt === undefined) {
    const eng = engineOf(task)
    const deps = { notify, readProcStartTime }
    if (eng.id === 'pi') {
      const usable = resolvePiProvider(typeof task.piProvider === 'string' ? task.piProvider : '')
      if (usable !== null) deps.env = { [`${usable.id.toUpperCase()}_API_KEY`]: usable.key }
      deps.provider = typeof task.piProvider === 'string' && task.piProvider !== '' ? task.piProvider : usable?.id
      deps.model = typeof task.piModel === 'string' && task.piModel !== '' ? task.piModel : usable?.model
      if (usable === null) noteErr('pi-env', new Error('没有可用的 Pi provider/API Key'))
    }
    rt = eng.create(task, deps)
    runtimes.set(task, rt)
  }
  return rt
}

// 任务结束即停看门狗（finalizeTask / finalizeReview 都会调用）。
function stopWatchdog(task) { rtOf(task).stopWatchdog() }

// spawn 后启动：每 30s 看一次活性（心跳 ∨ -o 文件 mtime 兜底），超 300s 无变化 → stuckSuspect + 通知一次。
export function startWatchdog(task) { rtOf(task).startWatchdog() }


// ── A（2026-10-25）：唯一收尾路径 ──
// finalizeTask 与 finalizeReview 原是两套平行实现且行为漂移（复核不读 output、不删
// outPath，轮次文件只能靠 keepDays 清理兜底）—— 统一为 finalizeJob：
// 读 output / 置状态 / 删 outPath(+.live) / 追加 consult 块，只落定一次。
// 首次落定即返回 true（后续重复调用是 no-op），保证通知只发一次。

// consult 关联（A，2026-10-25）：优先按 consult.taskId === task.id 精确绑定；
// 旧数据（无 taskId）才回退「at >= 任务开始」时间窗。
function consultsForTask(task) {
  const started = typeof task.startedAt === 'number' ? task.startedAt : 0
  return consults.filter((c) =>
    (typeof c.taskId === 'string' && c.taskId !== '' && c.taskId === task.id)
    || ((c.taskId === undefined || c.taskId === null || c.taskId === '') && typeof c.at === 'number' && c.at >= started))
}


// P2.3（2026-10-28）：finalizeJob 的 extra 是历史旁路 —— 若允许任意字段，等于给
// 「终态唯一落定」开一个后门（任何调用方都能绕过 status/exitCode 直接改 task）。
// 当前唯一调用方 finalizeReview 只传这两个复核专属字段，故按白名单收口。
const FINALIZE_EXTRA_ALLOWED = new Set(['verdict', 'error'])

export function finalizeJob(task, exitCode, status, extra) {
  if (task.endedAt !== null && task.endedAt !== undefined) return false
  clearCancelTimers(task)
  stopWatchdog(task)
  // exitCode 省略 = 保留调用方已记的值：复核每轮在 runReview 里自记 exitCode，不能覆盖。
  if (exitCode !== undefined) rtOf(task).setExitCode(exitCode)
  task.status = status
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (FINALIZE_EXTRA_ALLOWED.has(k)) task[k] = v
      else noteErr('finalizeJob.extra', new Error(`拒绝未知 extra 字段: ${k}`))
    }
  }
  // 读 -o 输出（头尾截断），成功才覆盖：复核轮文件在 readReviewOut 里逐轮已删、
  // 工单也可能没生成输出文件 —— 读不到时保留现有 output，这是常态不是错误。
  const jobOutPath = rtOf(task).getOutPath()
  try { task.output = readHeadTail(jobOutPath, TASK_OUTPUT_CLIP) } catch { /* 保留现有 output */ }
  // A 方案（2026-10-17 用户定）：过程流 `.live` 同样在收尾时删除 —— ephemeral 工单跑完
  // 不在磁盘留任何输出。要事后回看过程就勾「保留会话」（ephemeral:false，走 rollout）。
  // 复核被熔断时本轮 -o 文件还在（readReviewOut 没跑到），这里一并回收，不再单靠 keepDays。
  try { unlinkSync(jobOutPath) } catch { /* 文件可能本就没生成/已被逐轮清理，忽略 */ }
  try { unlinkSync(`${jobOutPath}.live`) } catch { /* 未生成或已被清，忽略 */ }
  try { unlinkSync(`${jobOutPath}.live.1`) } catch { /* 轮转备份同一收尾时机删除 */ }
  // 本次任务期间收到过 Codex 卡点求助？追加进 output —— 主 AI 收单必读 output，这是它唯一必经的通道。
  // 互审是最容易绕圈求助的场景，统一路径后两条收尾天然都不漏。
  try { appendConsultBlock(task, consultsForTask) } catch (e) { noteErr('consult', e) }
  task.endedAt = Date.now()
  finishSpawnAudit(rtOf(task).child(), exitCode, rtOf(task).child()?.signalCode, new Date(task.endedAt).toISOString())
  accountJob(task)
  return true
}

// 工单收尾：统一走 finalizeJob。
export function finalizeTask(task, exitCode, status) {
  const first = finalizeJob(task, exitCode, status)
  if (first) publishTaskReport(task, buildReport(task))
  return first
}

function clearCancelTimers(task) {
  const timers = task.cancelTimers
  if (!timers) return
  for (const timer of Object.values(timers)) {
    if (timer !== null) clearTimeout(timer)
  }
  task.cancelTimers = null
}

// 完成/停滞通知：走本机 3090 桥的 /app/notify（token 鉴权）。3 秒超时，任何失败静默忽略。
export function notify(text, title = '第二引擎') {
  return new Promise((resolve) => { try {
    let token = ''
    try { token = readFileSync(NOTIFY_TOKEN_PATH, 'utf8').trim() } catch { resolve(false); return }
    if (token === '') { resolve(false); return }
    const url = `${NOTIFY_URL}?token=${encodeURIComponent(token)}`
      + `&title=${encodeURIComponent(title)}`
      + `&text=${encodeURIComponent(text)}`
    const req = http.get(url, (resp) => {
      let body = ''
      resp.setEncoding('utf8')
      resp.on('data', (chunk) => { body += chunk })
      resp.on('end', () => { try { const parsed = JSON.parse(body); const result = typeof parsed.result === 'string' ? parsed.result : ''; if (/UNAUTHORIZED/i.test(result)) resolve(false); else if (/FOREGROUND_SKIP/i.test(result)) resolve(true); else resolve(/ok/i.test(result)) } catch { resolve(false) } })
      resp.on('error', () => resolve(false))
    })
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => { try { req.destroy() } catch { /* best effort */ } })
    req.on('error', () => resolve(false))
  } catch { resolve(false) } })
}

function auditNotifyFailure(task, reason) {
  try { const dir = boardDir(); mkdirSync(join(dir, 'audit'), { recursive: true }); appendFileSync(join(dir, 'audit', 'notify.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: task?.id, reason }) + '\n') } catch (e) { noteErr('notify-audit', e) }
}

export function notifyTask(task) {
  const label = task.kind === 'review' ? '复核' : '任务'
  const exCode = rtOf(task).getExitCode()
  const exit = Number.isInteger(exCode) ? ` (exit ${exCode})` : ''
  let text = `${label} ${task.id.slice(-6)} ${task.status}${exit}`
  // 阻断硬档（2026-10-26）：通知层就要醒目——这是「必须停手」档，不能只靠 taskView 查。
  if (task.kind === 'review' && task.stopReason === 'blocked') {
    text += '｜⛔ 阻断级问题（blocked，禁止上线）'
  }
  // #6：复核窗口内工作区新变脏 → 通知带出来（证据非归因，明细看 task.reviewDirty）。
  if (task.kind === 'review' && task.reviewDirty !== null && task.reviewDirty !== undefined) {
    text += `｜⚠️ 复核窗口内工作区新增 ${task.reviewDirty.total} 处改动`
  }
  void notify(text).then((ok) => { if (!ok) { task.notifyUndelivered = true; auditNotifyFailure(task, 'app notify rejected or unavailable') } })
}





// ── #8-10（2026-10-25）：复核接力链 ──
// ③ 摘要进 output：主 AI 收单必读 output（与 appendConsultBlock 同通道同先例），
// 它即使不知道 /api/reviews，下一次 GET /task?id= 也能看到未决问题与接力入口。
// （dual-board 收件箱被否决：inbox-append --sender 只允许 {lead,codex}，插件写入=冒充协议方。）



// 数量截断：目录超 REVIEW_KEEP_FILES 个按 mtime 删最旧。






async function gitCommitEnv(workdir) {
  const hasEmail = await gitOk(['config', '--get', 'user.email'], { cwd: workdir, timeout: 15000 })
  return hasEmail ? process.env : {
    ...process.env,
    GIT_AUTHOR_NAME: 'second-engine',
    GIT_AUTHOR_EMAIL: 'second-engine@localhost',
    GIT_COMMITTER_NAME: 'second-engine',
    GIT_COMMITTER_EMAIL: 'second-engine@localhost',
  }
}

export async function ensureGitBaseline(workdir) {
  try {
    const wd = resolve(workdir)
    const home = homedir()
    // 护栏（2026-10-14 事故）：绝不在家目录/根/含运行数据的目录里 git init + git add -A。
    // 复盘：调用方传了相对路径 "."，按 Web 进程 cwd 解析成 /root，于是把整张家目录
    //（含 .ssh/qq_access、.dsh/creds/*、.codex/*）加进了 git 索引。
    if (wd === home || wd === dirname(home) || wd === '/') return
    if (/(^|\/)(\.ssh|\.dsh|\.codex|\.gnupg|\.config)(\/|$)/.test(wd)) return
    if (existsSync(join(wd, '.git'))) return
    if (!(await gitOk(['init'], { cwd: wd, timeout: 30000 }))) return
    const env = await gitCommitEnv(wd)
    await gitOk(['add', '-A'], { cwd: wd, env })
    await gitOk(['commit', '--allow-empty', '-m', 'second-engine 基线'], { cwd: wd, env })
  } catch { /* best effort：基线失败不影响任务本身 */ }
}

// ── progress 封闭投影（2026-10-28）──
// task.progress 与对外 progress 的唯一形状定义处；kind 沿用 app-server-client 已有的
// 6 个封闭字面量（status|text|reasoning|tool|usage|done），不新增、不透传协议方法名。
// 字段名 progress 保持不变（外部消费者可能按名字取数组）。
const PROGRESS_KINDS = new Set(['status', 'text', 'reasoning', 'tool', 'usage', 'done'])
const PROGRESS_TEXT_LIMIT = 2000
export const PROGRESS_LIMIT = 20

// 归一化事件 → 封闭条目：显式构造，绝不展开原事件（缺字段就是空串，不会带出引擎形状）。
export function progressEntry(evt, at) {
  const kind = PROGRESS_KINDS.has(evt?.kind) ? evt.kind : 'status'
  let text = typeof evt?.text === 'string' ? evt.text : ''
  if (text === '' && kind === 'tool') {
    // tool 事件的正文在 tool.aggregatedOutput（命令输出预览），投影成 text 才有可读性。
    const out = evt?.tool && typeof evt.tool.aggregatedOutput === 'string' ? evt.tool.aggregatedOutput : ''
    const cmd = evt?.tool && typeof evt.tool.command === 'string' ? evt.tool.command : ''
    text = out !== '' ? out : cmd
  }
  return { kind, text: text.slice(0, PROGRESS_TEXT_LIMIT), at }
}

// 对外投影：只取最近 PROGRESS_LIMIT 条，且逐条重建（顺带兼容改动前留在内存里的旧形状条目）。
function projectProgress(list) {
  if (!Array.isArray(list)) return []
  return list.slice(-PROGRESS_LIMIT).map((e) => progressEntry(e, e?.at ?? null))
}


// POST /task：body { prompt, workdir?, ephemeral? }。立刻返回 { ok, id }，任务后台跑。
// ephemeral 缺省 true（不落盘 rollout），只有显式 body.ephemeral === false 才持久化会话。
export async function handleTaskCreate(req, res) {
  try {
    if (!checkTokenBudget(res)) return
    const body = await readBody(req)
    const boardId = requestedBoardId(body)
    const request = normalizeTaskRequest(body, { workdir: DEFAULT_TASK_WORKDIR, engine: activeEngineId() })
    const { prompt, workdir } = request
    if (prompt === '') return send(res, { ok: false, error: 'prompt 不能为空' }, 400)
    if (!existsSync(workdir)) {
      return send(res, { ok: false, error: `workdir 不存在：${workdir}` }, 400)
    }
    // P4.2（2026-10-28）：按引擎分流。Pi 走自己的 provider（env/models.json），
    // 不依赖 Codex 的 keyring，所以这一支必须在 loadKeyring 之前。
    const engineId = request.engine
    if (engineId === 'pi') {
      const requestedPiProvider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const piProvider = resolvePiProvider(requestedPiProvider)
      if (piProvider === null) {
        return send(res, { ok: false, error: '没有可用的 Pi provider/API Key；请先在第二引擎设置中配置 provider' }, 400)
      }
      // 请求里的 model 原来只判类型就原样下发 —— 名字写错时 Pi 自行失败或回退，
      // 用户看到「跑完了但不是我选的模型」。下发前用探测到的可用集合校验一次；
      // 探测拿不到（null / 空数组：没装 pi 或没配 key）时放行，不能因为探不到就拦住正常使用。
      const requestedPiModel = typeof body.model === 'string' ? body.model.trim() : ''
      if (requestedPiModel !== '') {
        const avail = await piAvailableModels().catch(() => null)
        if (Array.isArray(avail) && avail.length > 0) {
          const names = avail.map((m) => (typeof m === 'string' ? m : String(m?.id ?? m?.model ?? '')))
          if (!names.includes(requestedPiModel)) {
            const head = names.slice(0, 8).join(', ')
            return send(res, {
              ok: false,
              error: `Pi 没有模型 "${requestedPiModel}"；当前可用：${head}${names.length > 8 ? ` 等 ${names.length} 个` : ''}`,
            }, 400)
          }
        }
      }
      const piId = newId()
      return startPiTask({
        res,
        id: piId,
        boardId,
        outPath: join(CODEX_DIR, `task-${piId}.out`),
        workdir,
        prompt,
        model: typeof body.model === 'string' ? body.model : undefined,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
      })
    }

    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    if (active === undefined) return send(res, { ok: false, error: '没有可用的 active 提供方' }, 400)

    const id = newId()
    const outPath = join(CODEX_DIR, `task-${id}.out`)
    if (execMode() === 'appserver') {
      startAppServerTask({
        res,
        id,
        outPath,
        workdir,
        prompt,
        envKey: `${active.id.toUpperCase()}_API_KEY`,
        apiKey: active.apiKey,
        boardId,
        model: request.model,
      })
      return
    }
    const args = [
      'exec',
      '--skip-git-repo-check',
      // 规划 8.3-10①：缺省按临时工单跑（不落盘 rollout），显式 false 才留档。
      ...(body.ephemeral === false ? [] : ['--ephemeral']),
      '-o', outPath,
      // 提示词改走 stdin（'-' 占位）：argv 不再携带正文。2026-09-24 实证：prompt 以 argv
      // 出现在 /proc/<pid>/cmdline 时，工单若执行 pkill -f <模式>（如 dsh-browser 的
      // headless_shell 拼接串）会命中父进程自身 → 自杀（三单 76/97.5/101.3s 死亡的真因）。
      '-',
    ]
    // 与面板写 key 时同一套 env_key 约定：<PROVIDER_ID 大写>_API_KEY。
    const envKey = `${active.id.toUpperCase()}_API_KEY`
    await ensureGitBaseline(workdir)
    const live = { bytes: 0, path: `${outPath}.live`, rotatedAt: 0 }
    const child = spawnLimited(resolveCodexBinary(), args, {
      cwd: workdir,
      env: { ...process.env, [envKey]: active.apiKey },
      // stdin 改 pipe：写入提示词后立即 end()，EOF 自然到达（codex exec 等 stdin EOF 开始干活）。
      stdio: ['pipe', 'pipe', 'pipe'],
    }, 'codex-exec')
    // stdin EPIPE 兜底：codex 启动失败/早退时写 stdin 触发的是异步 error 事件，
    // 不挂监听器即 uncaughtException，整个 Web 宿主跟着崩。
    child.stdin?.on('error', () => { /* codex 已退出：exit/error 回调收尾 */ })
    child.stdin?.write(prompt)
    child.stdin?.end()
    // stdout/stderr 必须持续排空：长任务过程流写满管道缓冲（~64KB）后 codex 被写阻塞、永不退出
    // → 看门狗 300s 误杀（2026-09-24 三单复现实证）。
    // 同时**实时落盘到 <outPath>.live** 并计数：这样 exec 模式也能"直观看到有没有在动"
    // （最终结果仍以 -o 文件为准；live 文件是过程流，保留供诊断）。
    // 2026-10-24 改异步 WriteStream：逐块 appendFileSync 是同步系统调用，高频输出时反复阻塞事件循环。
    const livePath = `${outPath}.live`
    const openLiveStream = (flags) => {
      const stream = createWriteStream(livePath, { flags })
      stream.on('error', () => { /* 磁盘满等：丢这一段过程流，不影响任务本身 */ })
      return stream
    }
    let liveStream = openLiveStream('a')
    const writeLive = (buf) => {
      task.usageTail = ((task.usageTail ?? '') + buf.toString()).slice(-8192)
      live.bytes += buf.length
      // 保留最近两段；旧流排队中的写入继续落在 rename 后的 inode，绝不截断它。
      // 首次异步 open 完成后才能 rename；新 fd 同步打开，避免紧接着 finalize 又创建 .live。
      if (live.bytes - live.rotatedAt > LIVE_ROTATE_BYTES && !liveStream.pending && !liveStream.destroyed) {
        let renamed = false
        try {
          renameSync(livePath, `${livePath}.1`)
          renamed = true
          const next = createWriteStream(livePath, { fd: openSync(livePath, 'a') })
          next.on('error', () => { /* 诊断日志失败不影响任务 */ })
          const previous = liveStream
          liveStream = next
          live.rotatedAt = live.bytes
          previous.end()
        } catch {
          // 切换失败仍沿用旧流；新文件打开失败时恢复路径，下个 chunk 可再次尝试。
          if (renamed) { try { renameSync(`${livePath}.1`, livePath) } catch { /* best effort */ } }
        }
      }
      liveStream.write(buf)
    }
    child.stdout?.on('data', writeLive)
    child.stderr?.on('data', writeLive)
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
      live,
      cancelled: false,
      // P1.1 心跳：exec 模式不产事件，活性仍由 -o/.live 文件 mtime 兜底（此值保持 0）。
      }
    tasks.set(id, task)
    pruneTasks()
    // P3.3 修正（2026-10-28）：exec 工单的 child 原先只在对象字面量里，没交给 runtime ——
    // 导致 handleTaskCancel 的 rtOf(task).kill() 拿到 null，进程杀不死、终态永不落定。
    rtOf(task).setChild(child)
    // 2026-10-31 修（对照 task-reaper 时发现）：exec 工单原先**只 setChild、没记 childPid**。
    // 而 `probeTaskLost()` 靠 `rt.getChildPid()` 判断，pid 非整数就直接 return null ——
    // 于是 reconcile 的失联检测**对 exec 工单完全失效**（与 Pi runtime 那个 PID 登记坑同源，
    // 只是这处一直没被触发路径暴露）。照复核分支的写法在 spawn 后立即固定身份。
    rtOf(task).setChildPid(Number.isInteger(child.pid) ? child.pid : null)
    rtOf(task).setChildStart(rtOf(task).getChildPid() === null ? null : readProcStartTime(rtOf(task).getChildPid()))
    void persistBoardChild(task)
    startWatchdog(task)

    child.on('exit', (code, signal) => {
      // 被取消的任务固定 cancelled/-1；其余按真实退出码判定。
      // 2026-10-28（P1.2）：取消是独立终态，不再与失败混用 'error' —— 客户端
      // lib/client.js:1349/:1509 已把 'cancelled' 当合法值（显示「已取消」）。
      const cancelled = rtOf(task).isCancelled()
      const exitCode = cancelled ? -1 : (Number.isInteger(code) ? code : -1)
      const status = cancelled ? 'cancelled' : (exitCode === 0 ? 'done' : 'error')
      // 记录终止信号：exitCode=-1 时只有它能区分「外部 SIGTERM/SIGKILL」与「spawn 失败」。
      rtOf(task).setLastSignal(signal)
      // 取消是用户主动动作，收尾读 output，但不再打扰一次通知。
      if (finalizeTask(task, exitCode, status) && !cancelled) void notifyTask(task)
      try { liveStream.end() } catch { /* best effort */ }
    })
    // spawn 失败（如二进制缺失）不触发 exit，这里兜底收尾；错误原因记进 task.error，
    // 外部才能诊断（原先 err 被丢弃，只剩 status:'error' 与空 output）。
    child.on('error', (e) => {
      task.error = errMsg(e)
      try { liveStream.end() } catch { /* best effort */ }
      if (finalizeTask(task, -1, 'error')) void notifyTask(task)
    })

    send(res, { ok: true, id })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}





// ── /review、/review/cancel：双向互审 ──
// 两引擎相互批判性复核：每轮把同一份 content 交给独立复核引擎，只累加 issues 对照，
// 不做自动改写（v1 语义）；issues 清空即收敛，轮数到顶即打包交用户裁决。

const clipText = (text, limit = REVIEW_RAW_CLIP) => {
  const str = String(text === undefined || text === null ? '' : text)
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}

// 宽松解析：从自由文本里截取「首个配平的 {...} 块」（跳过字符串内的花括号与转义）。
const ISSUE_PUNCT_TABLE = { '，': ',', '、': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '（': '(', '）': ')', '【': '[', '】': ']', '「': '"', '」': '"', '『': '"', '』': '"', '“': '"', '”': '"', '‘': "'", '’': "'", '—': '-', '－': '-', '～': '~', '《': '<', '》': '>' }
const ISSUE_PUNCT_RE = /[，、。！？：；（）【】「」『』“”‘’—－～《》]/g
// fingerprint：sha256(severity + '\0' + 规范化 point) 前 12 位 hex（v1 的 id 算法原样保留，
// 只是不再当身份）。仅用于同一条目「文本是否原样重列」的判断与 mergedFrom 谱系留痕。

// ── 相似度归并阈值（提成常量，调参只动这里）──
// 归并须同时满足：severity 相同、point 3-gram Jaccard ≥ ISSUE_MERGE_THRESHOLD、
// suggestion 3-gram Jaccard ≥ ISSUE_MERGE_SUGGESTION_THRESHOLD。point 太松会把近邻
// 主张并成一条，suggestion 太松会把「同问题不同修法」拧成同一条。
const ISSUE_MERGE_THRESHOLD = 0.8
const ISSUE_MERGE_SUGGESTION_THRESHOLD = 0.5

// 引用形态：i<N>（v2 账本 id）或 4..64 位 hex（v1 内容哈希——经 ledger aliases 仍可命中）。

// 旧记录/旧种子里的 issues 可能带 v1 哈希 id：归一化后把旧 id 留在 legacyId 上，
// 开账（handleReviewCreate 接力）时收进条目 aliases——用旧哈希 ID 回辩仍命中。
export function ensureIssueIds(issues) {
  return (Array.isArray(issues) ? issues : []).map((raw) => {
    const issue = normalizeIssue(raw)
    const legacy = asText(raw?.id).trim().toLowerCase()
    if (legacy !== '' && !/^i\d+$/.test(legacy) && ISSUE_REF_RE.test(legacy)) issue.legacyId = legacy
    return issue
  })
}

// 归一化单条 issue：severity/point/suggestion 一律收敛成字符串，形状稳定；
// fingerprint 服务端计算；id 不在 parse 时定——由 mergeRoundIntoLedger 按归并结果
// 沿用/分配（i<N>），措辞改写不再换号。continuesIssueId 是 Codex 声明的继承引用
//（reworded 前身；replacesIssueId 为等价旧名），只认 i<N>/hex 形态才保留
//（防把自由文本塞进 ledger 继承链）。

// ── 复核回辩通道（B 方案，2026-10-26）：主 AI 与 Codex 的真讨论 ──
// 旧链路是单向批判：prev 只装 Codex 自己上一轮的 issues，主 AI 的立场不在输入里，
// 多轮收敛的只是它的自我一致性（内容不变 → 第 5 轮只能判 loop）。回辩通道把主 AI 的
// 逐条回应带进提示词，Codex 必须逐条裁决（withdrawn/upheld/reworded），讨论跨调用接力。

// 清洗主 AI 的回应条目 [{issueId?, issueIndex?, decision, reason}]：
// issueId 优先（i<N> 账本 id；v1 哈希 id 亦收——命中经 ledger aliases）；issueIndex 兼容旧入参（缺省回退数组下标），
// 二者都缺/都非法的条目丢弃。decision 是主 AI 的立场（accepted|partial|rejected），
// 与 Codex 的裁决轴（withdrawn|upheld|reworded）不互译——主 AI accepted 的一条，Codex
// 仍可因「问题在当前内容里还在」而 upheld。非法 decision 原样保留（留痕），不参与任何判定。
// id → ledger 条目的最终解析在 handleReviewCreate（那里才知道可用的 id 池）。

// 清洗 Codex 的逐条裁决 [{issueId?, issueIndex?, verdict, reason}]：verdict 收敛小写；
// 不在 {withdrawn, upheld, reworded} 里的取值原样保留（落盘可查），但只有严格
// 等于 'upheld' 才参与终止判定。issueId 优先、issueIndex 兼容（旧式只有 index 的
// 输出照常收）；同 id（或同 index）重复后者胜。

// responses 的 issueIndex 兼容解析：下标指上一轮（首轮即接力种子）的意见，能对上就
// 就地补稳定 id（补齐后再进 ledger 与落盘，按 id 可追）。已带 issueId 的原样通过；
// 对不上的（越界/无 prev）保持原样——留痕，不参与 ledger 判定。
export function resolveResponseIds(responses, prevIssues) {
  const seed = Array.isArray(prevIssues) ? prevIssues : []
  return (Array.isArray(responses) ? responses : []).map((r) => {
    if (r === null || typeof r !== 'object' || (typeof r.issueId === 'string' && r.issueId !== '')) return r
    const target = Number.isInteger(r.issueIndex) ? seed[r.issueIndex] : undefined
    return target !== undefined && typeof target.id === 'string' ? { ...r, issueId: target.id } : r
  })
}

// 三字段文本指纹（severity/point/suggestion 原文拼接）：textHistory 变化检测用——
// 归并进同一账本条目但措辞/建议微调时追记一条历史，而不是无感覆盖。

// ── 跨轮 issue ledger（2026-10-26 v2）：i<N> 序号账本 + 相似度归并 ──
// 条目：{id:'i<N>', fingerprint, severity, point, suggestion, firstRound, lastRound,
//   status:'open'|'resolved'|'disputed', resolvedRound?, inheritedFrom?,
//   aliases:[v1 哈希 id...], mergedFrom:[被归并替换掉的旧指纹...],
//   textHistory:[{round,severity,point,suggestion}]}
// id 是账本内单调递增序号（task.issueSeq 持久分配、接力接续），首现分配后终身沿用
//——措辞再怎么改写也沿用同一 id；跨轮对齐靠归并（见 mergeRoundIntoLedger），不靠
// id 重算。轮号是「链上轮号」= ledgerBase + 本任务轮号：接力（prev）时 ledgerBase
// 接续上一调用 ledger 的最大 lastRound，跨调用单调递增，讨论谱系一条线可追。
// v1 记录迁移（normalizeLedgerEntries）：无 i<N> id 的条目按首现顺序分配 i1..iN，
// 原哈希 id 进 aliases——用旧哈希 ID 回辩/引用仍命中（查 aliases）。

// id/alias → 条目 的索引（回辩与 responses 解析共用：旧哈希引用经 aliases 命中）。



// ledger 终止判据（纯函数）：open/disputed 清零 且 本轮 responses 无 upheld → converged。
// 取代旧的下标版 dialogueConverged（「issues 无新增且无 upheld」）：旧判据下「原样重列
// 但不坚持」也算收敛；账本口径更严——问题还挂在 issues 里就是未了结。

// ── 阻断硬档（2026-10-26，对齐 secondop-panel 的 BLOCK 档）──
// 语义：不可上线（涉及钱 / 数据丢失 / 安全漏洞）⇒ 必须停手，不是「再来一轮看看」。
// 识别两源（任一即判）：① verdict 说出 block/blocked（大小写不敏感、允许前后空白）；
// ② 任一 issue 的 severity 属 blocker/critical/block（同大小写不敏感）。两源都归一化成
// 统一的 'blocked'（verdict 字符串 + parsed.blocked 布尔），原始取值不透传——落盘与
// rounds[] 只有 blocked 一种形态，调用方不必匹配一堆变体。
const BLOCK_VERDICT_RE = /^block(ed)?$/i
const BLOCK_SEVERITIES = new Set(['blocker', 'critical', 'block'])
export function isBlockedVerdict(verdictText, issues) {
  if (BLOCK_VERDICT_RE.test(String(verdictText ?? '').trim())) return true
  return (Array.isArray(issues) ? issues : [])
    .some((i) => BLOCK_SEVERITIES.has(String(i?.severity ?? '').trim().toLowerCase()))
}

// 解析复核输出 → { ok:true, issues, verdict, responses } 或 { ok:false, raw }。
// issues 必须是数组（缺键视为解析失败：宁可报错也不误判「已收敛」）。
// responses 可缺省：旧格式（无该键）照常解析，缺失 = 未回应，恒为 []。
// blocked 时返回值另带 blocked:true，verdict 恒为归一化后的 'blocked'。


// c)（#6，2026-10-25）：被审产出用成对分隔标记包住并声明「数据非指令」——content 是
// 任意字符串、原样进 prompt，而它交给的是 danger-full-access + approval never 的进程，
// 这里从结构上把「材料里夹带的指令」隔离掉一层。标记串在 content 内出现时先中和，防自封闭。
const REVIEW_MATERIAL_BEGIN = '<<<待审材料-开始>>>'
const REVIEW_MATERIAL_END = '<<<待审材料-结束>>>'




// 从 codex exec 输出尾部抽 "tokens used\nN"（codex 自报的累计用量）。
// 抽不到返回 0 —— 宁可少算也不误停（硬预算语义是"到量才停"，不是"猜一个"）。

// 振荡检测用的稳定指纹：只取 issues 的三个语义字段，排序后哈希（顺序无关）。
// 两个 AI 在「主张 X / 反对 X」之间来回时，同一批 issues 会原样回来 → 命中即判循环。






export async function handleConfigSet(req, res) {
  try {
    const body = await readBody(req)
    // reviewRounds 改为「传了才改」（与 wallMs/tokenLimit 同款可选语义）：
    // collab-only 写入不再被它挡 400；但一个可设置字段都没有时仍 400。
    let rounds = null
    if (body.reviewRounds !== undefined && body.reviewRounds !== null) {
      const n = Number(body.reviewRounds)
      if (!REVIEW_ROUNDS_CHOICES.includes(n)) {
        return send(res, { ok: false, error: `reviewRounds 只支持 ${REVIEW_ROUNDS_CHOICES.join(' / ')}` }, 400)
      }
      rounds = n
    }
    // 硬预算为**可选**字段：传了才改，且拒绝过小值（避免"0 预算"让互审一进去就停）。
    let wallMs = null
    if (body.reviewWallMs !== undefined && body.reviewWallMs !== null) {
      const n = Number(body.reviewWallMs)
      if (!Number.isFinite(n) || n < REVIEW_MIN_WALL_MS) {
        return send(res, { ok: false, error: `reviewWallMs 必须是不小于 ${REVIEW_MIN_WALL_MS} 的数字（毫秒）` }, 400)
      }
      wallMs = Math.floor(n)
    }
    let tokenLimit = null
    if (body.reviewTokenLimit !== undefined && body.reviewTokenLimit !== null) {
      const n = Number(body.reviewTokenLimit)
      if (!Number.isFinite(n) || n < REVIEW_MIN_TOKEN_LIMIT) {
        return send(res, { ok: false, error: `reviewTokenLimit 必须是不小于 ${REVIEW_MIN_TOKEN_LIMIT} 的数字` }, 400)
      }
      tokenLimit = Math.floor(n)
    }
    // 协作两位：{preset}（展开成两位；与显式位同给时 preset 优先）或显式 {voice,longtask}
    //（第四组合 off/auto 只能走显式位）。显式写法里未给的位保持当前生效值。
    let collabBits = null
    const presetRaw = typeof body.preset === 'string' ? body.preset.trim() : ''
    if (presetRaw !== '') {
      const map = {
        review: { voice: 'off', longtask: 'manual' },
        propose: { voice: 'on', longtask: 'manual' },
        longtask: { voice: 'on', longtask: 'auto' },
      }
      collabBits = map[presetRaw] ?? null
      if (collabBits === null) {
        return send(res, { ok: false, error: 'preset 只支持 review / propose / longtask' }, 400)
      }
    } else if (body.voice !== undefined || body.longtask !== undefined) {
      const cur = resolveCollab()
      const v = body.voice === undefined ? cur.voice : (body.voice === 'on' || body.voice === 'off' ? body.voice : null)
      const l = body.longtask === undefined ? cur.longtask : (body.longtask === 'auto' || body.longtask === 'manual' ? body.longtask : null)
      if (v === null || l === null) {
        return send(res, { ok: false, error: 'voice 只支持 on/off，longtask 只支持 auto/manual' }, 400)
      }
      collabBits = { voice: v, longtask: l }
    }
    // P4.3 修（2026-10-28 实测）：engine-only 请求曾被这条前置检查挡成 400，
    // 导致面板切引擎静默失败（engine 处理在函数末尾）。这里把 engine 也算作可设置字段。
    const hasEngine = typeof body.engine === 'string' && body.engine !== ''
    if (rounds === null && wallMs === null && tokenLimit === null && collabBits === null && !hasEngine) {
      return send(res, { ok: false, error: '没给任何可设置字段（reviewRounds / preset / voice+longtask / engine）' }, 400)
    }
    // P2-1（2026-11-01）：engine 的「未知」与「有运行中工单的 409」都必须在**任何写入之前**
    // 判定——原先它们放在函数末尾，混合请求（reviewRounds + 非法 engine）会先写配置再回 400，
    // 造成「部分成功却报失败」。这里只做校验，不落盘。
    let engineSwitched = null
    if (hasEngine) {
      if (ENGINES[body.engine] === undefined) {
        return send(res, { ok: false, error: `未知引擎：${body.engine}（可选 ${Object.keys(ENGINES).join(' / ')}）` }, 400)
      }
      const runningTasks = [...tasks.values()].filter((t) => t && typeof t === 'object' && t.status === 'running' && typeof t.id === 'string')
      const engineNow = activeEngineId()
      if (runningTasks.length && body.engine !== engineNow && body.force !== true) {
        return send(res, {
          ok: false,
          error: `有 ${runningTasks.length} 个工单正在跑（${runningTasks.map((t) => t.id).join(', ')}），切换后面板会按新引擎展示而工单仍在旧引擎执行；确认切换请带 force:true`,
          runningTasks: runningTasks.map((t) => ({ id: t.id, engine: t.engine || '' })),
          activeEngine: engineNow,
        }, 409)
      }
    }
    const doc = loadKeyring()
    if (rounds !== null) doc.reviewRounds = rounds
    if (wallMs !== null) doc.reviewWallMs = wallMs
    if (tokenLimit !== null) doc.reviewTokenLimit = tokenLimit
    if (rounds !== null || wallMs !== null || tokenLimit !== null) saveKeyring(doc)
    // 协作两位落盘（整文件一次原子写）→ 位 1 档位可能变了，立即对账 AGENTS.md。
    // ensure 幂等：位 2-only 写入也无害，顺手自愈段状态。
    // agentsWritten = 写完后 AGENTS.md 里是否真有 VOICE 段（voice=on 时 true 才算写成功；
    // voice=off 时 false 是预期态，不是失败）。
    let agentsWritten = null
    if (collabBits !== null) {
      writeCollab(collabBits)
      ensureVoiceProtocol()
      try { agentsWritten = readFileSync(join(CODEX_DIR, 'AGENTS.md'), 'utf8').includes(VOICE_MARK) } catch { agentsWritten = false }
    }
    // P4.3：切换当前引擎（写 ~/.dsh/second-engine-engine.txt，一行 id）
    // 校验（未知引擎 / 运行中工单 409）已在前置阶段完成，这里只落盘。
    if (hasEngine) engineSwitched = setActiveEngineId(body.engine)
    send(res, {
      ok: true,
      reviewRounds: doc.reviewRounds,
      reviewWallMs: doc.reviewWallMs,
      reviewTokenLimit: doc.reviewTokenLimit,
      collab: collabStatus(),
      engine: await engineView(),
      ...(agentsWritten !== null ? { agentsWritten } : {}),
      ...(engineSwitched !== null ? { engineSwitched } : {}),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}



// ── /consult、/consults：Codex 卡点求助信道 ──
// 供第二引擎（Codex）在卡住时把上下文交给主 AI；内存队列，不落盘。
async function handleConsultCreate(req, res) {
  try {
    const body = await readBody(req)
    const from = typeof body.from === 'string' && body.from.trim() !== '' ? body.from.trim() : 'codex'
    const task = typeof body.task === 'string' ? body.task.trim() : ''
    const stuckContext = typeof body.stuckContext === 'string' ? body.stuckContext.trim() : ''
    // A（2026-10-25）：可选 taskId —— 工单 prompt 里带上任务 id 时 Codex 原样回传，
    // consultsForTask 按它精确归属到对应工单；空/缺省走旧时间窗兜底。
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (task === '') return send(res, { ok: false, error: 'task 不能为空' }, 400)
    if (stuckContext === '') return send(res, { ok: false, error: 'stuckContext 不能为空' }, 400)

    const entry = {
      id: newId(),
      from,
      task,
      stuckContext,
      taskId,
      at: Date.now(),
    }
    consults.push(entry)
    // 上限 20：超了从最旧一条开始丢（求助是短时效信号，留新不留旧）。
    while (consults.length > CONSULT_KEEP_LIMIT) consults.shift()

    // 通知按现有 NOTIFY_URL 方式发：text 用 task 摘要，正文走 /consults 取。
    notify(clipText(task.replace(/\s+/g, ' '), 120), 'Codex 求助')
    send(res, { ok: true, id: entry.id, at: entry.at, count: consults.length })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}





// ── Pi 引擎下的 MCP 兼容层（P4.22）──
// 前端 WebSearchMcpCard 一行不改：把 ~/.pi/agent/mcp.json 的 mcpServers
// 映射成 Codex 的 [{ name, url, enabled }] 形状。
// Pi 的 mcp.json 格式见 docs/mcp.md:47 —— url 型是 { url }，stdio 型是 { command, args }，
// 禁用是条目里 { enabled: false }（与 Codex 的 enabled 语义一致，无需额外映射）。
const PI_MCP_PATH = join(homedir(), '.pi', 'agent', 'mcp.json')

export function readPiMcp() {
  if (!existsSync(PI_MCP_PATH)) return { mcpServers: {} }
  try {
    const doc = JSON.parse(readFileSync(PI_MCP_PATH, 'utf8'))
    if (doc === null || typeof doc !== 'object') return { mcpServers: {} }
    if (doc.mcpServers === null || typeof doc.mcpServers !== 'object') doc.mcpServers = {}
    return doc
  } catch { return { mcpServers: {} } }
}

// D2（2026-10-29）：本函数原先自己写一份「备份 + tmp + rename」，三个 MCP 写入口
// （handlePiMcpAdd / Delete / Toggle）全在它外面各自 readPiMcp → 改 → 写，既无互斥，
// tmp 名又只带 pid（同进程两个入口并发时名字必撞），.bak 只带 Date.now()（同毫秒互相覆盖）。
// 现在统一走 piWriteJson：与 settings.json / models.json 同一把锁队列、同一套严格读与
// 随机后缀 tmp/备份；mcp.json 坏 JSON 同样中止而不是拿 { mcpServers: {} } 当基线覆盖掉用户的 MCP 配置。
// 读侧 readPiMcp 保留原样：它是**展示用**的宽松读（坏文件要让面板照常渲染并提示），
// 写基线一律用锁内的严格读，两者语义不同、不再共用。
export async function writePiMcp(mutate) {
  const out = await piWriteJson(PI_MCP_PATH, (doc) => {
    if (doc.mcpServers === null || typeof doc.mcpServers !== 'object') doc.mcpServers = Object.create(null)
    return mutate(doc)
  })
  prunePiBackups(PI_MCP_PATH)
  return out
}






// ── /mcp：MCP 服务器增删查（config.toml 的 [mcp_servers.*] 段）──
// 注册为 prefix 路由（'prefix' 同时命中 /mcp 与 /mcp/<name>），按方法+子路径分发。
export const MCP_ROUTE_PREFIX = '/second-engine/api/mcp'






// ── /version：版本检查 ──
// 本机 `codex --version` 与 GitHub 最新 release 对比。远端结果做模块级缓存 60 分钟：
// 设置页会反复刷新，匿名调用 api.github.com 的配额经不起每次请求都打一次。
const CODEX_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest'
// P4.28（2026-10-29）：Pi 的版本源是 npm registry（capabilities.versionCheck === 'npm'）。
// 与 GitHub release 同语义：本机 pi 版本 vs 最新发布版，有新版就在面板与浮球亮徽标。
const PI_NPM_LATEST_URL = 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest'
const PI_NPM_PAGE_URL = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent'
let latestPiVersionCache = { at: 0, version: '' }
const VERSION_FETCH_TIMEOUT_MS = 15000
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000
let latestVersionCache = { at: 0, version: '' }

// 取首个 x.y.z：'codex-cli 0.155.1'、'OpenAI Codex v0.155.1'、'v0.156.0' 都能吃。

// 三段数字比较：a>b → 1，a<b → -1，相等或任一侧不可解析 → 0。
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return 0
  const [ax, ay, az] = left.split('.').map(Number)
  const [bx, by, bz] = right.split('.').map(Number)
  if (ax !== bx) return ax > bx ? 1 : -1
  if (ay !== by) return ay > by ? 1 : -1
  if (az !== bz) return az > bz ? 1 : -1
  return 0
}

// 本机版本：execFile 带 8s 超时；二进制缺失/超时/输出无版本号一律回落 null。
function localCodexVersion() {
  return new Promise((resolve) => {
    try {
      execFile(resolveCodexBinary(), ['--version'], { timeout: 8000 }, (_err, stdout, stderr) => {
        resolve(parseVersion(`${stdout}${stderr}`))
      })
    } catch { resolve(null) }
  })
}

// 远端最新 release（从 tag_name 里取 x.y.z）；成功才写缓存，失败不写，下次请求可立刻重试。
async function latestCodexVersion() {
  if (latestVersionCache.version !== '' && Date.now() - latestVersionCache.at < VERSION_CACHE_TTL_MS) {
    return latestVersionCache.version
  }
  const resp = await fetch(CODEX_RELEASES_URL, {
    headers: { 'User-Agent': 'dsh-second-engine', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`GitHub releases 返回 ${resp.status}`)
  const json = await resp.json()
  const version = parseVersion(json?.tag_name)
  if (version === null) throw new Error('release 里没有 x.y.z 版本号')
  latestVersionCache = { at: Date.now(), version }
  return version
}

async function latestPiVersion() {
  if (latestPiVersionCache.version !== '' && Date.now() - latestPiVersionCache.at < VERSION_CACHE_TTL_MS) {
    return latestPiVersionCache.version
  }
  const resp = await fetch(PI_NPM_LATEST_URL, {
    headers: { 'User-Agent': 'dsh-second-engine', Accept: 'application/json' },
    signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`npm registry 返回 ${resp.status}`)
  const json = await resp.json()
  const version = parseVersion(json?.version)
  if (version === null) throw new Error('npm 包没有 x.y.z 版本号')
  latestPiVersionCache = { at: Date.now(), version }
  return version
}

// GET /version：{ current, latest, updateAvailable }。
// GitHub 不可达（离线/限流）不算失败：本机版本照回，原因放 error。
async function handleVersion(_req, res) {
  try {
    // P4.28：按引擎分流 —— Codex 查 GitHub release，Pi 查 npm registry；
    // 返回同形状 {engine,current,latest,updateAvailable,htmlUrl}，前端只按引擎换标签与链接。
    if (activeEngineId() === 'pi') {
      const probe = await piProbe().catch(() => null)
      const current = probe && typeof probe.version === 'string' ? probe.version : ''
      let latest = ''
      let error = ''
      try { latest = await latestPiVersion() } catch (e) { error = errMsg(e) }
      const payload = {
        ok: true,
        engine: 'pi',
        current,
        latest,
        updateAvailable: compareVersions(latest, current) > 0,
        htmlUrl: PI_NPM_PAGE_URL,
        checkedAt: latestPiVersionCache.at,
      }
      if (error !== '') payload.error = error
      return send(res, payload)
    }
    const current = await localCodexVersion()
    let latest = ''
    let error = ''
    try { latest = await latestCodexVersion() } catch (e) { error = errMsg(e) }
    const payload = {
      ok: true,
      engine: 'codex',
      current: current === null ? '' : current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
      htmlUrl: 'https://github.com/openai/codex/releases/latest',
      checkedAt: latestVersionCache.at,
    }
    if (error !== '') payload.error = error
    send(res, payload)
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /plugin-version：插件自身（dsh-second-engine）的版本检查 ──
// 与 /version 的区别：那个查 Codex CLI；这个查本插件仓库。
// 契约：远端查不到不算错误（ok:true、latest:''、updateAvailable:false、无 error 字段），
// 界面端「没有更新就一个像素都不渲染」，所以失败必须静默。
const PLUGIN_RELEASES_URL = 'https://api.github.com/repos/fengyu-12/dsh-second-engine/releases/latest'
const PLUGIN_FAIL_CACHE_TTL_MS = 10 * 60 * 1000   // 失败也缓存，别让设置页反复打 GitHub
let pluginVersionCache = { at: 0, latest: '', htmlUrl: '' }
// 按 package.json 的 mtime 缓存：文件没变不重复解析，改了立即生效（不再需要重启才认新版本号）。
let ownVersionCache = { mtime: -1, version: '' }

// 插件自身版本：package.json 相对模块文件往上找（最多两级），并校验包名防止误吃别的 package.json。
// 不写死绝对路径——插件可能被装到任意目录。找不到回 ''（后续比较恒为 false，静默）。
export function ownPluginVersion() {
  try {
    const self = dirname(fileURLToPath(import.meta.url))
    for (const base of [self, join(self, '..')]) {
      const pkgPath = join(base, 'package.json')
      if (!existsSync(pkgPath)) continue
      const mt = statSync(pkgPath).mtimeMs
      if (mt === ownVersionCache.mtime) return ownVersionCache.version
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg && pkg.name === 'dsh-second-engine') {
        ownVersionCache = { mtime: mt, version: parseVersion(pkg.version) || '' }
        return ownVersionCache.version
      }
    }
  } catch { /* 解析失败按找不到处理 */ }
  ownVersionCache = { mtime: -1, version: '' }
  return ''
}

// 远端最新 release：成功缓存 1 小时（复用 VERSION_CACHE_TTL_MS），失败缓存 10 分钟。
export async function latestPluginVersion() {
  const now = Date.now()
  const ttl = pluginVersionCache.latest !== '' ? VERSION_CACHE_TTL_MS : PLUGIN_FAIL_CACHE_TTL_MS
  if (pluginVersionCache.at !== 0 && now - pluginVersionCache.at < ttl) return pluginVersionCache
  try {
    const resp = await fetch(PLUGIN_RELEASES_URL, {
      headers: { 'User-Agent': 'dsh-second-engine', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`GitHub releases 返回 ${resp.status}`)
    const json = await resp.json()
    const version = parseVersion(json?.tag_name)
    if (version === null) throw new Error('release 里没有 x.y.z 版本号')
    pluginVersionCache = { at: Date.now(), latest: version, htmlUrl: String(json?.html_url || '') }
    return pluginVersionCache
  } catch (e) {
    pluginVersionCache = { at: Date.now(), latest: '', htmlUrl: '' }   // 失败缓存，10 分钟内不再打
    throw e
  }
}


export function apply(ctx) {
  loadPolicyWatchState()
  ctx.on('session/event', async (session, event) => {
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    const hintToggles = readHintToggles()
    if (hintToggles.mechanical && typeof sessionId === 'string' && sessionId) startPolicyWatch(sessionId)
    // 用户打断的机械标记（2026-11-02 实测）：turn/end.reason = {kind:'aborted', reason:{kind:'user'}}。
    // 本会话 196 个 turn 里 15 次，比任何文本匹配可靠 —— 记下来供下一轮 mood-watch 用。
    try {
      const rs = event?.data?.reason
      // 必须同时校验内层：真实结构是 {kind:'aborted', reason:{kind:'user'}}。
      // 只查外层会把超时/插件取消/进程退出也当用户打断（Codex 评估 2026-11-02 指出）。
      const byUser = rs !== null && typeof rs === 'object' && rs.kind === 'aborted'
        && rs.reason !== null && typeof rs.reason === 'object' && rs.reason.kind === 'user'
      if (hintToggles.interruption && byUser && typeof sessionId === 'string' && sessionId) {
        // 只留窗口内的，避免数组无限增长；单次打断不提示，靠频次判断「方向是否持续偏」
        const nowAb = Date.now()
        const kept = (moodWatchAborts.get(sessionId) || []).filter((t) => nowAb - t < MOOD_ABORT_WINDOW_MS)
        kept.push(nowAb)
        moodWatchAborts.set(sessionId, kept)
        // 淘汰最早的 key（Map 迭代顺序 = 插入顺序），与 policy-watch.trimPolicyWatchMaps 同款
        while (moodWatchAborts.size > MOOD_KEEP_LIMIT) moodWatchAborts.delete(moodWatchAborts.keys().next().value)
        while (moodWatchLastAt.size > MOOD_KEEP_LIMIT) moodWatchLastAt.delete(moodWatchLastAt.keys().next().value)
      }
    } catch (e) { noteErr('mood-watch-abort', e) }
  }, { global: true })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // 检测挂这里而不是 session/event：后者在 dsh-session/lib/index.js:1585 有
    // `callbacks !== void 0 && entry !== void 0` 的派发前置条件，插件拿不到 entry
    // 就永远收不到。agent/pre-step 是每次请求必经，且广播到**所有会话**（2026-10-31
    // 实测 2 个会话均触发）。agent.id 就是 session id（同次探针实测，两者同值）。
    const sessionId = agent?.id
    const hintToggles = readHintToggles()
    const pending = hintToggles.mechanical && typeof sessionId === 'string' ? policyWatchPending.get(sessionId) : null
    if (!hintToggles.mechanical && typeof sessionId === 'string') policyWatchPending.delete(sessionId)
    if (hintToggles.mechanical && typeof sessionId === 'string' && sessionId) startPolicyWatch(sessionId)
    let decision = await next()
    if (decision.kind === 'reject') return decision
    // mood-watch（2026-11-02）：用户纠错/打断的机械信号 → 注入一条模拟用户消息。
    // 与 policy-watch 并列、独立触发；不改变判定，只让「可能在纠正」每轮可见一次。
    if ((hintToggles.vocabulary || hintToggles.interruption) && typeof sessionId === 'string' && sessionId) {
      try {
        const nowAb2 = Date.now()
        const recentAborts = (moodWatchAborts.get(sessionId) || []).filter((t) => nowAb2 - t < MOOD_ABORT_WINDOW_MS)
        // 顺序：词表命中优先（更具体），abort 频次只在词表无命中时兜底。
        // 否则「停一下」会被 abort 分支吃掉，换成"连续被打断"的文案（Codex 评估指出）。
        const textHit = hintToggles.vocabulary ? diagnoseMood(lastUserText(decision.messages)) : null
        const abortHit = hintToggles.interruption && recentAborts.length >= MOOD_ABORT_TRIGGER
          ? { kind: 'interrupt', reason: `最近 ${Math.round(MOOD_ABORT_WINDOW_MS / 60000)} 分钟内被你打断 ${recentAborts.length} 次（单次不算，连续才算方向偏）` }
          : null
        const hit = textHit !== null ? textHit : abortHit
        const nowMs = Date.now()
        // stop 是明确叫停，必须立刻生效，不受冷却压制（Codex 评估指出）。
        if (hit !== null && (hit.kind === 'stop' || nowMs - (moodWatchLastAt.get(sessionId) || 0) >= MOOD_COOLDOWN_MS)) {
          moodWatchLastAt.set(sessionId, nowMs)
          decision = { ...decision, messages: [...decision.messages, buildMoodMessage(hit, `mood-watch-${sessionId}`)] }
        }
      } catch (e) { noteErr('mood-watch', e) }
    }
    if (!pending) return decision
    const now = Date.now()
    // 2026-11-03：pending 已不再因文件变化被删，所以这里必须自己判时效——
    // 算出太久（超过 POLICY_WATCH_FRESH_MS）就作废，避免把「五分钟前你在重复」当现状送达。
    if (pending.at && now - pending.at > POLICY_WATCH_FRESH_MS) {
      policyWatchPending.delete(sessionId)
      persistPolicyWatchState()
      return decision
    }
    const lastDelivered = policyWatchDelivered.get(sessionId) || 0
    policyWatchPending.delete(sessionId)
    if (now - lastDelivered < POLICY_WATCH_DELIVERY_COOLDOWN_MS) {
      persistPolicyWatchState()
      return decision
    }
    policyWatchDelivered.delete(sessionId)
    policyWatchDelivered.set(sessionId, now)
    persistPolicyWatchState()
    const message = {
      id: `policy-watch-${randomBytes(8).toString('hex')}`,
      role: 'user',
      source: { kind: 'policy-watch' },
      // 2026-11-03 改版：转写成「汇报上轮发生了什么 + 明确规则 + 指出第二引擎可用」。
      // 🔴 安全红线：summary 只来自 policy-watch.py 的机械量摘要（计数/位置），禁止回填用户原话或外部内容。
      content: [{ type: 'text', text:
        '[SECOND_ENGINE:POLICY_WATCH] 本条由 second-engine 插件生成，不是用户发言。\n'
        + `检测器在你上一轮的动作里判据命中：${pending.summary}。\n`
        + '先自己判断这是哪一种：① 你在验证同一个东西（重复是有意的，合理）；② 你在原地打转（同一命令反复跑、同一处反复改、连续多步没有实质推进）。\n'
        + '若判断为②：不要再重复同一条命令或同一处修改。换一个量、换一条路径，或把这步交给第二引擎做独立判断——派单执行或复核你最近的动作都行。\n'
        + '第二引擎只承担「独立判断或执行」这部分，派不派、派什么仍由你决定；它看不到当前会话，交代过去的活必须自包含。\n'
        + '不要在本轮回复中提及这条提醒，只处理判断后该做的事。' }],
    }
    return { ...decision, messages: [...decision.messages, message] }
  })
  // 桥清理：插件卸载/热重载时关掉本地桥，避免 server 句柄与端口残留。
  // 宿主用 cordis fiber：ctx.effect 回调返回的函数即卸载时的 disposer（同 guard 写法）；
  // 宿主若没有 effect（老版本），退回 process.on('exit')。
  try {
    ctx.effect(() => closeBridge, 'second-engine: bridge teardown')
  } catch {
    try { process.on('exit', closeBridge) } catch { /* best effort */ }
  }

  // Codex 协作协议：确保 ~/.codex/AGENTS.md 带有卡点求助段（幂等）。
  ensureAgentsProtocol()
  // 长任务协作看板（dual-board）用法段：同样写进全局 AGENTS.md（独立幂等）。
  ensureBoardProtocol()
  // 主动开口与整体评估段（2026-10-25）：三档开关 SECOND_ENGINE_VOICE=ask|voice|off，
  // 成对标记支持切档删除；缺省 ask 不写段。
  ensureVoiceProtocol()

  // 自动清理兜底（见 AUTO_CLEANUP_*）：每 6 小时检查一次，超阈值才按 KEEP_DAYS 天前清。
  // 先停旧的再装新的，重复 apply（热重载）不会叠加定时器。
  stopAutoCleanup()
  const autoCleanup = setInterval(runAutoCleanup, AUTO_CLEANUP_INTERVAL_MS)
  autoCleanupTimer = autoCleanup
  // 不因定时器把宿主进程吊住（宿主 server 在跑，定时器照常触发）。
  if (typeof autoCleanup.unref === 'function') autoCleanup.unref()
  try {
    ctx.effect(() => stopAutoCleanup, 'second-engine: auto cleanup teardown')
  } catch {
    try { process.on('exit', stopAutoCleanup) } catch { /* best effort */ }
  }

  // 期望态对账 tick（见 startReconcileTick 注释）：治「Web 重启后桥消失、config 仍指旧端口」。
  // 启动即跑一轮，之后每 7s 一次；只对差异动手，幂等。
  startReconcileTick()
  startBoardSweep()
  try { ctx.effect(() => stopBoardSweep, 'second-engine: board sweep teardown') }
  catch { process.on('exit', stopBoardSweep) }
  try {
    ctx.effect(() => stopReconcileTick, 'second-engine: reconcile tick teardown')
  } catch {
    try { process.on('exit', stopReconcileTick) } catch { /* best effort */ }
  }

  // 设置页 API：webServer 后挂载时也能注册；无 webServer 的 profile 自然不注册。
  ctx.inject(['webServer'], (wctx) => {
    // method/desc 内联进注册条目：GET /_meta 遍历本数组自动生成路由清单，别另手抄第二份。
    const routes = [
      { kind: 'exact', method: 'GET', path: '/second-engine/api/pi-panel', desc: 'Pi 引擎面板数据（提供方/MCP/聊天桥/会话/模型渠道）', handler: handlePiPanel },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/pi-channel', desc: 'Pi 自定义模型渠道 { id, baseUrl, api?, models[], name?, apiKey? }：写入 ~/.pi/agent/models.json 的 providers.<id>（写前 .bak、0600）', handler: handlePiChannelCreate },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/pi-model', desc: 'Pi 默认模型切换 { provider, model }：写 ~/.pi/agent/settings.json 的 defaultProvider/defaultModel（新建会话生效）', handler: handlePiModelSet },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/pi-bridge', desc: 'Pi 聊天桥启停 { action: start|stop }（起后真探活 8788 再回报）', handler: handlePiBridge },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/pi-cleanup', desc: 'Pi 会话清理 { confirm: true }：删 ~/.pi/agent/sessions 下 *.jsonl', handler: handlePiCleanup },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/pi-channel-delete', desc: 'Pi 删除自定义渠道 { id }（写前 .bak、0600）', handler: handlePiChannelDelete },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/status', desc: '引擎/密钥/会话占用概览', handler: handleStatus },
      { kind: 'exact', method: 'GET|POST', path: '/second-engine/api/providers', desc: 'GET 提供方列表（apiKey 脱敏）+ active；POST 新增自定义提供方 { id, baseUrl, api, apiKey, name? }', handler: handleProvidersRoot },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/providers/key', desc: '设置指定提供方 apiKey（keyring 0600）', handler: handleProviderKey },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/providers/active', desc: '切换激活并生成 config.toml（先备份）', handler: handleProviderActive },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/providers/delete', desc: '删除自定义提供方（预设不可删）', handler: handleProviderDelete },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/providers/update', desc: '编辑提供方（apiKey 省略=不改；active 改地址/模型时重写 config.toml）', handler: handleProviderUpdate },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/models', desc: '拉取该提供方 /models 模型清单（缺省 active）', handler: handleModels },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/model', desc: '更新该提供方 model（active 时重写 config.toml）', handler: handleProviderModel },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/key', desc: '兼容旧面板：给预设提供方写 key', handler: handleKey },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/cleanup', desc: '按 mtime 清理旧会话 *.jsonl（body 带 codexLogs:true 时顺带清 Codex logs_2.sqlite：删超期行 + 碎片超 30% 且安全闸全过才 VACUUM）', handler: handleCleanup },
      { kind: 'exact', method: 'POST|GET', path: '/second-engine/api/task', desc: 'POST 下发异步工单 { prompt, workdir?, ephemeral?, engine?, provider? }（后台跑，完成弹通知；GET ?id= 单条全量）', handler: handleTaskRoot },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/tasks', desc: '最近 10 条工单摘要（不含 output）', handler: handleTaskList },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/task/cancel', desc: '取消运行中的工单（SIGTERM）', handler: handleTaskCancel },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/review', desc: '双向互审 { content, workdir?, rounds? }：多轮批判复核；可带 prev=<上一轮复核id> 接力、reply=[{issueId,decision,reason}] 按账本序号 i<N> 逐条回辩（兼容 v1 哈希 id 与旧 issueIndex）', handler: handleReviewCreate },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/review/cancel', desc: '熔断取消复核任务（SIGTERM）', handler: handleReviewCancel },
      // #8-10：复核历史（落盘记录倒序；内存 tasks Map 重启即失，这里是持久真值）。
      { kind: 'exact', method: 'GET', path: '/second-engine/api/reviews', desc: '复核历史（~/.codex/reviews 持久化记录，倒序；?limit=）', handler: handleReviewsList },
      { kind: 'exact', method: 'GET|POST', path: '/second-engine/api/config', desc: '读/写插件配置 { reviewRounds: 1|3|5 }', handler: handleConfigRoot },
      { kind: 'exact', method: 'GET|POST', path: '/second-engine/api/hint-toggles', desc: '读/写提示开关 { vocabulary, interruption, mechanical }', handler: handleHintToggles },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/consult', desc: 'Codex 卡点求助入队（内存 20 条 + 弹 App 通知）', handler: handleConsultCreate },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/consults', desc: '求助列表（不脱敏，给主 AI 收卷）', handler: handleConsultsList },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/version', desc: '本机 codex 版本 vs GitHub 最新 release（updateAvailable）', handler: handleVersion },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/plugin-version', desc: '插件自身版本 vs GitHub 最新 release（失败静默，无更新不提示）', handler: handlePluginVersion },
      { kind: 'exact', method: 'POST', path: '/second-engine/api/_exp/wake', desc: '实验：唤醒休眠 DSH 会话并投递用户消息 { sessionId, text }（暂不传 setup）', handler: (req, res) => handleExperimentalWake(wctx, req, res) },
      { kind: 'exact', method: 'GET|POST', path: '/second-engine/api/websearch', desc: '读/写 config.toml 顶层 web_search { value: disabled|cached|indexed|live }', handler: handleWebSearchRoot },
      // prefix：'prefix' 同时命中 /mcp 与 /mcp/<name>，DELETE 的名字从 URL 尾巴取。
      { kind: 'prefix', method: 'GET|POST|DELETE', path: '/second-engine/api/mcp', desc: 'GET 全部 [mcp_servers.*] 段；POST 新增 { name, url }（重名 409）或 /<name> 启用禁用 { enabled }；DELETE /<name> 删段（404）', handler: handleMcpRoot },
      { kind: 'exact', method: 'GET', path: '/second-engine/api/_meta', desc: '路由自描述：遍历本注册表生成 {method,path,desc} 清单', handler: handleApiMeta },
    ]
    // GET /_meta（2026-10-26）：SKILL.md 不再手抄路由表，调用方以此端点自取；与其它 /api/* 同暴露面。
    function handleApiMeta(req, res) {
      try {
        if (req.method !== 'GET') { send(res, { ok: false, error: 'method not allowed, use GET' }); return }
        send(res, { ok: true, routes: routes.map((r) => ({ method: r.method, path: r.path, desc: r.desc })) })
      } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
    }
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `second-engine: ${route.path} route`)
    }
    // 浏览器聊天桥（2026-09-29）：4 个透传路由（status/start/stop/url）由模块自行注册。
    // 模块内用 execFile + 固定子命令白名单，不做通用透传；桥目录可用 BRIDGE_DIR 覆盖。
    registerBridgeRoutes(wctx)
  })

  // 设置 > 插件 > 插件配置 的 namespace：宿主 settings 服务只派发「served 的
  // namespace」与「settings.plugin.item 里按 key 占位的卡」的交集，所以这里
  // 必须注册 'second-engine'，否则浏览器端不渲染本插件面板。
  // 全程 best-effort：settings/llm 不可用时插件照常只提供三条 HTTP API。
  ctx.inject(['settings'], (sctx) => {
    try {
      const cfg = readConfig()
      const scope = sctx.settings.register('second-engine', z.object({
        keepDays: z.number().min(MIN_KEEP_DAYS).max(MAX_KEEP_DAYS).default(cfg.keepDays),
      }), { base: { keepDays: cfg.keepDays } })
      secondEngineSettingsScope = scope
      // 用 base 播种一次，宿主文档与默认值对齐。
      void scope.update({ keepDays: cfg.keepDays }).catch(() => {})
      // 宿主文档才是持久真值：把当前值镜像进进程内默认值，供 cleanup 兜底。
      scope.watch(() => {
        try {
          const v = scope.get()
          if (v && Number.isFinite(v.keepDays)) keepDaysDefault = Math.floor(v.keepDays)
        } catch { /* best effort */ }
      })
      // 目录条目：设置页据此把本插件列进可配置 provider，缺它浏览器端不渲染。
      // 注意 settingsNs/settingsPath 是必填（只传 provider/displayName 会抛
      // TypeError 被 catch 吞掉，等于没注册），与 dsh-llm 的 LlmConfigurableProvider 对齐。
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        try {
          llm.registerConfigurableProviders([{
            provider: 'second-engine',
            displayName: '第二引擎（second-engine）',
            settingsNs: 'second-engine',
            settingsPath: [],
          }])
        } catch { /* best effort */ }
      }
    } catch {
      // settings 不可用：插件照常提供 HTTP API。
    }
    sctx.effect(() => () => { secondEngineSettingsScope = null }, 'second-engine: settings scope teardown')
  })
}

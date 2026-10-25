// dsh-second-engine —— DeepSeek Harness 的 Codex 二元引擎插件。
//
// 进程内提供：设置页所需的 HTTP API（经 webServer 注册为 exact 路由）
//   GET    /second-engine/api/status            引擎/密钥/会话占用概览
//   GET    /second-engine/api/providers         提供方列表（apiKey 脱敏）+ active
//   POST   /second-engine/api/providers         新增自定义提供方
//   POST   /second-engine/api/providers/key     设置指定提供方 apiKey（keyring 0600）
//   POST   /second-engine/api/providers/active  切换激活并生成 config.toml（先备份）
//   POST   /second-engine/api/providers/delete  删除自定义提供方（预设不可删）
//   POST   /second-engine/api/providers/update  编辑提供方（apiKey 省略=不改；active 改地址/模型时重写 config.toml）
//   POST   /second-engine/api/models            拉取该提供方 /models 模型清单（缺省 active）
//   POST   /second-engine/api/model             更新该提供方 model（active 时重写 config.toml）
//   POST   /second-engine/api/key               兼容旧面板：给预设提供方写 key
//   POST   /second-engine/api/cleanup           按 mtime 清理旧会话 *.jsonl
//   POST   /second-engine/api/task              下发异步工单（后台 codex exec，完成弹 App 通知；ephemeral 缺省 true）
//   GET    /second-engine/api/task?id=          单条工单全量（含 output）
//   GET    /second-engine/api/tasks             最近 10 条工单摘要（不含 output）
//   POST   /second-engine/api/task/cancel       取消运行中的工单（SIGTERM）
//   POST   /second-engine/api/review            双向互审：对产出做多轮批判性复核（kind:'review'）
//   POST   /second-engine/api/review/cancel     熔断取消复核任务（SIGTERM）
//   GET    /second-engine/api/config            读插件配置（复核轮数 reviewRounds）
//   POST   /second-engine/api/config            写插件配置 { reviewRounds: 1|3|5 }
//   POST   /second-engine/api/consult           Codex 卡点求助入队（内存 20 条 + 弹 App 通知）
//   GET    /second-engine/api/consults          求助列表（不脱敏，给主 AI 收卷）
//   GET    /second-engine/api/version           本机 codex 版本 vs GitHub 最新 release（updateAvailable）
//   GET    /second-engine/api/plugin-version    插件自身版本 vs GitHub 最新 release（失败静默，无更新不提示）
//   GET    /second-engine/api/websearch         读 config.toml 顶层 web_search（无则 disabled）
//   POST   /second-engine/api/websearch         写 web_search { value: disabled|cached|indexed|live }
//   GET    /second-engine/api/mcp               config.toml 全部 [mcp_servers.*] 段
//   POST   /second-engine/api/mcp               新增 [mcp_servers.<name>] { name, url }（重名 409）
//   POST   /second-engine/api/mcp/<name>         启用/禁用该 MCP { enabled: bool }（保留配置段；Codex 官方 enabled 字段）
//   DELETE /second-engine/api/mcp/<name>        删除该段（不存在 404）
// 以及 rc.7 插件自有设置表面：settings 命名空间 'second-engine'（keepDays）与
// llm 的可配置 provider 目录条目，二者缺一浏览器端设置页都不渲染本插件面板。
// 请求体与响应均为 JSON，handler 用原生 node:req/res 风格。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync, readFileSync, copyFileSync, utimesSync, renameSync, openSync, fstatSync, readSync, closeSync, createWriteStream } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { registerBridgeRoutes } from './bridge-routes.js'
import http from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createBridgeServer } from './bridge.js'
import { startAppServerTurn } from './app-server-client.js'
import { resolveCollab, collabPreset, writeCollab } from './collab.js'
import { createHash, randomBytes } from 'node:crypto'

export const name = 'second-engine'

const CODEX_DIR = join(homedir(), '.codex')
const CODEX_BINARY = '/usr/local/bin/codex'
// T5：工单/复核执行模式。exec = 旧的一次性 `codex exec`（默认，零风险）；
// appserver = JSON-RPC 长连接，能看到流式进度、能真打断。验收通过后再把默认改为 appserver。
// 模式判定（运行时读取，改文件即切换，无需重启）：
//   1) env SECOND_ENGINE_EXEC_MODE 优先（exec|appserver）
//   2) 否则读 ~/.dsh/second-engine-mode.txt（内容 exec|appserver）
//   3) 都没有 → exec（零风险默认）
function execMode() {
  const fromEnv = process.env.SECOND_ENGINE_EXEC_MODE
  if (fromEnv === 'appserver' || fromEnv === 'exec') return fromEnv
  try {
    const fromFile = readFileSync(join(homedir(), '.dsh', 'second-engine-mode.txt'), 'utf8').trim()
    if (fromFile === 'appserver' || fromFile === 'exec') return fromFile
  } catch { /* 文件不存在 → 默认 */ }
  return 'exec'
}
const CONFIG_PATH = join(CODEX_DIR, 'config.toml')
const KEYRING_PATH = join(CODEX_DIR, 'keyring.json')
const SESSIONS_DIR = join(CODEX_DIR, 'sessions')

const CONFIG_BACKUP_PATH = join(CODEX_DIR, 'config.toml.bak-se')

// 首次初始化写入的三家预设（apiKey 空，待设置页填写）。
const PRESET_PROVIDERS = [
  // DeepSeek 官方文档实证的上下文/输出上限，写 config.toml 顶层（见 writeCodexConfig）。
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', model: 'deepseek-flash', contextWindow: 1048576, maxOutput: 393216 },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/v1', wireApi: 'responses', model: 'glm-4.6' },
]
const PRESET_IDS = new Set(PRESET_PROVIDERS.map((p) => p.id))
const DEFAULT_ACTIVE = PRESET_PROVIDERS[0].id
// Codex 侧永远讲 Responses（config.toml 的 wire_api 恒为它），
// 'completions' 提供方由本地翻译桥转接（见 ensureBridge）。
const WIRE_API = 'responses'
const SUPPORTED_WIRE_APIS = new Set(['responses', 'completions'])
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/
// config.toml 顶层 web_search：Codex 原生联网搜索档位（二进制 WebSearchMode 枚举实证）。
// disabled=关闭，live=开启；cached/indexed 是中间档，面板只暴露 disabled/live 两档。
const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live']
const DEFAULT_WEB_SEARCH = 'disabled'
// MCP 段名：限定字符集堵住段头注入（换行/']'/引号都进不来）。
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

// ── 异步工单 ──
// 进程内任务表：{ id, status:'running'|'done'|'error', exitCode, output, startedAt, endedAt, workdir }。
// 另外挂 child（进程句柄，取消用）与 outPath（-o 落点，读完输出后删除）；这两项不外发。
const tasks = new Map()
const DEFAULT_TASK_WORKDIR = process.env.SECOND_ENGINE_WORKDIR || '/root/proj'
const TASK_LIST_LIMIT = 10
const TASK_KEEP_LIMIT = 50
// 过程流轮转阈值：live 文件超限即重开（从头写），长任务不把诊断流膨胀到 GB 级。
const LIVE_ROTATE_BYTES = 10 * 1024 * 1024

// 任务/复核/求助 ID：时间前缀可读可排序 + 8 字节强随机。
// （旧式 4 字符随机段在并发提交时会碰撞，tasks.set 直接覆盖既有条目。）
function newId() {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
}

// ── Codex 卡点求助（consult）──
// 进程内队列：{ id, from, task, stuckContext, at }。只留最近 20 条，主 AI 定期收卷。
// 不落盘、不脱敏：这里是两个引擎之间的内部信道，不是给用户的展示面。
const consults = []
const CONSULT_KEEP_LIMIT = 20

// ── 吞错留痕（D，2026-10-25）──
// 原先大量 best-effort 分支裸 catch 静默吞错（「配置没写进去」无从排查）。统一去处：
// 环形缓冲最近 50 条 { t, tag, msg }，/api/status 暴露最近 10 条。
// 只存 tag 与脱敏后的短消息 —— 挂进来的调用点不碰密钥，keyring 内容不进缓冲；
// 脱敏正则兜第二层：sk- 令牌 / Bearer 凭证 / key|token|password|secret 赋值形态 → [redacted]。
const ERR_LOG = []
const ERR_LOG_LIMIT = 50
const ERR_REDACT_RE = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._~+\/=-]{6,}|(?:(?:api[_-]?key|key|token|password|secret)["']?\s*[:=]\s*)["']?[A-Za-z0-9._~+\/=-]{6,})/gi
function noteErr(tag, err) {
  let msg = err instanceof Error ? String(err.message ?? err) : String(err ?? '')
  msg = String(msg).replace(ERR_REDACT_RE, '[redacted]').slice(0, 300)
  ERR_LOG.push({ t: Date.now(), tag: String(tag), msg })
  while (ERR_LOG.length > ERR_LOG_LIMIT) ERR_LOG.shift()
}

const NOTIFY_URL = 'http://127.0.0.1:3090/app/notify'
const NOTIFY_TOKEN_PATH = process.env.DSH_BRIDGE_TOKEN_PATH || join(process.env.DSH_HOME || '/root/.dsh', '.bridge_token')
const NOTIFY_TIMEOUT_MS = 3000

// ── 双向互审（review）──
// 每轮以固定模板要求独立复核引擎输出 JSON；轮数默认 3、上限 5。
const REVIEW_DEFAULT_ROUNDS = 3
const REVIEW_MIN_ROUNDS = 1
const REVIEW_MAX_ROUNDS = 5
// 设置页可选轮数（GET/POST /api/config 的白名单，仅这三档）。
const REVIEW_ROUNDS_CHOICES = [1, 3, 5]
const REVIEW_TEMPLATE = '你是独立复核引擎。批判性审查以下产出：找自洽却错误的推理、漏掉的边界条件、更优备选。输出 JSON: {issues:[{severity,point,suggestion}], verdict}'
// 看门狗：每 30s 探一次 -o 输出文件 mtime，超 300s 无变化即标疑似停滞并通知。
const WATCHDOG_INTERVAL_MS = 30000
const WATCHDOG_STALL_MS = 300000
// 解析失败时回显的原始输出上限，避免把超长文本灌进任务表。
const REVIEW_RAW_CLIP = 2000
// 互审的硬预算缺省值（2026-10-03 补：此前只有轮数上限，"无新增即收敛"是**语义**条件，
// 两个 AI 在「主张 X / 反对 X」之间振荡时没有任何刹车，会一路烧到额度见底）。
// 两者都可在配置里覆盖（keyring 顶层 reviewWallMs / reviewTokenLimit）。
const REVIEW_DEFAULT_WALL_MS = 30 * 60 * 1000   // 墙钟 30 分钟
const REVIEW_DEFAULT_TOKEN_LIMIT = 400000       // 累计 40 万 token（按 codex 自报的 tokens used 累加）
const REVIEW_MIN_WALL_MS = 60 * 1000
const REVIEW_MIN_TOKEN_LIMIT = 1000

// 保留天数（设置页 keepDays）：宿主 settings 文档是持久真值，这里只放默认值。
const DEFAULT_KEEP_DAYS = 7
const MIN_KEEP_DAYS = 1
const MAX_KEEP_DAYS = 365

// 自动清理兜底：ephemeral 只是「缺省不落盘」，长线程/显式 false 的工单仍会写 sessions。
// 每 6 小时看一次，只有目录总量超 MAX_BYTES 才动手，按 KEEP_DAYS 天前清（阈值内不扫不删，
// 避免把手上正在跑的会话清掉）。
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
const errMsg = (e) => (e && e.message) ? e.message : String(e)

function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

// 请求体上限：设置页 API 的 payload 都很小，但 /api/review 的 content 可能承载
// 整份交付文档，取 4MB 兼顾两者；超限直接断开按空体处理，防超大包全量缓冲进内存。
const MAX_BODY_BYTES = 4 * 1024 * 1024
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let received = 0
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    req.on('data', (c) => {
      received += c.length
      if (received > MAX_BODY_BYTES) {
        try { req.destroy() } catch { /* best effort */ }
        finish({})
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
    // 客户端半途中断且只触发 close（无 error/end）时兜底，handler 不至于永久挂起。
    req.on('close', () => finish({}))
  })
}

// ── 本地状态探测 ──
// 当前 active 提供方的 apiKey 是否已配置。
function keyConfigured() {
  try {
    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    return active !== undefined && active.apiKey.trim() !== ''
  } catch {
    return false
  }
}

// sessions 目录总字节（递归；读不到的条目按 0 计，绝不抛错）
function sessionsBytes(dir = SESSIONS_DIR) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += sessionsBytes(full)
      else if (entry.isFile()) total += statSync(full).size
      else if (entry.isSymbolicLink()) total += statSync(full).size
    } catch { /* 忽略瞬时错误 */ }
  }
  return total
}

// status 轮询缓存：递归 stat 整棵 sessions 树不便宜（设置页/浮球会反复刷），
// TTL 内复用上次结果；runAutoCleanup 仍用新鲜的 sessionsBytes()。
const SESSIONS_BYTES_TTL_MS = 10000
let sessionsBytesCache = { at: 0, value: 0 }
function sessionsBytesCached() {
  if (Date.now() - sessionsBytesCache.at < SESSIONS_BYTES_TTL_MS) return sessionsBytesCache.value
  sessionsBytesCache = { at: Date.now(), value: sessionsBytes() }
  return sessionsBytesCache.value
}

// 脱敏预览：前 6 后 4；过短的 key 只留首尾各 2 位
function maskKey(key) {
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
function normalizeProvider(raw) {
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

// 原子落盘：同目录临时文件 + rename 顶替。直接 writeFileSync 目标路径，进程中途
// 崩溃/断电会留下半截文件（keyring.json / config.toml 随之解析失败）；mode 在创建
// 临时文件时即生效，0600 没有「先建后 chmod」的 world-readable 窗口。
function atomicWriteFileSync(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw e
  }
}

function saveKeyring(doc) {
  mkdirSync(CODEX_DIR, { recursive: true })
  atomicWriteFileSync(KEYRING_PATH, `${JSON.stringify(doc, null, 2)}\n`)
}

// 复核轮数：只认 1/3/5，其余（含缺失、非法、字符串数字以外的垃圾值）一律回落默认 3。
function normalizeReviewRounds(value) {
  const n = Number(value)
  return REVIEW_ROUNDS_CHOICES.includes(n) ? n : REVIEW_DEFAULT_ROUNDS
}

// 互审硬预算（2026-10-03）：非法/缺失/过小一律回落缺省值 ——
// 宁可给个保守值，也不要"0 预算"把互审一进去就停。
function normalizeReviewWallMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= REVIEW_MIN_WALL_MS ? Math.floor(n) : REVIEW_DEFAULT_WALL_MS
}

function normalizeReviewTokenLimit(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= REVIEW_MIN_TOKEN_LIMIT ? Math.floor(n) : REVIEW_DEFAULT_TOKEN_LIMIT
}

// ── Codex 协作协议（AGENTS.md 自动写入）──
// 让 Codex 拥有「卡点求助本能」：连续失败/绕圈时主动调 /api/consult。幂等：带标记则跳过。
const AGENTS_MARK = '<!-- dsh-second-engine:v2 -->'
const AGENTS_V1_MARK = '<!-- dsh-second-engine:v1 -->'
const AGENTS_SECTION = `${AGENTS_MARK}
# Codex 全局协作协议（by dsh-second-engine）

你是「第二引擎」，与主 AI（DSH）互为伙伴。卡点自救协议：
- 同一路径/命令连续失败 2 次、或在绕圈、或缺信息/权限无法自行获取时，必须主动求助而非硬试：
  curl -s -X POST http://127.0.0.1:3080/second-engine/api/consult -H 'Content-Type: application/json' \\
    -d '{"from":"codex","task":"<当前任务一句话>","stuckContext":"<试过什么、错在哪、需要什么>"}'
  提交后正常结束会话（输出已有成果），主 AI 会带建议回来。
- 若 HTTP 不通，在最终输出末尾追加一行：[CONSULT-NEEDED] <卡点描述>。
- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。
- **临时产物自清（2026-09-29 起，与主 AI 同规）**：排查/解包/实验过程中写进 \`/tmp\` 的文件与目录，任务收尾前必须自己删净（\`/tmp\` 不会自动清理）；只保留系统自带运行时项（\`dsh-*\`、\`tmux-*\`、\`node-compile-cache\`）。

## 联网搜索策略（三档降级制）

按顺序降级，不得跳级、不得把编造内容伪装成搜索结果：
1. 原生优先：优先尝试原生 web_search；
2. Exa 备胎：原生不可用（工具不存在）、被限流或返回失败时，用 MCP 工具 web_search_exa（搜索）/ web_fetch_exa（抓正文）。服务地址 https://mcp.exa.ai/mcp —— 匿名可免费用（有隐性限额，偶发 rate limit 重试即可）；若开始要求认证，到 Exa 官网 exa.ai 注册免费 key 再挂；
3. 全无则自己写：连 Exa 都没有（无 MCP/无网络）时，凭已有知识直接完成任务，明确标注"未经联网核实，时效性信息可能过时"，不得中断任务。
`
function ensureAgentsProtocol() {
  try {
    const path = join(CODEX_DIR, 'AGENTS.md')
    let existing = ''
    try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则新建 */ }
    if (existing.includes(AGENTS_MARK)) return
    if (existing.includes(AGENTS_V1_MARK)) {
      // v1 → v2 原位升级：v1 段以固定句收尾，切掉换新段
      const start = existing.indexOf(AGENTS_V1_MARK)
      const endMark = '- 只在指定工作副本内写文件；最终决策权在主 AI 与用户。'
      const end = existing.indexOf(endMark, start)
      const merged = end === -1
        ? existing.slice(0, start) + AGENTS_SECTION
        : existing.slice(0, start) + AGENTS_SECTION + existing.slice(end + endMark.length)
      writeFileSync(path, merged, 'utf8')
      chmodSync(path, 0o600)
      return
    }
    const merged = existing.endsWith('\n') || existing === '' ? existing + AGENTS_SECTION : existing + '\n\n' + AGENTS_SECTION
    writeFileSync(path, merged, 'utf8')
    chmodSync(path, 0o600)
  } catch (e) { noteErr('agents-protocol', e) /* best effort：写入失败不阻断插件启动 */ }
}

// ── 长任务协作看板（dual-board）用法段（2026-10-16 增）──
// 脚本与协议随本插件分发（tools/dual-board/），但"怎么用"此前只写在项目级 AGENTS.md
// （/root/proj/AGENTS.md，只在那个工作区生效）⇒ 公开用户的 Codex 侧完全不知道有这套东西。
// 这段把它写进全局 ~/.codex/AGENTS.md：带标记则跳过，与上面 v2 段互不干扰（独立幂等）。
const BOARD_MARK = '<!-- dsh-second-engine:board -->'
const BOARD_SECTION = `${BOARD_MARK}
## 长任务协作看板（dual-board）

- **协议全文**：本插件包内 \`tools/dual-board/PROTOCOL.md\`。派单 prompt 提到 dual-board、或数据目录里 \`board.json\` 还有未完成任务时，**先读协议再动工**。
- **写板唯一入口**：本插件包内 \`tools/dual-board/board.sh\`（\`new\` / \`claim\` / \`complete\` / \`block\` / \`abandon\` / \`show\` / \`ready\` / \`inbox-append|unread|read|archive\` / \`scope-check\` / \`doctor\`）—— **不要手写 \`board.json\`**。
- **脚本与协议在哪**：\`ls -d ~/.dsh/profiles/*/node_modules/dsh-second-engine/tools/dual-board/\`（以 \`link:\` 方式安装时该路径是软链，用 \`readlink -f\` 看实体）。
- **收件箱**：\`inbox-codex.md\`（lead → 你）—— **每次被唤醒的第一动作必读**。
- **交付必含四段**：交付 / 异议位 / 下一步建议 / 自验（并注明遵守的协议版本）。异议位不许沉默——列前提、标未验证项。
- **终态不可复改**：\`completed\` / \`abandoned\`；出问题开新任务，并在 \`context\` / \`blocked_by\` 引用旧任务。
- **数据目录**：默认 \`~/proj/dual-board\`，用环境变量 \`DUAL_BOARD_DIR\` 覆盖。
`
function ensureBoardProtocol() {
  try {
    const path = join(CODEX_DIR, 'AGENTS.md')
    let existing = ''
    try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则新建 */ }
    if (existing.includes(BOARD_MARK)) return
    const merged = existing.endsWith('\n') || existing === '' ? existing + BOARD_SECTION : existing + '\n\n' + BOARD_SECTION
    writeFileSync(path, merged, 'utf8')
    chmodSync(path, 0o600)
  } catch (e) { noteErr('board-protocol', e) /* best effort：写入失败不阻断插件启动 */ }
}

// ── 主动开口与整体评估段（2026-10-25 增；协作位 1「允许提议」）──
// 与 v2/board 段不同：用成对标记（起止各一），支持切档删除 —— board 单标记只能加不能删，
// on→off 切档时无法回收旧段，这里不照抄那个缺陷。
// 档位=协作两位之一（voice on/off）：on 写入/刷新段，off 删段；
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
function collabStatus() {
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
    const path = join(CODEX_DIR, 'AGENTS.md')
    let existing = ''
    try { existing = readFileSync(path, 'utf8') } catch { /* 不存在则视为空 */ }
    // 先摘除旧段（含标记本身），再按档位决定是否追加：on=刷新，off=移除。
    const stripped = existing.replace(VOICE_SECTION_RE, '')
    const next = voiceMode() !== 'on' ? stripped
      : (stripped.endsWith('\n') || stripped === '' ? stripped + VOICE_SECTION : stripped + '\n\n' + VOICE_SECTION)
    if (next === existing) return
    atomicWriteFileSync(path, next)
  } catch (e) { noteErr('voice-protocol', e) }
}

// 读取并归一化 keyring：
//   - 文件缺失/不可解析 → 首次初始化：写入两家预设（apiKey 空）
//   - 旧格式 { provider: 'deepseek'|'zhipu', key } → 迁移为对应预设的 apiKey
//   - 新格式 → 归一化，并保证两家预设始终在列
//   - 三种路径都带上 reviewRounds：handler 里 saveKeyring(loadKeyring()) 才不会把它写丢。
function loadKeyring() {
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
function providerView(p) {
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

function invalidIdError(id) {
  if (id === '') return 'id 不能为空'
  if (!ID_PATTERN.test(id)) return 'id 必须以小写字母开头，且只含小写字母、数字、下划线或连字符'
  return null
}

// 接受 'responses'（直连）与 'completions'（经本地翻译桥）；其余取值拒绝。
function wireApiError(value) {
  if (value === undefined || value === null || value === '') return null
  if (SUPPORTED_WIRE_APIS.has(value)) return null
  return `wireApi 只支持 'responses'（直连）或 'completions'（经本地桥），收到 '${value}'`
}

// ── config.toml 生成 ──
// TOML 基本字符串转义，并压掉换行避免注入额外键。
function tomlString(value) {
  return `"${String(value).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// 首次写入前把原始 config.toml 备份为 config.toml.bak-se；已存在则跳过、绝不覆盖。
function backupConfig() {
  try {
    if (existsSync(CONFIG_PATH) && !existsSync(CONFIG_BACKUP_PATH)) {
      copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH)
      chmodSync(CONFIG_BACKUP_PATH, 0o600)
    }
  } catch { /* 备份失败不阻断切换（best effort） */ }
}

// 提取原 config.toml 中全部 [mcp_servers.*] 段（段体直到下一个段头或文件尾）。
// 插件模板不生成这些段；切换提供方时原样保留，避免用户经 codex mcp add 挂载的
// 外部 MCP（如 exa）在重写中丢失。原文件不存在或读取失败时返回空数组。
function extractMcpServerBlocks() {
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

// 插件模板自己生成的段（每次重写都会重新生成）—— 重写时只排除这一类，其余段原样保留。
// 用黑名单而非白名单：白名单每出现一种新段就要补一次名单，漏补 = 静默丢配置。
// 2026-10-02 实证：旧白名单只保留 mcp_servers.*，切一次提供方就把 [features] 整段丢掉，
// memories / multi_agent_v2 / network_proxy / recommended_plugins 全部回到默认 false，
// [projects."/root/proj"] 的 trust_level 也一并消失，且全程零报错。
//
// memories 也归模板管：它的两个模型字段必须跟随当前提供方。缺省时 Codex 会去挑
// 内置目录里的 OpenAI 模型名，落到第三方提供方上就是「模型不存在，请检查模型代码」，
// 记忆生成全失败（2026-10-02 实证：jobs 表 6 条全 error、stage1_outputs 0 行）。
const TEMPLATE_OWNED_SECTION = /^\[(?:model_providers\.[^\]\n]+|memories)\][^\n]*$/

// 提取原 config.toml 中「除模板自有段之外」的全部段（段体直到下一个段头或文件尾）。
// 原文件不存在或读取失败时返回空数组。
function extractPreservedSections() {
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

// 模板自己生成的顶层键（每次重写重新生成）；其余顶层键值行重写时原样带回。
// 原先只显式保留 sandbox_mode/web_search，用户手写的其它顶层键（如
// disable_response_storage）在切换提供方时被静默丢弃。
const TEMPLATE_OWNED_TOP_LEVEL = new Set([
  'model_provider', 'model', 'sandbox_mode', 'web_search', 'approval_policy',
  'model_context_window', 'model_max_output_tokens',
])

// 首个段头之前的非模板顶层 key = value 行（原样保留；TOML 顶层键必须在首个 [table] 前）。
function extractPreservedTopLevelLines() {
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

// ── config.toml 读写（web_search / mcp_servers）──
// 与 extractMcpServerBlocks 同口径：读不到就当下不存在，绝不抛错。
function readConfigRaw() {
  try { return readFileSync(CONFIG_PATH, 'utf8') } catch { return '' }
}

// 落盘统一走这里：目录先建、权限 0600（config.toml 里有 apiKey 引用等敏感信息）。
function writeConfigRaw(text) {
  mkdirSync(CODEX_DIR, { recursive: true })
  atomicWriteFileSync(CONFIG_PATH, text)
}

// 读顶层字符串字段（无该字段/文件缺失 → fallback）。与 sandbox_mode 保留同一写法。
function readTopLevelString(key, fallback) {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(readConfigRaw())
  return m === null ? fallback : m[1]
}

// 当前生效的 web_search：非法/缺失一律按 disabled（与 Codex 无该字段时的默认行为一致）。
function readWebSearch() {
  const value = readTopLevelString('web_search', DEFAULT_WEB_SEARCH)
  return WEB_SEARCH_MODES.includes(value) ? value : DEFAULT_WEB_SEARCH
}

// 写顶层字符串字段。TOML 铁律：顶层键必须排在第一个 [table] 之前，否则会被归进那张表。
// 已存在则原地替换，否则插在顶层块末尾。
function writeTopLevelString(key, value) {
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
function listMcpServers() {
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
function addMcpServer(name, url) {
  const block = `[mcp_servers.${name}]\nurl = ${tomlString(url)}`
  const raw = readConfigRaw().replace(/\n*$/, '')
  writeConfigRaw(raw === '' ? `${block}\n` : `${raw}\n\n${block}\n`)
}

// 原地删除一个 [mcp_servers.<name>] 段（段体直到下一个段头或文件尾）。
// 存在并删除 → true；不存在 → false（handler 据此回 404）。
function removeMcpServer(name) {
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
function setMcpServerEnabled(name, enabled) {
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
function readProcStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // 切分后下标 = 原字段号 - 3（field 3 即 parts[0]）；starttime 是 field 22 → parts[19]
    const raw = parts[19]
    return raw === undefined ? null : raw
  } catch { return null }
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
  const pid = task.childPid
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e !== null && e !== undefined && e.code === 'ESRCH') return 'process-gone'
    return null // EPERM 等：进程还在，只是没权限探测
  }
  const nowStart = readProcStartTime(pid)
  if (task.childStart !== undefined && task.childStart !== null && nowStart !== null && nowStart !== task.childStart) {
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
    const why = probeTaskLost(task)
    if (why === null) continue
    task.reconcileLost = why
    if (finalizeTask(task, -1, 'error') && task.cancelled !== true) void notifyTask(task)
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
async function writeCodexConfig(provider) {
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

// ── API handlers ──
async function handleStatus(_req, res) {
  try {
    send(res, {
      ok: true,
      codexBinary: existsSync(CODEX_BINARY),
      configExists: existsSync(CONFIG_PATH),
      keyConfigured: keyConfigured(),
      sessionsBytes: sessionsBytesCached(),
      // D（2026-10-25）：最近 10 条吞错留痕（已脱敏）——「配置没写进去」类问题从这里查。
      lastErrors: ERR_LOG.slice(-10),
      // 协作两位 + 派生预设（主 AI 派单前查这里；preset 派生点在 collabPreset）。
      collab: collabStatus(),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 兼容旧面板：POST { provider, key } 等价于给该预设提供方设置 apiKey。
async function handleKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!PRESET_IDS.has(id)) {
      return send(res, { ok: false, error: 'provider 必须是 deepseek 或 zhipu' }, 400)
    }
    if (key === '') {
      return send(res, { ok: false, error: 'key 不能为空' }, 400)
    }
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    }
    target.apiKey = key
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(key) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /providers：列表（apiKey 脱敏）+ active。
async function handleProvidersList(_req, res) {
  try {
    const doc = loadKeyring()
    send(res, { ok: true, active: doc.active, providers: doc.providers.map(providerView) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers：新增自定义提供方。
async function handleProviderAdd(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

    const idErr = invalidIdError(id)
    if (idErr !== null) return send(res, { ok: false, error: idErr }, 400)
    const wireErr = wireApiError(body.wireApi)
    if (wireErr !== null) return send(res, { ok: false, error: wireErr }, 400)
    if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
    if (baseUrl === '') return send(res, { ok: false, error: 'baseUrl 不能为空' }, 400)

    const doc = loadKeyring()
    if (doc.providers.some((p) => p.id === id)) {
      return send(res, { ok: false, error: `提供方 '${id}' 已存在` }, 400)
    }
    const wireApi = typeof body.wireApi === 'string' && body.wireApi !== '' ? body.wireApi : WIRE_API
    const provider = { id, name, baseUrl, wireApi, model, apiKey }
    doc.providers.push(provider)
    saveKeyring(doc)
    send(res, { ok: true, active: doc.active, provider: providerView(provider) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/providers 同 path 两个方法：GET 列表 / POST 新增，其余 405。
async function handleProvidersRoot(req, res) {
  if (req.method === 'POST') return handleProviderAdd(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleProvidersList(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// POST /providers/key：设置指定提供方的 apiKey（文件保持 0600）。
async function handleProviderKey(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    target.apiKey = apiKey
    saveKeyring(doc)
    send(res, { ok: true, id, preview: maskKey(apiKey) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/active：切换激活并提供 config.toml（写前备份一次）。
async function handleProviderActive(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    // 先落 keyring，config 重写失败时回滚 active：避免「active 已持久化、
    // config.toml 还指着旧提供方」的两处不一致（对账 tick 只自愈桥，不自愈直连配置）。
    const previousActive = doc.active
    doc.active = id
    saveKeyring(doc)
    let envKey = ''
    try {
      envKey = await writeCodexConfig(target)
    } catch (e) {
      doc.active = previousActive
      try { saveKeyring(doc) } catch { /* 回滚失败：用户重试兜底 */ }
      throw e
    }
    send(res, { ok: true, active: id, configPath: CONFIG_PATH, backupPath: CONFIG_BACKUP_PATH, envKey })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/delete：核心默认（deepseek/zhipu）不可删；自定义提供方均可删。删除 active 时回落并同步 config.toml。
const PROTECTED_IDS = new Set(['deepseek', 'zhipu'])
async function handleProviderDelete(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    if (PROTECTED_IDS.has(id)) {
      return send(res, { ok: false, error: `核心默认提供方 '${id}' 不允许删除（自定义提供方均可删）` }, 400)
    }
    const doc = loadKeyring()
    const index = doc.providers.findIndex((p) => p.id === id)
    if (index === -1) return send(res, { ok: false, error: `未找到提供方 '${id}'` }, 404)
    doc.providers.splice(index, 1)
    let configRegenerated = false
    let fallback = null
    if (doc.active === id) {
      doc.active = DEFAULT_ACTIVE
      fallback = doc.providers.find((p) => p.id === DEFAULT_ACTIVE) ?? null
    }
    // 先落 keyring 再重写 config.toml：saveKeyring 一旦放到 await 之后，
    // 窗口期内其它 handler（如 /providers/key）落盘的修改会被这份旧 doc 整体覆盖（丢 key）。
    saveKeyring(doc)
    if (fallback !== null) {
      await writeCodexConfig(fallback)
      configRegenerated = true
    }
    send(res, { ok: true, active: doc.active, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /providers/update：编辑既有提供方。apiKey 省略 = 不改，其余字段只更新出现的。
// 该提供方为 active 且 baseUrl/wireApi/model 有变化时重写 config.toml（这些值会影响 config.toml）。
async function handleProviderUpdate(req, res) {
  try {
    const body = await readBody(req)
    const ignored = Object.keys(body)
      .filter((key) => !['id', 'name', 'baseUrl', 'wireApi', 'model', 'apiKey'].includes(key))
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空', ignored }, 400)
    const doc = loadKeyring()
    const target = doc.providers.find((p) => p.id === id)
    if (target === undefined) return send(res, { ok: false, error: `未找到提供方 '${id}'`, ignored }, 404)

    // 先把请求里出现过的字段全部校验完再落盘，避免校验失败后半更新。
    const patch = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return send(res, { ok: false, error: 'name 不能为空', ignored }, 400)
      patch.name = name
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
      if (!/^https?:\/\//i.test(baseUrl)) {
        return send(res, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头', ignored }, 400)
      }
      patch.baseUrl = baseUrl
    }
    if (body.wireApi !== undefined) {
      const wireApi = typeof body.wireApi === 'string' ? body.wireApi.trim() : ''
      const wireErr = wireApiError(wireApi)
      if (wireErr !== null) return send(res, { ok: false, error: wireErr, ignored }, 400)
      // 空串 = 未指定（与 wireApiError 的放行语义一致），不写进 patch：
      // 否则原为 completions 的提供方会被空串切成直连，错误还随 saveKeyring 固化。
      if (wireApi !== '') patch.wireApi = wireApi
    }
    if (body.model !== undefined) {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') return send(res, { ok: false, error: 'model 不能为空', ignored }, 400)
      patch.model = model
    }
    // apiKey 省略 = 保持原值；显式传空串属于误用（不修改就不该带这个字段）。
    if (body.apiKey !== undefined) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (apiKey === '') return send(res, { ok: false, error: 'apiKey 不能为空（不修改请省略该字段）', ignored }, 400)
      patch.apiKey = apiKey
    }

    // updated 只列真正发生变化的字段；空数组 = 提交值与现值完全一致，不落盘。
    const updated = []
    for (const key of Object.keys(patch)) {
      if (target[key] !== patch[key]) {
        target[key] = patch[key]
        updated.push(key)
      }
    }
    if (updated.length > 0) saveKeyring(doc)

    let configRegenerated = false
    if (doc.active === id && (updated.includes('baseUrl') || updated.includes('wireApi') || updated.includes('model'))) {
      await writeCodexConfig(target)
      configRegenerated = true
    }
    send(res, { ok: true, id, updated, ignored, configRegenerated })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /models 与 /model：模型获取与选择 ──

// 拼出 /models 端点：压掉 baseUrl 末尾斜杠，避免 '//models'。
function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

// 智谱：open.bigmodel.cn 上 /api/v1 是 **Codex 专用适配端点**（模型清单只列 codex 适配好的几个），
// 而 /api/coding/paas/v4 是编程端点、列出全量模型；两者共用同一把 key（2026-09-28 实测）。
// 这里给它一个辅助清单 URL，与主端点求并集展示，避免"面板只显示 3 个模型"的误判。
function bigmodelAuxModelsUrl(baseUrl) {
  return /open\.bigmodel\.cn/i.test(baseUrl)
    ? 'https://open.bigmodel.cn/api/coding/paas/v4/models'
    : null
}

// 兼容两种实测返回格式：
//   OpenAI（DeepSeek）：{ object:'list', data:[{ id, ... }] }
//   Z.ai（智谱）：      { models:[{ id, display_name, ... }] }
// 取 id；无 id 时回落 display_name；顺带容忍纯字符串条目与重复项。
function extractModels(json) {
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

// POST /models：body { id }（缺省 = active）。带 Bearer 拉取该提供方模型清单。
async function handleModels(req, res) {
  try {
    if (typeof fetch !== 'function') {
      return send(res, { ok: false, error: '当前 Node 运行时不支持 fetch（需要 Node 18+）' })
    }
    const body = await readBody(req)
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
    const doc = loadKeyring()
    const target = id === ''
      ? doc.providers.find((p) => p.id === doc.active)
      : doc.providers.find((p) => p.id === id)
    if (target === undefined) {
      return send(res, { ok: false, error: `未找到提供方 '${id === '' ? doc.active : id}'` }, 404)
    }
    if (target.apiKey.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 尚未配置 apiKey` }, 400)
    }
    if (target.baseUrl.trim() === '') {
      return send(res, { ok: false, error: `提供方 '${target.id}' 未配置 baseUrl` }, 400)
    }

    const urls = [modelsUrl(target.baseUrl)]
    const auxUrl = bigmodelAuxModelsUrl(target.baseUrl)
    if (auxUrl !== null && auxUrl !== urls[0]) urls.push(auxUrl)

    const models = []
    let primaryError = ''
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        const text = await r.text()
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        if (!r.ok) {
          const detail = json !== null && typeof json.error?.message === 'string' ? `：${json.error.message}` : ''
          // 主端点失败才算失败；辅助端点失败静默（它只是锦上添花）
          if (i === 0) primaryError = `GET ${url} 返回 HTTP ${r.status}${detail}`
        } else if (json !== null) {
          for (const m of extractModels(json)) if (!models.includes(m)) models.push(m)
        } else if (i === 0) {
          primaryError = `GET ${url} 返回非 JSON 响应`
        }
      } catch (e) {
        if (i === 0) primaryError = `请求 ${url} 失败：${errMsg(e)}`
      } finally {
        clearTimeout(timer)
      }
    }
    if (models.length === 0 && primaryError !== '') {
      return send(res, { ok: false, error: primaryError })
    }
    // sources 回显实际拉取的端点，便于核对"为什么是这个清单"
    send(res, { ok: true, id: target.id, models, sources: urls })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /model：body { id, model }（id 缺省 = active）。写入 provider.model；
// 若该提供方正是 active，则同步重写 config.toml，使引擎立刻用上新模型。
async function handleProviderModel(req, res) {
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
function cleanupSessions(dir, cutoff, stats) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      cleanupSessions(full, cutoff, stats)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = statSync(full)
      if (info.mtimeMs >= cutoff) continue
      unlinkSync(full)
      stats.removed += 1
      stats.freedBytes += info.size
    } catch { /* 跳过无法删除的条目 */ }
  }
}

// C 项（2026-10-17 用户定）：过程流 `task-*.out.live` 落在 CODEX_DIR 根下、**不在 sessions/ 内**，
// 所以 cleanupSessions 的递归永远扫不到它 —— 这里单独按 mtime 清。
// 跳过 status==='running' 的任务：它可能正在写这个文件（同一 outPath）。
function cleanupLiveFiles(cutoff, stats) {
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

async function handleCleanup(req, res) {
  try {
    const body = await readBody(req)
    // 请求未带 keepDays 时用 settings 命名空间镜像来的默认值（客户端总会带上）。
    const keepDays = body.keepDays === undefined ? keepDaysDefault : Number(body.keepDays)
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      return send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
    }
    const stats = { removed: 0, freedBytes: 0 }
    cleanupSessions(SESSIONS_DIR, Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    cleanupLiveFiles(Date.now() - keepDays * 24 * 60 * 60 * 1000, stats)
    // 把本次使用的保留天数回写到命名空间，使设置页卡片与本页一致（best effort）。
    if (secondEngineSettingsScope !== null) {
      try { void secondEngineSettingsScope.update({ keepDays: Math.floor(keepDays) }).catch(() => {}) } catch { /* settings 不可用时忽略 */ }
    }
    send(res, { ok: true, removed: stats.removed, freedBytes: stats.freedBytes })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /task、/tasks、/task/cancel：异步工单 ──

// 只要序列化安全的那部分（child/outPath/watchdog 绝不出进程）。
function taskView(task) {
  const view = {
    id: task.id,
    kind: task.kind === 'review' ? 'review' : 'task',
    status: task.status,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    workdir: task.workdir,
    output: typeof task.output === 'string' ? task.output : '',
  }
  // 实时进度可见性：exec 模式看 liveBytes（过程流字节数，在涨=在动），
  // appserver 模式另加 progress（归一化事件）。
  if (task.live !== undefined && task.live !== null) view.liveBytes = task.live.bytes ?? 0
  if (task.mode === 'appserver') {
    // T5：app-server 模式的实时进度（归一化事件，最近 20 条），供界面做流式展示。
    view.mode = 'appserver'
    view.progress = Array.isArray(task.progress) ? task.progress.slice(-20) : []
  }
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
  }
  if (task.stuckSuspect === true) view.stuckSuspect = true
  if (task.lastSignal) view.lastSignal = task.lastSignal
  // ① 对账 tick 判失联的原因（'process-gone' | 'pid-reused'）——不暴露就没法验收探活。
  if (typeof task.reconcileLost === 'string' && task.reconcileLost !== '') view.reconcileLost = task.reconcileLost
  if (typeof task.error === 'string' && task.error !== '') view.error = task.error
  // appserver 模式的失败原因记在 appError（原先不外发，外部无从诊断）。
  if (view.error === undefined && typeof task.appError === 'string' && task.appError !== '') view.error = task.appError
  return view
}

// 摘要：不含 output（列表只给状态，全文按需点开再取）。
function taskSummary(task) {
  const view = taskView(task)
  delete view.output
  return view
}

// 任务表封顶，避免长时间运行后无限增长；只淘汰已结束的最旧条目。
function pruneTasks() {
  if (tasks.size <= TASK_KEEP_LIMIT) return
  const finished = [...tasks.values()]
    .filter((t) => t.endedAt !== null && t.endedAt !== undefined)
    .sort((a, b) => a.endedAt - b.endedAt)
  for (const victim of finished) {
    if (tasks.size <= TASK_KEEP_LIMIT) break
    tasks.delete(victim.id)
  }
}

// 看门狗：任务结束即清 interval（finalizeTask / finalizeReview 都会调用）。
function stopWatchdog(task) {
  if (task.watchdog === null || task.watchdog === undefined) return
  try { clearInterval(task.watchdog) } catch { /* best effort */ }
  task.watchdog = null
}

// -o 输出文件 mtime（毫秒）；文件还没生成时返回 null。
function outFileMtimeMs(outPath) {
  try { return statSync(outPath).mtimeMs } catch { return null }
}

// spawn 后启动：每 30s 看一次 -o 文件 mtime，超 300s 无变化 → stuckSuspect + 通知一次。
// 复核每轮换新的 outPath，检查时按 task.outPath 动态取值，故 interval 可跨越整个任务生命周期。
function startWatchdog(task) {
  if (task.watchdog !== null && task.watchdog !== undefined) return
  // 顺带固定子进程身份（对账 tick 判失联用）：只在首次记录，重复调用不覆盖。
  if (task.childPid === undefined && task.child !== null && task.child !== undefined) {
    task.childPid = Number.isInteger(task.child.pid) ? task.child.pid : null
    task.childStart = readProcStartTime(task.childPid)
  }
  task.activityAt = Date.now()
  task.watchdog = setInterval(() => {
    try {
      if (task.endedAt !== null && task.endedAt !== undefined) { stopWatchdog(task); return }
      const mtime = task.outPath ? outFileMtimeMs(task.outPath) : null
      if (mtime !== null && mtime > task.activityAt) {
        task.activityAt = mtime
        task.stuckSuspect = false
        return
      }
      if (task.stuckSuspect === true) return
      if (Date.now() - task.activityAt >= WATCHDOG_STALL_MS) {
        task.stuckSuspect = true
        const label = task.kind === 'review' ? '复核' : '工单'
        notify(`${label} ${task.id.slice(-6)} 疑似停滞（>300s 无输出更新）`)
      }
    } catch { /* best effort：看门狗自身绝不抛错 */ }
  }, WATCHDOG_INTERVAL_MS)
  // 不因看门狗把宿主进程吊住。
  if (typeof task.watchdog.unref === 'function') task.watchdog.unref()
}

// 超长 -o 输出只留头尾（各半）：output 会整段进内存并随 GET /task 全量外发，
// 不设限时长任务的输出可达数百 MB（OOM + 响应体爆炸）。
const TASK_OUTPUT_CLIP = 2 * 1024 * 1024
function readHeadTail(path, maxBytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const readChunk = (buf, position) => {
      let off = 0
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, position + off)
        if (n <= 0) break
        off += n
      }
      return buf.toString('utf8')
    }
    if (size <= maxBytes) return readChunk(Buffer.alloc(size), 0)
    const half = Math.floor(maxBytes / 2)
    const head = readChunk(Buffer.alloc(half), 0)
    const tailLen = Math.min(half, size)
    const tail = readChunk(Buffer.alloc(tailLen), size - tailLen)
    return `${head}\n…[second-engine 截断：全文 ${size} 字节，仅保留头尾各 ${half} 字节]…\n${tail}`
  } finally {
    try { closeSync(fd) } catch { /* best effort */ }
  }
}

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

function appendConsultBlock(task) {
  const fresh = consultsForTask(task)
  if (fresh.length === 0) return
  const block = fresh.map(c =>
    `- ${new Date(c.at).toISOString()} ｜ ${c.task}${c.stuckContext ? ` ｜ 上下文：${c.stuckContext}` : ''}`,
  ).join('\n')
  const base = typeof task.output === 'string' ? task.output : ''
  task.output = `${base === '' ? '' : `${base}\n\n`}---\n`
    + `[SECOND_ENGINE_CONSULT] 本任务期间收到 ${fresh.length} 条卡点求助：\n${block}\n`
}

function finalizeJob(task, exitCode, status, extra) {
  if (task.endedAt !== null && task.endedAt !== undefined) return false
  stopWatchdog(task)
  // exitCode 省略 = 保留调用方已记的值：复核每轮在 runReview 里自记 exitCode，不能覆盖。
  if (exitCode !== undefined) task.exitCode = exitCode
  task.status = status
  if (extra) Object.assign(task, extra)
  // 读 -o 输出（头尾截断），成功才覆盖：复核轮文件在 readReviewOut 里逐轮已删、
  // 工单也可能没生成输出文件 —— 读不到时保留现有 output，这是常态不是错误。
  try { task.output = readHeadTail(task.outPath, TASK_OUTPUT_CLIP) } catch { /* 保留现有 output */ }
  // A 方案（2026-10-17 用户定）：过程流 `.live` 同样在收尾时删除 —— ephemeral 工单跑完
  // 不在磁盘留任何输出。要事后回看过程就勾「保留会话」（ephemeral:false，走 rollout）。
  // 复核被熔断时本轮 -o 文件还在（readReviewOut 没跑到），这里一并回收，不再单靠 keepDays。
  try { unlinkSync(task.outPath) } catch { /* 文件可能本就没生成/已被逐轮清理，忽略 */ }
  try { unlinkSync(`${task.outPath}.live`) } catch { /* 未生成或已被清，忽略 */ }
  // 本次任务期间收到过 Codex 卡点求助？追加进 output —— 主 AI 收单必读 output，这是它唯一必经的通道。
  // 互审是最容易绕圈求助的场景，统一路径后两条收尾天然都不漏。
  try { appendConsultBlock(task) } catch (e) { noteErr('consult', e) }
  task.endedAt = Date.now()
  return true
}

// 工单收尾：统一走 finalizeJob。
function finalizeTask(task, exitCode, status) {
  return finalizeJob(task, exitCode, status)
}

// 完成/停滞通知：走本机 3090 桥的 /app/notify（token 鉴权）。3 秒超时，任何失败静默忽略。
function notify(text, title = '第二引擎') {
  try {
    let token = ''
    try { token = readFileSync(NOTIFY_TOKEN_PATH, 'utf8').trim() } catch { return }
    if (token === '') return
    const url = `${NOTIFY_URL}?token=${encodeURIComponent(token)}`
      + `&title=${encodeURIComponent(title)}`
      + `&text=${encodeURIComponent(text)}`
    const req = http.get(url, (resp) => { resp.on('error', () => { /* 响应中途断开：静默 */ }); resp.resume() })
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => { try { req.destroy() } catch { /* best effort */ } })
    req.on('error', () => { /* 桥没开或拒绝连接：静默 */ })
  } catch { /* best effort */ }
}

function notifyTask(task) {
  const label = task.kind === 'review' ? '复核' : '任务'
  const exit = Number.isInteger(task.exitCode) ? ` (exit ${task.exitCode})` : ''
  notify(`${label} ${task.id.slice(-6)} ${task.status}${exit}`)
}

// 复核任务收尾：同样统一走 finalizeJob（A，2026-10-25：原先不读 output、不删 outPath，
// 轮次文件只能靠 keepDays 兜底 —— 已对齐）。verdict / error 是复核特有字段，经 extra 附加；
// exitCode 省略以保留 runReview 每轮自记的值。
function finalizeReview(task, status, verdict, error) {
  return finalizeJob(task, undefined, status, {
    verdict,
    error: typeof error === 'string' ? error : '',
  })
}

function queryParam(url, key) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key) || ''
  } catch { return '' }
}

// spawn 前给没有版本控制的 workdir 打一个基线提交：Codex 在无 .git 的目录里
// diff / 回滚都无从下手。幂等（已有 .git 直接跳过）、静默（git 缺失或提交失败都不阻断工单）。
// 提交身份：本机实证 root 无 ~/.gitconfig（`git commit` 报 Author identity unknown），
// 那样基线只剩 .git + 暂存区、等于没打成，所以缺身份时用 env 兜底（不覆盖宿主已配的身份）。
// git 全部走异步 execFile（带超时）：execSync 在大目录下可把整个 Web 宿主卡住
// 数秒到分钟级（期间全部 HTTP 请求、看门狗、对账 tick 停摆）。退出码 0 → true。
function gitOk(args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { timeout: 60000, ...opts }, (err) => { resolve(err === null) })
    } catch { resolve(false) }
  })
}

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

async function ensureGitBaseline(workdir) {
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

// T5：app-server 执行模式 —— 长连接 JSON-RPC。归一化事件进 task.progress；
// agentMessage 增量由客户端直接 append 到 -o 文件，故 finalizeTask/看门狗逻辑零改动。
function startAppServerTask({ res, id, outPath, workdir, prompt, envKey, apiKey }) {
  const env = { ...process.env, [envKey]: apiKey }
  const task = {
    id,
    kind: 'task',
    status: 'running',
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    endedAt: null,
    workdir,
    child: null,
    outPath,
    cancelled: false,
    mode: 'appserver',
    progress: [],
  }
  const handle = startAppServerTurn({
    cwd: workdir,
    env,
    prompt,
    outPath,
    onEvent: (evt) => {
      // 进度只保生产所需字段：meta.raw 是原始帧（可能很大），落盘前剔除
      const meta = { ...(evt.meta ?? {}) }
      delete meta.raw
      task.progress.push({ at: Date.now(), ...evt, ...(evt.meta ? { meta } : {}) })
      if (task.progress.length > 20) task.progress.shift()
      // 任何事件都刷新 -o mtime：既有看门狗「300s 无变化 → stuckSuspect」自动适配流式场景
      try {
        const now = new Date()
        utimesSync(outPath, now, now)
      } catch { /* 文件可能尚未创建 */ }
    },
  })
  task.child = handle.child
  task.app = handle
  tasks.set(id, task)
  pruneTasks()
  startWatchdog(task)

  handle.run.catch((e) => {
    task.appError = errMsg(e)
    if (finalizeTask(task, -1, 'error') && task.cancelled !== true) void notifyTask(task)
  })
  handle.done
    .then((r) => {
      const ok = r.status === 'completed'
      if (finalizeTask(task, ok ? 0 : 1, ok ? 'done' : 'error') && task.cancelled !== true) void notifyTask(task)
    })
    .catch((e) => {
      task.appError = errMsg(e)
      if (finalizeTask(task, -1, 'error') && task.cancelled !== true) void notifyTask(task)
    })

  send(res, { ok: true, id, mode: 'appserver' })
}

// POST /task：body { prompt, workdir?, ephemeral? }。立刻返回 { ok, id }，任务后台跑。
// ephemeral 缺省 true（不落盘 rollout），只有显式 body.ephemeral === false 才持久化会话。
async function handleTaskCreate(req, res) {
  try {
    const body = await readBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') return send(res, { ok: false, error: 'prompt 不能为空' }, 400)
    const workdir = typeof body.workdir === 'string' && body.workdir.trim() !== ''
      ? body.workdir.trim()
      : DEFAULT_TASK_WORKDIR
    if (!existsSync(workdir)) {
      return send(res, { ok: false, error: `workdir 不存在：${workdir}` }, 400)
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
    const child = spawn('codex', args, {
      cwd: workdir,
      env: { ...process.env, [envKey]: active.apiKey },
      // stdin 改 pipe：写入提示词后立即 end()，EOF 自然到达（codex exec 等 stdin EOF 开始干活）。
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
      live.bytes += buf.length
      // 轮转：live 只作近期诊断，超限重开（'w' 从头写），不让长任务把它膨胀到 GB 级。
      if (live.bytes - live.rotatedAt > LIVE_ROTATE_BYTES) {
        live.rotatedAt = live.bytes
        try { liveStream.end() } catch { /* best effort */ }
        liveStream = openLiveStream('w')
      }
      liveStream.write(buf)
    }
    child.stdout?.on('data', writeLive)
    child.stderr?.on('data', writeLive)
    const task = {
      id,
      kind: 'task',
      status: 'running',
      exitCode: null,
      output: '',
      startedAt: Date.now(),
      endedAt: null,
      workdir,
      child,
      outPath,
      live,
      cancelled: false,
    }
    tasks.set(id, task)
    pruneTasks()
    startWatchdog(task)

    child.on('exit', (code, signal) => {
      // 被取消的任务固定 error/-1；其余按真实退出码判定。
      const cancelled = task.cancelled === true
      const exitCode = cancelled ? -1 : (Number.isInteger(code) ? code : -1)
      const status = cancelled ? 'error' : (exitCode === 0 ? 'done' : 'error')
      // 记录终止信号：exitCode=-1 时只有它能区分「外部 SIGTERM/SIGKILL」与「spawn 失败」。
      if (signal) task.lastSignal = signal
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

// GET /task?id=：单条全量（含 output）。
async function handleTaskGet(req, res) {
  try {
    const id = queryParam(req.url, 'id')
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    send(res, { ok: true, task: taskView(task) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// GET /tasks：最近 10 条摘要（新→旧，不含 output）。
async function handleTaskList(_req, res) {
  try {
    const list = [...tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, TASK_LIST_LIMIT)
      .map(taskSummary)
    send(res, { ok: true, tasks: list })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /task/cancel：body { id }。SIGTERM 后按约定标 error/-1（exit 回调不再重复收尾）。
async function handleTaskCancel(req, res) {
  try {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') return send(res, { ok: false, error: 'id 不能为空' }, 400)
    const task = tasks.get(id)
    if (task === undefined) return send(res, { ok: false, error: `未找到任务 '${id}'` }, 404)
    if (task.status !== 'running') {
      return send(res, { ok: false, error: `任务已结束（${task.status}），无需取消` }, 400)
    }
    // 立刻落定状态（用户看到反馈不必等子进程真的退出）；
    // output 留给 exit 回调收尾，那样能拿到进程退出前的完整输出。
    task.cancelled = true
    task.status = 'error'
    task.exitCode = -1
    // T5：app-server 模式先发 turn/interrupt（优雅结束当前 turn），kill 作为兜底。
    if (task.app !== undefined && typeof task.app.interrupt === 'function') {
      // interrupt 可能 reject（连接已断等）：吞掉，取消路径靠 SIGTERM/SIGKILL 兜底。
      void Promise.resolve(task.app.interrupt()).catch(() => {})
    }
    try { task.child.kill('SIGTERM') } catch { /* 进程可能刚好自己退出 */ }
    // 兜底（2026-09-27 实测：codex 子进程偶有 SIGTERM 后残留）：3s 后仍未退出则 SIGKILL。
    const child = task.child
    const killTimer = setTimeout(() => {
      try {
        if (child !== null && child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          task.forcedKill = true
        }
      } catch { /* best effort */ }
    }, 3000)
    if (typeof killTimer.unref === 'function') killTimer.unref()
    send(res, { ok: true, id, status: task.status, exitCode: task.exitCode })
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
function extractFirstJsonObject(text) {
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

const asText = (value) => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return String(value) } catch { return '' }
}

// 归一化单条 issue：severity/point/suggestion 一律收敛成字符串，形状稳定。
function normalizeIssue(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    severity: asText(item.severity).trim(),
    point: asText(item.point).trim(),
    suggestion: asText(item.suggestion).trim(),
  }
}

// 解析复核输出 → { ok:true, issues, verdict } 或 { ok:false, raw }。
// issues 必须是数组（缺键视为解析失败：宁可报错也不误判「已收敛」）。
function parseReviewJson(text) {
  const block = extractFirstJsonObject(text)
  if (block === null) return { ok: false, raw: clipText(text) }
  let obj
  try { obj = JSON.parse(block) } catch { return { ok: false, raw: clipText(block) } }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, raw: clipText(block) }
  if (!Array.isArray(obj.issues)) return { ok: false, raw: clipText(block) }
  const issues = obj.issues.map(normalizeIssue)
  const verdict = asText(obj.verdict).trim()
  return { ok: true, issues, verdict: verdict !== '' ? verdict : (issues.length === 0 ? 'converged' : 'issues-found') }
}

// 固定模板 + 被审产出 +（第 2 轮起）上一轮 issues 对照。
function buildReviewPrompt(content, prev) {
  const parts = [REVIEW_TEMPLATE, '', '【被审产出】', content]
  const prevIssues = prev && Array.isArray(prev.issues) ? prev.issues : []
  if (prevIssues.length > 0) {
    parts.push(
      '',
      '【上一轮已发现的问题（请对照复核）】',
      JSON.stringify(prevIssues, null, 2),
      '已解决的不必重复罗列；仍未解决的请确认，并补充新发现的问题。',
    )
  }
  parts.push('', '只输出一个 JSON 对象，不要输出额外解释。')
  return parts.join('\n')
}

// 跑一轮 codex exec：与 /task 同配置（--ephemeral、stdin ignore、env 注入），
// 但返回同步可见的 child 句柄（立即可被 cancel SIGTERM）+ 等待退出码的 promise。
function spawnReviewRound({ prompt, workdir, envKey, apiKey, outPath }) {
  // 与 /task 同改：提示词走 stdin（'-' 占位），argv 不携带正文，免疫 pkill -f 误杀父进程。
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-o', outPath, '-']
  const child = spawn('codex', args, {
    cwd: workdir,
    env: { ...process.env, [envKey]: apiKey },
    // stdin 写入提示词后 end()，EOF 自然到达。
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // stdin EPIPE 兜底：codex 早退后写 stdin 触发的是异步 error 事件，无监听器会击穿宿主进程。
  child.stdin?.on('error', () => { /* codex 已退出：exit/error 回调收尾 */ })
  child.stdin?.write(prompt)
  child.stdin?.end()
  // 同 handleTaskCreate：pipe 无人消费会被长输出塞满 → codex 写阻塞假死，必须持续排空。
  // 这里顺带**只留尾部 8KB**：既排空了管道，又能从尾巴上抽 codex 自报的 "tokens used"
  // —— 这是 token 硬预算的数据来源，**别改回 resume()**（那样就拿不到用量了）。
  let tail = ''
  const keepTail = (buf) => { tail = (tail + buf.toString()).slice(-8192) }
  child.stdout?.on('data', keepTail)
  child.stderr?.on('data', keepTail)
  const wait = new Promise((resolve) => {
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      resolve(Number.isInteger(code) ? code : -1)
    }
    child.on('exit', (code) => done(code))
    // spawn 失败（二进制缺失等）不触发 exit，这里兜底。
    child.on('error', () => done(-1))
  })
  return { child, wait, getUsage: () => parseTokensUsed(tail) }
}

// 读一轮的 -o 输出并删除文件（逐轮清理，不把中间产物留在 ~/.codex）。
function readReviewOut(outPath) {
  let text = ''
  try { text = readFileSync(outPath, 'utf8') } catch { text = '' }
  try { unlinkSync(outPath) } catch { /* 文件可能没生成，忽略 */ }
  return text
}

// 从 codex exec 输出尾部抽 "tokens used\nN"（codex 自报的累计用量）。
// 抽不到返回 0 —— 宁可少算也不误停（硬预算语义是"到量才停"，不是"猜一个"）。
function parseTokensUsed(text) {
  if (typeof text !== 'string' || text === '') return 0
  const m = /tokens used\s*\n?\s*([\d,]+)/i.exec(text)
  if (m === null) return 0
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 振荡检测用的稳定指纹：只取 issues 的三个语义字段，排序后哈希（顺序无关）。
// 两个 AI 在「主张 X / 反对 X」之间来回时，同一批 issues 会原样回来 → 命中即判循环。
function issuesHash(issues) {
  const norm = (Array.isArray(issues) ? issues : []).map((i) => [
    String(i?.severity ?? '').trim(),
    String(i?.point ?? '').trim(),
    String(i?.suggestion ?? '').trim(),
  ])
  norm.sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1))
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16)
}

// 服务层自动循环：每轮 spawn → 解析 → 按 issues/轮数推进，cancelled 即熔断。
async function runReview(task, active) {
  const envKey = `${active.id.toUpperCase()}_API_KEY`
  // 硬预算（2026-10-03 补）：墙钟与累计 token 任一先到即停。
  // "无新增即收敛"降级为**提前停止的一种**，不再是唯一终止条件。
  const wallMs = Number.isFinite(task.wallMs) && task.wallMs >= REVIEW_MIN_WALL_MS ? task.wallMs : REVIEW_DEFAULT_WALL_MS
  const tokenLimit = Number.isFinite(task.tokenLimit) && task.tokenLimit >= REVIEW_MIN_TOKEN_LIMIT ? task.tokenLimit : REVIEW_DEFAULT_TOKEN_LIMIT
  const startedAt = Date.now()
  const seenHashes = new Map()   // issuesHash → round，振荡检测用
  let tokensUsed = 0
  try {
    for (;;) {
      if (task.status === 'cancelled' || task.cancelled === true) break
      const round = task.rounds.length + 1
      if (round > task.maxRounds) break
      task.round = round
      // ── 进轮前先判硬预算（第一轮不拦：连一轮都没跑就停没有意义）──
      if (round > 1) {
        if (Date.now() - startedAt >= wallMs) {
          task.stopReason = 'wallclock'
          finalizeReview(task, 'done', 'wallclock')
          void notifyTask(task)
          return
        }
        if (tokensUsed >= tokenLimit) {
          task.stopReason = 'tokens'
          finalizeReview(task, 'done', 'tokens')
          void notifyTask(task)
          return
        }
      }
      const prev = task.rounds.length > 0 ? task.rounds[task.rounds.length - 1] : null
      const prompt = buildReviewPrompt(task.content, prev)
      const outPath = join(CODEX_DIR, `review-${task.id}-r${round}.out`)
      task.outPath = outPath
      // 新一轮：重置活动时间，看门狗从本轮 spawn 起算 300s。
      task.activityAt = Date.now()
      const { child, wait, getUsage } = spawnReviewRound({ prompt, workdir: task.workdir, envKey, apiKey: active.apiKey, outPath })
      task.child = child
      // 互审的探活身份：startWatchdog 在首轮 spawn 前就启动（那时 child 还是 null）记不到
      // pid —— 每轮 spawn 后补记；轮间空窗（child 已退、下一轮未起）清掉，
      // 否则对账 tick 会把已退出的旧 pid 误判成失联、误杀多轮复核。
      task.childPid = Number.isInteger(child.pid) ? child.pid : null
      task.childStart = task.childPid === null ? null : readProcStartTime(task.childPid)
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
      }
      const code = await wait
      if (wallTimer !== null) clearTimeout(wallTimer)
      // 本轮 codex 自报用量累加进总账（抽不到记 0 —— 宁可少算也不误停）。
      tokensUsed += getUsage()
      task.child = null
      task.childPid = null
      task.childStart = null
      task.exitCode = task.cancelled === true ? -1 : code
      const raw = readReviewOut(outPath)
      // 墙钟到点被强杀：按 wallclock 正常收尾（而非落进下面的 unparsed 解析失败分支）。
      if (task.wallHit === true) {
        task.stopReason = 'wallclock'
        finalizeReview(task, 'done', 'wallclock')
        void notifyTask(task)
        return
      }
      if (task.status === 'cancelled' || task.cancelled === true) break
      const parsed = parseReviewJson(raw)
      if (!parsed.ok) {
        task.rounds.push({ round, issues: [], verdict: 'unparsed', raw: parsed.raw })
        finalizeReview(task, 'error', 'unparsed', code === 0 ? '未能从复核输出解析出 JSON' : `codex 退出码 ${code}`)
        void notifyTask(task)
        return
      }
      // issues 为空 → 本轮即收敛；否则记下本轮结论供下一轮对照。
      task.rounds.push({
        round,
        issues: parsed.issues,
        verdict: parsed.issues.length === 0 ? 'converged' : parsed.verdict,
      })
      if (parsed.issues.length === 0) {
        task.stopReason = 'converged'
        finalizeReview(task, 'done', 'converged')
        void notifyTask(task)
        return
      }
      // ── 振荡检测：本轮 issues 与历史某轮完全一致 → 判循环、立即停 ──
      const h = issuesHash(parsed.issues)
      if (seenHashes.has(h)) {
        task.stopReason = 'loop'
        task.loopWithRound = seenHashes.get(h)
        finalizeReview(task, 'done', `loop(与第 ${seenHashes.get(h)} 轮相同)`)
        void notifyTask(task)
        return
      }
      seenHashes.set(h, round)
      if (round >= task.maxRounds) {
        // 轮数用尽仍有问题：最后一轮 issues 已在 rounds 里，打包交用户裁决。
        task.stopReason = 'rounds'
        finalizeReview(task, 'done', 'max-rounds')
        void notifyTask(task)
        return
      }
    }
    // 走到这里只可能是被取消（cancelled → 熔断退出）。
    task.stopReason = 'cancelled'
    finalizeReview(task, 'cancelled', 'cancelled')
  } catch (e) {
    finalizeReview(task, 'error', 'error', errMsg(e))
    void notifyTask(task)
  }
}

// POST /review：body { content, rounds? }。立刻返回 { ok, id }，服务层后台自动循环。
async function handleReviewCreate(req, res) {
  try {
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
    // 复核不接用户 workdir：默认工单目录不在时退回 ~/.codex（codex exec 需要一个存在的 cwd）。
    const workdir = existsSync(DEFAULT_TASK_WORKDIR) ? DEFAULT_TASK_WORKDIR : CODEX_DIR
    mkdirSync(CODEX_DIR, { recursive: true })

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
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      workdir,
      child: null,
      outPath: '',
      cancelled: false,
      stuckSuspect: false,
      // 硬预算（可由配置覆盖）—— runReview 里再用缺省值兜底。
      wallMs: doc.reviewWallMs,
      tokenLimit: doc.reviewTokenLimit,
    }
    tasks.set(id, task)
    pruneTasks()
    startWatchdog(task)
    void runReview(task, active)
    send(res, { ok: true, id, maxRounds })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// POST /review/cancel：body { id }。置 cancelled（熔断），子进程活着则 SIGTERM。
async function handleReviewCancel(req, res) {
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
    task.cancelled = true
    task.status = 'cancelled'
    task.verdict = 'cancelled'
    const child = task.child
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
    send(res, { ok: true, id, status: task.status })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/task 同 path 两个方法：POST 下发 / GET 查询，其余 405。
async function handleTaskRoot(req, res) {
  if (req.method === 'POST') return handleTaskCreate(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleTaskGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// ── /config：插件配置（复核轮数 + 协作两位）──
// reviewRounds 真值在 keyring 顶层：loadKeyring 归一化、saveKeyring 落盘 0600；
// 协作两位真值在 ~/.dsh/second-engine-collab.txt（./collab.js），POST 任意子集即可。
async function handleConfigGet(_req, res) {
  try {
    const doc = loadKeyring()
    send(res, { ok: true, reviewRounds: doc.reviewRounds, roundsChoices: REVIEW_ROUNDS_CHOICES, reviewWallMs: doc.reviewWallMs, reviewTokenLimit: doc.reviewTokenLimit, wallMsMin: REVIEW_MIN_WALL_MS, tokenLimitMin: REVIEW_MIN_TOKEN_LIMIT, collab: collabStatus() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleConfigSet(req, res) {
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
    if (rounds === null && wallMs === null && tokenLimit === null && collabBits === null) {
      return send(res, { ok: false, error: '没给任何可设置字段（reviewRounds / preset / voice+longtask）' }, 400)
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
    send(res, {
      ok: true,
      reviewRounds: doc.reviewRounds,
      reviewWallMs: doc.reviewWallMs,
      reviewTokenLimit: doc.reviewTokenLimit,
      collab: collabStatus(),
      ...(agentsWritten !== null ? { agentsWritten } : {}),
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/config 同 path 两个方法：GET 回显 / POST 保存，其余 405。
async function handleConfigRoot(req, res) {
  if (req.method === 'POST') return handleConfigSet(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleConfigGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
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

// GET /consults：全量列表（含 stuckContext，不脱敏），给主 AI 收卷用。
async function handleConsultsList(_req, res) {
  try {
    send(res, { ok: true, count: consults.length, limit: CONSULT_KEEP_LIMIT, consults: consults.slice() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── /websearch：原生联网搜索开关（config.toml 顶层 web_search）──
// GET 回显当前档位（无字段 → disabled）；POST 写入，非法档位 400。
async function handleWebSearchGet(_req, res) {
  try { send(res, { ok: true, value: readWebSearch() }) }
  catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleWebSearchSet(req, res) {
  try {
    const body = await readBody(req)
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    if (!WEB_SEARCH_MODES.includes(value)) {
      return send(res, { ok: false, error: `value 只支持 ${WEB_SEARCH_MODES.join(' / ')}` }, 400)
    }
    writeTopLevelString('web_search', value)
    send(res, { ok: true, value })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// /api/websearch 同 path 两个方法：GET 回显 / POST 保存，其余 405。
async function handleWebSearchRoot(req, res) {
  if (req.method === 'POST') return handleWebSearchSet(req, res)
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return handleWebSearchGet(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// ── /mcp：MCP 服务器增删查（config.toml 的 [mcp_servers.*] 段）──
// 注册为 prefix 路由（'prefix' 同时命中 /mcp 与 /mcp/<name>），按方法+子路径分发。
const MCP_ROUTE_PREFIX = '/second-engine/api/mcp'

// 新增返回 false 表示重名（handler 据此回 409，不做覆盖）。
function handleMcpList(_req, res) {
  try { send(res, { ok: true, servers: listMcpServers() }) }
  catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleMcpAdd(req, res) {
  try {
    const body = await readBody(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (name === '') return send(res, { ok: false, error: 'name 不能为空' }, 400)
    if (!MCP_NAME_PATTERN.test(name)) {
      return send(res, { ok: false, error: 'name 只允许字母、数字、下划线和连字符' }, 400)
    }
    if (!/^https?:\/\//.test(url)) {
      return send(res, { ok: false, error: 'url 必须以 http:// 或 https:// 开头' }, 400)
    }
    if (listMcpServers().some((s) => s.name === name)) {
      return send(res, { ok: false, error: `已存在同名 MCP 服务器 '${name}'` }, 409)
    }
    addMcpServer(name, url)
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

function handleMcpDelete(res, name) {
  try {
    if (name === '' || !removeMcpServer(name)) {
      return send(res, { ok: false, error: `未找到 MCP 服务器 '${name}'` }, 404)
    }
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 启用/禁用（保留配置段，不删除）：POST /mcp/<name> { enabled: bool }
// 依据 Codex 官方字段 [mcp_servers.*] enabled = true|false；禁用后新会话不再连接它。
async function handleMcpToggle(req, res, name) {
  try {
    const body = await readBody(req)
    if (typeof body.enabled !== 'boolean') {
      return send(res, { ok: false, error: 'enabled 必须是布尔值' }, 400)
    }
    if (name === '' || !setMcpServerEnabled(name, body.enabled)) {
      return send(res, { ok: false, error: `未找到 MCP 服务器 '${name}'` }, 404)
    }
    send(res, { ok: true, servers: listMcpServers() })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// prefix 分发：'' → GET 列表 / POST 新增；'/<name>' → DELETE 删除 / POST 启用·禁用。
async function handleMcpRoot(req, res) {
  // 防御：req.url 非法（如 '*'）时 new URL 抛 TypeError —— 本函数是 async，
  // 不接住就是 unhandledRejection（queryParam 对同样操作包了 try/catch，这里补齐）。
  let pathname = ''
  try {
    pathname = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1').pathname
  } catch {
    return send(res, { ok: false, error: 'bad request url' }, 400)
  }
  const rest = pathname.slice(MCP_ROUTE_PREFIX.length)
  const method = req.method === undefined ? 'GET' : req.method
  if (rest !== '' && rest !== '/') {
    let name = rest.replace(/^\//, '')
    try { name = decodeURIComponent(name) } catch { /* 非法百分号编码：按原文处理 */ }
    if (method === 'DELETE') return handleMcpDelete(res, name)
    if (method === 'POST') return handleMcpToggle(req, res, name)
    return send(res, { ok: false, error: 'not found' }, 404)
  }
  if (method === 'POST') return handleMcpAdd(req, res)
  if (method === 'GET' || method === 'HEAD') return handleMcpList(req, res)
  return send(res, { ok: false, error: 'method not allowed' }, 405)
}

// ── /version：版本检查 ──
// 本机 `codex --version` 与 GitHub 最新 release 对比。远端结果做模块级缓存 60 分钟：
// 设置页会反复刷新，匿名调用 api.github.com 的配额经不起每次请求都打一次。
const CODEX_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest'
const VERSION_FETCH_TIMEOUT_MS = 15000
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000
let latestVersionCache = { at: 0, version: '' }

// 取首个 x.y.z：'codex-cli 0.155.1'、'OpenAI Codex v0.155.1'、'v0.156.0' 都能吃。
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text === undefined || text === null ? '' : text))
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`
}

// 三段数字比较：a>b → 1，a<b → -1，相等或任一侧不可解析 → 0。
function compareVersions(a, b) {
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
      execFile('codex', ['--version'], { timeout: 8000 }, (_err, stdout, stderr) => {
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

// GET /version：{ current, latest, updateAvailable }。
// GitHub 不可达（离线/限流）不算失败：本机版本照回，原因放 error。
async function handleVersion(_req, res) {
  try {
    const current = await localCodexVersion()
    let latest = ''
    let error = ''
    try { latest = await latestCodexVersion() } catch (e) { error = errMsg(e) }
    const payload = {
      ok: true,
      current: current === null ? '' : current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
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
function ownPluginVersion() {
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
async function latestPluginVersion() {
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

// GET /plugin-version：{ current, latest, updateAvailable, htmlUrl, checkedAt }。
async function handlePluginVersion(_req, res) {
  const current = ownPluginVersion()
  try {
    const hit = await latestPluginVersion()
    send(res, {
      ok: true,
      current,
      latest: hit.latest,
      updateAvailable: compareVersions(hit.latest, current) > 0,
      htmlUrl: hit.htmlUrl,
      checkedAt: hit.at,
    })
  } catch {
    // 离线/限流 = 「当没有更新」，不带 error —— 静默是本端点的语义
    send(res, { ok: true, current, latest: '', updateAvailable: false, checkedAt: Date.now() })
  }
}

export function apply(ctx) {
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
  try {
    ctx.effect(() => stopReconcileTick, 'second-engine: reconcile tick teardown')
  } catch {
    try { process.on('exit', stopReconcileTick) } catch { /* best effort */ }
  }

  // 设置页 API：webServer 后挂载时也能注册；无 webServer 的 profile 自然不注册。
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/second-engine/api/status', handler: handleStatus },
      { kind: 'exact', path: '/second-engine/api/providers', handler: handleProvidersRoot },
      { kind: 'exact', path: '/second-engine/api/providers/key', handler: handleProviderKey },
      { kind: 'exact', path: '/second-engine/api/providers/active', handler: handleProviderActive },
      { kind: 'exact', path: '/second-engine/api/providers/delete', handler: handleProviderDelete },
      { kind: 'exact', path: '/second-engine/api/providers/update', handler: handleProviderUpdate },
      { kind: 'exact', path: '/second-engine/api/models', handler: handleModels },
      { kind: 'exact', path: '/second-engine/api/model', handler: handleProviderModel },
      { kind: 'exact', path: '/second-engine/api/key', handler: handleKey },
      { kind: 'exact', path: '/second-engine/api/cleanup', handler: handleCleanup },
      { kind: 'exact', path: '/second-engine/api/task', handler: handleTaskRoot },
      { kind: 'exact', path: '/second-engine/api/tasks', handler: handleTaskList },
      { kind: 'exact', path: '/second-engine/api/task/cancel', handler: handleTaskCancel },
      { kind: 'exact', path: '/second-engine/api/review', handler: handleReviewCreate },
      { kind: 'exact', path: '/second-engine/api/review/cancel', handler: handleReviewCancel },
      { kind: 'exact', path: '/second-engine/api/config', handler: handleConfigRoot },
      { kind: 'exact', path: '/second-engine/api/consult', handler: handleConsultCreate },
      { kind: 'exact', path: '/second-engine/api/consults', handler: handleConsultsList },
      { kind: 'exact', path: '/second-engine/api/version', handler: handleVersion },
      { kind: 'exact', path: '/second-engine/api/plugin-version', handler: handlePluginVersion },
      { kind: 'exact', path: '/second-engine/api/websearch', handler: handleWebSearchRoot },
      // prefix：'prefix' 同时命中 /mcp 与 /mcp/<name>，DELETE 的名字从 URL 尾巴取。
      { kind: 'prefix', path: '/second-engine/api/mcp', handler: handleMcpRoot },
    ]
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

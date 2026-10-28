// 引擎注册表（P4.2，2026-10-28）
//
// 为什么需要它：P3 把「公共代码直读引擎字段」归零之后，接一个新引擎只剩两个动作 ——
//   ① 在 ENGINES 里登记一个 create()
//   ② handleTaskCreate 里按 engine 起进程
// 面板按 capabilities 决定显示什么（哪些卡片隐藏），不做引擎品牌分支。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createRuntime } from './runtime.js'
import { createPiRpcRuntime } from './pi-rpc-runtime.js'

/** 当前引擎落在 ~/.dsh/second-engine-engine.txt（一行引擎 id）；不存在 = codex。 */
export const ENGINE_FILE = join(homedir(), '.dsh', 'second-engine-engine.txt')

/**
 * 清理目标（P4.24，2026-10-29 契约 4.3）：清理范围**不写进 capabilities**，放这里按引擎登记。
 * 为什么单独一个表：`resume` 描述「能不能续会话」，与「删哪个目录的哪些文件」无因果关系，
 * 拿它当判据会把清理范围推错（v1 任务书 F5 就是这么写的，已作废）。
 * 形状与 docs/task-runtime-contract.md §二 的 CleanupTarget 一一对应；
 * 唯一出口是 engineView()，前端与 /status 都从这里读，禁止另抄一份。
 * 注意：这里只描述**会话记录**的清理范围；Codex 的 reviews / task-*.out 等过程产物由
 * handleCleanup（src/index.js:2492-2506）附带处理，口径以该函数实况为准。
 */
export const CLEANUP_TARGETS = {
  codex: {
    dir: join(homedir(), '.codex', 'sessions'),
    filePattern: '*.jsonl',
    appliesToEngine: 'codex',
    confirmRequired: false,
  },
  pi: {
    dir: join(homedir(), '.pi', 'agent', 'sessions'),
    filePattern: '*.jsonl',
    appliesToEngine: 'pi',
    confirmRequired: true,   // POST /api/pi-cleanup 要求 body.confirm === true
  },
}

export const ENGINES = {
  codex: {
    id: 'codex',
    label: 'Codex',
    create: createRuntime,
    capabilities: {
      eventStream: 'fine',        // appserver 有流式进度；exec 无（同一引擎两种传输）
      approvals: false,
      resume: true,               // codex exec resume <uuid>
      review: true,               // 互审硬绑 codex exec
      chatBridge: true,           // 用户可用 Web 聊天桥（语义＝能不能用，不是怎么实现）
      chatBridgeMode: 'app-server', // 实现模式：连已在跑的 app-server（bridge/web/ctl.sh）
      modelSwitch: 'config-file', // 重写 config.toml + 重启
      versionCheck: 'github',     // GitHub release
      mcp: 'config-toml',         // MCP 落 ~/.codex/config.toml 的 [mcp_servers.*]
      webSearch: true,            // config.toml 顶层 web_search 开关可用
    },
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    create: createPiRpcRuntime,
    capabilities: {
      eventStream: 'fine',         // 15 种 JSONL 事件
      approvals: false,            // extension_ui_request 暂无人应答
      resume: false,               // 未接 --session / fork
      review: false,               // 无互审实现
      // P4.24（2026-10-29 契约 4.1）：原值 false，注释写「自带 15+ provider，不需要桥」——
      // 那说的是**实现形态**，不是**用户能不能用**。Pi 桥实际可用：
      //   src/bridge-routes.js:7 import pi bridge lifecycle；:143-183 按 activeEngineId()==='pi' 分流；
      //   src/engine/pi-bridge.js:28 spawn bridge/pi/server.mjs（默认 8788）。
      // 按旧语义隐藏桥卡会把一个能用的功能藏起来 ⇒ 改 true，形态差异挪到 chatBridgeMode。
      chatBridge: true,
      chatBridgeMode: 'pi-rpc',    // 自建 pi --mode rpc 子进程，不做协议翻译
      modelSwitch: 'runtime-command', // RPC set_model，运行时切换
      versionCheck: 'npm',         // npm registry
      mcp: 'pi-config',            // MCP 落 ~/.pi/agent/mcp.json（index.js:4587-4600 已映射成 Codex 形状）
      webSearch: false,            // Pi 无 web_search 开关：GET 如实回 disabled，写入 400（index.js:4557-4567）
    },
  },
}

export function activeEngineId() {
  try {
    const v = readFileSync(ENGINE_FILE, 'utf8').trim()
    if (v !== '' && ENGINES[v] !== undefined) return v
  } catch { /* 文件不存在 = 默认 codex */ }
  return 'codex'
}

export function setActiveEngineId(id) {
  if (ENGINES[id] === undefined) throw new Error(`未知引擎：${id}`)
  mkdirSync(dirname(ENGINE_FILE), { recursive: true })
  writeFileSync(ENGINE_FILE, `${id}\n`, 'utf8')
  return id
}

/** 按 task.engine 选；任务没标引擎时用当前激活的。 */
export function engineOf(task) {
  const id = task !== null && task !== undefined && typeof task.engine === 'string' && task.engine !== ''
    ? task.engine
    : activeEngineId()
  return ENGINES[id] ?? ENGINES.codex
}

/** 该引擎的清理目标（未登记 → null，调用方如实留空，不猜）。 */
export function cleanupTarget(id) {
  return CLEANUP_TARGETS[id] ?? null
}

/** 给面板/API 用的引擎清单（不含 create，函数不可序列化）。 */
export function engineList() {
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, capabilities: e.capabilities }))
}

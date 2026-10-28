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
      chatBridge: true,           // Responses↔chat 翻译桥
      modelSwitch: 'config-file', // 重写 config.toml + 重启
      versionCheck: 'github',     // GitHub release
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
      chatBridge: false,           // 自带 15+ provider，不需要桥
      modelSwitch: 'runtime-command', // RPC set_model，运行时切换
      versionCheck: 'npm',         // npm registry
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

/** 给面板/API 用的引擎清单（不含 create，函数不可序列化）。 */
export function engineList() {
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, capabilities: e.capabilities }))
}

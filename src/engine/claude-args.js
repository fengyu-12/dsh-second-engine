// src/engine/claude-args.js —— Claude Code 命令行参数构造（2026-11-05 新增）
//
// 参数决策全部集中在这里，有实测依据的写进注释，**runtime 不自己拼参数**。
// 拆出来是为了让"为什么是这个参数"只有一个地方可查。

import { claudeMcpConfigPath } from '../claude-mcp.js'

/** 默认工具白名单：只放执行类，掐掉编排类（Task / Workflow / Cron 系列 / SendMessage / ListAgents）。 */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash']

/**
 * 构造 `claude` 的参数数组。
 *
 * ⚠️ 三条实测约束（2026-11-05）：
 *   · `--permission-mode bypassPermissions` 在 **root 下被直接拒绝**
 *     （`cannot be used with root/sudo privileges`）⇒ 只能用 `acceptEdits`
 *   · `--output-format stream-json` **必须配 `--verbose`**，否则报错
 *   · `--add-dir` 只授予访问权限、**不改变 cwd**（实测 pwd 仍是 `/`）⇒ 提示词里要写绝对路径
 */
export function buildArgs(spec = {}) {
  const args = [
    '-p', str(spec.prompt),
    '--model', str(spec.model) || 'haiku',
    '--permission-mode', str(spec.permissionMode) || 'acceptEdits',
    '--allowedTools', normalizeTools(spec.allowedTools),
  ]
  // --mcp-config 是变长参数（<configs...>），会吞掉后面所有非 flag 值；
  // 所以必须紧跟一个 flag（下面的 --output-format），不能放在数组末尾。
  // 文件不存在就整段不加：不配 MCP 的人不该挂一个空/缺失的配置文件。
  const mcpPath = claudeMcpConfigPath()
  if (mcpPath !== null) args.push('--mcp-config', mcpPath)
  args.push('--output-format', 'stream-json', '--verbose')
  const workdir = str(spec.workdir)
  if (workdir !== '') args.push('--add-dir', workdir)
  const maxTurns = int(spec.maxTurns)
  if (maxTurns !== null) args.push('--max-turns', String(maxTurns))
  const maxBudget = numOf(spec.maxBudgetUsd)
  if (maxBudget !== null) args.push('--max-budget-usd', String(maxBudget))
  const extra = Array.isArray(spec.extraArgs) ? spec.extraArgs : []
  for (const a of extra) if (typeof a === 'string' && a !== '') args.push(a)
  return args
}

function normalizeTools(v) {
  const list = Array.isArray(v) && v.length > 0 ? v : DEFAULT_ALLOWED_TOOLS
  return list.filter((x) => typeof x === 'string' && x !== '').join(',')
}

function str(v) { return typeof v === 'string' ? v : '' }
function int(v) { return Number.isInteger(v) ? v : null }
function numOf(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }

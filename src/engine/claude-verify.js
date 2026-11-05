import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function hasGitChanges(workdir) {
  if (typeof workdir !== 'string' || workdir === '') return false
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() !== ''
  } catch {
    return false
  }
}

// 递归扫描（跳过 node_modules / .git，最多 2000 条）：
// 原实现只扫 workdir 顶层，workdir 不是 git 仓库时（如 ~/claude-workspace），
// Claude 写进子目录就会被误判成「无外部产物」。
function hasNewFile(workdir, startedAt) {
  if (typeof workdir !== 'string' || workdir === '' || !Number.isFinite(startedAt)) return false
  const stack = [workdir]
  let seen = 0
  while (stack.length && seen < 2000) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      seen += 1
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(p); continue }
      if (!entry.isFile()) continue
      try { if (statSync(p).mtimeMs > startedAt) return true } catch { /* 并发消失 */ }
    }
  }
  return false
}

export function verifyClaudeEffect(task) {
  if (task?.engine !== 'claude') return { ok: true, reason: '', evidence: {} }
  const output = typeof task.output === 'string' ? task.output : ''
  const startedAt = Number(task.startedAt ?? task.createdAt)
  const evidence = {
    gitChanges: hasGitChanges(task.workdir),
    newFile: hasNewFile(task.workdir, startedAt),
    toolPair: /tool_use/.test(output) && /tool_result/.test(output)
  }
  if (evidence.gitChanges || evidence.newFile || evidence.toolPair || task.exitCode !== 0) {
    return { ok: true, reason: '', evidence }
  }
  return { ok: false, reason: 'claude 无外部产物', evidence: {} }
}

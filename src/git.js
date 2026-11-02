import { execFile } from 'node:child_process'
// ── #6（2026-10-25）：复核窗口的工作区证据 ──
// 能力边界（如实）：两次 git status 快照的差集只能证明「复核窗口内新变脏的路径」，
// 归因不了写入者（主 AI 并行写、review 进程写、git 自身残留都会计入）；起点已脏的
// 路径天然被排除，不会把复核前就存在的未提交改动记到复核头上。所以字段叫
// reviewDirty（证据），不叫 scopeViolation（裁决），也不参与任何状态判定。
export function gitPorcelain(workdir) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['status', '--porcelain'], { cwd: workdir, timeout: 20000 }, (err, stdout) => {
        if (err !== null) { resolve(null); return }
        const out = []
        for (const line of String(stdout).split('\n')) {
          const row = line.trimEnd()
          if (row === '') continue
          let pathPart = row.slice(3).trim()
          if (pathPart.startsWith('"') && pathPart.endsWith('"')) pathPart = pathPart.slice(1, -1)
          const arrow = pathPart.indexOf(' -> ')
          if (arrow !== -1) {
            out.push(pathPart.slice(0, arrow), pathPart.slice(arrow + 4))
          } else {
            out.push(pathPart)
          }
        }
        resolve(out)
      })
    } catch { resolve(null) }
  })
}

// spawn 前给没有版本控制的 workdir 打一个基线提交：Codex 在无 .git 的目录里
// diff / 回滚都无从下手。幂等（已有 .git 直接跳过）、静默（git 缺失或提交失败都不阻断工单）。
// 提交身份：本机实证 root 无 ~/.gitconfig（`git commit` 报 Author identity unknown），
// 那样基线只剩 .git + 暂存区、等于没打成，所以缺身份时用 env 兜底（不覆盖宿主已配的身份）。
// git 全部走异步 execFile（带超时）：execSync 在大目录下可把整个 Web 宿主卡住
// 数秒到分钟级（期间全部 HTTP 请求、看门狗、对账 tick 停摆）。退出码 0 → true。
export function gitOk(args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { timeout: 60000, ...opts }, (err) => { resolve(err === null) })
    } catch { resolve(false) }
  })
}

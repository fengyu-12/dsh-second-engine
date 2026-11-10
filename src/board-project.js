import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 与 src/index.js 的 boardDir() 保持同一解析顺序（DUAL_BOARD_DIR > ~/proj/dual-board）。
// 2026-11-10 修：Codex 首版把路径硬编码成 /root/proj/dual-board/board.json，
// 会让 DUAL_BOARD_DIR 覆盖失效，也与 runBoardAutoCleanup 的 boardDir 参数不一致。
const boardDir = () => process.env.DUAL_BOARD_DIR || join(homedir(), 'proj', 'dual-board')

// 只投影不改原板：旧任务没有 engine，必须借角色配置还原归属供 UI 分组。
export function projectBoard(board) {
  const tasks = (Array.isArray(board?.tasks) ? board.tasks : []).map((task) => ({
    ...task, engine: task.engine || board?.roles?.[task.owner]?.engine || null,
  }))
  const done = (task) => task.status === 'completed' || task.status === 'abandoned'
  const dependent = (task) => Boolean(task.blocked_by?.length)
  // 与 board.sh ready 同语义（2026-11-10 定）：completed 与 abandoned 都算「已了结」。
  // abandon 是放弃不是完成，但不解锁会让下游永久 blocked；缺前置产出的风险由派单方承担。
  const resolved = new Set(tasks.filter(done).map((task) => task.id))
  // 派生集合只放 id，避免让调用方误把集合当作另一份可写任务真值。
  return {
    ok: true,
    board: { revision: board?.revision ?? 0, tasks },
    ready: tasks.filter((t) => ['pending', 'blocked'].includes(t.status) && (t.blocked_by || []).every((id) => resolved.has(id))).map((t) => t.id),
    blocked: tasks.filter((t) => !done(t) && (t.status === 'blocked' || dependent(t))).map((t) => t.id),
    done: tasks.filter(done).map((t) => t.id),
  }
}

export async function handleBoard(req, res) {
  const reply = (body, status) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET') return reply({ ok: false, error: 'method not allowed, use GET' }, 405)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const board = JSON.parse(await readFile(join(boardDir(), 'board.json'), 'utf8'))
      if (!board || typeof board !== 'object' || !Array.isArray(board.tasks)) throw new Error('invalid board schema')
      return reply(projectBoard(board), 200)
    } catch (error) {
      // 原子替换不需要写锁；解析失败重新打开一次，避免偶发坏快照使请求崩溃。
      if (attempt === 0 && error instanceof SyntaxError) continue
      return reply({ ok: false, error: error.message || String(error) }, 404)
    }
  }
}

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTarget } from './registry.js'
import { readBody } from '../io.js'

const DEFAULT_KEEP_DAYS = 7

function send(res, body, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// Claude 的会话是**两层**：~/.claude/projects/<cwd 编码>/*.jsonl。
// 只扫顶层会得到 count=0（2026-11-06 实测：45 个文件、6.3 MB 全在子目录里，
// 而设置卡显示「0 个 / 0 B」）。所以统计与删除都递归。
function listSessions(dir) {
  const out = []
  if (typeof dir !== 'string' || dir === '') return out
  let names = []
  try { names = readdirSync(dir, { recursive: true }) } catch { return out }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.jsonl')) continue
    const full = join(dir, name)
    try {
      const info = statSync(full)
      if (info.isFile()) out.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
    } catch { /* 并发消失 */ }
  }
  return out
}

export async function handleClaudeCleanup(req, res) {
  try {
    const target = cleanupTarget('claude')
    const dir = process.env.NODE_ENV === 'test' && process.env.CLAUDE_CLEANUP_DIR
      ? process.env.CLAUDE_CLEANUP_DIR
      : (target ? target.dir : '')
    if (req.method === 'GET') {
      const files = listSessions(dir)
      return send(res, {
        ok: true,
        dir,
        count: files.length,
        bytes: files.reduce((a, f) => a + f.size, 0),
        keepDays: DEFAULT_KEEP_DAYS,
      })
    }
    const body = await readBody(req)
    if (body.confirm !== true) {
      return send(res, { ok: false, error: '需要明确确认后才能清理 Claude 会话记录' }, 400)
    }
    const keepDays = body.keepDays === undefined ? DEFAULT_KEEP_DAYS : Number(body.keepDays)
    if (!Number.isFinite(keepDays) || keepDays < 0) {
      return send(res, { ok: false, error: 'keepDays 必须是非负数字' }, 400)
    }
    if (!target) return send(res, { ok: false, error: '未配置 Claude 会话清理目标' }, 500)
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const stats = { deleted: 0, bytes: 0, kept: 0 }
    for (const f of listSessions(dir)) {
      if (f.mtimeMs >= cutoff) { stats.kept += 1; continue }
      try {
        unlinkSync(f.path)
        stats.deleted += 1
        stats.bytes += f.size
      } catch { /* 并发消失或不可访问 */ }
    }
    return send(res, { ok: true, dir, ...stats })
  } catch (error) {
    return send(res, { ok: false, error: error && error.message ? error.message : '清理失败' }, 500)
  }
}

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const AUDIT_RETENTION_DAYS = 30
export const DISPATCH_RETENTION_DAYS = 30
export const ARCHIVE_RETENTION_DAYS = 30
export const UNREAD_INBOX_MAX_DAYS = 7
export const CHANNEL_KEEP = 20
const DAY_MS = 86400000

function ageMs(path, now) {
  return now - statSync(path).mtimeMs
}
function within(root, paths) {
  return paths.map(p => resolve(root, p)).filter(p => p.startsWith(resolve(root) + '/'))
}
async function commitBeforeDelete(root, relPaths, date) {
  const paths = within(root, relPaths)
  if (!paths.length) throw new Error('refusing paths outside repository')
  await execFileAsync('git', ['-C', root, 'add', '--', ...paths], { timeout: 30000 })
  // 带 pathspec 的 commit：只提交这些路径，**不会**把索引里其它已暂存内容一起提交。
  // （2026-11-07 修：原写法是裸 commit，工作树里有别人 staged 的改动时会被裹进这次清理提交。）
  await execFileAsync('git', ['-C', root, 'commit', '--allow-empty', '-m', `board: auto-cleanup before prune ${date}`, '--', ...paths], { timeout: 30000 })
}
async function attempt(summary, label, action) {
  try { await action(); summary.actions.push(label) }
  catch (e) { summary.errors.push(`${label}: ${e.message}`) }
}

export async function runBoardAutoCleanup({ boardDir, boardScript, now = Date.now() }) {
  const dir = resolve(boardDir)
  const root = resolve(dir, '..')
  const summary = { at: new Date(now).toISOString(), policyVersion: 1, actions: [], skipped: [], errors: [], protected: ['board.json task states', 'proposals/'] }
  const date = summary.at.slice(0, 10)
  const call = async (...args) => execFileAsync('bash', [boardScript, ...args], { env: { ...process.env, DUAL_BOARD_DIR: dir }, timeout: 30000 })
  try {
    const board = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))
    summary.boardRevision = board.revision
  } catch (e) { summary.errors.push(`read board.json: ${e.message}`) }

  const auditDir = join(dir, 'audit')
  try {
    for (const name of readdirSync(auditDir)) {
      const path = join(auditDir, name)
      if (!/^completed-\d{4}-\d{2}\.jsonl$/.test(name) || ageMs(path, now) <= AUDIT_RETENTION_DAYS * DAY_MS) continue
      const rel = `dual-board/audit/${name}`
      await attempt(summary, `delete ${rel}`, async () => {
        await commitBeforeDelete(root, [rel], date)
        const { unlink } = await import('node:fs/promises'); await unlink(path)
      })
    }
  } catch (e) { summary.errors.push(`audit scan: ${e.message}`) }

  try {
    const notify = join(auditDir, 'notify.jsonl')
    if (existsSync(notify)) {
      const lines = readFileSync(notify, 'utf8').split(/(?<=\n)/)
      const cutoff = now - AUDIT_RETENTION_DAYS * DAY_MS
      const keep = lines.filter(line => {
        if (!line.trim()) return false
        try { return Date.parse(JSON.parse(line).at) >= cutoff } catch { return true }
      })
      if (keep.length !== lines.filter(l => l.trim()).length) {
        const rel = 'dual-board/audit/notify.jsonl'
        await attempt(summary, 'truncate audit/notify.jsonl', async () => {
          await commitBeforeDelete(root, [rel], date)
          writeFileSync(notify, keep.join(''))
        })
      }
    }
  } catch (e) { summary.errors.push(`notify scan: ${e.message}`) }

  try {
    const dispatchDir = join(dir, '.dispatch')
    for (const name of readdirSync(dispatchDir)) {
      const path = join(dispatchDir, name)
      if (!/^.+\.base$/.test(name) || ageMs(path, now) <= DISPATCH_RETENTION_DAYS * DAY_MS) continue
      const rel = `dual-board/.dispatch/${name}`
      await attempt(summary, `delete ${rel}`, async () => {
        await commitBeforeDelete(root, [rel], date)
        const { unlink } = await import('node:fs/promises'); await unlink(path)
      })
    }
  } catch (e) { summary.errors.push(`dispatch scan: ${e.message}`) }

  for (const who of ['lead', 'codex', 'pi', 'claude']) {
    const file = join(dir, `inbox-${who}.md`)
    if (!existsSync(file)) continue
    await attempt(summary, `archive inbox-${who}`, async () => {
      await call('inbox-archive', who, '--expire-unread-before', new Date(now - UNREAD_INBOX_MAX_DAYS * DAY_MS).toISOString())
    })
  }

  try {
    const channel = join(dir, 'channel.md')
    if (existsSync(channel)) {
      const month = summary.at.slice(0, 7)
      const target = join(dir, 'archive', `channel-${month}.md`)
      mkdirSync(join(dir, 'archive'), { recursive: true })
      await attempt(summary, `archive channel to archive/channel-${month}.md`, async () => {
        // 目标已存在时**追加**而不是覆盖：6 小时 tick 一天跑 4 次，覆盖会让同月第二次归档把上一条吞掉。
        const { appendFile, copyFile } = await import('node:fs/promises')
        if (existsSync(target)) await appendFile(target, '\n' + readFileSync(channel, 'utf8'))
        else await copyFile(channel, target)
        await call('channel-trim', '--keep', String(CHANNEL_KEEP))
      })
    }
  } catch (e) { summary.errors.push(`channel: ${e.message}`) }

  try {
    const archiveDir = join(dir, 'archive')
    for (const name of readdirSync(archiveDir)) {
      if (!/^(?:inbox-.+\.jsonl|tasks-.+\.jsonl|channel-.+\.md)$/.test(name)) continue
      const path = join(archiveDir, name)
      if (ageMs(path, now) <= ARCHIVE_RETENTION_DAYS * DAY_MS) continue
      const rel = `dual-board/archive/${name}`
      await attempt(summary, `delete ${rel}`, async () => {
        await commitBeforeDelete(root, [rel], date)
        const { unlink } = await import('node:fs/promises'); await unlink(path)
      })
    }
  } catch (e) { summary.errors.push(`archive scan: ${e.message}`) }

  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'auto-cleanup.last.json'), JSON.stringify(summary, null, 2) + '\n') }
  catch (e) { summary.errors.push(`status write: ${e.message}`) }
  return summary
}

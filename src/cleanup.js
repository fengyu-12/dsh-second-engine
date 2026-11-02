// cleanup.js —— 从 index.js 拆出的清理组（拆分交接见 split-brief.md）。
// 职责：按 mtime / 数量上限回收磁盘产物 —— Codex sessions 会话、Pi JSON 备份、
//       复核记录目录的数量截断，以及路径取 basename 的小工具。
// 函数体与常量值逐字来自 index.js（未改逻辑），只加了 export、import 与就近注释。
//
// 本模块是**叶子模块**：只依赖 node:fs / node:path / constants.js / io.js / state.js，
// 绝不 import index.js（循环依赖在 ESM 下拿不到 index.js 的绑定，见下）。
//
// 未搬（连同原因，见交付说明）：
//   · cleanupCodexLogs            —— 用户指定留到下一轮（依赖 codexProcessRunning / diskFreeBytes）。
//   · cleanupLiveFiles            —— 函数体内读 index.js 的模块态 `tasks`（跳过 running 任务）。
//   · cleanupReviewFiles          —— 同上，读 `tasks`。
//   · pruneTasks                  —— 整个函数就是 `tasks` 的封顶逻辑。
//   这三个的 `tasks` 依赖是硬阻塞：index.js 没有 export 它，而 cleanup.js → index.js
//   会构成循环 import。故本刀先把它们**依赖的共享态**落到 src/state.js（brief 目标布局里
//   本来就有这一格），函数体留在 index.js；下一轮把 `tasks` 全量迁到 state.js 后即可搬。
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CODEX_DIR } from './constants.js'
import { CONFIG_BACKUP_KEEP } from './io.js'
import { REVIEWS_DIR } from './state.js'


// ── Pi JSON 备份轮转（原 index.js L1977-1998）──
// Codex 侧早有这套：backupConfig() 按 CONFIG_BACKUP_NAME_RE 只认自己那套文件名，
// 排序后 slice 掉超出 CONFIG_BACKUP_KEEP 的旧份（:759-774）。Pi 侧这几个 JSON 之前
// 每次真写都留一份 .bak-<ts>，永远不清 → ~/.pi/agent 下无限增长。
// 这里复用同一个保留数，以及同一套「只按自己的文件名模式轮转」的纪律：
// 只匹配 ^<本文件名>\.bak- ，别的一律不碰（用户手放的备份、别的文件都安全）。
// 备份名是 <文件>.bak-<毫秒>-<pid>-<8hex>，时间戳定长在最前 → 字典序即时间序，sort() 就够。


export function baseNameOf(p) { const i = String(p).lastIndexOf('/'); return i === -1 ? String(p) : String(p).slice(i + 1) }

export const PI_BACKUP_KEEP = Number(process.env.DSH_PI_BACKUP_KEEP || CONFIG_BACKUP_KEEP)

export function prunePiBackups(path, keep = PI_BACKUP_KEEP) {
  const dir = dirname(path)
  const base = baseNameOf(path)
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-')
  const rolling = names.filter((n) => re.test(n)).sort()
  const removed = []
  for (const name of rolling.slice(0, Math.max(0, rolling.length - keep))) {
    try { unlinkSync(join(dir, name)); removed.push(name) } catch { /* best effort */ }
  }
  return removed
}


// ── Codex 会话清理（原 index.js L2674-2697）──
// 递归删除 sessions 下 mtime 早于 keepDays 天的 *.jsonl，统计数量与释放字节
export function cleanupSessions(dir, cutoff, stats) {
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


// ── 复核记录目录：数量截断（原 index.js L3229-3244）──

// 数量截断：目录超 REVIEW_KEEP_FILES 个按 mtime 删最旧。

// 上限常量只在本函数里读（组外零引用，已 grep 核）→ 随组搬入，index.js 里 import 回来给注释外的调用点用。

export const REVIEW_KEEP_FILES = 200

export function pruneReviewFiles() {
  let names
  try { names = readdirSync(REVIEWS_DIR) } catch { return }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = join(REVIEWS_DIR, name)
    try { files.push({ full, mtime: statSync(full).mtimeMs }) } catch { /* 跳过瞬时错误 */ }
  }
  if (files.length <= REVIEW_KEEP_FILES) return
  files.sort((a, b) => a.mtime - b.mtime)
  for (let i = 0; i < files.length - REVIEW_KEEP_FILES; i += 1) {
    try { unlinkSync(files[i].full) } catch { /* best effort */ }
  }
}

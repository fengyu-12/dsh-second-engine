// 判据冻结 + stale 判定（2026-11-06 · 方案来自 Codex 工单 mw3zh3qo）
//
// 能力边界（如实）：
//   只能证明「复核输入 / 显式列举的文件内容变了」，不能证明是谁改的、为什么改，
//   也不能检测权限、属主、mtime 变化（内容相同即视为未变，故意如此）。
//   派单的「验收标准」目前只有自由文本 prompt，没有结构化字段 ⇒ 本模块不冻结它，
//   别让调用方以为冻结了 prompt 就等于冻结了验收判据。
//
// 为什么不落独立文件：快照属于任务记录，复核任务已有 ~/.codex/reviews/<id>.json 可承载；
// 另建文件会引入双写与清理问题（Codex 方案「不值得做」节）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

export const CRITERIA_VERSION = 1

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function resolvePath(workdir, p) {
  if (typeof p !== 'string' || p === '') return null
  return isAbsolute(p) ? p : join(workdir, p)
}

/** 冻结判据：源文本 + 显式列举的文件内容。files 为空表示只冻结源文本。 */
export function freezeCriteria({ content = '', workdir = '', files = [] } = {}) {
  const list = []
  for (const p of Array.isArray(files) ? files : []) {
    const abs = resolvePath(workdir, p)
    if (abs === null) continue
    let hash = null
    try { hash = sha256(readFileSync(abs)) } catch { hash = null }
    list.push({ path: p, sha256: hash })
  }
  return {
    version: CRITERIA_VERSION,
    frozenAt: Date.now(),
    source: { contentSha256: sha256(String(content)), workdir: String(workdir) },
    files: list,
  }
}

/**
 * 按快照的形状重算「当前值」。content 由调用方给（源文本无法从磁盘反推），
 * 文件按冻结时的同一路径列表重读，读不到记 null。
 */
export function collectCurrent(snapshot, { content = '' } = {}) {
  const wd = (snapshot && snapshot.source && snapshot.source.workdir) || ''
  const files = []
  for (const f of (snapshot && Array.isArray(snapshot.files) ? snapshot.files : [])) {
    const abs = resolvePath(wd, f.path)
    let hash = null
    if (abs !== null) { try { hash = sha256(readFileSync(abs)) } catch { hash = null } }
    files.push({ path: f.path, sha256: hash })
  }
  return {
    version: CRITERIA_VERSION,
    source: { contentSha256: sha256(String(content)), workdir: wd },
    files,
  }
}

/**
 * 判 stale。返回 { stale:boolean, reasons:string[] }。
 * 判据：源文本哈希不等 / 任一文件哈希不等 / 冻结时存在的文件现在读不到。
 */
export function checkCriteria(snapshot, current) {
  const reasons = []
  if (!snapshot || snapshot.version !== CRITERIA_VERSION) {
    return { stale: false, reasons: ['无冻结快照，不做 stale 判定'] }
  }
  const cur = current || { source: {}, files: [] }
  const frozenSrc = (snapshot.source && snapshot.source.contentSha256) || ''
  const curSrc = (cur.source && cur.source.contentSha256) || ''
  if (frozenSrc !== curSrc) reasons.push('源文本已变')

  const curFiles = new Map()
  for (const f of (Array.isArray(cur.files) ? cur.files : [])) curFiles.set(f.path, f.sha256)
  for (const f of (Array.isArray(snapshot.files) ? snapshot.files : [])) {
    if (f.sha256 === null) continue // 冻结时就不存在，不算证据
    const now = curFiles.has(f.path) ? curFiles.get(f.path) : null
    if (now === null || now === undefined) { reasons.push(`文件已消失：${f.path}`); continue }
    if (now !== f.sha256) reasons.push(`文件内容已变：${f.path}`)
  }
  return { stale: reasons.length > 0, reasons }
}

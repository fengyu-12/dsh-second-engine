// io.js —— 从 index.js 拆出的 IO 组（拆分交接见 split-brief.md）。
// 职责：HTTP 请求体/查询参数小工具、keyring 落盘、config.toml 备份轮转、
//       任务输出头尾截断、任务/复核/求助 ID 生成。
// 函数体与常量值逐字来自 index.js（未改逻辑），只加了 export 与就近注释。
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, unlinkSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CODEX_DIR, CONFIG_PATH } from './constants.js'
import { atomicWriteFileSync } from './core.js'

// keyring 路径：只在 io 组（saveKeyring）里读写 → 随组搬入；index.js 的 loadKeyring
// 需要同一个值，故 export 后由 index.js import 回来（见 split-brief 硬约束 2）。
export const KEYRING_PATH = join(CODEX_DIR, 'keyring.json')


// ── 任务/复核/求助 ID ──
// 任务/复核/求助 ID：时间前缀可读可排序 + 8 字节强随机。
// （旧式 4 字符随机段在并发提交时会碰撞，tasks.set 直接覆盖既有条目。）
export function newId() {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
}


// ── node:http 小工具（同 guard 写法）──
// 请求体上限：设置页 API 的 payload 都很小，但 /api/review 的 content 可能承载
// 整份交付文档，取 4MB 兼顾两者；超限直接断开按空体处理，防超大包全量缓冲进内存。
export const MAX_BODY_BYTES = 4 * 1024 * 1024
export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let received = 0
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    req.on('data', (c) => {
      received += c.length
      if (received > MAX_BODY_BYTES) {
        try { req.destroy() } catch { /* best effort */ }
        finish({})
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
    // 客户端半途中断且只触发 close（无 error/end）时兜底，handler 不至于永久挂起。
    req.on('close', () => finish({}))
  })
}


// ── keyring 落盘 ──
// 原子落盘：同目录临时文件 + rename 顶替。直接 writeFileSync 目标路径，进程中途
// 崩溃/断电会留下半截文件（keyring.json / config.toml 随之解析失败）；mode 在创建
// 临时文件时即生效，0600 没有「先建后 chmod」的 world-readable 窗口。

export function saveKeyring(doc) {
  mkdirSync(CODEX_DIR, { recursive: true })
  atomicWriteFileSync(KEYRING_PATH, `${JSON.stringify(doc, null, 2)}\n`)
}


// ── config.toml 备份轮转 ──
// 每次重写 config 前按时间戳另存一份：config.toml.bak-<YYYYMMDD-HHMMSS>，保留最近
// CONFIG_BACKUP_KEEP 份，旧的清掉。A4（2026-10-26）：此前只在首次写前备份一次 .bak-se，
// 恢复点永远停在史前版本，之后任何一次重写出问题都只能回滚到最初状态。
// 只按本方案的文件名模式轮转（config.toml.bak-YYYYMMDD-HHMMSS），不碰史前 .bak-se 和其它文件。
export const CONFIG_BACKUP_KEEP = 5
export const CONFIG_BACKUP_NAME_RE = /^config\.toml\.bak-\d{8}-\d{6}$/
export function backupConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return
    const t = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const target = join(CODEX_DIR, `config.toml.bak-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`)
    copyFileSync(CONFIG_PATH, target)
    chmodSync(target, 0o600)
    const rolling = readdirSync(CODEX_DIR).filter((n) => CONFIG_BACKUP_NAME_RE.test(n)).sort()
    for (const name of rolling.slice(0, Math.max(0, rolling.length - CONFIG_BACKUP_KEEP))) {
      try { unlinkSync(join(CODEX_DIR, name)) } catch { /* best effort */ }
    }
  } catch { /* 备份失败不阻断切换（best effort） */ }
}


// ── 任务输出头尾截断 ──
// 超长 -o 输出只留头尾（各半）：output 会整段进内存并随 GET /task 全量外发，
// 不设限时长任务的输出可达数百 MB（OOM + 响应体爆炸）。
export const TASK_OUTPUT_CLIP = 2 * 1024 * 1024
export const CANCEL_RETRY_MS = 1000
export const CANCEL_FORCE_FINALIZE_MS = 5000
export const CANCEL_FORCE_FINALIZE_MESSAGE = 'agent 未响应取消，已强制收尾（5 秒超时）'
export function readHeadTail(path, maxBytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const readChunk = (buf, position) => {
      let off = 0
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, position + off)
        if (n <= 0) break
        off += n
      }
      return buf.toString('utf8')
    }
    if (size <= maxBytes) return readChunk(Buffer.alloc(size), 0)
    const half = Math.floor(maxBytes / 2)
    const head = readChunk(Buffer.alloc(half), 0)
    const tailLen = Math.min(half, size)
    const tail = readChunk(Buffer.alloc(tailLen), size - tailLen)
    return `${head}\n…[second-engine 截断：全文 ${size} 字节，仅保留头尾各 ${half} 字节]…\n${tail}`
  } finally {
    try { closeSync(fd) } catch { /* best effort */ }
  }
}


// ── URL 查询参数 ──
export function queryParam(url, key) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key) || ''
  } catch { return '' }
}

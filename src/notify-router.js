// 统一通知路由：队列 + 策略层，只在需要用户接手的节点提醒。
// 通道优先级 Toast → 振动 → 通知。不直接调用 /app/* 或任何 HTTP —— sender 由外部注入。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_PRIORITY_BY_KIND = {
  'task-complete': 'notification',
  pending: 'vibrate',
  consult: 'toast',
  error: 'notification',
}

const DEFAULT_POLICY = {
  quietHours: { start: '23:00', end: '08:00' },
  foreground: false,
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((s) => parseInt(s, 10))
  return h * 60 + (m || 0)
}

// 判断 now 是否落在 [start, end) 的静默时段内；支持跨午夜（start > end）。
function isQuietNow(quietHours, now) {
  if (!quietHours || !quietHours.start || !quietHours.end) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = toMinutes(quietHours.start)
  const end = toMinutes(quietHours.end)
  if (start === end) return false
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

function policyPath(storeDir) {
  return join(storeDir, 'policy.json')
}

function loadPolicy(storeDir) {
  try {
    const p = policyPath(storeDir)
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      return {
        quietHours: raw.quietHours || DEFAULT_POLICY.quietHours,
        foreground: !!raw.foreground,
      }
    }
  } catch {
    // 规则文件损坏时退回默认策略，不阻塞通知流程
  }
  return { ...DEFAULT_POLICY }
}

export function createNotifyRouter({ storeDir, now = Date.now, sender }) {
  if (!storeDir) throw new Error('createNotifyRouter: storeDir is required')
  if (typeof sender !== 'function') throw new Error('createNotifyRouter: sender is required')

  let policy = loadPolicy(storeDir)
  // 队列：按 dedupeKey 合并未发送的条目，顺序为首次入队顺序（Map 保留插入序）
  const queue = new Map()
  // 已发送记录：按 `${kind}::${dedupeKey}` 去重，防止重复发送
  const sentKeys = new Set()

  function sentId(kind, dedupeKey) {
    return `${kind}::${dedupeKey}`
  }

  function resolvePriority({ kind, priority }) {
    let p = priority || DEFAULT_PRIORITY_BY_KIND[kind] || 'notification'
    if (policy.foreground) p = 'vibrate'
    return p
  }

  // notify 返回 Promise；静默时段外会在返回前完成一次 flush（经由注入的异步 sender）。
  async function notify({ kind, dedupeKey, text, priority }) {
    if (!kind) throw new Error('notify: kind is required')
    if (!dedupeKey) throw new Error('notify: dedupeKey is required')

    const id = sentId(kind, dedupeKey)
    if (sentKeys.has(id)) {
      return { sent: false, queued: false, reason: 'deduped' }
    }

    const resolvedPriority = resolvePriority({ kind, priority })
    // 同 dedupeKey 在未发送前合并为一条：以最新 text 覆盖队列里的旧条目
    queue.set(id, { kind, dedupeKey, text, priority: resolvedPriority })

    if (isQuietNow(policy.quietHours, now())) {
      return { sent: false, queued: true }
    }

    await flush()
    return { sent: true, queued: false }
  }

  async function flush() {
    const entries = Array.from(queue.values())
    queue.clear()
    for (const entry of entries) {
      const id = sentId(entry.kind, entry.dedupeKey)
      await sender({ channel: entry.priority, text: entry.text })
      sentKeys.add(id)
    }
  }

  function setPolicy(next) {
    policy = { ...policy, ...next }
    try {
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(policyPath(storeDir), JSON.stringify(policy, null, 2))
    } catch {
      // 落盘失败不影响内存中的策略生效
    }
  }

  return { notify, flush, setPolicy }
}

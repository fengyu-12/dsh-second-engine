import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SESSIONS_DIR, loadKeyring } from './index.js'

export function execMode() {
  const fromEnv = process.env.SECOND_ENGINE_EXEC_MODE
  if (fromEnv === 'appserver' || fromEnv === 'exec') return fromEnv
  try {
    const fromFile = readFileSync(join(homedir(), '.dsh', 'second-engine-mode.txt'), 'utf8').trim()
    if (fromFile === 'appserver' || fromFile === 'exec') return fromFile
  } catch { /* 文件不存在 → 默认 */ }
  return 'exec'
}

export function keyConfigured() {
  try {
    const doc = loadKeyring()
    const active = doc.providers.find((p) => p.id === doc.active)
    return active !== undefined && active.apiKey.trim() !== ''
  } catch {
    return false
  }
}

export function sessionsBytes(dir = SESSIONS_DIR) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += sessionsBytes(full)
      else if (entry.isFile()) total += statSync(full).size
      else if (entry.isSymbolicLink()) total += statSync(full).size
    } catch { /* 忽略瞬时错误 */ }
  }
  return total
}

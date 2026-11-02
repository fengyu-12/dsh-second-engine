// src/core.js — 最底层无依赖工具（2026-11-02 从 index.js 拆出，第二刀）
// 零函数依赖、零可变状态：noteErr / atomicWriteFileSync / send / readConfigRaw。
import { writeFileSync, chmodSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { CONFIG_PATH } from './constants.js'

export const ERR_LOG = []

const ERR_LOG_LIMIT = 50

const ERR_REDACT_RE = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._~+\/=-]{6,}|(?:(?:api[_-]?key|key|token|password|secret)["']?\s*[:=]\s*)["']?[A-Za-z0-9._~+\/=-]{6,})/gi

export function noteErr(tag, err) {
  let msg = err instanceof Error ? String(err.message ?? err) : String(err ?? '')
  msg = String(msg).replace(ERR_REDACT_RE, '[redacted]').slice(0, 300)
  ERR_LOG.push({ t: Date.now(), tag: String(tag), msg })
  while (ERR_LOG.length > ERR_LOG_LIMIT) ERR_LOG.shift()
}

export function atomicWriteFileSync(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw e
  }
}

export function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

export function readConfigRaw() {
  try { return readFileSync(CONFIG_PATH, 'utf8') } catch { return '' }
}


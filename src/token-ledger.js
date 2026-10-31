// Durable cross-job accounting. Unknown usage is counted separately, never asserted as zero.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
export function tokenTotal(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (!value || typeof value !== 'object') return null
  for (const key of ['totalTokens', 'total_tokens', 'total']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) return value[key]
  }
  const input = value.inputTokens ?? value.input_tokens ?? value.input
  const output = value.outputTokens ?? value.output_tokens ?? value.output
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    ? input + output : null
}
export function ledgerSummary(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (e) { if (e.code === 'ENOENT') return { knownTokens: 0, unknown: 0, jobs: 0 }; throw e }
  const seen = new Set()
  let knownTokens = 0, unknown = 0
  for (const line of raw.split('\n').filter(Boolean)) {
    const row = JSON.parse(line)
    if (typeof row.id !== 'string') throw new Error('invalid token ledger row')
    if (seen.has(row.id)) continue
    seen.add(row.id)
    if (tokenTotal(row.tokens) !== null) knownTokens += row.tokens
    if (row.usage !== 'known') unknown++
  }
  return { knownTokens, unknown, jobs: seen.size }
}
export function recordTokens(path, id, source, tokens, unknown = tokens === null) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({ id, source, usage: unknown ? 'unknown' : 'known', tokens, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
}
export function budgetGate(path, budget) {
  const summary = ledgerSummary(path)
  if (budget === undefined || budget === '') return { ...summary, blocked: false }
  const limit = Number(budget)
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('SECOND_ENGINE_TOKEN_BUDGET 必须为非负整数')
  return { ...summary, limit, blocked: summary.knownTokens >= limit }
}

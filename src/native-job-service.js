// In-process lifecycle facade; bridge sends use the selected bridge's loopback API.
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createTask, taskView } from './index.js'
import { cancelTask } from './task-lifecycle.js'
import { cancelReview, loadReviewRecord, createReview } from './review-handlers.js'
import { createNativeReviewService } from './native-review-service.js'
import { nativeBridgeService } from './native-bridge-service.js'
import { tasks } from './state.js'
import { noteErr } from './core.js'

// Legacy lifecycle operations write through core.send(). Capture their response;
// this sink performs no IO and keeps HTTP and native callers on the same logic.
async function capture(operation, recover, log = noteErr) {
  let result
  try {
    await operation({
      setHeader() {},
      end(json) { result = JSON.parse(json) },
    })
    if (result === undefined) throw new Error('Lifecycle returned no result')
    if (recover && !result.ok) {
      const recovered = recover()
      if (recovered) {
        log('native-create-task', new Error(String(result.error ?? 'Lifecycle returned failure after creation')))
        return recovered
      }
    }
    return result
  } catch (error) {
    log('native-lifecycle-capture', error)
    const recovered = recover?.()
    if (recovered) return recovered
    if (result?.ok && result.id) return result
    throw error
  }
}
export function createNativeJobService({ create = createTask, jobs = tasks, view = taskView, load = loadReviewRecord, log = noteErr } = {}) {
  function findJob(kind, id) {
    const task = jobs.get(id)
    if (task) return (task.kind === 'review' ? 'review' : 'task') === kind ? task : null
    return kind === 'review' ? load(id) : null
  }
  const notFound = () => ({ ok: false, error: 'Job not found or kind mismatch' })
  return {
    ...nativeBridgeService,
    ...createNativeReviewService({ create: args => capture(sink => createReview(args, sink, { persistContent: true })), find: id => findJob('review', id) }),
    async bridgeSend({ engine, text }) {
      const warnings = []
      const failure = (code, error) => ({ ok: false, code,
        error: `${error} Result unknown; the operation may have succeeded. Do not automatically retry.`,
        status: 'unknown', retryable: false, ...(warnings.length ? { warnings } : {}) })
      let port
      try {
        const status = await nativeBridgeService.bridgeStatus({ engine })
        port = status.port
        if (!status.running || !Number.isInteger(port) || port < 1 || port > 65535) {
          return failure('BRIDGE_UNAVAILABLE', 'Selected bridge has no running endpoint.')
        }
      } catch { return failure('BRIDGE_UNAVAILABLE', 'Selected bridge status is unavailable.') }
      // Token policy differs per bridge: codex keeps one in its state dir; pi reads an env
      // var and claude accepts loopback unauthenticated (both only enforce it off-loopback).
      let token = ''
      try {
        if (engine === 'codex') {
          token = (await readFile(join(homedir(), '.dsh', 'second-engine-bridge', '.token'), 'utf8')).trim()
          if (!token) return failure('BRIDGE_TOKEN_UNAVAILABLE', 'Bridge token is empty.')
        } else if (engine === 'pi') {
          token = (process.env.PI_BRIDGE_TOKEN ?? '').trim()
        }
      } catch { return failure('BRIDGE_TOKEN_UNAVAILABLE', 'Bridge token is unavailable.') }
      return new Promise(resolve => {
        let req, timer, finished = false, responding = false
        let output = '', pending = ''
        const finish = result => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve(result)
          req?.destroy()
        }
        const parseLine = line => {
          if (!line.trim()) return
          const event = JSON.parse(line)
          if (event?.kind === 'text' && typeof event.text === 'string') output += event.text
          if (event?.kind === 'note' || event?.kind === 'error') {
            warnings.push([event.text, event.message, event.error].find(value => typeof value === 'string') ?? event.kind)
          }
          if (event?.kind === 'done') finish({ ok: event.ok !== false, text: output,
            tokens: event.tokens ?? null, engine, ...(warnings.length ? { warnings } : {}) })
          // claude/pi bridges terminate with 'end' (no done event); codex sends 'done'.
          else if (event?.kind === 'end') finish({ ok: true, text: output,
            tokens: event.tokens ?? null, engine, ...(warnings.length ? { warnings } : {}) })
        }
        try {
          req = request({ hostname: '127.0.0.1', port, path: '/api/send', method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}) } }, async res => {
            responding = true
            if (res.statusCode !== 200) {
              finish(failure('BRIDGE_HTTP_ERROR', `Bridge returned HTTP ${res.statusCode}.`))
              res.destroy()
              return
            }
            res.setEncoding('utf8')
            try {
              for await (const chunk of res) {
                pending += chunk
                let newline
                while ((newline = pending.indexOf('\n')) !== -1) {
                  const line = pending.slice(0, newline)
                  pending = pending.slice(newline + 1)
                  parseLine(line)
                  if (finished) return
                }
              }
              if (pending.trim()) parseLine(pending)
              if (!finished) finish(failure('BRIDGE_STREAM_INTERRUPTED', 'Bridge stream ended before done.'))
            } catch { finish(failure('BRIDGE_STREAM_INTERRUPTED', 'Bridge stream interrupted or invalid NDJSON.')) }
          })
          req.on('error', () => finish(failure(responding ? 'BRIDGE_STREAM_INTERRUPTED' : 'BRIDGE_CONNECTION_FAILED',
            responding ? 'Bridge stream interrupted.' : 'Could not connect to the selected bridge.')))
          timer = setTimeout(() => finish(failure(responding ? 'BRIDGE_STREAM_INTERRUPTED' : 'BRIDGE_CONNECTION_FAILED',
            'Bridge send timed out.')), 300_000)
          timer.unref()
          req.end(JSON.stringify({ text, threadId: null }))
        } catch { finish(failure('BRIDGE_CONNECTION_FAILED', 'Could not send to the selected bridge.')) }
      })
    },
    async createTask(args) {
      // IDs come from this invocation, never from a global before/after task diff.
      let allocatedId
      const result = await capture(sink => create(args, sink, false, id => { allocatedId = id }),
        () => allocatedId && jobs.has(allocatedId) ? { ok: true, id: allocatedId } : null, log)
      if (!result.ok) return result
      const task = jobs.get(result.id)
      return { id: result.id, status: task ? view(task).status : 'running' }
    },
    inspectTask(id) {
      const task = jobs.get(id)
      return task ? { exists: true, childPid: task.childPid, startedAt: task.startedAt, status: view(task).status } : { exists: false }
    },
    getJob({ kind, id }) {
      const task = findJob(kind, id)
      if (!task) return notFound()
      const projected = jobs.has(id) ? view(task) : task
      // Persisted review records retain rounds/verdict rather than task.output.
      const rounds = Array.isArray(projected.rounds) ? projected.rounds : []
      const output = kind === 'review'
        ? JSON.stringify({ verdict: projected.verdict ?? '', rounds, issues: rounds.at(-1)?.issues ?? [] })
        : (typeof projected.output === 'string' ? projected.output : '')
      return { id, kind, status: projected.status, output: output.slice(0, 4000), outputTruncated: output.length > 4000 }
    },
    async cancelJob({ kind, id }) {
      if (!findJob(kind, id)) return notFound()
      return capture(sink => (kind === 'review' ? cancelReview : cancelTask)(id, sink))
    },
  }
}
export const nativeJobService = createNativeJobService()

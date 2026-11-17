// In-process facade over the existing lifecycle. No request, socket or HTTP loopback.
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
    async createTask(args) {
      // IDs come from this invocation, never from a global before/after task diff.
      let allocatedId
      const result = await capture(sink => create(args, sink, false, id => { allocatedId = id }),
        () => allocatedId && jobs.has(allocatedId) ? { ok: true, id: allocatedId } : null, log)
      if (!result.ok) return result
      const task = jobs.get(result.id)
      return { id: result.id, status: task ? view(task).status : 'running' }
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

import { randomUUID } from 'node:crypto'

const owners = new Map()
// Covers a job finalizing before asynchronous creation returns its handle.
const recent = new Map()
const terminal = new Set(['done', 'error', 'cancelled'])

export function watchNativeJob(id, agent, status) {
  if (typeof id !== 'string' || !agent || typeof agent.inject !== 'function') return
  owners.set(id, new WeakRef(agent))
  if (recent.has(id)) completeNativeJob(recent.get(id))
  else if (terminal.has(status)) completeNativeJob({ id, status })
}

export function completeNativeJob(job) {
  if (!terminal.has(job?.status)) return
  // Metadata only: never copy engine output, prompts, diagnostics or credentials.
  const summary = { id: job.id, status: job.status }
  recent.set(job.id, summary)
  while (recent.size > 50) recent.delete(recent.keys().next().value)
  const owner = owners.get(job.id)
  owners.delete(job.id) // Consume before calling external code, even if it throws.
  const agent = owner?.deref()
  if (!agent) return
  try {
    const result = agent.inject({
      id: `second-engine-done-${randomUUID()}`,
      role: 'user',
      source: { kind: 'second-engine-completion' },
      content: [{ type: 'text', text: `[SECOND_ENGINE:DONE] ${JSON.stringify(summary).slice(0, 350)}\n插件完成通知；输出正文未注入，请用 second_engine_job_get 查询结果。` }],
    })
    // Also tolerate hosts/adapters with asynchronous delivery failures.
    Promise.resolve(result).catch(() => {})
  } catch { /* Session disposed or inbox unavailable: best effort only. */ }
}

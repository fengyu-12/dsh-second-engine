import { watchNativeJob } from './native-completion.js'

// Load lifecycle code only when a validated tool is executed.
const nativeJobService = Object.fromEntries(['createTask', 'getJob', 'cancelJob', 'createReview', 'replyReview', 'startBridge', 'stopBridge', 'bridgeStatus'].map(method => [
  method, async args => (await import('./native-job-service.js')).nativeJobService[method](args),
]))

const taskProperties = {
  prompt: { type: 'string' },
  workdir: { type: 'string' },
  engine: { type: 'string', enum: ['codex', 'claude', 'pi'] },
  ephemeral: { type: 'boolean' },
}
const jobProperties = {
  kind: { type: 'string', enum: ['task', 'review'] },
  id: { type: 'string' },
}
const engineProperties = { engine: taskProperties.engine }
const replyProperties = {
  issueId: { type: 'string' },
  decision: { type: 'string', enum: ['accepted', 'partial', 'rejected'] },
  reason: { type: 'string' },
}
const reviewProperties = {
  content: { type: 'string' }, workdir: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } },
  rounds: { type: 'integer', enum: [1, 2, 3, 4, 5] },
}
const replyParameters = {
  prev: { type: 'string' },
  reply: { type: 'array', items: { type: 'object', properties: replyProperties, required: ['issueId', 'decision'], additionalProperties: false } },
}
const errorResult = (code, message, status) => ({ ok: false, ...(status ? { status } : {}), error: { code, message } })
function valid(args, properties, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (!required.every(key => Object.hasOwn(args, key))) return false
  return Object.keys(args).every(key => {
    const spec = properties[key]
    const value = args[key]
    if (!spec) return false
    if (spec.type === 'array') return Array.isArray(value)
      && (key !== 'files' || value.length <= 50)
      && value.every(item => spec.items.type === 'object'
        ? valid(item, spec.items.properties, spec.items.required)
        : typeof item === 'string' && item.trim().length > 0)
    if (spec.type === 'integer') return Number.isInteger(value) && spec.enum.includes(value)
    return typeof value === spec.type
      && (spec.type !== 'string' || key === 'reason' || value.trim().length > 0)
      && (!spec.enum || spec.enum.includes(value))
  })
}

// Optional injection keeps tests entirely in-process and never starts a real engine.
nativeJobService.getStatus = async () => (await import('./native-status-service.js')).nativeStatusService.getStatus()

export function registerNativeTools(ctx, { service = nativeJobService, timeoutMs = 5000 } = {}) {
  if (typeof ctx?.tools?.register !== 'function') return
  for (const [suffix, method, properties, required, description] of [
    ['status', 'getStatus', {}, [], 'Get all engines local runtime status without remote version checks or sensitive diagnostics.'],
    ['review_start', 'createReview', reviewProperties, ['content'], 'Start an independent review asynchronously; returns a handle, not a verdict. Do not retry unknown outcomes.'],
    ['review_reply', 'replyReview', replyParameters, ['prev', 'reply'], 'Continue a prior review with issue decisions; returns a new asynchronous handle.'],
    ['bridge_start', 'startBridge', engineProperties, ['engine'], 'Start the selected engine chat bridge.'],
    ['bridge_stop', 'stopBridge', engineProperties, ['engine'], 'Disable desired state and stop the owned chat bridge instance.'],
    ['bridge_status', 'bridgeStatus', engineProperties, ['engine'], 'Query selected engine chat bridge status and desired state.'],
    ['task', 'createTask', taskProperties, ['prompt'], 'Start a second-engine task asynchronously. On unknown/timeout do not retry: creation may have succeeded.'],
    ['job_get', 'getJob', jobProperties, ['kind', 'id'], 'Get task/review status and an output summary.'],
    ['job_cancel', 'cancelJob', jobProperties, ['kind', 'id'], 'Request cancellation of a task/review.'],
  ]) {
    ctx.tools.register({
      name: `second_engine_${suffix}`,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value ?? { status: 'unknown' }) }]
        },
      },
      async execute(args, exec) {
        let timer
        let timedOut = false
        try {
          if (!valid(args, properties, required)) return errorResult('INVALID_ARGUMENTS', 'Invalid tool parameters')
          // One invocation only. Timeout does not abort or retry the underlying creation.
          const result = await Promise.race([
            Promise.resolve().then(() => service[method]({ ...args })).then(result => {
              if (['createTask', 'createReview', 'replyReview'].includes(method) && result?.ok !== false && !result?.error) {
                watchNativeJob(result?.id, exec?.agent, result?.status)
              }
              return result
            }),
            new Promise(resolve => {
              timer = setTimeout(() => { timedOut = true; resolve(errorResult('TIMEOUT', 'Result unknown; operation may have succeeded. Do not automatically retry.', 'unknown')) }, timeoutMs)
            }),
          ])
          if (timedOut) return result
          if (result?.code === 'bridge-timeout') return errorResult('TIMEOUT', 'Result unknown; operation may have succeeded. Do not automatically retry.', 'unknown')
          if (result?.ok === false) {
            // Do not surface raw backend diagnostics: they can contain sensitive data.
            return errorResult('OPERATION_FAILED', 'Operation rejected; inspect the local job/service status.')
          }
          if (['createTask', 'createReview', 'replyReview'].includes(method) && !result?.error) return { id: result.id, status: result.status ?? 'running' }
          return result
        } catch {
          return errorResult('EXECUTION_FAILED', 'Operation failed; creation outcome may be unknown. Do not automatically retry.')
        } finally {
          clearTimeout(timer)
        }
      },
    })
  }
}

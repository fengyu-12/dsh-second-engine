import { watchNativeJob } from './native-completion.js'

// Load lifecycle code only when a validated tool is executed.
const nativeJobService = Object.fromEntries(['createTask', 'getJob', 'cancelJob', 'createReview', 'replyReview', 'startBridge', 'stopBridge', 'bridgeStatus', 'bridgeSend', 'inspectTask'].map(method => [
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
    ['bridge_send', 'bridgeSend', { ...engineProperties, text: { type: 'string' } }, ['engine', 'text'], 'Send a message to the selected engine chat bridge and return its streamed reply. On unknown outcomes do not automatically retry.'],
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
        const isTask = method === 'createTask'
        const warnings = []
        try {
          if (!valid(args, properties, required)) return errorResult('INVALID_ARGUMENTS', 'Invalid tool parameters')
          if (isTask) {
            try {
              const snapshot = await service.getStatus()
              const requested = args.engine || snapshot.active
              if (args.engine && args.engine !== snapshot.active) warnings.push(`engine=${args.engine} 但当前 active=${snapshot.active}，任务会按 ${args.engine} 派发`)
              const engine = snapshot.engines?.find(item => item.id === requested)
              if (!engine || !engine.available) warnings.push(`该引擎不可用: ${requested}`)
              if (!engine?.keyConfigured) warnings.push('该引擎未配置 key')
            } catch { warnings.push('派单预检失败，无法确认当前引擎状态') }
          }
          // Streaming sends own their timeout and preserve their unknown-outcome details.
          if (method === 'bridgeSend') return await service[method]({ ...args })
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
          if (timedOut) return isTask ? { ...result, warnings } : result
          if (result?.code === 'bridge-timeout') return errorResult('TIMEOUT', 'Result unknown; operation may have succeeded. Do not automatically retry.', 'unknown')
          if (result?.ok === false) {
            // Do not surface raw backend diagnostics: they can contain sensitive data.
            return { ...errorResult('OPERATION_FAILED', 'Operation rejected; inspect the local job/service status.'), ...(isTask ? { warnings } : {}) }
          }
          if (isTask && result?.id) {
            let inspected
            const deadline = Date.now() + 3000
            do {
              try { inspected = await service.inspectTask(result.id) } catch { inspected = null }
              if (inspected?.childPid) break
              if (Date.now() >= deadline) break
              await new Promise(resolve => setTimeout(resolve, 100))
            } while (true)
            if (!inspected?.exists) warnings.push(`任务未登记 (id=${result.id})`)
            if (!inspected?.childPid) warnings.push(`可能未真正挂上（id=${result.id}）`)
            if (inspected?.exists) {
              if (!inspected.startedAt) warnings.push(`任务缺少 startedAt (id=${result.id})`)
            }
            return { ...result, warnings }
          }
          if (isTask) return { ...result, warnings }
          if (['createTask', 'createReview', 'replyReview'].includes(method) && !result?.error) return { id: result.id, status: result.status ?? 'running' }
          return result
        } catch {
          return { ...errorResult('EXECUTION_FAILED', 'Operation failed; creation outcome may be unknown. Do not automatically retry.'), ...(isTask ? { warnings } : {}) }
        } finally {
          clearTimeout(timer)
        }
      },
    })
  }
}

/**
 * 本地 Executor 接缝；不是官方版本绑定。
 * @typedef {object} TaskRequest
 * @property {string|null} taskId 未分配时为 null；ID 仍由原创建路径分配。
 * @property {string} prompt
 * @property {string} workdir
 * @property {{scope:string,strength:'explicit'|'inferred',policyVersion:number}} mandate
 * @property {string} engine
 * @property {string|undefined} provider
 * @property {string|undefined} model
 * @property {boolean} ephemeral
 *
 * Executor.create(request) 的返回形状：
 * start(): unknown（沿用宿主启动回调，只启动一次）；
 * events(): AsyncIterable<object>（由 adapter 提供；无流时为空）；
 * done: Promise<Report>（完整收尾后 resolve，取消意图不提前 resolve）；
 * cancel(reason): unknown（只提交取消意图，幂等；不伪造终态）；
 * descriptor: {id:string, transport:string, protocolVersion:number}。
 * Report: {taskId,state,exitCode,reason,progress,artifacts,engine,protocolVersion,
 *          status,output}；最后两项与 exitCode 是旧视图兼容投影。
 */

/** 纯解析；默认值由宿主注入，不读文件、环境或活动引擎，不负责 IO 门禁。
 * @param {object} body
 * @param {{workdir?:string,engine?:string}} defaults
 * @returns {TaskRequest}
 */
export function normalizeTaskRequest(body, defaults = {}) {
  const explicitWorkdir = typeof body.workdir === 'string' && body.workdir.trim() !== ''
  // 引擎不 trim：保留旧 API 对空白/未知引擎的处理。
  const explicitEngine = typeof body.engine === 'string' && body.engine !== ''
  const workdir = explicitWorkdir ? body.workdir.trim() : (defaults.workdir ?? '')
  return {
    taskId: typeof body.taskId === 'string' ? body.taskId : null,
    prompt: typeof body.prompt === 'string' ? body.prompt.trim() : '',
    workdir,
    mandate: {
      scope: workdir,
      strength: explicitWorkdir && explicitEngine ? 'explicit' : 'inferred',
      policyVersion: 0, // 等官方正式版；此处是本地占位，不表示官方策略版本。
    },
    engine: explicitEngine ? body.engine : (defaults.engine ?? 'codex'),
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    ephemeral: body.ephemeral !== false,
    // 派活前置校验的两项（2026-11-06）：合法值原样带进任务对象，非法值由
    // handleTaskCreate 当场 400 —— 不靠 agent 记得写，也不假装它们能校验质量。
    timeoutMs: Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : undefined,
    acceptance: Array.isArray(body.acceptance)
      ? body.acceptance.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : (typeof body.acceptance === 'string' && body.acceptance.trim() !== '' ? body.acceptance.trim() : undefined),
  }
}

/** 纯终态投影；不修改 task，也不改变 HTTP taskView。 */
export function buildReport(task) {
  return {
    taskId: task.id,
    state: ({ done: 'ready', error: 'failed', cancelled: 'dropped' })[task.status] ?? task.status,
    exitCode: task.exitCode ?? null,
    reason: task.stopReason ?? task.error ?? task.appError ?? null,
    progress: (task.progress ?? []).map(entry => ({ ...entry })),
    artifacts: (task.artifacts ?? []).map(entry => typeof entry === 'object' && entry !== null ? { ...entry } : entry),
    engine: task.engine ?? 'codex',
    protocolVersion: 1,
    status: task.status,
    output: task.output ?? '',
  }
}

const completions = new WeakMap()
const ports = new WeakSet()

/** 仅在宿主完整收尾后调用；不把 Report 写进可序列化任务记录。 */
export function publishTaskReport(task, report) {
  const resolve = completions.get(task)
  if (!resolve) return
  completions.delete(task)
  resolve(report)
}

/**
 * 包装 Codex/Pi runtime。start/cancel 由宿主注入现有生命周期操作，
 * 尤其 Codex 取消的信号升级仍由宿主负责，不在这里另造一套。
 * 创建不启动进程；同一 task 只允许一个端口；宿主须调用 publishTaskReport。
 */
export function createTaskExecutor(request, { task, runtime, start, cancel }) {
  if (ports.has(task)) throw new Error('task 已有 Executor 端口')
  ports.add(task)
  let started = false
  let cancelled = false
  let startResult
  let cancelResult
  const done = new Promise(resolve => completions.set(task, resolve))
  return {
    descriptor: { ...runtime.descriptor, protocolVersion: 1 },
    start() {
      if (!started && !cancelled && completions.has(task)) {
        started = true
        startResult = start(request)
      }
      return startResult
    },
    events() {
      return typeof runtime.events === 'function' ? runtime.events() : (async function* () {})()
    },
    done,
    cancel(reason) {
      if (!cancelled && completions.has(task)) {
        cancelled = true
        cancelResult = cancel(reason)
      }
      return cancelResult
    },
  }
}

import { accessSync, constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** 插件根目录（src/ 的上一级），默认桥目录随包走，装到 node_modules 里也成立。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BRIDGE_DIR = join(PLUGIN_ROOT, 'bridge/web')

const execFileAsync = promisify(execFile)

const BRIDGE_ROUTE_PREFIX = '/second-engine/api/bridge'
const BRIDGE_SCRIPT_NAME = 'ctl.sh'
const BRIDGE_COMMANDS = new Set(['status-json', 'start', 'stop', 'url'])
const BRIDGE_COMMAND_TIMEOUT_MS = {
  'status-json': 30_000,
  start: 60_000,
  stop: 30_000,
  url: 30_000,
}
const BRIDGE_MAX_BUFFER_BYTES = 1024 * 1024

function bridgeScriptPath() {
  const bridgeDir = process.env.BRIDGE_DIR || DEFAULT_BRIDGE_DIR
  return join(bridgeDir, BRIDGE_SCRIPT_NAME)
}

function redactToken(text) {
  return String(text ?? '').replace(/([?&]t=)[^&\s]+/g, '$1<redacted>')
}

function commandErrorDetail(error) {
  const parts = [error?.stderr, error?.stdout, error?.message]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .map(redactToken)
  return parts.join('\n').trim() || 'bridge command failed'
}

export async function runBridgeCommand(command, options = {}) {
  if (!BRIDGE_COMMANDS.has(command)) {
    return {
      ok: false,
      code: 'bridge-failed',
      error: `unsupported bridge subcommand '${command}'`,
    }
  }

  const script = bridgeScriptPath()
  try {
    accessSync(script, constants.X_OK)
  } catch (error) {
    return {
      ok: false,
      code: 'bridge-missing',
      error: redactToken(error?.message ?? `bridge script not accessible: ${script}`),
    }
  }

  const requestedTimeoutMs = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : BRIDGE_COMMAND_TIMEOUT_MS[command]

  try {
    const { stdout } = await execFileAsync(script, [command], {
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: BRIDGE_MAX_BUFFER_BYTES,
      windowsHide: true,
    })
    return { ok: true, output: stdout }
  } catch (error) {
    if (error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      return {
        ok: false,
        code: 'bridge-timeout',
        error: commandErrorDetail(error),
      }
    }
    return {
      ok: false,
      code: 'bridge-failed',
      error: commandErrorDetail(error),
    }
  }
}

function sendJson(res, data, status) {
  // 与插件 src/index.js 的 send() 同口径：状态码只能走 res.statusCode。
  // res.end(data, encoding, callback) 里没有 statusCode 参数——写成 res.end(x, undefined, 502)
  // 那个 502 会被当成 callback 忽略，错误响应实际仍是 200（2026-09-29 修正）。
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

async function sendBridgeResult(res, result, success, statusCodeByCode = {}) {
  if (!result.ok) {
    return sendJson(res, { ok: false, code: result.code, error: result.error }, statusCodeByCode[result.code] ?? 502)
  }
  return sendJson(res, success(result), 200)
}

function methodNotAllowed(res, allowedMethods) {
  return sendJson(res, {
    ok: false,
    error: `method not allowed; use ${allowedMethods}`,
  }, 405)
}

async function handleBridgeStatus(req, res) {
  if ((req.method ?? 'GET') !== 'GET') return methodNotAllowed(res, 'GET')
  const result = await runBridgeCommand('status-json')
  if (!result.ok) {
    return sendBridgeResult(res, result, () => {})
  }

  try {
    const status = JSON.parse(result.output)
    return sendJson(res, status, 200)
  } catch (error) {
    return sendJson(res, {
      ok: false,
      code: 'bridge-bad-json',
      error: redactToken(error?.message ?? 'bridge status output is not valid JSON'),
    }, 502)
  }
}

async function handleBridgeStart(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  const result = await runBridgeCommand('start')
  return sendBridgeResult(res, result, (passed) => ({ ok: true, output: passed.output }), {
    'bridge-timeout': 504,
    'bridge-missing': 500,
  })
}

async function handleBridgeStop(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  const result = await runBridgeCommand('stop')
  return sendBridgeResult(res, result, (passed) => ({ ok: true, output: passed.output }), {
    'bridge-timeout': 504,
    'bridge-missing': 500,
  })
}

async function handleBridgeUrl(req, res) {
  if ((req.method ?? 'GET') !== 'GET') return methodNotAllowed(res, 'GET')
  const result = await runBridgeCommand('url')
  return sendBridgeResult(res, result, (passed) => ({ ok: true, url: passed.output.trim() }), {
    'bridge-missing': 500,
  })
}

export function registerBridgeRoutes(wctx) {
  const routes = [
    { kind: 'exact', path: `${BRIDGE_ROUTE_PREFIX}/status`, handler: handleBridgeStatus },
    { kind: 'exact', path: `${BRIDGE_ROUTE_PREFIX}/start`, handler: handleBridgeStart },
    { kind: 'exact', path: `${BRIDGE_ROUTE_PREFIX}/stop`, handler: handleBridgeStop },
    { kind: 'exact', path: `${BRIDGE_ROUTE_PREFIX}/url`, handler: handleBridgeUrl },
  ]
  for (const route of routes) {
    wctx.effect(() => wctx.webServer.register(route), `second-engine: ${route.path} route`)
  }
}

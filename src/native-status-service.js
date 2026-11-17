import { existsSync, accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { nativeBridgeService } from './native-bridge-service.js'

// Presence checks only: never execute an engine (which could perform network IO).
function inPath(binary) {
  return (process.env.PATH || '').split(delimiter).some(dir => {
    try { accessSync(join(dir, binary), constants.X_OK); return true } catch { return false }
  })
}
const clean = value => String(value ?? '').replace(/sk-[\w-]+|Bearer\s+\S+|(?:[\w-]*(?:key|token|secret|password)[\w-]*)["']?\s*[:=]\s*["']?[^\s,;}]+/gi, '[redacted]')

// Called by engineView's local branch; shares model/registry sources with HTTP status.
export async function collectLocalEngines({ active, list, model, codexBinary, codexConfigured, bridgeStatus = args => nativeBridgeService.bridgeStatus(args),
  configured = async id => {
    if (id === 'codex') return codexConfigured()
    if (id === 'pi') return Boolean((await import('./core.js')).resolvePiProvider())
    const doc = (await import('./claude-providers.js')).loadClaudeProviders()
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ||
      doc.providers?.find(p => p.id === doc.active)?.apiKey)
  } }) {
  const engines = await Promise.all(list.map(async ({ id, label }) => {
    const current = await model(id)
    const bridge = await bridgeStatus({ engine: id })
    return { id, label, available: id === 'codex' ? existsSync(codexBinary()) : inPath(id),
      keyConfigured: await configured(id),
      model: current?.model || null, bridge }
  }))
  return { active, engines }
}

export function createNativeStatusService({ snapshot = async () => {
  const value = await (await import('./routes-a.js')).statusSnapshot({ localOnly: true })
  return { ...value.engine, lastErrors: value.lastErrors }
} } = {}) {
  return {
    async getStatus() {
      const value = await snapshot()
      return { active: clean(value.active), engines: value.engines.map(e => ({
        id: clean(e.id), label: clean(e.label), available: Boolean(e.available),
        keyConfigured: Boolean(e.keyConfigured), model: e.model ? clean(e.model) : null,
        bridge: { running: Boolean(e.bridge?.running), port: Number.isInteger(e.bridge?.port) ? e.bridge.port : null,
          pids: Array.isArray(e.bridge?.pids) ? e.bridge.pids.length : 0 },
      })), lastErrors: (value.lastErrors || []).slice(-3).map(e => clean(typeof e === 'string' ? e : e.msg).slice(0, 200)) }
    },
  }
}
export const nativeStatusService = createNativeStatusService()

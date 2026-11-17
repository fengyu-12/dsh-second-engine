import { readFileSync } from 'node:fs'

// Linux process birth identity, including protection against spaces/parentheses in comm.
export function readBridgeIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] || null
  } catch { return null }
}

// Serializes mutations per engine. Ownership is intentionally process-local: after a
// host restart existing bridges are observed but never adopted merely from a PID file.
export function createNativeBridgeService({ adapters, readIdentity = readBridgeIdentity, kill = pid => process.kill(pid, 'SIGTERM') }) {
  const states = new Map()
  function state(engine) {
    if (!adapters[engine]) throw new Error('Unsupported engine')
    if (!states.has(engine)) states.set(engine, { desired: false, owned: new Map(), tail: Promise.resolve() })
    return states.get(engine)
  }
  function serialize(s, operation) {
    const result = s.tail.then(operation)
    s.tail = result.catch(() => {})
    return result
  }
  async function status(engine, s) {
    const view = await adapters[engine].status()
    return { ok: true, engine, desired: s.desired, running: Boolean(view.running),
      pids: view.pids ?? [], ...(view.port ? { port: view.port } : {}) }
  }
  return {
    startBridge({ engine }) {
      const s = state(engine)
      s.desired = true
      return serialize(s, async () => {
        const before = await adapters[engine].status()
        if (!before.running) {
          const result = await adapters[engine].start()
          if (result?.ok === false) return result
          const after = await adapters[engine].status()
          const existing = new Set(before.pids ?? [])
          for (const pid of after.pids ?? []) {
            const identity = readIdentity(pid)
            if (!existing.has(pid) && identity !== null) s.owned.set(pid, identity)
          }
        }
        return status(engine, s)
      })
    },
    stopBridge({ engine }) {
      const s = state(engine)
      s.desired = false
      return serialize(s, async () => {
        // Clear persistent auto-start intent even when no process exists or a kill fails.
        await adapters[engine].disable()
        for (const [pid, birth] of s.owned) {
          if (readIdentity(pid) === birth) {
            try { kill(pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
          }
          s.owned.delete(pid)
        }
        return status(engine, s)
      })
    },
    async bridgeStatus({ engine }) { return status(engine, state(engine)) },
  }
}

const adapters = {
  codex: {
    async status() {
      const { runBridgeCommand } = await import('./bridge-routes.js')
      const result = await runBridgeCommand('status-json')
      if (!result.ok) throw new Error('Bridge status unavailable')
      const view = JSON.parse(result.output)
      return { running: Boolean(view.web?.running), port: view.web?.port,
        pids: [view.web, view.as].filter(part => part?.running && Number.isInteger(part.pid)).map(part => part.pid) }
    },
    async start() { return (await import('./bridge-routes.js')).runBridgeCommand('start') },
    async disable() {}, // ctl.sh has no persistent auto-recovery intent.
  },
  claude: {
    async status() {
      const view = (await import('./engine/claude-bridge-control.js')).claudeBridgeStatus()
      return { running: view.running, port: view.port, pids: view.running && view.pid ? [view.pid] : [] }
    },
    async start() { return (await import('./engine/claude-bridge-control.js')).startClaudeBridge() },
    async disable() { return (await import('./engine/claude-bridge-control.js')).disableClaudeBridgeRecovery() },
  },
  pi: {
    async status() {
      const view = await (await import('./engine/pi-bridge.js')).piBridgeStatus()
      return { running: view.running, port: view.port, pids: view.pid ? [view.pid] : [] }
    },
    async start() { return (await import('./engine/pi-bridge.js')).startPiBridge() },
    async disable() {}, // Pi has no persistent auto-recovery intent.
  },
}
export const nativeBridgeService = createNativeBridgeService({ adapters })

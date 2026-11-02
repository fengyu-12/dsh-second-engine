import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const HINT_TOGGLES_PATH = join(homedir(), '.dsh', 'second-engine', 'hint-toggles.json')

const DEFAULT_HINT_TOGGLES = Object.freeze({ vocabulary: false, interruption: false, mechanical: false })

function normalizeHintToggles(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    vocabulary: source.vocabulary === true,
    interruption: source.interruption === true,
    mechanical: source.mechanical === true,
  }
}

export function readHintToggles() {
  try {
    if (!existsSync(HINT_TOGGLES_PATH)) return { ...DEFAULT_HINT_TOGGLES }
    return normalizeHintToggles(JSON.parse(readFileSync(HINT_TOGGLES_PATH, 'utf8')))
  } catch {
    return { ...DEFAULT_HINT_TOGGLES }
  }
}

export function writeHintToggles(value) {
  const toggles = normalizeHintToggles(value)
  mkdirSync(dirname(HINT_TOGGLES_PATH), { recursive: true })
  writeFileSync(HINT_TOGGLES_PATH, `${JSON.stringify(toggles, null, 2)}\n`, { mode: 0o600 })
  return toggles
}

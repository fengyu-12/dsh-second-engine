import { constants } from 'node:fs'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONSULT_KEEP_LIMIT, noteErr } from './core.js'

const dir = join(homedir(), '.dsh', 'second-engine')
const path = join(dir, 'consults.jsonl')
const appendFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW

export const consults = []
let cacheReady
let writes = Promise.resolve()

// The cache is hydrated once. Disk reads stream the journal so the cache stays bounded.
async function* readJournal() {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  let invalid = 0
  try {
    for await (const line of file.readLines({ autoClose: false })) {
      if (line.trim() === '') continue
      try {
        const entry = JSON.parse(line)
        if (typeof entry?.id !== 'string' || typeof entry.at !== 'number'
          || !Number.isFinite(new Date(entry.at).getTime())) invalid++
        else yield entry
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e
        invalid++
      }
    }
  } finally {
    await file.close()
    if (invalid) noteErr('consult-read', `跳过 ${invalid} 条无效的 consult JSONL 记录`)
  }
}

function remember(entry) {
  consults.push(entry)
  if (consults.length > CONSULT_KEEP_LIMIT) consults.shift()
}

export function loadRecentConsults() {
  cacheReady ??= (async () => {
    for await (const entry of readJournal()) remember(entry)
  })().catch(e => noteErr('consult-read', e))
  return cacheReady
}

export function recordConsult(entry) {
  remember(entry)
  // Serialize writes so cursor order matches submission order. An error must not
  // reject the POST or prevent later entries from being appended.
  writes = writes.then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(entry)}\n`, { flag: appendFlags, mode: 0o600 })
  }).catch(e => noteErr('consult-append', e))
}

export async function consultsSince(since) {
  const at = /^\d+$/.test(since) ? Number(since) : /^\d{4}-\d{2}-\d{2}T/.test(since) ? Date.parse(since) : NaN
  const byTime = Number.isFinite(at)
  let found = byTime
  const result = []
  await writes
  for await (const entry of readJournal()) {
    if (byTime ? entry.at > at : found) result.push(entry)
    else if (!byTime && entry.id === since) found = true
  }
  return found ? result : null
}

export async function consultsForTask(taskId) {
  await writes
  const result = []
  for await (const entry of readJournal()) {
    if (entry.taskId === taskId) result.push(entry)
  }
  return result
}

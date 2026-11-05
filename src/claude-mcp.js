// src/claude-mcp.js —— Claude 引擎的 MCP 配置文件读写（--mcp-config 的数据源）
//
// 启用的服务器：~/.dsh/second-engine/claude-mcp.json   { mcpServers: { <name>: { type:'http', url } } }
// 停用的服务器：~/.dsh/second-engine/claude-mcp.disabled.json（同结构，不会传给 claude）
//
// 为什么停用要搬到旁路文件：`claude --help` 只说 --mcp-config 接受 JSON 文件/字符串，
// 没有文档化条目级 enabled 字段，往条目里塞未知字段可能被 schema 校验拒掉。
// 所以「停用 = 搬到 disabled 文件，启用 = 搬回」，传给 claude 的文件里永远只有启用项。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const CLAUDE_MCP_PATH = join(homedir(), '.dsh', 'second-engine', 'claude-mcp.json')
export const CLAUDE_MCP_DISABLED_PATH = join(homedir(), '.dsh', 'second-engine', 'claude-mcp.disabled.json')

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// 读：文件不存在 → 空；坏 JSON / 结构不对 → 抛错（写路径不能拿空基线覆盖用户配置）
function readBag(path) {
  const bag = Object.create(null)
  if (!existsSync(path)) return bag
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path} 结构不对（顶层不是对象），已中止`)
  const src = doc.mcpServers
  if (src === undefined) return bag
  if (src === null || typeof src !== 'object' || Array.isArray(src)) throw new Error(`${path} 的 mcpServers 不是对象，已中止`)
  for (const k of Object.keys(src)) bag[k] = src[k]
  return bag
}

function writeBag(path, bag) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, JSON.stringify({ mcpServers: { ...bag } }, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  try { renameSync(tmp, path) }
  catch (e) { try { unlinkSync(tmp) } catch { /* best effort */ } throw e }
}

// 进程内串行队列：并发 add 的查重与写入必须在同一临界区，否则后者静默覆盖前者
let queue = Promise.resolve()
function locked(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function describe(one) {
  const o = one !== null && typeof one === 'object' ? one : {}
  if (typeof o.url === 'string' && o.url !== '') return o.url
  if (typeof o.command === 'string' && o.command !== '') return `stdio: ${o.command}`
  return ''
}

/** 列表（含停用项），形状与 Codex/Pi 一致：[{ name, url, enabled }]。文件不存在 → []。 */
export function listClaudeMcp() {
  const out = []
  for (const [path, enabled] of [[CLAUDE_MCP_PATH, true], [CLAUDE_MCP_DISABLED_PATH, false]]) {
    const bag = readBag(path)
    for (const name of Object.keys(bag)) out.push({ name, url: describe(bag[name]), enabled })
  }
  return out
}

/** 新增；重名（启用/停用任一侧）→ { status:409 }。 */
export function addClaudeMcp(name, url) {
  return locked(() => {
    const on = readBag(CLAUDE_MCP_PATH)
    const off = readBag(CLAUDE_MCP_DISABLED_PATH)
    if (has(on, name) || has(off, name)) return { status: 409, error: `已存在同名 MCP 服务器 '${name}'` }
    on[name] = { type: 'http', url }
    writeBag(CLAUDE_MCP_PATH, on)
    return { ok: true }
  })
}

/** 删除；不存在 → { status:404 }。 */
export function removeClaudeMcp(name) {
  return locked(() => {
    const on = readBag(CLAUDE_MCP_PATH)
    const off = readBag(CLAUDE_MCP_DISABLED_PATH)
    if (has(on, name)) { delete on[name]; writeBag(CLAUDE_MCP_PATH, on); return { ok: true } }
    if (has(off, name)) { delete off[name]; writeBag(CLAUDE_MCP_DISABLED_PATH, off); return { ok: true } }
    return { status: 404, error: `未找到 MCP 服务器 '${name}'` }
  })
}

/** 启停：在两个文件间搬条目；已处于目标状态 → 幂等成功；不存在 → { status:404 }。 */
export function toggleClaudeMcp(name, enabled) {
  return locked(() => {
    const on = readBag(CLAUDE_MCP_PATH)
    const off = readBag(CLAUDE_MCP_DISABLED_PATH)
    const [from, to, fromPath, toPath] = enabled
      ? [off, on, CLAUDE_MCP_DISABLED_PATH, CLAUDE_MCP_PATH]
      : [on, off, CLAUDE_MCP_PATH, CLAUDE_MCP_DISABLED_PATH]
    if (has(to, name)) return { ok: true }
    if (!has(from, name)) return { status: 404, error: `未找到 MCP 服务器 '${name}'` }
    to[name] = from[name]
    delete from[name]
    // 先写目标再删源：中途失败最多出现重复条目，不会丢配置
    writeBag(toPath, to)
    writeBag(fromPath, from)
    return { ok: true }
  })
}

/** 供 claude-args 用：文件存在才返回路径，否则 null（不配 MCP 的人不挂空文件）。 */
export function claudeMcpConfigPath() {
  return existsSync(CLAUDE_MCP_PATH) ? CLAUDE_MCP_PATH : null
}

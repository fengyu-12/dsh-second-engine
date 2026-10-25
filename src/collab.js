// collab.js —— 协作模式两位（voice「允许提议」 / longtask「长会话」）的存储与解析。
// 抽成独立模块（2026-10-25）：纯函数 + 自带文件 IO，node -e 即可单测，
// 不必靠重启 DSH 宿主验证；index.js 只消费，不重复实现。
// 优先级每位独立：env > file > default（与 execMode 的 mode.txt 同风格）。
//   env：SECOND_ENGINE_VOICE（旧值 voice/ask/off 自动映射）/ SECOND_ENGINE_LONGTASK
//   file：~/.dsh/second-engine-collab.txt 两行 key=value
//   default：voice=off、longtask=manual
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 用 process.env.HOME 而非 os.homedir()：测试可用 HOME=/tmp/... 隔离，不碰真实 ~/.dsh。
export const COLLAB_PATH = join(process.env.HOME || '/root', '.dsh', 'second-engine-collab.txt')

const VOICE_VALUES = ['on', 'off']
const LONGTASK_VALUES = ['auto', 'manual']
// SECOND_ENGINE_VOICE 旧三值映射（voice 段曾是 ask/voice/off 三档）；新值 on 原样收。
const VOICE_ENV_MAP = { on: 'on', voice: 'on', ask: 'off', off: 'off' }

// 读文件：两行 key=value；# 注释与未知键忽略；文件缺失/损坏一律返回 {}（不抛）。
export function readCollabFile() {
  let text = ''
  try { text = readFileSync(COLLAB_PATH, 'utf8') } catch { return {} }
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)\s*$/.exec(line)
    if (m === null) continue
    if (m[1] === 'voice' && VOICE_VALUES.includes(m[2])) out.voice = m[2]
    else if (m[1] === 'longtask' && LONGTASK_VALUES.includes(m[2])) out.longtask = m[2]
  }
  return out
}

// 生效值 + 每位各自的来源（env/file/default）；非法 env 值视为未设置。
export function resolveCollab() {
  const file = readCollabFile()
  const voiceEnv = VOICE_ENV_MAP[String(process.env.SECOND_ENGINE_VOICE ?? '').trim().toLowerCase()]
  const longRaw = String(process.env.SECOND_ENGINE_LONGTASK ?? '').trim().toLowerCase()
  const longEnv = LONGTASK_VALUES.includes(longRaw) ? longRaw : undefined
  const voice = voiceEnv ?? file.voice ?? 'off'
  const longtask = longEnv ?? file.longtask ?? 'manual'
  return {
    voice,
    longtask,
    voiceSource: voiceEnv !== undefined ? 'env' : (file.voice !== undefined ? 'file' : 'default'),
    longtaskSource: longEnv !== undefined ? 'env' : (file.longtask !== undefined ? 'file' : 'default'),
  }
}

// 两位 → 预设（唯一派生点，客户端只渲染不计算）：
// review=off/manual · propose=on/manual · longtask=on/auto · custom=off/auto（第四组合）。
export function collabPreset(bits) {
  const v = bits?.voice === 'on' ? 'on' : 'off'
  const l = bits?.longtask === 'auto' ? 'auto' : 'manual'
  if (v === 'off' && l === 'manual') return 'review'
  if (v === 'on' && l === 'manual') return 'propose'
  if (v === 'on' && l === 'auto') return 'longtask'
  return 'custom'
}

// 整文件一次写（预设切换=两位同时翻转，单文件原子）；bits 归一化后落盘并回写生效值。
export function writeCollab(bits) {
  const voice = bits?.voice === 'on' ? 'on' : 'off'
  const longtask = bits?.longtask === 'auto' ? 'auto' : 'manual'
  const text = `voice=${voice}\nlongtask=${longtask}\n`
  mkdirSync(dirname(COLLAB_PATH), { recursive: true })
  const tmp = `${COLLAB_PATH}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  try {
    renameSync(tmp, COLLAB_PATH)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw e
  }
  return { voice, longtask }
}

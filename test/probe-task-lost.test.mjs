// test/probe-task-lost.test.mjs —— Pi 失联检测的「死代码分支」回归（2026-11-07）
//
// 为什么单独测：3.8.9 的教训是 childPid 初值 null 让整个 activityAt 兜底分支变成死代码，
// 而这条分支恰恰是 pid 缺失时的唯一失联判据。用 vm 从 index.js 切片注入（与
// tests/board-process-sweep.mjs 同一模式），不初始化宿主、不碰凭据。
import * as fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = fs.readFileSync(join(root, 'src/index.js'), 'utf8')
const start = source.indexOf('function probeTaskLost(')
const end = source.indexOf('// 一轮对账')
assert.ok(start > 0 && end > start, 'probeTaskLost 切片边界失效（函数被改名或移动了？）')
const code = source.slice(start, end)
const context = vm.createContext({
  process: { kill: process.kill.bind(process) },
  Number, Date,
  WATCHDOG_STALL_MS: 300000,
  readProcStartTime: () => null,
  rtOf: (t) => t.rt,
})
vm.runInContext(code, context)
const probe = vm.runInContext('probeTaskLost', context)

const fakeRt = (pid) => ({ getChildPid: () => pid, getChildStart: () => null })

test('pid 非整数 + activityAt 过期 → activity-stale（死代码分支必须活着）', () => {
  assert.equal(probe({ rt: fakeRt(null), activityAt: Date.now() - 400000 }), 'activity-stale')
})

test('pid 非整数 + activityAt 新鲜 → null（不误杀）', () => {
  assert.equal(probe({ rt: fakeRt(null), activityAt: Date.now() - 1000 }), null)
})

test('pid 存活 → null', () => {
  assert.equal(probe({ rt: fakeRt(process.pid), activityAt: 0 }), null)
})

test('pid 已死 → process-gone', () => {
  const dead = 2 ** 22 - 1  // 本机 pid_max 内、必然不存在的 pid
  assert.equal(probe({ rt: fakeRt(dead), activityAt: 0 }), 'process-gone')
})

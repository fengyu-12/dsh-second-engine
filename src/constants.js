// src/constants.js — 跨模块共享常量（2026-11-02 从 index.js 拆出）
// 路径常量在此自包含定义，避免 core.js → constants.js → index.js 的循环依赖。
import { join } from 'node:path'
import { homedir } from 'node:os'

export const WIRE_API = 'responses'

export const CODEX_DIR = join(homedir(), '.codex')

export const CONFIG_PATH = join(CODEX_DIR, 'config.toml')

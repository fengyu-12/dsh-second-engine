// state.js —— 跨组共享的模块态（拆分交接见 split-brief.md 目标布局）。
// 这里只放**真正跨组**的东西：本文件存在的唯一理由，是让 cleanup.js 这类叶子模块
// 不再反向 import index.js（ESM 循环依赖拿不到 index.js 的绑定）。
//
// ⚠ 已搬 REVIEWS_DIR 与 tasks/TASK_KEEP_LIMIT（2026-11-03 第二刀）。
import { join } from 'node:path'
import { CODEX_DIR } from './constants.js'

// 复核记录目录（原 index.js L268，逐字未改）。
// 组外调用点：persistReviewRecord（mkdirSync / atomicWriteFileSync）、
//             loadReviewRecord（readFileSync）、handleReviewsList（readdirSync）。
export const REVIEWS_DIR = join(CODEX_DIR, 'reviews')

// 任务表（原 index.js L189）：Map 实例，**从不重新赋值**，跨模块共享靠原地修改
// （set/delete/size 天然共享，无 ESM 只读绑定问题）。
export const tasks = new Map()

// 进程内任务保留上限（原 index.js L192）。
export const TASK_KEEP_LIMIT = 50

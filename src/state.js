// state.js —— 跨组共享的模块态（拆分交接见 split-brief.md 目标布局）。
// 这里只放**真正跨组**的东西：本文件存在的唯一理由，是让 cleanup.js 这类叶子模块
// 不再反向 import index.js（ESM 循环依赖拿不到 index.js 的绑定）。
//
// ⚠ 只搬了 REVIEWS_DIR。tasks（原 index.js L178）仍是 index.js 的模块态 ——
//   它被组外 23 处读写，全量迁移是独立的一刀，本刀没动。
import { join } from 'node:path'
import { CODEX_DIR } from './constants.js'

// 复核记录目录（原 index.js L268，逐字未改）。
// 组外调用点：persistReviewRecord（mkdirSync / atomicWriteFileSync）、
//             loadReviewRecord（readFileSync）、handleReviewsList（readdirSync）。
export const REVIEWS_DIR = join(CODEX_DIR, 'reviews')

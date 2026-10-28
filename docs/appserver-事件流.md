# app-server 执行层（`codex exec` → `app-server` 长连接）· 设计规格

> 本文是该模块的设计规格（要解决什么 / 怎么设计 / 怎么验收），实现见 `src/app-server-client.js`。

## 1. 要解决什么（现象 + 证据）

- 现状：插件原用 `codex exec` **一次性子进程** 跑工单 → **无中间进度、不能打断**。
- 证据（2026-09-27 实测）：一条工单 **12 分钟零输出**，进程活着、`-o` 输出文件从未生成，
  只能靠插件的 300s 看门狗标 `stuckSuspect`；同 provider 的 CLI 直连也出现
  `Reconnecting 5/5 → stream disconnected`。
- 实测（codex 0.158.0）app-server 能提供：`turn/started`、`item/started|completed`（reasoning / agentMessage /
  commandExecution）、`item/agentMessage/delta`、`item/commandExecution/outputDelta`、
  `thread/tokenUsage/updated`、`turn/completed`、以及 `turn/interrupt`。

## 2. 怎么设计（改哪个文件、怎么回退）

- 新增 **`src/app-server-client.js`**：stdio JSON-RPC 客户端 ——
  `initialize` → `initialized` → `thread/start` → `turn/start` → 消费事件流 → 等 `turn/completed`；
  暴露 `interrupt(turnId)`。零新增依赖（Node 原生子进程 + readline）。
- 工单执行加开关 **`SECOND_ENGINE_EXEC_MODE=exec|appserver`**：默认仍 `exec`，验收通过后再切默认。
- **事件归一化**：把 app-server 事件映射为内部统一进度事件
  `{kind, text, tool, usage, done}`，由 `GET /api/task?id=` 的进度字段对外暴露。
- **流控 / 心跳**：turn 进行中每 N 秒刷新一次心跳（更新输出文件 mtime 或心跳字段）；
  看门狗判据从「300s 无输出变化」改为「连续 3 次无心跳」。
- **回退**：① 开关切回 `exec`（旧路径零改动保留）；② 文件级回退 = 删除新增文件 + 开关置 `exec`。

## 3. 怎么验收（可观测判据，缺一不算完成）

1. 走 app-server 派一条真实工单，**运行中** `GET /api/task?id=` 能看到**流式进度**（非零输出）；
2. `POST /api/task/cancel` 能**真打断**（进程退出、状态 `cancelled`/`error`，不残留子进程）；
3. `SECOND_ENGINE_EXEC_MODE=exec` 时**旧行为完全不变**（回归）；
4. DSH 插件依赖自检（`dsh-dep-check`）**全绿**；
5. 判据可复现（命令 + 期望输出写进结果）。

## 4. 当时的分工（写范围不重叠）

| 谁 | 做什么 | 写范围 |
|---|---|---|
| 主 AI | app-server 客户端 + 开关 + 事件归一化 + 心跳 + 集成验收 | `src/` |
| 第二引擎 | ① 产出「事件类型 → 归一化字段」映射表 ② 实现后独立复核（读 diff、跑判据、提异议） | 仅映射表文件 |

# ref · Pi 引擎现场（路径 / 事件格式 / 桥 / 版本 / 配置）

> 入口：`SKILL.md`「要 Pi 的路径、事件格式、桥端口、能力契约、清理目标时」。
> 路径与事件格式都是本机跑出来的，不是文档抄的。

## 1. 路径对照（插件支持 `engine=codex|pi` 切换，开关文件 `~/.dsh/second-engine-engine.txt`）

Pi 不是 Codex，**下面每个路径都不同**：

| 用途 | Codex | Pi |
|---|---|---|
| 模型清单 | `~/.codex/config.toml` | `~/.pi/agent/models.json`（`{providers:{<id>:{baseUrl,api,apiKey,models:[{id}]}}}`）|
| 默认模型 | 同上 | `~/.pi/agent/settings.json` → `defaultProvider` / `defaultModel` |
| MCP | `config.toml` 的 `[mcp_servers.*]` | `~/.pi/agent/mcp.json`（`{mcpServers:{name:{url}|{command,args}}}`，禁用写 `enabled:false`）|
| 会话 | `~/.codex/sessions` | `~/.pi/agent/sessions/<cwd>/*.jsonl` |
| 模型缓存 | — | `~/.pi/agent/models-store.json` |
| 聊天桥 | 8787 附近，`ctl.sh` | **8788**，`bridge/pi/server.mjs`（自己管 `pi --mode rpc`）|

## 2. 装法与工作区（这三件决定"它到底在哪工作"）

- 装：`npm i -g @earendil-works/pi-coding-agent`（v1.4.0，约 22 MB，Node 直跑）。凭据按 `<PROVIDER>_API_KEY` 取，模型直接复用已有 key，不必再装第二个重型 CLI。
- **桥默认工作区 `~/pi-workspace`**，`PI_BRIDGE_CWD` 可覆盖；刻意不与 Codex 的工程目录混用（会话、AGENTS.md 都跟着走）——**不要复用 Codex 的 `~/proj`**。
- 因此 **Pi 会话落在 `~/.pi/agent/sessions/<该 cwd>/`** —— 找某次 Pi 会话要先确认当时桥的 cwd，不是全局一个目录。同理 AGENTS.md 按 cwd 逐级向上找，全局那份在 `~/.pi/agent/AGENTS.md`。
- **会话落盘**：桥原来带 `--no-session`（网页对话不落盘）。去掉了，桥会话与 CLI 同源落 `~/.pi/agent/sessions/<cwd>/`。**桥的 cwd = 工作区**（`PI_BRIDGE_CWD`，默认 `~/pi-workspace`），它同时决定会话分区与项目级 AGENTS.md 的向上查找起点。

## 3. 只能实测才知道的事实

1. **流式文本在 `message_update.assistantMessageEvent`**：`{type:'text_delta', delta:'你好'}`。`raw.message` 是空的（PiHub 0.4.0 就按 `raw.message` 读，对 Pi 1.4.0 拿不到增量）。结束信号用 `agent_settled`（比 `agent_end` 晚，带 `aborted`）。
2. **`get_available_models` 返回全局清单**：每项带 `provider` 字段，不按它过滤就会把别家的模型混进来（真实事故：拉 DeepSeek 出现 glm-5.3）。
3. **Pi 没有 `web_search`**：内置工具只有 read/bash/powershell/edit/write/grep/find/ls（+codemode/tool_search），联网走 MCP。别把 Codex 的 `web_search` 开关套上去。
4. **完成判定：`agent_settled` 就是本轮终点（2026-10-31 定，Pi 自证包内源码 + 实机验证）**。包内 `dist/core/agent-session.js` 的 `_startRun()` 在 `finally` 里 emit，**一次 prompt 只 emit 一次 settle**（正常/重试/压缩恢复/抛错都只一次，`abort` 也走这条）。⇒ settle 到达后 **1.5s drain**（被 `agent_start` 取消）即 `finalize`，**不等进程退出** —— `pi --mode rpc` 是长驻进程永不退，等它就永远 running（2026-10-31 实机复现：跑完 4 分钟仍 `running`、`output` 却已有 10,098 字符）。**成败不看 settle**，看最后一条 assistant message 的 `stopReason`：**只有 `stop` 算成功**（正向白名单），`aborted` 归取消，其余一律 `exitCode:-1` + 「未识别的终态 stopReason=」。⚠️ **别用黑名单**（只认 `error`/`length` 判失败）—— `pending`/`deferred`/空值/将来新增的枚举会被静默记成成功，那是"把不知道写成没问题"。

## 4. 桥的进程 pid 不写在日志里

`[pi-bridge] … pid=NNNN` 那个是 **pi 子进程**，不是桥进程。按它 kill 会「桥还在、子进程死」→ prompt 永远超时 + 新进程 `EADDRINUSE`。桥的真实 pid 只能按 `/proc/*/cmdline` 精确匹配（`argv[0]` 以 `node` 结尾 且 `argv[1]` 以 `bridge/pi/server.mjs` 结尾）。

## 5. 聊天桥前端契约（复用 `bridge/web/public/index.html`，与 Codex 桥同一个页面）

- `/api/send` 必须回 **NDJSON 流**，逐行 `{kind:'meta'|'text'|'activity'}`，收尾 `{kind:'end'}`；回一次性 JSON 会让界面**静默无反应**。
- 页面还需要 token：不带 `?t=` 时靠 302 到 `/?t=local` 种进 localStorage，否则红条「没有 token」且禁止发送。
- **引擎身份探针**：`GET /api/health` → `GET /api/config` 双探针（Codex 桥 health 无 `engine` 字段，只能当连通性兜底）；`engineName` 决定 AI 署名与空态；`codex-env` 提示仅 Codex 显示。
- **`data-skin=codex/claude` 是配色皮肤名，与引擎无关，一律不改**。

## 6. 能力契约：唯一判据，且单点定义

`src/engine/registry.js` 的 `capabilities` → 出口 `src/index.js engineView()`（`/status`、`/config` 共用）→ 前端 `lib/client.js:418` 兜底 → 桥页面。

Pi 的值：`chatBridge:true` + `chatBridgeMode:'pi-rpc'`、`mcp:'pi-config'`、`webSearch:false`、`versionCheck:'npm'`、`review:false`、`resume:false`。**别新增第二份能力表。**

### 四个已踩的判据坑

1. `chatBridge` 语义 = **用户能不能用桥**，不是"怎么实现"。Pi 原来写 `false`（注释"自带 15+ provider 不需要桥"），但 Pi 桥实际可用（8788 + `bridge-routes.js` 有 lifecycle）——按它隐藏桥卡 = 藏掉能用的功能。形态差异放进 `chatBridgeMode`。
2. **清理目标不放 capabilities**：`resume` 描述"能否续会话"，与"删哪个目录"无因果关系；用独立 `cleanup: {dir, filePattern, appliesToEngine, confirmRequired}`（`registry.CLEANUP_TARGETS` 唯一来源，Codex=`~/.codex/sessions`，Pi=`~/.pi/agent/sessions`）。**错引擎一律 409**（响应带 `engineMismatch: {active, expected}`，不动任何文件）——两边的清理接口不共用，别拿 Codex 的接口清 Pi。
3. **MCP 与 `modelSwitch` 是两个维度**：Pi 的 MCP 在 `~/.pi/agent/mcp.json`、后端已映射成 Codex 形状（可编辑）；按 `modelSwitch==='runtime-command'` 隐藏 = 藏掉可编辑的 MCP。
4. **Pi 下只有复核不可用**（复核硬绑 `codex exec`）：浮球按引擎只隐藏**复核卡**、显示一句说明。**工单是可用的**——2026-10-31 核实：后端 `startPiTask` 一直都支持 API 派单，是前端把整块工单区拦掉了，造成「派了单却看不见、完成也没通知」。已放开，并配套三处：隐藏 Pi 无意义的「保留会话」勾选（Pi 恒 `--no-session`）、placeholder 按引擎改文案、任务卡加 `Pi`/`Cx` 引擎标签（缺 `engine` 字段时**不标**，绝不默认成 `Cx`）。

## 7. AGENTS.md 双写

`ensureAgentsProtocol` / `BoardProtocol` / `VoiceProtocol` 现在对 `[~/.codex/AGENTS.md, ~/.pi/agent/AGENTS.md]` 各写一份；写 Pi 那份时用 `agentsSectionFor()` 把标题与 `"from":"codex"` 换成 Pi 身份（其余文案通用）。

Pi 的 AGENTS.md 规则：全局 = `agentDir/AGENTS.md`，项目级 = 从 cwd 向上逐级找 `AGENTS.override.md/AGENTS.md/CLAUDE.md`；另有 `SYSTEM.md`、`APPEND_SYSTEM.md`（项目级要 trusted）。

## 8. 版本检查按引擎分流

`GET /api/version` 在 Codex 下查 GitHub release，Pi 下查 npm registry（`@earendil-works/pi-coding-agent`），返回同形状 `{engine,current,latest,updateAvailable,htmlUrl}`；面板与浮球同款三档徽标（已是最新 / 有新版 x.y.z → / 检查失败）。**Pi 也要显示版本行**（曾按"不需要提示"删过，用户要回来）。

## 9. 模型真源优先序

Pi = runtime `get_state`（Pi 桥 `/api/runtime-settings`）→ 配置默认（`resolvePiProvider`）→ 空值 + `fallback:true`；返回带 `source: runtime|config|keyring|none`。`fallback` 只表示"没有可验证的 runtime 值，显示的是配置默认"，不要泛用。

## 10. UI 缺陷修复记录（别再按旧现象推断引擎能力）

> 判据：**引擎能力看 CLI/配置文件，不看 Web 控件列几个**。⚠️ **2026-10-30 更新**：那个「下拉只显示当前值」的 UI 缺陷**已修复**（`bridge/web/server.mjs` 的 `/api/runtime-settings` 现返回 `models`，实测宿主 `/api/models` 返 15 个）。

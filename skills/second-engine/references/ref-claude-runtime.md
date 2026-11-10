# Claude Code 运行时现场（第三引擎）

> 2026-11-06 接入完成时实测。所有结论都对应本机实况，换机或换版本要重验。

## 身份与路径

| 项 | 值 |
|---|---|
| 二进制 | `/usr/local/bin/claude`（v2.1.318，npm 平台包） |
| runtime | `src/engine/claude-{runtime,args,protocol}.js`（协议层 / 参数层 / 生命周期分开，合计约 390 行） |
| 登记 | `src/engine/registry.js` 的 `ENGINES.claude` + `CLEANUP_TARGETS.claude` |
| provider 存储 | `~/.dsh/second-engine/claude-providers.json` |
| 模型文件 | `~/.dsh/second-engine/claude-model.txt`（与插件 `handleProviderModel` 同一份） |
| 工作区 | `~/claude-workspace`（`--add-dir` 只给这个目录） |
| 全局记忆 | `~/.claude/CLAUDE.md`（**实测它同时读这个文件和工作目录的 `AGENTS.md`**） |
| 会话落盘 | `~/.claude/projects/<cwd 编码>/*.jsonl`，**两层目录**，一个文件一个 session |

## 启动参数三条硬约束（`src/engine/claude-args.js`）

- root 下 `--permission-mode bypassPermissions` **被直接拒绝**（`cannot be used with root/sudo privileges`）⇒ 只能用 `acceptEdits`
- `--output-format stream-json` **必须配 `--verbose`**，否则报错退出
- `--add-dir` **只授权、不改 cwd**（实测 pwd 仍是 `/`）⇒ 提示词里写绝对路径
- 提示词经 **stdin** 送、不进 argv（2026-11-07 改）⇒ `/proc/<pid>/cmdline` 里看不到工单正文

## 五个踩过的坑

1. **`doc.active` 是 id，不是条目的布尔 `active`** —— 按布尔找会回落 `providers[0]`，出现「provider 显示 DeepSeek、模型列表却是中转的 claude-*」的错配。
2. **`--model` / `--effort` 都是启动参数** —— 改了必须重建进程；且 `start()` 里不能写 `state.model = cred.model`，否则每次重建都切回默认（下拉看着改了、实际没变）。
3. **会话目录两层** —— `~/.claude/projects/<-root-claude-workspace>/<uuid>.jsonl`；只扫顶层统计恒为 0，清理/统计都要递归。
4. **前端「新会话」只清屏 + `threadId=null`** —— 桥收到 `null` 必须真的重开（Claude：重建进程；Pi：`new_session`；Codex：`thread/start`）。历史 id 是 UUID，占位串 `claude-session` 不是可 resume 的 id。
5. **身份文案要三值化** —— `agentsSectionFor()` 原来只有 Pi 分支，Claude 的 `CLAUDE.md` 会落进 Codex 分支，标题与 consult 的 `from` 都写成 codex。

## 能力与验收

- `capabilities`（`registry.js`）：`executor{events,cancel}` / `eventStream:'fine'` / `resume:true` / `review:true` / `chatBridge:true` / `modelSwitch:'flag'` / `versionCheck:'npm'` / `mcp:'flag'` / `webSearch:true` / `approvals:false`
- **外部事实验收**：`src/engine/claude-verify.js` —— 只有「git 改动 / 新文件（递归扫，跳过 node_modules、.git）/ 成对 tool_use+tool_result」三者之一成立才算 done，否则改 `error` 并在 output 末尾写原因。
  ⚠️ **必须放在 `finalizeJob` 之后**：finalizeJob 会用 `-o` 文件覆盖 `task.output`，先追加会被冲掉（2026-11-06 实测踩到）。
- **能力位要真生效**：`--effort` 只在启动时传；`MAX_THINKING_TOKENS` 控制思考 token 预算（0 = 关，但 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 不让关）。

## 聊天桥（8789）

- 进程：`bridge/claude/server.mjs`（独立进程，`CLAUDE_BRIDGE_PORT` 可覆盖，pid 落 `~/.dsh/second-engine/claude-bridge.pid`）
- 协议：`claude -p --input-format stream-json --output-format stream-json --verbose` 的**双向 NDJSON**；实测收第一行后不退出、两轮同一 session_id、关 stdin 后 rc=0
- 页面：复用 Pi/Codex 的 `bridge/web/public/index.html`（Pi 就是这么接的：一行 `readFileSync`）
- 端点契约：`/api/health`、`/api/config`、`/api/runtime-settings`、`/api/lock-info`、`/api/stamp`、`/api/threads`、`/api/transcript`、`/api/send`（NDJSON：`meta`→`text`→`end`）、`/api/stop`、`/api/events`（SSE）
- 两个必须处理的事件特征：`system/thinking_tokens` 单轮数百条（按 250ms 合并）；每轮重发 `system/init`（session 不变，记 turn 边界）
- **thinking 未接**：落盘 jsonl 与 stream 的 `assistant.message.content[].type=='thinking'` 有内容（实测一轮 488 字符），但桥只转 `text` 块；要显示得映射成前端的 `act` 条目
- 重启 Web 会带走桥进程 → 插件用 `claude-bridge.enabled` 记用户意图，`apply()` 时自恢复

## 已知遗留

- MCP 配置界面未做（后端只回 501/空，派单不转 `--mcp-config`）
- 团队/子代理工具（`Task`/`Workflow`/`SendMessage` 等）靠 `--allowedTools` 白名单排除，白名单只放 `Read,Write,Edit,Bash`

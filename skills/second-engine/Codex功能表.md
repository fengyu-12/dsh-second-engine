# Codex 功能表（只记对第二引擎有用的）

> **用途**：不用每次去翻 GitHub release notes，需要什么能力直接查这张表。
> **维护**：每次升级 Codex 后跑 §4 的检查清单，把新增/移除补进 §3，把开关变化补进 §1。
> **当前版本**：`0.160.0`（2026-10-02）
> **二进制**：musl 静态单文件，软链进 PATH 即可（本插件不依赖固定安装路径）。
> **升级方式**：走 npmmirror 的 npm 平台包 `@openai/codex@<版本>-linux-arm64`（带官方 sha512）；
> GitHub 直连易超时、部分镜像站内容可能损坏，装前务必核对 sha512。

---

## 1. 建议显式启用的 feature

这些**不在** Codex 默认值里，需要显式打开；`config.toml` 的 `[features]` 段被谁重写丢掉就会静默失效。

| feature | 稳定性 | 作用 | 对我们的意义 |
|---|---|---|---|
| `multi_agent_v2` | stable | 协作工具命名空间化：`spawn_agent` / `followup_task` / `send_message` / `wait_agent` / `interrupt_agent` / `list_agents` | Codex 自己也能分身并行 |
| `memories` | stable | 长期记忆：会话闲置后「摘要→整合」再注入 | 长任务跨会话保持上下文 |
| `network_proxy` | experimental | 沙箱网络管控（`permissions.network.*`） | ⚠️ **只开开关、不配 permissions** —— 配成 `limited` + 空白名单会直接断掉 provider/MCP/DNS |
| `recommended_plugins` | stable | 挂载推荐插件 | 实测无可见效果，按需保留 |

**默认就开着、且我们依赖的**：`multi_agent`、`shell_tool`、`shell_snapshot`、`unified_exec`、`plugins`、`plugin_sharing`、`skill_search`、`skill_mcp_dependency_install`、`tool_suggest`、`view_image`、`worktrees`、`fast_mode`、`hooks`、`goals`、`apps`、`code_mode_host`、`browser_use*`、`computer_use`、`guardian_*`、`image_generation`。

**明确保持关闭的**：

| feature | 为什么不开 |
|---|---|
| `prevent_idle_sleep` | 无 D-Bus 的环境（部分容器 / proot）里 `systemd-inhibit` 会报 `Failed to connect to bus`，开了也没用 |
| `secret_auth_storage` | 只针对 Windows Credential Manager |
| `analytics_plan_history` | 只服务 ChatGPT 消费者计划用量，受 account plan 门控 |

---

## 2. 能力面速查（按用途）

### 派活 / 操控第二引擎

```bash
codex exec "工单"                       # 非交互单发（下工单用这个）
codex exec --json "..." > out.json      # 结构化输出
codex exec resume <完整36位UUID> "..."  # 续会话；8 位前缀会被当作"按名字找"→静默新建
codex app-server                        # JSON-RPC 长连接（插件 appserver 模式的底座，可看流式进度）
codex mcp-server                        # 反过来把 Codex 本身当 MCP server
codex review --uncommitted|--base|--commit   # 三种审查范围
```

插件侧统一走 `$DSH_WEB_URL/second-engine/api/*`（面板 / 工单 / 互审 / 熔断）。

### 扩展

```bash
codex mcp list|get|add|remove|login|logout    # 外部 MCP 服务器
codex plugin ...                              # 插件市场（free-search-mcp 走这条）
codex features list | enable <名> | disable <名>   # ⚠️ 一次只能给一个名字
codex doctor                                  # 一站式环境诊断：OS/provider 连通/auth storage/sandbox/memories/线程
```

### 沙箱与权限

`-c sandbox_mode=...`（无 Landlock/bwrap 的环境需 `danger-full-access`）、`approval_policy`、`permissions.network.*`。

### 值得知道的非默认 feature（需要时再开）

| feature | 作用 |
|---|---|
| `instant_interrupt` | 新输入可打断并转向正在生成的响应（0.159 新增） |
| `guardianv2` + `guardian_conversation_history_tools` + `guardian_root_handoff_context` | Guardian 审查增强：可检索更早用户指令、纳入 handoff 上下文（0.160 相关） |
| `code_mode` / `code_mode_interrupt` / `code_mode_prewarm` | code mode 相关（默认关） |
| `agent_message_board` | agent 消息板 |
| `chronicle` / `artifact` / `context_management` | 新能力，作用待实测确认 |

> 完整清单（约 165 项，含 `removed` 历史项）直接跑 `codex features list`。

---

## 3. 版本变更日志（只记和我们相关的）

### 0.160.0（2026-10-01）

- **新增**：Guardian review 可检索更早用户指令 + 纳入 agent handoff 上下文；agent command center 历史分页；项目外启动会话（策略允许时）+ resume 恢复已保存权限；X11 中键粘贴
- **修复**：未发送的排队消息在重连后恢复（不再重复发送）；TUI 保留 server provider / reasoning-summary / verbosity 设置；resume/fork 历史显示正确会话；**显式 provider 模型目录不再塞入不支持的 bundled 模型**、刷新失败不再复用陈旧条目；**SQLite 连接与日志卡顿**；子代理保留仍在启动的环境并收到失败原因
- **其他**：缓存 plugin manifest + 复用 HTTP 连接；后台回收日志数据库空间

### 0.159.x（2026-09-29 ~ 30）

- **0.159.0 新增**：`instant_interrupt`（opt-in，可打断并转向）；紧凑欢迎屏；警告查看器关闭即清已读（按 `k` 保留）；决定是否应用计划时可滚动 transcript；Mermaid 渲染支持更多图形/标签/节点组；app-server 可按指定 item 分页 thread 历史
- **0.159.0 修复**：复制 transcript 保留 Markdown 表格与格式；空白会话切换任务保留草稿；已批准命令保留文件系统拒绝
- **0.159.0 安全**：`.aws` 目录默认受保护
- **0.159.0 移除**：自动 follow-up 提示建议 + `tui.prompt_suggestions` 设置；内置 `plugin-creator` skill ← **升级后要检查老配置里有无这些残留**
- **0.159.1**：GPT-6.1 Sol 成为内置目录默认模型
- **0.159.2**：Windows 控制台窗口抑制（backport）
- **0.159.3**：ChatGPT 账号安全设置提醒（backport）

### 0.158.0（2026-09-28）

上一个使用版本，未单独整理 release notes。

---

## 4. 升级后检查清单

```bash
codex --version                                    # 1. 版本对不对
codex features list | grep -v 'false$'             # 2. 启用了哪些（对照 §1）
codex features list | grep -E 'removed'            # 3. 有哪些被移除（老配置可能踩雷）
codex doctor                                       # 4. 环境体检（连通性/auth/sandbox/记忆库）
grep -nE '^\[' ~/.codex/config.toml                # 5. ★配置段是否完整
curl -s "$DSH_WEB_URL/second-engine/api/version"   # 6. 插件侧版本核对
```

### ★ 第 5 条是 2026-10-02 事故换来的

第二引擎插件的 `writeCodexConfig()` 原先只保留 `mcp_servers.*` 一种段。**切一次提供方**就会把 `[features]`、`[tui]`、`[projects.*]` 全部静默丢弃 —— 结果 4 个 feature 开关回到默认 `false`（`multi_agent_v2`、`memories`、`network_proxy`、`recommended_plugins`），项目信任级别也没了，**全程没有任何报错**，只有发现功能失效才会察觉。

修复：`src/index.js` 新增 `extractPreservedSections()`，用的是**黑名单**——只排除模板自有的
`[model_providers.*]` 与 `[memories]`，**其余段一律原样保留**（2026-10-02；最初写成白名单，当天改成黑名单）。

**推论（通用教训）**：任何「按模板重写配置文件」的组件，都要问一句"模板外的段去哪了"——白名单式重写会把不在名单里的用户配置静默抹掉。

---

## 5. 第二引擎插件的三条已知限制（动配置前必读）

### 5.1 `[memories]` 段由插件独占（2026-10-02 起）

`writeCodexConfig()` 会按当前提供方**整段生成** `[memories]`（`extract_model` / `consolidation_model` 跟随顶层 `model`），
该段同时已从 `extractPreservedSections()` 的保留名单里排除——目的是让「切厂商时记忆模型自动同步」，不必每次手改。

> ⚠️ **代价**：你往 `[memories]` 里加的任何其他配置——`max_unused_days`、`generate_memories`、
> `min_rollout_idle_hours` 之类——**会在下一次切换提供方时被整段覆盖掉，且不报错**。
> 想两头都要（模型跟随 + 自定义保留），得把插件改成「段内字段合并」（保留用户键、只覆盖模型两个键），**目前未做**。

### 5.2 插件改动必须重启 Web 才生效

`src/index.js` **没有热加载**。改完不重启，进程里跑的仍是旧代码——2026-10-02 实测：
改完插件但不重启，切提供方照样丢配置段。**顺序：改插件 → 重启 Web → 再验证**，不能省。

### 5.3 `codex exec` 疑似不触发记忆流水线（未确证）

配好 `[memories]` 模型后，经插件下发工单（内部走 `codex exec`）触发过 Codex 启动，`jobs` 表**毫无变化**
→ 记忆流水线没被触发。**推测**它只在交互式/长驻模式启动时跑，**尚未确证**。

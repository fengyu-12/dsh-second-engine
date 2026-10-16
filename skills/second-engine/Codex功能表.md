# Codex 功能表（只记对第二引擎有用的）

> **用途**：不用每次去翻 GitHub release notes，需要什么能力直接查这张表。
> **维护**：每次升级 Codex 后跑 §4 的检查清单，把新增/移除补进 §3，把开关变化补进 §1。
> **当前版本**：`0.163.0`（2026-10-17 升级；回滚物 `/root/codex/*.bak-0.162.1`）
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

**默认就开着、且我们依赖的**：`multi_agent`、`shell_tool`、`shell_snapshot`、`unified_exec`、`plugins`、`plugin_sharing`、`skill_search`、`skill_mcp_dependency_install`、`tool_suggest`、`view_image`、`worktrees`、`fast_mode`、`hooks`、`goals`、`apps`、`code_mode_host`（⚠️ **光开着没用：还必须有 sidecar 可执行文件，否则 `code_mode_only` 的模型工具全废 —— 见 §6**）、`browser_use*`、`computer_use`、`guardian_*`、`image_generation`。

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

## 3. Codex 现版本功能（`0.163.0` · 2026-10-17 拉取）

> **本节的维护方式：主 AI 自己拉** —— **不逐版累积变更日志**（那是无底洞，永远追着上游跑）。每次升级后用 `codex features list` / `codex --help` / 官方 release notes **重新拉一遍整节覆盖**即可。

**交互面**
- `/config` 搜索式设置：跨类别搜索偏好，部分项即时生效并标注哪些需重启
- 响应中可发 follow-up **立即转向**（steer）；中断 turn 会一并停掉活动的 Code Mode cells 及其嵌套工具调用
- `/keymap` 配 leader key（默认 `Ctrl+X`）；语音静音移到 `F9`
- `/daemon` 重启托管后台服务（先警告可能被打断的工作，随后自动重连）
- `/side` 切换线程后回到已有侧会话

**执行面**
- `codex exec` 非交互单发：**不再在无关命令后重复打印同一文件 diff**；本地命令在子进程持有输出管道时及时结束，远程命令保留迟到输出
- **只读工具可并行执行**（含 skill / memory / 会话历史查询）
- `codex queue <消息>` 给已有会话排队 · `codex resume` / `fork`（picker 或 `--last`）
- `codex agents` 浏览本地 app-server 守护上的全部会话
- `codex archive` / `unarchive` / `delete`（delete 永久）· `codex migrate-rollouts` 旧会话迁移到分页历史
- `codex app-server` · `exec-server` · `remote-control` · `cloud`（实验）

**权限与网络**
- 恢复 thread 时**恢复其权限与网络审批**（尊重显式覆盖与当前 managed policy）
- 网络代理：**DNS 查询前**检权限、拒绝重复 `Host` 头、防凭据别名绕过检查钩子

**诊断**
- `codex doctor` 一站式环境体检 · `codex features list|enable|disable` · `codex sandbox` / `debug` / `apply` / `completion`

**模型元数据（第三方 provider 必看）**：codex 内置模型表只含自家模型，第三方模型会退回**兜底窗口**（实测 `glm-5.3-flash` 的 `model_context_window` = `258400`，真值 1M）。用 `config.toml` 顶层的 `model_context_window` / `model_max_output_tokens` 覆盖。

- 主 AI 自己拉

## 4. 升级后检查清单

```bash
codex --version                                    # 1. 版本对不对
codex features list | grep -v 'false$'             # 2. 启用了哪些（对照 §1）
codex features list | grep -E 'removed'            # 3. 有哪些被移除（老配置可能踩雷）
codex doctor                                       # 4. 环境体检（连通性/auth/sandbox/记忆库）
grep -nE '^\[' ~/.codex/config.toml                # 5. ★配置段是否完整
curl -s "$DSH_WEB_URL/second-engine/api/version"   # 6. 插件侧版本核对
ls -l "$(dirname "$(readlink -f "$(command -v codex)")")/codex-code-mode-host"   # 7. ★sidecar 是否在位（见 §6）
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

---

## 6. Code Mode 与 `codex-code-mode-host`（2026-10-04 实测：不装它，GPT 系工具全废）

**现象**：用 `gpt-5.6-terra` / `gpt-6-*` 这类模型下工单，模型能回话，但**工具一个都执行不了**：

```
warning: Code Mode is unavailable because failed to spawn code-mode host
         .../codex-code-mode-host: host executable was not found
ERROR codex_core::tools::router: error=failed to spawn code-mode host ...
```

**机制（`codex debug models` 实测）**：模型元数据里有 `tool_mode` 字段，值为 **`code_mode_only`** 的模型，**所有命令执行都必须经这个独立 sidecar 进程**（长驻、内嵌 V8、gRPC/stdio、带 cell 复用）。内置目录 11 个条目里，**除 `gpt-5.5`（官方定位 "Legacy coding model"，无该字段）外全是 `code_mode_only`**：
`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-daybreak-blue/red-latest`、`codex-auto-review`。

> 该字段**按模型名匹配**，与"模型真假"无关——上游报什么名就走哪条元数据；**别用"要不要 host"推断模型真假**。也不能靠 `features.code_mode_host=false` 绕过：关掉后 exec 直接报 `code-mode host is disabled`（exec 必须走它）。

**为什么常被漏装**：codex 自 **0.144** 起把它改成独立 sidecar（上游 [issue #31906](https://github.com/openai/codex/issues/31906) / [#31831](https://github.com/openai/codex/issues/31831)），而**用 npm 平台包只取主二进制的装法会漏掉它**。0.158.0 同样带该特性（**降版本无用**）。

**修复（已验证，可逆）**：

```bash
# 1) 取本机架构的 sidecar（GitHub release，tag 与 CLI 同版本）
#    ⚠️ GitHub 直连在部分网络不通（30s 零字节）→ 走镜像 + 多连接；断了用 -c 续传
aria2c -c -x 8 -s 8 -k 1M -d /tmp -o cmh.tar.gz \
  "https://ghproxy.net/https://github.com/openai/codex/releases/download/rust-v<版本>/codex-code-mode-host-<arch>-<os>.tar.gz"
tar -xzf /tmp/cmh.tar.gz -C /tmp
# 2) ★放到 codex 主二进制的同目录（同目录即可，无需进 PATH），名字必须是 codex-code-mode-host
install -m 0755 /tmp/codex-code-mode-host-* "$(dirname "$(readlink -f "$(command -v codex)")")/codex-code-mode-host"
```

- 备选通道：npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`（`vendor/<arch>/bin/` 内含它），比 GitHub release 稳。
- **回退**：删掉该文件即回到原状，代价是**所有 `code_mode_only` 模型的工具全废**（`gpt-5.5` 不受影响）。

**验收判据（接任何新 provider / 模型必做）**：让它"建一个文件并运行"，**看文件真不真落盘**——别信回复像不像。回复正确但目录是空的 = 工具链断了。

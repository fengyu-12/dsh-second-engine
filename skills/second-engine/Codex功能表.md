# Codex 功能表（只记对我们有用的）

> **用途**：不用每次去翻 GitHub release notes，需要什么能力直接查这张表。
> **维护**：每次升级 Codex 后跑 §4 的检查清单，把新增/移除补进 §3，把开关变化补进 §1。
> **当前版本**：`0.164.0`（2026-10-25 升级；回滚物 `/root/codex/*.bak-0.163.0`。⚠️ 0.164.0 只跑了工具面 + DSH 依赖点，**执行链未复验**）
> **二进制**：`/root/codex/codex-aarch64-unknown-linux-musl`（musl 静态单文件，`/usr/local/bin/codex` 软链过去）
> **升级方式（2026-10-17 实测修订）**：**GitHub release 直连这次是通的** —— 主二进制 `codex-aarch64-unknown-linux-musl.tar.gz`(~100 MB) + sidecar `codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz`(~26 MB)，`aria2c -x8` 单线程 128 KiB/s → **757 KiB/s**，两分钟下完。**镜像现状变了**：`ghfast.top` **已挂（HTTP 000）**、`ghproxy.net` 200 可用。**⚠️ 网络状态会变，"直连不通"的旧结论不能当现在的判据**（10-10 那条就是这么过期的）。
> **sidecar 必须改名**：解压得到 `codex-code-mode-host-aarch64-unknown-linux-musl`，装进 `/root/codex/` 要改成 **`codex-code-mode-host`**（codex 找的是**无后缀** sibling）；**主 tar 里不含 sidecar**，两份资产要分别下。备选通道仍是 npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`。

---

## 1. 本机已显式启用的 feature

这些**不在** Codex 默认值里，是本机特意开的；`config.toml` 的 `[features]` 段被谁重写丢掉就会静默失效。

| feature | 稳定性 | 作用 | 对我们的意义 |
|---|---|---|---|
| `multi_agent_v2` | stable | 协作工具命名空间化：`spawn_agent` / `followup_task` / `send_message` / `wait_agent` / `interrupt_agent` / `list_agents` | Codex 自己也能分身并行 |
| `memories` | stable | 长期记忆：会话闲置后「摘要→整合」再注入 | 长任务跨会话保持上下文 |
| `network_proxy` | experimental | 沙箱网络管控（`permissions.network.*`） | ⚠️ **故意只开开关、不配 permissions** —— 配成 `limited` + 空白名单会直接断掉 provider/MCP/DNS |
| `recommended_plugins` | stable | 挂载推荐插件 | 实测无可见效果，按用户要求保留 |

**默认就开着、且我们依赖的**：`multi_agent`、`shell_tool`、`shell_snapshot`、`unified_exec`、`plugins`、`plugin_sharing`、`skill_search`、`skill_mcp_dependency_install`、`tool_suggest`、`view_image`、`worktrees`、`fast_mode`、`hooks`、`goals`、`apps`、`code_mode_host`（⚠️ **光开着没用：还必须有 sidecar 可执行文件，否则 `code_mode_only` 的模型工具全废 —— 见 §6**）、`browser_use*`、`computer_use`、`guardian_*`、`image_generation`。

**明确保持关闭的**：

| feature | 为什么不开 |
|---|---|
| `prevent_idle_sleep` | Android proot 无 D-Bus（`systemd-inhibit` 报 `Failed to connect to bus`），开了也没用 |
| `secret_auth_storage` | 只针对 Windows Credential Manager；本机 auth storage = `File` |
| `analytics_plan_history` | 只服务 ChatGPT 消费者计划用量，受 account plan 门控 |

---

## 2. 能力面速查（按用途）

### 派活 / 操控第二引擎

```bash
codex exec "工单"                       # 非交互单发（下工单用这个）
codex exec --json "..." > out.json      # 结构化输出
codex exec resume <完整36位UUID> "..."  # 续会话；8 位前缀会被当作"按名字找"→静默新建
codex app-server                        # JSON-RPC 长连接（插件 appserver 模式的底座，可看流式进度）
codex mcp-server                        # 反过来把 Codex 本身当 MCP server（2026-10-26 复核：0.164.0 --help 已无此子命令，已移除）
codex review --uncommitted|--base|--commit   # 三种审查范围
```

插件侧统一走 `$DSH_WEB_URL/second-engine/api/*`（面板 / 工单 / 互审 / 熔断）；全量路由自取：`curl -s "$DSH_WEB_URL/second-engine/api/_meta"`。

### 扩展

```bash
codex mcp list|get|add|remove|login|logout    # 外部 MCP 服务器
codex plugin ...                              # 插件市场（free-search-mcp 走这条）
codex features list | enable <名> | disable <名>   # ⚠️ 一次只能给一个名字
codex doctor                                  # 一站式环境诊断：OS/provider 连通/auth storage/sandbox/memories/线程
codex queue "消息"                            # 给已有会话排队一条消息（0.163 面已见）
codex agents                                  # 浏览本地 app-server 守护进程上的全部 agent 会话
codex archive|unarchive|delete <id|name>      # 会话归档/恢复/永久删除（delete 是永久）
codex migrate-rollouts                        # 旧会话迁移到分页线程历史
codex remote-control | exec-server | cloud | sandbox | debug   # 0.163 面里已列出的实验/工具子命令
```

### 沙箱与权限

`-c sandbox_mode=...`（本机必须 `danger-full-access`，proot 无 Landlock/bwrap）、`approval_policy`、`permissions.network.*`。

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

## 3. Codex 现版本功能（`0.163.0` · 2026-10-17 拉取 · **0.164.0 已升级但本节未重新拉取，当历史看**）

> **维护方式：主 AI 自己拉 · 不留存历史版本** —— 不逐版累积（没完没了、永远追着上游跑）。每次升级后重新拉一遍**整节覆盖**，只留**当下版本的具体变更与修复**。

**本版变更（0.163.0）**

- **新增**：`/config` 搜索式设置（跨类别搜偏好，部分即时生效并标注哪些需重启）· 响应中可发 follow-up **立即转向**（中断会一并停掉活动的 Code Mode cells 及其嵌套工具调用）· `/keymap` 配 leader key（默认 `Ctrl+X`，语音静音移到 `F9`）· `/daemon` 重启托管后台服务（先警告可能被打断的工作，随后自动重连）· **只读工具可并行执行**（含 skill / memory / 会话历史查询）· `Daybreak` 对符合条件账号默认启用
- **修复**：恢复 thread 时**恢复其权限与网络审批**（尊重显式覆盖与当前 managed policy）· 网络代理**改在 DNS 查询前检权限**、拒绝重复 `Host` 头、防凭据别名绕过检查钩子 · `/side` 切换线程后回到已有侧会话 · **`codex exec` 不再在无关命令后重复打印同一文件 diff** · 本地命令在子进程持有输出管道时及时结束，远程命令保留迟到输出
- **app-server**：新增 prompt prefix 兼容测试 · **全局 config 与启动目录解耦**
- **本机仍未验证**：exec 的 diff 改动在"多文件 / 多轮"下的表现；`Daybreak` 默认启用对本机（走第三方 provider）有无影响

**当前命令面（`codex --help` 实测，供速查）**

```bash
codex exec | resume | fork | queue "<消息>"    # 单发 / 续会话 / 分叉 / 排队
codex agents                                  # 浏览本地 app-server 守护上的全部会话
codex archive | unarchive | delete <id|name>  # 会话归档 / 恢复 / 永久删除
codex migrate-rollouts                        # 旧会话迁移到分页线程历史
codex app-server | exec-server | remote-control | cloud    # 实验
codex doctor                                  # 一站式环境体检
codex features list | enable <名> | disable <名>   # ⚠️ 一次只能给一个名字
codex sandbox | debug | apply | completion
```

**⚠️ 本机实测约束（2026-10-17，别照抄通用文档）**

- **推理档位**：codex 元数据里的枚举是 **6 档**（`low`/`medium`/`high`/`xhigh`/`max`/`ultra`，来自 `codex debug models` 的 `supported_reasoning_levels`）；而**上游智谱 `glm-5.3-flash` 只接受 `low`/`high`/`max`** —— 其余档位（含显式 `none`）都会撞 `该模型始终思考，不支持关闭思考；请使用 low、high 或 max`，表现为 `Reconnecting 1/5…5/5` 后 `stream disconnected`。**⚠️ codex 不校验档位值**（`bogus` 也照收），写错了只会在上游炸。
- **沙箱**：`sandbox_mode = "workspace-write"` 在本机**直接不可用**（`error building bubblewrap command: cannot establish app-server socket mount isolation`，连 consult 求助通道都会被拦）⇒ **必须 `danger-full-access`**（proot 无 Landlock/bwrap）。
- **`strict_config` 不是配置键**：`-c strict_config=true` 会被判 `unrecognized`（它只是命令行 flag `--strict-config`）。
- **能力增量只有三条**（配置项基本只调"安全与观测"，不给新本事）：① **给 codex 写 skill**（`~/.codex/skills/<名>/SKILL.md`，frontmatter `name`+`description`，可带 `scripts/`、`references/`；它自带 `skill-installer` 能从 GitHub 装）② 打开 `[mcp_servers]`（本机 `exa`/`parallel-search` 均 `enabled=false`）③ `model_catalog_json`（喂自定义模型元数据，比 `model_context_window` 更根本）。
- **已知无用/有害的键**：`model_verbosity`（二进制明写对不支持 verbosity 的模型会被忽略）、`service_tier`（OpenAI 专属）、`sandbox_mode=workspace-write`（见上）。

**模型元数据（第三方 provider 必看）**：codex 内置模型表只含自家模型，第三方模型会退回**兜底窗口**（实测 `glm-5.3-flash` 的 `model_context_window` = `258400`，而真值 1M）。用 `config.toml` 顶层的 `model_context_window` / `model_max_output_tokens` 覆盖。

- 主 AI 自己拉

## 4. 升级后检查清单

```bash
codex --version                                    # 1. 版本对不对
codex features list | grep -v 'false$'             # 2. 本机启用了哪些（对照 §1）
codex features list | grep -E 'removed'            # 3. 有哪些被移除（老配置可能踩雷）
codex doctor                                       # 4. 环境体检（连通性/auth/sandbox/记忆库）
grep -nE '^\[' ~/.codex/config.toml                # 5. ★配置段是否完整
curl -s "$DSH_WEB_URL/second-engine/api/version"   # 6. 插件侧版本核对
ls -l /root/codex/codex-code-mode-host             # 7. ★sidecar 是否在位（换源重装/升级后必查，见 §6）
grep -n 'model_context_window\|model_max_output_tokens' ~/.codex/config.toml  # 8. 模型元数据是否写入（见 §7）
ls -l /root/codex/*.bak-*                          # 9. ★回滚物是否在位（升级前必须留下）
```

### ★ 第 5 条是 2026-10-02 事故换来的

第二引擎插件的 `writeCodexConfig()` 原先只保留 `mcp_servers.*` 一种段。**切一次提供方**就会把 `[features]`、`[tui]`、`[projects.*]` 全部静默丢弃 —— 结果 4 个 feature 开关回到默认 `false`（`multi_agent_v2`、`memories`、`network_proxy`、`recommended_plugins`），`/root/proj` 的项目信任级别也没了，**全程没有任何报错**，只有发现功能失效才会察觉。

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

**现象**：用 `gpt-5.6-terra` / `gpt-6-*` 下工单，模型能回话，但**工具一个都执行不了**：

```
warning: Code Mode is unavailable because failed to spawn code-mode host
         .../codex-code-mode-host: host executable was not found
ERROR codex_core::tools::router: error=failed to spawn code-mode host ...
```

**机制（`codex debug models` 实测）**：模型元数据有 `tool_mode` 字段，值为 **`code_mode_only`** 的模型，**所有命令执行都必须经这个独立 sidecar 进程**（长驻、内嵌 V8、gRPC/stdio、带 cell 复用）。本机内置目录 11 个条目里，**除 `gpt-5.5`（官方定位 "Legacy coding model"，无该字段）外全是 `code_mode_only`**：
`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-daybreak-blue/red-latest`、`codex-auto-review`。

> 该字段**按模型名匹配**，与"模型真假"无关——中转报什么名就走哪条元数据；**别用"要不要 host"推断模型真假**。也不能靠 `features.code_mode_host=false` 绕过：关掉后 exec 直接报 `code-mode host is disabled`（exec 必须走它）。

**为什么本机缺**：codex 自 **0.144** 起把它改成独立 sidecar（上游 [issue #31906](https://github.com/openai/codex/issues/31906) / [#31831](https://github.com/openai/codex/issues/31831)），而本机是用 **npmmirror 的 npm 平台包只取了主二进制** —— sidecar 从没取过。0.158.0 备份同样有该特性（**降版本无用**）。

**修复（已验证，可逆）**：

```bash
# 1) 取本机架构的 sidecar（GitHub release，tag 与 CLI 同版本）
#    ⚠️ 直连通不通随网络状态变：10-10 记「不通」，10-17 实测「通」（128 KiB/s）；两可之间用镜像底座 + -c 续传
aria2c -c -x 8 -s 8 -k 1M -d /tmp -o cmh.tar.gz \
  "https://ghproxy.net/https://github.com/openai/codex/releases/download/rust-v<版本>/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz"
tar -xzf /tmp/cmh.tar.gz -C /tmp
# 2) ★与 codex 主二进制同目录，且必须命名为 codex-code-mode-host
cp /tmp/codex-code-mode-host-aarch64-unknown-linux-musl /root/codex/codex-code-mode-host
chmod +x /root/codex/codex-code-mode-host
```

- 备选通道：npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`（`vendor/<arch>/bin/` 内含它）——本机 codex 本来就是那条渠道装的，下次升级顺手把它一起取出来更省事。
- **回退**：删掉该文件即回到原状，代价是**所有 `code_mode_only` 模型的工具全废**（`gpt-5.5` 不受影响）。

**验收判据（接任何新 provider/模型必做）**：让它"建一个文件并运行"，**看文件真不真落盘**——别信回复像不像。回复正确但目录是空的 = 工具链断了。（2026-10-04 为此白烧约 2.7 万 token。）

---

## 7. 模型元数据：为什么会出现 `Model metadata ... not found`（2026-10-17 实测）

**现象**：`codex exec` 输出里一行 warning —— `Model metadata for \`glm-5.3-flash\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`

**机制**：codex 内置一张模型元数据表（上下文窗口 / 最大输出 / `tool_mode` 等），**只含它自家模型**。第三方 provider 的模型名匹配不到 → 退回兜底元数据。覆盖办法是 `config.toml` 顶层的 **`model_context_window`** / **`model_max_output_tokens`**。

**兜底值是多少（实测）**：rollout 的每个 `token_count` 事件都带 `model_context_window` —— 两个 rollout 共 **7 处，全为 `258400`**（≈252K）。

**真值对照（智谱官方[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)）**：GLM-5.3-Flash **上下文 1M = 1048576、最大输出 128K = 131072** ⇒ 兜底只有真实上下文的 **约 1/4**。

**但当下影响很低（实测口径）**：`~/.codex/task-*.out.live` 里 67 条历史工单的 token 用量 —— 中位 **12,814**、90 分位 **77,180**、最大 **154,423**，**没有一条超过 258,400**。⇒ 本机实际用法从未触到兜底上限，压缩也从未触发过。

**谁该填、怎么填**：这两个值在 second-engine 里是**按提供方各存一份**（keyring 的 `contextWindow` / `maxOutput`），**填一次永久生效**，不是每次派单都要改；keyring 里目前只有 `deepseek` 有值（`1048576 / 393216`），其余 provider 为空 ⇒ config.toml 里就没有这两个键（插件 `src/index.js:765-769` 是"有值才写"）。填法：设置面板改提供方，或 `POST /second-engine/api/providers/update`，然后**切一次 active** 重写 config.toml；**别手改** `keyring.json` / `config.toml`（红线 11）。

**验收判据**：填完跑一次 `codex exec`，看 rollout 的 `model_context_window` 是否变成 `1048576`、以及那行 warning 是否消失。

---

# 【2026-10-26 自 SKILL.md 外移】附A–附D

> 以下四节原载 `skill/SKILL.md`（547 行版），2026-10-26 技能瘦身外移至此（SKILL.md 原处只留可直接跑的命令）。外移前经只读核查子代理复核（codex 0.164.0、插件工作副本 se-slim-20261026），过期项就地标「2026-10-26 复核」。

## 附A. `~/.codex/`（CODEX_HOME）目录地图（2026-10-15 实测，当时共 185 M）

Codex 的一切状态都在这儿。**红线 11 的「不手改」只点名 `keyring.json` 与 `config.toml`**；其余在明确知道用途后可处理。

| 类别 | 项 | 大小 | 用途 |
|---|---|---|---|
| 配置 | `config.toml` | 1.2 K | `model_provider` / `model` / `sandbox_mode` / `web_search` / `[mcp_servers.*]`。**不手改** —— 插件切 active 时重写它 |
| | `config.toml.bak-*` ×7 | 各 ~450 B | 历史备份（`-20261001` `-pre-memories` `-pre-switch` `-ma2` `-recplug` `-before-ma2-recplug` `-se`） |
| | `keyring.json` | 1.4 K | 多提供方与 key。**不手改** |
| | `AGENTS.md` | 2.5 K | **Codex 自己的全局指令**（与 `/root/proj/AGENTS.md` 同源的那份） |
| 状态库 | **`logs_2.sqlite`** | **41 M** | 运行日志 —— **整个目录最大的一块**（能否清**未验证**） |
| | `thread_history_1.sqlite` (+`-wal` 248 K) | 15 M | 线程历史 |
| | `state_5.sqlite` (+`-shm`) | 573 K | 主状态；`state_5.sqlite.bak-20261003-pre-hue` ×3 ≈ 800 K 是升级前备份 |
| | `queue_1` / `goals_1` / `memories_1.sqlite` | 41 K / 32 K / 44 K | 队列 / 目标 / 记忆 |
| 内容 | **`sessions/`** | 16 M | 会话 rollout —— 落盘路径与读法见附A.1 |
| | **`task-*.out.live` ×~100** | **~10 M** | **second-engine 每个工单的原始输出**；清理走 `POST /second-engine/api/cleanup`（按 mtime）。**2026-10-26 复核：现 14 个 / ~595 KB**（2026-10-25 起 `finalizeJob` 统一删 `.out`/`.live`，积压已消化） |
| | `skills/` | 630 K | Codex 侧技能（`relay-probe` 在此） |
| | `memories/` / `archived_sessions/` | 189 K / 空 | 记忆 / 已归档会话 |
| 运行时 | `.tmp/` | **102 M** | `plugins/` 缓存 + `git-XXXXXX/`（**裸仓库**，只有 `HEAD`/`objects`/`refs`，各 15 K） |
| | `shell_snapshots/` | 3.5 K | **exec 模式**工单会建 |
| | `thread-writer-locks/` `app-server-control/` `app-server-daemon/` `mcp-oauth-locks/` `tui-thread-reference-capabilities/` `packages/` `log/` `tmp/` | 都极小 | 锁 / 守护 / 包 / 日志 —— ⚠️ **`tmp/`（7 K）与 `.tmp/`（102 M）是两个不同目录** |

**两条实测判据（2026-10-15）**：

1. **Codex 的 `TMPDIR` 就是 `/tmp`**（实测 `TMPDIR=/tmp`）—— 与主 AI **共用同一个临时区**；`~/.codex/.tmp/` 是它**另外主动写**的地方，**不是 TMPDIR 指过去的**。（探针工单 `mv8jnfzcmsrh`：两处都建文件都成功 ⇒ 只证明"都可写"，**不证明它默认往哪写**；默认行为以 `TMPDIR` 为准。）
2. **`git-XXXXXX/` 疑似与执行模式相关**：已有 3 个落在 01:51 / 02:33 / 02:49（当时在测 **appserver** 模式），而 04:09 的 **exec** 工单没建 `git-*`、只建了 `shell_snapshots/` ⇒ **推断，未验证**（要坐实得切回 appserver 派单）。

**清理纪律**：优先走插件的 `POST /second-engine/api/cleanup`（按 mtime 清旧会话）。**别手删状态库** —— `state_5` / `thread_history_1` / `logs_2` 是运行中的 SQLite，直接删可能丢诊断与历史。`config.toml.bak-*` 与 `state_5.sqlite.bak-*` 可只留最近 1~2 个（2026-10-15 用户裁定：**暂不清**）。

### 附A.1 会话落盘（rollout）在哪、怎么读（2026-10-17 实测）

**路径规则**：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO时间>-<uuid>.jsonl`
（实例：`~/.codex/sessions/2026/10/17/rollout-2026-10-17T01-40-02-01a145cc-….jsonl`，75 KB / 18 行。**2026-10-26 复核：sessions/ 最新月日目录为 2026/10/25，日分目录结构未变**）

**前提（最容易误判的一条）**：只有面板**勾了「保留会话」**（工单 `ephemeral:false`）才落盘。缺省 `ephemeral` 为 `true` ⇒ **不写 rollout**（源码语义「不落盘 rollout，只有显式 `body.ephemeral === false` 才持久化会话」，2026-10-26 复核仍在）⇒ **磁盘上查不到某工单，不等于该工单没跑**。

**★ 检索要点（2026-10-17 踩过）**：工单还有**另一处**留档 —— `~/.codex/task-<工单ID>.out.live`（例 `task-mvb96behtmfl.out.live`，549 B），**工单 ID 只在文件名里、不在内容里**，是插件 `-o` 的原始输出（banner + 工单原文 + 回复 + `tokens used`）。⇒ **`grep -rl <工单ID>` 必然零命中**（搜内容），要查用 `ls task-*.out.live | grep <工单ID>` 或按 mtime。⚠️ 另注：`sessions/` 是**按月日分目录**，别只看当天目录就断言"只有 N 个" —— 实测全库 86 个、跨 09-22 → 10-17。

⚠️ **术语歧义**：`ephemeral` 指**不写 codex 的 rollout（会话记录）**，**不等于「不产生文件」**。链路：`-o` 的 `task-<id>.out` 读入内存后即删；过程流 `.live` 曾长期无生命周期管理（10-17 积压 77 个 / 11 MB，当次清到 14 个）——**2026-10-25 起 `finalizeJob` 统一删 `.out` 与 `.live`**，cleanup 的 keepDays 降级为崩溃兜底。

**一行读法**（jsonl 一行一事件）：

```bash
python3 - <<'EOF'
import json,glob,os
f=sorted(glob.glob(os.path.expanduser('~/.codex/sessions/2026/10/17/rollout-*.jsonl')))[0]
for i,l in enumerate(open(f,encoding='utf-8')):
    d=json.loads(l); print(i, d.get('type'), str(d.get('payload'))[:150])
EOF
```

**事件类型速查**：`session_meta`（含 `cli_version` / `cwd` / `originator=codex_exec` / `model`）、`turn_context`（`model` / `approval_policy` / `sandbox_policy`）、`response_item`（`message` / `function_call` / `*_output`）、`event`（`task_started` / `token_count` / `task_complete`）、`world_state`、`item_completed`。

**用途（实证）**：核历史工单**不必看面板** —— 工单 `ehtmfl` 的完整闭环（`cli_version=<版本>` → 用户消息 → assistant 回复 → `token_count` → `task_complete`，全程 25 秒）全部从 rollout 解析出来。

## 附B. CLI 能力速查（官方文档 + 本机实测对照）

> **2026-10-26 复核（0.164.0）**：**已移除 `mcp-server`、`feedback`**（--help 不列；显式调用走"未知命令当 PROMPT"回退，勿再当子命令用）；**新增 `update`、`doctor`、`migrate-nfs-db`**。与 §2「派活」块的 `codex mcp-server` 行同步过期（已就地标注）。TUI 键位、文档镜像通道本轮未复验，标注保留。

**运行模式**：`codex`（交互 TUI）/ `codex exec "任务"`（非交互，**下工单用这个**）/ `codex exec --json`（结构化输出）

**命令**（官方文档列出 + **本机实测多出来的加粗**；⚠️ 0.164.0 已移除的加删除线说明）：
- 核心：`codex`、`exec`、`review`
- 会话：`apply`、`resume`、`fork`、**`queue`**、**`archive`**、**`delete`**、**`unarchive`**、**`migrate-rollouts`**
- 认证：`login`（ChatGPT 账号或 API key）、`logout`
- 集成：`mcp`、~~`mcp-server`~~（0.164.0 已移除）、`app-server`（IDE 用）、**`plugin`**、**`remote-control`**、**`exec-server`**、**`cloud`**（官方云端）、**`agents`**（浏览共享 daemon 的全部会话）
- 实用：`completion`、`sandbox`、`features`、~~`feedback`~~（0.164.0 已移除）、`debug`、**`doctor`**、**`update`**、**`migrate-nfs-db`**

**全局参数**：`-c KEY=VALUE`（覆盖 config.toml）、`-p NAME`（配置档）、`-m MODEL`、`--oss`（开源/本地 provider）、`--enable/--disable <FEATURE>`

**常用套路**：
```
codex exec --json "..." > out.json                          # 结构化抓取
codex review --uncommitted | --base main | --commit <sha>   # 三种审查范围
codex --oss --local-provider ollama "..."                   # 本地模型
codex -c sandbox_mode=workspace_write "..."                 # 覆盖沙箱
```
退出码：`0` 成功 / `1` 出错。

### TUI 快捷键（2026-09-25 官方文档核实；完整表见官方镜像页，这里只留常用的；2026-10-26 未复验）
`Ctrl+C` 忙碌时中断 / 空闲时再按退出；`Ctrl+D` 输入框为空时退出；`Ctrl+L` 清屏；`Ctrl+R` 恢复上一会话；`↑`/`↓` 历史；`Esc` 取消输入；`Enter` 发送、`Shift+Enter` 换行。

**取证教训（勿再犯）**：曾用 `strings` 搜二进制找键位，六种写法全 0 命中 → 误判"Ctrl+D 无绑定"。**键位是代码实现的，不留字符串**，`strings` 搜不到 ≠ 不存在。查 Codex 行为用官方文档，不要猜二进制。

**文档通道（本环境可用姿势）**：
- 索引（列全部页面）：`curl -sSL https://mintlify.com/openai/codex/llms.txt`
- 任意页原始 markdown（**`.md` 结尾**，纯文本好 grep，比抓 SPA 高效得多）：
  `curl -sSL https://mintlify.wiki/openai/codex/concepts/interactive-mode.md`
- ⚠️ openai 官方域在本环境**全线不可达**（实测 09-25：`developers.openai.com` 403、`platform.openai.com/docs` 403、`learn.chatgpt.com` 超时）→ 一律走上述镜像。

## 附C. 能力边界与实测方法（版本敏感部分，⚠️ 用前必测）

> 结论随 codex 版本变动，日志旧结论会腐化 —— **本环境已发生过一次**：早期记录写"`codex exec` 单发模式无协作层"，2026-09-24 实测发现是**整个协作层被上游移除**（措辞与范围都不同）。**别直接引旧结论，按下面重测。**

1. **查 feature flags**：`codex features list`（**真值以本表 §1 为准**）。本机曾复验的形态：`multi_agent`=stable/true、`multi_agent_v2`=stable/**true（本机已启用）**、`multi_agent_mode`=**removed**、`memories`/`network_proxy`/`recommended_plugins`=true；`collaboration_modes`=**removed**。
2. **官方子代理可用（2026-10-01 修正，推翻旧结论）**：`--enable multi_agent_v2` 后 prompt 会注入协作工具 `spawn_agent` / `followup_task` / `send_message` / `wait_agent` / `interrupt_agent` / `list_agents`；受控实测 `spawn_agent` 成功返回子代理 `agent_message: READY`。**该功能本机已启用**。
   ⚠️ 2026-09-24 那条「官方子代理不可用 / `spawn_agent` 报 `unsupported call: collaboration`」是**误判**：当时用**裸名 `collaboration`** 调用，而实际接口是**命名空间化工具**——报错是调用名写错，不是功能缺失。**教训：探测不到 ≠ 功能不存在，先确认调用名。**
   土办法仍可兜底：起多个独立 `codex exec` 进程并行（同一文件不要并行改；中转站一账号 5 并发）。
3. **换 provider / 换模型后必做"真干活"验证**：发小工单让它用 shell 建文件并 cat 确认，看到 `exec /bin/bash -lc "..." succeeded` 且文件真存在，才算工具调用可用（当日用中转 `deepseek-v4-flash` 通过，token 仅 ~14k）。

> **2026-10-26 复核（0.164.0）**：上列 flags 与 `codex features list` 全部一致（multi_agent / multi_agent_v2 stable true、multi_agent_mode removed false、memories true、network_proxy experimental true、recommended_plugins true、collaboration_modes removed）；唯 `collaboration_modes` 呈「removed 但 enabled 列 true」的异常组合，保留观察。`prevent_idle_sleep`/`secret_auth_storage`/`analytics_plan_history` 均在且 false，与 §1「明确保持关闭」一致。

### 本机已启用的扩展（开关态见本表 §1）

启用方式 `codex features enable <名>`（写入 `~/.codex/config.toml` 的 `[features]` 段）；改前备份 `config.toml.bak-20261001`、改后跑 `codex features list` 复核。

| 功能 | 状态 | 实测结论 |
|---|---|---|
| `memories` | ✅ 开 | 长期记忆：会话闲置 >12h 后「摘要→整合」并注入「记忆使用说明」（非全文注入）；效果需时间观察，观察点 = `memories_1.sqlite` 是否增长 |
| `network_proxy` | ✅ 开（仅开关） | 沙箱网络管控：`permissions.network.*`（mode=limited/full、allowed/denied_domains、proxy_url、socks_url、enable_socks5）。**故意未配 permissions** —— `mode: limited` + 空白名单会直接断掉 zhipu/MCP/DNS |
| `multi_agent_v2` | ✅ 开 | 协作工具命名空间化，`spawn_agent` 实测可用 |
| `recommended_plugins` | ✅ 开 | 实测**无可见效果**（仅 `doctor` 计数变化：54→55 enabled；无新命令/目录/网络请求）；按用户要求保留挂载 |
| `prevent_idle_sleep` | ❌ 关 | Android proot 无 D-Bus（`systemd-inhibit --list` 报 `Failed to connect to bus`），大概率无效 |
| `secret_auth_storage` | ❌ 关 | 改动只针对 Windows Credential Manager 路径；本机 `doctor` 显示 auth storage = `File` |
| `analytics_plan_history` | ❌ 关 | 只服务 ChatGPT 消费者计划用量，受 account plan 门控 |

**顺带发现（2026-10-01）**：`codex doctor` 是一站式环境诊断 —— OS/架构、provider 连通性（如 zhipu HTTP 200）、auth storage 类型（`File`/keyring）、sandbox 状态、`memories` 数据库完整性、线程状态。排查 Codex 环境问题优先跑它。

**provider 覆盖配方**（实测可用；**`name` 字段必填**，漏了报 `provider name must not be empty`）：
```
-c model_provider=relay -c model="<模型名>" \
-c 'model_providers.relay.name="relay"' \
-c 'model_providers.relay.base_url="https://laneai.dev/v1"' \
-c 'model_providers.relay.wire_api="responses"' \
-c 'model_providers.relay.env_key="RELAY_API_KEY"'
```

## 附D. 2026-09-25 新增能力（第二引擎侧，已实测）

> **2026-10-26 复核**：① **relay-forge 管线已退役**——`/root/proj/relay-forge/` 不存在，原件在 `/root/.dsh/refs/retired-proj-20261015/relay-forge`；② bridge/CHANGELOG.md **顶部现为 2026-09-29 两条**，2026-09-25 共 **4 条**（行 117/164/250/361），非下文所说"顶部三条"；③「会话 ID 36 位」小节引用的 `/root/proj/共同工作区/会话ID与挂载坑-20260925.md` **全盘查不到**（坑本身仍成立，已内联进 SKILL.md）。

### 中转站算力：探测与并发咨询

- **技能 `relay-probe`**（Codex 侧 `~/.codex/skills/relay-probe/`）：5 个子命令 `fingerprint` / `inject-size` / `extract` / `footer` / `consult`（并发问 N 个模型收第二意见）。方法与本机案例已归 skill `relay-forensics`（`/root/.dsh/skills/relay-forensics`），此处不重复。
- **管线 `/root/proj/relay-forge/`**（⚠️ 2026-10-26 已退役，见上）：并发让它写代码补丁。模型**没有联网能力**，"自己查资料"实际是
  模型发 `tool_calls` → `forge.py` 本地 `fetch_url` → 回灌。铁律：产出只落 `out/<时间戳>/`，
  **绝不自动改目标文件**；要"整文件重写"会得 0 字符，只喂"定位锚点 → 替换为"的补丁。

### 网页桥新增（插件内 `bridge/web/`；原件已退役到 `/root/proj/backup/`）

- 会话列表**搜索框**（`Ctrl+K` 唤起）、**会话 ID 芯片**（点一下复制完整 36 位 ID，显示只给前 8 位）、
  **深浅主题切换**（浅色为默认，选择存 localStorage）、被占用时**显示写锁持有者**
  （`GET /api/lock-info`，扫 `/proc` 不用 `pgrep -f`）。
- 改动明细与回滚命令：插件内 `bridge/CHANGELOG.md` 顶部（⚠️ 2026-10-26：顶部已是 09-29 记录；09-25 共 4 条在行 117 起）。
- **2026-09-28 取址便利改动**：① `ctl.sh url` 把网址同时落盘 `bridge/.url`（0600）——TUI 全屏会刷掉启动输出，随时 `cat` 取回；② `codex-env -u` / `--url` 只打印桥网址就退出（不进 TUI、不注入 key）；③ `codex-env` 默认桥路径由旧 `web-bridge/` 更正为 `second-engine-bridge/bridge/` —— 两目录各持独立 `.token`，旧 token 在 `/api/threads` 实测 **401**，混用会拿到打不开的网址。

### ⚠️ 会话 ID 必须给完整 36 位（当次实测的坑）

`codex resume` 的 id 参数是「UUID **或会话名**」。8 位前缀两者都不是 → 解析成"按名字找" → 找不到 →
**不报错，直接新建一条会话**（实测 `codex exec resume 01a0d8ad "hi"` 新建了 `01a0d930-…`）。
`codex-env -a <id>` 内部就是 `codex resume --remote`，同样中招。`codex delete` 无 TTY 时要
`--force` 且必须完整 UUID。（原复现文档已失联，见节首复核标注；坑的判据仍实测有效。）

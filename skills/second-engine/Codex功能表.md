# Codex 功能表（只记对我们有用的）

> **用途**：不用每次去翻 GitHub release notes，需要什么能力直接查这张表。
> **维护**：每次升级 Codex 后跑 §4 的检查清单，把新增/移除补进 §3，把开关变化补进 §1。
> **当前版本**：`0.164.0`（2026-10-25 升级；回滚物 `$CODEX_HOME/*.bak-0.163.0`。⚠️ 0.164.0 只跑了工具面 + DSH 依赖点，**执行链未复验**）
> **二进制**：`$CODEX_HOME/codex-aarch64-unknown-linux-musl`（musl 静态单文件，`/usr/local/bin/codex` 软链过去）
> **升级方式（2026-10-17 实测修订）**：**GitHub release 直连这次是通的** —— 主二进制 `codex-aarch64-unknown-linux-musl.tar.gz`(~100 MB) + sidecar `codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz`(~26 MB)，`aria2c -x8` 单线程 128 KiB/s → **757 KiB/s**，两分钟下完。**镜像现状变了**：`ghfast.top` **已挂（HTTP 000）**、`ghproxy.net` 200 可用。**⚠️ 网络状态会变，"直连不通"的旧结论不能当现在的判据**（10-10 那条就是这么过期的）。
> **sidecar 必须改名**：解压得到 `codex-code-mode-host-aarch64-unknown-linux-musl`，装进 `$CODEX_HOME/` 要改成 **`codex-code-mode-host`**（codex 找的是**无后缀** sibling）；**主 tar 里不含 sidecar**，两份资产要分别下。备选通道仍是 npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`。

---

## 1. 建议显式启用的 feature

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
ls -l $CODEX_HOME/codex-code-mode-host             # 7. ★sidecar 是否在位（换源重装/升级后必查，见 §6）
grep -n 'model_context_window\|model_max_output_tokens' ~/.codex/config.toml  # 8. 模型元数据是否写入（见 §7）
ls -l $CODEX_HOME/*.bak-*                          # 9. ★回滚物是否在位（升级前必须留下）
```

### ★ 第 5 条是 2026-10-02 事故换来的

第二引擎插件的 `writeCodexConfig()` 原先只保留 `mcp_servers.*` 一种段。**切一次提供方**就会把 `[features]`、`[tui]`、`[projects.*]` 全部静默丢弃 —— 结果 4 个 feature 开关回到默认 `false`（`multi_agent_v2`、`memories`、`network_proxy`、`recommended_plugins`），`<项目目录>` 的项目信任级别也没了，**全程没有任何报错**，只有发现功能失效才会察觉。

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
cp /tmp/codex-code-mode-host-aarch64-unknown-linux-musl $CODEX_HOME/codex-code-mode-host
chmod +x $CODEX_HOME/codex-code-mode-host
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

---
name: second-engine
description: 唤起与操作第二引擎 Codex 的完整流程：提供方与模型管理、工单下发（API 优先）、双向互审、卡点求助响应、结果验收、会话磁盘管理。当任务需要异构第二意见、并行下探子任务、独立复核、或用户说「用 Codex / 第二引擎 / 第二意见 / 让 Codex 试试」时使用。
---

# second-engine · Codex 第二引擎操作流程

## 引擎现状（2026-09-21 发布版实测）
- 二进制 `/usr/local/bin/codex`（**当前 0.158.0**，musl 静态；2026-09-28 由 0.156.1 换源升级——npmmirror 平台包 + sha512 校验，200MB 单文件；方法见 RESTORE 月志）；沙箱 `danger-full-access`（proot 无 Landlock/bwrap）→ **防线靠流程：工作副本隔离 + diff 审查 + git 仲裁**
- 提供方与 key 由插件统一管理：`~/.codex/keyring.json`（0600，**不要手改**），激活提供方切换时自动重写 `~/.codex/config.toml`（**不要手改**，sandbox_mode 已自动保留）
- 预设三家均实测直连：DeepSeek（responses）/ 智谱（responses，Coding 端点）/ 云知声（chat，经本地翻译桥自动挂接）

## API 优先（本插件服务层，Web 与主 AI 共用 —— 调用入口 = **当前 Web 地址** `$DSH_WEB_URL`）

**唤起 Codex 的入口 = 当前 Web 地址**（环境变量 `$DSH_WEB_URL`，DSH 启动时注入，随 Web 端口变）—— 插件路由挂在 Web 服务上，不写死端口：

```bash
W="$DSH_WEB_URL"        # 例: http://127.0.0.1:<Web端口>
curl -s "$W/second-engine/api/status"          # 自检: {"ok":true,"codexBinary":true,...}
curl -s -X POST "$W/second-engine/api/task" \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"<自包含工单>","workdir":"~/proj","ephemeral":true}'   # → {"id":"..."}
```

- ⚠️ **别用 App 设备桥的端口**（`/app/*`：读屏/点按/截屏/通知那套）：那不是插件路由，未知路径会被当 shell 命令，
  回 `{"result":"[NO_CMD]"}` —— 看着像插件故障，其实是敲错门（2026-09-27 实测踩过）。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/second-engine/api/status` | GET | 引擎三态 + 会话占用 + key 状态 |
| `/second-engine/api/providers` | GET | 提供方列表（key 脱敏）+ active |
| `/second-engine/api/providers` | POST | 添加自定义提供方 {id,name,baseUrl,wireApi:'responses',model} |
| `/second-engine/api/providers/key` | POST | 填 key {id, apiKey} |
| `/second-engine/api/providers/active` | POST | 切换激活（自动重写 config.toml + 按需起翻译桥） |
| `/second-engine/api/providers/update` | POST | 编辑（apiKey 省略=不改） |
| `/second-engine/api/providers/delete` | POST | 删除（deepseek/zhipu 受保护，其余可删） |
| `/second-engine/api/models` | POST | 拉取模型列表 {id}（OpenAI / Z.ai 双格式解析） |
| `/second-engine/api/model` | POST | 设定模型 {id, model}（active 自动同步 config） |
| `/second-engine/api/config` | GET/POST | 复核轮数等配置（reviewRounds: 1/3/5） |
| `/second-engine/api/task` | POST | **下发工单** {prompt, workdir?, ephemeral?=true} → {id} 立即返回 |
| `/second-engine/api/task?id=` | GET | 任务全量（status/output/exitCode） |
| `/second-engine/api/tasks` | GET | 最近 10 条摘要 |
| `/second-engine/api/task/cancel` | POST | 熔断 {id}（SIGTERM） |
| `/second-engine/api/review` | POST | **双向互审** {content, rounds?} → 多轮批判复核 |
| `/second-engine/api/review/cancel` | POST | 互审熔断 {id} |
| `/second-engine/api/consults` | GET | Codex 卡点求助列表（AGENTS.md 协议自动提交） |
| `/second-engine/api/version` | GET | 本地版本 vs GitHub 最新（有新版提醒，只提示不自动装） |
| `/second-engine/api/cleanup` | POST | 会话清理 {keepDays}（另有 6h 自动兜底 7天/200MB） |

## 标准流程

1. **下发**：`POST "$DSH_WEB_URL/second-engine/api/task"`（Web 地址见上节），工单写自包含、小粒度（Codex 零记忆）；工作副本目录默认 `~/proj`（**绝不进主工作区**）；默认 `--ephemeral` 不落盘（审计靠 git diff）。返回 `{id}` 即异步开跑。
2. **等待**：`bash <插件目录>/tools/wait-task.sh <id> [间隔=5] [超时=600]` 放进**后台 job**，完成由 App 通知自动唤醒（退出码 0=done / 2=失败 / 3=不存在 / 4=接口不可用 / 124=超时）——**禁止自写 `sleep`+`curl` 轮询**（既多余又占着会话不放）。
3. **验收**：`GET /api/task?id=` 读 output + 工作目录 `git diff` 审查 → apply / 打回（新工单指出问题）/ 升级用户裁决。
4. **互审**：把主 AI 产出（结论/方案/diff）`POST /api/review`，Codex 批判复核（上限内自动多轮，零新增即收敛，分歧打包上交用户）；面板可熔断。
5. **求助响应**：`GET /api/consults` 看 Codex 卡点（手机通知会提示）→ 针对性下一条工单解围。

## 执行模式（exec / appserver，2026-09-27 起）

工单与复核有两种执行模式，**运行时切换、不需要重启**：

- **exec**（默认）：`codex exec` 一次性子进程；行为与旧版完全一致。
- **appserver**：`codex app-server` JSON-RPC 长连接 —— `GET /api/task?id=` 多出 `progress` 字段（最近 20 条归一化事件，可看流式进度）；`POST /api/task/cancel` 先发 `turn/interrupt`（65ms 级结束）。
  输出仍落 `-o` 文件，看门狗（300s 无变化）判据不变；**任何事件都会刷新输出文件 mtime**。

```sh
echo appserver > ~/.dsh/second-engine-mode.txt   # 切 app-server
echo exec      > ~/.dsh/second-engine-mode.txt   # 切回
```
优先级：env `SECOND_ENGINE_EXEC_MODE` > 模式文件 > 默认 `exec`。
验收：`bash ~/.dsh/scripts/dsh/se-appserver-verify.sh`（流式进度 / 打断 / exec 回归三条判据）。

**实时可见性（怎么判断"到底行动了没"）**：
- **模型清单**：`POST /api/models {id}` 对智谱会**并集**两个端点（`/api/v1`（Codex 专用，只列 3 个）+ `/api/coding/paas/v4`（全量）），响应里的 `sources` 字段回显实际来源。实测两端点共用同一把 key，且 `/api/v1/responses` 支持全部 glm 模型（2026-09-28）。
- **exec 模式**：`GET /api/task?id=` 看 `liveBytes`（过程流字节数，持续增长即在动）；过程流保留在 `<outPath>.live`（最终结果仍以 `-o` 文件为准）。
- **appserver 模式**：除 `liveBytes` 外还有 `progress` 数组（归一化事件，最近 20 条，可见 reasoning / 文本增量 / 工具调用 / 用量）。
协议依据：`~/proj/appserver-spike/MAPPING.md`（事件→归一化字段，源自 app-server 的 JSON Schema；注意日志是 spike 摘要、不是原始帧）。

## 命令行降级（无插件环境 / 需要交互时）

```bash
codex-env          # 插件提供：自动注入激活提供方 key → 进 TUI（退出 Ctrl+D 或 /quit）
# 或手动（**别写成 `VAR=key cmd`，那会进 argv 被 ps 看到**）：
#   KEY=$(head -1 "$DSH_HOME/中转站/当前生效API.txt"); env PROVIDER_API_KEY="$KEY" cd ~/proj && codex exec --skip-git-repo-check -o /tmp/out.txt "工单"
```
- 长线程需 resume 时不加 `--ephemeral`；结构化收结果用 `-o <文件>` 或 `--json`。

## 协作边界（与 Codex 自述一致）

- Codex = 生产者；DSH 主 AI = 编排者 + 审核者；用户 = 裁决者。
- 三个价值按权重：**独立复核**（抓自洽却错的推理）> 视角互补（备选方案）> 并行下探（不重叠子任务外包）。
- 它不做最终决策，产出是「可验证的第二个信号」；停滞/绕圈时走 consult 求助，不硬试。

## 三种用法并行不悖：施工 / 复核 / 互补（2026-09-29 补，含派单模板）

**它们不是三选一，而是随时可切换的三条道**——方案阶段让它复核，实施阶段让它施工，两者交替用。

| 用法 | 场景 | 工单必须写清 |
|---|---|---|
| **并行施工** | 有一块可独立实施的代码/文件 | 工作副本路径 + 文件级要求 + 自测清单；**要产物，不要建议** |
| **独立复核** | 想让它挑我方案/结论的毛病 | 明确「只评审、不改文件」+ 要求可复现的反例 |
| **视角互补** | 我不确定时取第二方案 | 同样落到文件/命令级，不接受泛泛而谈 |

### 施工派单的五个要点（本会话实证）

1. **先冻结接口再分头开工** —— 谁改哪个文件、文件之间靠什么约定交互（函数名 / 输出格式 / 目录），全部写进工单；否则并行产物对不上。
2. **给它工作副本，不给主工作区** —— `workdir` 用 `~/proj` 或专门副本，**绝不指向插件实体 / 主工作区**。
3. **要求它自测并贴真实输出** —— `bash -n` / `node --check` / 用临时端口跑一圈；不接受「我改好了」。
4. **取用看 `git diff` + 复跑自测**，再**按「错误是点还是面」决定谁来修**：
   - **局部小错**（一两处、改法明确）→ **主 AI 直接改**。回炉要等它重跑（慢）、有断流风险，且 **ephemeral 工单没有项目全局记忆，容易越改越错**。实例（2026-09-29）：它误删 `load_key`（一段函数），主 AI 恢复 + 实测 5 分钟搞定，回炉只会更慢更险。
   - **大面积/方向性错误**（结构跑偏、多处不符规格、需求理解错）→ **回炉重做**（新工单写清问题），它手里有工作副本可以重来。
5. **工单模板**：范围（只改 X，不动 Y）→ 逐条改动 A/B/C → 硬约束（备份名 / 禁 `pkill -f` / 敏感信息不得出现）→ 自测清单 → 四段产出（含【异议位】）。

### 工单形态决定协作方式（2026-09-29 补，最易被忽略的一条）

| | **短期工单**（`POST /api/task`，ephemeral） | **长任务会话**（`codex exec` + `resume`，dual-board 链） |
|---|---|---|
| 记忆 | **零**——每单从零开始，看不见上一单 | 跨单保持，理解前因后果 |
| 适合 | 独立、自包含、边界清晰的一块活 | 多环节、需要持续理解项目的长链 |
| 出错时 | **小错主 AI 直接改**；只有大面积/方向性错误才回炉 | 可以打回，它有上下文能改对 |
| 主要风险 | 输出断、慢；**它不理解整体项目，反复回炉会越改越错** | 链长、状态多 |

> ⚠️ **别把长任务的「打回重做」习惯套到短期工单上**——短期单回炉＝让它从零重理解 + 等它慢慢跑 + 可能断流，通常比主 AI 直接改那几行更差。**判据只看一件事：错的是「点」还是「面」。**

### 判断「它到底动手没」——别看结论，看痕迹

- **文件 mtime / 字节数变化**：派单前后 `ls -la` 对比（本次实测：`ctl.sh` 6999→7792、`server.mjs` 29579→29719）
- **过程流里的补丁回显**：`<outPath>.live` 出现 `Success. Updated the following files: M xxx`
- **`git status`**：工作副本里对应文件是否真被改
- ⚠️ **`liveBytes` 增长 ≠ 在干活**：本次踩过——增长来自 `ERROR: Reconnecting...` 重连日志，不是有效产出；**必须看 `.live` 的内容**

> 反面教训（2026-09-29）：连着两单都写「只设计评审、不要改文件」，结果它只交回两份长篇方案，用户观感是「它只是个出想法的助手」。**进入实施阶段就必须换成「直接改代码」的工单**——编排者的派单方式决定了它是帮手还是顾问。

## 能力边界与实测方法（⚠️ 版本敏感，用前必测）

> 结论随 codex 版本变动，日志旧结论会腐化 —— **本环境已发生过一次**：早期记录写"`codex exec` 单发模式无协作层"，2026-09-24 在 0.156.1 实测发现是**整个协作层被上游移除**（措辞与范围都不同）。**别直接引旧结论，按下面重测。**

1. **查 feature flags**：`codex features list`。2026-09-24 实测：`multi_agent`=stable/true、`multi_agent_v2`=stable/**false**、`collaboration_modes`=**removed**、`multi_agent_mode`=**removed**。
2. **官方子代理不可用**：`spawn_agent` 返回 `unsupported call: collaboration`，`--enable multi_agent_v2` 也挂不出工具。**等效替代＝起多个独立 `codex exec` 进程并行**（当日实测可行：两进程各写一文件均成功）。约束：同一文件不要并行改；中转站一账号 **5 并发**。
3. **换 provider / 换模型后必做"真干活"验证**：发小工单让它用 shell 建文件并 cat 确认，看到 `exec /bin/bash -lc "..." succeeded` 且文件真存在，才算工具调用可用（当日用中转 `deepseek-v4-flash` 通过，token 仅 ~14k）。

**provider 覆盖配方**（实测可用；**`name` 字段必填**，漏了报 `provider name must not be empty`）：
```
-c model_provider=relay -c model="<模型名>" \
-c 'model_providers.relay.name="relay"' \
-c 'model_providers.relay.base_url="https://laneai.dev/v1"' \
-c 'model_providers.relay.wire_api="responses"' \
-c 'model_providers.relay.env_key="RELAY_API_KEY"'
```

**中转站速查**：Base `https://laneai.dev/v1`；key 在 `$DSH_HOME/中转站/keys/*.txt`（只读取、不写产物）；模型名以 `GET /v1/models` 实拉为准；一账号 5 并发；**敏感数据不过中转**。详见 `中转站/接入档案.md`。

**凭证安全（2026-09-24 实测）**：DSHA App 启动 proot 容器时把 `DEEPSEEK_API_KEY` 明文放进**命令行参数**（`/proc/<pid>/cmdline` 可见，容器内 `ps` 即可读到）。来源是 App 层、非 AI 引入；暴露面与 `keyring.json` 同级（都在容器内）→ **不必紧急轮换**，但应并入向上游的反馈。自己的命令**不要写成 `VAR=key cmd` 形式**（同样会进 argv），要从文件读再 `env` 注入；任何 key **不得**写进产物/文档/日志。

## CLI 能力速查（官方 CLI Overview + 本机 0.156.1 实测对照；0.158.0 下 exec / app-server 路径 2026-09-28 已复验）

**运行模式**：`codex`（交互 TUI）/ `codex exec "任务"`（非交互，**下工单用这个**）/ `codex exec --json`（结构化输出）

**命令**（官方文档列出 + **本机实测多出来的加粗**）：
- 核心：`codex`、`exec`、`review`
- 会话：`apply`、`resume`、`fork`、**`queue`**、**`archive`**、**`delete`**、**`unarchive`**、**`migrate-rollouts`**
- 认证：`login`（ChatGPT 账号或 API key）、`logout`
- 集成：`mcp`、`mcp-server`（把 Codex 当 MCP server）、`app-server`（IDE 用）、**`plugin`**、**`remote-control`**、**`exec-server`**、**`cloud`**（官方云端）、**`agents`**（浏览共享 daemon 的全部会话）
- 实用：`completion`、`sandbox`、`features`、`feedback`、`debug`

**全局参数**：`-c KEY=VALUE`（覆盖 config.toml）、`-p NAME`（配置档）、`-m MODEL`、`--oss`（开源/本地 provider）、`--enable/--disable <FEATURE>`

**常用套路**：
```
codex exec --json "..." > out.json                          # 结构化抓取
codex review --uncommitted | --base main | --commit <sha>   # 三种审查范围
codex --oss --local-provider ollama "..."                   # 本地模型
codex -c sandbox_mode=workspace_write "..."                 # 覆盖沙箱
```
退出码：`0` 成功 / `1` 出错。

### TUI 快捷键（2026-09-25 已从官方文档核实，取代此前"未验证"标注）

出处：`https://mintlify.wiki/openai/codex/concepts/interactive-mode.md`（Codex CLI 官方文档镜像）

| 快捷键 | 动作 |
|---|---|
| `Ctrl+C` | 取消当前操作**或**退出（注意是「或」——忙碌时是中断，空闲时再按才退） |
| `Ctrl+D` | **退出 Codex（输入框为空时）** —— 明确的退出绑定 |
| `Ctrl+L` | 清屏 |
| `↑`/`↓` | 命令历史 |
| `PgUp`/`PgDn` | 滚动会话 |
| `Home`/`End` | 跳到输入首/尾 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| `Ctrl+U` / `Ctrl+W` | 清当前行 / 删前一个词 |
| `Tab` | 补全（可用时） |
| `Ctrl+R` | 恢复上一个会话 |
| `Ctrl+P` | 打开命令面板（启用时） |
| `Esc` | 取消当前输入 |

> 官方附注：快捷键可能因终端模拟器与操作系统略有差异。

**取证教训（勿再犯）**：曾用 `strings` 搜二进制找键位，六种写法全 0 命中 → 误判"Ctrl+D 无绑定"。
**键位是代码实现的，不留字符串**，`strings` 搜不到 ≠ 不存在。查 Codex 行为用官方文档，不要猜二进制。

**文档通道（本环境可用姿势）**：
- 索引（列全部页面）：`curl -sSL https://mintlify.com/openai/codex/llms.txt`
- 任意页原始 markdown（**`.md` 结尾**，纯文本好 grep，比抓 SPA 高效得多）：
  `curl -sSL https://mintlify.wiki/openai/codex/concepts/interactive-mode.md`
- ⚠️ openai 官方域在本环境**全线不可达**（实测 09-25：`developers.openai.com` 403、`platform.openai.com/docs` 403、`learn.chatgpt.com` 超时）→ 一律走上述镜像。

## 双引擎协作看板 dual-board（2026-09-25 上线；协议实物 **v1.3**，2026-09-27）

- **脚本/协议随插件**：`tools/dual-board/{board.sh,board_tool.py,dispatch.sh,PROTOCOL.md}`（2026-09-30 收编；自定位，`DUAL_BOARD_DIR` 可覆盖数据目录）；**运行数据**默认仍在 `~/proj/dual-board/`（Codex 侧登记 `~/proj/AGENTS.md`）。派单涉及多环节长任务或需 Codex 持续记忆时走这套。
- **写板唯一入口 `board.sh`（v1.2 核心）**：CAS + O_EXCL 锁 + 原子写 + 状态机 + 归档 + 体检全在工具里，**手改 board.json = 破坏协议**。子命令：`new/claim/complete/block/abandon/set/show`、`inbox-append|unread|read|archive`、`archive`、`scope-check`、`doctor`；退出码即语义（0 成功 / 3 CAS 冲突 / 4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 降级）。**无 reopen**：completed 不可复改，出问题开新任务引用旧任务。
- **派单走 `dispatch.sh`**：自动注入 `inbox-codex.md` 未读段 + 派单**前**记基线 commit 与脏快照 → `.dispatch/<task id>.base`；交付后 `board.sh scope-check <id> --workdir <dir>` 机械校验 write_scopes 越界（⚠️ 脏工作区会漏报，尽量给干净目录，见协议 §十一）。
- **双通道**：短任务 `POST /api/task`（ephemeral 零记忆，互审/复核用）；长任务 `codex exec` 落盘 + `codex exec resume <thread_id>` 成员会话（一条链绑一个任务，thread id 记在看板 `session` 字段；0.156.1 实测跨单记忆保持）。长任务不走 API（API 不支持 resume），用命令行降级姿势手动注入 key。
- 工单三字段 task/context/frame；交付强制四段含【异议位】。细则读 PROTOCOL.md §九（工具化纪律）与 §十一（已知限制）。

## 2026-09-25 新增能力（第二引擎侧，已实测）

### 网页桥新增（插件内 `bridge/web/`；原件已退役到 `~/proj/backup/`）

- 会话列表**搜索框**（`Ctrl+K` 唤起）、**会话 ID 芯片**（点一下复制完整 36 位 ID，显示只给前 8 位）、
  **深浅主题切换**（浅色为默认，选择存 localStorage）、被占用时**显示写锁持有者**
  （`GET /api/lock-info`，扫 `/proc` 不用 `pgrep -f`）。
- 桥组件自述见 `bridge/README.md`。
- **2026-09-28 取址便利改动**：① `ctl.sh url` 把网址同时落盘 `bridge/.url`（0600）——TUI 全屏会刷掉启动输出，随时 `cat` 取回；② `codex-env -u` / `--url` 只打印桥网址就退出（不进 TUI、不注入 key）；③ `codex-env` 默认桥路径由旧 `web-bridge/` 更正为 `second-engine-bridge/bridge/` —— 两目录各持独立 `.token`，旧 token 在 `/api/threads` 实测 **401**，混用会拿到打不开的网址。

### ⚠️ 会话 ID 必须给完整 36 位（当次实测的坑）

`codex resume` 的 id 参数是「UUID **或会话名**」。8 位前缀两者都不是 → 解析成"按名字找" → 找不到 →
**不报错，直接新建一条会话**（实测 `codex exec resume 01a0d8ad "hi"` 新建了 `01a0d930-…`）。
`codex-env -a <id>` 内部就是 `codex resume --remote`，同样中招。`codex delete` 无 TTY 时要
`--force` 且必须完整 UUID。复现步骤：`~/proj/共同工作区/会话ID与挂载坑-20260925.md`。

## 异常速查

| 症状 | 处置 |
|---|---|
| 派单后长时间零输出（>10 分钟） | **先分清「错」「慢」「并发」**：见 `Reconnecting/stream disconnected` = 流断；只有沉默 = 可能在生成（relay 桥首包≈整段生成）。**2026-09-27 实测修正**：智谱 `/api/v1/responses` 单发长输出完全正常（25.3 万字节流/21s），`codex exec` 无并发长任务 30s 成功 → **失败多为「多个 codex 进程并发叠加」**所致。处置：① 先 `ps` 确认没有叠跑的 codex，再重试；② 仍不通则切 active 提供方（DeepSeek 直连）或用 relay。**别并发派单。** |
| 智谱模型的疑问 | `/api/v1` 是智谱给 **Codex 的专用适配端点**（模型描述含 `base_instructions`/`shell_type`/`slug`），所以只有 3 个模型（glm-5.3 / glm-5.3-flash / glm-5-turbo）；标准列表在 `/api/paas/v4/models`。`/api/coding/paas/v4/responses` = **404**（编程端点只支持 chat/completions），**不需要额外的「编程密钥」**——现有 key 三条端点均可用（2026-09-27 实测） |

| 长时间零输出：**先分清「错」与「慢」** | **有 `Reconnecting/stream disconnected` 等错误事件 = 上游故障**（切 provider）；**只有沉默、无错误 = 可能正在生成**——relay 翻译桥是「非流式请求上游、整段生成完再流式回放」，长任务首包延迟≈整段生成时间，此时**不要熔断**，先等（2026-09-27 实测：relay 短任务秒回、长复核 20 分钟沉默仍在生成） |
| 取消后仍有 codex 进程残留 | 旧版只发 SIGTERM；已在 `handleTaskCancel` 加 3s 兜底 SIGKILL（`task.forcedKill` 可查）。手工清理只用**精确 PID**（`kill <pid>`），绝不用模式匹配 |
| `Missing <X>_API_KEY` | 激活提供方换了但 env 没跟上：用 `codex-env` 或手动 export 对应变量 |
| 任务「运行中」长期无输出 | 看门狗会标 stuckSuspect；直接取消重发（曾因 stdin EOF 假死，已修复） |
| `wire_api` 报错 | config 被手改（应 responses）→ 面板重新「启用」即由生成器重写 |
| bwrap/sandbox 报错 | 沙箱模式被改回 → 同上，切 active 重写 config |
| 工具全灭 approval never | 同上 |

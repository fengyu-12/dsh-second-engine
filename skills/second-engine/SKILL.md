---
name: second-engine
description: 唤起与操作第二引擎 Codex 的完整流程：提供方与模型管理、工单下发（API 优先）、双向互审、卡点求助响应、结果验收、会话磁盘管理。当任务需要异构第二意见、并行下探子任务、独立复核、或用户说「用 Codex / 第二引擎 / 第二意见 / 让 Codex 试试」时使用。
---

# second-engine · Codex 第二引擎操作流程

## 🔴 什么时候该派它（2026-10-14 用户定稿 · 两分法）

**先分清两种情形 —— 别把"派单"当成碰壁的补救**（那会把自己养成行动的侏儒）。

### A. 本来就该它干的事（不必等卡，可以主动派）
- **独立复核**：我的产出要人挑错，**尤其"我觉得对"的时候**。
- **并行下探**：任务能拆成互不依赖的子块（⚠️ 先冻结接口，否则并行产物对不上）。
- **它是一手信源**：涉及它自己的运行环境 / 协议 / 历史（工单、session、config、keyring、app-server 协议）。
- **异构第二意见**：需要的是**与我的思路不同的解**，而不是同一条路径再试一遍。

### B. 我自己卡住了（**这才是求助，门槛要高**）
判据是**一条路径、四步穷尽**，缺一步都不算穷尽：

1. **实测** —— 直接跑，看真实回执（不看猜、不看记忆）；
2. **搜索** —— 网络搜索 + 官方文档（通用问题先看别人的实现与结论）；
3. **换路径继续实测** —— 换方法 / 换工具 / 换写法，再跑一轮；
4. **以上全试过仍不通** → 才派它，并把**已试过的路径与失败回执写进工单**（免得它重复踩）。

⚠️ **"两下不行就去问"是错的** —— 那等于把判断权交出去，长期只会让自己变成搬运工。
⚠️ **别把它的自救阈值当我派单的阈值**：Codex 侧「同一路径失败 2 次就喊」是**它**的自救线，不是**我**该派单的线；两个主体、两套判据，不能合并。
**反例（别派）**：局部小错、改法明确 → 我直接改；回炉要等它重跑、更慢更险（判据是错误在**"点"还是"面"**，见本文「三种用法」节）。

⚠️ **它喊我，我不查就看不到**（2026-10-14 实测）：`POST /api/consult` 通、记录进 `GET /api/consults`（**内存队列、无 taskId**），但**主 AI 侧没有被动通道**。
⇒ **派单前记基线 → 收单后比增量 → 收尾前再查一次**。因为队列无 taskId，只有**增量**才确定是这次任务的求助：

```bash
BASE=$(curl -s "$DSH_WEB_URL/second-engine/api/consults" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])")
# …派单、收单…
curl -s "$DSH_WEB_URL/second-engine/api/consults"   # count 超出 BASE 的部分 = 本次新增求助，逐条接手解围
```

✅ **求助已挂进工单出口**（2026-10-14 起）：任务收尾时，**本任务期间**的求助会自动以 `[SECOND_ENGINE_CONSULT]` 块追加进 `task.output` —— 收单读 output 就能看到，不必再赌自己记得去查（实测：3+3 测试单的 output 末尾自带该块）。

⚠️ **两个仍会漏的场景**：
1. **任务永不结束**（它卡死、`finalizeTask` 不跑）→ 追加不上；此时看 `GET /api/task` 的 **`stuckSuspect: true`**（看门狗 300s 无输出更新置位）就**去查 `consults`** 拿求助内容。
2. **review 内部循环** → 已补 `finalizeReview`；若在旧版插件上跑互审，仍按上面两条兜底。

### C. 用哪条通道派（2026-10-15 新增 · 官方原生工具 vs 本插件）

DSH 侧现在**两条路都能叫到 Codex**，别混：

| | `subagent_codex`（DSH 原生工具） | 本插件（second-engine API） |
|---|---|---|
| 怎么调 | 直接调工具，一行 | `curl $DSH_WEB_URL/second-engine/api/task` |
| 形态 | **进程内**一次委派，结果直接回到我的上下文 | **进程外**任务通道，有队列 / 历史 / output 留存 |
| 异步 | 支持（`run_in_background`），用 `job_output` 收 | 支持（完成弹 App 通知） |
| 取消 | `job_kill` | `/api/task/cancel` |
| 人能不能看见 | **看不见**（没有面板） | **能**（设置页面板 + `/api/tasks`） |
| 换 provider / 模型 | **不能**，只能吃 `config.toml` 里 active 的那份 | **能**（keyring 多 provider；切 active 时自动重写 config.toml） |
| 多轮批判互审 | 无 | `/api/review` |
| Codex 主动求助 | 无 | `/api/consult` |
| MCP / web_search / 会话清理 / 版本检查 | 无 | 有 |
| 跨工单连续性 | 无 | 无 |

**判据（一句话）**：

- **一件自包含的活，只要它把答案带回来给我** ⇒ `subagent_codex`（最短路径；默认等结果，`run_in_background` 才转后台）
- **要人看得见 / 要留痕 / 要换模型 / 要多轮互审 / 要它主动来找我** ⇒ 走本插件 API

**共同点**：两条都是「**一 run 一进程一 thread，无 resume**」（官方 README 原话 "one fresh process, thread, and turn per run … no continuation, resume, or pooling"，本机两条都已实测）⇒ **要连续性只能靠 dual-board 文本看板**，别指望引擎。

⚠️ **`subagent_codex` 的工具描述里完全没提 Codex** —— 与通用 `subagent` 的描述**前半段逐字相同**，只有末句不同（一个"默认后台 + 可续"，一个"默认等结果"）。所以新会话的 AI **不会自动知道**该用它干 Codex 的活，也读不出它没有连续性、`permissionMode` 默认 `never`。**这条判据正是本 skill 存在的意义之一。**

⚠️ 它的凭据由 provider 的 `env` 显式喂（**形似凭据的环境变量会被先剥离**，放 `~/.dsh/.env` 也没用）；本机做法是 `!!js` 现场从 `~/.codex/keyring.json` 读 active provider 的 key，凭据不落明文。装法/坑位见 skill `dsh-plugin-discipline` 第五节。

> 🔴 **升级后第一件事：维护旧结论**（本机私有判据）—— 跑完破坏性检验只是第一步，**真正的腐化源是"旧结论还挂在新版本号旁边"**。每次升级后必须回扫本文件与 `Codex功能表.md` 的**状态性结论**（开关态、能力对照、扩展表、CLI 速查），逐条二选一：
> **① 已复验 → 改成新版本 + 新日期**；**② 没验 → 明确标「<旧版本> 观察，未复验」**（不许搭着新版本号假装验过）。
> 判据：`grep -nE '0\.[0-9]{3}'` 的每一处都要能回答这句 —— **"这是历史事实（保留），还是现状标注（必须维护）？"**
> **历史事实永不改**（事故档案、版本变更日志、"某版实测"的记录）；**现状标注必须跟上**。

## 引擎现状（2026-09-21 发布版实测）
- 二进制 `/usr/local/bin/codex`（**当前 0.162.1**，2026-10-11 复验：工具面/执行链/依赖点三条全过；musl 静态）；**升级姿势 + 升级后破坏性检验见本文末节**；沙箱 `danger-full-access`（proot 无 Landlock/bwrap）→ **防线靠流程：工作副本隔离 + diff 审查 + git 仲裁**
- 提供方与 key 由插件统一管理：`~/.codex/keyring.json`（0600，**不要手改**），激活提供方切换时自动重写 `~/.codex/config.toml`（**不要手改**，sandbox_mode 已自动保留）
- 预设三家均实测直连：DeepSeek（responses）/ 智谱（responses，Coding 端点）/ 云知声（chat，经本地翻译桥自动挂接）
- 🔴 **wireApi 怎么选（2026-10-03 实证，接任何第三方端点前必做）**：判据只有一条 —— 直接 `POST {base}/responses` 发个最小请求，**200 = 原生支持 Responses，就标 `responses` 直连**；只有它 404/400 时才标 `completions` 走桥。**别默认套 `completions`**：桥（`src/bridge.js`）只保证**文本**往返，**工具调用循环会断** —— 同模型（glm-5.3）同工单，经桥两次都是 `exit 0 + 零产物 + 只回一句计划`（17.6s / 空 output），改直连后**同一工单立刻** `exec /bin/bash -lc '...' succeeded` 且文件真落盘。**判据："工单 exit 0 但工作目录没有新文件" = 假完成**，第一件事就是查它是不是走了桥。
- ✅ **`/providers/update` 现已支持 `wireApi`**（2026-10-03 补齐；源码：字段白名单含 `wireApi`、该提供方为 active 且值有变化时连带重写 `config.toml`，见 `src/index.js:945-973`）→ 原地把 `completions` 改成 `responses` 即可，**不必再"新增一个提供方再切 active"绕行**。⚠️ 两条前提：① 改完**重启 Web** 新代码才生效——未重启时旧代码仍会忽略它，`updated:[]` + `configRegenerated:false` 就是这个信号；② 换成 `responses` 前先按上一条验过端点原生支持，否则工具调用循环会断。

## `~/.codex/`（CODEX_HOME）目录地图（2026-10-15 实测，共 185 M）

Codex 的一切状态都在这儿。**红线 11 的「不手改」只点名 `keyring.json` 与 `config.toml`**；其余在明确知道用途后可处理。

| 类别 | 项 | 大小 | 用途 |
|---|---|---|---|
| 配置 | `config.toml` | 1.2 K | `model_provider` / `model` / `sandbox_mode` / `web_search` / `[mcp_servers.*]`。**不手改** —— 插件切 active 时重写它 |
| | `config.toml.bak-*` ×7 | 各 ~450 B | 历史备份（`-20261001` `-pre-memories` `-pre-switch` `-ma2` `-recplug` `-before-ma2-recplug` `-se`） |
| | `keyring.json` | 1.4 K | 多提供方与 key。**不手改** |
| | `AGENTS.md` | 2.5 K | **Codex 自己的全局指令**（与 `~/proj/AGENTS.md` 同源的那份） |
| 状态库 | **`logs_2.sqlite`** | **41 M** | 运行日志 —— **整个目录最大的一块**（能否清**未验证**） |
| | `thread_history_1.sqlite` (+`-wal` 248 K) | 15 M | 线程历史 |
| | `state_5.sqlite` (+`-shm`) | 573 K | 主状态；`state_5.sqlite.bak-20261003-pre-hue` ×3 ≈ 800 K 是升级前备份 |
| | `queue_1` / `goals_1` / `memories_1.sqlite` | 41 K / 32 K / 44 K | 队列 / 目标 / 记忆 |
| 内容 | **`sessions/`** | 16 M | 会话 rollout —— **落盘路径与读法见下方「会话落盘（rollout）在哪、怎么读」** |
| | **`task-*.out.live` ×~100** | **~10 M** | **second-engine 每个工单的原始输出**；清理走 `POST /second-engine/api/cleanup`（按 mtime） |
| | `skills/` | 630 K | Codex 侧技能 |
| | `memories/` / `archived_sessions/` | 189 K / 空 | 记忆 / 已归档会话 |
| 运行时 | `.tmp/` | **102 M** | `plugins/` 缓存 + `git-XXXXXX/`（**裸仓库**，只有 `HEAD`/`objects`/`refs`，各 15 K） |
| | `shell_snapshots/` | 3.5 K | **exec 模式**工单会建 |
| | `thread-writer-locks/` `app-server-control/` `app-server-daemon/` `mcp-oauth-locks/` `tui-thread-reference-capabilities/` `packages/` `log/` `tmp/` | 都极小 | 锁 / 守护 / 包 / 日志 —— ⚠️ **`tmp/`（7 K）与 `.tmp/`（102 M）是两个不同目录** |

**两条实测判据（2026-10-15）**：

1. **Codex 的 `TMPDIR` 就是 `/tmp`**（实测 `TMPDIR=/tmp`）—— 与主 AI **共用同一个临时区**；`~/.codex/.tmp/` 是它**另外主动写**的地方，**不是 TMPDIR 指过去的**。（探针工单 `mv8jnfzcmsrh`：两处都建文件都成功 ⇒ 只证明"都可写"，**不证明它默认往哪写**；默认行为以 `TMPDIR` 为准。）
2. **`git-XXXXXX/` 疑似与执行模式相关**：已有 3 个落在 01:51 / 02:33 / 02:49（当时在测 **appserver** 模式），而 04:09 的 **exec** 工单没建 `git-*`、只建了 `shell_snapshots/` ⇒ **推断，未验证**（要坐实得切回 appserver 派单）。

**清理纪律**：优先走插件的 `POST /second-engine/api/cleanup`（按 mtime 清旧会话）。**别手删状态库** —— `state_5` / `thread_history_1` / `logs_2` 是运行中的 SQLite，直接删可能丢诊断与历史。`config.toml.bak-*` 与 `state_5.sqlite.bak-*` 可只留最近 1~2 个（2026-10-15 用户裁定：**暂不清**）。

### 会话落盘（rollout）在哪、怎么读（2026-10-17 实测）

**路径规则**：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO时间>-<uuid>.jsonl`
（实例：`~/.codex/sessions/2026/10/17/rollout-2026-10-17T01-40-02-01a145cc-….jsonl`，75 KB / 18 行）

**前提（最容易误判的一条）**：只有面板**勾了「保留会话」**（工单 `ephemeral:false`）才落盘。缺省 `ephemeral` 为 `true` ⇒ **不写 rollout**（源码 `src/index.js:1452`、`:1485`：「不落盘 rollout，只有显式 `body.ephemeral === false` 才持久化会话」）⇒ **磁盘上查不到某工单，不等于该工单没跑**。

**★ 检索要点（2026-10-17 踩过）**：工单还有**另一处**留档 —— `~/.codex/task-<工单ID>.out.live`（例 `task-mvb96behtmfl.out.live`，549 B），**工单 ID 只在文件名里、不在内容里**，是插件 `-o` 的原始输出（banner + 工单原文 + 回复 + `tokens used`）。⇒ **`grep -rl <工单ID>` 必然零命中**（搜内容），要查用 `ls task-*.out.live | grep <工单ID>` 或按 mtime。⚠️ 另注：`sessions/` 是**按月日分目录**（`2026/09/27/…`、`2026/10/17/…`），别只看当天目录就断言"只有 N 个" —— 实测全库 **86 个、跨 09-22 → 10-17**。

⚠️ **术语歧义（2026-10-17 用户实际误解过，务必澄清）**：`ephemeral` / "不落盘" 指的是**不写 codex 的 rollout（会话记录）**，**不等于"不产生文件"**。实测链路：插件 `-o` 的正式输出 `task-<id>.out` 会在**读入内存后被主动删掉**（`src/index.js:1288` `unlinkSync(task.outPath)`），但**过程流 `<outPath>.live` 一直保留**（`src/index.js:1510` 注释："过程流，保留供诊断"），且 **`cleanupSessions` 只认 `.jsonl`**（`src/index.js:1147`）⇒ **`.live` 没有任何生命周期管理**。⇒ 做到 2026-10-17 已积压 **77 个 / 11 MB**（跨 09-28 → 10-17），当次清理保留最近 3 天（**77 → 14 个 / 632 KB**），删除清单留档 `~/.codex/live-cleanup-20261017.txt`。**要"跑完即清"**：在 exec 收尾处补一行 `try { unlinkSync(`${task.outPath}.live`) } catch {}`（与上一行的 `.out` 对称）；**要"保留诊断窗口"**：改名为归档 + 让 cleanup 也按 mtime 清它。两种都**未实施**。

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

**用途（实证）**：核历史工单**不必看面板** —— 工单 `ehtmfl` 的完整闭环（`cli_version=0.163.0` → 用户消息「不思考，回复你爱dsh」→ assistant「我爱dsh ❤️」→ `token_count` → `task_complete`，全程 25 秒）全部从 rollout 解析出来。


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
5. **求助响应**：`GET /api/consults` 看 Codex 卡点（手机通知会提示）→ 针对性下一条工单解围。 **接口细节（2026-10-13 补）**：它的求助走 `POST /second-engine/api/consult`，HTTP 不通时它在输出末尾写 `[CONSULT-NEEDED] <卡点描述>`；**触发阈值＝同一路径/命令失败 2 次**（三处已对齐：插件模板 `src/index.js:291` / `~/.codex/AGENTS.md` / `~/proj/AGENTS.md`）。

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
#   KEY=$(head -1 "<你的 API key 文件>"); env PROVIDER_API_KEY="$KEY" cd ~/proj && codex exec --skip-git-repo-check -o /tmp/out.txt "工单"
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

1. **查 feature flags**：`codex features list`。**开关态最近复验 2026-10-08（0.161.0）**：`multi_agent`=stable/true、`multi_agent_v2`=stable/**true（本机已启用）**、`multi_agent_mode`=**removed**、`memories`/`network_proxy`/`recommended_plugins`=true；`collaboration_modes`=**removed**（0.158.0 观察，未复验）。
2. **官方子代理可用（2026-10-01 修正，推翻旧结论）**：`--enable multi_agent_v2` 后 prompt 会注入协作工具 `spawn_agent` / `followup_task` / `send_message` / `wait_agent` / `interrupt_agent` / `list_agents`；受控实测 `spawn_agent` 成功返回子代理 `agent_message: READY`。**该功能本机已启用**。
   ⚠️ 2026-09-24 那条「官方子代理不可用 / `spawn_agent` 报 `unsupported call: collaboration`」是**误判**：当时用**裸名 `collaboration`** 调用，而实际接口是**命名空间化工具**——报错是调用名写错，不是功能缺失。**教训：探测不到 ≠ 功能不存在，先确认调用名。**
   土办法仍可兜底：起多个独立 `codex exec` 进程并行（同一文件不要并行改；中转站一账号 5 并发）。
3. **换 provider / 换模型后必做"真干活"验证**：发小工单让它用 shell 建文件并 cat 确认，看到 `exec /bin/bash -lc "..." succeeded` 且文件真存在，才算工具调用可用（当日用中转 `deepseek-v4-flash` 通过，token 仅 ~14k）。

### 本机已启用的扩展（开关态 2026-10-08 复验 @0.161.0；「实测结论」列仍是 0.158.0 观察）

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
-c 'model_providers.relay.base_url="<你的中转站 base_url>"' \
-c 'model_providers.relay.wire_api="responses"' \
-c 'model_providers.relay.env_key="RELAY_API_KEY"'
```

**中转站速查**：Base `<你的中转站 base_url>`；key 在 `<你的 keyring 目录>/*.txt`（只读取、不写产物）；模型名以 `GET /v1/models` 实拉为准；一账号 5 并发；**敏感数据不过中转**。详见 `中转站/接入档案.md`。

**中转站选型判据**（延迟方差 / 按次摊薄 / 成功率按分组）**属翻译线，已归 skill `rpgmaker-intl-pipeline`**（2026-10-15 从此处挪走，避免两头各写一份）；想验某条线的注入量，按 skill `relay-forensics` 测。

**凭证安全（2026-09-24 实测）**：DSHA App 启动 proot 容器时把 `DEEPSEEK_API_KEY` 明文放进**命令行参数**（`/proc/<pid>/cmdline` 可见，容器内 `ps` 即可读到）。来源是 App 层、非 AI 引入；暴露面与 `keyring.json` 同级（都在容器内）→ **不必紧急轮换**，但应并入向上游的反馈。自己的命令**不要写成 `VAR=key cmd` 形式**（同样会进 argv），要从文件读再 `env` 注入；任何 key **不得**写进产物/文档/日志。

## CLI 能力速查（官方文档 + 本机实测对照；exec / app-server 路径 2026-10-08 在 0.161.0 下已复验）

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
- **派单走 `dispatch.sh`**：自动注入 `inbox-codex.md` 未读段 + 派单**前**记基线 commit 与脏快照 → `.dispatch/<task id>.base`；交付后 `board.sh scope-check <id> --workdir <dir>` 机械校验 write_scopes 越界（⚠️ 脏工作区会漏报，尽量给干净目录，见协议 §十一）。 **2026-10-13 起硬约束**：`--context`（lead 的解读）/ `--self-test`（自测与验收方式）/ write_scopes（或显式 `--read-only`）**缺一即拒发**（exit 2）；`auto_archive()` 已移到派单**成功之后**（原顺序在派单前，派单失败会静默吞掉收件箱未读段）。
- **双通道**：短任务 `POST /api/task`（ephemeral 零记忆，互审/复核用）；长任务 `codex exec` 落盘 + `codex exec resume <thread_id>` 成员会话（一条链绑一个任务，thread id 记在看板 `session` 字段；0.156.1 实测跨单记忆保持）。长任务不走 API（API 不支持 resume），用命令行降级姿势手动注入 key。
- 工单三字段 task/context/frame；交付强制四段含【异议位】。细则读 PROTOCOL.md §九（工具化纪律）与 §十一（已知限制）。

### ⚠️ 派单必须显式 `--workdir <绝对路径>`（2026-10-14 事故）

`dispatch.sh` 的 `--workdir` **默认值是 `.`**，按 Web 进程 cwd 解析；落到 `$HOME` 时插件会在家目录 `git init && git add -A`，把整张家目录（含 `.ssh`/`.dsh` 凭据）加进 git 索引，并让 Web 面板的「改动摘要」从此被污染。**完整复盘、三层加固、判据命令见 skill `dsh-env-maintenance` 的「2026-10-14 事故」节**；`dispatch.sh` 现已拒绝相对路径与 home/root。

**纪律**：派单一律 `--workdir ~/proj`，别省。

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
| 任务**秒退**且过程流尾部是 `exceeded retry limit, last status: 429 Too Many Requests` | **先分清是「本地限速」还是「上游侧拒绝」—— 两者都报 429**。⚠️ **别用小请求探活当判据**：几个 token 的探针能返回 200，而 Codex 每次 40K+ token 上下文会被直接拒 —— 2026-10-03 我据此误判成"限速窗口很长"，还多灌了 55 个请求。**判据 = 看面板**；确属限速才冷却重派，否则换 provider |
| 工具全灭 approval never | 同上 |

## Codex 升级姿势 + 升级后破坏性检验

**升级姿势（0.161.0 实测）**：取 npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`，用其 `dist.integrity` 校 sha512（157MB tgz / 23.2s）；解包得主二进制 253MB + sidecar `codex-code-mode-host`（**须与主二进制同目录**）+ `codex-path/rg`（PATH 已有 `/usr/bin/rg`，**免装**）。**先跑包内 `bin/codex --version` 验活，再 `cp -a` 备份旧二进制（`<Codex 安装目录>/*.bak-<旧版>`）后替换**；回滚＝换回该备份文件。

**每次升级后跑三条检验 —— 判据与处置固定**：

| # | 检验什么 | 命令 | 通过判据 | 不过怎么办 |
|---|---|---|---|---|
| 1 | 工具面 | `node ~/.dsh/scripts/dsh/se-tool-probe.mjs` | 工具**名字集合**与上一版基线一致（**只看名字，不看字节数**——整份请求体本来就不逐字节一致） | 工具名增删 ⇒ 上游改了工具面，复核插件对工具名的假设 |
| 2 | 执行链 | `bash ~/.dsh/scripts/dsh/se-appserver-verify.sh` | 5/5（appserver 派单+流式进度 / cancel 打断无残留 / exec 回归） | **插件必须动**：先切 `exec` 模式兜底，再修 |
| 3 | DSH 依赖点 | `python3 ~/.dsh/scripts/dsh/dsh-dep-check.py` | 全 OK | 与 codex 版本无关，属 DSH 侧问题 |
| 4 | **版本锚点** | 手工：改本文件首节「当前 x.y.z」+ `Codex功能表.md` 顶部「当前版本」 | 两处都等于 `codex --version` | 漏改 ⇒ 下次照着旧版本号做判断 |

**「维护 skill」的完整含义 = 上面第 4 行（改两处版本锚点）**；只有第 2 条判不过，才需要动插件代码。

**人工判断（不可省）**：只读 release notes 四段归纳里的**插件调用面** —— `codex exec`（参数 `--skip-git-repo-check --ephemeral -o`）与 `codex app-server`。这两条未动 ⇒ **插件无需维护**；有变动或被默认收紧（例：0.161.0 把 `Daybreak` 改成必须 `--enable cli_daybreak`）⇒ 记一条并评估。

**0.161.0 实测**：三条全过（9 个工具名与 0.160.0 一致；appserver/exec 5/5；dep 3 探针 OK）⇒ **插件无需维护**。附带净收益：Responses 重试与 WS→HTTP 回退遵循服务端建议（治第三方端点断流）、`resume` 含最新已提交历史（dual-board 长链更稳）。

**0.162.1 实测（2026-10-11）**：三条全过 —— 工具面 9 个名字与 0.161.0 一致（`exec_command`/`write_stdin`/`request_user_input`/`view_image`/`multi_agent_v1`/`get_goal`/`create_goal`/`update_goal`/`web_search`）；appserver+exec 执行链 **5/5**（含 cancel 打断后无残留进程）；dep 探针 **6 条全 OK**（⚠️ 探针数已从 0.161.0 时的 3 增至 6，别再照旧数字核对）⇒ **插件无需维护**，锚点已同步（本文件首节 + `Codex功能表.md` 顶部）。

⚠️ **同日核对到的缺口**：`<Codex 安装目录>/` 下**只剩主二进制与 `code-mode-host` sidecar，没有任何 `.bak` 备份**（升级发生于 2026-10-10 03:50），也就是说本节的"回滚＝换回备份文件"**当前无法执行**。下次升级前应先 `cp -a` 补一份，否则出问题只能重新下载旧版包。

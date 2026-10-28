---
name: second-engine
description: 唤起与操作第二引擎（Codex 或 Pi，可在设置页切换）的完整流程：引擎切换、提供方与模型管理、工单下发（API 优先）、双向互审、卡点求助响应、结果验收、会话磁盘管理。当任务需要异构第二意见、并行下探子任务、独立复核，或用户说「用 Codex / 用 Pi / 第二引擎 / 第二意见 / 让 Codex 试试」时使用。
---

# second-engine · 第二引擎操作流程（Codex / Pi）

## 🔴 什么时候该派它（2026-10-14 用户定稿 · 两分法）

**先分清两种情形 —— 别把"派单"当成碰壁的补救**（那会把自己养成行动的侏儒）。

### A. 本来就该它干的事（不必等卡，可以主动派）
- **独立复核**：我的产出要人挑错，**尤其"我觉得对"的时候**。
- **并行下探**：任务能拆成互不依赖的子块（⚠️ 先冻结接口，否则并行产物对不上）。
- **它是一手信源**：涉及它自己的运行环境 / 协议 / 历史（工单、session、config、keyring、app-server 协议）。
- **异构第二意见**：需要的是**与我的思路不同的解**，而不是同一条路径再试一遍。

### B. 我自己卡住了（**早问 ≠ 早停**）
**派单条件很低，停手条件很高** —— 两件事，别混。

**什么时候可以派**：触头一出现就够了（红线 4 三形态：同一点试两次不通 / 结果怪又说不清 / 反复绕回同一处）。一单成本约 3 分钟，不值得为它再硬耗几小时。
**什么时候才能停手**：四步穷尽 —— ① **实测**（看真实回执，不看猜、不看记忆）② **搜索**（网络 + 官方文档）③ **换路径继续实测**（换方法 / 换工具 / 换写法）④ 以上全试过仍不通。**派单不能替代这四步里的任何一步**：问完回来照样要自己实测、自己签判断。

⚠️ 错的是"**两下不行就去问，问完就停**" —— 错在**后半句**。问得早不丢判断权，**问了就照抄才丢**。
⚠️ **别把它的自救阈值当我派单的阈值**：Codex 侧「同一路径失败 2 次就喊」是**它**的自救线，不是**我**的（两个主体、两套判据，不能合并）。

**反例（别派）**：局部小错、改法明确 → 我直接改；回炉要等它重跑、更慢更险（判据是错误在**"点"还是"面"**，见「三条道并行」节）。

⚠️ **它喊我，我不查就看不到**（2026-10-14 实测）：consult 走 `POST /api/consult`、记录进 `GET /api/consults`，但**主 AI 侧没有被动通道** ⇒ **派单前记基线 → 收单后比增量 → 收尾前再查一次**。2026-10-25 起 consult 记录支持 `taskId`（派单 prompt 写明「你的工单 id 是 X，consult 时回传」即精确归属）；不带时增量法仍是唯一可靠判据：

```bash
BASE=$(curl -s "$DSH_WEB_URL/second-engine/api/consults" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])")
# …派单、收单…
curl -s "$DSH_WEB_URL/second-engine/api/consults"   # count 超出 BASE 的部分 = 本次新增求助，逐条接手解围
```

✅ 收尾时**本任务期间**的求助会自动以 `[SECOND_ENGINE_CONSULT]` 块追加进 `task.output`（2026-10-14 起，收单读 output 即见）。仍会漏的两场景：① 任务永不结束（`finalizeTask` 不跑）→ 看 `GET /api/task` 的 **`stuckSuspect:true`**（看门狗 300s 无输出置位）就转去查 consults；② review 内部循环 → 2026-10-25 起 `finalizeReview` 已统一走 `finalizeJob`，不再单独漏。

### 选哪个引擎（Pi vs Codex，2026-10-29 补 —— 此前只有"怎么操作"，没有"为什么用这个"）

判据按**你要什么能力**，不按哪个"更好"：

| 你要的 | 选 | 依据（不是偏好） |
|---|---|---|
| **多轮批判复核**（`/review`、协作提议） | **Codex** | Pi 无复核链路，面板会隐藏该卡（点了必失败） |
| **流式进度 + 真打断**（长任务看过程、要能取消） | **Codex** | app-server 模式；Pi 走 exec，取消只能靠 SIGTERM |
| **`web_search`** | **Codex** | Pi 内置工具无联网（read/bash/edit/grep/find/ls），联网得自己配 MCP |
| **多 provider 并存、随时切** | **Pi** | `models.json` 可存多个 provider 各自模型，切换只改 `defaultProvider/defaultModel` |
| **省体积** | **Pi** | 22 MB vs 223 MB CLI（Codex 是 223 MB + 70 MB sidecar）|
| 只要一个**独立第二意见** | 都行 | 用当前 active 的，别为选型来回切 |

一句话：**要"审"走 Codex；要"几个厂商的模型并存、随时横向比"走 Pi。**

⚠️ **别把"能换模型"当成 Pi 的卖点** —— **Codex 同样能换**（改 `config.toml` 的 `model_provider` + `model`，本机现为 zhipu/glm-5.3-flash）。真实差别是：Codex 一次一个 active provider，Pi 可并存多个。

> 判据：**引擎能力看 CLI/配置文件，不看 Web 控件列几个**。下拉只显示当前值属 UI 层（缺陷记待办），别据此推断"这个引擎不能换模型"。

两条容易踩的：
- 切换即时生效（`~/.dsh/second-engine-engine.txt`），但**会话不迁移** —— 已开的工单留在原引擎，切完看不到旧单。
- Pi 下复核/工单/版本这类卡片会被隐藏，**不是故障**（面板按引擎渲染）。

### C. 用哪条通道派（2026-10-15 · 官方原生工具 vs 本插件）

DSH 侧**两条路都能叫到 Codex**，别混：

| | `subagent_codex`（DSH 原生工具） | 本插件（second-engine API） |
|---|---|---|
| 怎么调 | 直接调工具，一行 | `curl $DSH_WEB_URL/second-engine/api/task` |
| 形态 | **进程内**一次委派，结果直接回到我的上下文 | **进程外**任务通道，有队列 / 历史 / output 留存 |
| 异步 | 支持（`run_in_background`），`job_output` 收 | 支持（完成弹 App 通知） |
| 取消 | `job_kill` | `/api/task/cancel` |
| 人能不能看见 | **看不见**（没有面板） | **能**（设置页面板 + `/api/tasks`） |
| 换 provider / 模型 | **不能**，只能吃 config.toml 里 active 的那份 | **能**（keyring 多 provider；切 active 自动重写 config.toml） |
| 多轮互审 / 主动求助 / MCP / web_search / 会话清理 / 版本检查 | 无 | 有 |
| 跨工单连续性 | 无 | 无 |

**判据一句话**：一件自包含的活、只要它把答案带回来给我 ⇒ `subagent_codex`（最短路径，默认等结果）；要人看得见 / 要留痕 / 要换模型 / 要多轮互审 / 要它主动来找我 ⇒ 走本插件 API。

**共同点**：两条都是「**一 run 一进程一 thread，无 resume**」（官方原话，本机两条都已实测）⇒ **要连续性只能靠 dual-board 文本看板**，别指望引擎。

⚠️ **`subagent_codex` 的工具描述里完全没提 Codex**（与通用 `subagent` 的描述前半段逐字相同），新会话的 AI 不会自动知道该用它干 Codex 的活，也读不出它没有连续性、`permissionMode` 默认 `never`。**这条判据正是本 skill 存在的意义之一。**

⚠️ 它的凭据由 provider 的 `env` 显式喂（**形似凭据的环境变量会被先剥离**，放 `~/.dsh/.env` 也没用）；本机做法是 `!!js` 现场从 `~/.codex/keyring.json` 读 active provider 的 key，凭据不落明文。装法/坑见 skill `dsh-plugin-discipline` 第五节。

### D. 派单前先读档位（2026-10-25 · 责任在主 AI）

**同一张工单，三档三种发法。** 主 AI 没有推送通道，档位只能自己查，别凭上一轮印象：

```bash
curl -s "$DSH_WEB_URL/second-engine/api/status" | python3 -c "import sys,json;print(json.load(sys.stdin)['collab'])"
```

拿到 `preset` 就照「三种模式的派单方式」发：`review` 单发不问表态 / `propose` 单发 + prompt 里要 `LONGSESSION:` 行 / `longtask` **不派工单**、直接 `codex exec` 起长会话。**查不到（接口挂、字段缺）一律按 `review` 兜底**，不猜；字段含义见「协作模式开关」。

## 文件地图 · 哪份是真身（2026-10-28 立；当晚在这上面连错三次）

| 路径 | 身份 | 什么时候动 |
|---|---|---|
| `<插件目录>/` | **代码真身**（唯一带 git 历史的） | 改代码只改这里 |
| `~/.dsh/plugin-src/dsh-second-engine/` | **加载层**：Web 进程实际 import 的那份 | 真身改完**必须 `cp` 过来**；漏了＝没生效（重启也白搭） |
| `second-engine-publish/`（独立克隆） | 发布树（文档已剔私） | **只在发版时**同步 |
| `~/proj/dual-board/` | **数据**：board.json / channel.md / inbox-* / archive / .dispatch | 只放数据，**不放脚本**（旧副本 2026-10-28 已删） |
| `~/.dsh/待办/多引擎适配-施工追踪.md` | 本次长任务的施工台账 | 每块做完划线 |

- **自检一条命令**：`bash <插件目录>/tools/smoke.sh` 第 8 段比对 **17 个文件**的三处指纹；文档类（README / CHANGELOG / PROTOCOL / env.example）发布树是剔私版，只比存在不比内容。
- **board 唯一入口**：`<插件目录>/tools/dual-board/board.sh`；数据目录默认 `~/proj/dual-board`（`DUAL_BOARD_DIR` 可覆盖）。
- **三个坑（实测踩的）**：① 改完真身没同步加载层 → 重启后验证白跑；② `board_tool.py` 的 `CHANNEL` 曾错挂 `dirname(__file__)`，`complete` 的清场全写进插件目录（已改为跟 `BOARD_DIR`）；③ 面板卡片状态白名单曾漏 `cancelled`，导致「已取消 + 运行中」并存。

## Pi 引擎（2026-10-28 实测立；路径与事件格式都是本机跑出来的，不是文档抄的）

插件支持 `engine=codex|pi` 切换（`~/.dsh/second-engine-engine.txt`）。Pi 不是 Codex，**下面每个路径都不同**：

| 用途 | Codex | Pi |
|---|---|---|
| 模型清单 | `~/.codex/config.toml` | `~/.pi/agent/models.json`（`{providers:{<id>:{baseUrl,api,apiKey,models:[{id}]}}}`）|
| 默认模型 | 同上 | `~/.pi/agent/settings.json` → `defaultProvider` / `defaultModel` |
| MCP | `config.toml` 的 `[mcp_servers.*]` | `~/.pi/agent/mcp.json`（`{mcpServers:{name:{url}|{command,args}}}`，禁用写 `enabled:false`）|
| 会话 | `~/.codex/sessions` | `~/.pi/agent/sessions/<cwd>/*.jsonl` |
| 模型缓存 | — | `~/.pi/agent/models-store.json` |
| 聊天桥 | 8787 附近，`ctl.sh` | **8788**，`bridge/pi/server.mjs`（自己管 `pi --mode rpc`）|

**三个只能实测才知道的事实**：

1. **流式文本在 `message_update.assistantMessageEvent`**：`{type:'text_delta', delta:'你好'}`。`raw.message` 是空的（PiHub 0.4.0 就按 `raw.message` 读，对 Pi 1.4.0 拿不到增量）。结束信号用 `agent_settled`（比 `agent_end` 晚，带 `aborted`）。
2. **`get_available_models` 返回全局清单**：每项带 `provider` 字段，不按它过滤就会把别家的模型混进来（真实事故：拉 DeepSeek 出现 glm-5.3）。
3. **Pi 没有 `web_search`**：内置工具只有 read/bash/powershell/edit/write/grep/find/ls（+codemode/tool_search），联网走 MCP。别把 Codex 的 `web_search` 开关套上去。

**桥的进程 pid 不写在日志里**：`[pi-bridge] … pid=NNNN` 那个是 **pi 子进程**，不是桥进程。按它 kill 会「桥还在、子进程死」→ prompt 永远超时 + 新进程 `EADDRINUSE`。桥的真实 pid 只能按 `/proc/*/cmdline` 精确匹配（`argv[0]` 以 `node` 结尾 且 `argv[1]` 以 `bridge/pi/server.mjs` 结尾）。

**聊天桥前端契约**（复用 `bridge/web/public/index.html`，与 Codex 桥同一个页面）：`/api/send` 必须回 **NDJSON 流**，逐行 `{kind:'meta'|'text'|'activity'}`，收尾 `{kind:'end'}`；回一次性 JSON 会让界面**静默无反应**。页面还需要 token：不带 `?t=` 时靠 302 到 `/?t=local` 种进 localStorage，否则红条「没有 token」且禁止发送。

## 派单与核对纪律（从多次误判提炼，只记判据不记过程）

- **workdir 里不能放同名过期副本**。模型会诚实去读 workdir 里能找到的那份，给出「对那份完全正确、对真身全错」的答案。派单前 `find <workdir> -name index.js` 查一遍；发现副本就挪走或改名。
- **核对它给的行号，先确认为它读的是哪份文件**。拿 A 的行号去比 B，会得出「它在编」的错误结论——实际它读的是旧快照且 6/6 命中。**先问"你读的哪个路径"，再判对错。**
- **要它精确改代码，路径写到文件级**：`<插件目录>/src/index.js`，别只给 workdir。
- **采纳它提出的新名词前先 `grep -c`**。合同里塞进 `queued`/`finalizing` 两个状态，代码里 0 命中——凭空放大改造面。**新名词先验证存在性**。
- **改「取消 / 终局」这类语义，先把所有写点找齐**。exec 走 `child.on('exit')`、appserver 走 `handle.done` reject；只改一条路径等于没改，且要等真实取消才暴露。
- **删一个副作用前，查它还兼管什么**。`utimesSync(outPath)` 同时喂看门狗和污染 `cleanupLiveFiles` 的 mtime 判据——删掉解耦了两件事，也顺带改了清理行为（这是好事，但要知道）。
- **同一块 UI 可能有两套判据**。面板标题走 `taskStateText()`（认 `cancelled`），同卡片的 `status` 变量白名单只有 `done|error` → 出现「已取消 + 运行中」并存。改状态语义时扫全部判据，不只看一处。
- **`grep task\.<字段>` 这类归零判据看不见对象字面量里的裸字段**（`const task = { ..., child, ... }`）。改字段归属时必须对着**每条创建路径**逐个确认（本项目三条：appserver / exec / review）；否则会出现「grep 已归零、运行时却拿不到值」——2026-10-28 就这么漏了 exec 的 child，导致取消杀不死进程、`endedAt` 永不落定，而冒烟 32 项全绿。

## 引擎现状（版本号、开关态、逐版实测一律查 `<本机功能核对表>`，本文件不记）
- 二进制 `/usr/local/bin/codex`（musl 静态）；沙箱 `danger-full-access`（proot 无 Landlock/bwrap）→ **防线靠流程：工作副本隔离 + diff 审查 + git 仲裁**；升级姿势 + 升级后破坏性检验见本文末节。
- 提供方与 key 由插件统一管理：`~/.codex/keyring.json`（0600，**不手改**），激活切换时自动重写 `~/.codex/config.toml`（**不手改**，sandbox_mode 自动保留）。
- 预设两家均实测直连：DeepSeek（responses）/ 智谱（responses，Coding 端点）；chat 协议上游（中转 / 自建）经本地翻译桥自动挂接。
- 🔴 **wireApi 怎么选（2026-10-03 实证，接任何第三方端点前必做）**：判据只有一条 —— 直接 `POST {base}/responses` 发最小请求，**200 = 原生支持 Responses 标 `responses` 直连；404/400 才标 `completions` 走桥**。**别默认套 `completions`**：桥只保证**文本**往返，**工具调用循环会断**（同模型同工单经桥 exit 0 + 零产物；改直连后同一工单立刻成功）。**判据："工单 exit 0 但工作目录没有新文件" = 假完成**，第一件事查它是不是走了桥。
- ✅ `/providers/update` 已支持原地改 `wireApi`（2026-10-03），不必"新增一个提供方再切 active"绕行。两条前提：① 改完**重启 Web** 新代码才生效（`updated:[]` + `configRegenerated:false` 就是未生效信号）；② 换 `responses` 前先按上条验过端点原生支持。

## `~/.codex/`（CODEX_HOME）现场查（完整目录地图已外移 `<本机功能核对表>` 附A）

- 大小分布：`du -sh ~/.codex/* ~/.codex/.tmp 2>/dev/null | sort -rh | head -15`
- 工单原始输出：`ls -la ~/.codex/task-*.out.live`（**工单 ID 只在文件名里、不在内容里**，查单用文件名或 mtime；清理走 `POST /second-engine/api/cleanup`，**别手删 sqlite 状态库**）
- 会话 rollout：`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`，**仅工单 `ephemeral:false` 才落盘**（缺省 true 不写）⇒ **磁盘查不到 ≠ 没跑**。最近一份的一行读法：

```bash
f=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)
python3 -c "import json,sys
for i,l in enumerate(open(sys.argv[1],encoding='utf-8')):
    d=json.loads(l); print(i,d.get('type'),str(d.get('payload'))[:120])" "$f"
```

## API 优先（本插件服务层，入口 = 当前 Web 地址 `$DSH_WEB_URL`，随端口变、别写死）

```bash
W="$DSH_WEB_URL"   # 例: http://127.0.0.1:<Web端口>
curl -s "$W/second-engine/api/status"      # 自检: {"ok":true,...}
curl -s -X POST "$W/second-engine/api/task" -H 'Content-Type: application/json' \
     -d '{"prompt":"<自包含工单>","workdir":"~/proj","ephemeral":true}'   # → {"id":"..."}
```

- ⚠️ **别用 App 设备桥的端口**（`/app/*` 读屏/点按/截屏/通知那套）：那不是插件路由，未知路径会被当 shell 命令回 `{"result":"[NO_CMD]"}` —— 是敲错门，不是插件故障（2026-09-27 实测踩过）。
- **全量路由（method / path / desc，随代码自动生成，勿手抄）**：`curl -s "$DSH_WEB_URL/second-engine/api/_meta"`（浏览器桥的 4 条 `/api/bridge/*` 另注册于 `bridge-routes.js`，不在此清单）。

## 协作模式开关（collab 两位，2026-10-25 落地）

**派单前查 `GET /api/status` 的 `collab` 字段**——当前值、来源与优先级链（env `SECOND_ENGINE_VOICE`/`SECOND_ENGINE_LONGTASK` > `~/.dsh/second-engine-collab.txt` > 默认，逐位独立）等一切现状以该字段为准，本节不复述代码行为：

- **位 1 `voice`**：`on` = `~/.codex/AGENTS.md` 有「主动开口」段（允许它推荐自己）；`off` = 无。
- **位 2 `longtask`**：`auto` = 分阶段任务直接开长会话 + dual-board；`manual` = 升级走漏斗三判据。**只影响主 AI 派单，不写进 AGENTS.md**。
- 预设：`review`(off/manual) / `propose`(on/manual) / `longtask`(on/auto) / `custom`(off/auto，只能显式两位表达)。
- **切档是用户裁决，主 AI 不擅自 POST `/api/config`**；`voice=on` 是**许可不是分支**（独立复核照样走单次工单）。拨档（UI 未上线前）：
  `curl -s -X POST "$DSH_WEB_URL/second-engine/api/config" -H 'Content-Type: application/json' -d '{"preset":"…"}'`（回包 collab + `agentsWritten:true` 表示 AGENTS.md 已同步，仅 voice 档有段）

### 三种模式的派单方式（2026-10-25 定 · 责任在主 AI 不在 Codex）

**核心判断：别指望 Codex 自己判断「何时该提议、何时该拉长」**——实测三次它都不遵守 AGENTS.md 里的业务策略指令（评估工单 / 简单工单 / 手动加「必须表态」全都不写），而格式指令（文件首行 `MARKER-OK`）照做 ⇒ **要它做什么，就在这次工单里说，别放全局教义**。

| 模式 | 主 AI 派单时怎么做 |
|---|---|
| **普通复核（review）** | 一次性工单；不要求表态，也不要求提议 |
| **协作提议（propose）** | 一次性工单 + **prompt 里明确要求**：「交付末尾给一行 `LONGSESSION: yes/no`；若 yes，说明你愿意接哪部分」。要提议就直接问，不等它自觉 |
| **长任务配合（longtask）** | **不派工单**：`codex exec`（**不带** `--ephemeral`，手动注入 provider key）拿 thread id → `codex exec resume <完整 36 位 UUID>` 直接长会话；thread id 记 dual-board 的 `session` 字段 |

- 长会话不走 API 的原因：`POST /api/task` 固定 `--ephemeral` 不支持 resume；协议层虽有 `thread/resume` 但插件未暴露 ⇒ 只能 CLI 降级。
- ⚠️ **8 位前缀会静默新建会话**：resume 必须给完整 36 位 UUID（`codex delete` 无 TTY 要 `--force` 且同样要完整 UUID）。
- `voice=on` 的 AGENTS.md 段保留（允许它主动接管），但触发由主 AI 在 prompt 里给，不靠教义自觉。

## 检查点（CHECKPOINTS）

长任务工单里写**声明式停手点**，让它 turn 内自行判断「到点了」就结束并汇报。**为什么需要**：一个 turn 可连续跑几十分钟，turn 之间必须主 AI 唤起（它没有后台 job），停手点是用户中途介入的唯一机制；硬兜底 `stuckSuspect`（300s 无输出）+ `/api/task/cancel`。

```
CHECKPOINTS:
1. 完成 <文件/模块> 后停手，汇报改了哪些函数、有没有测试
2. 跑通 node --check + 回归后停手
3. 预计剩余工作量超过 2 个文件时，停下等我确认
```

## 标准流程

1. **下发**：`POST "$DSH_WEB_URL/second-engine/api/task"`，工单自包含、小粒度（Codex 零记忆）；workdir 默认 `~/proj`（**绝不进主工作区**）；默认 `--ephemeral` 不落盘（审计靠 git diff）。返回 `{id}` 即异步开跑。
2. **等待**：`bash <插件目录>/tools/wait-task.sh <id> [间隔=5] [超时=600]` 放**后台 job**，完成由 App 通知自动唤醒（0=done / 2=失败 / 3=不存在 / 4=接口不可用 / 124=超时）——**禁止自写 `sleep`+`curl` 轮询**（既多余又占着会话不放）。
3. **验收**：`GET /api/task?id=` 读 output + 工作目录 `git diff` 审查 → apply / 打回（新工单指出问题）/ 升级用户裁决。
4. **互审**：把主 AI 产出（结论/方案/diff）`POST /api/review`，Codex 批判复核（上限内自动多轮，零新增即收敛，**最终结论一次上交用户裁决**）；单轮需求改走工单，判据见「三条道并行」。
5. **求助响应**：`GET /api/consults` 看 Codex 卡点（手机通知会提示）→ 针对性下工单解围。HTTP 不通时它在输出末尾写 `[CONSULT-NEEDED] <卡点描述>`；**触发阈值＝同一路径/命令失败 2 次**（插件 `AGENTS_SECTION` / `~/.codex/AGENTS.md` / `~/proj/AGENTS.md` 三处对齐）。

## 执行模式（exec / appserver，运行时切换、不需要重启）

- **exec**（默认）：`codex exec` 一次性子进程，行为与旧版一致。
- **appserver**：`codex app-server` JSON-RPC 长连接——`GET /api/task?id=` 多 `progress` 字段（最近 20 条归一化事件，可看流式进度）；`POST /api/task/cancel` 先发 `turn/interrupt`（65ms 级结束）。输出仍落 `-o` 文件，看门狗判据不变，任何事件都刷新输出 mtime。
- **复核恒走 exec，不支持 appserver**（2026-10-25 定）。

```sh
echo appserver > ~/.dsh/second-engine-mode.txt   # 切 app-server（2026-10-26 查：当前值为 exec）
echo exec      > ~/.dsh/second-engine-mode.txt   # 切回
```
优先级：env `SECOND_ENGINE_EXEC_MODE` > 模式文件 > 默认 `exec`。验收：`bash ~/.dsh/scripts/dsh/se-appserver-verify.sh`（流式进度 / 打断 / exec 回归三条判据）。

**实时可见性（判断"到底行动了没"）**：exec 看 `GET /api/task?id=` 的 `liveBytes`（过程流字节数，持续增长即在动；但**增长 ≠ 有效产出**，看痕迹判据见「三条道并行」末条）；appserver 另有 `progress` 数组（reasoning / 文本增量 / 工具调用 / 用量），协议映射 `~/.dsh/refs/codex-appserver-spike-20260928/MAPPING.md`（原 `~/proj/appserver-spike` 已迁 refs）。模型清单：`POST /api/models {id}` 对智谱**并集**两个端点（`/api/v1` 只 3 个 + `/api/coding/paas/v4` 全量），响应 `sources` 回显实际来源，两端点共用同一 key（2026-09-28 实测）。

## 命令行降级（无插件环境 / 需要交互时）

```bash
codex-env          # 插件提供：自动注入激活提供方 key → 进 TUI（Ctrl+D 或 /quit 退出）
# 手动（⚠️ 别写成 VAR=key cmd，会进 argv 被 ps 看到）：
KEY=$(head -1 "<你的 API key 文件>"); cd ~/proj && env PROVIDER_API_KEY="$KEY" codex exec --skip-git-repo-check -o /tmp/out.txt "工单"
```
- 长线程需 resume 时不加 `--ephemeral`（完整 36 位 UUID）；结构化收结果用 `-o <文件>` 或 `--json`。

## 协作边界（与 Codex 自述一致）

- Codex = 生产者；DSH 主 AI = 编排者 + 审核者；用户 = 裁决者。
- 三个价值按权重：**独立复核**（抓自洽却错的推理）> 视角互补（备选方案）> 并行下探（不重叠子任务外包）。
- 它不做最终决策，产出是「可验证的第二个信号」；停滞/绕圈时走 consult 求助，不硬试。

## 三条道并行：工单 / 复核 / 互补（2026-10-26 合并定稿，含派单判据）

它们不是三选一，而是随时可切换的三条道——方案阶段让它复核，实施阶段让它施工，两者交替用。**总判据一句话：看东西是谁产生的、错了是否不可逆。**

| 你要的 | 走哪条 | 为什么 |
|---|---|---|
| 我手里还没有的产出（代码 / 文件 / 调查 / 第二方案） | **工单** `POST /api/task` | 它是生产者 |
| 产出已在我手里（结论 / 方案 / diff / 外部评估），要挑错 | **复核** `POST /api/review` | 它是挑错者 |
| 只需要**一轮**意见 | **工单**（交付自带【异议位】） | 单轮复核＝工单；复核面板没有输入入口 |
| 需要**多轮收敛**（意见矛盾 / 确认修干净） | **复核**，一次只发一条 | 自动多轮 + loop 检测 |
| 局部小错、改法明确 | 自己改 | 回炉更慢更险 |
| 琐碎 / 低风险 / 单文件 | 都不做 | 免进漏斗 |

| 用法 | 场景 | 工单必须写清 |
|---|---|---|
| **并行施工** | 有一块可独立实施的代码/文件 | 工作副本路径 + 文件级要求 + 自测清单；**要产物，不要建议** |
| **独立复核** | 想让它挑我方案/结论的毛病 | 明确「只评审、不改文件」+ 要求可复现的反例 |
| **视角互补** | 我不确定时取第二方案 | 同样落到文件/命令级，不接受泛泛而谈 |

| | **短期工单**（`POST /api/task`，ephemeral） | **长任务会话**（`codex exec` + `resume`，dual-board 链） |
|---|---|---|
| 记忆 | **零**——每单从零开始，看不见上一单 | 跨单保持，理解前因后果 |
| 适合 | 独立、自包含、边界清晰的一块活 | 多环节、需要持续理解项目的长链 |
| 出错时 | 小错主 AI 直接改；只有大面积/方向性错误才回炉 | 可以打回，它有上下文能改对 |
| 主要风险 | 不理解整体项目，反复回炉越改越错 | 链长、状态多 |

⚠️ **判据只看一件事：错的是「点」还是「面」**。别把长任务的「打回重做」习惯套到短期工单上——回炉＝让它从零重理解 + 等它慢慢跑 + 断流风险，通常比主 AI 直接改那几行更差。

**施工派单五要点（实证）**：① **先冻结接口再分头开工**（谁改哪个文件、文件之间靠什么约定交互，全写进工单，否则并行产物对不上）② **给它工作副本，不给主工作区**（`~/proj` 或专门副本，绝不指向插件实体 / 主工作区）③ **要求自测并贴真实输出**（`bash -n` / `node --check` / 临时端口跑一圈；不接受「我改好了」）④ **取用看 `git diff` + 复跑自测**，按点/面决定谁修（局部小错主 AI 直接改——回炉要等它重跑、ephemeral 工单无项目全局记忆容易越改越错；大面积/方向性错误回炉重做，新工单写清问题）⑤ **工单模板**：范围（只改 X 不动 Y）→ 逐条改动 A/B/C → 硬约束（备份名 / 禁 `pkill -f` / 敏感信息不得出现）→ 自测清单 → 四段产出（含【异议位】）。

**派生任务四要素**（每次把活派给 Codex——工单 / 复核 / 长会话都算——缺一样它就会在真空里乱窜）：

| 要素 | 回答什么 | 反例 |
|---|---|---|
| **目的** | 最终要造成什么、谁用、验收标准 | 「优化一下」 |
| **原料** | 读哪些文件 / 哪段 diff / 哪个 commit；**被审对象的具体锚点（路径 + 行号范围）** | 「看看这个项目」 |
| **行为边界** | 允许做什么、**禁止做什么**（不碰凭据 / 不重启 / 只改副本 / 禁 `pkill -f`） | 只说「注意安全」 |
| **结构** | 交付物形状（文件 / 函数 / 格式 / 四段产出含【异议位】）、工作副本绝对路径 | 「给我个方案」 |

**推理预算（复杂单必写）**：工单里加一句「最多 2 次不带写入的动作（读/搜索/推演都算），第 3 次必须 Write/Edit 落盘」——实测不写则连续三轮各推演 8–12 分钟零落盘，写上则 4 分钟落 392 行。**它会在边界情况上无限自我验证，硬预算比"别想太久"有效**。复核同理：`content` 不是随便一段话，要指明审哪个文件、哪段 diff；没有锚点它会在 workdir 里自己找目标。

**复核纪律与生命周期（2026-10-25/26 已落地，源码复核在案）**：

- **一次只发一条复核**（同一内容重复发起没有信息增量，自动多轮就是空转：5 轮配置下第 5 轮判 `loop`）；**不每轮裁决，最终结论一次上交用户**（`reviewRounds` 是上限不是目标）。发起前主动 `GET /api/config` 读 reviewRounds（主 AI 没有推送；实测当前 3，`roundsChoices:[1,3,5]`）；要锁定轮数就显式传 `rounds`，响应必回 `maxRounds` 可核对。发起时写清三件事：被审对象是什么（含路径）、验收到什么程度算过、几轮内不收敛就停。
- 生命周期：结果落盘 `~/.codex/reviews/<id>.json`（`GET /api/reviews?limit=` 可列）；收尾时未决问题摘成 `[REVIEW_ISSUES]` 追加进复核任务 output（**收单必读**）；复核窗口内工作区被改动会记 `reviewDirty`（证据、非归因）。
- **续轮**：`POST /api/review {content, prev:"<上一轮id>"}`，服务端取上一轮 issues 作种子（跨重启可用），响应 `prevSeeded:true`。
- **回辩（真讨论）**：`reply:[{issueId, decision:"accepted|partial|rejected", reason}]`（旧 `issueIndex` 兼容）→ 每轮注入【主 AI 的回应】节；Codex 逐条回 `withdrawn|upheld|reworded`，`upheld` 必须给可核查新证据。**issueId = sha256(severity+规范化 point) 前 12 位**（账本内另有 `i<N>` 序号，服务端算、跨轮稳定）；`task.issueLedger` 记 open/resolved/disputed 与继承链（`GET /api/task?id=` / `GET /api/reviews` 可看）。**终止判据＝ledger 无 open/disputed 且本轮无 upheld**。

**判断「它到底动手没」——看痕迹不看结论**：文件 mtime / 字节数变化（派单前后 `ls -la` 对比）｜过程流 `.live` 出现补丁回显（`Success. Updated the following files: M xxx`）｜工作副本 `git status`。⚠️ **`liveBytes` 增长 ≠ 在干活**（可能只是 `Reconnecting` 重连日志），必须看 `.live` 内容。反面教训：连写两单「只设计评审、不要改文件」，它就只交两份长篇方案——**进入实施阶段必须换「直接改代码」的工单**，编排者的派单方式决定它是帮手还是顾问。

## 三方评估漏斗（短工单探口风 → 三方校准 → 长会话）· 2026-10-21 立

适用：任务开始前 / 卡住时 / 收尾前，判断**整条路**值不值得走。与「独立复核」分开——独立复核只给事实不给我的判断（要它当外部变量）；本漏斗给全事实链，评的是路线本身。**反模式**：探口风写潦草（后两级全歪）、把「总体可行」当通过、用长会话承担本该一单解决的独立复核。

1. **短工单探口风**（成本约 3 分钟）：喂 ① **用户原话**（逐字引，不转述）② **可核查事实链**（产物路径 / commit / 报错原文 / 已试路径 / 轮数）③ **当前卡点**（标明「这句是我的判断」）。**不喂**我的总结与倾向结论（会让它顺着我回答）。要它回三样：整体可行吗 / 我们没看到的是什么 / 它愿意接哪部分。
2. **三方校准**：我回结果与判断 → **用户看原文**交换信息，关键节点让用户直接对 Codex 说原始意图（绕开我的转述损耗）。
3. **可靠性判据（三条全过才升级）**：① 点出我们没有的**具体**风险（不是「建议多做测试」）② 给出**可直接执行**的下一步（文件 / 命令 / 操作顺序）③ 给出**它自己愿意承担**的部分。缺一条 = 礼貌评估，不升级。
4. **拉长会话 + dual-board**：`codex exec resume` 或聊天桥；先与我简短对齐再动工，进度走 dual-board。

- **免进漏斗**（防它变成收费站）：纯执行 / 有先例 / 低风险 / 单文件 / 验收标准明确——**能一句话写出验收命令，就不用探口风**。
- **降级模式（主 AI 缺位）**：用户直接拿三问对 Codex 问，不经过我转述；用户自担核证据（不接受「整体可行」当结论）；可靠性判据前两条不能省，第三条（它愿意接哪部分）没有主 AI 接手时无意义可省。

## 能力边界与 CLI 现场（版本敏感结论已外移 `<本机功能核对表>` 附B/附C）

> 结论随 codex 版本变动，日志旧结论会腐化——本环境已发生过一次（早期记录"exec 单发无协作层"，09-24 实测发现是**整个协作层被上游移除**）。**别直接引旧结论**；版本号、feature 开关、CLI 面、逐版实测一律查 `<本机功能核对表>`。

- **用前重测两条**：`node ~/.dsh/scripts/dsh/se-tool-probe.mjs`（工具面：工具**名字集合**与上版基线比对，只看名字不看字节数）+ `bash ~/.dsh/scripts/dsh/se-appserver-verify.sh`（执行链 5/5）。开关现值一条命令：`codex features list`。
- 换 provider / 换模型后必做「真干活」验证：发小工单让它用 shell 建文件并 cat 确认，看到 `exec /bin/bash -lc "..." succeeded` 且文件真存在，才算工具调用可用（当日实测 token 仅 ~14k）。
- **凭证安全（2026-09-24 实测）**：DSHA App 启动 proot 容器时把 `DEEPSEEK_API_KEY` 明文放进**命令行参数**（`/proc/<pid>/cmdline` 可见；来源是 App 层非 AI 引入，暴露面与 keyring.json 同级，不必紧急轮换，应并入上游反馈）。自己的命令**不要写 `VAR=key cmd`**（同样进 argv），要从文件读再 `env` 注入；任何 key **不得**写进产物/文档/日志。
- 中转站速查：Base `<你的中转站 base_url>`；key 在 `<你的 keyring 目录>/*.txt`（只读取、不写产物）；模型名以 `GET /v1/models` 实拉为准；一账号 5 并发；**敏感数据不过中转**。详见 `<你的中转站目录>/接入档案.md`；选型判据归 skill `relay-forensics`（`<DSH 技能目录>/relay-forensics`）。
- relay 侧现场查（原「2026-09-25 新增能力」整节已外移功能表附D）：（本机私有排查路径，安装者无对应物）；桥 UI 改动记录：`head -60 <插件目录>/bridge/CHANGELOG.md`。
- CLI 现场（完整速查已外移功能表附B）：`codex --help` / `codex features list` / `codex doctor`（一站式环境诊断）；官方文档镜像索引 `curl -sSL https://mintlify.com/openai/codex/llms.txt`，任意页加 `.md` 后缀取纯文本 markdown（openai 官方域本环境全线不可达，一律走镜像）。

## dual-board 双引擎协作看板（2026-09-25 上线；协议实物 v1.3）

- **脚本/协议随插件**：`<插件目录>/tools/dual-board/{board.sh,board_tool.py,dispatch.sh,PROTOCOL.md}`（自定位，`DUAL_BOARD_DIR` 可覆盖数据目录）；**运行数据**默认 `~/proj/dual-board/`（Codex 侧登记 `~/proj/AGENTS.md`）。派单涉及多环节长任务或需 Codex 持续记忆时走这套。
- **写板唯一入口 `board.sh`**：CAS + O_EXCL 锁 + 原子写 + 状态机 + 归档 + 体检全在工具里，**手改 board.json = 破坏协议**；子命令 `new/claim/complete/block/abandon/set/show`、`inbox-append|unread|read|archive`、`archive`、`scope-check`、`doctor`，退出码即语义（0 成功 / 3 CAS 冲突 / 4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 降级），不带参数跑一次看用法。**无 reopen**：completed 不可复改，出问题开新任务引用旧任务。
- **派单走 `dispatch.sh`**：自动注入 `inbox-codex.md` 未读段 + 派单**前**记基线 commit 与脏快照 → `.dispatch/<task id>.base`；交付后 `board.sh scope-check <id> --workdir <dir>` 机械校验 write_scopes 越界（⚠️ 脏工作区会漏报，尽量给干净目录）。**2026-10-13 起硬约束**：`--context`（lead 的解读）/ `--self-test`（自测与验收方式）/ write_scopes（或显式 `--read-only`）**缺一即拒发**（exit 2）。
- **双通道**：短任务 `POST /api/task`（ephemeral 零记忆，互审/复核用）；长任务 `codex exec` 落盘 + `codex exec resume <完整 36 位 UUID>` 成员会话（一条链绑一个任务，thread id 记看板 `session` 字段，实测跨单记忆保持；API 不支持 resume，长任务用命令行降级姿势手动注入 key）。工单三字段 task/context/frame，交付强制四段含【异议位】；细则读 PROTOCOL.md §九（工具化纪律）与 §十一（已知限制）。
- ⚠️ **派单必须显式 `--workdir <绝对路径>`**（2026-10-14 事故）：`--workdir` 默认值 `.` 按 Web 进程 cwd 解析，落到 `$HOME` 时插件会在家目录 `git init && git add -A`，把整张家目录（含 `.ssh`/`.dsh` 凭据）加进 git 索引并污染面板「改动摘要」。复盘、三层加固、判据命令见 skill `dsh-env-maintenance` 的「2026-10-14 事故」节（`dispatch.sh` 现已拒绝相对路径与 home/root）。**纪律：一律 `--workdir ~/proj`，别省。**

## 异常速查

| 症状 | 处置 |
|---|---|
| 派单后长时间零输出（>10 分钟） | **先分清「错」「慢」「并发」**：有 `Reconnecting/stream disconnected` = 流断，切 provider；只有沉默无错误 = 可能在生成（relay 桥是"非流式请求上游、整段生成完再流式回放"，长任务首包延迟≈整段生成时间，此时**不要熔断，先等**）；**失败多为多个 codex 进程并发叠加**（实测智谱单发长输出 25.3 万字节/21s 完全正常）——先 `ps` 确认没叠跑再重试，仍不通切 active 提供方。**别并发派单** |
| 智谱模型的疑问 | `/api/v1` 是智谱给 **Codex 的专用适配端点**（只 3 个模型：glm-5.3 / glm-5.3-flash / glm-5-turbo）；标准列表在 `/api/paas/v4/models`；`/api/coding/paas/v4/responses` = 404（编程端点只支持 chat/completions）；**不需要额外「编程密钥」**，现有 key 三端点通用（2026-09-27 实测） |
| 取消后仍有 codex 进程残留 | 已加 3s 兜底 SIGKILL（`task.forcedKill` 可查）；手工清理只用**精确 PID**（`kill <pid>`），绝不用模式匹配 |
| `Missing <X>_API_KEY` | 激活提供方换了但 env 没跟上：用 `codex-env` 或手动 export 对应变量 |
| 任务「运行中」长期无输出 | 看门狗会标 `stuckSuspect`（曾因 stdin EOF 假死，已修复）；直接取消重发 |
| `wire_api` 报错 / bwrap、sandbox 报错 | config 被手改（应 responses / danger-full-access）→ 面板重新「启用」即由生成器重写 |
| 任务**秒退**且过程流尾部 `exceeded retry limit, last status: 429` | **先分清「本地限速」还是「上游侧拒绝」——两者都报 429**。⚠️ 别用小请求探活当判据（几个 token 的探针 200，而 40K+ 上下文被直接拒；10-03 误判多灌 55 个请求）；**判据 = 看面板**；确属限速才冷却重派，否则换 provider |
| 工具全灭 approval never | 同上（config 被改坏，切 active 重写） |

## Codex 升级姿势 + 升级后破坏性检验

**升级姿势**：优先 GitHub release 直连取主二进制 + sidecar（网络时通时不通，以当次实测为准；镜像 `ghproxy.net` 可用、`ghfast.top` 已挂）；备选 npmmirror 平台包 `@openai/codex@<版本>-linux-arm64`（用 `dist.integrity` 校 sha512）。解包得主二进制 + sidecar `codex-code-mode-host`（**须与主二进制同目录、无后缀命名**）+ `codex-path/rg`（PATH 已有 `/usr/bin/rg`，免装）。**先跑包内 `bin/codex --version` 验活，再 `cp -a` 备份旧二进制（`<Codex 安装目录>/*.bak-<旧版>`）后替换**；回滚＝换回备份。（2026-10-26 复核：`.bak-0.163.0` 主二进制与 sidecar 两份在位，回滚链可用。）

**每次升级后跑三条检验 —— 判据与处置固定**：

| # | 检验什么 | 命令 | 通过判据 | 不过怎么办 |
|---|---|---|---|---|
| 1 | 工具面 | `node ~/.dsh/scripts/dsh/se-tool-probe.mjs` | 工具**名字集合**与上一版基线一致（只看名字，不看字节数） | 工具名增删 ⇒ 上游改了工具面，复核插件对工具名的假设 |
| 2 | 执行链 | `bash ~/.dsh/scripts/dsh/se-appserver-verify.sh` | 5/5（appserver 派单+流式进度 / cancel 打断无残留 / exec 回归） | **插件必须动**：先切 `exec` 模式兜底，再修 |
| 3 | DSH 依赖点 | `python3 ~/.dsh/scripts/dsh/dsh-dep-check.py` | 全 OK | 与 codex 版本无关，属 DSH 侧问题 |

**只有第 2 条判不过，才需要动插件代码**；另两条是自查。**人工判断（不可省）**：读 release notes 里**插件调用面**——`codex exec`（参数 `--skip-git-repo-check --ephemeral -o`）与 `codex app-server` 协议；这两条未动 ⇒ 插件无需维护；有变动或被默认收紧 ⇒ 记一条并评估。逐版实测记录查 `<本机功能核对表>`。⚠️ 探针数量会变（曾 3 条增至 6 条），按脚本当次输出比对，别照旧数字核。

## `~/.codex` 目录维护（2026-10-26 立；插件不管这目录的体积，偶尔手动跑一次）

先跑这条看现状：`du -sm ~/.codex ~/.codex/.tmp /tmp/codex-upgrade 2>/dev/null; ls ~/.codex/*.bak-* | wc -l` + `python3 -c "import sqlite3;c=sqlite3.connect('file:<CODEX_HOME>/logs_2.sqlite?mode=ro',uri=True);print('碎片 %d/%d 页'%(c.execute('PRAGMA freelist_count').fetchone()[0],c.execute('PRAGMA page_count').fetchone()[0]))"`

- **能删**：`/tmp/codex-upgrade`（升级残留，实测一次 **532 MB**）· `.tmp/git-*`（Codex **每次运行建一个、从不自清**，实测一晚 12 个 / 102 MB）· `.live`/`task-*.out`（`POST /api/cleanup {"keepDays":7}`，自动清理卡在 200 MB 阈值上所以永远跑不到）· bak 每类各留最新一份
- **别动**：`tmp/arg0` 与 `tmp/arg0-linux` —— 是**符号链接**（`apply_patch`/`codex-linux-sandbox`/`codex-execve-wrapper` 全指同一二进制，靠 `argv[0]` 分派），删了 sandbox 与打补丁坏
- **`logs_2.sqlite`**：42 MB 里 **35 MB 是碎片**（`freelist_count/page_count` 87%）——**删行不缩文件，只有 `VACUUM` 能收**；`VACUUM` 要独占锁、Codex 在跑时**禁止**。低优先，别为它引入新机制

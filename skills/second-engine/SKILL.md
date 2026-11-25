---
name: second-engine
description: 操作第二引擎（Codex/Pi/Claude Code，设置页切换）：模型管理、工单(API优先)、互审、验收、看板、多 agent 编排(写域隔离/基线/accept.sh)、提醒通道。用于异构第二意见、并行下探、独立复核、外置判断权，或用户说「用 Codex/Pi/第二引擎/让 Codex 试试/编排/派单/多找几个」；也用于我绕圈、被纠正、卡住时求助。
---

# second-engine · 第二引擎操作流程（Codex / Pi / Claude Code）

**怎么用这份文件**：第 1 节是**该不该派**（每次派单都撞得到的第一关）；第 2 节是**规划**（整条路值不值得走 / 派给谁 / 怎么分工）；第 3 节是**操作**（怎么写单 / 怎么收单 / 异常降级）；第 4 节是档案，要时才查。

**章节索引（按使用流程读，顺序即流程）**

- **0 入口**：0.1 读取闸门 · 0.2 走哪条通道 · 0.3 三条道并行 · 0.4 API 入口
- **1 判据**（该不该派）：1.1 什么时候该派它（A/B 两分法）
- **2 规划**（整条路值不值得走 / 派给谁 / 怎么分工）：2.1 三方评估漏斗 · 2.2 被用户否定时 · 2.3 选引擎 · 2.4 各方边界 · 2.5 多 agent 分工 · 2.6 编排决策：先判是否编排，再建表（开编排时才用） · **2.7 编排硬规则 16 条** · 2.7.1 谁签字 · 2.8 提醒偏好 · 2.9 桥+工单+board 三件套 —— 2.5/2.6/2.7/2.9 细则见 `references/ref-orchestration.md`**
- **3 操作**：3.1 查档位 → 3.2 交接单 → 3.3 核对纪律 → 3.4 工单怎么写 → 3.5 复核 → 3.6 标准流程 → 3.7 执行模式 → 3.8 唤醒层 → 3.9 求助归属 → 3.10 看痕迹 → 3.11 异常速查 → 3.12 降级路径
- **4 档案**：4.1 已迁至 skill `second-engine-dev`（真身 / 加载层 / 发布树落点）· 4.2 dual-board · 4.3 引擎与本机现场（references 索引）

## 0.1 读取闸门（任务出现 → 必须先读 → 读完带走什么）

| 任务出现时 | 必须先读（绝对路径） | 带走什么结论 |
|---|---|---|
| 要操作 Pi：路径 / 事件格式 / 桥 / 新建与切换会话 / 能力契约 / 清理 / 版本 | `<DSH 技能目录>/second-engine/references/ref-pi-runtime.md` | Pi 会话落在 `<cwd>` 分区、桥端口见该 ref、`agent_settled` 才是终点、成败只认 `stopReason=stop` |
| 要查 Codex 现场：keyring / wireApi / CODEX_HOME / CLI / 凭证 / 中转站 | `<DSH 技能目录>/second-engine/references/ref-codex-facts.md` | config.toml 由 keyring 生成（别手改）、wireApi 判据、key 不进 argv |
| 要升级 Codex，或升级后判断插件要不要动 | `<DSH 技能目录>/second-engine/references/ref-codex-upgrade.md` | npm 平台包是正选、三条检验的通过判据、只有执行链判不过才动插件 |
| 要写看板 / 派长任务链 / 查 board 子命令 | `<DSH 技能目录>/second-engine/references/ref-dual-board.md` | `board.sh` 是唯一写入口、出板必须 `--reviewed-by human`、`--workdir` 必须绝对路径 |
| 要决定派给谁 / 写执行方边界 / 评估编排安全 / 查同类项目 | `<DSH 技能目录>/second-engine/references/ref-dispatch-routing.md` | 路由二分法（我 / 第二引擎；其他执行方看各自 skill）、每单边界写死、隔离实测 4 条 ⇒ 只能「限额+留痕+可回滚」 |
| 派单核对 / 执行模式切换 / 唤醒端点 / 提醒通道 | `<DSH 技能目录>/second-engine/references/ref-dispatch-drill.md` | 能被一条命令验证的描述落笔前先跑过它、复核恒走 exec、`VAR=key cmd` 会进 argv 被 ps 看到、wake 要 `session-<uuid>` 前缀 |
| 要操作 Claude Code：路径 / provider / 模型 / 档位 / 桥 / 会话 / 外部事实验收 | `<DSH 技能目录>/second-engine/references/ref-claude-runtime.md` | 顶层 `active` 是 id 不是布尔、`--model/--effort` 改了要重建进程、会话是两层目录、桥（端口见该 ref）双向 NDJSON |
| 选 Pi / Codex / Claude Code | `<DSH 技能目录>/second-engine/references/ref-engine-pick.md` | 要「审」/流式进度/web_search 走 Codex、多 provider 并存走 Pi、切完旧单不迁移 |
| 要编排（多 agent）/ 查 16 条硬规则或三件套实操 | `<DSH 技能目录>/second-engine/references/ref-orchestration.md` | 六问答不全不开工、写域有交集不许并行 |

---


## 0.2 用哪条通道派（2026-10-15 · 官方原生工具 vs 本插件）

DSH 侧**两条路都能叫到 Codex**，别混：

| | `subagent_codex`（DSH 原生工具） | 本插件（second-engine API） |
|---|---|---|
| 怎么调 | 直接调工具，一行 | **原生工具 `second_engine_task`**；无 tools 服务时走 HTTP 兜底（等价路径） |
| 形态 | **进程内**一次委派，结果直接回到我的上下文 | **进程外**任务通道，有队列 / 历史 / output 留存 |
| 异步 | 支持（`run_in_background`），`job_output` 收 | 支持（完成弹 App 通知） |
| 取消 | `job_kill` | `second_engine_job_cancel`（HTTP 兜底 `/api/task/cancel`） |
| 人能不能看见 | **看不见**（没有面板） | **能**（设置页面板 + `/api/tasks`） |
| 换 provider / 模型 | **不能**，只能吃 config.toml 里 active 的那份 | **能**（keyring 多 provider；切 active 自动重写 config.toml） |
| 多轮互审 / 主动求助 / MCP / web_search / 会话清理 / 版本检查 | 无 | 有 |
| 跨工单连续性 | 无 | 无 |

**判据一句话**：一件自包含的活、只要它把答案带回来给我 ⇒ `subagent_codex`（最短路径，默认等结果）；要人看得见 / 要留痕 / 要换模型 / 要多轮互审 / 要它主动来找我 ⇒ 走本插件 API。

**共同点**：这两条短工单通道都是「**一 run 一进程一 thread，无 resume**」（官方原话，本机实测；CLI 可 resume，见 `references/ref-orchestration.md` §2.7 第 3 条与 §3.1）⇒ **要连续性只能靠 dual-board 文本看板**，别指望引擎。

⚠️ **`subagent_codex` 的工具描述里完全没提 Codex**（与通用 `subagent` 的描述前半段逐字相同），新会话的 AI 不会自动知道该用它干 Codex 的活，也读不出它没有连续性、`permissionMode` 默认 `never`。**这条判据正是本 skill 存在的意义之一。**（它的凭据喂法见 `<DSH 技能目录>/second-engine/references/ref-codex-facts.md`）

## 0.3 三条道并行：工单 / 复核 / 互补（2026-10-26 合并定稿）

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

⚠️ **判据只看一件事：错的是「点」还是「面」**（完整判据见 §1.1）。别把长任务的「打回重做」习惯套到短期工单上——回炉＝让它从零重理解 + 等它慢慢跑 + 断流风险，通常比主 AI 直接改那几行更差。

## 0.4 工具优先：本插件服务层（HTTP 兜底见 `references/ref-http-api.md`）

**优先用原生工具（十个，P0→P2 已真机验收；`bridge_send` 2026-11-21 补）**——会话工具列表有 `second_engine_*` 时别手拼 curl：
- `second_engine_task {prompt, workdir?, engine?(codex|claude|pi), ephemeral?}` → `{id,status,warnings?}`（秒回，不阻塞；2026-11-21 起工具内部做**派单预检**（engine 与 active 不符/不可用/无 key）与**派后自检**（3 秒内无 pid 判「可能未真正挂上」），只往 `warnings[]` 报、不拦单；面板接口 `/api/tasks` 不含此字段）
- `second_engine_job_get {kind:'task'|'review', id}` → 状态 + output（≤4000 字，超出看 `outputTruncated`；review 的 output 是 `{verdict,rounds,issues}` JSON，issues=最后一轮）
- `second_engine_job_cancel {kind, id}`
- `second_engine_review_start {content, workdir?, files?, rounds?}` → 句柄+状态（异步，不承诺立即给 verdict）；`second_engine_review_reply {prev, reply:[{issueId,decision,reason}]}` → 新句柄
- `second_engine_bridge_start / bridge_stop / bridge_status {engine}`（明确引擎；stop 同步期望态防自动恢复拉起）
- `second_engine_bridge_send {engine, text}` → `{ok, text, tokens, engine}`（桥对话：发一条收流式回复。**不自动起桥**，桥没跑返回 `BRIDGE_UNAVAILABLE`，先 `bridge_start`；codex 桥以 `kind:done` 收尾、claude/pi 以 `kind:end` 收尾，两种都算完成；token 按引擎分（codex 读状态目录、pi 读 `PI_BRIDGE_TOKEN`、claude loopback 免）；超时/断流返回 `status:unknown` 不重试）
- `second_engine_status {}` → 全引擎本机运行态（active/available/keyConfigured/model/bridge），不联网、不启动引擎、已脱敏
判据：**派单 / 收卷 / 复核 / 起停桥 / 查状态一律先看工具**；只有**改引擎全局配置（config / providers / model / key）/ 查全量路由 / 面板操作**才走 HTTP。超时 ≠ 未创建，不自动重试。

无工具或排障时的 HTTP 兜底、全量路由清单、consult 查询、排障字段：**全部收在 `references/ref-http-api.md`**（本正文不再展开 curl）。

- **`engine` 是工单级字段，单次生效**：`codex` / `pi` / `claude` 任选，**不动 active**，所以可以同一秒连发不同引擎的工单（2026-11-06 实测：两单并行、`/api/tasks` 里 `engine` 各是各的）。不写这个字段才落当前激活引擎。切 active 只影响「不带 engine 的工单 + UI 面板/桥/悬浮球」，两者别混。

- ⚠️ **别用 App 设备桥的端口**（`/app/*` 读屏/点按/截屏/通知那套）：那不是插件路由，未知路径会被当 shell 命令回 `{"result":"[NO_CMD]"}` —— 是敲错门，不是插件故障（2026-09-27 实测踩过）。

## 1.1 🔴 什么时候该派它（2026-10-14 用户定稿 · 两分法）

**先分清两种情形 —— 别把"派单"当成碰壁的补救**（那会把自己养成行动的侏儒）。

### A. 本来就该它干的事（不必等卡，可以主动派）
- **独立复核**：我的产出要人挑错，**尤其"我觉得对"的时候**。
- **并行下探**：任务能拆成互不依赖的子块（⚠️ 先冻结接口，否则并行产物对不上）。
- **它是一手信源**：涉及它自己的运行环境 / 协议 / 历史（工单、session、config、keyring、app-server 协议）。
- **异构第二意见**：需要的是**与我的思路不同的解**，而不是同一条路径再试一遍。

### B. 我自己卡住了（**早问 ≠ 早停**）
**派单条件很低，停手条件很高** —— 两件事，别混。

**什么时候可以派**：触头一出现就够了（本机红线 4 的三形态——分发版按这三条理解：同一点试两次不通 / 结果怪又说不清 / 反复绕回同一处）。一单成本约 3 分钟，不值得为它再硬耗几小时。
**什么时候才能停手**：四步穷尽 —— ① **实测**（看真实回执，不看猜、不看记忆）② **搜索**（网络 + 官方文档）③ **换路径继续实测**（换方法 / 换工具 / 换写法）④ 以上全试过仍不通。**派单不能替代这四步里的任何一步**：问完回来照样要自己实测、自己签判断。

⚠️ 错的是"**两下不行就去问，问完就停**" —— 错在**后半句**。问得早不丢判断权，**问了就照抄才丢**。
⚠️ **别把它的自救阈值当我派单的阈值**：Codex 侧「同一路径失败 2 次就喊」是**它**的自救线，不是**我**的（两个主体、两套判据，不能合并）。

**反例（别派）**：局部小错、改法明确 → 我直接改；回炉要等它重跑、更慢更险（判据是错误在**"点"还是"面"**，见「三条道并行」节）。

## 2.1 整条路值不值得走：三方评估漏斗（2026-10-21 立）

适用：任务开始前 / 卡住时 / 收尾前，判断**整条路**值不值得走。与「独立复核」分开——独立复核只给事实不给我的判断（要它当外部变量）；本漏斗给全事实链，评的是路线本身。**反模式**：探口风写潦草（后两级全歪）、把「总体可行」当通过、用长会话承担本该一单解决的独立复核。

1. **短工单探口风**（成本约 3 分钟）：喂 ① **用户原话**（逐字引，不转述）② **可核查事实链**（产物路径 / commit / 报错原文 / 已试路径 / 轮数）③ **当前卡点**（标明「这句是我的判断」）。**不喂**我的总结与倾向结论（会让它顺着我回答）。要它回三样：整体可行吗 / 我们没看到的是什么 / 它愿意接哪部分。
2. **三方校准**：我回结果与判断 → **用户看原文**交换信息，关键节点让用户直接对 Codex 说原始意图（绕开我的转述损耗）。
3. **可靠性判据（三条全过才升级）**：① 点出我们没有的**具体**风险（不是「建议多做测试」）② 给出**可直接执行**的下一步（文件 / 命令 / 操作顺序）③ 给出**它自己愿意承担**的部分。缺一条 = 礼貌评估，不升级。
4. **拉长会话 + dual-board**：`codex exec resume` 或聊天桥；先与我简短对齐再动工，进度走 dual-board。

**免进漏斗**（防它变成收费站）：纯执行 / 有先例 / 低风险 / 单文件 / 验收标准明确——**能一句话写出验收命令，就不用探口风**。

## 2.2 🔴 用户否了我时：要不要外置判断权（2026-10-31 立；同日按第二意见修订）

**定义**：编排 = 主 AI 单干**无法收敛**时，把一部分**判断权或执行权**外置给独立执行体，**自己保留裁决权**。它不是"把活全丢出去"，也不是"把任务拆成步骤工单"。

**先破一个混同**：**不依赖用户措辞 ≠ 不依赖语义**。触发词表（"你怎么又绕""卡住了"）要匹配**用户说了哪个词**，跨人跨模型对不齐 —— 写窄漏、写宽误触发，这条路废弃。但"这次纠正是修补还是推翻"必须由我判断，躲不掉，也不该躲。

### 主路：二分自答（不问他说了什么词）

用户不满出现时 —— **不满靠"他否定了我上一步的产出或方向"识别，不靠词表** —— 只问一句：

> **他纠正的是「这一步做法」，还是「这条路」？**

| 判断 | 判据 | 动作 |
|---|---|---|
| **这一步做法** | 拼写 / 参数 / 单点事实 / 格式；换个写法就行，当前计划仍会导向他要的结果 | **不派单**，当场改 |
| **这条路** | 方向或验收条件变了；或同一处已被纠正 2 次；或他一句话推翻了我前面的判断链 | **立即派单**，先派后解释 |

**分不清按"这条路"处理** —— 多派一单 3 分钟，比再绕一小时便宜。用户的不满通常比我自己的察觉更早，因为**我是最后一个发现自己绕圈的人**。

**判据**：判成"这条路" ⇒ **先派单，后解释**（解释放在拿到第二意见之后）；判成"这一步做法" ⇒ 直接改，不解释不派单。

**显式指令**（"编排""派单""叫 codex""多找几个"）⇒ 直接执行，不判。

### 拿到回复后的三分支（不许擅自动作）

1. 工单指出我有错 → **自己改**，改完在回复里写明"错在哪"（不藏）
2. 工单认可方向、但方法有问题 → **自己改 + 记一条**到待办或日志
3. 工单认为该并行 / 该换人 / 我仍不确定 → **通知用户**「要不要开多 agent 一起做？」**等用户点头才开**；不点头 = 默认继续单干

## 2.3 选哪个引擎：Pi / Codex / Claude Code（按能力，不按偏好）

**一句话：Claude 建、Codex 审。** 前端/UI/设计/需要「读意图」的活 ⇒ Claude（社区实测：同一前端任务只有 Claude 懂设计细节；本机 2026-11-17 已装 `frontend-design` 插件）；后端/并发/进程/资源生命周期，以及**审查/判真伪** ⇒ Codex（行号准）；可编程 loop / 异步 SDK / 多 provider 横比 ⇒ Pi（不当主力；**能力面不止横比**，见 `references/ref-orchestration.md` §2.5，2026-11-17 修正）——**别把角色写死**——边界只用来选人，不用来限死：复杂任务允许交叉（Claude 写前端、Codex 复核同一份产物）。

能力契约（`review` / `resume` / `webSearch` / `mcp` / `worktree` / `Agent SDK` / `子代理` / `流式` / `打断`）**单源化，本节不再复述**：分工理由见 `references/ref-orchestration.md` §2.5 的表，引擎细节见 `references/ref-engine-pick.md`（2026-11-07 去重，原三条 bullet 与 §2.5 判据列重复）。

关于「同模型换引擎差多少」：2026 年受控研究给出约 8–13 个百分点的 scaffold 效应，差异在失败指纹、token 成本与并行方式上（`The Scaffold Effect in Coding Agents` / `Harness or Model?`）。⇒ 选引擎先看能力契约，模型强弱让用户按档位决定。

**编排时**：跨引擎可并行（Codex + Claude 同时各跑一单），但**写域必须不重叠**；同一引擎不叠加（判据与例外见 `references/ref-orchestration.md` §2.7 第 2 条）。别把「能换模型」当 Pi 的卖点。切换后会话不迁移、Pi 下卡片隐藏不是故障 → `references/ref-engine-pick.md`

## 2.4 各方边界

- **主 AI**：最终裁决 + 落地 + 记账。
- **本机执行方**：复核 / 判真伪 / 施工；行号准、敢判假。
- **外部通道**：批量读 / 粗筛；行号常不可信 ⇒ 只出候选，不定稿。
- **用户**：最终裁决。

共同点：都不是最终决策者；角色与能力判据**以 `references/ref-orchestration.md` §2.5 表为唯一来源**。

## 2.5 多 agent 怎么分工（2026-10-30 立 · 目标＝多 agent 互审，不押注单一引擎）
分工按能力：Codex 后端/复核、Claude 设计/前端、Pi 多 provider；详细分工与判据见 references/ref-orchestration.md。

## 2.6 编排决策：先判是否编排，再建表（2026-11-01 立 · 2026-11-04 重写）
六问（拆 / 谁干 / 怎么干 / 时间 / 谁能接 / 怎么验收）答不全不开工；完整六问与表结构见 references/ref-orchestration.md。

## 2.7 多 agent 编排硬规则（2026-11-01 · 判据清单）
16 条编排硬规则见 references/ref-orchestration.md（写域/通道/基线/验收/失败处置）。

## 2.7.1 谁签字：控制点是「动作前停」，不是「谁签名」（2026-11-04 立）

- **低风险**（workspace 内、可回滚、能一句话写出验收命令且 `exit=0`）→ 直接做完、事后汇报（普通任务不涉及 `reviewed-by`；`--reviewed-by` 只用于 **board 出板**，见 §4.2——出板必须 `human`）。
- **高风险**（发布 / 凭据 / 删数据 / 改运行中机制 / 结论不确定）→ **停手等用户说「可以」**，`--reviewed-by human`，`--result` 里写用户授权原话。
- **认清前提**：单机单 agent 架构下「人签」**无法认证主体**（命令是主 AI 执行的）；真正起作用的是「动作前停」，不是签名本身。

## 2.8 编排开始前：先问提醒偏好（2026-11-02 立）

开编排前问一句「需要我在关键节点提醒你吗？你一般怎么挂着 App——全屏、画中画，还是小窗？」并配好通道（**优先级：Toast → 振动 → 通知**；Toast 不依赖通知权限、后台也可见，通知需系统权限，顶部浮条本机未启用——实测见该 ref）。**只在需要用户介入时提醒（验收拍板 / 要重启或确认 / 动发布·凭据·删数据前 / 卡住两轮不通），任务落定别提醒。** 通道矩阵与设置 → `references/ref-dispatch-drill.md §提醒通道`

## 2.9 编排实操：桥 + 工单 + board 三件套（2026-11-02 立）
三件套（board.sh 记账 + 工单/桥 + accept.sh 验收）实操见 references/ref-orchestration.md。

## 3.1 派单前：先跑机械校验（2026-11-10 起 · 2026-11-21 补：工具层已内置）

> **2026-11-21 起**：`second_engine_task` 工具内部已内置「预检（engine/active/可用/key）+ 派后自检（pid/startedAt）」，结果只进 `warnings[]`。脚本仍是**纪律层**且更细（prompt 缺句、空产出风险、通道选择），两者不互替：脚本管「单子该怎么写」，工具管「这单真挂上了吗」。

**责任在主 AI 不在 Codex**：主 AI 没有推送通道，档位只能自己查。**先跑这条**（只读、不派单、不切档）：

```bash
bash tools/dispatch-check.sh --engine <codex|pi|claude> --mode <task|review|longtask> --prompt-file <单文件>
```

它读真实 `/api/status`，一次给出「当前档位 / 该走哪条通道 / prompt 缺哪句 / 该引擎会不会判空产出」，有 error 退出码 1。
**三档对照与 R1–R9 规则只在脚本里，本 skill 不复述** —— 文档和脚本讲同一件事，两份必然漂移。接口查不到时脚本按 `review` 兜底。
⚠️ 脚本只管机械项；「切档是用户裁决」「独立复核照样走单次工单」这类判断仍在本 skill（§2.2 / §2.3）。

**collab 两位**（脚本会打出值，含义在这里）：
- `voice`：`on` = `~/.codex/AGENTS.md` 有「主动开口」段（允许它推荐自己）；`off` = 无。
- `longtask`：`auto` = 分阶段任务直接开长会话 + dual-board；`manual` = 升级走漏斗三判据。只影响主 AI 派单，不写进 AGENTS.md。
- 优先级链：env `SECOND_ENGINE_VOICE` / `SECOND_ENGINE_LONGTASK` > `~/.dsh/second-engine-collab.txt` > 默认，逐位独立。预设：`review`(off/manual) / `propose`(on/manual) / `longtask`(on/auto) / `custom`(off/auto)。
- **切档是用户裁决**，主 AI 不擅自 `POST /api/config`；`voice=on` 是**许可不是分支**（独立复核照样走单次工单）。

**长任务档的落法**（脚本只给通道名，细节留这里）：`codex exec`（**不带** `--ephemeral`，手动注入 provider key）拿 thread id → `codex exec resume <完整 36 位 UUID>`；thread id 记 dual-board 的 `session` 字段。
- 长会话不走 API 的原因：`POST /api/task` 固定 `--ephemeral` 不支持 resume；协议层虽有 `thread/resume` 但插件未暴露 ⇒ 只能 CLI 降级。
- ⚠️ **8 位前缀会静默新建会话**：resume 必须给完整 36 位 UUID（`codex delete` 无 TTY 要 `--force`，同样要完整 UUID）。
- `voice=on` 的 AGENTS.md 段保留，但触发由主 AI 在 prompt 里给，不靠教义自觉。

**别指望 Codex 自己判断「何时该提议、何时该拉长」**——实测三次它都不遵守 AGENTS.md 里的业务策略指令（评估工单 / 简单工单 / 手动加「必须表态」全都不写），而格式指令（文件首行 `MARKER-OK`）照做 ⇒ **要它做什么，就在这次工单里说，别放全局教义**。

## 3.2 派单前：落交接单三行（黄灯协议，2026-10-31 立）

> 交通信号灯那条：**一方停止的过渡，就是另一方前进的信号**。没有这张单，通行权交接就没有凭据——对方不知道我从哪停的，我也不知道它该从哪接。

主 AI 把活交给外部执行体（工单 / 复核 / 长会话）**之前**，先落三行，写进 prompt 顶部或看板的 `context`：

```
STOP-AT: <我停在哪：文件 / 函数 / 大致行号>
DONE:    <已完成什么，怎么验证：命令 + 期望输出>
NEXT:    <对方从哪接手；验收判据是什么>
```

**判据**（适用于**显式长任务 / 协同配合档位**；中小任务不需要它）：三行缺一 ⇒ 不许派单。**验收时拿 STOP-AT 与 DONE 逐条对**——对不上，说明交接单写错了，或我并没有真停在那儿（后者更常见）。

**例外（抢黄灯）**：救急可跳过，但必须在 prompt 里写一句「本单未落交接单，原因：X」，事后可查。没有这一句的跳过 = 违规。

**为什么它同时解决两件事**：① 我的"停手"从感觉变成**可验证的事实**（3 行文字）；② 对方的"接手"从猜变成**对着 STOP-AT 开工**。（适用范围以上句为准，别两处各说一套。）

## 3.3 派单与核对纪律（从多次误判提炼，只记判据不记过程）

**单子里凡是能被一条命令验证的描述（`文件:行号` + 当前行为），落笔前必须已经跑过那条命令**，与描述不符就改描述、不许凭印象写。其余 7 条（workdir 同名副本、确认它读的哪份文件、路径写到文件级、新名词先 `grep -c`、取消/终局写点找齐、副作用兼管什么、一套 UI 两套判据、可执行产物验输出不验跑通）→ `references/ref-dispatch-drill.md`

## 3.4 工单怎么写：四要素、五要点、推理预算、停手点

**派生任务四要素**（每次把活派给 Codex——工单 / 复核 / 长会话都算——缺一样它就会在真空里乱窜）：

| 要素 | 回答什么 | 反例 |
|---|---|---|
| **目的** | 最终要造成什么、谁用、验收标准 | 「优化一下」 |
| **原料** | 读哪些文件 / 哪段 diff / 哪个 commit；**被审对象的具体锚点（路径 + 行号范围）** | 「看看这个项目」 |
| **行为边界** | 允许做什么、**禁止做什么**（不碰凭据 / 不重启 / 只改副本 / 禁 `pkill -f`） | 只说「注意安全」 |
| **结构** | 交付物形状（文件 / 函数 / 格式 / 四段产出含【异议位】）、工作副本绝对路径 | 「给我个方案」 |

**两条补充（2026-11-18 蒸馏，精简记）**：① **具名风险**——派单时写一句「我知道它会错在哪」，报告须回应；② **报告只当待查声明**——交付报告不进验收证据位，证据只认我复跑的输出（同红线 22）。

**施工派单五要点（实证）**：① **先冻结接口再分头开工**（谁改哪个文件、文件之间靠什么约定交互，全写进工单，否则并行产物对不上）② **给它工作副本，不给主工作区**（`~/proj` 或专门副本，绝不指向插件实体 / 主工作区）③ **要求自测并贴真实输出**（`bash -n` / `node --check` / 临时端口跑一圈；不接受「我改好了」）④ **取用看 `git diff` + 复跑自测**，按点/面决定谁修（判据见 §1.1）（局部小错主 AI 直接改——回炉要等它重跑、ephemeral 工单无项目全局记忆容易越改越错；大面积/方向性错误回炉重做，新工单写清问题）⑤ **工单模板**：范围（只改 X 不动 Y）→ 逐条改动 A/B/C → 硬约束（备份名 / 禁 `pkill -f` / 敏感信息不得出现）→ 自测清单 → 四段产出（含【异议位】）。

**失败升档（2026-11-21 用户定）**：工单失败、且错的是「面」不是「点」（需要返工/重派，而不是我盯着 diff 改几行就能过）时，**不原档重试**——把 effort 提一档再派（medium → high），一次不够再升。别跳过中间档直接梭到最高。判据同 §1.1「点/面」：返工＝需要它重新理解再跑；小修＝我自己改几行就能过，不升档。

**推理预算（复杂单必写）**：工单里加一句「最多 2 次不带写入的动作（读/搜索/推演都算），第 3 次必须 Write/Edit 落盘」——实测不写则连续三轮各推演 8–12 分钟零落盘，写上则 4 分钟落 392 行。**它会在边界情况上无限自我验证，硬预算比"别想太久"有效**。复核同理：`content` 不是随便一段话，要指明审哪个文件、哪段 diff；没有锚点它会在 workdir 里自己找目标。

### 卡住了怎么问它：在工单里写停手点（CHECKPOINTS）

长任务工单里写**声明式停手点**，让它 turn 内自行判断「到点了」就结束并汇报。**为什么需要**：一个 turn 可连续跑几十分钟，turn 之间必须主 AI 唤起（它没有后台 job），停手点是用户中途介入的唯一机制；硬兜底 `stuckSuspect`（300s 无输出）+ `/api/task/cancel`。

```
CHECKPOINTS:
1. 完成 <文件/模块> 后停手，汇报改了哪些函数、有没有测试
2. 跑通 node --check + 回归后停手
3. 预计剩余工作量超过 2 个文件时，停下等我确认
```

## 3.5 复核怎么发、怎么收敛（2026-10-25/26 已落地，源码复核在案）

- **一次只发一条复核**（同一内容重复发起没有信息增量）。**默认 1 轮**（`REVIEW_DEFAULT_ROUNDS=1`，2026-11-07 起），`roundsChoices:[1,3,5]`；要自动多轮就显式传 `rounds`，响应回 `maxRounds` 可核对。**多轮走同一 thread**（2026-11-07 起）：第 2 轮用 `exec resume <threadId>` 续审，模型自己记得前几轮，不再每轮回灌 prev/reply；threadId 解析失败会回退新开一轮（`task.resumeFallback` 可查）。**不每轮裁决，最终结论一次上交用户**（`reviewRounds` 是上限不是目标）。发起时写清三件事：被审对象是什么（含路径）、验收到什么程度算过、几轮内不收敛就停。
- 生命周期：结果落盘 `~/.codex/reviews/<id>.json`（`GET /api/reviews?limit=` 可列）；收尾时未决问题摘成 `[REVIEW_ISSUES]` 追加进复核任务 output（**收单必读**）；复核窗口内工作区被改动会记 `reviewDirty`（证据、非归因）。
- **判据冻结 / stale（2026-11-06 落地）**：`POST /api/review` 可带 `files:["相对 workdir 的路径", …]`。服务端发起时冻结 `content` 的 sha256 + 各文件的内容哈希，收尾前重算，不一致即判 stale（`status` 仍是 `done`、记录里 `stale:true`、`verdict` 换成 `'stale'`、原值收进 `staleOf`），**旧结论不发布**。⚠️ **不传 `files` 时只有 `content` 参与比对，而内存里的 content 不会变 ⇒ 等于没开 stale 检测**；要它真的生效，得把「复核期间可能被改的文件」列进 `files`。
- **续轮**：`second_engine_review_reply {prev:"<上一轮id>", reply:[…]}`，服务端取上一轮 issues 作种子（跨重启可用），响应 `prevSeeded:true`。
- **回辩（真讨论）**：`second_engine_review_reply` 的 `reply:[{issueId, decision:"accepted|partial|rejected", reason}]`（旧 `issueIndex` 兼容）→ 每轮注入【主 AI 的回应】节；Codex 逐条回 `withdrawn|upheld|reworded`，`upheld` 必须给可核查新证据。**issueId = sha256(severity+规范化 point) 前 12 位**（账本内另有 `i<N>` 序号，服务端算、跨轮稳定）；`task.issueLedger` 记 open/resolved/disputed 与继承链（`GET /api/task?id=` / `GET /api/reviews` 可看）。**终止判据＝ledger 无 open/disputed 且本轮无 upheld**。

## 3.6 标准流程（下发 → 等待 → 验收 → 互审 → 求助）

1. **下发**：优先调原生工具 `second_engine_task {prompt, workdir?, engine?, ephemeral?}`（返回 `{id,status}`）；会话没有该工具时走 HTTP 兜底（等价路径）。工单自包含、小粒度（Codex 零记忆）；workdir 默认 `~/proj`（**绝不进主工作区**）；默认 `--ephemeral` 不落盘（审计靠 git diff）。返回 `{id,status,warnings?}` 即异步开跑——**先读 warnings**，有「未真正挂上」再查证，别当成功。
   > ⚠️ **TIMEOUT 补救（2026-11-25 实证 · 2026-11-26 补）**：`second_engine_task` 返回 TIMEOUT / `status:unknown` **不等于未创建**——工具 TIMEOUT 分支不回传已创建任务的 id，且 `/api/tasks` 对新任务有可见性滞后，「查列表为空」不能当未创建用。姿势：① 先等 ≥10 秒；② 再查 `/api/tasks`，按同 `engine+workdir` 找 running；③ 仍无才可重派。2026-11-25 事故＝查列表为空就立刻重派，实际首单已建，导致两条并行（`mwv692ga…` 与 `mwv69m0m…`）。
2. **等待**：`bash <插件目录>/tools/wait-task.sh <id> [间隔=5] [超时=600]` 放**后台 job**，job 结束时运行时通知我（0=done / 2=失败 / 3=不存在 / 4=接口不可用 / 124=超时）——**禁止自写 `sleep`+`curl` 轮询**。中途想看进度用 `second_engine_job_get`（只查询、不唤醒），别拿 `liveBytes` 判完成。
   ⚠️ **"放后台 job"的具体做法**（2026-11-03 补，因主 AI 连续两次没照做）：调 `bash` 时就带 `run_in_background:true`，**不要前台跑着等**——前台跑满超时会被动转后台，白占一个等待周期且期间什么都收不到。job 结束时运行时会通知主 AI，**这是唯一非轮询的获知途径**：插件完成只弹 App 通知给用户，主 AI 没有被动通道；`GET /api/task?id=` 的 `liveBytes/tokens` 是判进度、不是判完成的依据。
3. **验收**：`second_engine_job_get {kind,id}` 读 output（review 看 verdict/rounds/issues）+ 工作目录 `git diff` 审查 → apply / 打回（新工单指出问题）/ 升级用户裁决。**接口类**（API / CLI / 鉴权 / 网关 / 桥接）另加一条「应当被拒绝」的失败路径实测与落地状态；只贴成功响应壳不算验收（2026-11-18 蒸馏，精简记）。
4. **互审**：把主 AI 产出（结论/方案/diff）用 `second_engine_review_start {content, files?, rounds?}` 发起，Codex 批判复核（上限内自动多轮，零新增即收敛，**最终结论一次上交用户裁决**）；回辩用 `second_engine_review_reply`；单轮需求改走工单，判据见「三条道并行」。
5. **求助响应**：`GET /api/consults` 看 Codex 卡点（手机通知会提示；2026-11-21 起记录落 `~/.dsh/second-engine/consults.jsonl`，可用 `?since=<求助id|毫秒|ISO>` 拉增量，返回带 `nextSince`）→ 针对性下工单解围。HTTP 不通时它在输出末尾写 `[CONSULT-NEEDED] <卡点描述>`；**触发阈值＝同一路径/命令失败 2 次**（插件 `AGENTS_SECTION` / `~/.codex/AGENTS.md` / `~/proj/AGENTS.md` 三处对齐）。

### 3.6.1 长任务补充

**循环**：job 完成通知本身就是驱动力——验收完立刻派下一单 + 挂新 job，无需用户触发（goal 不管子任务跑没跑完都会叫你，反而更差）。
**三条通用做法**：① 工单给固定 `sed -n 'A,Bp'` 区间、禁止通读；② 工具只做拼装，import 头与长字面量由主控原样下发（它会按理解重建，长串易丢）；③ 开工即起心跳（`nohup while sleep 30 >> PROGRESS.md`）+ 出错写 `FAILED.md`，那是唯一能判活/判死的痕迹。
**验收三道**：`node --check` → 逐字比对原著 → `tools/smoke.sh`；删除前校验行首含目标符号名（AST 行号会因先前删除偏移）。

## 3.7 执行模式：exec / appserver（运行时切换、不需要重启）

`echo appserver > ~/.dsh/second-engine-mode.txt` 切 app-server（多 `progress` 流式事件、`/api/task/cancel` 走 `turn/interrupt`），`echo exec` 切回；优先级 env `SECOND_ENGINE_EXEC_MODE` > 模式文件 > 默认 exec。**复核恒走 exec，不支持 appserver。** 验收脚本与协议映射 → `references/ref-dispatch-drill.md`

## 3.8 唤醒层：把消息递进 DSH 会话（实验端点，`POST /api/_exp/wake`，2026-10-30 实测通过）

三条约束（`sessionId` 必须 `session-<uuid>` 带前缀 / 只能用 DSH 侧 provider / 对正在跑的会话发 followup 会打断当前回合）→ `references/ref-dispatch-drill.md`

## 3.9 它喊我，我不查就看不到（consult 归属判据，2026-10-14 实测）

consult 走 `POST /api/consult`、记录进 `GET /api/consults`（2026-11-21 起**落盘** `~/.dsh/second-engine/consults.jsonl`，`?since=` 拉增量、跨重启可查；内存最近 20 条仍在），但**主 AI 侧仍没有被动通道**（没有 push，只能主动查） ⇒ **派单前记基线 → 收单后比增量 → 收尾前再查一次**。2026-10-25 起 consult 记录支持 `taskId`（派单 prompt 写明「你的工单 id 是 X，consult 时回传」即精确归属）；不带时增量法仍是唯一可靠判据：


✅ 收尾时**本任务期间**的求助会自动以 `[SECOND_ENGINE_CONSULT]` 块追加进 `task.output`（2026-10-14 起，收单读 output 即见）。仍会漏的两场景：① 任务永不结束（`finalizeTask` 不跑）→ 看 `GET /api/task` 的 **`stuckSuspect:true`**（看门狗 300s 无输出置位）就转去查 consults；② review 内部循环 → 2026-10-25 起 `finalizeReview` 已统一走 `finalizeJob`，不再单独漏。

## 3.10 判断它到底动手没：看痕迹，不看结论

> 状态信号口径见 `references/ref-orchestration.md` §2.7 第 8–9 条；异常处置见 §3.11。

- **看痕迹三处**：文件 mtime / 字节数变化（派单前后 `ls -la` 对比）｜过程流 `.live` 出现补丁回显（`Success. Updated the following files: M xxx`）｜工作副本 `git status`。
- exec 看 `second_engine_job_get` 的 `liveBytes`（过程流字节数，持续增长即在动）；appserver 另有 `progress` 数组（reasoning / 文本增量 / 工具调用 / 用量）。⚠️ **`liveBytes` 增长 ≠ 在干活**，必须看 `.live` 内容。
- 反面教训：连写两单「只设计评审、不要改文件」，它就只交两份长篇方案——**进入实施阶段必须换「直接改代码」的工单**，编排者的派单方式决定它是帮手还是顾问。

## 3.11 异常速查（先分类，再动手）

| 症状 | 处置 |
|---|---|
| 派单后零输出（>10 分钟） | 先查 `stuckSuspect` / 进程 / `liveBytes` 是否在涨：在生成 → 继续等；**`stuckSuspect` 置位才取消重发**。同一执行通道不许叠跑（不同通道可并行，见 `references/ref-orchestration.md` §2.9） |
| 任务**秒退**且报 429 | **先分清「本地限速」还是「上游拒绝」**。⚠️ 别用小请求探活当判据（小探针通 ≠ 大上下文能过）；判据看面板；确属限速才冷却重派，否则换通道 |
| 工单 exit 0 但工作目录没有新文件 | **假完成**，第一件事查它是不是走了翻译桥（wireApi 判据见 `<DSH 技能目录>/second-engine/references/ref-codex-facts.md`） |
| `wire_api` 报错 / bwrap、sandbox 报错 | config 被手改（应 responses / danger-full-access）→ 面板重新「启用」即由生成器重写 |
| 工具全灭 approval never | 同上（config 被改坏，切 active 重写） |
| `Missing <X>_API_KEY` | 激活提供方换了但 env 没跟上：用 `codex-env` 或手动 export 对应变量 |
| 取消后仍有 codex 进程残留 | 已加 3s 兜底 SIGKILL（`task.forcedKill` 可查）；手工清理只用**精确 PID**（`kill <pid>`），绝不用模式匹配 |

## 3.12 降级路径（环境不全时怎么办）

- **用户没配第二引擎 key**（其他插件用户）⇒ 派单发不出去时，**自己强制复核一遍**并向用户明说"因未配置第二引擎，以下是我自审的结果"，不许假装已委派。
- **主 AI 缺位**：用户直接拿三方漏斗的三问对 Codex 问，不经过我转述；用户自担核证据（不接受「整体可行」当结论）；可靠性判据前两条不能省，第三条（它愿意接哪部分）没有主 AI 接手时无意义可省。

## 4.1 已迁至 skill `second-engine-dev`（真身 / 加载层 / 发布树落点）

本节内容已迁出；保留编号占位，避免既有引用失效。

## 4.2 长任务链走看板：dual-board（细则见 `<DSH 技能目录>/second-engine/references/ref-dual-board.md`）

**什么时候走**：派单涉及多环节长任务，或需要 Codex 持续记忆。**写板唯一入口是 `board.sh`，手改 `board.json` = 破坏协议。**

```bash
bash <插件目录>/tools/dual-board/board.sh          # 不带参数看用法与退出码语义
bash <插件目录>/tools/dual-board/dispatch.sh --help # 派单前注入未读段 + 记基线
```

- 数据目录默认 `~/proj/dual-board/`，`DUAL_BOARD_DIR` 可覆盖。
- 派单三件必给：`--context` / `--self-test` / write_scopes（或 `--read-only`），**缺一拒发（exit 2）**。
- ⚠️ **一律 `--workdir ~/proj`，别省**（2026-10-14 事故：默认 `.` 会在家目录 `git init && git add -A`，把 `.ssh`/`.dsh` 全进 git 索引）。
- 协议 v1.4 出板必须 `--reviewed-by human`（自动化用 `--keep`，绝不伪造）。

## 4.3 引擎与本机现场（要细节就读 references）

> 各引擎的路径 / 现场 / 能力 / 升级细节，见 **§0.1 读取闸门表**与对应 refs（`ref-pi-runtime.md` / `ref-codex-facts.md` / `ref-codex-upgrade.md` / `ref-claude-runtime.md`）；版本敏感结论（版本号、feature 开关、CLI 面）一律查 `<本机功能核对表>`，本文件不记现状。

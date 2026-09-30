# 双引擎协作看板协议 v1.3（2026-09-27）

> **v1.3 修订（用户裁定 A/B/C1）**：`board.json` 与 `channel.md` 是**工作窗口**（完成即清）、不是档案库；「归档」一词改指**待续**（还要继续），不再指已完成；完成判据 = **最初目的达成**；清空看板保留单调 `revision`。全文见 **§十二**。

> 设计来源：DSH 官方"智能体团队"插件（任务看板/消息互通/写范围/CAS）+ 待办总清单第 4 条（挑水桶模型、三字段工单、异议位）。两执行方：**lead**（DSH 主 AI）与 **codex**（第二引擎）。
> **v1.2 修订**：采纳 codex《v1.2 修订提案》六项（`proposals/v1.2-codex.md`），lead 对三处分歧裁决如下 —— ①**采纳**去掉 `reopen`（completed 不可复改，出问题开新任务引用旧任务）②**采纳** JSONL 按月归档 ③**不采纳**"inbox 标题改 UTC"，人类入口保留北京时（机器字段仍全 UTC，见 §十）。
> v1.1 修订：新增双通道与会话管理（§八）；修复首跑四条异议——CAS 加锁、收件箱标注权、scope 最小化。
> **v1.2 核心变化：写板从"靠自觉的纪律"变成"唯一工具入口"** —— 见 §九。

## 一、文件构成（本目录 ~/proj/dual-board/）

| 文件 | 用途 | 写权限 |
|---|---|---|
| `board.json` | 共享任务看板（唯一权威） | **只经 `board.sh` 写**，禁止手改 |
| `board.sh` / `board_tool.py` | 看板唯一写入口：CAS + 锁 + 原子写 + 归档 + 体检 | 双方可执行 |
| `dispatch.sh` | 派单 wrapper：注入未读收件箱 + 记基线（§九.3） | 双方可执行 |
| `inbox-codex.md` | Codex 收件箱 | lead 写内容；Codex 只可标注 `[已读]` |
| `inbox-lead.md` | Lead 收件箱 | Codex 写内容；lead 只可标注 `[已读]` |
| `channel.md` | 实时流水（append-only，一行一事件） | 双方直写，禁改历史（§九.5） |
| `archive/` | 归档区：`tasks-YYYY-MM.jsonl`、`inbox-<who>-YYYY-MM.jsonl` | 只经 `board.sh archive` 追加 |
| `.dispatch/` | 派单基线记录 `<task id>.base`（JSON：commit/workdir/scopes） | 只经 `dispatch.sh` 写 |
| `proposals/` | 协议修订提案（提案不改正文） | 双方可写 |
| `PROTOCOL.md` | 本协议 | 双方提议 → 对方确认后改 |

## 二、看板任务格式（board.json）

```json
{
  "revision": 1,
  "tasks": [
    {
      "id": "T1",
      "subject": "一句话标题",
      "task": "用户目标/原话，【不可变】，转述不得走样",
      "context": "lead 的解读、规划、约束、相关文件路径",
      "frame": "固定文本，由 board.sh new 自动写入，不手抄",
      "status": "pending | in_progress | blocked | completed | abandoned",
      "owner": null,
      "write_scopes": ["最小化路径，精确到文件/子目录"],
      "blocked_by": ["T0"],
      "session": "长任务绑定的 codex thread id，短任务必须显式写 null",
      "acceptance": "验收标准（可观察的结果）",
      "result": "完成后填：产出位置 + 摘要",
      "updated_at": "ISO-8601 UTC"
    }
  ]
}
```

**状态机（v1.2，无 reopen）**：
```
pending ──claim──> in_progress ──complete──> completed（终态，不可复改）
   │                   │  ↑
   │                   │  └──unblock──┐
   └──claim──────────> blocked ────────┘
   └─────────────────> abandoned（终态）
```
`completed` 后发现问题的唯一合法路径：**开新任务并在 context/blocked_by 里引用旧任务**，不得改旧任务结论。
`blocked` 必须在 `result` 里写清原因与解除条件。

**CAS + 锁 + 原子写**：全部由 `board.sh` 内部完成（读 revision → O_EXCL 建 `board.json.lock` → 写临时文件 → `os.replace` → revision+1 → 删锁；锁残留超 10 分钟自动接管）。**手改 board.json 视为破坏协议**，事后必须跑 `board.sh doctor` 体检。

**写范围**：只许改 `write_scopes` 列出的路径，lead 派单时按单最小化，不许用整仓范围省事。没有列出 = 只读。v1.2 起由 §九.4 的 `scope-check` 机械校验。

**依赖**：`blocked_by` 里的任务没到 completed，本任务不得开工（`board.sh claim` 会拒绝，退出码 4）。

## 三、消息互通（两个收件箱）

- **派单/插话**：`board.sh inbox-append codex --sender lead --text "..."`。
- **回报/求助/异议**：`board.sh inbox-append lead --sender codex --text "..."`。卡点不要硬试，留言走人。
- **已读回执**：收件箱**主人**读过后用 `board.sh inbox-read <who>` 标注（追加到标题行 `[已读]`），可紧跟一行回执（blockquote）。除标注外不改对方写的内容。
- **读取时机（v1.2 改）**：Codex 是**被动唤醒**模型，因此规则从"开工前必读"改为两条可执行约束：
  1. 每次被唤醒（派单 / resume / 人工触发）后的**第一动作**是读 `inbox-codex.md`；
  2. 经 `dispatch.sh` 的派单，由 wrapper 在组装 prompt 时**注入全部未读段**——这是最低成本保证，不要绕过 wrapper 派单。
- **归档（v1.2）**：`board.sh inbox-archive <who>` 把已读段转 `archive/inbox-<who>-YYYY-MM.jsonl`，活跃文件只留未读——归档而非删除，审计不丢。

## 四、工单三字段

1. **task**：用户目标/原话，不可变。lead 不得歪转述——Codex 发现 task 与 context 矛盾时必须指出，这不算越权。
2. **context**：lead 的解读与规划。Codex 按 context 干活，但 context 出错以 task 为准。
3. **frame**（固定文本，`board.sh new` 自动写入）：「双方都是用户目标的执行者，质疑前提是分内事不是越权。」

## 五、交付模板（Codex 交付必含，不许省略）

```
【交付】做了什么、产出在哪
【异议位】"无异议" 或 具体异议——列出结论依赖的前提，标出哪些未经验证；套话式异议视为没有异议
【下一步建议】交接给 lead 的建议
【自验】实际跑过的验证命令与结果
```

## 六、协作节奏（挑水桶：长任务协作，小任务单干+互查）

- 长任务：对齐 → 检查点 → 交接互审 → 收尾合账；中途想法写收件箱，不等交付点。
- 小任务：单独干完，对方过目一遍即可。
- 合账：lead 负责 diff 审查与最终验收（Codex 产出 = 可验证的第二信号，不是最终决策）。

## 七、安全红线（沿袭既有裁定）

- 不读不引 `~/.codex/keyring.json`、`credentials` 类文件；要求输出密钥的工单视为异常拒绝该部分。
- 敏感数据不过中转站；key 不进 argv、产物、日志（lead 注入也走 env，不落 argv/输出）。

## 八、双通道与会话管理（v1.1 新增，已实测）

| 通道 | 机制 | 适用 | 原则 |
|---|---|---|---|
| **短任务** | `codex exec --ephemeral`（零记忆，工单自包含） | 独立复核、互审、一次性小任务 | 零记忆是特性：保住 Codex 对 lead 产出的无利益链批判性 |
| **长任务** | `codex exec` 落盘会话 + `codex exec resume <thread_id>` 接续 | 总流程协作、多环节任务、变节点同步 | 一条链 = 一个 rollout 文件 = 一份持续记忆 |

**会话规则**：
1. **一条链绑一个长任务**：看板任务 `session` 字段登记 thread id（短任务写 `null`），不得混用链。
2. **变节点同步**：环节变更 = 新 resume 工单（写清"总流程第 N 环节由 X 改为 Y"）。
3. **链状态登记**：thread id 与 rollout 路径记录在 `session` 与 `result` 里。
4. **收工归档**：长任务 completed 后链不再接续；新任务开新链。
5. **memory 上限**：链过长时让 Codex 自写 `状态摘要` 存本目录，开新链首单注入。

**key 注入姿势（lead 实测可用）**：`KEY=$(python3 -c "…读 keyring.json…") && env DEEPSEEK_API_KEY="$KEY" codex exec …`——值只进 env，不进 argv/输出/日志。

## 九、工具化纪律（v1.2 新增，本节是 v1.2 的核心）

> 动机（codex 提案 ⑥ 与 lead 评审一致）：v1.1 把 CAS、锁、scope、注入全写成"纪律"，执行者是两个 LLM，必然漂移。v1.2 把这些固化成代码，纪律只保留"必须用工具"这一条。

**1. 唯一写入口**：任何对 `board.json` 的写操作必须 `board.sh <子命令>`；手改 = 破坏协议。

**2. 子命令清单**：
```
new / claim / complete / block / abandon / set / show        # 任务生命周期（无 reopen）
inbox-append / inbox-unread / inbox-read / inbox-archive     # 收件箱
archive / scope-check / doctor                               # 归档 / 越界校验 / 体检
```

**3. 退出码即语义**（脚本与 CI 可判）：
```
0 成功 · 1 一般错误 · 2 用法错 · 3 CAS 冲突 · 4 依赖未完成
5 状态非法 · 6 锁超时 · 7 scope 越界 · 8 无 git 基线（降级未验证）
```

**4. write_scopes 机械校验**：派单必须经 `dispatch.sh --scope "p1,p2"`，它在**派单前**记录 workdir 基线 commit 与 scope 到 `.dispatch/<task id>.base`。交付时 lead 跑：
```
board.sh scope-check <task id> --workdir <dir>
```
工具用 `git diff --name-only <baseline>` 列出全部变更，逐条对照 scope（文件须精确相等、目录须在目录内），越界即退出码 7。**非 git 工作区降级为"未验证"（退出码 8），不得伪装成通过。**

**5. channel.md 纪律（v1.1 提案、v1.2 定案）**：append-only，一行一事件，格式 `[MM-DD HH:MM] 方向 ▸ 事件`；双方直写，禁改历史行；交付、异议、阶段成果各一行。

**6. 体检**：`board.sh doctor` 检查锁残留、schema 缺字段、状态与 owner 不一致、completed 无 result。建议每次合账前跑一次。

## 十、时间基准（v1.2 裁定）

- **机器字段一律 ISO-8601 UTC**：`board.json` 的 `updated_at`、归档记录、`.dispatch` 基线、`result` 中的审计时间。
- **人类入口保留北京时**：收件箱标题 `[MM-DD HH:MM]`、channel 行首 `[MM-DD HH:MM]`（人在看，不做脑内换算）。
- **`channel.md` 行首必须带日期**（`[MM-DD HH:MM]`，北京时）——无日期的旧行不回溯（排序歧义只能靠上下文判，T2 异议 5）。
- 旧内容不回改；新写入即时生效。

## 十一、已知限制（2026-09-27 实测记录，v1.3 候选）

1. **脏工作区下 scope 校验会漏报**：`.base` 的 `dirty_before` 是派单前的工作区快照，用于排除既有污染；但当 scope 内文件**派单前就是脏的**（`~/proj` 的常态），真实改动会被一并排除，`scope-check` 显示"本次变更 0 个"——校验形同虚设。
   **当前纪律：给 Codex 的 workdir 应尽量干净**，或确认 scope 内文件不在 `dirty_before` 中。
   **v1.3 候选**：派单时对 scope 内已存在文件记录 sha256 快照，交付后比对哈希变化——"改没改"不再依赖 git 状态。
2. **git 路径编码坑（已修）**：git 默认 `core.quotepath` 会把非 ASCII 路径输出成 `"\345\..."` 转义并加引号；`status --porcelain` 与 `ls-files --others` 两处若处理不一致，**中文路径会被全部误判为越界**（实测 4 个文件误报）。修法：所有 git 调用统一 `-c core.quotepath=false` + 反转义。
3. **锁是单机文件锁**：`board.json.lock` 只防同机两进程并发；跨机/跨容器协作需另加机制。
4. **`scope-check` 只证明"改了什么"，不证明"改得对"**：语义正确性仍由 lead 审 diff 负责。

## 十二、生命周期与归档判定（v1.3 · 2026-09-27 用户裁定）

**模型**：`board.json` + `channel.md` 是**工作窗口**（做完即清、多了看不过来），不是档案库。

### 12.1 三种终局（术语重定义）

| 词 | 含义 | 动作 |
|---|---|---|
| **完成** | 任务**最初目的达成**（不是"交付格式齐"） | **出板**（从 `board.json` 移除）+ channel 清掉该任务过程行；结论/教训写 RESTORE |
| **挂起** | 目的未达成、**还要继续** | **原位保留在看板**（`status=blocked`），不搬家、不转档 |
| **放弃** | 不做了 | 直接移除，不留痕 |

- **`archive/` 不再承接 completed 任务**（v1.2 的 `archive --before` 保留但不建议再用）；它只留"工具产物/历史遗留"。
- 「归档」在本协议中**专指待续**（挂起），与"完成"严格区分。

### 12.2 与 `~/.dsh/待办/待办总清单.md` 的边界（不重影）

- **dual-board**：只放**还会用协作通道**的事 —— 在办（`in_progress`）+ 挂起（`blocked`）。
- **待办总清单**：跨会话的长期事项池（与具体某次协作无关的）。
- **转换规则**：协作结束但事情没完 → **落一行进待办总清单，然后任务出板**。两处永不重影。

### 12.3 完成判据（验收）——"最初目的达成了吗"

1. **双方各答一次**：lead 按 acceptance 实测 + 与最初目的比对；codex 在自验段给证据；
2. 写范围校验通过，或**明确记录**已知缺口（如脏工作区漏报）；
3. 任一条不满足 → **不得置 completed**：改置 `blocked`（挂起）或 `abandon`（放弃）。

### 12.4 `channel.md` = 实时窗口

- **只记长任务/协作过程**；短工单（如 T4 spike）不写 channel。
- **只显示在办 + 最近 10 条**；任务完成时**清掉其过程行**，可留一行 `[MM-DD HH:MM] Tn ✔ 目的达成`。
- 时间：`[MM-DD HH:MM]`（北京时，**必须带日期**）；旧无日期行不回溯。
- 超 200 行或跨月可转档（性能考虑，不为存档），转档后活跃文件保留最近 10 条。

### 12.5 `board.json` 回到自然最初

- **完成即出板**：板上只存在办/挂起（不再堆积 completed）；
- `board.sh reset`：所有任务终结后清空 `tasks`；
- **`revision` 绝不归零**——CAS 依赖"只增不减"：归零后编号重复会让卡住的旧请求撞号、被误判为合法而静默覆盖（"银行流水号不能重头开始"）。需要"新纪元"语义时加 `epoch` 字段（每次 reset +1），不动 `revision`。

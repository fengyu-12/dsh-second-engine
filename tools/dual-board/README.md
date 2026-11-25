# dual-board 运维 README

> 本文是**维护/清理层**说明：数据长什么样、任务怎么出板、板外的自动清理做什么。
> 协议语义（字段定义、状态机判定、交付模板、安全红线）见同目录 `PROTOCOL.md`——两文互补，不重复。
> 写板唯一入口：`board.sh`（或 `board_tool.py`）。**禁止手改 `board.json`**。

## 1. 数据布局

| 文件 | 作用 |
|---|---|
| `board.json` | 活看板：`tasks` + `roles` + `revision`（CAS 的单调版本号） |
| `channel.md` | 协作过程窗口：只留在办 + 最近 N 条，不做档案 |
| `inbox-<role>.md` | 收件箱（lead / codex / pi / claude） |
| `archive/` | 工具产物与历史遗留：`tasks-YYYY-MM.jsonl`、`inbox-<who>-YYYY-MM.jsonl`、`channel-YYYY-MM.md`；**不是已完成任务的归宿** |
| `audit/completed-YYYY-MM.jsonl` | 完成审计（含完整任务 + reviewed_by/at） |
| `auto-cleanup.last.json` | 最近一次自动清理的结果（失败原因也在里面） |
| `.dispatch` / `second-engine-board-sweep.last.json` | 派发状态与巡检时间戳 |

## 2. 任务生命周期（以当前实现为准）

`pending → claim → in_progress → complete / block / abandon`

- **complete**：目的达成 → 默认**出板**（从 `tasks` 移除）并写 `audit/`；`--keep` 留板待审。
- **abandon**：只置 `status=abandoned`（终态）并追加 reason，**不会自动从 board.json 消失**。要清走用第 3 节的 `archive --before` 或 `reset`。
- **block**：原位保留（`status=blocked`），不搬家。
- **终态不可复改**：completed/abandoned 之后再 claim/complete 会被拒（退出码 5）；要重做请开新卡并在 `context` / `blocked_by` 引用旧 id。

## 3. 日常维护动作（按场景）

```bash
# 看现状
board.sh show                 # 全部任务 + revision
board.sh ready                # 可开始的任务（依赖已满足）
board.sh doctor               # 结构体检

# 完成任务（出板 + 写 audit）
board.sh complete <id> --result '<证据与结论>' --reviewed-by human   # 人确认
board.sh complete <id> --result '<自测输出>' --reviewed-by auto      # 低风险自签
board.sh complete <id> --result '...' --keep                        # 留板待审

# 放弃 / 卡住
board.sh abandon <id> --reason '<原因>'
board.sh block   <id> --reason '<卡点>'

# 清掉已终结任务（转档到 archive/tasks-YYYY-MM.jsonl）
board.sh archive --before 2026-11-26T00:00:00+08:00

# 全清（有未终结任务时需 --force；revision 不归零）
board.sh reset [--force]

# 收件箱 / channel 瘦身
board.sh inbox-archive <who> --expire-unread-before <ISO>
board.sh channel-trim --keep 10

# 角色与收件箱映射
board.sh roles show
board.sh roles set <role> --engine <dsh|codex|pi|claude>
```

## 4. 板外的自动清理（auto-cleanup）

插件内定时运行（约 6 小时一次），只动**板外文件**，不删 `board.json` 里的任务：

- `inbox-<who>.md`：7 天未读段标 `expired-unread` 后归档到 `archive/inbox-<who>-YYYY-MM.jsonl`。
- `channel.md`：按月转档到 `archive/channel-YYYY-MM.md`（目标已存在时**追加**，不覆盖）。
- `audit/`、`.dispatch`、`archive/` 里超过 30 天的文件清理。
- 删文件前先 git commit（`-c user.name=board-cleanup -c user.email=board-cleanup@localhost` 临时身份，本机无全局身份）；失败记 `auto-cleanup.last.json`，不阻塞主流程。

## 5. 常见坑

- **终态不可复改**：要续做就开新卡，不要试图把 completed/abandoned 改回去。
- **`archive --before` 必填 ISO-8601**（缺省会直接报错退出 2）。
- **`--reviewed-by` 只认 `human` / `auto`**，其它值（含 codex/lead）退出码 5。
- **`--owner` 是团队角色名**（lead/codex/pi/claude），不是引擎 id。
- **`revision` 只增不减**：`reset` 清空 tasks 但版本号不归零，CAS 依赖这一点。
- **完成 ≠ 审核**：`completed` 只表示工作完成，`reviewed_by=human` 才表示人审核过。

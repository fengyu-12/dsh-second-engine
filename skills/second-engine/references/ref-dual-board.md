# ref · dual-board 双引擎协作看板细则（协议实物 v1.4，2026-09-25 上线）

> 入口：`SKILL.md`「要写看板、派长任务链、查 board 子命令与退出码、跑 scope-check 时」。
> 什么时候该走看板：派单涉及多环节长任务或需 Codex 持续记忆时。

## 1. 脚本 / 协议随插件，数据分离

- 脚本与协议：`~/dsha-second-engine/tools/dual-board/{board.sh,board_tool.py,dispatch.sh,PROTOCOL.md}`（自定位，`DUAL_BOARD_DIR` 可覆盖数据目录）。
- **运行数据**默认 `~/proj/dual-board/`（Codex 侧登记 `~/proj/AGENTS.md`）：board.json / channel.md / inbox-* / archive / .dispatch。**只放数据，不放脚本**。

## 2. 写板唯一入口 `board.sh`

CAS + O_EXCL 锁 + 原子写 + 状态机 + 归档 + 体检全在工具里，**手改 board.json = 破坏协议**。

- 子命令：`new/claim/complete/block/abandon/set/show`、`inbox-append|unread|read|archive`、`archive`、`scope-check`、`doctor`；不带参数跑一次看用法。
- **退出码即语义**：0 成功 / 3 CAS 冲突 / 4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 降级。
- **无 reopen**：completed 不可复改，出问题开新任务引用旧任务。

## 3. 协议 v1.4 三条（2026-10-30 落地，三条都改行为）

1. **`complete` 出板必须 `--reviewed-by human`**（Agent 自报不算完成）；自动化流程用 **`--keep`**（免人审、留在板、**不写** human 标记，绝不伪造）。出板记录落 `audit/completed-<月>.jsonl`，`archive/` 不再承接已完成任务。
2. **`steps` 字段**：`set steps=描述::pending,...`，≤20 项 / 每项 200 字符 / 总 4000；不参与状态机。
3. **N 角色**：角色清单进 `board.json.roles`，`inbox-<role>` 动态生成，`dispatch.sh --to ROLE`（缺省 codex），`claim --owner` 的合法值从 roles 取。

## 4. 派单走 `dispatch.sh`

- 自动注入 `inbox-codex.md` 未读段 + 派单**前**记基线 commit 与脏快照 → `.dispatch/<task id>.base`。
- 交付后 `board.sh scope-check <id> --workdir <dir>` 机械校验 write_scopes 越界（⚠️ 脏工作区会漏报，尽量给干净目录）。
- **2026-10-13 起硬约束**：`--context`（lead 的解读）/ `--self-test`（自测与验收方式）/ write_scopes（或显式 `--read-only`）**缺一即拒发**（exit 2）。

## 5. 双通道

- **短任务**：`POST /api/task`（ephemeral 零记忆，互审/复核用）。
- **长任务**：`codex exec` 落盘 + `codex exec resume <完整 36 位 UUID>` 成员会话（一条链绑一个任务，thread id 记看板 `session` 字段，实测跨单记忆保持；API 不支持 resume，长任务用 CLI 手动注入 key）。
- 工单三字段 task/context/frame，交付强制四段含【异议位】。
- 细则读 `PROTOCOL.md` §九（工具化纪律）与 §十一（已知限制）。

## 6. ⚠️ 派单必须显式 `--workdir <绝对路径>`（2026-10-14 事故）

`--workdir` 默认值 `.` 按 Web 进程 cwd 解析，落到 `$HOME` 时插件会在家目录 `git init && git add -A`，把整张家目录（含 `.ssh`/`.dsh` 凭据）加进 git 索引并污染面板「改动摘要」。复盘、三层加固、判据命令见 skill `dsh-env-maintenance` 的「2026-10-14 事故」节（`dispatch.sh` 现已拒绝相对路径与 home/root）。

**纪律：一律 `--workdir ~/proj`，别省。**

## 7. 写板相关的历史坑（实测踩的，改工具前先看）

- `board_tool.py` 的 `CHANNEL` 曾错挂 `dirname(__file__)`，`complete` 的清场全写进插件目录（已改为跟 `BOARD_DIR`）。
- 面板卡片状态白名单曾漏 `cancelled`，导致「已取消 + 运行中」并存。

## 8. 多桥部署（跨引擎并行，2026-11-04 实测）

只跨引擎多开（Codex + Pi + Claude）；同引擎两桥是同一模型两个上下文，边际收益低。

- **Pi**：`PI_BRIDGE_PORT=8788 node bridge/pi/server.mjs`（插件根下跑）；1 个 node 进程，内部是否再拉 Pi RPC 子进程**未实测个数**
- **Codex**：`BRIDGE_STATE_DIR=/tmp/bx BRIDGE_PORT=3195 BRIDGE_AS_PORT=3196 ./ctl.sh start`（在 `bridge/web/` 下）；**2 个常驻进程**（app-server + 网页桥）
- **Claude**：`CLAUDE_BRIDGE_PORT=8789 node bridge/claude/server.mjs`；1 个 node + 内部 1 个常驻 claude 子进程（懒启动）；页面复用 `bridge/web/public/index.html`
- **后果**：每加一个桥 ≈ 一组端口 + 一份常驻内存；Codex 桥还会拉起完整 app-server（`/api/health` 里 `appServer.connected` 可验）。桥没有 `task.output` ⇒ **必须各自 `board.sh new` 记账**
- **别共用状态目录**：`.pid` / `.as.pid` / `.token` 固定落在 `BRIDGE_STATE_DIR`，两个实例互相覆盖 ⇒ **一桥一目录**
- **收尾**：`ctl.sh stop`（同目录同端口）；Pi 桥按**精确 PID** 结束；临时状态目录与日志一并删

实测（2026-11-04）：Codex 桥 3195/3196 = pid 31012(app-server) + 31057(网页桥)，health `ok:true, connected:true`；Pi 8788 = 1 个 node 进程，根路径 HTTP 302。

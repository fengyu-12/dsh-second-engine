# 派单路由与编排安全（2026-10-30 用户定 · 2026-10-31 自待办迁入）

## 路由铁律：派给谁

- **本机相关 / 轻量 → 我**；**比较麻烦的写代码 → 第二引擎**（当前 active 是 Codex；切到 Pi 后路由前先按 `选哪个引擎` 一节确认这活 Pi 能不能接）。不要再全干。（其他执行方各有自己的 skill，本文件不越界）
- **产物对齐**：派单前必须**重新打包当前真身并记 md5**，禁止拿旧包派单；旧包改名 `*-stale-*`。
- **先决定再干**：设计有疑问先发一单问第二引擎定方案，方案定了再派施工。

## 各方边界（每单写死）

| 执行方 | 边界 |
|---|---|
| 第二引擎（Codex / Pi） | 只读派单指定的副本目录；禁读 `~/.codex/`、`~/.dsh/`、config / keyring / 凭据；**禁删除**；允许联网搜索；改完必须贴真实自测输出 |

## 编排安全：真隔离做不到

**顺序不能反**：底座先做好，编排才有意义。本机实测（proot）：

| 手段 | 实测 | 结论 |
|---|---|---|
| capabilities | `CapEff: 0000000000000000` | 假 root，`mount` / `chroot` 不可用 |
| Landlock | syscall 444 → `errno=38 ENOSYS` | 内核没编，不可用 |
| 第二个 uid | `uid>=1000` 零条 | 「独立 uid + 0700」做不了 |
| namespace | proot 无真 namespace | bwrap / firejail 起不来（同红线 19） |
| ptrace | `PTRACE_TRACEME` 成功、无 yama | **唯一还开着的门**；proot 自身用 ptrace，嵌套未验证 |

⇒ **真隔离做不到，只能「限额 + 留痕 + 可回滚」。叫最小权限，别叫沙箱。**

**编排放大的三个风险**：① **传染** —— A 的产出喂 B，A 被污染后 B 照着做，而 B 权限可能更大 ② **记忆污染** —— 共享记忆写入错误结论，后面所有 agent 都召回它 ③ **身份伪造** —— `session.append('user/message')` 让消息看起来像用户说的，任何能调该端点的进程都能冒充用户。

**最小底座三件（按性价比）**：

- **spawn 时收窄 workdir + 加 ulimit** —— 挡炸盘 / 吃满 CPU / 误改整个 `/root`（未做）
- **访问审计（只记不拦）** —— 事后知道「它碰了什么」，出事能追（未做）
- ~~Pi 桥加 token~~ —— 已随 S6 完成（loopback 免 token、非 loopback 必须 `x-bridge-token`）

**当前最糟的一条**：本插件给 Codex 生成的配置固定 `approval_policy="never"` + 默认 `danger-full-access` ⇒ 派出去的 Codex **完全放开、无人审批**，且能读 `$HOME/.dsh` 全部内容（含 `凭据文件`）。⇒ 门禁是**流程要求**，不是执行层保障。

## 同类项目速查（2026-10-29 调研 · **已停止调研，别重复搜**）

| 项目 | 可搬点 | 判定 |
|---|---|---|
| `zsjs110110-cpu/dsh-cross-session-approval` | 两个原语：`ctx.get('sessions').get(id)` + `session.append()`；`agents.resume({resumeSessionId})`；`cs_` 短别名 | 只抄原语，它的 10 个工具用不了（宿主 bundle，外部 CLI 不行） |
| `Fei2411/DeepSeek-Bot`（= DSH 内置 `ds-bot`） | Bot 团队 + `@转交` + 群共享记忆的交互形态 | 不装（与上重叠） |
| `Gambler134201/multi-agent-collaboration` | **`{path, sha256}` 证据模式**（治「文档说做了、实物没做」）；执行端适配器四步（探测 → 投递 → 回收 → 判定） | 抄设计，跑不了（Windows PowerShell/PS） |
| `LUgABeEEE/dsh-global-todo` | 完成门禁第二个入口：`done` 只是声明 + `review:{pending}`、宿主自动收尾也进待确认、只有干净收尾算候选 | 不装；缺口见待办 |
| `xfgil/dsh-second-opinion` | ① `whenIdle()` 不能当等待真源（`wakeDriver` 在非 idle 时直接 return、不新建 `activityDone`，会解析上一轮的 promise）② 只读旁看用 `sessionController.inspect`（不 resume、不写入、不打断） | 它是同模型开新会话：解决「被上下文带偏」，不解决「模型本身想不出」 |

**判定不做**：`scope-recall`（记忆层属过度设计）、`claude-agent-examples`（无 license 不可搬）、`emperor-agent`（macOS-only 非插件）、`ds-bot`（概念已对齐）、`cross-session-approval` 的工具面。

**许可**：MIT 可直接搬（保留版权声明）；AGPL 只能借鉴设计。

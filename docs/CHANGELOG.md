# 版本记录

> 2026-10-29 从 README 拆出：README 只留最新版摘要，完整历史放这里。

> **3.1.2 → 3.5.0 是跳号发布**：这一轮动的是**协作机制本身** —— 三档协同、主 AI 侧派单契约、版本提示自动熄灭。不是挤牙膏式修补，按换代走。

| 版本 | 关键点 |
|---|---|
| **3.7.0** | **双引擎能力契约 + Pi 运行时接入（未发布）**。① Pi 运行时与桥：`src/engine/pi-*.js`、`bridge/pi/server.mjs`；② 能力契约拆分：`chatBridge`（可用性）+ `chatBridgeMode`、`mcp`、`webSearch`，清理目标 `cleanup` 独立于 `resume`；③ 设置面板与浮球按引擎渲染（Pi 下不再出现 Codex 探测/版本/占用/复核/工单等假入口）；④ 浏览器桥按引擎署名与提示（Pi 不提示 `codex-env`，页面身份取 `/api/health`→`/api/config` 双探针）；⑤ Pi 模型真源：runtime `get_state` → 配置默认（返回带 `source`，`fallback` 语义收窄）；⑥ 版本检查按引擎分流（Codex=GitHub release，Pi=npm registry，页面/浮球同款三档徽标）；⑦ AGENTS.md 双写 Codex+Pi（Pi 段身份为 pi），Pi 桥会话落盘（去 `--no-session`）、默认工作区 `~/pi-workspace`；⑧ **写入口与清理门禁加固**：Pi 提供方 id 加保留名白名单（`constructor`/`prototype`/`toString` 等对象原型键不再能写成配置键）、`mcp.json` 纳入同一把写锁与原子写（并发 10 写不再丢）、`.bak` 轮转保留 5 份、清理接口按引擎判（错引擎一律 409 且带 `engineMismatch`，不再误删另一引擎的会话）。 |
| **3.6.2** | **补第二批「端口 / 注释」缺陷 + 固化冒烟**。① `tools/wait-task.sh`（连环境变量兜底都没有）与 `tools/dual-board/dispatch.sh` 的 Web 地址默认写死 `127.0.0.1:3080`，动态端口下派单/等待直接连不通 → 新增 `tools/web-base.sh`，优先级 `SECOND_ENGINE_BASE_URL` > `DSH_WEB_URL` > 运行中宿主 `--port` > 3080。② 行尾注释保留改**引号感知**（新 `bridge/web/toml-comment.mjs`）：值含 ` # ` 时不再从引号内部切开，`#` 前无空格的尾注也能保留。③ 新增 `tools/smoke.sh`：干净环境冒烟（语法 / 端口解析 / wait-task 联调 / 看板全链路 / dispatch 草稿 / install dry-run / 注释单测 / 三处落点对齐）。④ 版本记录计数口径统一：3.6.1 实为 **14 处**（5+2+2+1+3+1）。 |
| **3.6.1** | **修「干净环境一跑就崩」的 14 处**（3.6.0 包里它们在新装用户第一次运行时全部踩中；作者机因目录早已手建从未触发）：`install.sh` 按旧布局找路径等 5 处 · `board_tool.py` 不建数据目录 + **12 个子命令无一能建板** 2 处 · `dispatch.sh` 收件箱缺失即报错 + 用数据目录找随包脚本 2 处 · `package.json` 的 `files` 漏 `wait-task.sh`/`t-tool.sh` 1 处 · 3 个注入函数补 `mkdirSync(CODEX_DIR)` 3 处 · 网页桥 `updateConfigToml` 保留行尾注释 1 处。**验收**：`DUAL_BOARD_DIR=$(mktemp -d)` → `board.sh new` → `dispatch.sh` 双 exit 0。 |
| **3.6.0** | **债务清算 + 实现优化**。修三处**不报错**的静默失效：① 卡点求助地址写死 3080（新版 DSH 改动态端口后一直连不通，只靠文本兜底）→ 改从宿主 `--port` 解析；② `~/.codex/AGENTS.md` 的 v2/board 段「标记存在就跳过」⇒ 老用户永远拿不到新内容 → 补结束标记 + 摘除重写 + 三级边界（末命中则告警不动手），`v1→v2` 不再静默截断；③ `rounds[].verdict` 与终止判据口径不一致。补两处**写了但从没跑到**的清理：`.live` 被 200 MB 阈值挡在后面（10-17 起未执行）→ 从阈值摘出；Codex 日志库按时间清 + 碎片回收（`node:sqlite`，五道安全闸）。优化：复核**首轮**提示词补三条硬要求 · 复核新增 `blocked` 硬档（识别即终止）· 只读 `independentSources`/`quorumNote`（不参与收敛判定）· 写入统一原子化 · `config.toml` 备份轮转留 5 份 · 新增 `GET /api/_meta` 路由自描述。 |
| **3.5.0** | **协作模式三档落地**（普通复核 / 协作提议 / 长任务配合 + custom；`voice` 切档即写/删 `~/.codex/AGENTS.md` 段，`longtask` 只影响主 AI 派单）· 悬浮球加档位下拉 · 球面板版本行改「Codex 版本 / 会话目录占用」两行 kv + 与设置页同款「已是最新」徽标 · **修「升级完红点常亮」**：有新版提示由挂载查一次改为 30s 轮询，且无新版时自动熄灭（旧版只有点亮分支，升级完必须整页刷新才熄）· 主 AI 侧新增「派单前先读档位」流程（插件无推送通道，靠 `/api/status` 主动查）· SKILL 不再记版本号，版本与开关态统一归 `Codex功能表.md` |
| **3.1.2** | 插件自身版本提示（`/api/plugin-version`，默认完全静默）· 面板「模型与思考」`/api/config`（键白名单 + 写前备份 + 原子替换）· 设置页改分区制（说明收进「?」、provider 主行只留名称/徽标/模型、会话清理折起）· 悬浮球面板重排（标题行状态点+模型名、版本与占用并一行、空态去框）· 面板高度跟随 `visualViewport`（键盘弹出不再慢半拍） |
| **3.1.1** | 文档补全：安装分「tgz / 源码」两种方式并标明 link: 必装依赖 · 用 GPT 系模型需另装 `codex-code-mode-host`（含镜像下载与「文件真落盘」验收判据） |
| **3.1.0** | exec 工单过程流 `.live` 跑完即删（不再积压磁盘）· `cleanup` 覆盖 `.live`（并跳过运行中的任务）· dual-board 用法段回灌 · SKILL 增「会话落盘路径与读法」 |
| **3.0.0** | 首 token 看门狗 180s · 终态方法集合（防迟到旧 turn）· `contextUsageRatio` 多版本兜底 · `thread/settings/update` 会话内切模型 |
| v2.6 | dual-board **v1.4**（`ready` 引导 + `trace_search.py` 过程级检索）· 面板滚动条修复 · Codex 侧 dual-board 用法写入全局 `~/.codex/AGENTS.md` |
| v2.5 | 编排层口径 · 翻译桥对账 tick · 互审硬预算 · `/providers/update` 支持 `wireApi` |
| v1.2.1 | 配置保留段改用黑名单（切提供方不再丢 `[features]` / `[tui]` / `[projects.*]`） |

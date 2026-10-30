# dsh-second-engine

> 🚀 **你的 AI 也能拥有自己的 AI**：装一个插件、再装个 223MB 的 Codex CLI，你的 DeepSeek Harness 里就多了一位 7×24 待命的**第二引擎**——多个 agent 干累了可以「让 Codex 试试」，写完代码自动互审挑刺，卡住还会主动喊救命。一个手机，两颗大脑，你只管裁决。
>
> **这里卖的不是"多装一个 agent"，而是那个把 agent 管起来的宿主**：一个有界面、有系统通知、能被手机系统调用、还能让多个 agent 互相把活交出去的调度层。装第二个 agent 只要一行 `npm i -g`；让它在手机上**可被指派、可被观察、可被打断、可被验收**，才是这个插件干的事。
>
> **v3.5.0 起，两颗大脑开始「商量着干活」**：三档协作模式 —— **普通复核**（默认，交付即完）· **协作提议**（要它自己表态愿不愿意接、接哪部分）· **长任务配合**（不开单次任务，直接起长会话边干边聊）。档位在悬浮球里切，切完对下一次协作生效。

| 平台 | 状态 |
|---|---|
| **Android（DSHA）** | ✅ 实测全功能（免 ROOT 免 Termux：[DSHA 下载](https://github.com/qiannianhuanxiang/DSHA) · [项目主页](https://github.com/DSH-APP/DSHA)）|
| **Windows / macOS（DSH 桌面壳）** | ⚠️ 理论兼容未实测（插件为纯 Node；需换装 x86_64 版 Codex 二进制；App 通知能力视宿主而定）。桌面壳参考：[desk-harness](https://github.com/llyyhh0487/desk-harness) / [deepseekharness-desktop](https://github.com/honghuachen/deepseekharness-desktop) |

## 它替你解决什么问题

把 OpenAI Codex CLI 接入 DeepSeek Harness（DSH），作为与 DSH 内 agent 并行的**第二引擎**，并把"多个 agent 怎么一起干活"这套调度做实：

- **看得见**：设置面板 + 悬浮球，引擎状态灯、模型提供方、任务列表、版本徽标都在界面上，不是只有终端里滚日志。
- **叫得动**：任务完成经 **App 系统通知**提醒；等结果的工具挂在后台 job 里，通知会自动唤醒等待者——不用人守着想"它到底跑完没"。
- **能互相交活**：一个 agent 把产出交给另一个做多轮批判性复核；卡住的一方主动提交卡点求助；长任务在文件看板上交接、留痕、要人签字。
- **可打断可追溯**：appserver 模式下真打断（65ms 级）+ 流式进度；工单有队列、历史、output 留存。

在同一台 Android 设备的 DSHA 容器（Ubuntu / proroot）里，双引擎并存：DSH 侧 agent 负责编排与审核，Codex 独立复核、并行下探、提供异构第二意见——三者各司其职：**Codex 生产 · DSH 侧 agent 编排审核 · 用户裁决**。

**占用账单（安卓实测）**：Codex 本体 223MB + 数据 33MB + 插件依赖 0.3MB ≈ **256MB**，换一个独立执行、互审、救场的第二 Agent。

## 为什么安卓上"多一个 agent"这么难，怎么绕过的

Android 的沙箱模型把环境切碎了：每个 App 各自下载依赖、各部署一遍，agent 想要的那把 shell 工具链在沙箱里根本不存在。

- **沙箱为什么挡路**：proot 环境无 Landlock / bubblewrap，Codex 需要的沙箱原语拿不到；App 各自一套环境，也意味着没有一处能让两个 agent 共用同一份工作目录与同一批工具。
- **proot 容器怎么替代**：DSHA 容器（Ubuntu / proroot）给出一把完整 shell，Codex 用 **musl 静态二进制**直接跑（免 ROOT 免 Termux）；沙箱改为 `danger-full-access` 运行，**安全防线移到流程层**——工作副本隔离 + diff 审查 + git 仲裁（详见「有哪些坑要提前知道」）。
- **顺带得到的好处**：Codex 不自带依赖，任务里跑的每条命令直接使用容器现成的 Python / Node / 工具链 / 词库（55 个沉淀脚本即取即用），插件本体仅 0.3MB；两颗大脑互为备份——DSH 侧 agent 装插件/写配置出问题时，Codex 有完整 shell 可以接手排查修复；反过来 Codex 卡住走求助协议喊救命，DSH 侧 agent 带建议回来。谁都能救谁。

## 多个 agent 怎么分工

| 角色 | 职责 |
|---|---|
| Codex（第二引擎） | 生产：小粒度任务交付、独立复核、并行下探 |
| DSH 侧 agent | 编排：拆任务、布置环境、审 diff、落主区 |
| 用户 | 裁决：分歧点上交，最终取舍由人 |

## 什么时候该把活交给另一个引擎（多引擎协作策略）

插件把这套判据随包分发，agent 不用每次临场即兴判断：

- **主判据 · 二分自答**：当用户否掉了上一步，先只问一句——**他纠正的是「这一步做法」，还是「这条路」？** 做法问题当场改，不叫第二引擎；方向或验收条件变了、同一处已被纠正 2 次、或一句话推翻了前面的判断链 ⇒ 立刻外置，先交活后解释。分不清按"这条路"处理：多跑一次约 3 分钟，比再耗一小时便宜。
- **兜底 · 四条机械信号**（由 `tools/policy-watch.py` 从会话事件流里算，不靠 agent 自己记）：
  - 同一规范命令 + 同一错误类**连续失败 ≥2 次**
  - 同一文件**编辑振荡 A→B→A**
  - **连续 4 步无状态推进**（跳过等待类调用）
  - 同一失败集合重复（中间有实质修改）
  命中即退出码 **10**。已验：正向 **3/3 命中**、负向 **4 类反例不报**。不计入的噪声：网络抖动 / 限流 / 外部终止 / 等待期 / MCP 重连 / 格式化与代码生成的大 diff。
- **反向也成立**：Codex 连续失败或反复回到同一处时，会主动调 `/api/consult` 提交卡点并通知，DSH 侧 agent 带建议接手。

对外只说**编排**与**协作**：谁做、谁审、谁签字，都在界面上看得见。

## 怎么一起干活：互审、求助、看板、桥

### 双向互审

把产出交给 Codex 做多轮批判性复核：轮数上限 / 零新增提前收敛 / 分歧打包上交用户 / 任意时刻熔断，轮数在面板设置。**复核（`POST /api/review`）恒走 exec 多轮子进程**——appserver 化在路线图上（复用 `startAppServerTurn` 即可；卡点是 token 硬预算的数据源要从 exec 尾部 "tokens used" 换成 `thread/tokenUsage/updated` 事件，未验收前不切）。

复核记录持久化到 `~/.codex/reviews/<id>.json`（0600，数量 200 封顶 + 按保留天数龄清），历史用 `GET /api/reviews?limit=20` 拉取（重启不丢）；末轮未决问题同时以 `[REVIEW_ISSUES]` 块追加进该复核任务的 `output`。带 `reviewDirty` 时通知也会提示（复核窗口内工作区新增改动＝**证据**：含任何写入者的改动，不归因、不阻断——起点已脏的路径不计入）。

### 卡点求助协议

插件自动向 `~/.codex/AGENTS.md` 写入协作协议——Codex 连续失败或反复回到同一处时主动调 `/api/consult` 提交卡点并通知，DSH 侧 agent 带建议接手。

### 协作看板（dual-board，v1.4）

长任务协作走文件看板。**脚本与协议随插件**：`tools/dual-board/`（`board.sh` / `board_tool.py` / `dispatch.sh` / `PROTOCOL.md`，2026-09-30 收编、路径自定位）；**运行数据**默认仍在 `/root/proj/dual-board/`，可用 `DUAL_BOARD_DIR` 覆盖（Codex 侧由 `/root/proj/AGENTS.md` 自动注入，无需人工提醒）：

- **写板唯一入口 `board.sh`**（v1.2 起）：CAS + O_EXCL 锁 + 原子写 + 状态机 + JSONL 归档 + `doctor` 体检都在工具里，**手改 `board.json` 视为破坏协议**。退出码即语义（3 CAS 冲突 / 4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 降级）。
- **出板要人确认 `--reviewed-by human`**（v1.4 起）：`complete` 必须由人签，**Agent 自报不算完成**；自动化流程用 **`--keep`**（免人审、留在板、**不写** human 标记，绝不伪造）。出板记录落 `audit/completed-<月>.jsonl`，`archive/` 不再承接已完成任务。
- **`steps` 字段**（v1.4 起）：长任务可拆 ≤20 步（`board.sh set <id> steps="描述::pending,描述::done"`，每项 ≤200 字符、总长 ≤4000），不参与状态机，供中断/续跑。
- **N 角色泛化**（v1.4 起）：角色清单进 `board.json.roles`，收件箱按角色动态生成 `inbox-<role>.md`；交活给某个角色用 `dispatch.sh --to <role>`（缺省 codex），`claim --owner` 的合法值从 roles 取。
- **交活一律走 `dispatch.sh`**：自动注入收件箱未读段、附协作纪律、在交付**前**记基线 commit 与工作区脏快照到 `.dispatch/<task id>.base`；交付后用 `board.sh scope-check <id>` 机械校验写范围越界。
- **看板**：`board.json` —— 状态 `pending / in_progress / blocked / completed / abandoned`（**无 reopen**，completed 不可复改）；工单三字段：`task`（用户原话，不可变）/ `context`（DSH 侧 agent 解读）/ `frame`（质疑前提是分内事，由工具自动写入）。
- **收件箱**：`inbox-codex.md` / `inbox-lead.md` 双向留言（经 `board.sh inbox-append`），已读标注 + 按月 JSONL 转档（`archive/`）；交付必含四段：交付 / **异议位** / 下一步建议 / 自验。
- **可开工引导 `board.sh ready`**（v1.4 起）：只读列出「前置已满足」的下一步，与 `claim` 的依赖门互补（claim 是拒绝、ready 是引导；空态退出码 0）。
- **过程级检索 `trace_search.py`**（v1.4 起）：`list` / `search` / `get` 三档，在历史会话 rollout 里按关键词找**过程证据**（不只找结论），`--exclude-session` 可排除自己。
- **双通道**：短任务走 `/api/task`（ephemeral 零记忆，保互审独立性）；长任务 `codex exec resume <thread_id>` 成员会话（一条链绑一个任务，看板 `session` 字段登记，收工归档）。
- **可视化**：浏览器聊天桥（3095）的会话列表抽屉 = 成员会话切换，终端/网页/DSH 侧 agent 三方同链。
- ⚠️ **已知限制**：脏工作区下 scope 校验会漏报（协议 §十一）；给 Codex 的 workdir 尽量干净。

### 浏览器聊天桥

手机浏览器里直接和 Codex 对话，与终端共享同一批会话（`127.0.0.1:3095`，自带 token 鉴权，等于密码别外传）。

## 唤醒层：把消息递进指定会话（实验端点）

`POST /api/_exp/wake` 用 `session.append` + `agents.resume` 把消息递进指定会话——任务完成、卡点命中时不再只能"通知你、等你回来点一下"。三条实测前提：需 `session-<uuid>` **带前缀**（裸 uuid 报 `session not found`）；provider 只能用 **DSH 侧**的（Codex keyring 的 id 会 `NO_ADAPTER`）；对正在跑的会话发跟进会**打断它当前回合**。⚠️ 实验端点，转正留后续版本。

## 想再换一个引擎：Pi（2026-10-28 起）

**第二引擎不再只能是 Codex。** 设置 → 第二引擎 → 引擎，可切 `Codex` 或 `Pi`，切换即时生效（存 `~/.dsh/second-engine-engine.txt`）。

[Pi](https://pi.dev)（`npm i -g @earendil-works/pi-coding-agent`，v1.4.0，约 22 MB）是另一个本地 coding agent：原生支持 15+ provider（anthropic / openai / deepseek / gemini / zhipu 等），按 `<PROVIDER>_API_KEY` 取凭据。它的好处是**不用再装一个 223MB 的 CLI**，模型直接复用你已有的 key。

| | Codex 引擎 | Pi 引擎 |
|---|---|---|
| 任务下发 / 取消 / 进度 | ✅ | ✅ |
| 多轮复核（`/review`）+ 协作模式三档 | ✅ | ❌ 无复核链路（面板只隐藏**复核卡**；任务下发 / 取消 / 进度全部可用） |
| 浏览器聊天桥 | 8787 附近的 `ctl.sh` | **8788** 自建桥，端口独立 |
| 模型提供方 / MCP | `config.toml` + keyring | `~/.pi/agent/{models.json,settings.json,mcp.json}` |

两个引擎的**面板是同一套**（模型提供方 / 联网搜索与 MCP / 浏览器聊天桥都由后端按引擎分流，前端零改动），所以外观与操作一致，只有「会话清理」各按自己的目录来。

> Pi 的模型清单支持从远端拉取（填 baseUrl + apiKey 后点「获取模型列表」），也支持手填模型名。

**Pi 侧的三件实况**（2026-10-29）：
- **AGENTS.md 双写**：插件启动时把协作协议同时写进 `~/.codex/AGENTS.md` 与 `~/.pi/agent/AGENTS.md`（Pi 那份用 Pi 身份，`"from":"pi"`）。
- **会话落盘 + 独立工作区**：Pi 聊天桥的会话与 CLI 同源落 `~/.pi/agent/sessions/<cwd>/`；桥默认工作区 `~/pi-workspace`（`PI_BRIDGE_CWD` 可覆盖），不与 Codex 的工程目录混用。
- **版本检查分源**：面板/浮球的版本徽标在 Codex 查 GitHub release、Pi 查 npm registry（`@earendil-works/pi-coding-agent`）。

## 随包分发的操作手册：skill 分层（400 行正文 + 4 个按需文件）

插件把"怎么用第二引擎"这套流程写成 skill 随包分发，agent 触发后自动加载，不用临场编。为避免手册本身吃掉上下文，v3.8.0 起做成分层结构：

- **正文 `SKILL.md` 约 400 行**：只留判据、触发条件、命令、陷阱，以及每个按需文件的一行入口。最常用的判据（什么时候该把活交给另一个引擎）排在最前，运维类排最后。
- **`references/` 4 个按需文件**：Pi 运行时现场 / Codex 事实档案 / Codex 升级与破坏性检验 / dual-board 细则。正文里每个都写明「要 X 时读 `references/y.md`」，不常用的细节不进正文。
- **读取闸门表**：正文里逐条标好"什么时候才需要打开哪个文件"，agent 不必每次把全部细节读进上下文。
- **同包还带 `Codex功能表.md`**：版本敏感的开关态与命令面（见下方 Codex 0.166.0）。

## 长什么样

<p align="center">
  <img src="https://github.com/fengyu-12/dsh-second-engine/raw/master/docs/images/float-panel.jpg" width="46%" alt="悬浮球面板">
  <img src="https://github.com/fengyu-12/dsh-second-engine/raw/master/docs/images/settings-panel.jpg" width="46%" alt="设置页">
  <br>
  <sub>左：<b>悬浮球</b> —— 三档协作模式一点即切，底部是 Codex 版本与会话占用两行 kv，有新版才亮徽标。
  <br>右：<b>设置页</b> —— 引擎状态、协作模式、四家模型提供方、联网搜索与 MCP、浏览器聊天桥。</sub>
</p>

<p align="center">
  <img src="https://github.com/fengyu-12/dsh-second-engine/raw/master/docs/images/web-chat.jpg" width="46%" alt="浏览器聊天桥">
  <img src="https://github.com/fengyu-12/dsh-second-engine/raw/master/docs/images/terminal.jpg" width="46%" alt="终端 TUI">
  <br>
  <sub>左：<b>浏览器聊天桥</b> —— 手机浏览器里直接和 Codex 对话，与终端共享同一批会话。
  <br>右：<b>终端 TUI</b> —— 原生 Codex，YOLO mode 全功能。</sub>
</p>

<p align="center">
  <img src="https://github.com/fengyu-12/dsh-second-engine/raw/master/docs/images/settings-model.jpg" width="46%" alt="界面风格与模型思考">
  <br>
  <sub><b>界面风格</b>（Codex 蓝 / Claude 陶土色）· 字号 · 模型与思考等级</sub>
</p>

## 装之前要准备什么

- DeepSeek Harness（新版 App + Web）
- [OpenAI Codex CLI](https://github.com/openai/codex/releases) ≥ 0.155.1

### 安装 Codex CLI（Android proot / aarch64 Linux）

到 [Releases 页](https://github.com/openai/codex/releases) 下载 **aarch64-unknown-linux-musl** 资产（musl 静态二进制在 proot 下可直接运行），解压后放进 PATH：

```bash
curl -LO https://github.com/openai/codex/releases/latest/download/<资产文件名>
tar -xzf <资产文件名> && install -m755 codex /usr/local/bin/codex
codex --version   # 验证
```

> GitHub 直连慢/失败：在下载 URL 前加镜像前缀（如 `https://ghproxy.net/https://github.com/...`）。资产文件名以 Releases 页实际列表为准。

> 备选通道：npmmirror 的 `@openai/codex@<版本>-linux-arm64` 平台包（`vendor/<arch>/bin/` 内含它）。

### 用 GPT 系模型：还要装 `codex-code-mode-host`（必读）

Codex 自 0.144 起把命令执行拆到独立 sidecar。用 `gpt-5.6-*` / `gpt-6-*` / `codex-auto-review` 这类 **`code_mode_only`** 模型时，缺了它模型能正常回话、但**工具一个都执行不了**（报 `failed to spawn code-mode host ... host executable was not found`）；内置目录里只有 `gpt-5.5` 不受影响，降版本也躲不开。

取与 CLI **同版本**的 sidecar，解压后放到 **codex 主二进制同目录**（无需进 PATH）：

```bash
VER=$(codex --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
curl -fL -o /tmp/cmh.tar.gz \
  "https://ghproxy.net/https://github.com/openai/codex/releases/download/rust-v${VER}/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz"
tar -xzf /tmp/cmh.tar.gz -C /tmp
install -m 0755 /tmp/codex-code-mode-host-* \
  "$(dirname "$(readlink -f "$(command -v codex)")")/codex-code-mode-host"
```

> 验收判据：让它「建一个文件并运行」——回复像不像不算数，看文件是否真落盘。回复正确但目录为空＝host 没装上。

## 装上它（两种二选一）

两种方式二选一。**不要跳过依赖安装**：插件用 `link:` 注册时，宿主不会替你装插件自己的依赖；缺依赖的表现是「装完重启，设置页没有第二引擎」，而且没有报错。

### 方式 A：tgz 安装（推荐，无需改配置文件）

1. 下载 Releases 里的 `dsh-second-engine-3.7.0.tgz`；
2. 打开 DSH App 的插件管理页，安装时粘贴 tgz 的 HTTPS 直链，或容器内绝对路径（如 `/root/Downloads/dsh-second-engine-3.7.0.tgz`）；
3. 重启 Web，设置页出现「第二引擎」即成功。

tgz 由 pnpm 解析，`dependencies` 会自动装上，不需要再跑 `npm install`。

### 方式 B：源码安装（需要终端）

```bash
# 1. 解压源码到实体目录（目录与路径随你，下文以 /root/dsha-second-engine 为例）
cd /root/dsha-second-engine
npm install --omit=dev          # ★ 必做：link: 不会替你装依赖，跳过这步插件会静默不加载

# 2. 注册进 profile
cd ~/.dsh/profiles/web
#   package.json: dependencies 加 "dsh-second-engine": "link:/root/dsha-second-engine"
#   dsh.profile.bundles 数组加 "dsh-second-engine"
pnpm install

# 3. 重启 Web，设置页出现「第二引擎」分区即成功
```

### 装好后：收录知识层 skill（强烈建议）

插件包里的 `skills/second-engine/`（`SKILL.md` + `references/` 4 个按需文件 + `Codex功能表.md`）是**给 agent 读的操作手册**——协作策略、施工五要点、诊断清单、异常速查、协作模式全在里面。它**不会自动出现在 DSH 的 skill 目录**，需要手动放一次：

```bash
# ① 找已安装的包目录（tgz / 源码安装位置不同，两处都找一下）
PKG=$(find "$HOME/.dsh/plugin-src" "$HOME/.dsh/profiles" -maxdepth 5 -type d -name dsh-second-engine 2>/dev/null | head -1)
# ② 拷进 DSH 的 skill 目录
mkdir -p "$HOME/.dsh/skills"
cp -r "$PKG/skills/second-engine" "$HOME/.dsh/skills/"
# ③ 校验：应看到 SKILL.md 与 Codex功能表.md
ls "$HOME/.dsh/skills/second-engine/"
```

装好后，你说「用 Codex / 第二引擎 / 第二意见 / 让 Codex 试试」时，agent 会自动加载这套流程，而不是临场即兴发挥。

不装也能用插件（面板、任务、互审都正常），只是 agent 少了这份手册，**协作质量与踩坑规避会明显变差**。

升级插件后 `skills/` 可能更新，**重跑第 ② 步覆盖即可**（`cp -r` 会合并覆盖同名文件）。

## 配好它（四步）

1. 设置 → 第二引擎 → 模型提供方 → 选择预设（DeepSeek / 智谱）或添加自定义；
2. 填入 API Key（保存于 `~/.codex/keyring.json`，0600 权限，界面仅脱敏回显）；
3. 「获取模型列表」→ 下拉选择模型 → 启用；
4. 终端快速启动：`codex-env`（自动注入激活提供方的 Key 并进入 Codex TUI）；只想取浏览器聊天桥网址用 `codex-env -u`。

### 换机器要确认的路径与环境变量

`/root` 本身是 DSHA 容器的固定根，**不用改**。真正要确认的是「你的 Codex 工作区在哪」——
下表是按本机默认值整理的，个别变量你的环境可能不同：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SECOND_ENGINE_WORKDIR` | `/root/proj` | 异步工单的默认工作目录。这是**作者本机的 Codex 工作区**，你的机器上可能没有 ⇒ 设成自己的项目目录，或先 `mkdir -p /root/proj` |
| `DSH_HOME` | `/root/.dsh` | DSH 数据目录，决定 `.bridge_token` 的落点。DSHA 默认就是它，一般无需改 |
| `DSH_BRIDGE_TOKEN_PATH` | `$DSH_HOME/.bridge_token` | 通知令牌文件完整路径，一般不用动 |
| `DSH_WEB_URL` | 宿主注入 | 插件路由基址，**不要写死端口** |
| `SECOND_ENGINE_EXEC_MODE` | `exec` | 工单执行模式（`exec` / `appserver`） |

> 出现「工单卡住 / 找不到目录 / 通知发不出」时，先对照上表看这两个路径是否落在真实存在的目录。

### 界面里能管什么

- **设置面板**（DSH 设置 → 第二引擎）
  - 引擎状态灯：Codex 二进制 / config.toml / API Key（纯本地探测，不上报）
  - **模型提供方管理**：预设 DeepSeek / 智谱（端点均经实测），支持添加任意自定义提供方（Provider ID / 名称 / API 地址 / 协议 / 模型），可编辑、填 Key、切换激活
  - **模型获取与选择**：一键从提供方拉取可用模型列表，下拉切换
  - **模型与思考**：`/api/config` 写 `config.toml` 顶层 `model` / `model_reasoning_effort` / `model_reasoning_summary` / `sandbox_mode` / `approval_policy` / `web_search`（键白名单 + 写前备份 + 原子替换）
  - **插件自身版本提示**：`/api/plugin-version` 读自身 `package.json` 与 GitHub releases 比对（成功缓存 1h / 失败 10min）；**无更新时界面完全不出现**，有更新才在设置卡与浮动球提示，只提示不自动装
  - 会话清理：按保留天数清理 Codex 会话文件
- **浮动球**：会话界面常驻半露小球，点开即达状态摘要与任务入口（指针拖动 + 吸附边缘 + 纵向位置记忆）
- **异步任务**：面板直接下发（后台 `codex exec`），完成经 App 通知提醒，支持取消
- **联网搜索与 MCP**：web_search 开关（live↔disabled）与 MCP 增删直接落 config.toml

### 终端使用（TUI）

| 动作 | 方式 |
|---|---|
| **启动** | 终端页敲 `codex-env`（自动注入激活提供方的 Key → 进入 /root/proj → 拉起 TUI）|
| **退出** | `Ctrl+D` 或输入 `/quit` |
| **取桥网址** | `codex-env -u`（只打印网址、不进 TUI、不注入 Key）；或 `cat <桥目录>/.url`（桥目录＝运行实例目录，默认 `bridge/web/`） |
| **网页聊天桥** | 浏览器打开取到的网址（`127.0.0.1:3095`，自带 token 鉴权，等于密码别外传）；终端 TUI 与网页**共享同一批会话** |
| 换模型 | TUI 内 `/model`（或回设置面板「获取模型列表」选）|
| 看改动 | `/diff`；会话恢复 `codex resume` |
| 中文输入 | App 终端输入法受限时，在 Web 输入框写好复制粘贴进去 |

### 用哪家的模型（端点实测）

| 提供方 | Base URL | 协议 | 说明 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | responses | 直连 |
| 智谱 | `https://open.bigmodel.cn/api/v1` | responses | GLM Coding 端点 |

### 会话落在哪里、会不会撑爆磁盘

| 来源 | 会话记录 |
|---|---|
| 面板/浮动球下发工单 | **默认不落盘**（ephemeral，审计靠 git diff）；勾选「保留会话」才落盘 |
| 终端 TUI / `codex exec`（命令行） | 落盘 `~/.codex/sessions/年/月/日/`（约 33KB/次，可 `codex resume`）|
| 共同 | `~/.codex/*.sqlite` 状态库（官方管理，插件不清理）|

服务层每 6 小时自动兜底清理（保留 7 天 / 总量超 200MB 从最旧删）；面板「会话清理」可手动按天清理。

## 从命令行唤起它（API 入口）

插件路由挂在 **Web 服务**上，地址取环境变量 **`$DSH_WEB_URL`**（DSH 启动时注入，随 Web 端口变化，**不要写死端口**）：

```bash
W="$DSH_WEB_URL"                                            # 例: http://127.0.0.1:<Web端口>

curl -s "$W/second-engine/api/status"                       # 自检: {"ok":true,"codexBinary":true,...}

curl -s -X POST "$W/second-engine/api/task" \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"<自包含工单>","workdir":"/root/proj","ephemeral":true}'   # → {"id":"..."} 立即返回
```

- ⚠️ **不要用 App 设备桥的端口**（`/app/*`：读屏/点按/截屏/通知那套）去拼插件路由：那不是插件路由，未知路径会被当 shell 命令执行，返回
  `{"result":"[NO_CMD]"}` —— 看着像「插件 API 不存在」，实际是敲错门（2026-09-27 实测）。
- **工单是异步的**：`POST /api/task` 拿到 `{id}` 就可以走人，**完成经 App 通知提醒**；等结果用
  `tools/wait-task.sh <id> [轮询间隔=5] [总超时=600]` 放进**后台 job**（完成通知自动唤醒等待者，退出码 `0=done / 2=失败 / 3=不存在 / 4=接口不可用 / 124=超时`），
  **不要自己写 `sleep`+`curl` 轮询**。
- **复核接力**：`POST /api/review` 可带 `"prev":"<上一轮复核id>"`——首轮自动附上一轮未决问题对照。

## 两种执行模式怎么选（2026-09-27 起）

工单支持两种执行模式，**切换不需要重启**：

| 模式 | 机制 | 能力 |
|---|---|---|
| **exec**（默认） | `codex exec` 一次性子进程 + `-o` 文件 | 与旧版完全一致，零风险 |
| **appserver** | `codex app-server` JSON-RPC 长连接 | **流式进度**（`GET /api/task?id=` 的 `progress`，最近 20 条归一化事件）+ **真打断**（`/api/task/cancel` 先发 `turn/interrupt`，65ms 级结束）；输出仍落 `-o` 文件，看门狗判据不变 |

```sh
echo appserver > ~/.dsh/second-engine-mode.txt   # 切 app-server 模式
echo exec      > ~/.dsh/second-engine-mode.txt   # 切回 exec
```

优先级：环境变量 `SECOND_ENGINE_EXEC_MODE` > 上述模式文件 > 默认 `exec`。
验收脚本：`bash /root/.dsh/scripts/dsh/se-appserver-verify.sh`（流式进度 / 打断 / exec 回归三条判据）。

**怎么判断"到底行动了没"**：
- **exec 模式**：`GET /api/task?id=` 看 `liveBytes`（过程流字节数，持续增长即在动）；过程流保留在 `<outPath>.live`（最终结果仍以 `-o` 文件为准）。
- **appserver 模式**：除 `liveBytes` 外还有 `progress` 数组（归一化事件，最近 20 条，可见 reasoning / 文本增量 / 工具调用 / 用量）。
- **模型清单**：`POST /api/models {id}` 对智谱会**并集**两个端点（`/api/v1`（Codex 专用，只列 3 个）+ `/api/coding/paas/v4`（全量）），响应里的 `sources` 字段回显实际来源。实测两端点共用同一把 key，且 `/api/v1/responses` 支持全部 glm 模型（2026-09-28）。

协议依据：`/root/proj/appserver-spike/MAPPING.md`（事件 → 归一化字段映射，源自 app-server 生成的 JSON Schema）。

## 支持能力一览（v3.8.0 · 未发布）

| 能力 | 状态 | 说明 |
|---|---|---|
| **多引擎协作策略 + 无效重试信号检测** | ✅ 3.8.0 | `tools/policy-watch.py` 从会话事件流算三条信号（同一命令+同一错误类连续失败 ≥2 / 同一文件编辑振荡 A→B→A / 连续 4 步无状态推进，跳过等待类调用），退出码 **10 = 命中**；已验正向 3/3 命中、负向 4 类反例不报。配「二分自答」判据决定要不要把活外置给第二引擎 |
| **skill 分层（正文 400 行 + `references/` 4 个按需文件 + 读取闸门表）** | ✅ 3.8.0 | 手册正文只留判据与入口，细节按需要时才读，避免手册本身吃掉上下文 |
| **出板人审门禁 + 审计留痕** | ✅ 3.8.0 | `complete` 须 `--reviewed-by human`（Agent 自报不算），自动化用 `--keep` 免审留在板且**不伪造** human 标记；出板记录落 `audit/completed-<月>.jsonl` |
| **board `steps` 字段** | ✅ 3.8.0 | 长任务拆 ≤20 步（每项 ≤200 字符 / 总长 ≤4000），可中断可续跑，不参与状态机 |
| **board N 角色泛化** | ✅ 3.8.0 | 角色清单进 `board.json.roles`、`inbox-<role>` 动态生成、`dispatch.sh --to ROLE`、`claim --owner` 从 roles 取合法值 |
| **唤醒层（实验端点）** | ⚠️ 3.8.0 | `POST /api/_exp/wake` 用 `session.append` + `agents.resume` 把消息递进指定会话；需 `session-<uuid>` 前缀、provider 只能用 DSH 侧（Codex keyring 的 id 会 `NO_ADAPTER`）；转正留后续版本 |
| **UTF-8 跨 chunk 分帧修复** | ✅ 3.8.0 | app-server 与 Pi 桥改用 `node:string_decoder` 的 `StringDecoder`，中文正文不再在 chunk 边界被切成 U+FFFD |
| **Pi 模型下发前校验** | ✅ 3.8.0 | 请求的 `model` 不在可用集合时返回 400 并列出可选值；探测失败时放行（不因探测抖动拦住正常下发） |
| **协作模式三档**（collab） | ✅ 3.5.0 | 普通复核 / 协作提议 / 长任务配合 + 自定义第四组合。两位各自独立：`voice`（允许它主动提议）/ `longtask`（分阶段任务直接开长会话）；优先级 环境变量 > `~/.dsh/second-engine-collab.txt` > 默认。切 `voice=on` 立即写 `~/.codex/AGENTS.md` 的 voice 段、切回即删（文件 0600）。悬浮球面板与设置页都能切 |
| **双引擎能力契约 + Pi 运行时接入** | ✅ 3.7.0 | 面板按引擎能力渲染，前端零改动 |
| 插件自身版本提示 | ✅ 3.1.2 | `/api/plugin-version` 读自身 `package.json` 与 GitHub releases 比对（成功缓存 1h / 失败 10min）；**无更新时界面完全不出现**，有更新才在设置卡徽标与浮动球红点提示，只提示不自动装 |
| **首 token 看门狗（180s）** | ✅ 3.0.0 | app-server 模式迟迟不回第一个事件时不再无限挂起——超时即判失败并报错，工单不会静默卡死 |
| **终态方法集合** | ✅ 3.0.0 | 过滤迟到的旧 turn 事件，避免上一轮结果覆盖当前工单 |
| **上下文占用率多版本兜底** | ✅ 3.0.0 | `contextUsageRatio` 在多种 app-server 版本上都能算出（取不到时降级，不报错） |
| **会话内切模型** | ✅ 3.0.0 | `thread/settings/update`：不重启即可在会话里换模型 |
| 配置保留段（切提供方不丢） | ✅ v1.2.1 修复 | 重写 `config.toml` 时改用**黑名单**：只排除模板自有的 `[model_providers.*]` 与 `[memories]`，其余段一律原样保留；此前白名单式重写会把 `[features]` / `[tui]` / `[projects.*]` 静默抹掉且不报错 |
| 浮动球交互 | ✅ v1.2 | 指针拖动（鼠标 / 触屏 / 触控笔通用）+ 松手吸附最近左右边缘 + 纵向位置记忆；面板内显示 Codex 版本与新版本提示 |
| scope-check 脏工作区 | ✅ v1.2 修复 | 交活时记 `write_scopes` 的 sha256 快照，交付后比对——「交活前就脏、之后又被改」不再漏报；无 git 时降级为哈希校验 |
| Codex 功能表 | ✅ v1.2 | `skills/second-engine/Codex功能表.md` 随包分发 |
| 提供方切换 / 工单 / 双向互审 | ✅ | DeepSeek / 智谱直连，chat 协议上游经翻译桥自动挂接；切换不丢用户配置（sandbox、MCP） |
| AGENTS.md 联网搜索三档降级 | ✅ v2 | 原生 web_search 优先 → Exa MCP 备胎 → 全无则凭已有知识完成任务并标注「未经联网核实」；v1 用户自动原位升级 |
| tools/t-tool.sh | ✅ 实测 | tmux 交互窗口：屏幕快照、哨兵式等待、`run` 退出码回传、owner 防串台；**依赖 tmux**（`apt install tmux`） |
| tools/wait-task.sh | ✅ 实测 | 工单完成阻塞等待，退出码语义完整；配后台 job 使用，完成通知自动唤醒等待者 |
| Exa MCP（可选外挂） | ⚠️ 限额 | `https://mcp.exa.ai/mcp` 匿名可用但有隐性限额（偶发 rate limit，重试即可）；正式用去 exa.ai 注册免费 key |
| 面板「联网搜索与 MCP」分区 | ✅ v0.3.4 | web_search 开关（live↔disabled）与 MCP 增删直接落 config.toml；八项验收 + 切提供方持久性 + 智谱端到端原生搜索实测通过 |
| 工单审批策略 | ✅ v0.3.4 修复 | `approval_policy="never"` 固定写入 config；此前字段丢失曾致写工作副本外目录的工单无限挂起 |
| 面板交互 | ✅ v1.0 | 分区折叠（右上角「展开/收回」带框文字按钮 + 标题行整行可点）、抽屉限高 78vh 内滚、**工单列表固定最近 5 条**（面板高度恒定，头部 × 不被挤掉）——手机实测确认 |
| **本地翻译桥**（实验性） | ⚠️ 实验性 | `responses → chat completions` 协议转换，让仅有 chat 协议的提供方（部分中转 / 自建网关）也能接入 Codex |

## Codex 升到 0.166.0 之后

Codex 升到 **0.166.0**，命令面新增 `review` / `mcp` / `plugin` / `update` / `migrate-nfs-db` 等子命令。

⚠️ 版本号、feature 开关、逐版实测结论**不写在 README**——这类结论会随版本腐化。要看现值查随包分发的 `skills/second-engine/Codex功能表.md`；升级后的破坏性检验判据见 `references/ref-codex-upgrade.md`。

## 版本记录（择要）

最新版本 **3.7.0** —— 双引擎能力契约 + Pi 运行时接入。完整版本历史见 [docs/CHANGELOG.md](https://github.com/fengyu-12/dsh-second-engine/blob/master/docs/CHANGELOG.md)。

## 有哪些坑要提前知道（已知限制）

- **沙箱**：proot 环境无 Landlock / bubblewrap，Codex 需 `danger-full-access` 运行——安全防线在流程层（工作副本隔离 + diff 审查 + git 仲裁），**不要把主工作区直接交给 Codex**；
- **翻译桥**：实验性；内部以非流式请求上游、以流式事件回放，长任务首包延迟等于整段生成时间；
- **工单记录**：内存态，重启 Web 即清空（复核记录自 2026-10-25 起持久化到 `~/.codex/reviews/`，不受影响）；
- **完成提醒**：经 App 通知提醒用户回 Web 唤起 DSH 侧 agent 验收（DSH 暂无会话主动注入 API；唤醒层是其实验性前置，见上）；
- **唤醒层**：实验端点，需 `session-<uuid>` 前缀与 DSH 侧 provider，对运行中的会话发跟进会打断它当前回合；转正留后续版本；
- **t-tool run 前提**：目标会话须停在 shell 提示符；pane 正跑前台程序时哨兵等不到，表现为 TIMEOUT（会话不损，等程序结束即可）；命令须写单行；
- **t-tool wait 基线语义**：匹配的是全屏（含旧输出），"等命令跑完"一律用 `run`；需要"只匹配新增输出"时传基线行数（第 5 参）；
- **DeepSeek 无联网搜索**：官方 Responses API 不执行 `web_search`（文档明示禁用）——搜索走 Exa 备胎或 DSH 侧 agent 代查；
- **完成通知节流**：App 通知 30 秒节流，连续快速完成的任务可能合并提醒；
- **插件 API 无鉴权**：`/second-engine/api/*` 仅绑定 127.0.0.1（外网不可及），但本机任意 App 均可无认证调用——个人设备低风险，接入外部 agent 前将统一加 token（bridge_token 同款机制）。

## 代码放在哪（架构）

```
dsh-second-engine/
├── skills/second-engine/SKILL.md   # 知识层：agent 的操作流程正文（约 400 行）
├── skills/second-engine/references/ # 知识层按需文件（Pi 现场 / Codex 事实 / 升级 / dual-board）
├── src/index.js                    # 服务层：路由 / 提供方 / 工单 / 桥
├── src/bridge.js                   # 翻译桥：responses ↔ chat
├── lib/client.js                   # 界面层：设置面板 + 浮动球
├── tools/dual-board/               # 看板：board.sh / board_tool.py / dispatch.sh / PROTOCOL.md
└── cordis.patch.yml                # bundle 收录声明
```

## License

MIT

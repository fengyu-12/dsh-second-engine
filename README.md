# dsh-second-engine

> 🚀 **你的 AI 也能拥有自己的 AI**：装一个插件、再装个 223MB 的 Codex CLI，你的 DeepSeek Harness 里就多了一位 7×24 待命的**第二引擎**——主 AI 干累了可以「让 Codex 试试」，写完代码自动互审挑刺，卡住还会主动喊救命。一个手机，两颗大脑，你只管裁决。

| 平台 | 状态 |
|---|---|
| **Android（DSHA）** | ✅ 实测全功能（免 ROOT 免 Termux：[DSHA 下载](https://github.com/qiannianhuanxiang/DSHA) · [项目主页](https://github.com/DSH-APP/DSHA)）|
| **Windows / macOS（DSH 桌面壳）** | ⚠️ 理论兼容未实测（插件为纯 Node；需换装 x86_64 版 Codex 二进制；App 通知能力视宿主而定）。桌面壳参考：[desk-harness](https://github.com/llyyhh0487/desk-harness) / [deepseekharness-desktop](https://github.com/honghuachen/deepseekharness-desktop) |

**占用账单（安卓实测）**：Codex 本体 223MB + 数据 33MB + 插件依赖 0.3MB ≈ **256MB**，换一个独立执行、互审、救场的第二 Agent。

> 把 OpenAI Codex CLI 接入 DeepSeek Harness（DSH），作为与主 AI 并行的**第二引擎**。

在同一台 Android 设备的 DSHA 容器（Ubuntu / proroot）里，主 AI（DSH）与 Codex 双引擎并存：主 AI 编排与审核，Codex 独立复核、并行下探、提供异构第二意见——三者各司其职：**Codex 生产 · 主 AI 编排审核 · 用户裁决**。

## 功能

- **设置面板**（DSH 设置 → 第二引擎）
  - 引擎状态灯：Codex 二进制 / config.toml / API Key（纯本地探测，不上报）
  - **模型提供方管理**：预设 DeepSeek / 智谱（端点均经实测），支持添加任意自定义提供方（Provider ID / 名称 / API 地址 / 协议 / 模型），可编辑、填 Key、切换激活
  - **模型获取与选择**：一键从提供方拉取可用模型列表，下拉切换
  - 会话清理：按保留天数清理 Codex 会话文件
- **浮动球**：会话界面常驻半露小球，点开即达状态摘要与工单入口
- **异步工单**：面板直接下发任务（后台 `codex exec`），完成经 App 通知提醒，支持取消
- **双向互审**：把产出交给 Codex 做多轮批判性复核（轮数上限 / 零新增提前收敛 / 分歧打包上交用户 / 任意时刻熔断），轮数在面板设置
- **卡点求助协议**：插件自动向 `~/.codex/AGENTS.md` 写入协作协议——Codex 连续失败或绕圈时主动调 `/api/consult` 提交卡点并通知，主 AI 带建议接手
- **本地翻译桥**（实验性）：`responses → chat completions` 协议转换，让仅有 chat 协议的提供方（云知声 / 部分中转）也能接入 Codex
- **知识层**：随包分发 SKILL.md，主 AI 自动获得唤起与协作流程（工单下发、diff 审查、异常速查）

## 环境单例 —— 安卓上的 PC 式双引擎

Android 的沙箱模型把环境切碎了：每个 App 各自下载依赖、各部署一遍。本插件逆着这个模型，把 DSHA 容器变成**双引擎共用的环境单例**：

- **Codex 不自带依赖**：工单里跑的每条命令直接使用容器现成的 Python / Node / 工具链 / 词库（55 个沉淀脚本即取即用），插件本体仅 0.3MB——它只是环境的调度器，不是又一轮部署；
- **双引擎互为备份**：主 AI 装插件/写配置出问题时，Codex 有完整 shell 可以接手排查修复；反过来 Codex 卡住走 consult 协议喊救命，主 AI 带建议回来——谁都能救谁。

## 双引擎分工

| 角色 | 职责 |
|---|---|
| Codex（第二引擎） | 生产：exec 小粒度工单、独立复核、并行下探 |
| DSH 主 AI | 编排：拆任务、布置环境、审 diff、落主区 |
| 用户 | 裁决：分歧点上交，最终取舍由人 |

## 协作看板（dual-board，v1.3 · 2026-09-27）

长任务协作走文件看板。**脚本与协议随插件**：`tools/dual-board/`（`board.sh` / `board_tool.py` / `dispatch.sh` / `PROTOCOL.md`，2026-09-30 收编、路径自定位）；**运行数据**默认仍在 `~/proj/dual-board/`，可用 `DUAL_BOARD_DIR` 覆盖（Codex 侧由 `~/proj/AGENTS.md` 自动注入，无需人工提醒）：

- **写板唯一入口 `board.sh`**（v1.2 起）：CAS + O_EXCL 锁 + 原子写 + 状态机 + JSONL 归档 + `doctor` 体检都在工具里，**手改 `board.json` 视为破坏协议**。退出码即语义（3 CAS 冲突 / 4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 降级）。
- **派单一律走 `dispatch.sh`**：自动注入收件箱未读段、附派单纪律、在派单**前**记基线 commit 与工作区脏快照到 `.dispatch/<task id>.base`；交付后用 `board.sh scope-check <id>` 机械校验写范围越界。
- **看板**：`board.json` —— 状态 `pending / in_progress / blocked / completed / abandoned`（**无 reopen**，completed 不可复改）；工单三字段：`task`（用户原话，不可变）/ `context`（主 AI 解读）/ `frame`（质疑前提是分内事，由工具自动写入）。
- **收件箱**：`inbox-codex.md` / `inbox-lead.md` 双向留言（经 `board.sh inbox-append`），已读标注 + 按月 JSONL 转档（`archive/`）；交付必含四段：交付 / **异议位** / 下一步建议 / 自验。
- **双通道**：短任务走 `/api/task`（ephemeral 零记忆，保互审独立性）；长任务 `codex exec resume <thread_id>` 成员会话（一条链绑一个任务，看板 `session` 字段登记，收工归档）。
- **可视化**：浏览器聊天桥（3095）的会话列表抽屉 = 成员会话切换，终端/网页/主 AI 三方同链。
- ⚠️ **已知限制**：脏工作区下 scope 校验会漏报（协议 §十一）；给 Codex 的 workdir 尽量干净。

## 前置要求

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

## 安装

```bash
# 1. 放置插件实体
cp -a dsh-second-engine <插件目录>
cd <插件目录> && npm install --omit=dev

# 2. 注册进 profile（link: 方式，指向插件实体目录）
cd ~/.dsh/profiles/web
#   package.json: dependencies 加 "dsh-second-engine": "link:<插件目录>"
#   dsh.profile.bundles 数组加 "dsh-second-engine"
pnpm install

# 3. 重启 Web，设置页出现「第二引擎」分区即成功
```

## 配置

1. 设置 → 第二引擎 → 模型提供方 → 选择预设（DeepSeek / 智谱）或添加自定义；
2. 填入 API Key（保存于 `~/.codex/keyring.json`，0600 权限，界面仅脱敏回显）；
3. 「获取模型列表」→ 下拉选择模型 → 启用；
4. 终端快速启动：`codex-env`（自动注入激活提供方的 Key 并进入 Codex TUI）；只想取浏览器聊天桥网址用 `codex-env -u`。

### 终端使用（TUI）

| 动作 | 方式 |
|---|---|
| **启动** | 终端页敲 `codex-env`（自动注入激活提供方的 Key → 进入 ~/proj → 拉起 TUI）|
| **退出** | `Ctrl+D` 或输入 `/quit` |
| **取桥网址** | `codex-env -u`（只打印网址、不进 TUI、不注入 Key）；或 `cat <桥目录>/.url`（桥目录＝运行实例目录，默认 `bridge/web/`） |
| **网页聊天桥** | 浏览器打开取到的网址（`127.0.0.1:3095`，自带 token 鉴权，等于密码别外传）；终端 TUI 与网页**共享同一批会话** |
| 换模型 | TUI 内 `/model`（或回设置面板「获取模型列表」选）|
| 看改动 | `/diff`；会话恢复 `codex resume` |
| 中文输入 | App 终端输入法受限时，在 Web 输入框写好复制粘贴进去 |

### 预设提供方（端点实测）

| 提供方 | Base URL | 协议 | 说明 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | responses | 直连 |
| 智谱 | `https://open.bigmodel.cn/api/v1` | responses | GLM Coding 端点 |
| 云知声 | `https://maas-api.unisound.com/v1` | chat（经本地桥） | 多模型聚合 MaaS |

### 会话与磁盘（谁落盘，落哪里）

| 来源 | 会话记录 |
|---|---|
| 面板/浮动球下发工单 | **默认不落盘**（ephemeral，审计靠 git diff）；勾选「保留会话」才落盘 |
| 终端 TUI / `codex exec`（命令行） | 落盘 `~/.codex/sessions/年/月/日/`（约 33KB/次，可 `codex resume`）|
| 共同 | `~/.codex/*.sqlite` 状态库（官方管理，插件不清理）|

服务层每 6 小时自动兜底清理（保留 7 天 / 总量超 200MB 从最旧删）；面板「会话清理」可手动按天清理。

## API 入口（唤起 Codex 的正确地址）

插件路由挂在 **Web 服务**上，地址取环境变量 **`$DSH_WEB_URL`**（DSH 启动时注入，随 Web 端口变化，**不要写死端口**）：

```bash
W="$DSH_WEB_URL"                                            # 例: http://127.0.0.1:<Web端口>

curl -s "$W/second-engine/api/status"                       # 自检: {"ok":true,"codexBinary":true,...}

curl -s -X POST "$W/second-engine/api/task" \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"<自包含工单>","workdir":"~/proj","ephemeral":true}'   # → {"id":"..."} 立即返回
```

- ⚠️ **不要用 App 设备桥的端口**（`/app/*`：读屏/点按/截屏/通知那套）去拼插件路由：那不是插件路由，未知路径会被当 shell 命令执行，返回
  `{"result":"[NO_CMD]"}` —— 看着像「插件 API 不存在」，实际是敲错门（2026-09-27 实测）。
- **工单是异步的**：`POST /api/task` 拿到 `{id}` 就可以走人，**完成经 App 通知提醒**；等结果用
  `tools/wait-task.sh <id> [轮询间隔=5] [总超时=600]` 放进**后台 job**（完成通知自动唤醒等待者，退出码 `0=done / 2=失败 / 3=不存在 / 4=接口不可用 / 124=超时`），
  **不要自己写 `sleep`+`curl` 轮询**。

## 支持能力一览（v1.1.0）

| 能力 | 状态 | 说明 |
|---|---|---|
| 提供方切换 / 工单 / 双向互审 | ✅ | DeepSeek / 智谱直连，云知声经翻译桥；切换不丢用户配置（sandbox、MCP） |
| AGENTS.md 联网搜索三档降级 | ✅ v2 | 原生 web_search 优先 → Exa MCP 备胎 → 全无则凭已有知识完成任务并标注「未经联网核实」；v1 用户自动原位升级 |
| tools/t-tool.sh | ✅ 实测 | tmux 交互窗口：屏幕快照、哨兵式等待、`run` 退出码回传、owner 防串台；**依赖 tmux**（`apt install tmux`） |
| tools/wait-task.sh | ✅ 实测 | 工单完成阻塞等待，退出码语义完整；配后台 job 使用，完成通知自动唤醒等待者 |
| Exa MCP（可选外挂） | ⚠️ 限额 | `https://mcp.exa.ai/mcp` 匿名可用但有隐性限额（偶发 rate limit，重试即可）；正式用去 exa.ai 注册免费 key |
| 面板「联网搜索与 MCP」分区 | ✅ v0.3.4 | web_search 开关（live↔disabled）与 MCP 增删直接落 config.toml；八项验收 + 切提供方持久性 + 智谱端到端原生搜索实测通过 |
| 工单审批策略 | ✅ v0.3.4 修复 | `approval_policy="never"` 固定写入 config；此前字段丢失曾致写工作副本外目录的工单无限挂起 |
| 面板交互 | ✅ v1.0 | 分区折叠（右上角「展开/收回」带框文字按钮 + 标题行整行可点）、抽屉限高 78vh 内滚、**工单列表固定最近 5 条**（面板高度恒定，头部 × 不被挤掉）——手机实测确认 |

## 已知限制

- **沙箱**：proot 环境无 Landlock / bubblewrap，Codex 需 `danger-full-access` 运行——安全防线在流程层（工作副本隔离 + diff 审查 + git 仲裁），**不要把主工作区直接交给 Codex**；
- **翻译桥**：实验性；内部以非流式请求上游、以流式事件回放，长任务首包延迟等于整段生成时间；
- **工单记录**：内存态，重启 Web 即清空；
- **完成提醒**：经 App 通知提醒用户回 Web 唤起主 AI 验收（DSH 暂无会话主动注入 API）；
- **t-tool run 前提**：目标会话须停在 shell 提示符；pane 正跑前台程序时哨兵等不到，表现为 TIMEOUT（会话不损，等程序结束即可）；命令须写单行；
- **t-tool wait 基线语义**：匹配的是全屏（含旧输出），"等命令跑完"一律用 `run`；需要"只匹配新增输出"时传基线行数（第 5 参）；
- **DeepSeek 无联网搜索**：官方 Responses API 不执行 `web_search`（文档明示禁用）——搜索走 Exa 备胎或主 AI 代查；
- **完成通知节流**：App 通知 30 秒节流，连续快速完成的任务可能合并提醒；
- **插件 API 无鉴权**：`/second-engine/api/*` 仅绑定 127.0.0.1（外网不可及），但本机任意 App 均可无认证调用——个人设备低风险，接入外部 agent 前将统一加 token（bridge_token 同款机制）。

## 执行模式（2026-09-27 起）

工单与复核支持两种执行模式，**切换不需要重启**：

| 模式 | 机制 | 能力 |
|---|---|---|
| **exec**（默认） | `codex exec` 一次性子进程 + `-o` 文件 | 与旧版完全一致，零风险 |
| **appserver** | `codex app-server` JSON-RPC 长连接 | **流式进度**（`GET /api/task?id=` 的 `progress`，最近 20 条归一化事件）+ **真打断**（`/api/task/cancel` 先发 `turn/interrupt`，65ms 级结束）；输出仍落 `-o` 文件，看门狗判据不变 |

```sh
echo appserver > ~/.dsh/second-engine-mode.txt   # 切 app-server 模式
echo exec      > ~/.dsh/second-engine-mode.txt   # 切回 exec
```

优先级：环境变量 `SECOND_ENGINE_EXEC_MODE` > 上述模式文件 > 默认 `exec`。
验收脚本：`bash $DSH_HOME/scripts/dsh/se-appserver-verify.sh`（流式进度 / 打断 / exec 回归三条判据）。

**实时可见性（怎么判断"到底行动了没"）**：
- **模型清单**：`POST /api/models {id}` 对智谱会**并集**两个端点（`/api/v1`（Codex 专用，只列 3 个）+ `/api/coding/paas/v4`（全量）），响应里的 `sources` 字段回显实际来源。实测两端点共用同一把 key，且 `/api/v1/responses` 支持全部 glm 模型（2026-09-28）。
- **exec 模式**：`GET /api/task?id=` 看 `liveBytes`（过程流字节数，持续增长即在动）；过程流保留在 `<outPath>.live`（最终结果仍以 `-o` 文件为准）。
- **appserver 模式**：除 `liveBytes` 外还有 `progress` 数组（归一化事件，最近 20 条，可见 reasoning / 文本增量 / 工具调用 / 用量）。
协议依据：`~/proj/appserver-spike/MAPPING.md`（事件 → 归一化字段映射，源自 app-server 生成的 JSON Schema）。

## 架构

```
dsh-second-engine/
├── skills/second-engine/SKILL.md   # 知识层：主 AI 的操作流程
├── src/index.js                    # 服务层：路由 / 提供方 / 工单 / 桥
├── src/bridge.js                   # 翻译桥：responses ↔ chat
├── lib/client.js                   # 界面层：设置面板 + 浮动球
└── cordis.patch.yml                # bundle 收录声明
```

## License

MIT

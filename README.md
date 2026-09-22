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

Android 的沙箱模型把环境切碎了：Termux 一套、Operit 一套，每个 App 各自下载依赖各部署一遍。本插件逆着这个模型，把 DSHA 容器变成**所有 agent 共用的环境单例**：

- **Codex 不自带依赖**：工单里跑的每条命令直接使用容器现成的 Python / Node / 工具链 / 词库（55 个沉淀脚本即取即用），插件本体仅 0.3MB——它只是环境的调度器，不是又一轮部署；
- **双引擎互为备份**：主 AI 装插件/写配置出问题时，Codex 有完整 shell 可以接手排查修复；反过来 Codex 卡住走 consult 协议喊救命，主 AI 带建议回来——谁都能救谁；
- **再来第三个 agent 依旧零部署**：接入即用，环境只有一份。

## 双引擎分工

| 角色 | 职责 |
|---|---|
| Codex（第二引擎） | 生产：exec 小粒度工单、独立复核、并行下探 |
| DSH 主 AI | 编排：拆任务、布置环境、审 diff、落主区 |
| 用户 | 裁决：分歧点上交，最终取舍由人 |

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
cp -a dsh-second-engine /root/dsha-second-engine
cd /root/dsha-second-engine && npm install --omit=dev

# 2. 注册进 profile（link: 方式，须指向 /root/dsha-* 实体）
cd ~/.dsh/profiles/web
#   package.json: dependencies 加 "dsh-second-engine": "link:/root/dsha-second-engine"
#   dsh.profile.bundles 数组加 "dsh-second-engine"
pnpm install

# 3. 重启 Web，设置页出现「第二引擎」分区即成功
```

## 配置

1. 设置 → 第二引擎 → 模型提供方 → 选择预设（DeepSeek / 智谱）或添加自定义；
2. 填入 API Key（保存于 `~/.codex/keyring.json`，0600 权限，界面仅脱敏回显）；
3. 「获取模型列表」→ 下拉选择模型 → 启用；
4. 终端快速启动：`codex-env`（自动注入激活提供方的 Key 并进入 Codex TUI）。

### 终端使用（TUI）

| 动作 | 方式 |
|---|---|
| **启动** | 终端页敲 `codex-env`（自动注入激活提供方的 Key → 进入 /root/proj → 拉起 TUI）|
| **退出** | `Ctrl+D` 或输入 `/quit` |
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

## 支持能力一览（v1.0.0）

| 能力 | 状态 | 说明 |
|---|---|---|
| 提供方切换 / 工单 / 双向互审 | ✅ | DeepSeek / 智谱直连，云知声经翻译桥；切换不丢用户配置（sandbox、MCP） |
| AGENTS.md 联网搜索三档降级 | ✅ v2 | 原生 web_search 优先 → Exa MCP 备胎 → 全无则凭已有知识完成任务并标注「未经联网核实」；v1 用户自动原位升级 |
| tools/t-tool.sh | ✅ 实测 | tmux 交互窗口：屏幕快照、哨兵式等待、`run` 退出码回传、owner 防串台；**依赖 tmux**（`apt install tmux`） |
| tools/wait-task.sh | ✅ 实测 | 工单完成阻塞等待，退出码语义完整；配后台 job 使用，完成通知自动唤醒等待者 |
| Exa MCP（可选外挂） | ⚠️ 限额 | `https://mcp.exa.ai/mcp` 匿名可用但有隐性限额（偶发 rate limit，重试即可）；正式用去 exa.ai 注册免费 key |
| 面板「联网搜索与 MCP」分区 | ✅ v0.3.4 | web_search 开关（live↔disabled）与 MCP 增删直接落 config.toml；八项验收 + 切提供方持久性 + 智谱端到端原生搜索实测通过 |
| 工单审批策略 | ✅ v0.3.4 修复 | `approval_policy="never"` 固定写入 config；此前字段丢失曾致写工作副本外目录的工单无限挂起 |
| 面板交互 | ✅ v1.0 | 分区折叠（右上角「展开/收回」带框文字按钮 + 标题行整行可点）、抽屉限高 78vh 内滚、× 永远可达——手机实测手感确认 |

## 已知限制

- **沙箱**：proot 环境无 Landlock / bubblewrap，Codex 需 `danger-full-access` 运行——安全防线在流程层（工作副本隔离 + diff 审查 + git 仲裁），**不要把主工作区直接交给 Codex**；
- **翻译桥**：实验性；内部以非流式请求上游、以流式事件回放，长任务首包延迟等于整段生成时间；
- **工单记录**：内存态，重启 Web 即清空；
- **完成提醒**：经 App 通知提醒用户回 Web 唤起主 AI 验收（DSH 暂无会话主动注入 API）；
- **t-tool run 前提**：目标会话须停在 shell 提示符；pane 正跑前台程序时哨兵等不到，表现为 TIMEOUT（会话不损，等程序结束即可）；命令须写单行；
- **t-tool wait 基线语义**：匹配的是全屏（含旧输出），"等命令跑完"一律用 `run`；需要"只匹配新增输出"时传基线行数（第 5 参）；
- **DeepSeek 无联网搜索**：官方 Responses API 不执行 `web_search`（文档明示禁用）——搜索走 Exa 备胎或主 AI 代查；
- **完成通知节流**：App 通知 30 秒节流，连续快速完成的任务可能合并提醒。

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

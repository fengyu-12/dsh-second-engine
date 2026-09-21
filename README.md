# dsh-second-engine

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

## 已知限制

- **沙箱**：proot 环境无 Landlock / bubblewrap，Codex 需 `danger-full-access` 运行——安全防线在流程层（工作副本隔离 + diff 审查 + git 仲裁），**不要把主工作区直接交给 Codex**；
- **翻译桥**：实验性；内部以非流式请求上游、以流式事件回放，长任务首包延迟等于整段生成时间；
- **工单记录**：内存态，重启 Web 即清空；
- **完成提醒**：经 App 通知提醒用户回 Web 唤起主 AI 验收（DSH 暂无会话主动注入 API）。

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

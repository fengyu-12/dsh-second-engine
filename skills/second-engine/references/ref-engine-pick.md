# ref-engine-pick：Pi vs Codex vs Claude Code 选型矩阵

> 2026-11-03 从 SKILL.md 外置。正文留一句话结论，细节读本文件。

## 2.3 选哪个引擎：Pi vs Codex（按能力，不按偏好）

判据按**你要什么能力**，不按哪个"更好"：

| 你要的 | 选 | 依据（不是偏好） |
|---|---|---|
| **前端 / UI / 设计**（要「好看、懂意图」） | **Claude** | 社区实测：同一前端任务只有 Claude 懂设计细节；本机已装 `frontend-design` |
| **后端 / 并发 / 资源生命周期** | **Codex** | Codex 强项；本机已装 `superpowers`（planning/TDD/debugging 方法论） |
| **多轮批判复核**（`/review`、协作提议） | **Codex** | Pi 无复核链路，面板会隐藏该卡（点了必失败） |
| **流式进度 + 真打断**（长任务看过程、要能取消） | **Codex** | app-server 模式；Pi 走 exec，取消只能靠 SIGTERM |
| **`web_search`** | **Codex** | Pi 内置工具无联网（read/bash/edit/grep/find/ls），联网得自己配 MCP |
| **多 provider 并存、随时切** | **Pi** | `models.json` 可存多个 provider 各自模型，切换只改 `defaultProvider/defaultModel` |
| **可编程 loop / 远程异步（SDK / RPC / JSON）** | **Pi** | print/JSON/RPC/SDK 四模式，远程异步设计走得最远（2026-11 社区评估） |
| **包生态 / 扩展** | **Pi** | 5400+ npm 包：extensions / skills / prompt 模板 / 主题（pi.dev/packages） |
| **省体积** | **Pi** | CLI 体积显著更小（具体数字随版本变，以实测为准）|
| 只要一个**独立第二意见** | 都行 | 用当前 active 的，别为选型来回切 |

一句话：**Claude 建、Codex 审；要"几个厂商的模型并存、随时横向比"走 Pi。**

⚠️ **别把"能换模型"当成 Pi 的卖点** —— **Codex 同样能换**（改 `config.toml` 的 `model_provider` + `model`）。真实差别是：Codex 一次一个 active provider，Pi 可并存多个。

> 判据：**引擎能力看 CLI/配置文件，不看 Web 控件列几个**。别再按「下拉只显示当前值」的旧现象推断引擎能力（该 UI 缺陷 2026-10-30 已修，细节见 `~/.dsh/skills/second-engine/references/ref-pi-runtime.md`）。

两条容易踩的：
- 切换即时生效（`~/.dsh/second-engine-engine.txt`），但**会话不迁移** —— 已开的工单留在原引擎，切完看不到旧单。
- Pi 下复核/工单/版本这类卡片会被隐藏，**不是故障**（面板按引擎渲染）。

## 已装插件（2026-11-17）

- **Codex：`superpowers@openai-api-curated`**（obra/Jesse Vincent 的完整开发方法论：先 spec、分块评审、实现计划、红绿 TDD、YAGNI/DRY、debugging）——影响它「不问就写代码」的习惯。
- **Claude：`frontend-design@claude-plugins-official` 1.1.1**（生产级前端界面、高设计质量）。
- 回滚：`codex plugin remove superpowers` / `claude plugin uninstall frontend-design@claude-plugins-official`。


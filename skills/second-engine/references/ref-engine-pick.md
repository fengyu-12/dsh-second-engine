# ref-engine-pick：Pi vs Codex 选型矩阵

> 2026-11-03 从 SKILL.md 外置。正文留一句话结论，细节读本文件。

## 2.3 选哪个引擎：Pi vs Codex（按能力，不按偏好）

判据按**你要什么能力**，不按哪个"更好"：

| 你要的 | 选 | 依据（不是偏好） |
|---|---|---|
| **多轮批判复核**（`/review`、协作提议） | **Codex** | Pi 无复核链路，面板会隐藏该卡（点了必失败） |
| **流式进度 + 真打断**（长任务看过程、要能取消） | **Codex** | app-server 模式；Pi 走 exec，取消只能靠 SIGTERM |
| **`web_search`** | **Codex** | Pi 内置工具无联网（read/bash/edit/grep/find/ls），联网得自己配 MCP |
| **多 provider 并存、随时切** | **Pi** | `models.json` 可存多个 provider 各自模型，切换只改 `defaultProvider/defaultModel` |
| **省体积** | **Pi** | CLI 体积显著更小（具体数字随版本变，以实测为准）|
| 只要一个**独立第二意见** | 都行 | 用当前 active 的，别为选型来回切 |

一句话：**要"审"走 Codex；要"几个厂商的模型并存、随时横向比"走 Pi。**

⚠️ **别把"能换模型"当成 Pi 的卖点** —— **Codex 同样能换**（改 `config.toml` 的 `model_provider` + `model`）。真实差别是：Codex 一次一个 active provider，Pi 可并存多个。

> 判据：**引擎能力看 CLI/配置文件，不看 Web 控件列几个**。别再按「下拉只显示当前值」的旧现象推断引擎能力（该 UI 缺陷 2026-10-30 已修，细节见 `<DSH 技能目录>/skills/second-engine/references/ref-pi-runtime.md`）。

两条容易踩的：
- 切换即时生效（`~/.dsh/second-engine-engine.txt`），但**会话不迁移** —— 已开的工单留在原引擎，切完看不到旧单。
- Pi 下复核/工单/版本这类卡片会被隐藏，**不是故障**（面板按引擎渲染）。


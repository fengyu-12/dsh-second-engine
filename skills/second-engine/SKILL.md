---
name: second-engine
description: 唤起与操作第二引擎 Codex 的完整流程：提供方与模型管理、工单下发（API 优先）、双向互审、卡点求助响应、结果验收、会话磁盘管理。当任务需要异构第二意见、并行下探子任务、独立复核、或用户说「用 Codex / 第二引擎 / 第二意见 / 让 Codex 试试」时使用。
---

# second-engine · Codex 第二引擎操作流程

## 引擎现状（2026-09-21 发布版实测）
- 二进制 `/usr/local/bin/codex`（0.155.1，musl 静态）；沙箱 `danger-full-access`（proot 无 Landlock/bwrap）→ **防线靠流程：工作副本隔离 + diff 审查 + git 仲裁**
- 提供方与 key 由插件统一管理：`~/.codex/keyring.json`（0600，**不要手改**），激活提供方切换时自动重写 `~/.codex/config.toml`（**不要手改**，sandbox_mode 已自动保留）
- 预设三家均实测直连：DeepSeek（responses）/ 智谱（responses，Coding 端点）/ 云知声（chat，经本地翻译桥自动挂接）

## API 优先（本插件服务层，Web 与主 AI 共用）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/second-engine/api/status` | GET | 引擎三态 + 会话占用 + key 状态 |
| `/second-engine/api/providers` | GET | 提供方列表（key 脱敏）+ active |
| `/second-engine/api/providers` | POST | 添加自定义提供方 {id,name,baseUrl,wireApi:'responses',model} |
| `/second-engine/api/providers/key` | POST | 填 key {id, apiKey} |
| `/second-engine/api/providers/active` | POST | 切换激活（自动重写 config.toml + 按需起翻译桥） |
| `/second-engine/api/providers/update` | POST | 编辑（apiKey 省略=不改） |
| `/second-engine/api/providers/delete` | POST | 删除（deepseek/zhipu 受保护，其余可删） |
| `/second-engine/api/models` | POST | 拉取模型列表 {id}（OpenAI / Z.ai 双格式解析） |
| `/second-engine/api/model` | POST | 设定模型 {id, model}（active 自动同步 config） |
| `/second-engine/api/config` | GET/POST | 复核轮数等配置（reviewRounds: 1/3/5） |
| `/second-engine/api/task` | POST | **下发工单** {prompt, workdir?, ephemeral?=true} → {id} 立即返回 |
| `/second-engine/api/task?id=` | GET | 任务全量（status/output/exitCode） |
| `/second-engine/api/tasks` | GET | 最近 10 条摘要 |
| `/second-engine/api/task/cancel` | POST | 熔断 {id}（SIGTERM） |
| `/second-engine/api/review` | POST | **双向互审** {content, rounds?} → 多轮批判复核 |
| `/second-engine/api/review/cancel` | POST | 互审熔断 {id} |
| `/second-engine/api/consults` | GET | Codex 卡点求助列表（AGENTS.md 协议自动提交） |
| `/second-engine/api/version` | GET | 本地版本 vs GitHub 最新（有新版提醒，只提示不自动装） |
| `/second-engine/api/cleanup` | POST | 会话清理 {keepDays}（另有 6h 自动兜底 7天/200MB） |

## 标准流程

1. **下发**：`POST /api/task`，工单写自包含、小粒度（Codex 零记忆）；工作副本目录默认 `/root/proj`（**绝不进主工作区**）；默认 `--ephemeral` 不落盘（审计靠 git diff）。
2. **验收**：`GET /api/task?id=` 读 output + 工作目录 `git diff` 审查 → apply / 打回（新工单指出问题）/ 升级用户裁决。
3. **互审**：把主 AI 产出（结论/方案/diff）`POST /api/review`，Codex 批判复核（上限内自动多轮，零新增即收敛，分歧打包上交用户）；面板可熔断。
4. **求助响应**：`GET /api/consults` 看 Codex 卡点（手机通知会提示）→ 针对性下一条工单解围。

## 命令行降级（无插件环境 / 需要交互时）

```bash
codex-env          # 插件提供：自动注入激活提供方 key → 进 TUI（退出 Ctrl+D 或 /quit）
# 或手动：export <PROVIDER>_API_KEY=... && cd /root/proj && codex exec --skip-git-repo-check -o /tmp/out.txt "工单"
```
- 长线程需 resume 时不加 `--ephemeral`；结构化收结果用 `-o <文件>` 或 `--json`。

## 协作边界（与 Codex 自述一致）

- Codex = 生产者；DSH 主 AI = 编排者 + 审核者；用户 = 裁决者。
- 三个价值按权重：**独立复核**（抓自洽却错的推理）> 视角互补（备选方案）> 并行下探（不重叠子任务外包）。
- 它不做最终决策，产出是「可验证的第二个信号」；停滞/绕圈时走 consult 求助，不硬试。

## 异常速查

| 症状 | 处置 |
|---|---|
| `Missing <X>_API_KEY` | 激活提供方换了但 env 没跟上：用 `codex-env` 或手动 export 对应变量 |
| 任务「运行中」长期无输出 | 看门狗会标 stuckSuspect；直接取消重发（曾因 stdin EOF 假死，已修复） |
| `wire_api` 报错 | config 被手改（应 responses）→ 面板重新「启用」即由生成器重写 |
| bwrap/sandbox 报错 | 沙箱模式被改回 → 同上，切 active 重写 config |
| 工具全灭 approval never | 同上 |

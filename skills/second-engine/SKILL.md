---
name: second-engine
description: 唤起与操作第二引擎 Codex 的流程：工单下发、结果验收、缓存与磁盘管理。当任务需要异构第二意见、并行下探子任务、或用户要求「用 Codex」时使用。
---

# second-engine · Codex 第二引擎操作流程

## 引擎现状（2026-09-21 施工实测）
- 二进制 `/usr/local/bin/codex`（codex-cli 0.155.1，musl 静态，proroot 下路径翻译已双探针验证）
- provider = DeepSeek 官方（**Responses 协议直连**，`wire_api="responses"`），key 在 `~/.codex/keyring.json`（0600，经插件面板 `/second-engine/api/key` 配置）或环境变量 `DEEPSEEK_API_KEY`
- 沙箱 = `danger-full-access`（Landlock/bwrap 在本机均不可用）→ **一切防线靠流程，不靠沙箱**：Codex 只进工作副本、产出以 diff 交卷、主 AI 审查后才进主区

## 唤起流程（每次）
1. **环境自检**：`codex --version` 正常；key 已配置（面板或 keyring）。
2. **布置**：`cd` 到工作副本目录（**绝不进主工作区**）；把工单写成自包含、小粒度的任务描述（Codex 零记忆，不共享上下文）。
3. **下发**：
   ```bash
   export DEEPSEEK_API_KEY=$(tr -d '[:space:]' < ~/.codex/keyring.json 的 key 字段)
   codex exec [--ephemeral] --skip-git-repo-check -o /tmp/se_last.txt "工单"
   ```
   - 临时工单加 `--ephemeral`（不落盘 rollout）；需 `resume` 的长线程不加；
   - 结构化收结果：`--json`（JSONL 事件流）或 `-o <文件>`（末消息）；
4. **验收**：读 `-o` 输出 + `git diff` 审查产出 → 决定 apply / 打回 / 升级给用户裁决。
5. **异常速查**：报 `wire_api` 错 = config 被改（应为 responses）；报 bwrap/sandbox = 沙箱模式被改回（应为 danger-full-access）；工具全灭报 approval never = 同上。

## 协作边界（与 Codex 自述一致）
- Codex = 生产者；DSH 主 AI = 编排者 + 审核者；用户 = 裁决者。
- 三个价值：独立复核（抓自洽却错的推理）/ 并行下探（不重叠子任务外包）/ 视角互补（备选方案）。
- 它不做最终决策，产出是「可验证的第二个信号」。

## 会话与磁盘
- rollout 落点 `~/.codex/sessions/年/月/日/*.jsonl`（约 33KB/小任务）；状态库 `~/.codex/*.sqlite` 不动。
- 清理走插件面板或 `POST /second-engine/api/cleanup {keepDays:7}`（200MB 兜底）。
- 缓存注意：system prompt 段前缀稳定可命中 DeepSeek 前缀缓存；工单内勿放随机/时间戳前缀，否则缓存全断。

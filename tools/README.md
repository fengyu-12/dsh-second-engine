# Codex 工具集

给第二引擎 Codex（或任何有 shell 的 agent）用的两个轻量工具，复制到工作目录（如 /root/proj）即可，`chmod +x` 后直接 bash 调用。

## t-tool.sh — tmux 交互窗口工具（依赖 tmux）

解决 agent「看不见交互式程序内部」的问题：长驻 PTY 会话 + 结构化屏幕快照 + 哨兵式等待 + 退出码回传。

```bash
t-tool.sh new  <会话名> [命令]     # 新建长驻会话(200x50)
t-tool.sh type <会话名> <文本>     # 注入字面文本+回车
t-tool.sh key  <会话名> <按键名>   # 注入按键(C-c/Enter/Tab...)
t-tool.sh run  <会话名> <命令>     # 哨兵式执行: 阻塞到跑完, 回传 EXIT=退出码+命令输出; 会话不会因 exit 被杀
t-tool.sh snap <会话名> [末N行|-full] # 屏幕快照(渲染后可读文本)
t-tool.sh wait <会话名> <正则> [超时秒] [基线行]  # 屏幕出现匹配即 MATCH
t-tool.sh ls / gc [分钟] / kill <会话名>
```

防串台：只操作本工具创建的会话（@owner 标记），他人会话一律拒绝。注意事项：run 的目标会话须停在 shell 提示符；命令写单行。

## wait-task.sh — 阻塞等待 second-engine 工单完成

```bash
wait-task.sh <工单id> [轮询间隔秒=5] [总超时秒=600]
```

退出码语义：0=done 2=失败终态 3=任务不存在 4=接口不可用 124=超时。配后台 job 使用：工单完成时 harness 的完成通知会自动唤醒等待者，本脚本同时是超时与故障的兜底。

## policy-watch.py — 算「该派单了」的机械信号

```bash
policy-watch.py [--session <id>] [--root <会话根>] [--json] [--steps N]
```

读 DSH 会话事件流 `~/.dsh/sessions/<cwd编码>/<session>/session.v4.jsonl.zstd`，算三条判据：
同一命令 + 同一错误类连续失败 ≥2 · 同一文件编辑振荡 A→B→A · 连续 N 步无状态推进（默认 4，自动跳过 `job_output` 等等待类）。
退出码 0 = 未命中，10 = 命中。配套 skill `second-engine` 的「编排的定义与触发 · 兜底」节。

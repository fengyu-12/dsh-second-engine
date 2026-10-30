#!/usr/bin/env bash
# post-change.sh —— 改完插件后一条命令跑完所有「能机械验的」（2026-10-30 立）
#
# 为什么有它：改完要跑两条检查（代码三处 + skill 三处），分两次跑必然漏一个。
# 2026-10-30 实测：改完 skill 只跑了 smoke、没跑 sync --check，结果三处 hash 全不同
# （396 / 384 / 361 行），是用户提醒才补上。
#
# 用法: bash tools/post-change.sh
# 退出码: 0 机械项全过 / 1 有失败
#
# ⚠️ 开发件，不进发布包（与 smoke.sh 同）。README / 版本号 / 相关 skill / 记录属
#    判断项，本脚本查不到 —— 改完仍要过 dsh-plugin-discipline「六·补」那张表。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SYNC="$HOME/.dsh/scripts/dsh/sync-second-engine-docs.sh"
RC=0

printf '\n===== 1/2 代码三处 + 全量 smoke =====\n'
if bash "$HERE/smoke.sh"; then printf '\n✅ smoke 全绿\n'; else printf '\n❌ smoke 有失败\n'; RC=1; fi

printf '\n===== 2/2 skill 三处（母本 / 插件实体 / 发布树）=====\n'
out=$(bash "$SYNC" --check 2>&1); src=$?
printf '%s\n' "$out"
h_src=$(printf '%s\n' "$out" | grep -F "$HOME/.dsh/skills/second-engine/SKILL.md" | awk '{print $1}')
h_ent=$(printf '%s\n' "$out" | grep -F "dsha-second-engine/skills/second-engine/SKILL.md" | awk '{print $1}')
if [ "$src" -eq 0 ] && [ -n "$h_src" ] && [ "$h_src" = "$h_ent" ] && printf '%s' "$out" | grep -q '命中: 0'; then
  printf '\n✅ skill 三处一致（①==②，③ 私有串 0）\n'
else
  printf '\n❌ skill 三处不一致：跑无参版同步 → bash %s\n' "$SYNC"
  RC=1
fi

printf '\n'
if [ "$RC" -eq 0 ]; then
  printf '===== 机械项全过。仍须人工过：README / 版本号 / 相关 skill / 记录 =====\n'
else
  printf '===== 有失败，先修再谈其他 =====\n'
fi
exit "$RC"

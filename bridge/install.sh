#!/bin/bash
# 第二引擎桥 · 安装器（幂等；不碰运行时状态，不重启服务）
#
# 用法：./install.sh [--dry-run] [--with-codex-env] [目标目录]
#   --dry-run          只打印要做什么
#   --with-codex-env   顺便把启动器装到 $BIN_DIR（默认 $HOME/.local/bin）
#   目标目录            默认 $HOME/.local/share/second-engine-bridge
#
# 它只做四件事：建目录 → 拷 4 个文件 + 前端页 → chmod → 可选装启动器。
# 不会动 .token / .pid / .as.pid / 日志，也不会启动或停止任何进程。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DRY=""; WITH_ENV=""; TARGET=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --with-codex-env) WITH_ENV=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$a"; exit 2 ;;
    *) TARGET="$a" ;;
  esac
done
TARGET=${TARGET:-$HOME/.local/share/second-engine-bridge}
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}

run() { if [ -n "$DRY" ]; then echo "  [dry] $*"; else eval "$@"; fi }

echo "→ 目标目录：$TARGET"
# 源=目标（原地安装）时跳过拷贝 —— 否则 cp 会报 "are the same file"（2026-09-29）
SRC_REAL=$(readlink -f "$HERE/bridge" 2>/dev/null || echo "$HERE/bridge")
TGT_REAL=$(readlink -f "$TARGET" 2>/dev/null || echo "$TARGET")
if [ "$SRC_REAL" = "$TGT_REAL" ]; then
  echo "  目标即包内 bridge/ 本体，跳过拷贝（原地安装）"
  run "chmod +x '$TARGET/ctl.sh'"
else
  run "mkdir -p '$TARGET/public'"
  for f in server.mjs as-client.mjs selftest.mjs ctl.sh; do
    run "cp '$HERE/bridge/$f' '$TARGET/$f'"
  done
  run "cp '$HERE/bridge/public/index.html' '$TARGET/public/index.html'"
  run "chmod +x '$TARGET/ctl.sh'"
fi

if [ -n "$WITH_ENV" ]; then
  echo "→ 启动器：$BIN_DIR/codex-env"
  run "mkdir -p '$BIN_DIR'"
  run "cp '$HERE/bin/codex-env' '$BIN_DIR/codex-env'"
  run "chmod +x '$BIN_DIR/codex-env'"
fi

echo
echo "装好了。接下来："
echo "  cd $TARGET && ./ctl.sh start"
echo "  ./ctl.sh url      # 手机浏览器打开（token 每次首启随机生成，存在 .token）"
echo "  ./ctl.sh check    # 体检：codex / 所有者 / 协议 / 网页"
[ -n "$WITH_ENV" ] && echo "  codex-env         # 终端开新会话（默认就挂到同一批会话上，网页里立刻可见）"

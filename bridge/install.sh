#!/bin/bash
# 第二引擎桥 · 安装器（幂等；不碰运行时状态，不重启服务）
#
# 用法：./install.sh [--dry-run] [--with-codex-env] [目标目录]
#   --dry-run          只打印要做什么（会逐条 %q 转义，可当断言用）
#   --with-codex-env   顺便把启动器装到 $BIN_DIR（默认 $HOME/.local/bin）
#   目标目录            默认 $HOME/.local/share/second-engine-bridge
#
# 它只做三件事：建目录 → 拷 web/ 下的运行文件 → chmod；可选装启动器。
# 不会动 .token / .pid / .as.pid / 日志，也不会启动或停止任何进程。
#
# 2026-10-26 修正（五处，此前该脚本在本包布局下**一次都跑不通**）：
#   ① 运行文件全在 web/ 下，旧版按「$HERE/bridge/…」找 → 5 条 cp 全落空
#   ② 旧版还拷 public/index.html，该目录早已不存在
#   ③ 旧版缺 list.mjs
#   ④ codex-env 在 web/ 下，旧版找 bin/
#   ⑤ 末行 `[ -n "$WITH_ENV" ] && echo` 在 set -e 下会被当失败（提前 exit 1）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DRY=""; WITH_ENV=""; TARGET=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --with-codex-env) WITH_ENV=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$a"; exit 2 ;;
    *) TARGET="$a" ;;
  esac
done
TARGET=${TARGET:-$HOME/.local/share/second-engine-bridge}
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}

# 不用 eval：参数按 argv 传递，路径带空格/单引号也不会被重新切词（旧版 `eval "$@"` 有此隐患）
run() { if [ -n "$DRY" ]; then printf '  [dry]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi }

echo "→ 目标目录：$TARGET"
SRC_REAL=$(readlink -f "$HERE" 2>/dev/null || echo "$HERE")
TGT_REAL=$(readlink -f "$TARGET" 2>/dev/null || echo "$TARGET")
if [ "$SRC_REAL" = "$TGT_REAL" ]; then
  echo "  目标即包内 bridge/ 本体，跳过拷贝（原地安装）"
  run chmod +x "$TARGET/ctl.sh"
else
  run mkdir -p "$TARGET"
  for f in server.mjs as-client.mjs selftest.mjs list.mjs ctl.sh; do
    run cp "$HERE/web/$f" "$TARGET/$f"
  done
  run chmod +x "$TARGET/ctl.sh"
fi

if [ -n "$WITH_ENV" ]; then
  echo "→ 启动器：$BIN_DIR/codex-env"
  run mkdir -p "$BIN_DIR"
  run cp "$HERE/web/codex-env" "$BIN_DIR/codex-env"
  run chmod +x "$BIN_DIR/codex-env"
fi

echo
echo "装好了。接下来："
echo "  cd $TARGET && ./ctl.sh start"
echo "  ./ctl.sh url      # 手机浏览器打开（token 每次首启随机生成，存在 .token）"
echo "  ./ctl.sh check    # 体检：codex / 所有者 / 协议 / 网页"
if [ -n "$WITH_ENV" ]; then
  echo "  codex-env         # 终端开新会话（默认就挂到同一批会话上，网页里立刻可见）"
fi

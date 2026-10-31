#!/usr/bin/env bash
# dual-board 看板操作入口（唯一合法写板通道）
#
# 纪律：任何一方写 board.json / 收件箱都必须经本入口，不要手改文件——
#       CAS + O_EXCL 锁 + 原子写都在 board_tool.py 里固化。
# 用法：board.sh <子命令> [参数]；无参数时打印全部子命令。
#       完整帮助：python3 board_tool.py <子命令> -h
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 2026-09-30 收编进插件：脚本随插件走，运行数据默认仍在本机工作区（DUAL_BOARD_DIR 可覆盖）
export DUAL_BOARD_DIR="${DUAL_BOARD_DIR:-$HOME/proj/dual-board}"

if [[ $# -eq 0 ]]; then
  python3 "$DIR/board_tool.py" --help
  exit 0
fi

exec python3 "$DIR/board_tool.py" "$@"

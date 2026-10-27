#!/bin/bash
# web-base.sh — 解析 DSH Web 的 base URL（wait-task.sh / dispatch.sh / smoke.sh 共用）
#
# 为什么不能写死 3080：新版 DSH 的 Web 端口每次启动可能变（本机实测 43309）。
# 优先级与 src/index.js 的 AGENTS_BASE_URL 一致：
#   1) SECOND_ENGINE_BASE_URL  显式覆盖
#   2) DSH_WEB_URL             调用方注入
#   3) 运行中 dsh web 进程的 --port（唯一可靠来源：宿主自己的启动参数）
#   4) http://127.0.0.1:3080   历史默认值兜底
# 用法（source 后调用，不要 exec）：
#   . "$(dirname "$0")/web-base.sh"; base=$(se_web_base)
# 只读 /proc，不杀进程、不改文件；被 source 时不启用 set -e，避免污染调用方。
# 2026-10-27 新增：修「wait-task.sh 硬编码 3080 无兜底」与「dispatch.sh 只认 DSH_WEB_URL」。

# 从运行中的 dsh web 进程命令行取 --port；取不到则输出空。
se_web_port_from_proc() {
  python3 - <<'PY' 2>/dev/null
import glob
for path in glob.glob('/proc/[0-9]*/cmdline'):
    try:
        raw = open(path, 'rb').read()
    except OSError:
        continue
    args = [a.decode('utf-8', 'replace') for a in raw.split(b'\0')]
    # 宿主：node .../dsh/lib/bin.js web --host … --port <N>
    if not any('bin.js' in a for a in args) or 'web' not in args:
        continue
    for i, a in enumerate(args[:-1]):
        if a == '--port' and args[i + 1].isdigit():
            print(args[i + 1])
            raise SystemExit
PY
}

# 输出不带尾斜杠的 base URL。优先使用调用方已注入的值。
se_web_base() {
  local base="${SECOND_ENGINE_BASE_URL:-}"
  [ -n "$base" ] || base="${DSH_WEB_URL:-}"
  if [ -n "$base" ]; then
    printf '%s' "${base%/}"
    return 0
  fi
  local port
  port=$(se_web_port_from_proc)
  if [ -n "$port" ]; then
    printf 'http://127.0.0.1:%s' "$port"
    return 0
  fi
  printf 'http://127.0.0.1:3080'
}

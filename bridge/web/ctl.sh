#!/bin/bash
# 浏览器聊天桥 控制脚本（app-server 版）
#
#   ./ctl.sh start        起所有者 + 网页（幂等）
#   ./ctl.sh reload-web   只重载网页进程
#   ./ctl.sh stop         两个都停
#   ./ctl.sh restart      先停再起（会打断正在跑的一轮）
#   ./ctl.sh status       看两个进程 + 健康
#   ./ctl.sh status-json  输出插件可解析的单行 JSON 状态
#   ./ctl.sh url          打印浏览器地址（含 token）
#   ./ctl.sh as-url       打印 app-server 地址
#   ./ctl.sh check        自检
#   ./ctl.sh threads      列出最近会话
#   ./ctl.sh logs         看两个日志的尾巴
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
STATE_DIR=${BRIDGE_STATE_DIR:-$HOME/.dsh/second-engine-bridge}
DEFAULT_WEB_PORT=${BRIDGE_PORT:-3095}
DEFAULT_AS_PORT=${BRIDGE_AS_PORT:-3096}
PORT=$DEFAULT_WEB_PORT
AS_PORT=$DEFAULT_AS_PORT
AS_URL=${BRIDGE_AS_URL:-ws://127.0.0.1:$AS_PORT}
CODEX_BIN=${CODEX_BIN:-$(command -v codex 2>/dev/null || true)}
NODE_BIN=${NODE_BIN:-$(command -v node 2>/dev/null || true)}
WORKDIR=${BRIDGE_WORKDIR:-$STATE_DIR/work}
WEB_PID_FILE="$STATE_DIR/.pid"
AS_PID_FILE="$STATE_DIR/.as.pid"
TOKEN_FILE="$STATE_DIR/.token"
URL_FILE="$STATE_DIR/.url"
PORTS_FILE="$STATE_DIR/ports.json"
LOCK_FILE="$STATE_DIR/start.lock"
BRIDGE_LOG="$STATE_DIR/bridge.log"
AS_LOG="$STATE_DIR/as-server.log"

mkdir -p "$STATE_DIR" "$WORKDIR" || {
  printf '%s\n' '{"code":"state-dir-unavailable"}'
  exit 1
}

json_error() {
  printf '%s\n' "$1"
  exit 1
}

require_bins() {
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || json_error '{"code":"node-not-found"}'
  [ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ] || json_error '{"code":"codex-not-found"}'
}

port_value() {
  local name=$1 default=$2 value
  value=$(sed -n "s/.*\"$name\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$PORTS_FILE" 2>/dev/null | tail -1)
  [ -n "$value" ] || value=$default
  printf '%s' "$value"
}

load_ports() {
  PORT=$(port_value web "$DEFAULT_WEB_PORT")
  AS_PORT=$(port_value as "$DEFAULT_AS_PORT")
  AS_URL=${BRIDGE_AS_URL:-ws://127.0.0.1:$AS_PORT}
}

port_open() {
  timeout 1 bash -c ": </dev/tcp/127.0.0.1/$1" >/dev/null 2>&1
}

select_ports() {
  local offset web_port as_port
  for offset in 0 2 4 6 8 10 12 14 16 18; do
    web_port=$((PORT + offset))
    as_port=$((AS_PORT + offset))
    if ! port_open "$web_port" && ! port_open "$as_port"; then
      PORT=$web_port
      AS_PORT=$as_port
      AS_URL=${BRIDGE_AS_URL:-ws://127.0.0.1:$AS_PORT}
      printf '{"web":%s,"as":%s}\n' "$PORT" "$AS_PORT" > "$PORTS_FILE"
      return 0
    fi
  done
  json_error '{"code":"port-unavailable"}'
}

persist_ports() {
  printf '{"web":%s,"as":%s}\n' "$PORT" "$AS_PORT" > "$PORTS_FILE"
}

pid_of() {
  local file=$1 want=$2 p
  [ -f "$file" ] || return 1
  p=$(tr -dc '0-9' < "$file")
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  grep -qa "$want" "/proc/$p/cmdline" 2>/dev/null || return 1
  printf '%s' "$p"
}

web_pid() { pid_of "$WEB_PID_FILE" server.mjs; }

find_as_pid() {
  local p c
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    case "$c" in *"app-server --listen $AS_URL"*) printf '%s' "${p#/proc/}"; return 0;; esac
  done
  return 1
}

as_pid() { pid_of "$AS_PID_FILE" app-server || find_as_pid 2>/dev/null; }

# app-server 要拿着 provider key 才能真跑回合；key 的出处与 codex-env 一致（DSH 的 keyring）。
# ⚠️ 这段不能删：删了桥**能启动**、但发消息时回合跑不起来（2026-09-29 被误当作"密钥红线"删过一次，已恢复）。
# 红线管的是「key 不得进日志/产物/命令行」；从本机 0600 的 keyring 读出、经环境注入子进程，是正确做法。
load_key() {
  local kr=${BRIDGE_KEYRING:-$HOME/.codex/keyring.json}
  if [ ! -f "$kr" ]; then echo "⚠ 没找到 $kr（DSH：设置 → 第二引擎 里配提供方）"; return 0; fi
  eval "$(python3 - "$kr" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1]))
providers = {p['id']: p for p in d.get('providers', [])}
p = providers.get(d.get('active'))
if p and p.get('apiKey'):
    print('export %s_API_KEY=%s' % (str(d['active']).upper(), shlex.quote(p['apiKey'])))
PY
)"
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    curl -sf -m 2 "http://127.0.0.1:$AS_PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

start_as() {
  local p child_pid
  if p=$(as_pid); then echo "会话所有者已在跑 (pid $p)"; return 0; fi
  rm -f "$AS_PID_FILE"
  load_key   # 必须在起 app-server 之前：key 靠环境变量传给子进程
  (cd "$WORKDIR" && exec setsid nohup "$CODEX_BIN" app-server --listen "$AS_URL" >>"$AS_LOG" 2>&1 </dev/null) 9>&- &
  child_pid=$!
  disown 2>/dev/null || true
  if ! wait_ready; then
    kill "$child_pid" 2>/dev/null || true
    rm -f "$AS_PID_FILE"
    echo "✗ 会话所有者启动失败（$AS_URL）。请检查 codex 可用性和 $AS_LOG"
    return 1
  fi
  if p=$(find_as_pid 2>/dev/null); then printf '%s\n' "$p" > "$AS_PID_FILE"; fi
  echo "会话所有者已就绪：$AS_URL${p:+ (pid $p)}"
}

start_web() {
  local mode=${1:-start}
  p=
  (cd "$HERE" && BRIDGE_STATE_DIR="$STATE_DIR" BRIDGE_PORT="$PORT" BRIDGE_AS_URL="$AS_URL" BRIDGE_WORKDIR="$WORKDIR" exec setsid nohup "$NODE_BIN" server.mjs >>"$BRIDGE_LOG" 2>&1 </dev/null) 9>&- &
  disown 2>/dev/null || true
  for _ in $(seq 1 20); do
    sleep 0.5
    p=$(web_pid) && break
  done
  if [ -z "$p" ]; then
    echo "✗ 网页桥启动失败，日志：$BRIDGE_LOG"
    return 1
  fi
  if [ "$mode" = reload ]; then
    echo "网页桥已重载 (pid $p；所有者没动)"
  else
    echo "网页桥已启动 (pid $p)"
  fi
}

case "${1:-}" in
  start)
    require_bins
    load_ports
    exec 9>"$LOCK_FILE"
    flock -n 9 || json_error '{"code":"start-busy"}'
    if p=$(web_pid); then
      echo "网页桥已在运行 (pid $p)"
    else
      rm -f "$WEB_PID_FILE"
      if ! web_pid >/dev/null && ! as_pid >/dev/null; then
        select_ports
      else
        persist_ports
      fi
      start_as || exit 1
      start_web || exit 1
    fi
    "$HERE/ctl.sh" url
    echo "终端想共享同一批会话：codex --remote $AS_URL"
    ;;
  stop)
    load_ports
    if p=$(web_pid); then kill "$p" && rm -f "$WEB_PID_FILE" && echo "网页桥已停止 (pid $p)"; else echo "网页桥未在运行"; fi
    if p=$(as_pid); then
      kill "$p" && rm -f "$AS_PID_FILE" && echo "会话所有者已停止 (pid $p)"
      echo "注意：挂在它上面的终端 TUI（codex --remote）会一起断开"
    else
      echo "会话所有者未在运行"
    fi
    ;;
  reload-web)
    require_bins
    load_ports
    exec 9>"$LOCK_FILE"
    flock -n 9 || json_error '{"code":"reload-busy"}'
    if p=$(web_pid); then kill "$p" && rm -f "$WEB_PID_FILE"; sleep 1; fi
    start_web reload || exit 1
    ;;
  restart)
    if as_pid >/dev/null; then
      echo "⚠ 重启会踢掉挂在所有者上的终端 TUI（它们会报 session could not be restored）"
    fi
    "$HERE/ctl.sh" stop
    sleep 1
    "$HERE/ctl.sh" start
    ;;
  status)
    load_ports
    if p=$(web_pid); then
      echo "网页桥: 活着 (pid $p)"
      curl -s -m 5 "http://127.0.0.1:$PORT/api/health" || echo "  (health 无响应)"
      echo
    else
      echo "网页桥: 死"
    fi
    if p=$(as_pid); then
      echo "会话所有者: 活着 (pid $p) $AS_URL"
      curl -s -m 3 "http://127.0.0.1:$AS_PORT/readyz" >/dev/null 2>&1 && echo "  /readyz ok" || echo "  /readyz 无响应"
    else
      echo "会话所有者: 死"
    fi
    ;;
  status-json)
    load_ports
    web_running=false
    web_pid_value=null
    as_running=false
    as_pid_value=null
    healthy=false
    if p=$(web_pid); then web_running=true; web_pid_value=$p; fi
    if p=$(as_pid); then as_running=true; as_pid_value=$p; fi
    if $web_running && $as_running && curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && curl -sf -m 2 "http://127.0.0.1:$AS_PORT/readyz" >/dev/null 2>&1; then
      healthy=true
    fi
    printf '{"web":{"running":%s,"pid":%s,"port":%s},"as":{"running":%s,"pid":%s,"url":"%s"},"healthy":%s}\n' \
      "$web_running" "$web_pid_value" "$PORT" "$as_running" "$as_pid_value" "$AS_URL" "$healthy"
    ;;
  url)
    load_ports
    token=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -z "$token" ]; then echo "还没有 token，先 ./ctl.sh start"; exit 1; fi
    URL="http://127.0.0.1:$PORT/?t=$token"
    printf '%s\n' "$URL"
    (umask 077; printf '%s\n' "$URL" > "$URL_FILE")
    ;;
  as-url)
    load_ports
    echo "$AS_URL"
    ;;
  check)
    require_bins
    load_ports
    cd "$HERE" && BRIDGE_PORT="$PORT" BRIDGE_AS_URL="$AS_URL" exec "$NODE_BIN" selftest.mjs
    ;;
  threads)
    require_bins
    load_ports
    cd "$HERE" && BRIDGE_AS_URL="$AS_URL" exec "$NODE_BIN" list.mjs "${2:-12}"
    ;;
  logs)
    echo "== bridge.log"; tail -20 "$BRIDGE_LOG" 2>/dev/null
    echo "== as-server.log"; tail -20 "$AS_LOG" 2>/dev/null
    ;;
  *) sed -n '2,19p' "$HERE/ctl.sh" | sed 's/^# \{0,1\}//' ;;
esac

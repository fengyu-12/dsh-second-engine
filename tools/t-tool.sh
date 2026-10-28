#!/bin/bash
# t-tool.sh v3 — tmux 交互窗口工具集（第二引擎；按 v2 验收报告遗留缺陷修复）
#
# 用法: t-tool.sh <子命令> [参数...]     （无参数 / -h / --help / help 显示本帮助）
#
# v3 变更:
#   1. run 用子 shell 包裹命令: 实际发送 "( <命令> ); echo <哨兵>=$?_"。
#      exit/logout 只退子 shell, 不再连会话 bash 一起杀死
#      （v2 实测 run t1 "echo x; exit 7" 会把整个会话干掉并 TIMEOUT）。
#   2. 新增 _check_owner(): type/key/run/snap/wait/kill 操作前统一校验 @owner,
#      非本工具创建的同名会话一律拒绝(rc=3); new 仍只做防重名(原有行为, 提示区分归属)。
#   3. 新增 _check_uint(): run 超时>=1、snap 行数>=1（0 不再静默空输出）、
#      wait 超时>=1 / 基线行>=0，外加 wait 正则合法性；参数不合法 rc=4 并给中文提示,
#      不再出现 "tail: invalid number" / 算术表达式报错这类难懂输出。
#   4. run 回传命令输出: v2 只有退码+空行(哨兵独占一行时 ${L%%$TK=*} 前缀恒为空),
#      现在截取「回显的命令行」与「哨兵行」之间的内容作为输出。
#   5. 帮助输出滤掉 shebang（v2 首行会打印 "!/bin/bash"），并补齐各子命令用法。
#
# 子命令:
#   new  <会话名> [命令]                          新建后台会话 200x50（重名拒绝），打标 @owner
#   type <会话名> <文本>                          原样注入文本（不回车；要回车用 key <会话> Enter）
#   key  <会话名> <键>                            发送 tmux 键名（Enter / C-c / Up / M-x ...）
#   run  <会话名> <命令> [超时秒=120]              执行命令，回传输出+退出码；exit 不会杀死会话
#   snap <会话名> [-full | 行数=40]               回看窗口（默认去空行取末尾 40 行，-full 全文）
#   wait <会话名> <正则> [超时秒=30] [基线行=0]    等正则出现（从基线行之后开始匹配），命中打印 MATCH
#   ls                                            列出会话：名字 / 创建时间 / owner
#   gc   [分钟=30]                                清理超龄且属于本工具的会话
#   kill <会话名>                                 关闭会话并补刀子进程
#
# 注意: run/wait 要求目标会话停在 shell 提示符上；命令请写单行（多行自己用 ; && 串）。
#       run 的退出码在 EXIT=<n> 行回传，命令自身的输出在上一行起逐行给出。
# 退出码: 0=成功 1=TIMEOUT 2=会话不存在 3=会话已存在/非本工具创建 4=参数错误
set -o pipefail
OWNER="dsh-ttool-v2"   # 会话打标命名空间；沿用 v2 取值，让 ls/gc/_check_owner 继续认领 v2 建的会话

  # 内部函数；帮助文本由 grep '^#' 生成, 所以脚本体内的注释必须缩进, 否则会漏进帮助输出
_owner_of() { tmux show-options -qv -t "$1" @owner 2>/dev/null; }

_check_owner() {
  tmux has-session -t "$1" 2>/dev/null || { echo "会话不存在: $1" >&2; exit 2; }
  local o; o=$(_owner_of "$1")
  [ "$o" = "$OWNER" ] || { echo "拒绝操作: 会话 $1 非本工具创建(owner='${o:-未设置}'), 防串台" >&2; exit 3; }
}

_check_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) echo "参数错误: $2 必须是不小于 $3 的整数, 收到 '${1:-}'" >&2; return 1 ;;
  esac
  [ "$1" -ge "$3" ] || { echo "参数错误: $2 必须是不小于 $3 的整数, 收到 '$1'" >&2; return 1; }
}

case "${1:-}" in
  new)  [ -n "$2" ] || { echo "用法: new <会话名> [命令]" >&2; exit 4; }
        if tmux has-session -t "$2" 2>/dev/null; then
          if [ "$(_owner_of "$2")" = "$OWNER" ]; then echo "会话已存在(防串台,拒绝覆盖): $2" >&2
          else echo "拒绝: 会话 $2 已存在且非本工具创建, 不覆盖" >&2; fi
          exit 3
        fi
        tmux new-session -d -s "$2" -x 200 -y 50 "${3:-bash}" \
          && tmux set-option -t "$2" @owner "$OWNER" >/dev/null \
          && echo "会话 $2 已建(200x50)" ;;
  type) [ -n "$2" ] && [ -n "$3" ] || { echo "用法: type <会话名> <文本>" >&2; exit 4; }
        _check_owner "$2"
        tmux send-keys -t "$2" -l "$3"; tmux send-keys -t "$2" Enter; echo "已注入" ;;
  key)  [ -n "$2" ] && [ -n "$3" ] || { echo "用法: key <会话名> <键>" >&2; exit 4; }
        _check_owner "$2"
        tmux send-keys -t "$2" "$3"; echo "已按键" ;;
  run)  [ -n "$2" ] && [ -n "$3" ] || { echo "用法: run <会话名> <命令> [超时秒=120]" >&2; exit 4; }
        _check_owner "$2"
        S=${4:-120}; _check_uint "$S" "超时秒" 1 || exit 4
        TK="__DSH_DONE_$(date +%s%N)_$RANDOM__"
        tmux send-keys -t "$2" -l "( $3 ); echo $TK=\$?_"
        tmux send-keys -t "$2" Enter
        i=0
        while [ "$i" -lt $((S*2)) ]; do
          CAP=$(tmux capture-pane -p -J -S -2000 -t "$2" 2>/dev/null)
          L=$(printf '%s\n' "$CAP" | grep -E -- "$TK=[0-9]+_" | tail -1)
          if [ -n "$L" ]; then
            C=${L##*=}; echo "EXIT=${C%_}"
            printf '%s\n' "$CAP" | awk -v tk="$TK" '
              { line[NR]=$0 }
              index($0,tk) { if ($0 ~ (tk "=[0-9]+_")) { en=NR; exit } else { st=NR } }
              END { for (i=st+1; i<en; i++) print line[i] }'
            exit 0
          fi
          sleep 0.5; i=$((i+1))
        done; echo "TIMEOUT(${S}s)" >&2; exit 1 ;;
  snap) [ -n "$2" ] || { echo "用法: snap <会话名> [-full | 行数=40]" >&2; exit 4; }
        _check_owner "$2"
        if [ "${3:-40}" = "-full" ]; then tmux capture-pane -p -J -t "$2"
        else N=${3:-40}; _check_uint "$N" "行数" 1 || exit 4
             tmux capture-pane -p -J -t "$2" | grep -v '^[[:space:]]*$' | tail -n "$N"
        fi ;;
  wait) [ -n "$2" ] && [ -n "$3" ] || { echo "用法: wait <会话名> <正则> [超时秒=30] [基线行=0]" >&2; exit 4; }
        _check_owner "$2"
        S=${4:-30}; BASE=${5:-0}
        _check_uint "$S" "超时秒" 1 || exit 4
        _check_uint "$BASE" "基线行" 0 || exit 4
        printf '' | grep -qE -- "$3" 2>/dev/null; [ $? -gt 1 ] && { echo "参数错误: 正则无效: '$3'" >&2; exit 4; }
        i=0
        while [ "$i" -lt $((S*2)) ]; do
          tmux capture-pane -p -J -S -2000 -t "$2" 2>/dev/null | tail -n "+$((BASE+1))" | grep -qE -- "$3" \
            && { echo "MATCH"; exit 0; }
          sleep 0.5; i=$((i+1))
        done; echo "TIMEOUT"; exit 1 ;;
  ls)   tmux list-sessions -F '#{session_name}|#{session_created}|#{@owner}' 2>/dev/null | while IFS='|' read N C O; do
            T=$(date -d @"$C" "+%m-%d %H:%M" 2>/dev/null || echo "?")
            printf "%-16s since=%s owner=%s\n" "$N" "$T" "${O:--}"
          done ;;
  gc)   LIMIT=${2:-30}; _check_uint "$LIMIT" "分钟" 0 || exit 4
        NOW=$(date +%s)
        tmux list-sessions -F '#{session_name}|#{session_created}|#{@owner}' 2>/dev/null | while IFS='|' read N C O; do
          [ "$O" = "$OWNER" ] || continue
          AGE=$(( (NOW - C) / 60 ))
          [ "$AGE" -ge "$LIMIT" ] && { tmux kill-session -t "$N" && echo "已清理 $N (龄 ${AGE}分钟)"; }
        done; echo "gc 完成" ;;
  kill) _check_owner "$2"
        P=$(tmux display-message -p -t "$2" '#{pane_pid}')
        tmux kill-session -t "$2"
        pkill -TERM -P "$P" 2>/dev/null; sleep 0.5; pkill -KILL -P "$P" 2>/dev/null
        kill "$P" 2>/dev/null; echo "已关闭(含子进程补刀)" ;;
  help|-h|--help|'') grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)    echo "未知子命令: $1" >&2
        grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 4 ;;
esac

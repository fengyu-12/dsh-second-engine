#!/bin/bash
# wait-task.sh v2 — 阻塞等待 second-engine 工单完成（按 Codex 验收报告重构）
# 退出码: 0=done  2=失败终态(error/cancelled)  3=任务不存在/响应异常  4=接口不可用  124=超时  1=参数错误
# 用法: wait-task.sh <工单id> [轮询间隔秒=5] [总超时秒=600]
ID="$1"; IV="${2:-5}"; TOTAL="${3:-600}"
[[ "$ID" =~ ^[A-Za-z0-9]+$ ]] || { echo "无效 id" >&2; exit 1; }
[[ "$IV" =~ ^[0-9]+$ ]] || { echo "间隔必须是整数秒" >&2; exit 1; }
START=$(date +%s); FAILS=0; LASTHB=0
while :; do
  NOW=$(date +%s)
  RESP=$(curl -s --max-time 8 -w $'\n%{http_code}' "http://127.0.0.1:3080/second-engine/api/task?id=$ID" 2>/dev/null)
  CODE=${RESP##*$'\n'}; BODY=${RESP%$'\n'*}
  if [ "$CODE" = "404" ]; then echo "任务不存在: $ID" >&2; exit 3; fi
  if [ "$CODE" != "200" ]; then
    FAILS=$((FAILS+1))
    [ $FAILS -ge 3 ] && { echo "接口连续 $FAILS 次不可用(最后 http=$CODE)" >&2; exit 4; }
  else
    FAILS=0
    S=$(printf '%s' "$BODY" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('task',{}).get('status','?'))
except Exception: print('PARSE_ERR')" 2>/dev/null)
    case "$S" in
      done)            echo "$ID done"; exit 0 ;;
      error|cancelled) echo "$ID $S" >&2; exit 2 ;;
      '?'|PARSE_ERR|'') echo "响应异常(status=$S)" >&2; exit 3 ;;
    esac
  fi
  [ $((NOW - START)) -ge $TOTAL ] && { echo "等待超时(${TOTAL}s)" >&2; exit 124; }
  [ $((NOW - LASTHB)) -ge 30 ] && { echo "[wait-task] 仍在等待 $ID ..." >&2; LASTHB=$NOW; }
  sleep "$IV"
done

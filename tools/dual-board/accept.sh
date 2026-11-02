#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOARD_DIR="${DUAL_BOARD_DIR:-$HOME/proj/dual-board}"
if [[ $# -lt 1 ]]; then echo "usage: accept.sh <task-id> [--test \"command\"]" >&2; exit 2; fi
TASK_ID="$1"; shift
TEST_CMD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) [[ $# -ge 2 ]] || { echo "--test requires a command" >&2; exit 2; }; TEST_CMD="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
TASK_JSON="$(python3 - "$BOARD_DIR/board.json" "$TASK_ID" <<'PY'
import json,sys
try:
    tasks=json.load(open(sys.argv[1],encoding='utf-8')).get('tasks',[])
    t=next((x for x in tasks if x.get('id')==sys.argv[2]),None)
except (OSError,ValueError): t=None
if t is None or t.get('status') in ('completed','abandoned'):
    sys.exit(4)
print(json.dumps(t))
PY
)" || { rc=$?; [[ $rc -eq 4 ]] && echo "任务不存在或状态不允许验收" >&2; exit 4; }
BASE="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("base") or "")' "$TASK_JSON")"
SCOPE_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]).get("write_scopes") or []))' "$TASK_JSON")"
SNAPSHOT="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]).get("_base_snapshot") or {}))' "$TASK_JSON")"
WORKDIR="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("workdir") or ".")' "$TASK_JSON")"
[[ -n "$BASE" ]] || { echo "未记录基线，拒绝合并" >&2; exit 2; }
cd "$WORKDIR"
CHANGED=()
if [[ "$BASE" == md5:* ]]; then
  mapfile -t CHANGED < <(python3 - "$SNAPSHOT" "$WORKDIR" "$SCOPE_JSON" <<'PY'
import hashlib,json,os,sys
old=json.loads(sys.argv[1]); root=sys.argv[2]; scopes=json.loads(sys.argv[3]); current={}
paths=set(old)
for scope in scopes:
    full=os.path.join(root,scope)
    if os.path.isfile(full): paths.add(scope)
    elif os.path.isdir(full):
        for base,_,files in os.walk(full):
            paths.update(os.path.relpath(os.path.join(base,name),root).replace(os.sep,'/') for name in files)
for path in paths:
    full=os.path.join(root,path)
    if os.path.isfile(full):
        with open(full,'rb') as f: current[path]=hashlib.sha256(f.read()).hexdigest()
for path in old.keys() | current.keys():
    if old.get(path)!=current.get(path): print(path)
PY
)
else
  git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1 || { echo "基线不可用：$BASE" >&2; exit 2; }
  while IFS= read -r path; do [[ -n "$path" ]] && CHANGED+=("$path"); done < <(git -c core.quotepath=false diff --name-only "$BASE")
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    found=0
    for existing in "${CHANGED[@]}"; do [[ "$existing" == "$path" ]] && found=1; done
    [[ $found -eq 1 ]] || CHANGED+=("$path")
  done < <(git -c core.quotepath=false ls-files --others --exclude-standard)
fi
OUTSIDE=()
if [[ "$SCOPE_JSON" != "[]" ]]; then
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    allowed=0
    while IFS= read -r scope; do
      [[ -n "$scope" && ( "$path" == "$scope" || "$path" == "$scope/"* ) ]] && allowed=1
    done < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$SCOPE_JSON")
    [[ $allowed -eq 1 ]] || OUTSIDE+=("$path")
  done < <(printf '%s\n' "${CHANGED[@]}")
fi
if [[ ${#OUTSIDE[@]} -gt 0 ]]; then printf '范围越界文件:\n%s\n' "$(printf '%s\n' "${OUTSIDE[@]}")" >&2; exit 2; fi
[[ ${#CHANGED[@]} -gt 0 ]] || { echo "工作区无改动，疑似空交付" >&2; exit 1; }
if [[ -z "$TEST_CMD" ]]; then echo "拒绝无测试的验收" >&2; exit 1; fi
set +e
TEST_OUTPUT="$(bash -o pipefail -c "$TEST_CMD" 2>&1)"
TEST_RC=$?
set -e
if [[ $TEST_RC -ne 0 ]]; then printf '%s\n' "$TEST_OUTPUT" | tail -n 30 >&2; exit 1; fi
printf 'ACCEPT OK %s files=%s\n' "$TASK_ID" "${#CHANGED[@]}"

#!/bin/bash
# 派单前只读校验：仅获取状态，不派单、不切档、不落盘。
set -euo pipefail
TOOLS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$TOOLS_DIR/web-base.sh"
# Python 负责参数、JSON 和规则；仅在未提供离线状态时解析 Web 地址。
export -f se_web_base se_web_port_from_proc
python3 - "$@" <<'PY'
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

parser = argparse.ArgumentParser(description="派单前只读校验")
parser.add_argument('--engine', choices=('codex', 'pi', 'claude'))
parser.add_argument('--mode', choices=('task', 'review', 'longtask'), default='task')
parser.add_argument('--prompt', default='')
parser.add_argument('--prompt-file')
parser.add_argument('--status-json')
parser.add_argument('--json', action='store_true', dest='as_json')
a = parser.parse_args()
checks = []
def add(level, code, message):
    checks.append(dict(level=level, code=code, message=message))

# R1：失败时不猜档位，仍执行其余可以判定的规则。
status = None
try:
    raw = a.status_json
    if raw is None:
        raw = os.environ.get('SECOND_ENGINE_STATUS_JSON')
    if raw is None:
        base = subprocess.check_output(['bash', '-c', 'se_web_base'], text=True).strip()
        with urllib.request.urlopen(base + '/second-engine/api/status', timeout=8) as response:
            raw = response.read().decode('utf-8')
    status = json.loads(raw)
    collab = status['collab']
    active = status['engine']['active']
    if (not isinstance(collab, dict)
            or collab.get('preset') not in ('review', 'propose', 'longtask')
            or not all(isinstance(collab.get(k), str) for k in ('voice', 'longtask'))
            or active not in ('codex', 'pi', 'claude')):
        raise ValueError('状态字段无效')
except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
    status = None
    collab = {}
    active = None
    add('error', 'R1', '接口不可用，按 review 兜底；不要猜档位')
else:
    add('ok', 'R1', '已获取协作档位与引擎状态')

prompt = a.prompt
if a.prompt_file is not None:
    try:
        prompt += '\n' + Path(a.prompt_file).read_text(encoding='utf-8')
    except (OSError, ValueError, UnicodeError):
        # 不输出文件内容或底层异常，以免泄露工单中的敏感信息。
        add('error', 'INPUT', '无法读取 prompt 文件（需为可读的 UTF-8 文本）')
engine = a.engine or active
preset = collab.get('preset')
if a.mode == 'review' and engine != 'codex':
    add('error', 'R2', '复核恒走 codex exec')
if preset == 'propose' and a.mode == 'task' and 'LONGSESSION:' not in prompt:
    add('error', 'R3', '协作提议档：prompt 末尾必须要求给一行 LONGSESSION: yes/no')
if preset == 'review' and a.mode == 'longtask':
    add('warn', 'R4', '当前档未开长任务；切档是用户裁决，主 AI 不擅自切')
if preset == 'longtask' and a.mode == 'task':
    add('info', 'R5', '独立短活走 /api/task 合法；只有跨轮连续的部分才必须 resume')
if engine == 'claude' and a.mode == 'task' and re.search('只评审|只分析|不要改文件|不改文件|禁止写|不改代码', prompt):
    add('error', 'R6', 'claude 纯分析单必被判『claude 无外部产物』→ error；改用 codex')
if a.mode == 'task' and not prompt.strip() and a.prompt_file is None:
    add('error', 'R7', '工单必须自包含')
if engine == 'pi':
    add('info', 'R8', '成功判据 stopReason=stop；其余（含空值新增枚举）一律判失败')
if engine == 'codex':
    add('info', 'R9', '成功判据 exitCode=0')

channels = {
    'task': '一次性工单 → POST /second-engine/api/task',
    'review': '复核（codex exec） → POST /second-engine/api/review',
    'longtask': '长任务 → resume（接续已有会话；新链先创建会话）',
}
channel = channels['review' if status is None else a.mode]
errors = sum(c['level'] == 'error' for c in checks)
result = dict(ok=not errors, preset=preset, channel=channel, engine=engine,
              checks=checks, blocked=bool(errors))
if a.as_json:
    print(json.dumps(result, ensure_ascii=False))
else:
    print(f"档位: {preset or '未知'} (voice={collab.get('voice', '未知')} longtask={collab.get('longtask', '未知')})")
    print(f"通道: {channel}")
    print(f"引擎: {engine or '未知'}")
    print('检查:')
    icons = dict(ok='✅', warn='⚠️', info='ℹ️', error='❌')
    for c in checks:
        print(f"  {icons[c['level']]} {c['code']} {c['message']}")
    print('结论: ' + (f'不要派（先修 {errors} 项）' if errors else '可以派单'))
sys.exit(1 if errors else 0)
PY

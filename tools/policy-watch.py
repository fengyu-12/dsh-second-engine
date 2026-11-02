#!/usr/bin/env python3
"""policy-watch.py — 从 DSH 会话事件流里算"该派单了"的机械信号。

配套 skill `second-engine` 的「编排的定义与触发 · 兜底」节。判据全部取自
结构化事件，不解析我的自然语言、也不靠我自觉计数。

三条判据：
  M1 同一规范命令 + 完全相同的输出连续 >= 2（不依赖退出码），
     且「本次 vs 上一次同命令同输出」的间隔 < window（局部间隔，不以整场末尾为锚）
  M2 同一文件编辑振荡 A->B->A（edit 用 old/new 对；write 用 content 哈希序列）
  M3 连续 N 步无状态推进（默认 4 步 / 10 分钟窗口）

数据源：~/.dsh/sessions/<cwd 编码>/<session>/session.v4.jsonl.zstd

用法:
  policy-watch.py                       # 当前目录最新会话
  policy-watch.py --session <id 或路径>  # 指定会话
  policy-watch.py --json                # 机器可读
  policy-watch.py --steps 6             # 改 M3 的步数阈值

退出码：0 = 无命中；10 = 有命中（可直接接 shell 判断）
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

SESSIONS_ROOT = os.path.expanduser("~/.dsh/sessions")
SESSION_FILE = "session.v4.jsonl.zstd"
# 等待类工具调用不算"无推进"（它们本来就不产出状态）
WAIT_TOOLS = {"job_output", "job_list", "job_kill"}
EXIT_RE = re.compile(r"\[exit code:\s*(-?\d+)\]")


def h(s, n=12):
    return hashlib.sha1(s.encode("utf-8", "replace")).hexdigest()[:n]


def norm_cmd(c):
    """命令归一化：压空白 + 截断。只用前 200 字符，避免长命令天然唯一而漏判。"""
    return re.sub(r"\s+", " ", str(c).strip())[:200]


def norm_err(t):
    """错误类归一化：去掉数字、路径、耗时、内存地址这类每次都变的部分，只留错误骨架。"""
    t = EXIT_RE.sub("", str(t))
    t = re.sub(r"/[\w./-]+", "<path>", t)
    # 十六进制地址（traceback 里的 0x7f...）每次都不一样，先于十进制数字归一化
    t = re.sub(r"\b0[xX][0-9a-fA-F]+\b", "<addr>", t)
    # 浮点/整数归一化：负向后视保证从数字开头整体匹配（0.31s -> <n>s，而不是 <n>.31s），
    # 同时不会把 x.31 里的 31 当成数字。
    t = re.sub(r"(?<![\w.])\d+(?:\.\d+)?", "<n>", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:300]


def cwd_key(cwd):
    """DSH 把 cwd 编码成目录名：/a/b -> --a-b--"""
    return "--" + cwd.strip("/").replace("/", "-") + "--"


def find_sessions(root):
    out = []
    if not os.path.isdir(root):
        return out
    for grp in os.listdir(root):
        gp = os.path.join(root, grp)
        if not os.path.isdir(gp) or grp == ".sessions-trash":
            continue
        for sid in os.listdir(gp):
            f = os.path.join(gp, sid, SESSION_FILE)
            if os.path.isfile(f):
                out.append((os.path.join(gp, sid), os.path.getmtime(f)))
    out.sort(key=lambda x: -x[1])
    return out


def pick_session(spec, root=SESSIONS_ROOT):
    if spec:
        if os.path.isdir(spec) and os.path.isfile(os.path.join(spec, SESSION_FILE)):
            return spec
        for p in find_sessions(os.path.dirname(os.path.abspath(spec))):
            if spec.rstrip("/").endswith(os.path.basename(p)) or spec in p:
                return p
        for p, _ in find_sessions(root):
            if spec in p:
                return p
        return None
    # 默认：当前 cwd 对应分组里的最新会话；没有就全局最新
    group = os.path.join(root, cwd_key(os.getcwd()))
    cands = [x for x in find_sessions(root) if os.path.dirname(x[0]) == group]
    if cands:
        return cands[0][0]
    alls = find_sessions(root)
    return alls[0][0] if alls else None


def read_events(path):
    f = os.path.join(path, SESSION_FILE)
    try:
        proc = subprocess.Popen(["zstd", "-dc", f], stdout=subprocess.PIPE)
    except FileNotFoundError:
        raise RuntimeError("zstd binary not found")
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue
    proc.wait()


# epoch 秒的合理区间：2001-09-09 ~ 2100-01-01。区间外的值一律当坏样本丢弃。
MIN_EPOCH_S = 1_000_000_000.0
MAX_EPOCH_S = 4_102_444_800.0


def _scale_epoch(v):
    """按量级把 s / ms / µs / ns 统一成秒；离谱值返回 None（不污染 max()）。"""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if v < 0 or v != v:        # 负数 / NaN
        return None
    if v >= 1e17:              # ns
        v /= 1e9
    elif v >= 1e14:            # µs
        v /= 1e6
    elif v >= 1e11:            # ms（本机 DSH 就是这个量级）
        v /= 1e3
    if not (MIN_EPOCH_S <= v <= MAX_EPOCH_S):
        return None
    return v


def _event_time(ev):
    """Return event time in seconds, accepting epoch s/ms/µs/ns or ISO strings.

    格式变化时的防御：
      - 数字按量级分级识别（秒 / 毫秒 / 微秒 / 纳秒）；
      - 离谱值（0、负数、非本世纪）返回 None，让调用方跳过而不是污染 max()；
      - naive ISO 按 UTC 处理（fromisoformat 出来的 naive 会被当成本地时区）。
    """
    for key in ("ts", "timestamp", "time", "createdAt"):
        value = ev.get(key)
        if value is None:
            value = (ev.get("data") or {}).get(key)
        if value is None or isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return _scale_epoch(value)
        if isinstance(value, str):
            s = value.strip()
            if not s:
                continue
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                dt = None
            if dt is not None:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return _scale_epoch(dt.timestamp())
            try:
                return _scale_epoch(float(s))
            except ValueError:
                pass
    return None


def analyze(events, steps_threshold, window_s=600):
    events = list(events)
    calls = {}          # callId -> {name, args, seq, turn, step}
    m1_streak = {}      # command hash -> [out_sig, count, last_ts]
    last_m1_cmd = None
    m1_hits = []
    edits = {}          # file_path -> [(old_h, new_h, seq, turn)]
    writes = {}         # file_path -> [(content_h, seq, turn)]  M2 的 write 独立路径
    m2_hits = []
    step_sig = {}       # (turn, step) -> [result_texts]
    step_wait = set()   # (turn, step) 只含等待类调用
    n_ev = 0

    for ev in events:
        n_ev += 1
        typ = ev.get("type")
        data = ev.get("data") or {}
        if typ == "tool/call":
            cid = data.get("callId")
            calls[cid] = {
                "name": data.get("name"),
                "args": data.get("arguments"),
                "turn": data.get("turn"),
                "step": data.get("step"),
                "seq": ev.get("seq"),
            }
        elif typ == "tool/result":
            cid = data.get("toolCallId") or (data.get("message") or {}).get("toolCallId")
            call = calls.get(cid)
            if not call:
                continue
            key = (call["turn"], call["step"])
            msg = data.get("message") or {}
            content = msg.get("content") or []
            text = ""
            if isinstance(content, list) and content:
                c0 = content[0]
                text = c0.get("text", "") if isinstance(c0, dict) else str(c0)
            step_sig.setdefault(key, []).append(str(text))
            if call["name"] in WAIT_TOOLS:
                step_wait.add(key)

            name = call["name"]
            if name == "bash":
                event_time = _event_time(ev)
                try:
                    args = json.loads(call["args"] or "{}")
                except ValueError:
                    args = {}
                cmd = norm_cmd(args.get("command", ""))
                ck = h(cmd)
                # 判据：同一规范命令 + 完全相同的输出，连续出现 >= 2。
                # 不依赖退出码 —— 2026-10-31 实测：DSH 的 bash 结果**只在非 0 时**追加
                # `[exit code: N]`；而末条是 echo 之类的命令会把整体退出码变成 0（于是不标记），
                # 单靠退出码会漏掉「成功但输出一字未变」的重复。输出本身会变的命令
                # （date / ps / ls 变化目录）自然不命中。
                out_sig = h(norm_err(str(text))[:2000])
                # M1 is continuous: any different command breaks the streak.
                if last_m1_cmd != ck:
                    m1_streak.clear()
                last_m1_cmd = ck
                prev = m1_streak.get(ck)
                # 局部时间窗：只比「本次」与「上一次同命令同输出」的间隔，
                # 不再用 max(known) - window 当锚 —— 否则隔一阵才回看就只看得到末尾。
                too_far = (
                    prev is not None
                    and event_time is not None
                    and prev[2] is not None
                    and (event_time - prev[2]) >= window_s
                )
                if prev and prev[0] == out_sig and not too_far:
                    prev[1] += 1
                    gap = (event_time - prev[2]) if (event_time is not None and prev[2] is not None) else None
                    if event_time is not None:
                        prev[2] = event_time
                    if prev[1] >= 2:
                        m1_hits.append({
                            "cmd": cmd[:160],
                            "turn": call["turn"],
                            "step": call["step"],
                            "count": prev[1],
                            "gap_s": None if gap is None else round(gap, 3),
                            "seq": ev.get("seq"),
                        })
                        m1_streak[ck] = [out_sig, 0, prev[2]]
                else:
                    m1_streak[ck] = [out_sig, 1, event_time]
            elif name == "edit":
                try:
                    args = json.loads(call["args"] or "{}")
                except ValueError:
                    args = {}
                fp = args.get("file_path") or args.get("path") or "?"
                oh, nh = h(str(args.get("old_string", ""))), h(str(args.get("new_string", "")))
                lst = edits.setdefault(fp, [])
                lst.append((oh, nh, ev.get("seq"), call["turn"]))
                if len(lst) >= 2:
                    a, b = lst[-2], lst[-1]
                    if a[0] == b[1] and a[1] == b[0]:
                        m2_hits.append({
                            "file": fp,
                            "kind": "edit",
                            "turn": call["turn"],
                            "step": call["step"],
                            "seq": ev.get("seq"),
                        })
                        lst.pop()   # 计一次就够，避免连环重复报
            elif name == "write":
                # write 没有 old_string，套 ABA 会误判（新内容与旧内容无对偶关系），
                # 所以单独按 file_path 记 content 哈希序列：A -> B -> A 才算循环。
                try:
                    args = json.loads(call["args"] or "{}")
                except ValueError:
                    args = {}
                fp = args.get("file_path") or args.get("path") or "?"
                ch = h(str(args.get("content", "")))
                lst = writes.setdefault(fp, [])
                lst.append((ch, ev.get("seq"), call["turn"]))
                if len(lst) >= 3:
                    a, b, c = lst[-3], lst[-2], lst[-1]
                    if a[0] == c[0] and a[0] != b[0]:
                        m2_hits.append({
                            "file": fp,
                            "kind": "write",
                            "turn": call["turn"],
                            "step": call["step"],
                            "seq": ev.get("seq"),
                        })
                        lst.pop()   # 同上：计一次就够

    # M3：按 (turn, step) 顺序看结果内容是否连续不变
    m3_hits = []
    ordered = [k for k in step_sig.keys()]
    if ordered:
        cur = []
        for key in ordered:
            if key in step_wait:
                cur = []
                continue
            sig = h("".join(step_sig[key]))
            if cur and cur[-1][0] == sig:
                cur.append((sig, key))
            else:
                cur = [(sig, key)]
            if len(cur) >= steps_threshold:
                m3_hits.append({"from": cur[0][1], "to": key, "n": len(cur)})
                cur = []

    return {
        "events": n_ev,
        "m1": m1_hits,
        "m2": m2_hits,
        "m3": m3_hits,
    }


def main():
    ap = argparse.ArgumentParser(description="算 DSH 会话的派单机械信号")
    ap.add_argument("--session", help="会话 id 或路径（默认当前目录最新）")
    ap.add_argument("--root", default=SESSIONS_ROOT, help="会话根目录")
    ap.add_argument("--steps", type=int, default=4, help="M3 连续无推进步数阈值（默认 4）")
    ap.add_argument("--window", type=float, default=600, help="M1 时间窗口秒数（默认 600）")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    a = ap.parse_args()

    path = pick_session(a.session, a.root)
    if not path:
        print("[policy-watch] 找不到会话文件", file=sys.stderr)
        return 3

    res = analyze(read_events(path), a.steps, a.window)
    total = len(res["m1"]) + len(res["m2"]) + len(res["m3"])

    if a.json:
        print(json.dumps({"session": os.path.basename(path), **res, "hits": total},
                         ensure_ascii=False, indent=2))
    else:
        print("[policy-watch] session=%s 事件=%d" % (os.path.basename(path), res["events"]))
        print("M1 同命令+同输出连续重复: %d 处" % len(res["m1"]))
        for x in res["m1"]:
            print("   -> turn %s step %s 连续 %d 次: %s" % (x["turn"], x["step"], x["count"], x["cmd"]))
        print("M2 编辑/写入振荡 A->B->A: %d 处" % len(res["m2"]))
        for x in res["m2"]:
            print("   -> %s @turn %s (%s)" % (x["file"], x["turn"], x.get("kind", "edit")))
        print("M3 连续无状态推进 >=%d 步: %d 处" % (a.steps, len(res["m3"])))
        for x in res["m3"]:
            print("   -> turn/step %s 起连续 %d 步无变化" % (x["from"], x["n"]))
        if total:
            print("结论: 命中 %d 条 -> 该派单让第二引擎判「卡在哪」" % total)
        else:
            print("结论: 未命中 -> 继续单干")
    return 10 if total else 0


if __name__ == "__main__":
    sys.exit(main())

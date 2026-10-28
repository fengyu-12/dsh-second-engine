#!/usr/bin/env python3
"""trace_search.py - 检索 Codex 代理的会话记录（rollout-*.jsonl）。

只读工具：不写文件、不删文件、不起子进程、不联网。
纯标准库；流式逐行读，绝不整文件载入内存。

子命令：
  list                       列出会话（session_id / uuid / 起止时间 / cwd / 路径 / 行数）
  search <关键字>            全量或指定会话的逐行大小写不敏感子串检索
  get <session_id> --steps   取出指定会话指定行号的完整原始内容（JSON 缩进打印）

会话定位：--session / <session_id> 同时接受 session_meta.payload.session_id
与文件名中的 uuid（两者通常一致，此处都支持以防元信息缺失）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 单文件单行可能极长（工具输出、base64），逐行读但限制单行读入上限由
# iterate 的 1MB 分块读取保证；下面是"打印"阶段的截断阈值（字符数）。
FIELD_MAX_CHARS = 400        # 递归提取时，单个字符串字段保留的字符数
LINE_MAX_CHARS = 20000       # 归一化后的整行可搜索文本上限（防止内存/输出爆炸）
DEFAULT_CONTEXT = 200        # search 默认打印的文本前缀长度
LONG_RUN_RE = re.compile(r"[A-Za-z0-9+/=]{256,}")  # 疑似 base64 / 长 token

# 凭证模式（协议 §十三.4：命中项疑似凭证只报位置、不复述内容）
_CRED_PREFIX = (
    re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
)
_CRED_KV = re.compile(
    r"(?i)\b(api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?token|"
    r"refresh[_-]?token|authorization|cookie|credential|private[_-]?key)\b"
    r"((?:\s*[:=]\s*|\s+))(\"?)([^\s\"',;}，。；：、]{8,})"
)


def redact(text: str) -> str:
    """把疑似凭证的值打成 ***REDACTED***，保留 key 名与位置。

    口径（与协议 §十三.4 对齐）：只对"看起来是凭证的值"动手，
    不隐藏 key 名、不隐藏所在行号——检索者需要知道"这里出现过凭证"。
    """
    for pat in _CRED_PREFIX:
        text = pat.sub("***REDACTED***", text)
    def _kv(m):
        value = m.group(4)
        # 只打码"像密钥"的值：ASCII、无空白、长度 >= 8；中文普通词/短语一律放过
        if len(value) < 8 or not value.isascii():
            return m.group(0)
        return "%s%s%s***REDACTED***" % (m.group(1), m.group(2), m.group(3))

    return _CRED_KV.sub(_kv, text)


EXIT_OK = 0
EXIT_USAGE = 2       # 参数错误 / 找不到会话 / 目录不存在
EXIT_BAD_INPUT = 3   # 目录结构不可读等输入问题


# ---------------------------------------------------------------- 工具函数


def die(msg: str, code: int = EXIT_USAGE) -> "None":
    """错误路径统一出口：信息走 stderr，非零退出码，绝不抛 traceback。"""
    print("错误: %s" % msg, file=sys.stderr)
    raise SystemExit(code)


def norm_text(value: object) -> str:
    """把任意 JSON 值归一化成"可搜索文本"（递归、稳健、带截断）。

    设计取舍：
    - dict：只保留 key 与 value 的文本，不输出结构符号，让检索命中更像自然文本；
    - list：空格拼接（保持顺序，便于 `--context` 预览可读）；
    - str：折叠连续空白为单个空格（payload 里大量内嵌 JSON 带换行/缩进，
      不折叠的话预览会刷屏，且跨行内容无法在一行里看到）；
    - 超长字符串按 FIELD_MAX_CHARS 截断并标注省略字数；
    - 疑似 base64/长 token 的连续段单独压成 <blob:N chars>，避免整段刷屏；
    - bool/None/数字转字符串，None 跳过（不引入 "None" 噪声）。
    """
    parts: list[str] = []

    def walk(node: object, depth: int) -> None:
        if len(parts) >= 4000 or depth > 24:
            return
        if node is None:
            return
        if isinstance(node, str):
            s = " ".join(node.split())
            if not s:
                return
            if len(s) > FIELD_MAX_CHARS:
                s = s[:FIELD_MAX_CHARS] + "…[截断,原长%d]" % len(s)
            s = LONG_RUN_RE.sub(lambda m: "<blob:%d chars>" % len(m.group(0)), s)
            s = redact(s)
            parts.append(s)
        elif isinstance(node, bool):
            parts.append("true" if node else "false")
        elif isinstance(node, (int, float)):
            parts.append(str(node))
        elif isinstance(node, dict):
            for k, v in node.items():
                if isinstance(k, str) and k:
                    parts.append(k)
                walk(v, depth + 1)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v, depth + 1)
        else:  # 兜底：未知类型一律 str()，保证永不抛异常
            parts.append(str(node))

    walk(value, 0)
    text = " ".join(parts)
    if len(text) > LINE_MAX_CHARS:
        text = text[:LINE_MAX_CHARS] + "…[行截断]"
    # 整段再脱敏一次：key 与 value 在 parts 里是两段，拼接后才相邻（JSON 拍平后即 "password <值>"）
    return redact(text)


def uuid_from_name(path: str) -> str:
    """rollout-2026-09-22T14-20-58-<uuid>.jsonl -> <uuid>"""
    stem = os.path.basename(path)[: -len(".jsonl")] if path.endswith(".jsonl") else os.path.basename(path)
    m = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                  r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$", stem)
    return m.group(1) if m else ""


def discover(root: str) -> list[str]:
    """递归找 <root>/**/rollout-*.jsonl，按路径排序（稳定输出）。"""
    if not os.path.isdir(root):
        die("会话根目录不存在或不是目录: %s" % root, EXIT_BAD_INPUT)
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.startswith("rollout-") and name.endswith(".jsonl"):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def iter_lines(path: str, max_line: int):
    """流式逐行读。

    - errors="replace"：坏字节不致命（替换成 U+FFD），宁可少几个字符也不整文件报错；
    - newline=None 由文本层处理换行；
    - 单行超过 max_line 时丢弃剩余部分（skip_long_line），保证 O(1) 内存。
    产出 (lineno, line_or_None)；line 为 None 表示该行超长被丢弃。
    """
    lineno = 0
    with open(path, "r", encoding="utf-8", errors="replace", newline=None) as fh:
        buf = ""
        pending = False
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                if pending:
                    lineno += 1
                    yield lineno, None
                elif buf:
                    # 文件末尾没有换行：这一行同样是真实存在的一行，必须计入
                    # （rollout 被 kill 时最常见就是这种截断尾行；旧版会整行漏掉）
                    lineno += 1
                    yield (lineno, None) if len(buf) > max_line else (lineno, buf)
                break
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                lineno += 1
                if len(line) > max_line:
                    yield lineno, None
                else:
                    yield lineno, line
            pending = buf != "" and len(buf) > max_line
            if pending:
                buf = ""


def parse_line(line: str):
    """解析一行 JSON；失败返回 (None, None, 原因)。

    顶层键固定为 timestamp / ordinal / type / payload，但缺失时不报错，
    取默认值继续——检索工具的可用性优先于严格性。
    """
    try:
        obj = json.loads(line)
    except Exception as exc:  # json.JSONDecodeError 及其子类
        return None, None, "%s" % exc
    if not isinstance(obj, dict):
        return None, None, "顶层不是对象(%s)" % type(obj).__name__
    return obj.get("type") or "?", obj, None


def file_meta(path: str) -> dict:
    """扫一遍文件，得到 session_id / uuid / 起止日期 / 行数 / 坏行数。

    内存：只缓存 session_id / cwd / 日期集合（不缓存 payload 文本），
    因此起止时间取"日期精度"（YYYY-MM-DD）——这已经足够 --since 过滤；
    需要秒级时间戳时用 get 看具体行。
    """
    meta = {
        "path": path,
        "uuid": uuid_from_name(path),
        "session_id": "",
        "cwd": "",
        "model_provider": "",
        "dates": set(),
        "lines": 0,
        "bad_lines": 0,
    }
    for lineno, line in iter_lines(path, max_line=1 << 20):
        meta["lines"] = lineno
        if line is None:
            meta["bad_lines"] += 1
            continue
        _type, obj, err = parse_line(line)
        if err or obj is None:
            meta["bad_lines"] += 1
            continue
        ts = obj.get("timestamp")
        if isinstance(ts, str) and len(ts) >= 10:
            meta["dates"].add(ts[:10])
        if _type == "session_meta":
            payload = obj.get("payload")
            if isinstance(payload, dict):
                sid = payload.get("session_id")
                if isinstance(sid, str) and sid:
                    meta["session_id"] = sid
                cwd = payload.get("cwd")
                if isinstance(cwd, str) and cwd:
                    meta["cwd"] = cwd
                mp = payload.get("model_provider")
                if isinstance(mp, str) and mp:
                    meta["model_provider"] = mp
    if not meta["session_id"]:
        # 元信息缺失/损坏时退回文件名 uuid，保证 list 仍可定位该文件。
        meta["session_id"] = meta["uuid"]
    dates = sorted(meta["dates"])
    meta["first_date"] = dates[0] if dates else ""
    meta["last_date"] = dates[-1] if dates else ""
    del meta["dates"]
    return meta


def scan_sessions(root: str, since: str | None, cwd_sub: str | None,
                  session: str | None = None) -> list[dict]:
    """遍历会话文件并按 --since / --cwd / --session 过滤。"""
    out: list[dict] = []
    for path in discover(root):
        meta = file_meta(path)
        if session:
            if session not in (meta["session_id"], meta["uuid"]) and \
               meta["session_id"].lower() != session.lower() and \
               meta["uuid"].lower() != session.lower():
                continue
        if since:
            # 日期比较用 ISO 字典序；会话任一天的记录 >= since 即保留。
            if not meta["last_date"] or meta["last_date"] < since:
                continue
        if cwd_sub and cwd_sub not in meta["cwd"]:
            continue
        out.append(meta)
    return out


# ---------------------------------------------------------------- 子命令


def cmd_list(a: argparse.Namespace) -> None:
    sessions = scan_sessions(a.sessions_root, a.since, a.cwd)
    if not sessions:
        print("未找到会话（root=%s%s%s）" % (
            a.sessions_root,
            "，--since=%s" % a.since if a.since else "",
            "，--cwd=%s" % a.cwd if a.cwd else "",
        ))
        return
    if a.json:
        print(json.dumps({"root": a.sessions_root, "count": len(sessions),
                          "sessions": sessions}, ensure_ascii=False, indent=2))
        return
    print("%-3s %-40s %-40s %-12s %-12s %8s %8s  %s" % (
        "#", "session_id", "uuid(文件名)", "first_date", "last_date", "lines", "bad", "cwd"))
    for i, m in enumerate(sessions, 1):
        print("%-3d %-40s %-40s %-12s %-12s %8d %8d  %s" % (
            i, m["session_id"] or "-", m["uuid"] or "-",
            m["first_date"] or "-", m["last_date"] or "-",
            m["lines"], m["bad_lines"], m["cwd"] or "-"))
        print("     path: %s" % m["path"])
    print("\n共 %d 个会话" % len(sessions))


def cmd_search(a: argparse.Namespace) -> None:
    needle = a.keyword.lower()
    if not needle:
        die("关键字不能为空")
    exclude = {s.lower() for s in (a.exclude_session or [])}
    sessions = scan_sessions(a.sessions_root, a.since, a.cwd, a.session)
    if a.session and not sessions:
        die("找不到会话: %s（先用 list 查 session_id 或文件名 uuid）" % a.session)
    if exclude:
        sessions = [m for m in sessions
                    if m["session_id"].lower() not in exclude
                    and m["uuid"].lower() not in exclude]
    if not sessions:
        print("没有可检索的会话（可能被 --exclude-session 全部排除）")
        return

    width = max(16, a.context)
    total_hits = 0
    hit_sessions = 0
    records = [] if a.json else None

    for meta in sessions:
        hits = []
        for lineno, line in iter_lines(meta["path"], max_line=a.max_line):
            if line is None:
                continue
            _type, obj, err = parse_line(line)
            if err or obj is None:
                continue  # 坏行：跳过（list 里已按 bad 列汇总，避免逐行刷屏）
            text = norm_text(obj.get("payload"))
            if needle not in text.lower() and needle not in line.lower():
                continue
            shown = text[:width] + ("…" if len(text) > width else "")
            hits.append({"lineno": lineno, "type": _type, "text": shown})
        if hits:
            hit_sessions += 1
            total_hits += len(hits)
            if a.json:
                records.append({
                    "session_id": meta["session_id"], "uuid": meta["uuid"],
                    "path": meta["path"], "cwd": meta["cwd"], "hits": hits,
                })
            else:
                print("=== session_id=%s uuid=%s lines=%d cwd=%s" % (
                    meta["session_id"], meta["uuid"], meta["lines"], meta["cwd"] or "-"))
                print("    path=%s" % meta["path"])
                for h in hits:
                    print("  L%-6d %-13s %s" % (h["lineno"], h["type"], h["text"]))
    if a.json:
        print(json.dumps({"keyword": a.keyword, "root": a.sessions_root,
                          "session_hits": hit_sessions, "line_hits": total_hits,
                          "results": records}, ensure_ascii=False, indent=2))
    else:
        print("\n命中 %d 行，涉及 %d 个会话（关键字=%r）" % (total_hits, hit_sessions, a.keyword))


def cmd_get(a: argparse.Namespace) -> None:
    wanted: list[int] = []
    for token in a.steps.split(","):
        token = token.strip()
        if not token:
            continue
        if not token.isdigit():
            die("--steps 只接受逗号分隔的 1-based 行号，例如 3,7,12（收到 %r）" % token)
        wanted.append(int(token))
    if not wanted:
        die("--steps 不能为空，例如 --steps 3,7,12")
    wanted_set = set(wanted)
    max_want = max(wanted_set)

    sessions = scan_sessions(a.sessions_root, None, None, a.session_id)
    if not sessions:
        die("找不到会话: %s（list 输出里的 session_id 或文件名 uuid 都可用）" % a.session_id)
    if len(sessions) > 1:  # 理论上 uuid 唯一；真撞上就报错而不是猜
        die("session_id=%s 匹配到 %d 个文件，请用更精确的 id" % (a.session_id, len(sessions)))
    meta = sessions[0]

    found: dict[int, tuple[str, object]] = {}
    for lineno, line in iter_lines(meta["path"], max_line=a.max_line):
        if lineno not in wanted_set:
            if lineno > max_want:
                break          # 目标行都取完了，提前结束，不白读整个大文件
            continue
        if line is None:
            found[lineno] = ("超长行（>%d 字符）已按流式上限跳过" % a.max_line, None)
        else:
            _type, obj, err = parse_line(line)
            if err:
                found[lineno] = ("该行 JSON 解析失败: %s" % err, line)
            else:
                found[lineno] = ("ok", obj)
        if len(found) == len(wanted_set):
            break

    print("session_id=%s uuid=%s" % (meta["session_id"], meta["uuid"]))
    print("path=%s lines=%d cwd=%s" % (meta["path"], meta["lines"], meta["cwd"] or "-"))
    for lineno in wanted:
        print("\n---- line %d ----" % lineno)
        if lineno not in found:
            print("（该行不存在：会话共 %d 行）" % meta["lines"])
            continue
        status, obj = found[lineno]
        if status != "ok":
            print("（%s）" % status)
            if isinstance(obj, str):
                print(obj[: a.context if a.context > 0 else len(obj)])
            continue
        print(json.dumps(obj, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 入口


def add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--sessions-root", required=True,
                   help="会话根目录（其下 **/rollout-*.jsonl）；必填，无默认路径、无环境变量")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="trace_search.py",
        description="检索 Codex 代理会话记录（rollout-*.jsonl），只读、流式、纯标准库。",
    )
    sub = ap.add_subparsers(dest="cmd", metavar="{list,search,get}")
    sub.required = True

    p = sub.add_parser("list", help="列出会话：session_id/uuid/起止时间/cwd/路径/行数")
    add_common(p)
    p.add_argument("--since", metavar="YYYY-MM-DD", help="只列最后活动日期 >= 该日期的会话")
    p.add_argument("--cwd", metavar="SUBSTR", help="只列 cwd 含该子串的会话")
    p.add_argument("--json", action="store_true", help="以 JSON 打印（便于脚本消费）")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="逐行大小写不敏感子串检索")
    add_common(p)
    p.add_argument("keyword", help="关键字（大小写不敏感的子串）")
    p.add_argument("--session", metavar="ID_OR_UUID", help="只检索该会话")
    p.add_argument("--exclude-session", metavar="ID_OR_UUID", action="append",
                   help="排除该会话（可重复；用于自动排除自己当前会话）")
    p.add_argument("--since", metavar="YYYY-MM-DD", help="只列最后活动日期 >= 该日期的会话")
    p.add_argument("--cwd", metavar="SUBSTR")
    p.add_argument("--context", type=int, default=DEFAULT_CONTEXT,
                   help="命中行可搜索文本前 N 字符（默认 %d）" % DEFAULT_CONTEXT)
    p.add_argument("--max-line", type=int, default=1 << 20,
                   help="单行读入上限字符数，超长行跳过（默认 1048576）")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("get", help="取指定会话指定行号的完整原始内容")
    add_common(p)
    p.add_argument("session_id", metavar="session_id", help="session_id 或文件名 uuid")
    p.add_argument("--steps", required=True, metavar="3,7,12",
                   help="逗号分隔的 1-based 行号")
    p.add_argument("--max-line", type=int, default=1 << 20)
    p.add_argument("--context", type=int, default=0,
                   help="坏行降级预览的前 N 字符（0=不预览）")
    p.set_defaults(func=cmd_get)
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    a = ap.parse_args(argv)
    ctx = getattr(a, "context", None)
    if ctx is not None and ctx < 0:
        die("--context 不能为负数")
    ml = getattr(a, "max_line", None)
    if ml is not None and ml < 128:
        die("--max-line 至少 128")
    if getattr(a, "since", None):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.since):
            die("--since 需要 YYYY-MM-DD 格式（收到 %r）" % a.since)
    try:
        a.func(a)
    except OSError as exc:
        die("读取失败: %s" % exc, EXIT_BAD_INPUT)
    except BrokenPipeError:  # 支持 `| head`
        raise SystemExit(EXIT_OK)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())

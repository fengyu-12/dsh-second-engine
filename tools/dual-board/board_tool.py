#!/usr/bin/env python3
"""dual-board 看板操作工具（唯一合法写板通道）· v1.2

设计目标：把 PROTOCOL.md §2 的「读 revision → O_EXCL 建锁 → 写 → revision+1 → 删锁」
从"靠双方 LLM 自觉执行"固化成代码，任何一方写 board.json 都必须经过本工具。

v1.2 变更（2026-09-27，lead 裁决后落地）：
  - 移除 reopen：completed 不可复改（采纳 codex 提案 ②），任务出问题开新任务引用旧任务
  - 归档改 JSONL：archive/tasks-YYYY-MM.jsonl + archive/inbox-<who>-YYYY-MM.jsonl（提案 ③）
  - 新增 scope-check：用 dispatch 基线 commit 机械校验 write_scopes 越界（提案 ⑥）
  - 新增 inbox-archive：已读段按月转档
  - 时间基准（裁定）：机器字段一律 ISO-8601 UTC；人类入口（inbox 标题）用北京时间 [MM-DD HH:MM]

退出码约定：
  0 成功 / 1 一般错误 / 2 用法错误 / 3 CAS 冲突（revision 不匹配）
  4 依赖未完成 / 5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 基线（降级未验证）
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time

BOARD_DIR = os.environ.get("DUAL_BOARD_DIR") or os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.join(BOARD_DIR, "board.json")
LOCK = os.path.join(BOARD_DIR, "board.json.lock")
ARCHIVE_DIR = os.path.join(BOARD_DIR, "archive")
DISPATCH_DIR = os.path.join(BOARD_DIR, ".dispatch")
STALE_SEC = 600
LOCK_TRIES = 50          # 50 × 0.1s = 5s
LOCK_SLEEP = 0.1
INBOX = {"codex": "inbox-codex.md", "lead": "inbox-lead.md"}
VALID_STATUS = ("pending", "in_progress", "blocked", "completed", "abandoned")
TERMINAL = ("completed", "abandoned")
TASK_TEMPLATE_KEYS = ("frame", "session", "write_scopes", "blocked_by", "acceptance", "result")
FRAME = "双方都是用户目标的执行者，质疑前提是分内事不是越权。"


# ---------------------------------------------------------------- 基础

def die(code: int, msg: str) -> "None":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def now_utc() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_bj() -> str:
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=8)).strftime("%m-%d %H:%M")


def month_bj() -> str:
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=8)).strftime("%Y-%m")


class _Lock:
    """O_EXCL 锁上下文；超 10 分钟的残留锁视为废弃可接管。"""

    def __enter__(self):
        for _ in range(LOCK_TRIES):
            try:
                fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, f"pid={os.getpid()} ts={time.time():.0f}\n".encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    age = time.time() - os.path.getmtime(LOCK)
                except FileNotFoundError:
                    continue
                if age > STALE_SEC:
                    try:
                        os.unlink(LOCK)
                        print(f"warn: 接管废弃锁（age={int(age)}s）", file=sys.stderr)
                        continue
                    except FileNotFoundError:
                        continue
                time.sleep(LOCK_SLEEP)
        die(6, f"锁等待超时（{LOCK_TRIES * LOCK_SLEEP:.0f}s）：{LOCK} 被占用，请检查是否有残留进程")

    def __exit__(self, *exc):
        try:
            os.unlink(LOCK)
        except FileNotFoundError:
            pass
        return False


def load_board() -> dict:
    if not os.path.exists(BOARD):
        die(1, f"看板不存在：{BOARD}")
    with open(BOARD, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("revision", 0)
    data.setdefault("tasks", [])
    return data


def save_board(data: dict) -> None:
    """原子写：临时文件 + os.replace，避免半截 JSON。"""
    fd, tmp = tempfile.mkstemp(dir=BOARD_DIR, prefix=".board.tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, BOARD)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def find_task(data: dict, task_id: str) -> dict:
    for t in data["tasks"]:
        if t.get("id") == task_id:
            return t
    die(1, f"任务不存在：{task_id}")


def check_cas(data: dict, expect: int | None) -> None:
    if expect is not None and data["revision"] != expect:
        die(3, f"CAS 冲突：期望 revision={expect}，实际 {data['revision']}（请重读看板后重试）")


def check_deps(data: dict, task: dict) -> None:
    done = {t["id"] for t in data["tasks"] if t.get("status") == "completed"}
    missing = [b for b in task.get("blocked_by") or [] if b not in done]
    if missing:
        die(4, f"依赖未完成：{', '.join(missing)}")


def commit(data: dict, entry: str) -> None:
    data["revision"] = int(data.get("revision", 0)) + 1
    print(f"ok: {entry} → revision={data['revision']}")


def fill_template(task: dict) -> dict:
    """补全 §2 模板字段，避免 schema 与实例脱节（v1.1 实证问题）。"""
    task.setdefault("frame", FRAME)
    task.setdefault("session", None)
    task.setdefault("write_scopes", [])
    task.setdefault("blocked_by", [])
    task.setdefault("acceptance", "")
    task.setdefault("result", "")
    return task


# ---------------------------------------------------------------- 子命令

def cmd_new(a) -> None:
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        if any(t.get("id") == a.id for t in data["tasks"]):
            die(1, f"任务 id 已存在：{a.id}")
        task = fill_template({
            "id": a.id,
            "subject": a.subject,
            "task": a.task,
            "context": a.context or "",
            "status": "pending",
            "owner": None,
            "write_scopes": [s for s in (a.scope or "").split(",") if s],
            "blocked_by": [s for s in (a.blocked or "").split(",") if s],
            "acceptance": a.acceptance or "",
            "session": a.session,
            "result": "",
            "updated_at": now_utc(),
        })
        data["tasks"].append(task)
        commit(data, f"新建 {a.id}")
        save_board(data)


def cmd_claim(a) -> None:
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        t = find_task(data, a.id)
        check_deps(data, t)
        if t.get("status") not in ("pending", "blocked"):
            die(5, f"{a.id} 状态为 {t.get('status')}，不可认领")
        t["owner"] = a.owner
        t["status"] = "in_progress"
        t["updated_at"] = now_utc()
        commit(data, f"{a.id} 认领 by {a.owner}")
        save_board(data)


def cmd_complete(a) -> None:
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        t = find_task(data, a.id)
        if t.get("status") in TERMINAL:
            die(5, f"{a.id} 已终结（{t['status']}），completed 不可复改——有问题请开新任务并引用 {a.id}")
        if not a.result.strip():
            die(2, "complete 必须给 --result（产出位置 + 摘要）")
        if t.get("owner") and a.owner and t["owner"] != a.owner and not a.force:
            die(5, f"{a.id} owner 是 {t['owner']}，{a.owner} 无权完成（--force 可覆盖）")
        t["status"] = "completed"
        t["owner"] = t.get("owner") or a.owner
        t["result"] = a.result
        t["updated_at"] = now_utc()
        summary = a.result.strip().splitlines()[0][:120]
        if getattr(a, "keep", False):
            commit(data, f"{a.id} 完成（--keep 保留在板）")
            save_board(data)
            print(f"ok: {a.id} 完成（按要求保留在板）")
            return
        # v1.3 §12.1：完成即出板，板上只留在办/挂起；§12.4：channel 只留窗口
        data["tasks"] = [x for x in data["tasks"] if x.get("id") != a.id]
        commit(data, f"{a.id} 完成（目的达成）· 出板")
        save_board(data)
        _channel_note(f"{a.id} ✔ 目的达成：{summary}")
        removed = _channel_trim(keep=CHANNEL_KEEP, drop_task=a.id)
    print(f"ok: {a.id} 已完成并出板（channel 清理 {removed} 条过程行）；"
          f"结论/教训写 RESTORE（§12.1）")


def cmd_block(a) -> None:
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        t = find_task(data, a.id)
        if t.get("status") in TERMINAL:
            die(5, f"{a.id} 已终结，不可置 blocked")
        t["status"] = "blocked"
        t["result"] = (t.get("result") or "") + f"\n[blocked {now_utc()}] {a.reason}"
        t["updated_at"] = now_utc()
        commit(data, f"{a.id} 置 blocked")
        save_board(data)


def cmd_abandon(a) -> None:
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        t = find_task(data, a.id)
        t["status"] = "abandoned"
        t["result"] = (t.get("result") or "") + f"\n[abandoned {now_utc()}] {a.reason}"
        t["updated_at"] = now_utc()
        commit(data, f"{a.id} 置 abandoned")
        save_board(data)


def cmd_set(a) -> None:
    allow = {"owner", "session", "result", "acceptance", "subject", "context", "status",
             "write_scopes", "blocked_by"}
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        t = find_task(data, a.id)
        for pair in a.pairs:
            if "=" not in pair:
                die(2, f"--field 需 key=value 形式：{pair}")
            k, v = pair.split("=", 1)
            if k not in allow:
                die(2, f"字段不可改：{k}（允许：{', '.join(sorted(allow))}）")
            if k == "status" and v not in VALID_STATUS:
                die(5, f"非法状态：{v}")
            if k == "status" and v == "completed" and t.get("status") in TERMINAL:
                die(5, "completed 不可复改")
            t[k] = [x for x in v.split(",") if x] if k in ("write_scopes", "blocked_by") else v
        t["updated_at"] = now_utc()
        commit(data, f"{a.id} 字段更新")
        save_board(data)


def cmd_show(a) -> None:
    data = load_board()
    tasks = data["tasks"] if not a.id else [find_task(data, a.id)]
    if a.json:
        print(json.dumps({"revision": data["revision"], "tasks": tasks}, ensure_ascii=False, indent=2))
        return
    print(f"revision={data['revision']}  tasks={len(data['tasks'])}")
    for t in tasks:
        print(f"  {t['id']:<6} {t.get('status',''):<12} owner={str(t.get('owner')):<6} "
              f"blocked_by={t.get('blocked_by')}  {t.get('subject','')}")
        if a.id:
            print(f"    task: {t.get('task','')}")
            print(f"    scopes: {t.get('write_scopes')}  session: {t.get('session')}")
            print(f"    acceptance: {t.get('acceptance','')}")
            print(f"    result: {(t.get('result') or '').strip()[:400]}")


def _inbox_path(who: str) -> str:
    return os.path.join(BOARD_DIR, INBOX[who])


def cmd_inbox_append(a) -> None:
    path = _inbox_path(a.who)
    head = f"\n## [{now_bj()}] 来自 {a.sender}\n"
    body = a.text if a.text is not None else sys.stdin.read()
    with open(path, "a", encoding="utf-8") as f:
        f.write(head + body.rstrip("\n") + "\n")
    print(f"ok: 追加到 {INBOX[a.who]}（{a.sender}）")


_SECTION_RE = re.compile(r"^## \[", re.M)


def read_sections(who: str):
    """返回 [(段文本, 是否已读)]，按标题行是否含 [已读] 判定。"""
    path = _inbox_path(who)
    if not os.path.exists(path):
        return []
    text = open(path, encoding="utf-8").read()
    starts = [m.start() for m in _SECTION_RE.finditer(text)]
    out = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else len(text)
        seg = text[s:e].strip()
        out.append((seg, "[已读]" in seg.splitlines()[0]))
    return out


def cmd_inbox_unread(a) -> None:
    segs = [s for s, read in read_sections(a.who) if not read]
    if not segs:
        print(f"（{INBOX[a.who]} 无未读）", file=sys.stderr)
        return
    print("\n\n".join(segs))


def cmd_inbox_read(a) -> None:
    """给未读段标题行追加 [已读] 标注（本工具代劳，避免手改整行出错）。"""
    path = _inbox_path(a.who)
    if not os.path.exists(path):
        die(1, f"收件箱不存在：{path}")
    lines = open(path, encoding="utf-8").read().splitlines(keepends=True)
    marked = 0
    for i, ln in enumerate(lines):
        if ln.startswith("## [") and "[已读]" not in ln:
            if a.match and a.match not in ln:
                continue
            lines[i] = ln.rstrip("\n") + " [已读]\n"
            marked += 1
            if a.match:
                break
    if not marked:
        print("（无未读需标注）", file=sys.stderr)
        return
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"ok: 标注 {marked} 条已读 → {INBOX[a.who]}")


def _append_jsonl(path: str, records: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


CHANNEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "channel.md")
CHANNEL_KEEP = 10


def _bj_stamp() -> str:
    """channel 行首时间戳（§12.4：北京时 + 必须带日期）。"""
    # 注意：本模块导入是 `import datetime as _dt`（别名），写 datetime.xxx 会 NameError —— v1.3 实测踩过
    tz = _dt.timezone(_dt.timedelta(hours=8))
    return _dt.datetime.now(tz).strftime("%m-%d %H:%M")


def _channel_note(text: str, who: str = "lead") -> None:
    with open(CHANNEL, "a", encoding="utf-8") as f:
        f.write(f"[{_bj_stamp()}] {who} ▸ {text}\n")


def _channel_trim(keep: int = CHANNEL_KEEP, drop_task: str | None = None) -> int:
    """channel 窗口化（§12.4）：保留头部说明 + 最近 keep 条事件行（以 `[` 开头）。
    drop_task 指定时先清掉该任务的过程行（完成即清场）。返回移除的事件行数。"""
    if not os.path.exists(CHANNEL):
        return 0
    lines = open(CHANNEL, encoding="utf-8").read().splitlines()
    header = [l for l in lines if not l.startswith("[")]
    events = [l for l in lines if l.startswith("[")]
    before = len(events)
    if drop_task:
        events = [l for l in events if drop_task not in l]
    kept = events[-keep:] if keep > 0 else []
    while header and not header[-1].strip():
        header.pop()
    text = "\n".join(header) + ("\n" if header else "")
    if kept:
        text += "\n".join(kept) + "\n"
    open(CHANNEL, "w", encoding="utf-8").write(text)
    return before - len(kept)


def cmd_reset(a) -> None:
    """回到自然最初（§12.5）：清空 tasks；revision 保持单调递增，绝不归零。"""
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        live = [t for t in data["tasks"] if t.get("status") not in TERMINAL]
        if live and not a.force:
            die(5, "板上还有未终结任务：" + ", ".join(t["id"] for t in live) + "（先完成/挂起/放弃，或 --force）")
        n = len(data["tasks"])
        data["tasks"] = []
        data["epoch"] = int(data.get("epoch", 1)) + 1
        commit(data, f"reset：清空 {n} 条任务，epoch={data['epoch']}（revision 单调保留）")
        save_board(data)
        epoch = data["epoch"]
    print(f"ok: 看板回到最初（tasks=0，epoch={epoch}，revision 单调保留）")


def cmd_channel_trim(a) -> None:
    """手动把 channel 归到窗口大小（§12.4）。"""
    removed = _channel_trim(keep=a.keep, drop_task=a.drop_task)
    print(f"ok: channel 移除 {removed} 条，保留最近 {a.keep} 条")


def cmd_archive(a) -> None:
    """把 before 之前终结的任务转档为 archive/tasks-YYYY-MM.jsonl。"""
    if not a.before:
        die(2, "archive 必须给 --before <ISO时间>（只归档该时间之前终结的任务）")
    month = a.month or month_bj()
    base = os.path.basename(BOARD)
    with _Lock():
        data = load_board()
        check_cas(data, a.expect)
        keep, moved = [], []
        for t in data["tasks"]:
            if t.get("status") in TERMINAL and (t.get("updated_at") or "") < a.before:
                moved.append(t)
            else:
                keep.append(t)
        if not moved:
            print("（无符合条件的终结任务，看板未改动）", file=sys.stderr)
            return
        # 先落档案（append-only JSONL），成功后再从活跃看板移除
        _append_jsonl(os.path.join(ARCHIVE_DIR, f"tasks-{month}.jsonl"),
                      [dict(t, archived_at=now_utc()) for t in moved])
        data["tasks"] = keep
        commit(data, f"归档 {len(moved)} 条（{base}）→ archive/tasks-{month}.jsonl")
        save_board(data)
    print(f"ok: {len(moved)} 条已转档 archive/tasks-{month}.jsonl：{', '.join(t['id'] for t in moved)}")


def cmd_inbox_archive(a) -> None:
    """把某收件箱里已读的段转档，正文按月切 JSONL，活跃文件只留未读。"""
    month = a.month or month_bj()
    path = _inbox_path(a.who)
    if not os.path.exists(path):
        die(1, f"收件箱不存在：{path}")
    text = open(path, encoding="utf-8").read()
    starts = [m.start() for m in _SECTION_RE.finditer(text)]
    if not starts:
        print("（收件箱无消息段）", file=sys.stderr)
        return
    head = text[:starts[0]]
    keep_segs, moved_segs = [], []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else len(text)
        seg = text[s:e]
        (moved_segs if "[已读]" in seg.splitlines()[0] else keep_segs).append(seg)
    if not moved_segs:
        print("（无已读段可归档）", file=sys.stderr)
        return
    _append_jsonl(os.path.join(ARCHIVE_DIR, f"inbox-{a.who}-{month}.jsonl"),
                  [{"archived_at": now_utc(), "content": seg.strip()} for seg in moved_segs])
    with open(path, "w", encoding="utf-8") as f:
        f.write(head.rstrip("\n") + ("\n\n" if head.strip() else "") + "\n".join(
            s.strip() for s in keep_segs) + ("\n" if keep_segs else ""))
    print(f"ok: {len(moved_segs)} 段已读转档 archive/inbox-{a.who}-{month}.jsonl")


def _scope_hashes_now(workdir: str, scopes) -> dict:
    """交付后重算 write_scopes 覆盖文件的 sha256（与 dispatch 侧快照同构）。

    #4：脏工作区下 git 分不清「派单前就脏」与「派单后又被改」，哈希可以。
    """
    out = {}
    wd = os.path.abspath(workdir)
    for s in scopes or []:
        base = s if os.path.isabs(s) else os.path.join(wd, s)
        files = []
        if os.path.isfile(base):
            files = [base]
        elif os.path.isdir(base):
            for root, dirs, names in os.walk(base):
                dirs[:] = [d for d in dirs if d != ".git"]
                files.extend(os.path.join(root, n) for n in names)
        for f in files:
            try:
                rel = os.path.relpath(f, wd).replace(os.sep, "/")
                with open(f, "rb") as fh:
                    out[rel] = hashlib.sha256(fh.read()).hexdigest()
            except OSError:
                continue
    return out


def _load_base_record(task_id: str):
    """读 .dispatch/<id>.base；v1.2 为 JSON，v1.1 为纯 commit 行（兼容）。"""
    path = os.path.join(DISPATCH_DIR, f"{task_id}.base")
    if not os.path.exists(path):
        return None
    raw = open(path, encoding="utf-8").read().strip()
    try:
        rec = json.loads(raw)
        return {"commit": rec.get("commit"), "write_scopes": rec.get("write_scopes") or [],
                "workdir": rec.get("workdir"), "dirty_before": rec.get("dirty_before") or []}
    except json.JSONDecodeError:
        return {"commit": raw.splitlines()[0] if raw else None, "write_scopes": [],
                "workdir": None, "dirty_before": []}


def cmd_scope_check(a) -> None:
    """用 dispatch 基线 commit + write_scopes 机械校验越界（提案 ⑥）。

    变更集 = 已跟踪文件改动（git diff）∪ 未跟踪新增（git ls-files --others）
             减去派单前就存在的脏文件（.base 的 dirty_before）。
    只查 git diff 会漏掉新建文件——这是本工具首版实测的假通过。
    """
    rec = _load_base_record(a.id)
    if rec is None:
        die(1, f"无派单基线记录：{DISPATCH_DIR}/{a.id}.base（未经 dispatch.sh 派单或记录缺失）")
    data = load_board()
    task = next((t for t in data["tasks"] if t.get("id") == a.id), None)
    workdir = a.workdir or rec.get("workdir") or "."
    scopes = rec.get("write_scopes") or (task or {}).get("write_scopes") or []
    commit = rec.get("commit")
    scope_hashes = rec.get("scope_hashes") or {}
    no_git = (not commit) or commit == "no-git"
    if no_git and not scope_hashes:
        print("warn: workdir 无 git 基线且派单时无哈希快照，scope 校验降级为『未验证』", file=sys.stderr)
        sys.exit(8)
    if no_git:
        print("warn: workdir 无 git 基线，本次改用派单时的 sha256 快照校验", file=sys.stderr)

    def git(*args) -> str:
        r = subprocess.run(["git", "-C", workdir, "-c", "core.quotepath=false", *args],
                           capture_output=True, text=True)
        if r.returncode != 0:
            die(1, f"git {' '.join(args)} 失败（workdir={workdir}）：{r.stderr.strip()}")
        return r.stdout

    def unquote(p: str) -> str:
        """git 对含特殊字符的路径会加引号；quotepath=false 时中文已是原文。"""
        p = p.strip()
        if not (p.startswith('"') and p.endswith('"') and len(p) >= 2):
            return p
        raw, out, i = p[1:-1], bytearray(), 0
        simple = {"n": 10, "t": 9, "\\": 92, '"': 34, "a": 7, "b": 8, "f": 12, "r": 13, "v": 11}
        while i < len(raw):
            c = raw[i]
            if c == "\\" and raw[i + 1:i + 4].isdigit() and len(raw[i + 1:i + 4]) == 3:
                out.append(int(raw[i + 1:i + 4], 8)); i += 4
            elif c == "\\" and i + 1 < len(raw):
                out.append(simple.get(raw[i + 1], ord(raw[i + 1]))); i += 2
            else:
                out.extend(c.encode()); i += 1
        return out.decode("utf-8", "replace")

    def paths(out: str) -> set:
        return {unquote(x) for x in out.splitlines() if x.strip()}

    tracked, untracked = set(), set()
    if not no_git:
        tracked = paths(git("diff", "--name-only", commit, "--"))
        untracked = paths(git("ls-files", "--others", "--exclude-standard"))
    dirty_before = set(rec.get("dirty_before") or [])
    # .dispatch 基线文件与锁是派单/写板工具自身产物，不算任务产出
    # 协议授权的管理/通讯文件不算任务产出（工具自身产物 + 双方共写通讯件）。
    # 注意：git 给的路径是相对 workdir 的，可能是 "dual-board/xxx" —— 必须按看板目录
    # 相对 workdir 的真实前缀匹配，否则白名单形同虚设（v1.3 实测踩过）。
    # PROTOCOL.md 与 proposals/ 故意不放行——改协议须双方确认，越界就该报。
    board_rel = os.path.relpath(os.path.dirname(os.path.abspath(__file__)),
                                os.path.abspath(workdir)).replace(os.sep, "/")
    managed_prefixes = (f"{board_rel}/.dispatch/", f"{board_rel}/archive/")
    managed_files = {f"{board_rel}/{n}" for n in
                     ("board.json", "board.json.lock", "channel.md",
                      "inbox-codex.md", "inbox-lead.md")}
    # #4：派单时的 sha256 快照 —— 捞回「派单前就脏、派单后又被改」的真实改动。
    # 这类文件会被 dirty_before 整批排除，正是协议 §十一 记录的漏报来源。
    hash_changed = set()
    if scope_hashes:
        now_hashes = _scope_hashes_now(workdir, scopes)
        hash_changed = {p for p in set(scope_hashes) | set(now_hashes)
                        if scope_hashes.get(p) != now_hashes.get(p)}
    changed_set = (tracked | untracked) - dirty_before
    changed_set |= hash_changed
    changed = sorted(p for p in changed_set
                     if not p.startswith(managed_prefixes) and p not in managed_files)

    scopes_abs = [os.path.abspath(s if os.path.isabs(s) else os.path.join(workdir, s)) for s in scopes]
    violations, inside = [], []
    for c in changed:
        p = os.path.abspath(os.path.join(workdir, c))
        ok = any(p == s or p.startswith(s.rstrip("/") + "/") for s in scopes_abs)
        (inside if ok else violations).append(c)
    skipped = sorted(((tracked | untracked) & dirty_before) - hash_changed)
    print(f"task={a.id} workdir={workdir} baseline={commit[:12]} scopes={scopes}")
    for c in inside:
        print(f"  ✓ {c}")
    for c in violations:
        print(f"  ✗ 越界 {c}")
    for c in skipped:
        print(f"  · 派单前已脏，不计：{c}")
    if not scopes:
        print("warn: 该任务未列 write_scopes —— 按协议「没有列出 = 只读」，任何变更都算越界", file=sys.stderr)
    print(f"本次变更 {len(changed)} 个，越界 {len(violations)} 个")
    sys.exit(7 if violations else 0)


def cmd_doctor(a) -> None:
    """体检：锁残留 / schema 缺字段 / 状态与 owner 不一致 / revision 类型。"""
    problems = []
    if os.path.exists(LOCK):
        age = int(time.time() - os.path.getmtime(LOCK))
        problems.append(f"残留锁 board.json.lock（age={age}s，>600s 可自动接管）")
    data = load_board()
    if not isinstance(data.get("revision"), int):
        problems.append(f"revision 非整数：{data.get('revision')!r}")
    seen = set()
    for t in data["tasks"]:
        tid = t.get("id")
        if tid in seen:
            problems.append(f"重复 id：{tid}")
        seen.add(tid)
        for k in TASK_TEMPLATE_KEYS:
            if k not in t:
                problems.append(f"{tid} 缺字段 `{k}`（v1.1 实证的 schema 脱节，v1.2 起 new 自动补全）")
        st = t.get("status")
        if st not in VALID_STATUS:
            problems.append(f"{tid} 非法状态：{st!r}")
        if st == "in_progress" and not t.get("owner"):
            problems.append(f"{tid} in_progress 但无 owner")
        if st == "completed" and not (t.get("result") or "").strip():
            problems.append(f"{tid} completed 但 result 为空")
    print(f"board: revision={data['revision']} tasks={len(data['tasks'])}")
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("体检通过：无问题")


# ---------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="board.sh", description="dual-board 看板操作工具（唯一合法写板通道）· v1.2")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_cas(sp):
        sp.add_argument("--expect", type=int, default=None, help="CAS 期望 revision（不匹配则退出码 3）")

    sp = sub.add_parser("new", help="新建任务")
    sp.add_argument("id"); sp.add_argument("--subject", required=True)
    sp.add_argument("--task", required=True); sp.add_argument("--context", default="")
    sp.add_argument("--scope", default=""); sp.add_argument("--blocked", default="")
    sp.add_argument("--acceptance", default=""); sp.add_argument("--session", default=None)
    add_cas(sp); sp.set_defaults(func=cmd_new)

    sp = sub.add_parser("claim", help="认领（设 owner + in_progress）")
    sp.add_argument("id"); sp.add_argument("--owner", required=True, choices=["lead", "codex"])
    add_cas(sp); sp.set_defaults(func=cmd_claim)

    sp = sub.add_parser("complete", help="完成（目的达成 → 出板；v1.3）")
    sp.add_argument("id"); sp.add_argument("--owner", choices=["lead", "codex"])
    sp.add_argument("--result", required=True); sp.add_argument("--force", action="store_true")
    sp.add_argument("--keep", action="store_true", help="保留在板（默认完成即出板）")
    add_cas(sp); sp.set_defaults(func=cmd_complete)

    sp = sub.add_parser("reset", help="回到自然最初：清空 tasks（revision 单调不归零）")
    sp.add_argument("--force", action="store_true", help="有未终结任务时也强制清")
    add_cas(sp); sp.set_defaults(func=cmd_reset)

    sp = sub.add_parser("channel-trim", help="channel 窗口化（只留最近 N 条）")
    sp.add_argument("--keep", type=int, default=10)
    sp.add_argument("--drop-task", default=None, help="同时清掉含该任务 id 的过程行")
    sp.set_defaults(func=cmd_channel_trim)

    sp = sub.add_parser("block", help="置 blocked（卡点）")
    sp.add_argument("id"); sp.add_argument("--reason", required=True); add_cas(sp)
    sp.set_defaults(func=cmd_block)

    sp = sub.add_parser("abandon", help="置 abandoned（放弃，终态）")
    sp.add_argument("id"); sp.add_argument("--reason", required=True); add_cas(sp)
    sp.set_defaults(func=cmd_abandon)

    sp = sub.add_parser("set", help="更新字段 key=value")
    sp.add_argument("id"); sp.add_argument("pairs", nargs="+"); add_cas(sp)
    sp.set_defaults(func=cmd_set)

    sp = sub.add_parser("show", help="查看看板/单任务")
    sp.add_argument("id", nargs="?"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("inbox-append", help="向收件箱追加消息")
    sp.add_argument("who", choices=["codex", "lead"])
    sp.add_argument("--sender", required=True, choices=["lead", "codex"])
    sp.add_argument("--text", default=None, help="缺省读 stdin")
    sp.set_defaults(func=cmd_inbox_append)

    sp = sub.add_parser("inbox-unread", help="打印未读段（供 dispatch.sh 注入）")
    sp.add_argument("who", choices=["codex", "lead"]); sp.set_defaults(func=cmd_inbox_unread)

    sp = sub.add_parser("inbox-read", help="给未读段标注 [已读]")
    sp.add_argument("who", choices=["codex", "lead"]); sp.add_argument("--match", default=None)
    sp.set_defaults(func=cmd_inbox_read)

    sp = sub.add_parser("inbox-archive", help="已读段转档 archive/inbox-<who>-YYYY-MM.jsonl")
    sp.add_argument("who", choices=["codex", "lead"]); sp.add_argument("--month", default=None)
    sp.set_defaults(func=cmd_inbox_archive)

    sp = sub.add_parser("archive", help="终结任务转档 archive/tasks-YYYY-MM.jsonl")
    sp.add_argument("--before", required=False, help="ISO 时间；只归档该时间之前终结的")
    sp.add_argument("--month", default=None)
    add_cas(sp); sp.set_defaults(func=cmd_archive)

    sp = sub.add_parser("scope-check", help="按派单基线校验 write_scopes 越界（越界退出码 7）")
    sp.add_argument("id"); sp.add_argument("--workdir", default=None)
    sp.set_defaults(func=cmd_scope_check)

    sp = sub.add_parser("doctor", help="看板体检")
    sp.set_defaults(func=cmd_doctor)
    return p


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

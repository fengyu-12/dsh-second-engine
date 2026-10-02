#!/usr/bin/env bash
# dual-board 派单 wrapper（v1.2）—— 由 board.sh 生态配套使用
#
# 作用：派单前自动做三件事，避免"协议写了但没人执行"：
#   1) 注入 inbox-codex.md 的全部未读段（解决「Codex 被动唤醒看不到留言」）
#   2) 附固定【派单纪律】尾段
#   3) 派单「之前」记录 workdir 基线 commit + write_scopes → .dispatch/<task id>.base（供 board.sh scope-check 用）
#
# 用法：dispatch.sh "<工单正文>" [--workdir DIR] [--scope "路径1,路径2"] [--dry-run]
# 纪律：真实派单必须带 --scope（工单的写范围），否则 scope-check 无据可依。
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse
import datetime
import hashlib
import os
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BOARD_DIR = Path(os.environ.get("DUAL_BOARD_DIR") or (Path.home() / "proj" / "dual-board"))
INBOX = BOARD_DIR / "inbox-codex.md"
DISPATCH_DIR = BOARD_DIR / ".dispatch"
API_URL = (os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080").rstrip("/") + "/second-engine/api/task"


def usage(parser):
    parser.print_usage(sys.stderr)
    print('dispatch.sh "<工单正文>" [--workdir DIR] [--scope "p1,p2"] [--dry-run]', file=sys.stderr)


def unread_segments(text):
    """段 = 行首 "## [" 开头；标题行含 [已读] 的段跳过。"""
    segments = []
    current = []
    unread = False
    for line in text.splitlines(keepends=True):
        if line.startswith("## "):
            if current and unread:
                segments.append("".join(current).rstrip() + "\n")
            current = [line]
            unread = "[已读]" not in line
        elif current:
            current.append(line)
    if current and unread:
        segments.append("".join(current).rstrip() + "\n")
    return segments


def build_prompt(task, scopes):
    try:
        inbox_text = INBOX.read_text(encoding="utf-8")
    except OSError as error:
        raise RuntimeError(f"无法读取收件箱 {INBOX}: {error}") from error

    parts = []
    segments = unread_segments(inbox_text)
    if segments:
        parts.append("【未读收件箱】\n" + "\n".join(segments))
    parts.append(task)
    scope_line = "；\n".join(f"  · {s}" for s in scopes) if scopes else "  · （本单未声明 write_scopes，按协议视为只读）"
    parts.append(
        f"【派单纪律】\n"
        f"先读 {BOARD_DIR}/PROTOCOL.md；\n"
        f"写 board.json / 收件箱一律经 {BOARD_DIR}/board.sh，不要手改文件；\n"
        "本单 write_scopes：\n" + scope_line + "；\n"
        "交付必含四段：交付/异议位/下一步建议/自验。"
    )
    return "\n\n".join(parts), segments


def baseline_commit(workdir):
    try:
        result = subprocess.run(
            ["git", "-C", str(workdir), "rev-parse", "HEAD"],
            check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError):
        return "no-git"
    return result.stdout.strip()


def dirty_paths(workdir):
    """派单前工作区的脏文件快照——scope-check 要靠它把"派单前就脏"的既有污染排除。"""
    try:
        out = subprocess.run(
            ["git", "-C", str(workdir), "-c", "core.quotepath=false",
             "status", "--porcelain=v1", "--untracked-files=all"],
            check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    paths = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        p = line[3:]
        if " -> " in p:
            p = p.split(" -> ", 1)[1]
        p = p.strip()
        # git 对含特殊字符的路径加引号（quotepath=false 时中文已是原文）
        if p.startswith('"') and p.endswith('"') and len(p) >= 2:
            p = p[1:-1]
        paths.append(p)
    return sorted(set(paths))


def snapshot_scope_hashes(workdir, scopes):
    """#4：对 write_scopes 覆盖的文件记 sha256（派单前快照）。

    脏工作区下 scope-check 靠 git 排除「派单前就脏」的文件，会把
    「派单前就脏、派单后又被改」的真实改动一并排除（协议 §十一 的漏报）。
    哈希比对不受 git 状态影响：交付后重算即可把这类改动捞回来；
    workdir 无 git 时也能靠它降级校验，而不是直接判「未验证」。
    """
    out = {}
    wd = Path(workdir)
    for s in scopes or []:
        base = Path(s) if os.path.isabs(s) else (wd / s)
        if base.is_file():
            files = [base]
        elif base.is_dir():
            files = sorted(p for p in base.rglob("*")
                           if p.is_file() and ".git" not in p.parts)
        else:
            files = []
        for f in files:
            try:
                rel = os.path.relpath(f, wd).replace(os.sep, "/")
                out[rel] = hashlib.sha256(f.read_bytes()).hexdigest()
            except OSError:
                continue
    return out


def write_base(task_id, commit, workdir, scopes, dirty, hashes):
    DISPATCH_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "task_id": task_id,
        "commit": commit,
        "workdir": str(workdir),
        "write_scopes": scopes,
        "dirty_before": dirty,
        "scope_hashes": hashes,
        "dispatched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (DISPATCH_DIR / f"{task_id}.base").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dispatch_task(prompt, workdir, scopes):
    # 基线必须在派单之前取：派单后 codex 可能已开始改文件
    commit = baseline_commit(workdir)
    dirty = dirty_paths(workdir)
    hashes = snapshot_scope_hashes(workdir, scopes)
    body = json.dumps(
        {"prompt": prompt, "workdir": str(workdir), "ephemeral": True},
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        API_URL, data=body,
        headers={"Content-Type": "application/json; charset=utf-8"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}: {response_body}")
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {response_body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"请求失败: {error}") from error

    try:
        payload = json.loads(response_body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"响应不是 JSON: {response_body}") from error
    if payload.get("ok") is not True:
        raise RuntimeError(f"响应不是 ok: {response_body}")
    task_id = payload.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError(f"响应缺少有效 id: {response_body}")

    write_base(task_id, commit, workdir, scopes, dirty, hashes)
    return task_id, commit


def auto_archive():
    """完成即回滚：派单【前】把「已读收件箱段 + 已终结任务」转档 archive/，活跃文件只留
    未读/未完成 —— 归档不再依赖「谁记得执行」。

    纪律：只归档【首行带 [已读]】的段。codex 收件箱由 lead（作者/派单方）在读完后标注，
    故派单时自动标已读并归档；lead 收件箱【不替 lead 假装读过】，只在其超阈值时提醒。
    """
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # v1.3：完成即出板 → 不再 archive completed；改为把 channel 归到窗口大小
    jobs = [["inbox-read", "codex"], ["inbox-archive", "codex"],
            ["inbox-archive", "lead"], ["channel-trim", "--keep", "10"]]
    for argv in jobs:
        try:
            proc = subprocess.run(["bash", str(BOARD_DIR / "board.sh")] + argv,
                                  text=True, capture_output=True, timeout=30)
            msg = ((proc.stdout or "") + (proc.stderr or "")).strip().replace("\n", " ")
            if msg:
                print(f"[自动归档] {' '.join(argv)}: {msg}", file=sys.stderr)
        except Exception as error:
            print(f"[自动归档] 跳过 {' '.join(argv)}: {error}", file=sys.stderr)
    try:
        lines = sum(1 for _ in open(BOARD_DIR / "inbox-lead.md", encoding="utf-8"))
        if lines > 100:
            print(f"[提醒] lead 收件箱已 {lines} 行：读完后跑 board.sh inbox-read lead 再归档",
                  file=sys.stderr)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("task", nargs="?")
    parser.add_argument("--workdir", default=".")
    parser.add_argument("--scope", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--board-id", default=None,
                        help="看板任务 id（如 T5）：写一份 <board-id>.base 别名，"
                             "让 scope-check 能按看板 id 找到基线（v1.3）")
    parser.add_argument("-h", "--help", action="store_true")
    args = parser.parse_args()

    if args.help:
        print('用法: dispatch.sh "<工单正文>" [--workdir DIR] [--scope "p1,p2"] [--board-id ID] [--dry-run]')
        return 0
    if not args.task or not args.task.strip():
        usage(parser)
        return 2
    if not Path(args.workdir).is_dir():
        print(f"workdir 不存在或不是目录: {args.workdir}", file=sys.stderr)
        return 1

    scopes = [s for s in args.scope.split(",") if s.strip()]

    try:
        prompt, _ = build_prompt(args.task, scopes)
        if args.dry_run:
            print(prompt)
            print(f"\n基线: {baseline_commit(args.workdir)}")
            print(f"write_scopes: {scopes or '（未声明）'}")
            return 0
        if not scopes:
            print("warn: 未传 --scope，scope-check 将无据可依", file=sys.stderr)
        auto_archive()
        task_id, commit = dispatch_task(prompt, args.workdir, scopes)
        if args.board_id:
            link = DISPATCH_DIR / f"{args.board_id}.base"
            try:
                if link.is_symlink() or link.exists():
                    link.unlink()
                link.symlink_to(f"{task_id}.base")
                print(f"看板 id 别名: {link.name} -> {task_id}.base")
            except OSError as error:
                print(f"warn: 别名创建失败（{error}）", file=sys.stderr)
        print(f"task id: {task_id}")
        print(f"基线: {commit}")
        print(f"记录: {DISPATCH_DIR}/{task_id}.base")
        return 0
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
PY

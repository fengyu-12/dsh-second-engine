#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""board_tool.py 回归测试（纯标准库，不依赖 pytest）

覆盖 PROTOCOL.md v1.4 §九.3「退出码即语义」的全部约定：
    0 成功 / 1 一般错误 / 2 用法错 / 3 CAS 冲突 / 4 依赖未完成
    5 状态非法 / 6 锁超时 / 7 scope 越界 / 8 无 git 基线（降级未验证）

运行（在本文件所在目录，board_tool.py 用 --tool 指定或用默认相对路径）：
    python3 test_board_tool.py                 # 全跑
    python3 test_board_tool.py --verbose       # 打印每个用例的 rc/stderr
    python3 test_board_tool.py --only cas      # 只跑 id 含 "cas" 的用例
    python3 test_board_tool.py --tool /path/to/board_tool.py

设计约束：
  - 每个用例独立的临时 DUAL_BOARD_DIR，互不污染；绝不写调用方的真实看板。
  - 只经 CLI 黑盒调用（subprocess），不 import board_tool —— 这样测的是
    「协议承诺的退出码」，而不是内部函数重构后仍然成立的性质。
  - 依赖 git 的用例在 git 不可用时记为 SKIP（不算失败），因此本文件在
    无 git 的最小环境里也能跑通其余用例。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOOLS = [
    os.environ.get("BOARD_TOOL", ""),
    os.path.join(HERE, "board_tool.py"),
    os.path.join(HERE, "..", "uploads", "board_tool.py"),
    os.path.join(HERE, "..", "tools", "dual-board", "board_tool.py"),
]
TOOL = next((p for p in DEFAULT_TOOLS if p and os.path.exists(p)), None)
# 覆盖值放在环境变量里，不放模块变量——因为 unittest 的 loader.discover() 会把本文件
# **重新 import 成另一个模块对象**跑用例，写在模块变量上的 --tool 只有 main() 看得
# 到，用例读到的那份仍是 import 时探测的默认值（已踩过：换 --tool 后 48 用例全红变全绿）。
TOOL_ENV = "BOARD_TOOL_PATH"


def _tool_cfg() -> str:
    """当前生效的 board_tool.py 路径（--tool 通过环境变量传递，跨模块副本有效）。"""
    return os.environ.get(TOOL_ENV) or TOOL

EXIT = {  # PROTOCOL §九.3
    "OK": 0, "ERR": 1, "USAGE": 2, "CAS": 3, "DEP": 4,
    "STATE": 5, "LOCK": 6, "SCOPE": 7, "NOGIT": 8,
}


def run_tool(args, board_dir, cwd=None, stdin=None, timeout=60):
    """黑盒调用 board_tool.py，返回 CompletedProcess（rc/stdout/stderr 均为文本）。

    注：每次读 _tool_cfg()，不在 import 时绑死——否则 --tool 只能改到副本，
    测试会默默跑错文件而全绿（已踩过）。
    """
    env = dict(os.environ)
    # 关键：BOARD_DIR 由环境变量决定（board_tool.py:34），所以每个用例给它独立目录。
    env["DUAL_BOARD_DIR"] = board_dir
    proc = subprocess.run(
        [sys.executable, _tool_cfg(), *args],
        cwd=cwd or board_dir, env=env, input=stdin,
        capture_output=True, text=True, timeout=timeout,
    )
    return proc


class BoardCase(unittest.TestCase):
    """提供 self.board（临时看板目录）与 self.bt（断言退出码）。"""

    @classmethod
    def setUpClass(cls):
        tool = _tool_cfg()
        if not tool:
            raise RuntimeError("找不到 board_tool.py：用 --tool <路径> 指定，或设 BOARD_TOOL 环境变量")
        # 防假绿：先确认子进程真能加载。路径错/不可读时直接红，
        # 不能 SkipTest——否则「全跳过」会被误读成「全通过」。
        probe_dir = tempfile.mkdtemp(prefix="boardtest-probe-")
        try:
            probe = run_tool(["--help"], probe_dir)
        finally:
            shutil.rmtree(probe_dir, ignore_errors=True)
        if probe.returncode != 0:
            raise RuntimeError(f"board_tool.py 不可执行：{tool}\n{probe.stderr[:300]}")

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="boardtest-")
        self.board = os.path.join(self._tmp, "data")
        os.makedirs(self.board)
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)

    # ---- 便捷封装 -------------------------------------------------------
    def call(self, *args, **kw):
        return run_tool(list(args), self.board, **kw)

    def must(self, *args, **kw):
        """断言 rc==0，返回 stdout（失败时把 stderr 打进断言消息，便于定位）。"""
        p = self.call(*args, **kw)
        self.assertEqual(p.returncode, EXIT["OK"],
                         f"期望 rc=0：{args}\nstdout={p.stdout}\nstderr={p.stderr}")
        return p.stdout

    def expect_rc(self, code, *args, contains=None, **kw):
        p = self.call(*args, **kw)
        self.assertEqual(p.returncode, code,
                         f"期望 rc={code}，实际 {p.returncode}：{args}\n"
                         f"stdout={p.stdout}\nstderr={p.stderr}")
        if contains:
            blob = p.stdout + p.stderr
            self.assertIn(contains, blob,
                          f"rc 对但输出缺关键字 {contains!r}：{blob}")
        return p

    def board_json(self):
        with open(os.path.join(self.board, "board.json"), encoding="utf-8") as f:
            return json.load(f)

    def revision(self):
        return self.board_json()["revision"]

    def task(self, tid):
        for t in self.board_json()["tasks"]:
            if t.get("id") == tid:
                return t
        raise AssertionError(f"任务不在板上：{tid}")

    def mk(self, tid, **kw):
        a = ["new", tid, "--subject", kw.get("subject", "s-" + tid),
             "--task", kw.get("task", "t-" + tid)]
        for flag, key in (("--context", "context"), ("--scope", "scope"),
                          ("--blocked", "blocked"), ("--acceptance", "acceptance")):
            if key in kw:
                a += [flag, kw[key]]
        return self.must(*a)

    def dispatch_base(self, tid, **rec):
        """.dispatch/ 相对 BOARD_DIR（board_tool.py:38 DISPATCH_DIR），不是相对 cwd。"""
        d = os.path.join(self.board, ".dispatch")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{tid}.base"), "w", encoding="utf-8") as f:
            json.dump(rec, f)


# =======================================================================  CAS
class TestCAS(unittest.TestCase):
    def setUp(self):
        if not _tool_cfg():
            raise RuntimeError("找不到 board_tool.py：用 --tool 指定路径")
        self._tmp = tempfile.mkdtemp(prefix="boardtest-")
        self.board = os.path.join(self._tmp, "data")
        os.makedirs(self.board)
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)

    def call(self, *a, **kw):
        return run_tool(list(a), self.board, **kw)

    def must(self, *a, **kw):
        p = self.call(*a, **kw)
        self.assertEqual(p.returncode, 0, f"{a}\n{p.stdout}{p.stderr}")
        return p.stdout

    def board_json(self):
        with open(os.path.join(self.board, "board.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_01_wrong_expect_exits_3(self):
        """--expect 与当前 revision 不符 ⇒ 3（协议 §九.3）。"""
        self.must("new", "t1", "--subject", "s", "--task", "t")          # revision 1
        p = self.call("new", "t2", "--subject", "s", "--task", "t", "--expect", "999")
        self.assertEqual(p.returncode, EXIT["CAS"], p.stderr)
        self.assertIn("CAS 冲突", p.stderr)

    def test_02_stale_expect_after_other_writer_exits_3(self):
        """读到的 revision 被别人推进后，旧 expect 必须失效（真正的 TOCTOU 场景）。"""
        self.must("new", "t1", "--subject", "s", "--task", "t")          # rev 1
        seen = self.board_json()["revision"]
        self.must("new", "t2", "--subject", "s", "--task", "t")          # rev 2（他人写入）
        p = self.call("new", "t3", "--subject", "s", "--task", "t", "--expect", str(seen))
        self.assertEqual(p.returncode, EXIT["CAS"], p.stderr)
        ids = [t["id"] for t in self.board_json()["tasks"]]
        self.assertNotIn("t3", ids, "CAS 失败却写进了看板")

    def test_03_correct_expect_succeeds(self):
        """对照组：expect 正确必须成功，否则上一条测试可能因恒失败而假绿。"""
        self.must("new", "t1", "--subject", "s", "--task", "t")
        rev = self.board_json()["revision"]
        self.must("new", "t2", "--subject", "s", "--task", "t", "--expect", str(rev))
        self.assertEqual(self.board_json()["revision"], rev + 1)

    def test_04_concurrent_same_expect_only_one_wins(self):
        """5 进程同 expect ⇒ 恰好 1 个 rc=0、其余 rc=3，且只落一条任务。

        这是 CAS 的核心承诺：并发下不静默覆盖（协议 §二 CAS + 锁）。
        """
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump({"revision": 1, "tasks": []}, f)
        procs = [subprocess.Popen(
            [sys.executable, _tool_cfg(), "new", f"c{i}", "--subject", "s", "--task", "t", "--expect", "1"],
            cwd=self.board, env={**os.environ, "DUAL_BOARD_DIR": self.board},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(5)]
        rcs = []
        for p in procs:
            out, err = p.communicate(timeout=60)
            rcs.append(p.returncode)
        self.assertEqual(rcs.count(EXIT["OK"]), 1, f"应恰好 1 个成功，实际 rc={rcs}")
        self.assertEqual(rcs.count(EXIT["CAS"]), 4, f"其余应全为 CAS 冲突 3，实际 rc={rcs}")
        data = self.board_json()
        self.assertEqual(len(data["tasks"]), 1, "并发写入应只落一条")
        self.assertEqual(data["revision"], 2, "revision 只能 +1")


# ===============================================================  状态机
class TestStateMachine(BoardCase):

    def test_10_completed_cannot_revert_to_pending(self):
        """completed 终态：改回 pending ⇒ 5（协议 §二「无 reopen」）。

        用 --keep 让任务留在板上，才能对「板上 completed」下 set。
        """
        self.mk("t1")
        self.must("complete", "t1", "--result", "done", "--keep")
        self.assertEqual(self.task("t1")["status"], "completed")
        self.expect_rc(EXIT["STATE"], "set", "t1", "status=pending",
                       contains="终态不可再改")

    def test_11_abandoned_is_terminal(self):
        """abandoned 终态：set / abandon / claim 全部拒绝 ⇒ 5。"""
        self.mk("t2")
        self.must("abandon", "t2", "--reason", "不做了")
        self.assertEqual(self.task("t2")["status"], "abandoned")
        self.expect_rc(EXIT["STATE"], "set", "t2", "status=pending", contains="终态不可再改")
        self.expect_rc(EXIT["STATE"], "abandon", "t2", "--reason", "再来一次", contains="已终结")
        self.expect_rc(EXIT["STATE"], "claim", "t2", "--owner", "lead", contains="不可认领")
        self.expect_rc(EXIT["STATE"], "block", "t2", "--reason", "卡住", contains="已终结")

    def test_12_set_cannot_reach_completed_directly(self):
        """set 不能直达终态（completed / abandoned）⇒ 5（协议 §九.2 只允许生命周期子命令置终态）。"""
        self.mk("t3")
        self.expect_rc(EXIT["STATE"], "set", "t3", "status=completed",
                       contains="不可通过 set 直接写入终态")
        self.expect_rc(EXIT["STATE"], "set", "t3", "status=abandoned",
                       contains="不可通过 set 直接写入终态")
        self.assertEqual(self.task("t3")["status"], "pending", "被拒后状态不应变")

    def test_13_set_rejects_unknown_field_and_value(self):
        """set 的字段白名单与取值校验 ⇒ 2（字段）/ 5（状态值）。"""
        self.mk("t4")
        self.expect_rc(EXIT["USAGE"], "set", "t4", "id=hacked", contains="字段不可改")
        self.expect_rc(EXIT["USAGE"], "set", "t4", "notaKVpair", contains="key=value")
        self.expect_rc(EXIT["STATE"], "set", "t4", "status=done", contains="非法状态")

    def test_14_claim_respects_dependency_gate(self):
        """blocked_by 未完成 ⇒ claim 退出码 4；前置完成后放行（协议 §二）。"""
        self.mk("t1")
        self.mk("t2", blocked="t1")
        self.expect_rc(EXIT["DEP"], "claim", "t2", "--owner", "codex", contains="依赖未完成")
        self.must("complete", "t1", "--result", "R\n$ true\nexit=0", "--reviewed-by", "human")  # t1 出板
        self.must("claim", "t2", "--owner", "codex")                            # 依赖经 audit 认定
        self.assertEqual(self.task("t2")["status"], "in_progress")

    def test_15_claim_rejects_unknown_role_and_wrong_state(self):
        self.mk("t5")
        self.expect_rc(EXIT["STATE"], "claim", "t5", "--owner", "nobody", contains="角色不存在")
        self.must("claim", "t5", "--owner", "lead")
        self.expect_rc(EXIT["STATE"], "claim", "t5", "--owner", "codex", contains="不可认领")

    def test_16_ready_is_readonly_and_filters_unmet(self):
        """ready 只读：不改 revision；未满足依赖的任务不进 ready 而进 blocked[]。"""
        self.mk("t1")
        self.mk("t2", blocked="t1")
        rev_before = self.revision()
        p = self.call("ready", "--json")
        self.assertEqual(p.returncode, EXIT["OK"], p.stderr)
        payload = json.loads(p.stdout)
        ids_ready = [t["id"] for t in payload["ready"]]
        self.assertIn("t1", ids_ready)
        self.assertNotIn("t2", ids_ready)
        self.assertEqual([b["id"] for b in payload["blocked"]], ["t2"])
        self.assertEqual(payload["blocked"][0]["missing"], ["t1"])
        self.assertEqual(self.revision(), rev_before, "ready 必须只读，不得推进 revision")

    def test_17_abandon_unlocks_dependent(self):
        """abandon 是放弃不是完成，但解锁依赖方（2026-11-10 方案 B）。"""
        self.mk("t1")
        self.mk("t2", blocked="t1")
        self.must("abandon", "t1", "--reason", "不做了")
        p = self.call("ready", "--json")
        self.assertEqual(p.returncode, EXIT["OK"], p.stderr)
        payload = json.loads(p.stdout)
        rows = [t for t in payload["ready"] if t["id"] == "t2"]
        self.assertTrue(rows, "放弃的前置必须解锁下游")
        self.assertEqual(rows[0]["abandoned_deps"], ["t1"])
        p = self.call("claim", "t2", "--owner", "codex")
        self.assertEqual(p.returncode, EXIT["OK"], p.stderr)
        self.assertIn("依赖已放弃", p.stderr)
        self.assertEqual(self.task("t2")["status"], "in_progress")


    def test_18_scope_overlap_rejected(self):
        self.mk("T1", scope="a,b")
        before = self.board_json()
        p = self.expect_rc(EXIT["SCOPE"], "new", "T2", "--subject", "s",
                           "--task", "t", "--scope", "b,c", contains="写域重叠")
        self.assertIn("b", p.stderr)
        self.assertIn("T1", p.stderr)
        self.assertEqual(self.board_json(), before)

    def test_19_allow_scope_overlap_warns(self):
        self.mk("T1", scope="a,b")
        p = self.call("new", "T2", "--subject", "s", "--task", "t",
                      "--scope", "b,c", "--allow-overlap")
        self.assertEqual(p.returncode, EXIT["OK"], p.stderr)
        self.assertIn("warn", p.stderr)
        self.assertEqual(self.task("T2")["write_scopes"], ["b", "c"])

    def test_19_completed_scope_is_free(self):
        self.mk("T1", scope="a")
        self.must("complete", "T1", "--result", "R\n$ true\nexit=0",
                  "--reviewed-by", "human")
        self.mk("T2", scope="a", blocked="T1")

    def test_19_terminal_scopes_are_free(self):
        self.mk("T1", scope="a")
        self.must("complete", "T1", "--result", "done", "--keep")
        self.mk("T2", scope="a")
        self.must("abandon", "T2", "--reason", "不做了")
        self.mk("T3", scope="a")

    def test_19_self_dependency_rejected(self):
        self.expect_rc(EXIT["DEP"], "new", "T3", "--subject", "s",
                       "--task", "t", "--blocked", "T3", contains="T3 → T3")

    def test_19_indirect_cycle_rejected(self):
        self.expect_rc(EXIT["DEP"], "new", "T1", "--subject", "s",
                       "--task", "t", "--blocked", "T2", contains="依赖不存在：T2")
        # 先完成出板，再由审计允许 T2 引用 T1；复用 T1 时闭合真实依赖环。
        self.mk("T1")
        self.must("complete", "T1", "--result", "R\n$ true\nexit=0",
                  "--reviewed-by", "human")
        self.mk("T2", blocked="T1")
        before = self.board_json()
        self.expect_rc(EXIT["DEP"], "new", "T1", "--subject", "s",
                       "--task", "t", "--blocked", "T2", contains="T1 → T2 → T1")
        self.assertEqual(self.board_json(), before)

    def test_19_missing_dependency_rejected(self):
        self.expect_rc(EXIT["DEP"], "new", "T3", "--subject", "s",
                       "--task", "t", "--blocked", "missing", contains="依赖不存在：missing")


# =========================================================  complete 门禁
class TestCompleteGate(BoardCase):

    def test_20_missing_human_review_exits_5(self):
        """缺 --reviewed-by human 且不带 --keep ⇒ 5（协议 §12.2「Agent 自报不算人确认」）。"""
        self.mk("t1")
        self.expect_rc(EXIT["STATE"], "complete", "t1", "--result", "R",
                       contains="未经人确认的完成不算完成")

    def test_21_non_human_reviewer_exits_5(self):
        """--reviewed-by 的任何非 human 值（含 codex/lead/self）⇒ 5。"""
        self.mk("t2")
        for value in ("codex", "lead", "self", "human ", "HUMAN"):
            with self.subTest(reviewed_by=value):
                self.expect_rc(EXIT["STATE"], "complete", "t2", "--result", "R",
                               "--reviewed-by", value, contains="只接受 human")

    def test_22_keep_does_not_write_reviewed_by(self):
        """--keep：置 completed 但**不写** reviewed_by（面板据此显示待审）；且不写 audit。"""
        self.mk("t3")
        audit_dir = os.path.join(self.board, "audit")
        self.must("complete", "t3", "--result", "自动化交付", "--keep")
        t = self.task("t3")
        self.assertEqual(t["status"], "completed")
        self.assertNotIn("reviewed_by", t, "--keep 不应写 reviewed_by")
        self.assertNotIn("reviewed_at", t, "--keep 不应写 reviewed_at")
        self.assertEqual(t["result"], "自动化交付")
        self.assertFalse(os.path.isdir(audit_dir),
                         "--keep 不得写 audit/（协议 §12.2：留板待审不出板、不落审计）")

    def test_23_human_review_writes_audit_and_removes_task(self):
        """--reviewed-by human：写 reviewed_by + audit/*.jsonl，然后任务出板。"""
        self.mk("t4")
        self.must("complete", "t4", "--result", "人工已验收\n$ true\nexit=0", "--reviewed-by", "human")
        with self.assertRaises(AssertionError):
            self.task("t4")                       # 已出板
        audit_dir = os.path.join(self.board, "audit")
        self.assertTrue(os.path.isdir(audit_dir), "人确认应落 audit/")
        recs = []
        for fn in os.listdir(audit_dir):
            self.assertRegex(fn, r"^completed-\d{4}-\d{2}\.jsonl$")
            with open(os.path.join(audit_dir, fn), encoding="utf-8") as f:
                recs += [json.loads(line) for line in f if line.strip()]
        self.assertEqual([r["id"] for r in recs], ["t4"])
        self.assertEqual(recs[0]["reviewed_by"], "human")
        self.assertTrue(recs[0].get("reviewed_at") and recs[0].get("recorded_at"))

    def test_24_keep_and_reviewed_by_are_not_mixed(self):
        """--keep 与 --reviewed-by human 同时给：仍属人确认语义，不得写 reviewed_by 于留板任务。

        协议 §九.2b 明写「二者不可混用」。此处钉住实现的实际行为，防回归。
        """
        self.mk("t5")
        self.must("complete", "t5", "--result", "R\n$ true\nexit=0", "--keep", "--reviewed-by", "human")
        audit_dir = os.path.join(self.board, "audit")
        self.assertFalse(os.path.isdir(audit_dir),
                         "--keep 的语义是留板待审，不应落 audit")

    def test_25_complete_requires_nonempty_result(self):
        """--result 空白 ⇒ 2。注意：必须带 --keep 才能测到这条。

        不带 --keep 时，人确认门禁先 fire（rc=5），--result 的用法校验根本走不到。
        见交付说明「疑似真 bug #2」：用法错应优先于策略错。
        """
        self.mk("t6")
        self.expect_rc(EXIT["USAGE"], "complete", "t6", "--result", "   ", "--keep",
                       contains="必须给 --result")

    def test_25b_review_gate_shadows_result_usage_error(self):
        """钉住现状：同时缺人确认与 result 时，先报策略错(5) 而非用法错(2)。"""
        self.mk("t7")
        self.expect_rc(EXIT["STATE"], "complete", "t7", "--result", "   ",
                       contains="未经人确认的完成不算完成")

    def test_26_completed_is_not_reeditable_even_with_keep(self):
        """--keep 置 completed 之后同样不可复改（终态语义不因 keep 而弱化）。"""
        self.mk("t7")
        self.must("complete", "t7", "--result", "R", "--keep")
        self.expect_rc(EXIT["STATE"], "complete", "t7", "--result", "R2", "--keep",
                       contains="不可复改")


# =================================================================  archive
class TestArchive(BoardCase):

    def test_30_archive_without_before_exits_2(self):
        """--before 缺失 ⇒ 2（协议 §九.3 用法错）。"""
        self.mk("t1")
        self.must("abandon", "t1", "--reason", "x")
        self.expect_rc(EXIT["USAGE"], "archive", contains="必须给 --before")

    def test_31_archive_malformed_before_is_not_validated(self):
        """--before 格式错：协议承诺「2 用法错」，实现**不做格式校验** ⇒ 实际 rc=0 且会搬数据。

        见交付说明「疑似真 bug #1」。本用例按现状钉住 rc==0，
        一旦作者补了校验（改成 rc=2），此测试会失败并提醒同步更新。
        """
        self.mk("t1")
        self.must("abandon", "t1", "--reason", "x")
        p = self.call("archive", "--before", "not-a-date")
        self.assertEqual(p.returncode, EXIT["OK"],
                         "现状：非法 --before 被当字符串比较，rc=0（协议说该是 2）\n"
                         f"stdout={p.stdout}stderr={p.stderr}")
        self.assertIn("已转档", p.stdout)
        self.assertEqual(self.board_json()["tasks"], [], "非法时间串竟触发了归档搬移")

    def test_32_archive_honours_before_boundary(self):
        """--before 的正常语义：只归档 updated_at < before 的终结任务。"""
        self.mk("t1")
        self.mk("t2")
        self.must("abandon", "t1", "--reason", "old")
        self.must("abandon", "t2", "--reason", "new")
        rev = self.revision()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.expect_rc(EXIT["OK"], "archive", "--before", "1970-01-01T00:00:00Z")
        self.assertEqual(self.revision(), rev, "无命中时不应推进 revision")
        self.assertEqual(len(self.board_json()["tasks"]), 2, "早于所有任务的时间不该搬走任何东西")
        self.must("archive", "--before", "2099-01-01T00:00:00Z")
        self.assertEqual(self.board_json()["tasks"], [])
        arc = os.path.join(self.board, "archive")
        files = [f for f in os.listdir(arc) if f.startswith("tasks-") and f.endswith(".jsonl")]
        self.assertTrue(files, "应生成 archive/tasks-YYYY-MM.jsonl")
        with open(os.path.join(arc, files[0]), encoding="utf-8") as f:
            recs = [json.loads(l) for l in f if l.strip()]
        self.assertEqual({r["id"] for r in recs}, {"t1", "t2"})
        self.assertTrue(all("archived_at" in r for r in recs))

    def test_33_archive_respects_cas(self):
        self.mk("t1")
        self.must("abandon", "t1", "--reason", "x")
        self.expect_rc(EXIT["CAS"], "archive", "--before", "2099-01-01T00:00:00Z",
                       "--expect", "999")


# =============================================================  scope-check
def _git_available():
    return shutil.which("git") is not None


@unittest.skipUnless(_git_available(), "git 不可用：无法构造基线，跳过 scope 越界用例")
class TestScopeCheckGit(BoardCase):
    """越界 ⇒ 7（协议 §九.4）。需要 workdir 是 git 仓库 + .dispatch 基线。"""

    def setUp(self):
        super().setUp()
        self.wd = os.path.join(self._tmp, "wd")
        os.makedirs(os.path.join(self.wd, "src"))
        os.makedirs(os.path.join(self.wd, "docs"))
        for path, body in (("src/a.py", "a\n"), ("docs/d.md", "d\n")):
            with open(os.path.join(self.wd, path), "w", encoding="utf-8") as f:
                f.write(body)
        for cmd in (["init", "-q"], ["config", "user.email", "t@t"],
                    ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "base"]):
            r = subprocess.run(["git", "-C", self.wd, *cmd], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
        base = subprocess.run(["git", "-C", self.wd, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        self.mk("t1", scope="src/")
        self.dispatch_base("t1", commit=base, workdir=self.wd,
                           write_scopes=["src/"], dirty_before=[])

    def test_40_no_change_passes(self):
        self.expect_rc(EXIT["OK"], "scope-check", "t1", "--workdir", self.wd)

    def test_41_in_scope_change_passes(self):
        with open(os.path.join(self.wd, "src", "a.py"), "w", encoding="utf-8") as f:
            f.write("changed\n")
        p = self.expect_rc(EXIT["OK"], "scope-check", "t1", "--workdir", self.wd)
        self.assertIn("src/a.py", p.stdout)

    def test_42_out_of_scope_change_exits_7(self):
        with open(os.path.join(self.wd, "src", "a.py"), "w", encoding="utf-8") as f:
            f.write("ok\n")
        with open(os.path.join(self.wd, "docs", "d.md"), "w", encoding="utf-8") as f:
            f.write("越界\n")
        p = self.expect_rc(EXIT["SCOPE"], "scope-check", "t1", "--workdir", self.wd)
        self.assertIn("越界", p.stdout)
        self.assertIn("docs/d.md", p.stdout)

    def test_43_new_untracked_file_out_of_scope_exits_7(self):
        """未跟踪新文件也算变更（首版只查 git diff 造成假通过，协议已记为实测坑）。"""
        with open(os.path.join(self.wd, "docs", "new.md"), "w", encoding="utf-8") as f:
            f.write("new file\n")
        self.expect_rc(EXIT["SCOPE"], "scope-check", "t1", "--workdir", self.wd)

    def test_44_no_write_scopes_means_readonly(self):
        """未列 write_scopes ⇒ 任何变更都算越界 ⇒ 7（协议 §二「没有列出 = 只读」）。"""
        self.mk("t9", scope="")
        base = subprocess.run(["git", "-C", self.wd, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        self.dispatch_base("t9", commit=base, workdir=self.wd, write_scopes=[], dirty_before=[])
        with open(os.path.join(self.wd, "src", "a.py"), "w", encoding="utf-8") as f:
            f.write("touched\n")
        p = self.expect_rc(EXIT["SCOPE"], "scope-check", "t9", "--workdir", self.wd)
        self.assertIn("没有列出 = 只读", p.stdout + p.stderr)


class TestScopeCheckNoGit(BoardCase):
    """非 git 工作区 ⇒ 8「降级未验证」，不得伪装成通过（协议 §九.4）。"""

    def test_50_no_git_baseline_exits_8(self):
        wd = os.path.join(self._tmp, "plain")
        os.makedirs(wd)
        self.mk("t1", scope="src/")
        self.dispatch_base("t1", commit="no-git", workdir=wd,
                           write_scopes=["src/"], dirty_before=[])
        p = self.expect_rc(EXIT["NOGIT"], "scope-check", "t1", "--workdir", wd)
        self.assertIn("未验证", p.stdout + p.stderr)

    def test_51_null_commit_also_degrades_to_8(self):
        wd = os.path.join(self._tmp, "plain2")
        os.makedirs(wd)
        self.mk("t2", scope="src/")
        self.dispatch_base("t2", commit=None, workdir=wd,
                           write_scopes=["src/"], dirty_before=[])
        self.expect_rc(EXIT["NOGIT"], "scope-check", "t2", "--workdir", wd)

    def test_52_missing_baseline_exits_1(self):
        """基线记录缺失 ⇒ 1（既非越界也非降级，是前置条件不成立）。"""
        self.mk("tX", scope="src/")
        self.expect_rc(EXIT["ERR"], "scope-check", "tX", "--workdir", self._tmp,
                       contains="无派单基线记录")


# ===============================================================  doctor
class TestDoctor(BoardCase):

    def test_60_clean_board_passes(self):
        self.mk("t1")
        p = self.expect_rc(EXIT["OK"], "doctor", contains="体检通过")
        self.assertIn("revision=", p.stdout)

    def test_61_completed_without_result_is_reported(self):
        """缺 result 的 completed 必须被报出来 ⇒ doctor rc=1。

        构造方式：手改 board.json 塞一条 completed 无 result —— 这正是协议 §二
        「手改视为破坏协议，事后必须跑 doctor 体检」所针对的场景。
        """
        data = {"revision": 1, "tasks": [{
            "id": "TBAD", "subject": "s", "task": "t",
            "status": "completed", "owner": "lead", "updated_at": "2026-11-01T00:00:00Z",
        }]}
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        p = self.expect_rc(EXIT["ERR"], "doctor")
        self.assertIn("completed 但 result 为空", p.stdout)
        self.assertIn("TBAD", p.stdout)

    def test_62_keep_completed_still_needs_result(self):
        """--keep 出来的 completed 若 result 为空，doctor 同样该抓到（门禁与体检闭环）。"""
        self.mk("t2")
        # complete 的 --result 非空校验会挡住空串，所以这里用 set 清空 result 模拟历史脏数据
        self.must("complete", "t2", "--result", "R", "--keep")
        self.must("set", "t2", "result=")
        p = self.expect_rc(EXIT["ERR"], "doctor", contains="completed 但 result 为空")
        self.assertIn("t2", p.stdout)

    def test_63_missing_schema_fields_are_reported(self):
        self.mk("t3")
        data = self.board_json()
        for key in ("frame", "session", "write_scopes", "steps"):
            data["tasks"][0].pop(key, None)
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        p = self.expect_rc(EXIT["ERR"], "doctor")
        for key in ("frame", "session", "write_scopes", "steps"):
            self.assertIn(f"缺字段 `{key}`", p.stdout)

    def test_64_in_progress_without_owner_is_reported(self):
        self.mk("t4")
        data = self.board_json()
        data["tasks"][0].update({"status": "in_progress", "owner": None})
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.expect_rc(EXIT["ERR"], "doctor", contains="in_progress 但无 owner")

    def test_66_duplicate_id_and_bad_status_are_reported(self):
        dup = {"id": "D", "subject": "s", "task": "t", "status": "completed",
               "owner": "lead", "result": "r", "frame": "f", "session": None,
               "write_scopes": [], "blocked_by": [], "acceptance": "", "steps": [],
               "updated_at": "2026-11-01T00:00:00Z"}
        bad = dict(dup, id="D2", status="doing")
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump({"revision": 3, "tasks": [dup, dict(dup), bad]}, f, ensure_ascii=False)
        p = self.expect_rc(EXIT["ERR"], "doctor")
        self.assertIn("重复 id：D", p.stdout)
        self.assertIn("非法状态", p.stdout)

    def test_67_owner_not_in_roles_is_reported(self):
        self.mk("t6")
        data = self.board_json()
        data["tasks"][0]["owner"] = "ghost"
        data["tasks"][0]["status"] = "in_progress"
        with open(os.path.join(self.board, "board.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.expect_rc(EXIT["ERR"], "doctor", contains="owner 不在 roles")

    def test_65_stale_lock_is_reported(self):
        """残留锁（未超 600s 接管阈值）应被 doctor 报出来 ⇒ rc=1。"""
        self.mk("t5")
        lock = os.path.join(self.board, "board.json.lock")
        with open(lock, "w", encoding="utf-8") as f:
            f.write("pid=99999999 ts=0\n")
        self.addCleanup(lambda: os.path.exists(lock) and os.unlink(lock))
        p = self.expect_rc(EXIT["ERR"], "doctor", contains="残留锁")
        self.assertIn("board.json.lock", p.stdout)


class TestLock(unittest.TestCase):
    """协议 §二「锁残留超 10 分钟自动接管」与 §九.3 退出码 6。"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="boardtest-")
        self.board = os.path.join(self._tmp, "data")
        os.makedirs(self.board)
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        run_tool(["new", "seed", "--subject", "s", "--task", "t"], self.board)
        self.lock = os.path.join(self.board, "board.json.lock")

    def test_90_stale_lock_is_taken_over(self):
        """age > 600s 的残留锁 ⇒ 自动接管，写操作照常成功（rc=0）。"""
        with open(self.lock, "w", encoding="utf-8") as f:
            f.write("pid=1 ts=0\n")
        old = time.time() - 700
        os.utime(self.lock, (old, old))
        p = run_tool(["new", "t9", "--subject", "s", "--task", "t"], self.board)
        self.assertEqual(p.returncode, 0, f"{p.stdout}{p.stderr}")
        self.assertIn("接管废弃锁", p.stderr)

    def test_91_fresh_lock_blocks_writer_with_exit_6(self):
        """未过期占用锁 ⇒ 等待 5s 后退出码 6（不静默阻塞、不死等）。"""
        with open(self.lock, "w", encoding="utf-8") as f:
            f.write("pid=1 ts=0\n")
        self.addCleanup(lambda: os.path.exists(self.lock) and os.unlink(self.lock))
        started = time.time()
        p = run_tool(["new", "t9", "--subject", "s", "--task", "t"], self.board)
        elapsed = time.time() - started
        self.assertEqual(p.returncode, EXIT["LOCK"], f"{p.stdout}{p.stderr}")
        self.assertIn("锁等待超时", p.stderr)
        self.assertGreaterEqual(elapsed, 4.0, "应真的重试过（50×0.1s），不是立即失败")
        self.assertLess(elapsed, 15.0, "不得无限等待")


# ====================================================  一般错误 / 用法错
class TestBasics(BoardCase):

    def test_70_unknown_task_exits_1(self):
        self.mk("seed")
        self.expect_rc(EXIT["ERR"], "claim", "nope", "--owner", "lead", contains="任务不存在")

    def test_71_missing_board_exits_1(self):
        """看板不存在时，非 new 子命令 ⇒ 1（new 允许 create=True 自建）。"""
        p = self.call("show")
        self.assertEqual(p.returncode, EXIT["ERR"], p.stderr)
        self.assertIn("看板不存在", p.stderr)

    def test_72_new_on_empty_dir_bootstraps(self):
        """新装用户第一条命令就是 new（协议 §九.1 + 2026-10-26 修复的缺口）。"""
        fresh = tempfile.mkdtemp(prefix="boardtest-fresh-")
        self.addCleanup(shutil.rmtree, fresh, ignore_errors=True)
        empty = os.path.join(fresh, "not-created-yet")   # 故意不建
        # cwd 给一个已存在的目录：工具自己会 makedirs(BOARD_DIR)，但 subprocess 的 cwd 必须先存在
        p = run_tool(["new", "t1", "--subject", "s", "--task", "t"], empty, cwd=fresh)
        self.assertEqual(p.returncode, 0, f"{p.stdout}{p.stderr}")
        self.assertTrue(os.path.exists(os.path.join(empty, "board.json")))

    def test_73_duplicate_id_exits_1(self):
        self.mk("t1")
        self.expect_rc(EXIT["ERR"], "new", "t1", "--subject", "s", "--task", "t",
                       contains="任务 id 已存在")

    def test_74_no_subcommand_exits_2(self):
        """argparse 必填子命令缺失 ⇒ 2（与协议「用法错」一致）。"""
        self.expect_rc(EXIT["USAGE"], "not-a-subcommand")

    def test_75_revision_is_monotonic_and_reset_keeps_it(self):
        """revision 只增不减（§12.5「银行流水号不能重头开始」）。"""
        self.mk("t1")
        self.mk("t2")
        before = self.revision()
        self.must("abandon", "t1", "--reason", "x")
        self.must("abandon", "t2", "--reason", "x")
        self.must("reset")
        data = self.board_json()
        self.assertEqual(data["tasks"], [])
        self.assertGreater(data["revision"], before, "reset 不得把 revision 归零")
        self.assertGreaterEqual(data.get("epoch", 1), 2, "reset 应推进 epoch")

    def test_76_reset_refuses_live_tasks_without_force(self):
        self.mk("t1")
        self.expect_rc(EXIT["STATE"], "reset", contains="未终结任务")
        self.must("reset", "--force")
        self.assertEqual(self.board_json()["tasks"], [])

    def test_77_no_temp_files_left_behind(self):
        """原子写不得留残file：跑一轮生命周期后目录里不该有 .board.tmp-* / *.tmp-*。"""
        self.mk("t1")
        self.must("claim", "t1", "--owner", "lead")
        self.must("complete", "t1", "--result", "R\n$ true\nexit=0", "--reviewed-by", "human")
        leftovers = [n for n in os.listdir(self.board)
                     if n.startswith(".board.tmp-") or ".tmp-" in n]
        self.assertEqual(leftovers, [], f"原子写留下临时文件：{leftovers}")
        self.assertFalse(os.path.exists(os.path.join(self.board, "board.json.lock")),
                         "正常结束后不应残留锁")


def main() -> int:
    ap = argparse.ArgumentParser(description="board_tool.py 回归测试（纯标准库）")
    ap.add_argument("--tool", default=None, help="board_tool.py 路径（默认自动探测）")
    ap.add_argument("--only", default=None, help="只跑用例 id 含此子串的用例")
    ap.add_argument("--verbose", "-v", action="store_true", help="打印每个用例名")
    args = ap.parse_args()

    if args.tool:
        if not os.path.exists(args.tool):
            print(f"error: --tool 指定的文件不存在：{args.tool}", file=sys.stderr)
            return 2
        # 走环境变量：discover() 重新 import 出的副本也能读到（见 TOOL_ENV 注释）
        os.environ[TOOL_ENV] = os.path.abspath(args.tool)
    print(f"board_tool.py = {_tool_cfg()}")
    print(f"python        = {sys.executable} ({sys.version.split()[0]})")
    print(f"git           = {shutil.which('git') or '不可用（scope 越界用例将 SKIP）'}")
    print("-" * 68)

    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=HERE, pattern=os.path.basename(__file__), top_level_dir=HERE)
    if args.only:
        suite = _filter(suite, args.only)
    runner = unittest.TextTestRunner(verbosity=2 if args.verbose else 1)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


def _filter(suite, needle):
    keep = unittest.TestSuite()
    def walk(s):
        for item in s:
            if isinstance(item, unittest.TestSuite):
                walk(item)
            elif needle.lower() in item.id().lower():
                keep.addTest(item)
    walk(suite)
    return keep


if __name__ == "__main__":
    sys.exit(main())

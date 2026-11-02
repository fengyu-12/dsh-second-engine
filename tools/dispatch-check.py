#!/usr/bin/env python3
"""dispatch-check.py — 派单前机械校验（工单四要素 + 可复跑判据）。

用法:
  python3 tools/dispatch-check.py <工单文件|->      # - 表示从 stdin 读
  python3 tools/dispatch-check.py <文件> --json

检查 5 项，缺任一项 exit 1（全部通过 exit 0）：
  1. anchor  文件级锚点        出现路径（/xxx 或 xxx.yy 或 src/...）
  2. range   行号区间          sed -n 'A,Bp' 或 L<数字>-<数字>
  3. verify  可复跑判据        node --check / bash X.sh / python3 X / npm test / smoke
  4. scope   写域边界          「不要修改」/「禁止修改」/「只新建」/「只读」
  5. budget  推理预算          「最多 N 次」

存在原因（2026-11-03）：我派单时只给了文件路径、没给行号区间，Pi 只能通读 5249 行
定位函数，单笔耗时 20 分钟仍未收尾。SKILL.md 3.4 四要素里的「原料 = 具体锚点
（路径 + 行号范围）」当时已在上下文里，但没人逼我检查 —— 所以做成脚本。

注意：本工具只验「格式有没有」，不验「内容对不对」。锚点是否指向正确函数、判据是否
真能复跑，仍要人看。
"""
import json
import re
import sys

CHECKS = [
    ("anchor", "文件级锚点", re.compile(r"(/[\w./-]+\.\w+|[\w-]+\.(?:js|mjs|py|sh|md|json))")),
    ("range", "行号区间", re.compile(r"sed -n '\d+,\d+p'|L\d+-\d+")),
    ("verify", "可复跑判据", re.compile(r"node --check|bash [\w./-]+\.sh|python3 [\w./-]+|npm (?:test|run)|smoke\.sh|split-verify")),
    ("scope", "写域边界", re.compile(r"不要修改|禁止修改|不许修改|只新建|只读|--read-only|不改动")),
    ("budget", "推理预算", re.compile(r"最多\s*\d+\s*次")),
]


def check(text):
    rows = []
    ok = True
    for key, label, pat in CHECKS:
        hit = pat.search(text)
        rows.append({"key": key, "label": label, "pass": bool(hit),
                     "evidence": hit.group(0) if hit else None})
        ok = ok and bool(hit)
    return ok, rows


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    if len(args) != 1:
        print(__doc__.strip().split("\n")[2], file=sys.stderr)
        return 2
    src = sys.stdin.read() if args[0] == "-" else open(args[0], encoding="utf-8").read()
    ok, rows = check(src)
    if as_json:
        print(json.dumps({"ok": ok, "checks": rows}, ensure_ascii=False, indent=1))
    else:
        for r in rows:
            mark = "PASS" if r["pass"] else "MISS"
            print(f"  [{mark}] {r['label']:8s} {r['evidence'] or '(未命中)'}")
        print("结果：", "通过" if ok else "缺项 —— 补齐后再派单")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

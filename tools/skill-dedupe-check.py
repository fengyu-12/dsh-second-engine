#!/usr/bin/env python3
"""skill-dedupe-check.py — 去重前的「不丢」三层校验（L1 粗筛 / L2 细筛 / L3 守恒）

用法:
  python3 skill-dedupe-check.py <file> <anchorA> <anchorB>
示例:
  python3 skill-dedupe-check.py SKILL.md "## 2.3" "## 2.5"

判据:
  L1 整节 token 交集率 <20%  → 不是整节重复，别动
  L2 关键信息词在两段计数对称率 >=80% → 认定「语义重复」，可合并
  L3 A 的关键信息集（反引号标识符 + 数字 + 命令 + 路径）必须 ⊆ B，差集为空才可删 A

退出码: 0 三层都过（可安全合并）| 1 有独占关键信息（必须先搬）| 2 用法错
"""
import re
import sys

def load(path):
    return open(path, encoding='utf-8').read()

def section(text, anchor):
    lines = text.split('\n')
    start = None
    for i, l in enumerate(lines):
        if anchor in l and l.lstrip().startswith('#'):
            start = i
            break
    if start is None:
        return ''
    level = len(lines[start]) - len(lines[start].lstrip('#'))
    out = [lines[start]]
    for j in range(start + 1, len(lines)):
        l = lines[j]
        if l.lstrip().startswith('#') and (len(l) - len(l.lstrip('#'))) <= level:
            break
        out.append(l)
    return '\n'.join(out)

def tokens(s):
    t = set()
    t |= {x.strip('`') for x in re.findall(r'`[^`]+`', s)}
    t |= {x.lower() for x in re.findall(r'[A-Za-z_][A-Za-z0-9_.:/~-]{2,}', s)}
    t |= set(re.findall(r'\d+(?:\.\d+)?', s))
    zh = re.sub(r'[^\u4e00-\u9fff]', '', s)
    t |= {zh[i:i + 2] for i in range(len(zh) - 1)}
    return t

def keyinfo(s):
    """关键信息：反引号标识符 / 路径 / 端口 / 版本号 / 带数字的命令片段"""
    k = set()
    k |= {x.strip('`') for x in re.findall(r'`[^`]+`', s)}
    k |= set(re.findall(r'[~/][\w./-]{3,}', s))
    k |= set(re.findall(r'\b\d+(?:\.\d+){1,}\b', s))
    k |= set(re.findall(r'\b\d{3,5}\b', s))
    return k

def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    path, a_anchor, b_anchor = sys.argv[1], sys.argv[2], sys.argv[3]
    text = load(path)
    A, B = section(text, a_anchor), section(text, b_anchor)
    if not A or not B:
        print(f'节未找到: A={bool(A)} B={bool(B)}')
        return 2
    tA, tB = tokens(A), tokens(B)
    inter = len(tA & tB)
    ratio = inter / max(1, len(tA | tB))
    print(f'[L1] token: A={len(tA)} B={len(tB)} 交集={inter} Jaccard={ratio:.2f}')
    print(f'     → {"整节不是重复（<0.20），别动" if ratio < 0.20 else "存在整节重复嫌疑（>=0.20）"}')

    caps = ['review', 'resume', 'webSearch', 'mcp', 'chatBridge', 'modelSwitch',
            'worktree', 'Agent SDK', 'provider', '子代理', '流式', '打断', '行号准', '敢判假']
    pairs = [(c, A.count(c), B.count(c)) for c in caps]
    sym = [(c, x, y) for c, x, y in pairs if x > 0 and y > 0 and abs(x - y) <= max(1, max(x, y) // 4)]
    both = [(c, x, y) for c, x, y in pairs if x > 0 or y > 0]
    rate = len(sym) / max(1, len(both))
    print(f'[L2] 关键信息词对称: {len(sym)}/{len(both)} 对称率={rate:.0%}')
    for c, x, y in both:
        mark = ' 对称' if (c, x, y) in sym else ' 不对称'
        print(f'     {c:12} A={x} B={y}{mark}')
    print(f'     → {"语义重复成立，可合并" if rate >= 0.80 else "对称率不足，不能当重复处理"}')

    kA, kB = keyinfo(A), keyinfo(B)
    onlyA = kA - kB
    print(f'[L3] 关键信息仅 A 有: {sorted(onlyA) if onlyA else "无"}')
    if onlyA:
        print('     → 删 A 前必须先把这些搬进 B 或 refs，否则丢信息')
        return 1
    print('     → 可安全合并（A 的关键信息 B 全有）')
    return 0

if __name__ == '__main__':
    sys.exit(main())

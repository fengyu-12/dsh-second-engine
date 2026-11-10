#!/usr/bin/env bash
# 发版前机械校验（2026-11-11 立）：README 的「及更早版本」分界线、能力表标题、tag 对齐。
# 起因：分界线是「上次发布前的版本号」，靠人记必失真（v4.2.1 发布时还停在 3.8.5）。
# 退出码：0 全过 / 1 有不一致 / 2 环境错误。
set -u
cd "$(dirname "$0")/.." || exit 2
ver=$(python3 -c "import json;print(json.load(open('package.json'))['version'])") || exit 2
latest_tag=$(git tag --sort=-v:refname 2>/dev/null | head -1 | sed 's/^v//')
boundary=$(grep -oE '^> [0-9]+\.[0-9]+\.[0-9]+ 及更早版本的逐条能力明细' README.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
fail=0
printf 'package.json=%s | 最近 tag=%s | README 分界线=%s\n' "$ver" "${latest_tag:-<无>}" "${boundary:-<缺>}"
if [ -n "$latest_tag" ] && [ "$boundary" != "$latest_tag" ]; then
  printf '❌ README 分界线应为最近一次发布的 %s（现为 %s）\n' "$latest_tag" "${boundary:-<缺>}"
  fail=1
fi
grep -q "支持能力一览（v$ver）" README.md || { printf '❌ 能力表标题未对齐 v%s\n' "$ver"; fail=1; }
if git rev-parse -q --verify "v$ver" >/dev/null; then
  printf '⚠️ v%s 已存在 tag；重发同版本需 git tag -f\n' "$ver"
fi
[ "$fail" = 0 ] && echo '✅ 发版前校验通过' || echo '有失败项，先修再发'
exit "$fail"

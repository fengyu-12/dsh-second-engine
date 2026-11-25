#!/usr/bin/env bash
# engine-upgrade —— 第二引擎三件套（Pi / Claude Code / Codex）一键查版本与升级
# 用法：engine-upgrade.sh [--check] [pi|claude|codex ...]
#   --check      只查当前版本与最新版本，不升级
#   无参数       升级三个引擎（默认顺序 pi → claude → codex，与用户约定一致）
#   指定引擎     只处理列出的引擎，按给定顺序执行
# 镜像：npm 走 https://registry.npmmirror.com（NPM_MIRROR 可覆盖）；Codex 走 npmmirror 平台包
# 副作用：升级 Codex 会备份旧二进制到 /root/codex/*.bak-<旧版本>；替换期间不要派单
# 退出码：0 成功/已是最新；1 失败（升级 Codex 失败时备份仍在，可回滚）；2 用法错误
# 回滚：cp -a /root/codex/codex.bak-<旧版本> /root/codex/codex
#       cp -a /root/codex/codex-code-mode-host.bak-<旧版本> /root/codex/codex-code-mode-host
set -u

NPM_MIRROR="${NPM_MIRROR:-https://registry.npmmirror.com}"
MIRROR_ARG=(--registry "$NPM_MIRROR")
CODEX_DIR=/root/codex
CODEX_BIN="$CODEX_DIR/codex"
CODEX_HOST="$CODEX_DIR/codex-code-mode-host"
VENDOR=package/vendor/aarch64-unknown-linux-musl/bin

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) PLAT=linux-arm64 ;;
  x86_64|amd64)  PLAT=linux-x64 ;;
  *) echo "[engine-upgrade] 不支持的架构: $ARCH" >&2; exit 1 ;;
esac

log()  { printf '[engine-upgrade] %s\n' "$*"; }
die()  { printf '[engine-upgrade] 错误: %s\n' "$*" >&2; exit 1; }
usage(){ sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 2; }

latest_pi()     { npm view @earendil-works/pi-coding-agent version "${MIRROR_ARG[@]}" 2>/dev/null | tail -1; }
latest_claude() { npm view @anthropic-ai/claude-code version "${MIRROR_ARG[@]}" 2>/dev/null | tail -1; }
latest_codex()  { npm view @openai/codex version "${MIRROR_ARG[@]}" 2>/dev/null | tail -1; }

cur_pi()     { pi --version 2>/dev/null | tail -1; }
cur_claude() { claude --version 2>/dev/null | awk '{print $1}'; }
cur_codex()  { [ -x "$CODEX_BIN" ] && "$CODEX_BIN" --version 2>/dev/null | awk '{print $2}'; }

do_check() {
  printf '%-8s %-24s %-24s %s\n' "引擎" "当前版本" "最新版本" "状态"
  local c l
  c=$(cur_pi);  l=$(latest_pi);  printf '%-8s %-24s %-24s %s\n' "pi"      "${c:-未安装}" "${l:-查询失败}" "$([ -n "$c" ] && [ "$c" = "$l" ] && echo 已最新 || echo 有更新)"
  c=$(cur_claude); l=$(latest_claude); printf '%-8s %-24s %-24s %s\n' "claude"  "${c:-未安装}" "${l:-查询失败}" "$([ -n "$c" ] && [ "$c" = "$l" ] && echo 已最新 || echo 有更新)"
  c=$(cur_codex);  l=$(latest_codex);  printf '%-8s %-24s %-24s %s\n' "codex"   "${c:-未安装}" "${l:-查询失败}" "$([ -n "$c" ] && [ "$c" = "$l" ] && echo 已最新 || echo 有更新)"
}

upgrade_pi() {
  local c l; c=$(cur_pi); l=$(latest_pi)
  [ -n "$l" ] || die "查不到 @earendil-works/pi-coding-agent 最新版"
  [ "$c" = "$l" ] && { log "Pi 已是最新 $c"; return 0; }
  log "Pi: ${c:-未安装} -> $l"
  npm i -g "@earendil-works/pi-coding-agent@$l" "${MIRROR_ARG[@]}" >/dev/null 2>&1 || die "Pi 升级失败"
  [ "$(cur_pi)" = "$l" ] || die "Pi 版本复核失败（期望 $l，实际 $(cur_pi)）"
  log "Pi 升级成功：$(cur_pi)"
}

upgrade_claude() {
  local c l; c=$(cur_claude); l=$(latest_claude)
  [ -n "$l" ] || die "查不到 @anthropic-ai/claude-code 最新版"
  [ "$c" = "$l" ] && { log "Claude 已是最新 $c"; return 0; }
  log "Claude: ${c:-未安装} -> $l"
  npm i -g "@anthropic-ai/claude-code@$l" "${MIRROR_ARG[@]}" >/dev/null 2>&1 || die "Claude 升级失败"
  [ "$(cur_claude)" = "$l" ] || die "Claude 版本复核失败（期望 $l，实际 $(cur_claude)）"
  log "Claude 升级成功：$(cur_claude)"
}

upgrade_codex() {
  local c l tmp src
  c=$(cur_codex); l=$(latest_codex)
  [ -n "$l" ] || die "查不到 @openai/codex 最新版"
  [ "$c" = "$l" ] && { log "Codex 已是最新 $c"; return 0; }
  [ -n "$c" ] || die "当前 codex 不可用（$CODEX_BIN 缺失），跳过自动升级"
  log "Codex: $c -> $l（平台包 $PLAT）"
  tmp=$(mktemp -d) || die "mktemp 失败"
  curl -fL --retry 2 -o "$tmp/pkg.tgz" "https://registry.npmmirror.com/@openai/codex/-/codex-${l}-${PLAT}.tgz" 2>/dev/null \
    || { rm -rf "$tmp"; die "Codex 平台包下载失败"; }
  tar -xzf "$tmp/pkg.tgz" -C "$tmp" || { rm -rf "$tmp"; die "解压失败"; }
  src="$tmp/$VENDOR"
  [ -x "$src/codex" ] || { rm -rf "$tmp"; die "包内路径不符：$src/codex 不存在"; }
  "$src/codex" --version 2>/dev/null | grep -q "codex-cli ${l}" \
    || { rm -rf "$tmp"; die "包内 codex 版本不符，已中止（未动现有二进制）"; }
  cp -a "$CODEX_BIN"  "$CODEX_BIN.bak-${c}"  || { rm -rf "$tmp"; die "备份 codex 失败"; }
  cp -a "$CODEX_HOST" "$CODEX_HOST.bak-${c}" || { rm -rf "$tmp"; die "备份 sidecar 失败"; }
  cp "$src/codex" "$CODEX_BIN.new" && mv -f "$CODEX_BIN.new" "$CODEX_BIN" \
    || { rm -rf "$tmp"; die "替换 codex 失败（备份在 *.bak-${c}）"; }
  cp "$src/codex-code-mode-host" "$CODEX_HOST.new" && mv -f "$CODEX_HOST.new" "$CODEX_HOST" \
    || { rm -rf "$tmp"; die "替换 sidecar 失败（备份在 *.bak-${c}）"; }
  rm -rf "$tmp"
  [ "$(cur_codex)" = "$l" ] || die "Codex 版本复核失败（期望 $l）"
  log "Codex 升级成功：$(cur_codex)（回滚物 *.bak-${c}）"
}

verify_codex() {
  local ok=0
  log "检验 1/3 工具面"; node ~/.dsh/scripts/dsh/se-tool-probe.mjs 2>/dev/null | tail -2 || ok=1
  log "检验 2/3 执行链"; bash ~/.dsh/scripts/dsh/se-appserver-verify.sh 2>/dev/null | tail -2 || ok=1
  log "检验 3/3 依赖点"; python3 ~/.dsh/scripts/dsh/dsh-dep-check.py 2>/dev/null | tail -2 || ok=1
  [ "$ok" = 0 ] && log "三关检验全过" || log "警告：有检验未过，按 ref-codex-upgrade.md 处置"
  return "$ok"
}

MODE=upgrade
TARGETS=()
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    pi|claude|codex) TARGETS+=("$a") ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(pi claude codex)

if [ "$MODE" = check ]; then
  do_check
  exit 0
fi

for t in "${TARGETS[@]}"; do
  "upgrade_$t" || exit 1
done

for t in "${TARGETS[@]}"; do
  [ "$t" = codex ] && { verify_codex || exit 1; }
done

log "完成"

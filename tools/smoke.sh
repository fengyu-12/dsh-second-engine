#!/usr/bin/env bash
# smoke.sh — 插件冒烟（干净环境全链路）
#
# 背景：3.6.0 / 3.6.1 两次「装上就崩」都是作者机上目录早已手建、脚本从没在干净环境跑过。
# 这个脚本把当初的一次性验收固化成一条命令：改完插件先跑它，再谈发布。
#
# 覆盖：① 语法 ② Web 端口解析 ③ wait-task 联调 ④ 干净看板全链路
#       ⑤ dispatch 草稿 ⑥ install.sh dry-run ⑦ 行尾注释保留
# 用法：bash tools/smoke.sh      退出码：0 全过 / 1 有失败
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/se-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  ⏭  %s\n' "$*"; }

printf '\n== 1/8 语法 ==\n'
for f in "$ROOT"/tools/*.sh "$ROOT"/tools/dual-board/*.sh "$ROOT"/bridge/*.sh "$ROOT"/bridge/web/*.sh; do
  [ -f "$f" ] || continue
  if bash -n "$f" 2>"$TMP/err"; then ok "bash -n ${f#"$ROOT"/}"; else bad "bash -n ${f#"$ROOT"/}: $(head -2 "$TMP/err")"; fi
done
for f in "$ROOT"/src/*.js "$ROOT"/src/*.mjs "$ROOT"/lib/*.js "$ROOT"/bridge/web/*.mjs; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>"$TMP/err"; then ok "node --check ${f#"$ROOT"/}"; else bad "node --check ${f#"$ROOT"/}: $(head -2 "$TMP/err")"; fi
done

printf '\n== 2/8 Web 端口解析 ==\n'
base=$(bash -c '. "$1"; se_web_base' _ "$ROOT/tools/web-base.sh")
case "$base" in
  http://*) ok "se_web_base → $base" ;;
  *)        bad "se_web_base 输出异常: $base" ;;
esac
proc_port=$(bash -c '. "$1"; se_web_port_from_proc' _ "$ROOT/tools/web-base.sh")
if [ -n "$proc_port" ]; then
  [ "$base" = "http://127.0.0.1:$proc_port" ] && ok "与运行中 dsh web 端口一致（$proc_port）" \
    || bad "解析 $base ≠ 进程端口 $proc_port"
else
  skip "未发现运行中的 dsh web 进程（走 env / 3080 兜底）"
fi

printf '\n== 3/8 wait-task 联调 ==\n'
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$base/second-engine/api/status" 2>/dev/null || true)
if [ "$code" = "200" ]; then
  out=$(bash "$ROOT/tools/wait-task.sh" smoke-no-such-id 1 2 2>&1); rc=$?
  [ "$rc" = 3 ] && ok "不存在的工单 → exit 3（$out）" || bad "期望 exit 3，实得 $rc：$out"
else
  skip "接口不可用（http=$code），跳过"
fi

printf '\n== 4/8 干净看板全链路 ==\n'
export DUAL_BOARD_DIR="$TMP/board"
mkdir -p "$DUAL_BOARD_DIR"
B="$ROOT/tools/dual-board/board.sh"
run_board() { bash "$B" "$@" >>"$TMP/board.log" 2>&1; }
if run_board new t1 --subject smoke --task "干净环境验证" --context c --scope x; then ok "new（板不存在时自建）"; else bad "new: $(tail -3 "$TMP/board.log")"; fi
if run_board claim t1 --owner lead; then ok "claim"; else bad "claim: $(tail -3 "$TMP/board.log")"; fi
if run_board complete t1 --owner lead --result ok >/dev/null 2>&1; then bad "complete 未带 --reviewed-by human 竟然成功"; else ok "complete 无人确认被拒"; fi
if run_board complete t1 --owner lead --result ok --reviewed-by human; then ok "complete（人确认）"; else bad "complete: $(tail -3 "$TMP/board.log")"; fi
if run_board new t2 --subject s2 --task t2 --acceptance a2 >/dev/null 2>&1 && run_board complete t2 --owner lead --result r2 --keep >/dev/null 2>&1; then ok "complete --keep 免人审留在板"; else bad "complete --keep 失败: $(tail -3 "$TMP/board.log")"; fi
if run_board doctor >>"$TMP/board.log" 2>&1; then ok "doctor"; else bad "doctor: $(tail -3 "$TMP/board.log")"; fi

printf '\n== 5/8 dispatch 草稿 ==\n'
D="$ROOT/tools/dual-board/dispatch.sh"
if bash "$D" --help >"$TMP/dh.log" 2>&1; then ok "--help"; else bad "--help: $(head -3 "$TMP/dh.log")"; fi
if DUAL_BOARD_DIR="$TMP/dispatch-board" bash "$D" "smoke" --context c --self-test s --scope x --workdir "$TMP" --dry-run >"$TMP/dd.log" 2>&1; then
  ok "dry-run（无预建板、无收件箱）"
else
  bad "dry-run: $(head -5 "$TMP/dd.log")"
fi
grep -q 'SECOND_ENGINE_BASE_URL' "$ROOT/tools/web-base.sh" && grep -q 'se_web_base' "$D" \
  && ok "端口优先级链已接入 dispatch" || bad "dispatch 未接入 web-base.sh"

printf '\n== 6/8 install.sh dry-run ==\n'
if bash "$ROOT/bridge/install.sh" --dry-run --with-codex-env "$TMP/bridge-install" >"$TMP/in.log" 2>&1; then
  ok "dry-run --with-codex-env（set -e 下末行不再退出 1）"
else
  bad "install: $(head -5 "$TMP/in.log")"
fi
if grep -q 'server\.mjs' "$TMP/in.log" && grep -q 'list\.mjs' "$TMP/in.log" && grep -q 'codex-env' "$TMP/in.log"; then
  ok "拷贝清单含 server.mjs / list.mjs / codex-env"
else
  bad "dry-run 拷贝清单缺文件: $(grep -c . "$TMP/in.log") 行"
fi

printf '\n== 7/8 行尾注释保留 ==\n'
cat >"$TMP/toml.test.mjs" <<'JS'
const { replaceTomlValue } = await import(process.env.SE_ROOT + '/bridge/web/toml-comment.mjs');
const cases = [
  ['model = "a # b"', 'x', 'model = "x"'],
  ['model = "gpt"  # 主力', 'y', 'model = "y"  # 主力'],
  ['  model = "a"#注', 'z', '  model = "z"  #注'],
  ["model = 'lit # x' # c", 'w', 'model = "w"  # c'],
  ['model = "a\\" # b" # real', 'q', 'model = "q"  # real'],
];
let failed = 0;
for (const [line, val, want] of cases) {
  const got = replaceTomlValue(line, val);
  if (got !== want) {
    console.error('FAIL:', JSON.stringify(line), '→', JSON.stringify(got), 'want', JSON.stringify(want));
    failed = 1;
  }
}
process.exit(failed);
JS
if SE_ROOT="$ROOT" node "$TMP/toml.test.mjs"; then ok "引号感知 / 无空格尾注 / 单引号字符串"; else bad "注释保留单测失败（见上）"; fi

printf '\n结果：%d 通过 / %d 失败 / %d 跳过\n' "$PASS" "$FAIL" "$SKIP"
printf '\n== 8/8 三处落点对齐 ==\n'
PUB_DIR="${SE_PUBLISH_DIR:-/root/Documents/deepseek-harness/default-workspace/共同工作区/second-engine-publish}"
LOAD_DIR="${SE_LOAD_DIR:-$HOME/.dsh/plugin-src/dsh-second-engine}"
if [ -d "$PUB_DIR" ] && [ -d "$LOAD_DIR" ]; then
  align_bad=0; align_n=0
  # 发布树剔私版：只比存在、不比内容（本机路径被换成「不随包分发」说明）
  # 发布树剔私版：只比存在、不比内容（本机路径被换成占位符）
  PRIVATE_STRIPPED=" src/app-server-client.js tools/dual-board/PROTOCOL.md bridge/README.md bridge/env.example bridge/CHANGELOG.md tools/README.md "
  EXPLICIT="tools/web-base.sh tools/smoke.sh tools/wait-task.sh tools/dual-board/dispatch.sh bridge/web/toml-comment.mjs bridge/web/server.mjs bridge/pi/server.mjs package.json src/index.js src/app-server-client.js src/bridge.js src/bridge-routes.js src/collab.js src/engine/runtime.js src/engine/pi-runtime.js src/engine/pi-rpc-runtime.js src/engine/registry.js src/engine/pi-probe.js lib/client.js tools/dual-board/board_tool.py tools/dual-board/board.sh tools/dual-board/trace_search.py"
  # 2026-10-29：清单 = 精选 + 全量 JS 动态。手写清单曾漏 as-client.mjs / pi-bridge.js 等 6 个文件，
  # 那天只改了实体没同步另两处，smoke 照样全绿 → 新增文件必须自动纳入，不靠人记得改清单。
  DYNAMIC=$(git -C "$ROOT" ls-files 2>/dev/null | grep -E '\.(js|mjs|cjs)$')
  # 发布树有权不含的开发件（仍与生效层比对，缺了不算失败）
  # smoke.sh 自己与 eslint 配置只对「改插件的人」有意义，下游拿到没有用处 → 不进发布包（2026-10-29 定）
  PUB_OPTIONAL=" selftest-block.mjs tools/smoke.sh tools/lint-undef.config.mjs "
  for f in $(printf '%s\n%s\n' "$EXPLICIT" "$DYNAMIC" | tr ' ' '\n' | grep -v '^$' | sort -u); do
    [ -f "$ROOT/$f" ] || continue
    case "$PRIVATE_STRIPPED" in
      *" $f "*)
        if [ -f "$PUB_DIR/$f" ]; then ok "剔私文件在位（不比内容）: $f"; else bad "发布树缺剔私文件: $f"; fi
        continue;;
    esac
    align_n=$((align_n+1))
    s1=$(md5sum "$ROOT/$f" | cut -d' ' -f1)
    s2=$(md5sum "$PUB_DIR/$f" 2>/dev/null | cut -d' ' -f1)
    s3=$(md5sum "$LOAD_DIR/$f" 2>/dev/null | cut -d' ' -f1)
    case "$PUB_OPTIONAL" in
      *" $f "*) [ -n "$s2" ] || s2=$s1;;
    esac
    if [ "$s1" != "$s2" ] || [ "$s1" != "$s3" ]; then
      align_bad=$((align_bad+1)); printf '  ⚠️  %s 实体=%s 发布=%s 加载=%s\n' "$f" "${s1:0:8}" "${s2:0:8}" "${s3:0:8}"
    fi
  done
  [ "$align_bad" = 0 ] && ok "代码文件三处一致（$align_n 个）" || bad "三处落点 $align_bad 个文件不一致"
  # 不按本机绝对路径分支：只要加载层有 README 就比（发布树是剔私版，不比）
  if [ -f "$LOAD_DIR/README.md" ]; then
    cmp -s "$ROOT/README.md" "$LOAD_DIR/README.md" && ok "README 实体=加载（发布树为剔私版，不比）" || bad "README 实体与加载层不一致"
  fi
  # docs/：实体 = 加载层必须是完整镜像（生效层要能对着文档排查）。
  # 发布树是有意剔私的（appserver-* 本机排查记录、capabilities 派单计划都不随包），故不比。
  # 2026-10-28 立：此前 docs 完全不在检查范围，加载层的 task-runtime-contract.md
  # 落后实体 6 行注释（cancel 语义）却没被发现——只能靠手工全量 md5 扫才看见。
  docs_bad=0; docs_n=0
  for f in $(cd "$ROOT" && ls docs/*.md 2>/dev/null); do
    [ -f "$ROOT/$f" ] || continue
    docs_n=$((docs_n+1))
    if [ ! -f "$LOAD_DIR/$f" ]; then
      docs_bad=$((docs_bad+1)); printf '  ⚠️  加载层缺 %s\n' "$f"
    elif ! cmp -s "$ROOT/$f" "$LOAD_DIR/$f"; then
      docs_bad=$((docs_bad+1)); printf '  ⚠️  %s 实体≠加载\n' "$f"
    fi
  done
  [ "$docs_bad" = 0 ] && ok "docs 实体=加载（$docs_n 个；发布树剔私不比）" || bad "docs 有 $docs_bad 个不一致/缺失"
  # 可执行位：zip 打包（含手机端 MT 管理器）会丢掉 Unix 权限位。
  # 2026-10-28 实测：从 zip 同步回来后 ctl.sh 变 600，面板点「聊天桥→启动」报
  # EACCES: permission denied, access '.../bridge/web/ctl.sh'。加这道闸免得再发一次。
  exec_bad=0; exec_n=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    exec_n=$((exec_n+1))
    [ -x "$ROOT/${f#./}" ] || { exec_bad=$((exec_bad+1)); printf '  ⚠️  无执行位: %s\n' "$f"; }
  done <<EOF
$(cd "$ROOT" && find . -name "*.sh" -not -path "./node_modules/*" 2>/dev/null | sort)
EOF
  [ -x "$ROOT/bridge/web/codex-env" ] || { exec_bad=$((exec_bad+1)); printf '  ⚠️  无执行位: bridge/web/codex-env\n'; }
  [ "$exec_bad" = 0 ] && ok "可执行位齐全（$exec_n 个 .sh + codex-env）" || bad "$exec_bad 个脚本缺执行位（zip 打包会丢）"
else
  skip "发布树或 plugin-src 不存在（SE_PUBLISH_DIR / SE_LOAD_DIR 可覆盖），跳过三处比对"
fi

printf '\n== 9/9 未定义变量（no-undef）==\n'
# 为什么加这段：`node --check` 只查语法。2026-10-28 设置页引用了浮球面板的 busy，
# 语法完全合法，运行时 ReferenceError 把整块设置页渲染搞白。eslint 的 no-undef 能抓。
if command -v eslint >/dev/null 2>&1 && [ -f "$ROOT/tools/lint-undef.config.mjs" ]; then
  if eslint --config "$ROOT/tools/lint-undef.config.mjs" "$ROOT/lib/client.js" "$ROOT/src/index.js" >/tmp/se-lint.$$ 2>&1; then
    ok "no-undef 干净（client.js + index.js）"
  else
    bad "no-undef 报错："; grep -E "error" /tmp/se-lint.$$ | head -5
  fi
  rm -f /tmp/se-lint.$$
else
  skip "eslint 未安装（npm i -g eslint）"
fi

[ "$FAIL" -eq 0 ]

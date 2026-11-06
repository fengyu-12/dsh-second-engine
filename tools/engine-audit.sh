#!/usr/bin/env bash
#
# tools/engine-audit.sh — dsh-second-engine「新引擎接入」机械项自检
#
# 用法:  bash tools/engine-audit.sh <engine>        engine ∈ codex|pi|claude
# 可用环境变量覆盖路径:
#   ROOT          仓库根           (默认 /root/dsha-second-engine)
#   AGENTS_MD     board 段文案     (默认 ~/.codex/AGENTS.md)
#   MIRROR_A/B/C  三处发布镜像     (默认见 item 12)
# 退出码: 0 全部 OK | 1 有 MISS | 2 必需文件缺失 | 3 用法错误
#
# 只读: 全部检查为 grep/sed/awk/md5sum/find, 不修改任何文件, 不运行 Node。

set -uo pipefail

ROOT=${ROOT:-/root/dsha-second-engine}
AGENTS_MD=${AGENTS_MD:-$HOME/.codex/AGENTS.md}
MIRROR_A=${MIRROR_A:-/root/dsha-second-engine}
MIRROR_B=${MIRROR_B:-$HOME/.dsh/plugin-src/dsh-second-engine}
MIRROR_C=${MIRROR_C:-/root/Documents/deepseek-harness/default-workspace/共同工作区/second-engine-publish}

# ---- 检查清单 (12 项) ------------------------------------------------------
CHECKS=(
  "ENGINES 登记"
  "capabilities 填满"
  "CLEANUP_TARGETS 登记"
  "引擎白名单"
  "taskWorkdirForEngine 分流"
  "引擎分支点覆盖"
  "设置页判断非二元"
  "悬浮球判断非二元"
  "StatusCard 判断非二元"
  "board 角色表"
  "AGENTS.md 文案"
  "三处一致"
)
# 文件缺失分级:
#   必需文件 registry.js / src/index.js / tools/dual-board/board_tool.py => exit 2
#   附加性/跨仓库项 (src/ 目录、AGENTS.md、三处镜像)                     => 降级为 MISS (exit 1)

# ---- 状态 ------------------------------------------------------------------
MISSES=0
FILE_MISSING=0
IDX=0

say()  { printf '%s\n' "$*"; }
ok()   { say "[OK] $1"; }
miss() { say "[MISS] $1 $2"; MISSES=$((MISSES + 1)); }
# 文件存在性前置守门: 必需文件缺失 => exit 2
require_file() {
  if [ ! -f "$1" ]; then
    say "[MISS] ${CHECKS[$IDX]} 文件缺失:$1"
    FILE_MISSING=1
    return 1
  fi
  return 0
}
# 附加性/跳仓库的文件缺失 => 降级为 MISS (exit 1)
file_missing() { miss "${CHECKS[$IDX]}" "文件缺失:$1"; }
# grep 无命中 => MISS, 打印 文件:行号 (文件内找不到该标识时退化为 文件:1)
grep_miss() {  # $1=检查名 $2=文件 $3=ERE
  local l
  l=$(grep -nE "$3" "$2" 2>/dev/null | head -1 | cut -d: -f1)
  [ -n "$l" ] || l=1
  miss "$1" "$2:$l"
}

# ---- 行/区间工具 -----------------------------------------------------------
line_of()   { grep -nE "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1; }   # 首个匹配行号
# 函数/对象块尾: 从 $2 行起做「累计花括号深度」扫描 (同 enclosing 的思路)
# 不能用顶格 }, 也不能用单行净增量: const x = {} / 单行字面量都会让单行失衡
block_end() {
  awk -v s="$2" '
    function strip(t) { gsub(/\/\/.*$/, "", t); return t }   # 只去行尾注释; 绝不能删引号串——引擎名就在引号里
    { L[NR] = $0; N = NR }
    END {
      d = 0
      for (i = 1; i <= N; i++) {
        t = strip(L[i])
        d += gsub(/\{/, "{", t) - gsub(/\}/, "}", t)
        D[i] = d
      }
      # 关键: 用「相对深度」——以起始行之前的累计深度为基准。
      # 全局深度到 0 的写法在 `export const ENGINES = { ... };` 这种顶格闭合下行不通
      # (起始行本身已在深度 1 里), 会把块尾算到文件末尾。
      B = (s > 1 ? D[s - 1] : 0)
      for (i = s; i <= N; i++) if (D[i] - B <= 0) { print i; exit }
    }' "$1"
}
# 区间匹配统一用 grep -E (本机 awk 是 mawk, 动态正则不可靠; grep 对 JS 里的奇形字符也不会报错)
# ⚠ 两个已踩过的坑:
#   1) 不要用 grep 退出码判断「正则是否合法」: 本机 grep 无论正则合法与否都不报错,
#      退出码只反映有无匹配; grep -cE "$re" /dev/null 探测更是把合法正则当非法。
#   2) awk 程序用单引号包裹时, 后面跟的 -F: 会把紧跟的空格当选项值(-F 参数 = " "),
#      导致 -F: 失效、awk 按空格分列、$1 变成单词而不是行号。必须用 -v FS=: 或 -F':'。
range_has() {
  local f=$1 a=$2 b=$3 re=$4
  [ -f "$f" ] || return 1
  [ -n "$(grep -nE "$re" "$f" 2>/dev/null | awk -v a="$a" -v b="$b" -v FS=: '$1 >= a && $1 <= b { print $1; exit }')" ]
}
# 词边界: 用 POSIX 括号类而不是 \b (\b 在不同 grep/sed 实现里行为不一致)
wb() { printf "(^|[^[:alnum:]_])%s([^[:alnum:]_]|$)" "$1"; }
# 区间内匹配的行号列表
slice_re() {
  local f=$1 a=$2 b=$3 re=$4
  [ -f "$f" ] || return 0
  grep -nE "$re" "$f" 2>/dev/null | awk -v a="$a" -v b="$b" -v FS=: '$1 >= a && $1 <= b'
}
# 引擎「等值判断」行: 只算 if/三元里的 === == !== != (case 'pi' 归入下面的 switch 判据)
# 一律用 ERE 分组形式 (不用 | 顶层交替): 跨 awk 实现更可移植
eng_cmp() { printf "(===|!==|==|!=)[[:space:]]*['\"]%s['\"]" "$1"; }
any_other_engine() { printf "(===|!==|==|!=)[[:space:]]*['\"](codex|claude)['\"]"; }
# 多引擎分流形式: switch / default 分支 / includes([...]) 白名单
multi_form() { printf "(switch[[:space:]]*\(|default[[:space:]]*:|includes\(\\[)"; }
# 取 $1 里 $2 行所在的「最内层函数体」起止行 -> "start end"
# 算法: 先算每行结束时的累计花括号深度 D[] (不用单行平衡 —— 单行对象/数组字面量本来就不平衡),
#       目标行之前最近一个「本行带 { 且 D[i-1] <= 0 && D[i] > 0」的行 = 所在块开括号行,
#       再从该行往下取「D[i-1] > 0 && D[i] <= 0」的行 = 块尾。
enclosing() {
  awk -v n="$2" '
    function strip(s) { gsub(/\/\/.*$/, "", s); return s }   # 只去行尾注释; 绝不能删引号串——引擎名就在引号里
    { L[NR] = $0; N = NR }
    END {
      if (!n || n > N) exit
      d = 0
      for (i = 1; i <= N; i++) {
        t = strip(L[i])
        d += gsub(/\{/, "{", t) - gsub(/\}/, "}", t)
        D[i] = d
      }
      st = 0
      for (i = n - 1; i >= 1; i--) {
        if (index(strip(L[i]), "{") > 0 && D[i - 1] + 0 <= 0 && D[i] > 0) { st = i; break }
      }
      if (!st) exit
      # 块尾 = 累计深度从正数回到 0 的那一行 (D[i-1] > 0 && D[i] <= 0)
      for (i = st; i <= N; i++) if (D[i - 1] + 0 > 0 && D[i] <= 0) { print st, i; exit }
      print st, N
    }' "$1"
}
# ---- 参数 ------------------------------------------------------------------
ENGINE=${1-}
case "$ENGINE" in
  codex|pi|claude) ;;
  *) say "用法: bash tools/engine-audit.sh <engine>    engine ∈ codex|pi|claude" >&2; exit 3 ;;
esac

REG=$ROOT/src/engine/registry.js
IDX_JS=$ROOT/src/index.js
CLIENT=$ROOT/lib/client.js          # 前端: 悬浮球 / StatusCard 的引擎判断在这里
BOARD=$ROOT/tools/dual-board/board_tool.py

say "# engine-audit: $ENGINE"
say "# ROOT=$ROOT"
say ""

# ---- 1. ENGINES 登记 -------------------------------------------------------
IDX=0
if [ ! -f "$REG" ]; then
  require_file "$REG"
else
  tl=$(line_of "$REG" 'ENGINES[[:space:]]*=')
  if [ -z "$tl" ]; then
    grep_miss "${CHECKS[$IDX]}" "$REG" 'ENGINES'
  else
    ee=$(block_end "$REG" "$tl"); ee=${ee:-999999}
    if [ -n "$(slice_re "$REG" "$tl" "$ee" "^[[:space:]]*(${ENGINE})[[:space:]]*:")" ]; then
      ok "${CHECKS[$IDX]}"
    else
      miss "${CHECKS[$IDX]}" "$REG:$tl"
    fi
  fi
fi

# ---- 2. capabilities 填满 --------------------------------------------------
# 位置: ENGINES.<engine>.capabilities (在引擎条目内部, 不是文件顶层)
# 判据: 块内 resume: / review: / chatBridge: 三个键都出现且各有值 (true/false 均可)
# 注: 完整字段集是 executor / eventStream / approvals / resume / review /
#     chatBridge / chatBridgeMode / modelSwitch, 但只有这三个是必需硬判据;
#     三家都没有 webSearch, 不要查它。
IDX=1
if [ ! -f "$REG" ]; then
  require_file "$REG"
else
  # 必须先框定 ENGINES 块，否则会抓到 CLEANUP_TARGETS 里的同名条目（第 27 行的 codex:）
  EL=$(line_of "$REG" 'export const ENGINES')
  EE=$(block_end "$REG" "$EL"); EE=${EE:-999999}
  S=$(slice_re "$REG" "$EL" "$EE" "^[[:space:]]*${ENGINE}[[:space:]]*:" | head -1 | cut -d: -f1)
  if [ -z "$S" ]; then
    grep_miss "${CHECKS[$IDX]}" "$REG" "^[[:space:]]*ENGINES"
  else
    E=$(block_end "$REG" "$S"); E=${E:-999999}
    cs=$(slice_re "$REG" "$S" "$E" 'capabilities[[:space:]]*:' | head -1 | cut -d: -f1)
    if [ -z "$cs" ]; then
      miss "${CHECKS[$IDX]}" "$REG:$S 无 capabilities 块"
    else
      ce=$(block_end "$REG" "$cs"); ce=${ce:-$E}
      bad=""
      for f in resume review chatBridge; do
        # 「有值」: 布尔 / 字符串 / 数字 / 变量引用都算, 只要键在且冒号后非空
        range_has "$REG" "$cs" "$ce" "^[[:space:]]*['\"]?${f}['\"]?[[:space:]]*:[[:space:]]*[^[:space:],]" || bad="$bad $f"
      done
      if [ -z "$bad" ]; then ok "${CHECKS[$IDX]}"; else miss "${CHECKS[$IDX]}" "$REG:$cs 缺键:$bad"; fi
    fi
  fi
fi

# ---- 3. CLEANUP_TARGETS 登记 ----------------------------------------------
# 位置: src/engine/registry.js 的 export const CLEANUP_TARGETS = { (不在 src/index.js)
# 判据: 该块内有 <engine>: 键 (带引号或不带引号都认)
IDX=2
if [ ! -f "$REG" ]; then
  require_file "$REG"
else
  l=$(line_of "$REG" 'CLEANUP_TARGETS')
  if [ -z "$l" ]; then
    grep_miss "${CHECKS[$IDX]}" "$REG" 'CLEANUP_TARGETS'
  else
    e=$(block_end "$REG" "$l"); e=${e:-999999}
    if range_has "$REG" "$l" "$e" "^[[:space:]]*['\"]?${ENGINE}['\"]?[[:space:]]*:"; then
      ok "${CHECKS[$IDX]}"
    else
      miss "${CHECKS[$IDX]}" "$REG:$l"
    fi
  fi
fi

# ---- 4. 引擎白名单 (至少 3 处) --------------------------------------------
IDX=3
if [ ! -f "$IDX_JS" ]; then
  require_file "$IDX_JS"
else
  n=$(grep -cE "$(wb "$ENGINE")" "$IDX_JS" 2>/dev/null); n=${n:-0}
  if [ "$n" -ge 3 ]; then
    ok "${CHECKS[$IDX]}"
  else
    l=$(line_of "$IDX_JS" "$(wb "$ENGINE")"); l=${l:-1}
    miss "${CHECKS[$IDX]}" "$IDX_JS:$l 命中 ${n} 处 (需 >=3)"
  fi
fi

# ---- 5. taskWorkdirForEngine 分流 -----------------------------------------
# 位置: src/index.js 里的 taskWorkdirForEngine
# 判据: 函数体内出现 '<engine>' ; 或该引擎走 else / 默认兜底分支 -> 同样 OK
#       (codex 就是默认分支, 不会为它写显式 case)
# 兜底用「结构」而不是关键字判断: 真实代码里兜底常常就是一句结尾的无条件 return
# (行尾注释写「默认分支」但并没有 default 这个 token), 所以看函数体最后一条语句。
IDX=4
if [ ! -f "$IDX_JS" ]; then
  require_file "$IDX_JS"
else
  # 以函数定义行为起点 (而不是调用点), 否则块尾会乱
  l=$(line_of "$IDX_JS" 'function[[:space:]]+taskWorkdirForEngine|taskWorkdirForEngine[[:space:]]*[:=(]')
  if [ -z "$l" ]; then
    grep_miss "${CHECKS[$IDX]}" "$IDX_JS" 'taskWorkdirForEngine'
  else
    e=$(block_end "$IDX_JS" "$l"); e=${e:-999999}
    if range_has "$IDX_JS" "$l" "$e" "['\"]${ENGINE}['\"]"; then
      ok "${CHECKS[$IDX]}"
    elif slice_re "$IDX_JS" "$l" "$e" '(default[[:space:]]*:|fallback)' | grep -q . \
         || slice_re "$IDX_JS" "$l" "$e" 'else([[:space:]]+if)?([[:space:]]*\{|[[:space:]]+return)' | grep -q . \
         || slice_re "$IDX_JS" "$l" "$e" '(^|\})[[:space:]]*else([[:space:]]|$)' | grep -q . \
         || awk -v a="$l" -v b="$e" '
              NR >= a && NR < b && $0 ~ /^[[:space:]]*return([[:space:]]|$)/ { last = NR }
              END { exit !(last && last >= b - 2) }' "$IDX_JS"; then
      # 没有显式分支, 但函数结尾有无条件兜底路径接住该引擎 => 视为已分流
      ok "${CHECKS[$IDX]}"
    else
      miss "${CHECKS[$IDX]}" "$IDX_JS:$l 函数体 ${l}-${e} 既无 '${ENGINE}' 也无默认兜底分支"
    fi
  fi
fi

# ---- 6. 引擎分支点覆盖 ----------------------------------------------------
IDX=5
if [ ! -d "$ROOT/src" ]; then
  file_missing "$ROOT/src"
elif [ "$ENGINE" = pi ]; then
  # 基准引擎本身: 按规约恒 OK
  ok "${CHECKS[$IDX]}"
else
  N=$(cd "$ROOT" && grep -rn "=== 'pi'" src/ 2>/dev/null | wc -l | tr -d ' \n'); N=${N:-0}
  M=$(cd "$ROOT" && grep -rn "=== '${ENGINE}'" src/ 2>/dev/null | wc -l | tr -d ' \n'); M=${M:-0}
  if [ "$M" -gt 0 ]; then
    ok "${CHECKS[$IDX]}"
  else
    l=$(cd "$ROOT" && grep -rn "=== 'pi'" src/ 2>/dev/null | head -1 | cut -d: -f2); l=${l:-1}
    miss "${CHECKS[$IDX]}" "$ROOT/src/:${l} N(=== 'pi')=${N} M(=== '${ENGINE}')=${M} 差值 N-M=$((N - M))"
  fi
fi

# ---- 7/8/9. 三处「引擎判断非二元」 ----------------------------------------
# 判据: 先用 UI 关键词(设置页/悬浮球/StatusCard) ±WIN 行定位相关区域; 再看区域内
#       对 pi 的等值判断行——它所在的整个函数体(找不到函数体时退化为 ±WIN 窗口)
#       必须另有 (a) codex/claude 的等值判断 或 (b) switch/default;
#       否则就是 if(pi)else 二元形态 -> MISS。
nonbinary() {  # $1=检查序号 $2=UI 关键词 ERE $3=窗口行数
  IDX=$1
  local kw=$2 win=$3 p seg s2 e2
  if [ ! -f "$IDX_JS" ]; then require_file "$IDX_JS"; return; fi
  # 入口: 文件里找不到该 UI 区域 => 无从判断, 直接 MISS 并给出搜索词行号
  if ! grep -qE "$kw" "$IDX_JS" 2>/dev/null; then grep_miss "${CHECKS[$IDX]}" "$IDX_JS" "$kw"; return; fi
  # 该文件完全没对 pi 做等值判断 => 不存在二元形态
  if ! grep -qE "$(eng_cmp pi)" "$IDX_JS" 2>/dev/null; then ok "${CHECKS[$IDX]}"; return; fi
  for p in $(grep -nE "$(eng_cmp pi)" "$IDX_JS" 2>/dev/null | cut -d: -f1); do
    # 只看落在 UI 关键词 ±win 行内的 pi 判断
    if ! grep -nE "$kw" "$IDX_JS" 2>/dev/null | awk -v p="$p" -v w="$win" \
         -v FS=: '$1 >= p - w && $1 <= p + w { found = 1 } END { exit !found }'; then
      continue
    fi
    seg=$(enclosing "$IDX_JS" "$p")
    if [ -n "$seg" ]; then set -- $seg; s2=$1; e2=$2
    else s2=$((p - win)); [ "$s2" -lt 1 ] && s2=1; e2=$((p + win)); fi
    if ! range_has "$IDX_JS" "$s2" "$e2" "$(any_other_engine)" \
       && ! range_has "$IDX_JS" "$s2" "$e2" "$(multi_form)"; then
      miss "${CHECKS[$IDX]}" "$IDX_JS:$p 函数体 ${s2}-${e2} 只对 pi 做等值判断 (二元形态)"
      return
    fi
  done
  ok "${CHECKS[$IDX]}"
}
nonbinary 6 '设置页|settingsPage|SettingsPage|settings-page' 15

# ---- 8/9. 悬浮球 / StatusCard (前端 lib/client.js) -------------------------
# 这两处的引擎判断不在 src/index.js, 在 lib/client.js, 形态也不是 if(pi)else,
# 而是 d.engine.active === '<engine>' 这种逐引擎判断。
# 判据: d.engine.active === '<engine>' 出现 >=1 处 ;
#       或该引擎出现在默认值 / 映射表里。后端侧「映射表的值」也要算
#       (如 const STATUS_LABEL = { codex: 'CX', ... }), 否则 codex 这种
#       只在映射表里露面的引擎会被误报。
ui_engine_branch() {  # $1=检查序号 $2=UI 关键词 ERE
  IDX=$1
  local kw=$2 n seg s e
  if [ ! -f "$CLIENT" ]; then file_missing "$CLIENT"; return; fi
  # 该 UI 区域完全不在前端文件里 => MISS(给搜索词, 方便人确认是不是改了名)
  if ! grep -qE "$kw" "$CLIENT" 2>/dev/null; then grep_miss "${CHECKS[$IDX]}" "$CLIENT" "$kw"; return; fi
  # 主判据: 逐引擎等值判断 (d.engine.active === 'x' 等)
  n=$(grep -nE "[A-Za-z_$.)]*[A-Za-z0-9_$]*\.active[[:space:]]*===[[:space:]]*['\"]${ENGINE}['\"]" "$CLIENT" 2>/dev/null | wc -l | tr -d ' \n'); n=${n:-0}
  if [ "$n" -ge 1 ]; then ok "${CHECKS[$IDX]}"; return; fi
  # 默认引擎（ENGINES 第一个键 = activeEngineId 兜底）无需显式判断
  local _el _ee _first
  _el=$(line_of "$REG" 'export const ENGINES')
  _ee=$(block_end "$REG" "$_el"); _ee=${_ee:-999999}
  _first=$(sed -n "${_el},${_ee}p" "$REG" 2>/dev/null | grep -oE "^[[:space:]]*[A-Za-z_]+[[:space:]]*:" | head -1 | sed 's/[[:space:]:]//g')
  if [ -n "$_first" ] && [ "$_first" = "$ENGINE" ]; then ok "${CHECKS[$IDX]}"; return; fi
  # 备选判据: 默认值 / 映射表 / case 分支。必须在「该 UI 关键词 ±WIN 行」范围内看——
  # 全文扫会让另一个 UI 函数里的映射表替本引擎答上 OK(误报)。
  # 引擎名在表里可能是键({ codex: / 'codex': )也可能是值(return 'codex' / || 'codex')。
  # 注意: 不用 (^|[{,(])x 这种写法 —— grep 看到像区间量词的 {..} 会当非法正则退 1。
  for s in $(grep -nE "$kw" "$CLIENT" 2>/dev/null | cut -d: -f1); do
    local a=$((s - 15)); [ "$a" -lt 1 ] && a=1
    e=$((s + 15))
    range_has "$CLIENT" "$a" "$e" "(active|engine|default[A-Za-z]*)[[:space:]]*:[[:space:]]*['\"]${ENGINE}['\"]" && { ok "${CHECKS[$IDX]}"; return; }
    range_has "$CLIENT" "$a" "$e" "case[[:space:]]+['\"]${ENGINE}['\"]"               && { ok "${CHECKS[$IDX]}"; return; }
    range_has "$CLIENT" "$a" "$e" "^[[:space:]]*['\"]?${ENGINE}['\"]?[[:space:]]*:"         && { ok "${CHECKS[$IDX]}"; return; }
    range_has "$CLIENT" "$a" "$e" "(\{|,|\()[[:space:]]*['\"]?${ENGINE}['\"]?[[:space:]]*:"  && { ok "${CHECKS[$IDX]}"; return; }
    range_has "$CLIENT" "$a" "$e" "(return|\|\|)[[:space:]]*['\"]${ENGINE}['\"]"           && { ok "${CHECKS[$IDX]}"; return; }
  done
  miss "${CHECKS[$IDX]}" "$CLIENT:$(line_of "$CLIENT" "$kw") 无 engine.active === '${ENGINE}' 也不在默认值/映射表里"
}
ui_engine_branch 7 '悬浮球|floatingBall|FloatingBall|floating-ball|floatBall'
ui_engine_branch 8 'StatusCard|statusCard|status-card'

# ---- 10. board 角色表 -----------------------------------------------------
IDX=9
if [ ! -f "$BOARD" ]; then
  require_file "$BOARD"
else
  l=$(line_of "$BOARD" 'DEFAULT_ROLES')
  if [ -z "$l" ]; then
    grep_miss "${CHECKS[$IDX]}" "$BOARD" 'DEFAULT_ROLES'
  else
    e=$(block_end "$BOARD" "$l"); e=${e:-999999}
    if range_has "$BOARD" "$l" "$e" "['\"]${ENGINE}['\"]"; then
      ok "${CHECKS[$IDX]}"
    else
      miss "${CHECKS[$IDX]}" "$BOARD:$l"
    fi
  fi
fi

# ---- 11. AGENTS.md 文案 (board 段) ----------------------------------------
IDX=10
if [ ! -f "$AGENTS_MD" ]; then
  file_missing "$AGENTS_MD"
else
  # 标题行只看本行。注意: 这段不能用 awk '/^#{1,6}...[Bb]oard/ {...}' —— 单引号程序里
  # 紧跟在 [Bb]oard 后的 '/' 会被 awk 当成除号(表达式语境), 正则永不生效。
  l=$(grep -nE '^#{1,6}[[:space:]].*[Bb]oard' "$AGENTS_MD" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -n "$l" ]; then
    e=$(grep -nE '^#{1,6}[[:space:]]' "$AGENTS_MD" 2>/dev/null | awk -v s="$l" -v FS=: '$1 > s { print $1; exit }')
    e=${e:-999999}
    if range_has "$AGENTS_MD" "$l" "$e" "$(wb "$ENGINE")"; then
      ok "${CHECKS[$IDX]}"
    else
      miss "${CHECKS[$IDX]}" "$AGENTS_MD:$l"
    fi
  else
    grep_miss "${CHECKS[$IDX]}" "$AGENTS_MD" "(^|[^[:alnum:]_])[Bb]oard([^[:alnum:]_]|$)"
  fi
fi

# ---- 12. 三处 src/*.js md5 一致 ------------------------------------------
IDX=11
gap=""
for m in "$MIRROR_A" "$MIRROR_B" "$MIRROR_C"; do
  [ -d "$m/src" ] || gap="$gap $m/src"
done
if [ -n "$gap" ]; then
  file_missing "$gap"
else
  badlist=$(mktemp) || badlist=/dev/null
  # 以 A 处 src/*.js 为基准逐个同名文件比 md5 (避开跳版本新增文件刷屏)
  files=$( cd "$MIRROR_A" && find src -type f -name '*.js' | LC_ALL=C sort )
  for rel in $files; do
    fa=$MIRROR_A/$rel; fb=$MIRROR_B/$rel; fc=$MIRROR_C/$rel
    absent=""
    for f in "$fb" "$fc"; do [ -f "$f" ] || absent="$absent $f"; done
    if [ -n "$absent" ]; then
      printf '%s %s:1 缺文件:%s\n' "$rel" "$fa" "$absent" >> "$badlist"
      continue
    fi
    ha=$(md5sum "$fa" | awk '{print $1}')
    hb=$(md5sum "$fb" | awk '{print $1}')
    hc=$(md5sum "$fc" | awk '{print $1}')
    if [ "$ha" != "$hb" ] || [ "$ha" != "$hc" ]; then
      printf '%s %s:1 md5 不一致 A=%s B=%s C=%s\n' "$rel" "$fa" "$ha" "$hb" "$hc" >> "$badlist"
    fi
  done
  if [ -s "$badlist" ]; then
    while read -r rel loc rest; do miss "${CHECKS[$IDX]}" "$loc $rest"; done < "$badlist"
  else
    ok "${CHECKS[$IDX]}"
  fi
  [ "$badlist" != /dev/null ] && rm -f "$badlist"
fi

# ---- 汇总 ------------------------------------------------------------------
say ""
if [ "$FILE_MISSING" = 1 ]; then
  say "# 结果: 必需文件缺失, 自检未完成"
  exit 2
fi
if [ "$MISSES" -gt 0 ]; then
  say "# 结果: ${MISSES}/${#CHECKS[@]} 项 MISS"
  exit 1
fi
say "# 结果: 全部 ${#CHECKS[@]} 项 OK"
exit 0

// TOML 行级工具（server.mjs 的 updateConfigToml 使用；抽成独立模块是为了能被 tools/smoke.sh 单测）
//
// 2026-10-27 修「保留行尾注释」的引号盲区：
//   旧实现用 /\s#\s/ 找注释位置，当值本身含 " # "（如 model = "a # b"）时会从引号内部切开，
//   旧值残余被当作注释拼回新行（注释被污染）；且 `key="v"#注`（# 前后无空格）根本不匹配，
//   那行注释照样被抹掉。这里按 TOML 词法走一遍：
//   - 双引号字符串内支持反斜杠转义，单引号 literal 字符串内不转义；
//   - 字符串外的第一个 # 起即为注释（TOML 裸键不含 #，无需要求 # 前有空格）。
// 限制：本函数按行处理，多行字符串（""" / '''）的跨行状态不跟踪——
//       config.toml 的顶层键值基本都是单行，遇到多行字符串请人工确认。

// 返回 { code, comment }：comment 含行首 '#'（无注释时为 ''）。
export function splitTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') return { code: line.slice(0, i), comment: line.slice(i) };
  }
  return { code: line, comment: '' };
}

// 把一行 `key = value [ # 注释]` 改成 `key = <新值> [  # 注释]`。
// 无法识别的行原样返回；缩进与注释保留，值统一按 JSON 字符串写法。
export function replaceTomlValue(line, value) {
  const m = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*=/);
  if (!m) return line;
  const { comment } = splitTomlComment(line);
  const tail = comment ? `  ${comment}` : '';
  return `${m[1]}${m[2]} = ${JSON.stringify(String(value))}${tail}`;
}

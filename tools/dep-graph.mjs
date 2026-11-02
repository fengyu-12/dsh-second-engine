#!/usr/bin/env node
// dep-graph.mjs — 函数依赖图（AST 版，2026-11-02 重写）
// 为什么重写：Codex 那版用「正则 + maskNonCode + 行号推算」，实测 startLine/endLine 统一偏 +1，
// 且函数体内 JSON 字符串里的 {}/ 会干扰括号配平（extractFirstJsonObject 被算成 1 行）。
// 本版用 acorn 真解析：行号取自 node.loc，引用取自 AST 遍历，不猜。
// ⚠️ 行号会随改动过期：按旧图行号删函数，行号偏移会把函数体切半（2026-11-03 实测误删过
//    canonicalIssueText）。**删前校验该行行首是否仍是要删的函数名**，不符就重新生成依赖图。
// 用法: node tools/dep-graph.mjs [输入文件] [输出目录]
// 输出: dep-graph.json / dep-graph.md（与旧版同形状，字段名不变）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2] || path.join(here, '..', 'src', 'index.js')
const outDir = process.argv[3] || here

function walk(node, fn) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
  if (typeof node.type === 'string') fn(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
    walk(node[key], fn)
  }
}

function analyze(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const fnNames = new Set()
  const fnNodes = []
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
      fnNames.add(node.id.name)
      fnNodes.push(node)
    }
  }
  // 模块级 let/var（只取顶层声明）
  const moduleVars = new Set()
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue
    if (node.kind !== 'let' && node.kind !== 'var') continue
    for (const d of node.declarations) if (d.id.type === 'Identifier') moduleVars.add(d.id.name)
  }
  const funcs = []
  for (const node of fnNodes) {
    const name = node.id.name
    const usedVars = new Set()
    const calls = new Set()
    walk(node.body, (n) => {
      if (n.type === 'Identifier' && moduleVars.has(n.name)) usedVars.add(n.name)
      if (n.type === 'CallExpression') {
        const c = n.callee
        if (c.type === 'Identifier' && fnNames.has(c.name) && c.name !== name) calls.add(c.name)
      }
    })
    funcs.push({
      name,
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
      lines: node.loc.end.line - node.loc.start.line + 1,
      moduleLets: [...usedVars].sort(),
      calls: [...calls].sort(),
      calledBy: [],
    })
  }
  const byName = new Map(funcs.map((f) => [f.name, f]))
  for (const f of funcs) for (const c of f.calls) { const t = byName.get(c); if (t) t.calledBy.push(f.name) }
  for (const f of funcs) f.calledBy.sort()
  return funcs
}

function selfTest() {
  const sample = 'let state;\nfunction a() { b(); }\nfunction b() { state++; }\nfunction c() { state = 1; }\n'
  const got = analyze(sample)
  const a = got.find((f) => f.name === 'a'), b = got.find((f) => f.name === 'b')
  if (got.length !== 3) throw new Error(`selfTest 函数数 ${got.length} != 3`)
  if (!a.calls.includes('b')) throw new Error('selfTest a 未识别 b 调用')
  if (!b.calledBy.includes('a')) throw new Error('selfTest b 反向边缺失')
  if (!b.moduleLets.includes('state')) throw new Error('selfTest b 未识别 state 引用')
  if (a.startLine !== 2 || a.endLine !== 2) throw new Error('selfTest 行号错位')
  return got
}

function emit(funcs) {
  fs.mkdirSync(outDir, { recursive: true })
  const json = funcs.map(({ name, startLine, endLine, lines, moduleLets, calls, calledBy }) =>
    ({ name, startLine, endLine, lines, moduleLets, calls, calledBy }))
  fs.writeFileSync(path.join(outDir, 'dep-graph.json'), JSON.stringify(json, null, 2) + '\n')
  let md = '# 函数依赖图（AST 版）\n\n| 函数名 | 起止行 | 行数 | 引用的模块级 let | 调用的其他顶层函数 | 被哪些函数调用 |\n|---|---:|---:|---|---|---|\n'
  for (const f of json) md += `| ${f.name} | ${f.startLine}-${f.endLine} | ${f.lines} | ${f.moduleLets.join(', ') || '-'} | ${f.calls.join(', ') || '-'} | ${f.calledBy.join(', ') || '-'} |\n`
  fs.writeFileSync(path.join(outDir, 'dep-graph.md'), md)
  return json
}

const st = selfTest()
const json = emit(analyze(fs.readFileSync(input, 'utf8')))
console.log(JSON.stringify({ ok: true, selfTest: st.map((f) => f.name), functionCount: json.length, totalLines: json.reduce((s, f) => s + f.lines, 0) }, null, 2))

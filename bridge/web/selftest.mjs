#!/usr/bin/env node
// 第二引擎 · 桥的自检
//
// 为什么要有它：本桥依赖 codex 的 app-server 协议（官方标着 experimental），
// 升级 codex 之后协议可能变。这脚本只回答一件事：**是哪儿坏了** ——
//   ① codex 没了/换路径  ② 所有者没起  ③ 协议方法变了（升级导致的）  ④ 网页进程的事
//
// 其中 thread/loaded/list 单独拎出来：终端新会话同步（codex-env 默认）靠它 ——
// 那条会话还没落盘，thread/list 里根本没有，只有加载列表能报出来。
//
// 用法：node selftest.mjs  （或 ./ctl.sh check）

import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.BRIDGE_PORT || 3095);
const AS_URL = process.env.BRIDGE_AS_URL || `ws://127.0.0.1:${Number(process.env.BRIDGE_AS_PORT || 3096)}`;
const AS_HTTP = AS_URL.replace(/^ws/, 'http');

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, hint) => { failed++; console.log(`  ✗ ${msg}`); if (hint) console.log(`     → ${hint}`); };

console.log(`# 1. codex 本体`);
try {
  const v = execFileSync(process.env.CODEX_BIN || 'codex', ['--version'], { encoding: 'utf8' }).trim();
  ok(`codex 可用：${v}`);
} catch (err) {
  bad(`codex 跑不起来：${err.message}`, '升级/换路径了？把 codex 放回 PATH，或改 web-bridge 里的 CODEX_BIN');
}

console.log(`# 2. 会话所有者（${AS_URL}）`);
let ready = false;
try {
  const r = await fetch(`${AS_HTTP}/readyz`, { signal: AbortSignal.timeout(3000) });
  ready = r.ok;
  ready ? ok(`/readyz ${r.status}`) : bad(`/readyz ${r.status}`);
} catch (err) {
  bad(`连不上：${err.message}`, '终端里跑 ./ctl.sh start');
}

console.log(`# 3. app-server 协议（升级最容易坏的地方）`);
if (!ready) {
  console.log('  – 所有者没起，跳过');
} else {
  const hints = {
    'thread/loaded/list': '这条坏了 → 终端新开、还没说话的会话不会出现在网页（见 README「终端新会话自动同步」）',
  };
  const methods = [
    ['initialize', { clientInfo: { name: 'selftest', version: '1' } }],
    ['thread/list', { limit: 1 }],
    ['thread/loaded/list', {}],
  ];
  const ws = new WebSocket(AS_URL);
  const call = (id, method, params) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 8000);
    const onMsg = (ev) => {
      let o;
      try { o = JSON.parse(ev.data); } catch { return; }
      if (o.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      resolve(o);
    };
    ws.addEventListener('message', onMsg);
    ws.send(`${JSON.stringify({ id, method, params })}\n`);
  });
  const opened = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  if (!opened) bad('WebSocket 连不上', '所有者还活着吗？（./ctl.sh status）');
  else {
    let firstThread = null;
    for (const [i, [method, params]] of methods.entries()) {
      const r = await call(i + 1, method, params);
      if (r.timeout) bad(`${method} 没有响应`, hints[method] || '协议可能变了：升级 codex 后要重新对一遍方法名/参数');
      else if (r.error) bad(`${method} 报错：${r.error.message}`, hints[method] || '协议可能变了');
      else {
        ok(`${method} 正常`);
        if (method === 'thread/list') firstThread = r.result?.data?.[0]?.id ?? null;
      }
    }
    for (const [i, [method, params]] of [['thread/items/list', { threadId: firstThread, limit: 1 }], ['thread/read', { threadId: firstThread, includeTurns: true }]].entries()) {
      if (!firstThread) break;
      const r = await call(10 + i, method, params);
      if (r.timeout || r.error) bad(`${method} 异常：${r.timeout ? '无响应' : r.error.message}`, '协议可能变了');
      else ok(`${method} 正常`);
    }
  }
  try { ws.close(); } catch {}
}

console.log(`# 4. 网页进程（127.0.0.1:${PORT}）`);
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  j.appServer?.connected ? ok(`/api/health ok，所有者 connected=${j.appServer.connected}`) : bad('/api/health 说所有者没连上');
} catch (err) {
  bad(`连不上：${err.message}`, './ctl.sh start');
}

console.log(failed ? `\n结论：${failed} 项有问题（上面带 → 的就是怎么办）` : '\n结论：全部正常');
process.exit(failed ? 1 : 0);

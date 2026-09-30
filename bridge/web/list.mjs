#!/usr/bin/env node
// 第二引擎 · 列出最近的会话（给终端用：拿到 id 才能 codex-env -a <id>）
//
// 用法：node list.mjs [条数]      或     ./ctl.sh threads [条数]

const AS_URL = process.env.BRIDGE_AS_URL || `ws://127.0.0.1:${Number(process.env.BRIDGE_AS_PORT || 3096)}`;
const LIMIT = Math.min(Math.max(Number(process.argv[2]) || 12, 1), 100);

const pad = (s, n) => String(s ?? '').padEnd(n);
const when = (sec) => {
  if (!sec) return '?';
  const d = new Date(Number(sec) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const source = (t) => (t.originator === 'web-bridge' || t.source === 'appServer' ? '网页' : '终端');

const ws = new WebSocket(AS_URL);
const send = (o) => ws.send(`${JSON.stringify(o)}\n`);
ws.addEventListener('open', () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'bridge-list', version: '1' } } }));
ws.addEventListener('message', (ev) => {
  let o;
  try { o = JSON.parse(ev.data); } catch { return; }
  if (o.id === 1) return send({ id: 2, method: 'thread/list', params: { limit: LIMIT } });
  if (o.id !== 2) return;
  if (o.error) { console.error(`读会话列表失败：${o.error.message}`); process.exit(1); }
  const rows = o.result?.data || [];
  if (!rows.length) { console.log('（还没有会话）'); process.exit(0); }
  console.log(`# 最近 ${rows.length} 条（本地时间）  —— 打开某条：codex-env -a <id>`);
  for (const t of rows) {
    const busy = t.status?.type === 'active' ? '运行中' : '';
    console.log(`${t.id}  ${when(t.updatedAt)}  ${pad(source(t), 4)} ${pad(busy, 6)} ${(t.name || t.preview || '').replace(/\s+/g, ' ').slice(0, 50)}`);
  }
  process.exit(0);
});
ws.addEventListener('error', () => {
  console.error(`连不上会话所有者（${AS_URL}）：先在终端跑 ./ctl.sh start`);
  process.exit(1);
});
setTimeout(() => { console.error('超时：所有者没响应'); process.exit(1); }, 10000);

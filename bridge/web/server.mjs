#!/usr/bin/env node
// 第二引擎 · 浏览器聊天桥（app-server 版）
//
// 为什么改：旧版每回合 spawn 一个 `codex exec resume`，那是「每回合抢一次会话写锁」——
// 网页在跑时终端续不上、终端开着时网页发不出（报 already has an active writer）。
//
// 现在照 DSH 的做法：一个常驻 `codex app-server` 是**唯一的会话所有者**，
// 本进程和终端 TUI 都只是它的客户端：
//   - ctl.sh start 先起 app-server（ws://127.0.0.1:$BRIDGE_AS_PORT），再起本进程
//   - 终端想和网页共享同一批会话：codex --remote ws://127.0.0.1:3096
//   - 本进程只做：HTTP + token + 把 app-server 推送转成前端要的 NDJSON 流
//
// 前端契约（public/index.html，未改动）：
//   GET  /api/threads?limit=80            → {threads:[{id,title,source,updatedAt,busy}]}
//   GET  /api/transcript?id=<thread>      → {entries:[{t:'me'|'ai'|'act'|'note',…}]}
//   GET  /api/stamp?id=<thread>           → {stamp}
//   POST /api/thread/archive | delete     → {ok}
//   POST /api/send   {text,threadId}      → NDJSON: meta|text|activity|note|end|done
//   POST /api/stop                        → {ok}

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, readlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppServerClient } from './as-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'public', 'index.html');

const STATE_DIR = process.env.BRIDGE_STATE_DIR || path.join(os.homedir(), '.dsh', 'second-engine-bridge');
const WORKDIR = process.env.BRIDGE_WORKDIR || path.join(STATE_DIR, 'work');
const PORT = Number(process.env.BRIDGE_PORT || 3095);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const AS_PORT = Number(process.env.BRIDGE_AS_PORT || 3096);
const AS_URL = process.env.BRIDGE_AS_URL || `ws://127.0.0.1:${AS_PORT}`;
const TOKEN_FILE = path.join(STATE_DIR, '.token');
const PID_FILE = path.join(STATE_DIR, '.pid');
const AS_PID_FILE = path.join(STATE_DIR, '.as.pid');   // ctl.sh 写的 app-server pid，用于认"锁是不是自家上游拿着"
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 30 * 60 * 1000);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

// codex 自己注入的上下文（AGENTS.md、环境信息、技能清单）不是用户真说过的话，转录里滤掉
const INJECTED_PREFIXES = [
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<user_instructions>',
  '<skills_instructions>',
];

async function loadToken() {
  try {
    const existing = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // 首次启动，下面生成
  }
  const fresh = randomBytes(24).toString('base64url');
  await writeFile(TOKEN_FILE, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

await mkdir(STATE_DIR, { recursive: true });
await mkdir(WORKDIR, { recursive: true });
const TOKEN = await loadToken();

// 哪些会话是**桥自己**开的（网页新会话）。owner 上创建的会话 originator 一律写 "web-bridge"，
// 分不出是网页开的还是终端 codex --remote 开的，所以自己留一份账。
const OWN_FILE = path.join(STATE_DIR, '.bridge-owns.json');
const owned = new Map(); // threadId -> iso
try {
  for (const [k, v] of Object.entries(JSON.parse(await readFile(OWN_FILE, 'utf8')))) owned.set(k, v);
} catch {
  // 首次运行，没有这份账
}
let ownSaveTimer = null;
function ownThread(id) {
  if (!id || owned.has(id)) return;
  owned.set(id, new Date().toISOString());
  clearTimeout(ownSaveTimer);
  ownSaveTimer = setTimeout(() => {
    const cutoff = Date.now() - 7 * 86400000; // 只留最近一周，别无限长
    const obj = {};
    for (const [k, v] of owned) if (new Date(v).getTime() > cutoff) obj[k] = v;
    writeFile(OWN_FILE, JSON.stringify(obj), { mode: 0o600 }).catch(() => {});
  }, 500);
}

function authed(req, url) {
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string' && header === TOKEN) return true;
  const query = url.searchParams.get('t');
  return typeof query === 'string' && query === TOKEN;
}

// ── app-server ──────────────────────────────────────────────────────────────

const log = (...args) => console.log(new Date().toISOString(), ...args);
const as = new AppServerClient(AS_URL, { clientInfo: { name: 'web-bridge', version: '2.0' }, log });

const active = new Map(); // threadId -> {res, turnId, started, usage, ok, finished, timer, pendingCancel}

function oneLine(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toIso(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
}

// codex 的 ThreadItem → 网页的 entry
function itemToEntry(item) {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content || [])
        .map((c) => (typeof c === 'string' ? c : c?.text || ''))
        .join('\n')
        .trim();
      if (!text || INJECTED_PREFIXES.some((p) => text.startsWith(p))) return null;
      return { t: 'me', text };
    }
    case 'agentMessage':
      return item.text ? { t: 'ai', text: item.text } : null;
    case 'commandExecution':
      return { t: 'act', name: '命令', detail: oneLine(item.command, 160) };
    case 'fileChange': {
      const paths = (item.changes || []).map((c) => c?.path).filter(Boolean).join(', ');
      return { t: 'act', name: '改文件', detail: oneLine(paths, 160) };
    }
    case 'mcpToolCall':
      return { t: 'act', name: `MCP ${item.server || ''}/${item.tool || ''}`, detail: oneLine(item.arguments && JSON.stringify(item.arguments), 120) };
    case 'dynamicToolCall':
      return { t: 'act', name: `工具 ${item.tool || ''}`, detail: '' };
    case 'webSearch':
      return { t: 'act', name: '搜索', detail: oneLine(item.query, 120) };
    case 'plan':
      return { t: 'act', name: '计划', detail: oneLine(item.text, 160) };
    case 'imageView':
      return { t: 'act', name: '看图', detail: oneLine(item.path, 120) };
    case 'imageGeneration':
      return { t: 'act', name: '生成图片', detail: oneLine(item.savedPath || item.revisedPrompt, 120) };
    case 'subAgentActivity':
    case 'collabAgentToolCall':
      return { t: 'act', name: '子代理', detail: oneLine(item.kind || item.tool, 80) };
    case 'contextCompaction':
      return { t: 'note', text: '上下文已压缩', level: '' };
    case 'reasoning':
    case 'functionCallOutput':
    case 'hookPrompt':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return null;
    default:
      return { t: 'act', name: String(item.type || 'item'), detail: '' };
  }
}

function errorText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || err.additionalDetails || err.type || JSON.stringify(err).slice(0, 300);
}

function threadTitle(t) {
  const raw = t.name || t.preview || '';
  const title = oneLine(raw, 80);
  return title || '（无标题）';
}

function isBusyThread(thread) {
  return thread?.status?.type === 'active';
}

// owner 内存里当前加载着哪些会话（纯 id 数组）。刚在终端 codex --remote 里开出来、
// 还没说过话的会话就只存在于这里 —— 它没有 rollout 文件，thread/list 看不见，
// 但它确实活着（能读、能直接发第一条）。这是"终端新会话同步到网页"的关键。
async function loadedThreadIds() {
  try {
    const r = await as.call('thread/loaded/list', {}, 10000);
    return new Set((r.data || []).filter((x) => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

// app-server 的 Thread → 网页列表项（thread/list 与 thread/read 两种来源共用）
function threadRow(t, { pending = false } = {}) {
  return {
    id: t.id,
    title: threadTitle(t),
    // owner 对在它上面建的会话一律报 originator=web-bridge，分不出是谁开的，
    // 所以"网页开的"以本桥自己的账本为准（见 owned）。
    source: owned.has(t.id) ? 'bridge' : 'term',
    updatedAt: toIso(t.updatedAt ?? t.recencyAt ?? t.createdAt),
    busy: isBusyThread(t),
    cwd: t.cwd || '',
    pending,
  };
}

// 网页崩过之后可能留下"断了线、也没人收尾"的条目。真去问一次所有者：
// 那条会话其实不忙，就说明是个残留，丢掉它 —— 否则 409 会把这条会话永久锁死。
async function threadReallyBusy(threadId) {
  try {
    const r = await as.call('thread/read', { threadId }, 15000);
    return isBusyThread(r.thread);
  } catch {
    return false;
  }
}

// ── 会话写锁持有者探测 ──────────────────────────────────────────────────────
// 旧行为：409 只说"正被另一个终端占用，先退出那个终端"——用户不知道是哪个终端，
// 而且这句话经常是**错的**：本桥的 app-server 才是会话写锁的持有者，
// 它手里 active 的会话压根没有"另一个终端"。所以 409 时把真正的持有者查出来。
//
// 查法：扫 /proc/<pid>/fd 找指向 thread-writer-locks/<id>.lock 的进程。
// 禁止 pgrep -f / pkill -f —— 匹配串会命中自己的命令行，等于自杀（铁律 12）。
async function scanLockHolders(threadId) {
  const want = `${threadId}.lock`;
  const hits = [];
  let pids;
  try {
    pids = await readdir('/proc');
  } catch {
    return hits;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;                       // 不是我们的进程 / 没权限 / 已经退了：跳过
    }
    for (const fd of fds) {
      let target;
      try {
        target = await readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (path.basename(target) !== want) continue;
      if (!target.includes('thread-writer-locks')) continue;
      hits.push({ pid: Number(pid), lockPath: target });
      break;                          // 一个进程只记一次
    }
  }
  return hits;
}

async function appServerPid() {
  try {
    const fromFile = (await readFile(AS_PID_FILE, 'utf8')).trim();
    if (/^\d+$/.test(fromFile)) {
      try {
        await readFile(`/proc/${fromFile}/comm`);
        return Number(fromFile);
      } catch {
        // pid 文件过期，下面按命令行兜底
      }
    }
  } catch {
    // 没这个文件：老部署直接兜底
  }
  try {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (cmdline.includes('app-server') && cmdline.includes(AS_URL)) return Number(pid);
    }
  } catch {
    // ignore
  }
  return null;
}

// 返回 { held, holders:[{pid,comm,cmdline,isUpstream,lockPath}], selfOnly, hint }
async function lockHolder(threadId) {
  if (!/^[0-9a-f-]{8,}$/i.test(String(threadId || ''))) return { held: false };
  const hits = await scanLockHolders(threadId);
  if (!hits.length) return { held: false };
  const asPid = await appServerPid();
  const holders = [];
  for (const h of hits) {
    const raw = await readFile(`/proc/${h.pid}/cmdline`, 'utf8').catch(() => '');
    const comm = (await readFile(`/proc/${h.pid}/comm`, 'utf8').catch(() => '')).trim();
    holders.push({
      pid: h.pid,
      comm,
      cmdline: raw.replace(/\0/g, ' ').trim().slice(0, 400),
      lockPath: h.lockPath,
      isUpstream: asPid !== null && h.pid === asPid,
    });
  }
  const selfOnly = holders.every((h) => h.isUpstream);
  let hint;
  if (selfOnly) {
    const h = holders[0];
    hint = `写锁在本桥的 app-server（pid ${h.pid}）手里，不是别的终端占着：`
      + '说明 app-server 里这条会话还是 active —— 要么终端那边 codex --remote 正跑着这一轮，'
      + '要么是上游没释放的残留（刷新列表、或稍等一下再试）。';
  } else {
    const h = holders.find((x) => !x.isUpstream);
    hint = `写锁被 pid ${h.pid} 占着：${h.cmdline || h.comm || '（读不到命令行）'}`;
  }
  return { held: true, holders, selfOnly, hint };
}

// app-server 的通知 → 正在等待的 HTTP 流
as.on('notification', (msg) => {
  const p = msg.params || {};
  const a = p.threadId ? active.get(p.threadId) : null;
  switch (msg.method) {
    case 'item/agentMessage/delta':
      if (a) a.send({ kind: 'text', text: p.delta || '' });
      break;
    case 'item/started': {
      if (!a) break;
      const entry = itemToEntry(p.item);
      if (entry && entry.t === 'act') a.send({ kind: 'activity', name: entry.name, detail: entry.detail });
      break;
    }
    case 'thread/tokenUsage/updated':
      if (a) a.usage = p.tokenUsage?.last || null;
      break;
    case 'error':
      if (a) {
        a.ok = false;
        if (!p.willRetry) a.send({ kind: 'note', level: 'error', text: errorText(p.error) });
      }
      break;
    case 'turn/started':
      if (a && !a.turnId) {
        a.turnId = p.turn?.id || null;
        tryPendingCancel(a).catch((err) => log(`补发中断失败：${err.message}`));
      }
      break;
    case 'turn/completed': {
      if (!a) break;
      const turn = p.turn || {};
      if (turn.error) {
        a.ok = false;
        a.send({ kind: 'note', level: 'error', text: errorText(turn.error) });
      }
      a.send({ kind: 'end', usage: a.usage ? { output_tokens: a.usage.outputTokens } : null });
      a.send({ kind: 'done', ok: a.ok && turn.status !== 'failed', ms: Date.now() - a.started });
      finish(a);
      break;
    }
    default:
      break;
  }
});

as.on('serverRequest', (msg) => log(`婉拒服务端请求 ${msg.method}`));
as.on('ready', () => log(`app-server 就绪 ${AS_URL}`));

function finish(a) {
  if (a.finished) return;
  a.finished = true;
  clearTimeout(a.timer);
  active.delete(a.threadId);
  try {
    a.res.end();
  } catch {
    // 客户端可能已经走了
  }
}

async function interrupt(threadId, turnId) {
  if (!turnId) return false;
  try {
    await as.call('turn/interrupt', { threadId, turnId }, 15000);
    return true;
  } catch (err) {
    log(`中断失败：${err.message}`);
    return false;
  }
}

// turnId 是异步就绪的（turn/start 返回、或 turn/started 通知）。
// 用户在就绪前点「中断」时，interrupt() 会因 turnId 为空静默返回 false —— 那次点击就被丢掉了。
// 这里在 turnId 一到位时补发一次。消费后清 pendingCancel，防止两条路径重复触发。
async function tryPendingCancel(entry) {
  if (!entry || !entry.pendingCancel || !entry.turnId) return;
  entry.pendingCancel = false;
  log(`补发中断（turnId 刚就绪）：${entry.threadId.slice(0, 8)}/${String(entry.turnId).slice(0, 8)}`);
  await interrupt(entry.threadId, entry.turnId);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function requireReady(res) {
  if (as.ready) return true;
  json(res, 503, { error: `app-server 未连接（${AS_URL}）。终端里跑 ./ctl.sh start 或 ./ctl.sh restart` });
  return false;
}

async function handleSend(req, res, payload) {
  let threadId = typeof payload.threadId === 'string' && payload.threadId ? payload.threadId : null;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return json(res, 400, { error: '内容为空' });
  if (threadId && active.has(threadId)) {
    const cur = active.get(threadId);
    if (cur.detached && !(await threadReallyBusy(threadId))) {
      log(`清掉残留条目（${threadId.slice(0, 8)}，挂起 ${Math.round((Date.now() - cur.started) / 1000)}s）`);
      finish(cur);
    } else {
      return json(res, 409, { error: '这一轮还在跑，先等它结束或点「中断」' });
    }
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
  };

  try {
    if (threadId) {
      // 必须先 resume：**resume 才是订阅**。不 resume 就收不到 item/agentMessage/delta 和
      // turn/completed（实测 2026-09-23：跳过 resume 直接 turn/start，回合跑完了桥一个通知都没收到，
      // 网页会一直挂"运行中"）。代价是"还没落盘的会话"resume 会失败（no rollout found）——
      // 那种会话只能先在终端说第一句，落盘后才接管得了。
      await as.call('thread/resume', { threadId }, 120000);
    } else {
      const started = await as.call('thread/start', {
        cwd: WORKDIR,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      });
      threadId = started.thread?.id;
      if (!threadId) throw new Error('thread/start 没返回会话 id');
      ownThread(threadId);
      send({ kind: 'meta', threadId });
    }
  } catch (err) {
    const detail = err.message || String(err);
    const msg = /active writer/i.test(detail)
      ? '这条会话被另一个进程占着（多半是没走 --remote 的终端 TUI）。去那个终端里说，或先退出它再来。'
      : /no rollout found|no saved session|not loaded/i.test(detail)
        ? '这条会话还没有落盘（还没说过第一句话），网页接管不了 —— 去终端里说一句，它就活了，之后两边都能发。'
        : `开不了会话：${detail}`;
    send({ kind: 'note', level: 'error', text: msg });
    send({ kind: 'done', ok: false, ms: 0 });
    return res.end();
  }

  const entry = { threadId, res, send, started: Date.now(), turnId: null, usage: null, ok: true, finished: false, pendingCancel: false };
  active.set(threadId, entry);

  try {
    const started = await as.call('turn/start', { threadId, input: [{ type: 'text', text }] }, 120000);
    entry.turnId = started.turn?.id || entry.turnId;
    tryPendingCancel(entry).catch((err) => log(`补发中断失败：${err.message}`));
  } catch (err) {
    send({ kind: 'note', level: 'error', text: `发不出去：${err.message || err}` });
    send({ kind: 'done', ok: false, ms: Date.now() - entry.started });
    return finish(entry);
  }

  entry.timer = setTimeout(() => {
    send({ kind: 'note', level: 'error', text: `超时 ${Math.round(TURN_TIMEOUT_MS / 1000)}s，已中断` });
    entry.ok = false;
    interrupt(threadId, entry.turnId).finally(() => finish(entry));
  }, TURN_TIMEOUT_MS);

  // 网页断开（切后台/锁屏/刷新）**不中断**：这一轮继续跑，结果照样写进会话，
  // 重新打开页面就能看到（前端每 5 秒对一次 stamp）。要停请点「中断」或 POST /api/stop。
  res.on('close', () => {
    if (entry.finished || entry.detached) return;
    entry.detached = true;
    log(`网页断开，回合继续跑（${threadId.slice(0, 8)}）；结果会写进会话，重开页面即可看到`);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    return json(res, 403, { error: `Host 不在白名单：${req.headers.host}` });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      appServer: { url: AS_URL, connected: as.ready },
      busy: active.size > 0,
      active: [...active].map(([id, e]) => ({
        id: id.slice(0, 8),
        detached: !!e.detached,
        ageS: Math.round((Date.now() - e.started) / 1000),
        turn: e.turnId ? e.turnId.slice(0, 8) : null,
      })),
      workdir: WORKDIR,
      port: PORT,
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const page = await readFile(PAGE, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authed(req, url)) return json(res, 401, { error: 'token 无效，请用启动时打印的完整网址打开' });
    if (!requireReady(res)) return;

    // 会话列表直接问 app-server（真源），所以终端那边的对话也能在这里切
    if (req.method === 'GET' && url.pathname === '/api/threads') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 80, 1), 200);
      try {
        const r = await as.call('thread/list', { limit, archived: false });
        const threads = (r.data || []).map((t) => threadRow(t));

        // 补上 owner 内存里、还没写进会话文件的新会话（终端刚 codex --remote 开出来、
        // 还没说第一句的那种）。它们在 thread/list 里不存在，但能被加载列表报出来。
        const seen = new Set(threads.map((t) => t.id));
        const loaded = await loadedThreadIds();
        for (const id of loaded) {
          if (seen.has(id)) continue;
          let t = null;
          try {
            t = (await as.call('thread/read', { threadId: id }, 15000)).thread;
          } catch {
            continue; // 读不到就算了，别让列表整体失败
          }
          const row = threadRow(t, { pending: true });
          if (row.title === '（无标题）') row.title = '（新会话 · 还没开始）';
          threads.push(row);
        }
        threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return json(res, 200, { threads });
      } catch (err) {
        return json(res, 500, { error: `读会话列表失败：${err.message}` });
      }
    }

    // 某条会话的转录（分页拿全，最多 2000 条）
    if (req.method === 'GET' && url.pathname === '/api/transcript') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json(res, 400, { error: '缺少 id' });
      try {
        const entries = [];
        let cursor = null;
        for (let page = 0; page < 20; page++) {
          const r = await as.call('thread/items/list', { threadId: id, limit: 500, cursor, sortDirection: 'asc' });
          // 列表里的元素是 {turnId, item}，通知里是直接的 item —— 两种都吃
          for (const row of r.data || []) {
            const entry = itemToEntry(row?.item ?? row);
            if (entry) entries.push(entry);
          }
          cursor = r.nextCursor || null;
          if (!cursor) break;
        }
        return json(res, 200, { entries });
      } catch (err) {
        // 还没落盘的新会话读不到条目 —— 那不是错误，是"还空着"。确认会话存在就给个空转录。
        try {
          await as.call('thread/read', { threadId: id }, 10000);
          return json(res, 200, { entries: [], pending: true });
        } catch {
          return json(res, 404, { error: `读转录失败：${err.message}` });
        }
      }
    }

    // 变化探测：app-server 的 updatedAt + 回合数，够前端判断"终端那边是不是又说了话"
    if (req.method === 'GET' && url.pathname === '/api/stamp') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json(res, 400, { error: '缺少 id' });
      try {
        let r;
        try {
          r = await as.call('thread/read', { threadId: id, includeTurns: true });
        } catch {
          // 还没落盘的会话（终端刚开、没说话）可能不支持带 turns 读，退一步只读 metadata
          r = await as.call('thread/read', { threadId: id }, 10000);
        }
        const t = r.thread || {};
        return json(res, 200, { stamp: `${t.updatedAt ?? 0}-${(t.turns || []).length}` });
      } catch (err) {
        return json(res, 404, { error: `找不到这条会话：${err.message}` });
      }
    }

    // 归档 / 删除：走协议，不再 spawn codex 命令
    if (req.method === 'POST' && (url.pathname === '/api/thread/archive' || url.pathname === '/api/thread/delete')) {
      const wantDelete = url.pathname.endsWith('/delete');
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return json(res, 400, { error: `请求体不是 JSON：${err.message}` });
      }
      const id = typeof payload.id === 'string' ? payload.id : '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: '会话 id 不合法' });
      if (active.has(id)) return json(res, 409, { error: '这条会话正在网页里跑，先中断再来。' });
      try {
        const read = await as.call('thread/read', { threadId: id });
        if (isBusyThread(read.thread)) {
          // 别再说"另一个终端"了：先把真正的写锁持有者查出来再下结论
          const lk = await lockHolder(id);
          const error = lk.selfOnly
            ? '这条会话在 app-server 里还是 active（不是别的终端占着），先等它结束或稍后重试。'
            : '这条会话正被别的进程占着写锁，见下面那行。';
          log(`409 归档/删除 ${id.slice(0, 8)} → ${lk.hint || '没查到锁持有者'}`);
          return json(res, 409, { error, holder: lk });
        }
      } catch {
        // 读不到就当不忙，让 archive/delete 自己报错
      }
      try {
        await as.call(wantDelete ? 'thread/delete' : 'thread/archive', { threadId: id }, 60000);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 500, { error: `${wantDelete ? '删除' : '归档'}失败：${err.message}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return json(res, 400, { error: `请求体不是 JSON：${err.message}` });
      }
      return handleSend(req, res, payload);
    }

    // 谁占着这条会话？前端在"占用中"被拦住时按需来问（扫 /proc 有成本，不进列表接口）
    if (req.method === 'GET' && url.pathname === '/api/lock-info') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json(res, 400, { error: '缺少 id' });
      try {
        return json(res, 200, await lockHolder(id));
      } catch (err) {
        return json(res, 500, { error: `查写锁失败：${err.message}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      let want = '';
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        want = typeof b.threadId === 'string' ? b.threadId : '';
      } catch { /* 空 body 合法：退回"唯一的活跃会话" */ }
      let target = want;
      if (!target) {
        const ids = [...active.keys()];
        if (ids.length === 0) return json(res, 200, { ok: true, state: 'none', stopped: false });
        if (ids.length > 1) {
          return json(res, 409, { ok: false, state: 'ambiguous',
            error: `同时有 ${ids.length} 个活跃回合，无法确定停哪个；请带 {"threadId":"…"}` });
        }
        target = ids[0];
      }
      const entry = active.get(target);
      if (!entry) return json(res, 200, { ok: true, state: 'none', stopped: false });
      if (!entry.turnId) {
        entry.pendingCancel = true;
        log(`登记待取消（turnId 尚未就绪）：${target.slice(0, 8)}`);
        return json(res, 200, { ok: true, state: 'pending', stopped: false });
      }
      const stopped = await interrupt(target, entry.turnId);
      return json(res, 200, { ok: true, state: stopped ? 'stopped' : 'failed', stopped });
    }

    return json(res, 404, { error: `没有这个接口：${url.pathname}` });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  // 控制脚本靠这个文件找到我，别用 pgrep -f 猜（会被别的 shell 文本匹配到）
  writeFile(PID_FILE, `${process.pid}\n`).catch(() => {});
  console.log(`第二引擎 · 浏览器聊天桥（app-server 版）`);
  console.log(`  会话所有者 ${AS_URL}（已连接：${as.ready}）`);
  console.log(`  工作目录 ${WORKDIR}`);
  console.log(`  终端想共享同一批会话：codex --remote ${AS_URL}`);
  console.log(`  （不想记网址就运行 ./ctl.sh url）`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    as.stop();
    process.exit(0);
  });
}

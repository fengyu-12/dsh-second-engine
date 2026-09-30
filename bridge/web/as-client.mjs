// 第二引擎 · app-server 客户端
//
// `codex app-server --listen ws://127.0.0.1:PORT` 说的事：一个 WebSocket，
// 每行一个 JSON（JSONL），有 id 的是请求、没 id 的是通知。
// 这个类把它包成：call() 拿响应、on('notification') 收推送、断了自动重连。
//
// 「唯一所有者」就靠它实现：会话由 app-server 进程独占，网页和终端都只是客户端。

import { EventEmitter } from 'node:events';

export class AppServerClient extends EventEmitter {
  constructor(url, { clientInfo = { name: 'web-bridge', version: '2.0' }, log = () => {} } = {}) {
    super();
    this.url = url;
    this.clientInfo = clientInfo;
    this.log = log;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this.attempts = 0;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.log(`WebSocket 构造失败：${err.message}`);
      return this.retry();
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.call('initialize', { clientInfo: this.clientInfo })
        .then((r) => {
          this.ready = true;
          this.log(`app-server 已连接：${r.userAgent || ''}`);
          this.emit('ready', r);
        })
        .catch((err) => this.log(`initialize 失败：${err.message}`));
    });

    ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8');
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          this.log(`丢弃无法解析的帧：${s.slice(0, 120)}`);
          continue;
        }
        this.dispatch(msg);
      }
    });

    ws.addEventListener('close', () => {
      const wasReady = this.ready;
      this.ready = false;
      if (wasReady) this.log('app-server 连接断开');
      this.emit('down');
      this.retry();
    });

    ws.addEventListener('error', () => {
      // close 事件随后也会来，这里不重复重连
    });
  }

  retry() {
    if (this.closed || this.reconnectTimer) return;
    const wait = Math.min(1000 * 2 ** this.attempts++, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    if (this.attempts <= 2) this.log(`app-server 未就绪，${wait}ms 后重连`);
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // 服务端反向请求（审批、提问）。本桥一律婉拒，别让整轮挂住。
      this.emit('serverRequest', msg);
      this.reply(msg.id, { code: -32601, message: `web-bridge 不支持 ${msg.method}` });
      return;
    }
    this.emit('notification', msg);
  }

  reply(id, error) {
    this.raw(JSON.stringify({ id, error }));
  }

  raw(line) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(`${line}\n`);
  }

  call(method, params = {}, timeoutMs = 120000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('app-server 未连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.raw(JSON.stringify({ id, method, params }));
    });
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      // 关不上就算了，进程退出时内核会收
    }
  }
}


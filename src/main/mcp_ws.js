// main/mcp_ws.js — Persistent WebSocket JSON-RPC client used by the MCP server.
// One WebSocket is opened lazily and reused for every RPC; requests carry
// incrementing ids routed through an id -> resolver map, so concurrent calls
// on the same connection resolve to the correct response. Server-side event
// notifications (broadcast with no jsonrpc id) are dropped: the MCP surface is
// request/response only (server→client notifications are dropped here, which is
// why live-push tools are not exposed over MCP — see below)
// (enables CDP monitors + network-body cache; does not stream live events).
//
// #5: robust auto-reconnect — when the connection drops (Electron relaunch /
// NetworkService wedge), `getWs` retries with exponential backoff until the
// server is reachable again (reconnectTimeout budget) instead of failing the
// first call after a drop. Calls wait on the connection first, so the RPC
// per-call `timeout` only starts after the socket is OPEN (a relaunch window is
// absorbed by backoff, not counted as a hung call).
//
// MW-4 race: a stale socket's deferred close/error events must never clobber the
// refs of a freshly re-opened connection. Two guards: (a) a socket isn't
// adopted as `_ws` until its 'open' fires, and (b) close/error handlers mutate
// state only via detachIfCurrent(ws), which no-ops if `_ws` already points at a
// different (newer) socket.
import WebSocket from 'ws';

export function createWsClient({
  url,
  timeout = 15000,
  reconnectTimeout = 120000, // total budget to keep retrying after a drop
  retryBase = 500,           // initial backoff; doubles per attempt, capped
  maxRetryDelay = 10000,
  ensureRunning = null,      // Lazy launch hook: async; called on connection
                             // failure so the server can spawn Electron on demand.
  hello = null,              // 连接建立后立刻发的自报家门（ui.hello 通知）。
                             // 为什么必须发：服务端只看得到一个 socket，分不清
                             // 对面是"一个 agent"还是"一段脚本"。而"要不要给你
                             // 自己的工作区/标签组"必须区分这两者 —— 脚本期望
                             // 老行为（不传 tab 就打当前页），agent 期望隔离。
} = {}) {
  let _ws = null;        // current OPEN socket (or null)
  let _connecting = null; // in-flight getWs() promise (dedupes concurrent callers)
  let _rpcId = 0;
  const _pending = new Map();

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function flushPending(err) {
    for (const [, cb] of _pending) cb({ error: { message: err.message } });
    _pending.clear();
  }

  // Clear out our ref to `ws` ONLY if it is still the current socket. Prevents a
  // stale handler from nulling a newer connection (MW-4).
  function detachIfCurrent(ws) {
    if (_ws === ws) _ws = null;
  }

  // Persistent handlers for an OPEN socket: route messages, drop the socket on
  // error/close (guarded) and reject any in-flight calls so they fail fast while
  // the NEXT call reconnects.
  function attachPersistent(ws) {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const cb = msg.id !== undefined ? _pending.get(msg.id) : undefined;
      if (cb) { _pending.delete(msg.id); cb(msg); }
      // Notifications (no id) are dropped — see the createWsClient comment.
    });
    ws.on('error', (e) => {
      detachIfCurrent(ws);
      flushPending(new Error('WebSocket error: ' + e.message));
    });
    ws.on('close', () => {
      detachIfCurrent(ws);
      flushPending(new Error('WebSocket closed'));
    });
  }

  function getWs() {
    if (_ws && _ws.readyState === WebSocket.OPEN) return Promise.resolve(_ws);
    if (_connecting) return _connecting;

    _connecting = (async () => {
      const deadline = Date.now() + reconnectTimeout;
      let attempt = 0;
      let launchErr = null;   // ensureRunning 的失败原因，超时那一刻报给调用方
      while (true) {
        // A concurrent open socket appearing (e.g. rude open racing the loop) wins.
        if (_ws && _ws.readyState === WebSocket.OPEN) return _ws;

        const ws = new WebSocket(url);
        // Connect-phase: handlers only settle the local await; the socket is not
        // yet adopted as _ws, so a failed attempt cannot corrupt live state.
        let open = false;
        let connectionErr = null;
        await new Promise((res) => {
          const settle = () => res();
          const to = setTimeout(settle, 5000);
          ws.once('open', () => { open = true; clearTimeout(to); settle(); });
          ws.once('error', (e) => { connectionErr = e; clearTimeout(to); settle(); });
          ws.once('close', () => { clearTimeout(to); settle(); });
        });

        if (open) {
          _ws = ws;
          attachPersistent(ws);
          // 自报家门必须在**第一条 RPC 之前**发出去：TCP/WS 保序，服务端会先
          // 处理它，于是第一条业务调用就已经带着身份（能拿到自己的标签组）。
          if (hello) {
            try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ui.hello', params: hello })); }
            catch (_e) { /* 发不出去就退化成匿名连接，不影响调用 */ }
          }
          return ws;
        }

        // Attempt failed — release this socket's connect-phase listeners fully so
        // its later error/close can't touch live state (MW-4).
        // ⚠️ close() 一个还在 CONNECTING 的 socket 会异步再发一次 'error'
        // （"WebSocket was closed before the connection was established"）。
        // removeAllListeners 把 connect-phase 的 once('error') 也摘了，这个迟到
        // 的 error 就没有监听器 → EventEmitter 直接 throw → 整个 MCP server 进程
        // 崩掉，lazy launch 重试循环根本走不到（表现为"首次调用必崩"）。
        // 挂一个 no-op error 兜底：迟到事件只被吞掉，不影响 MW-4 的状态隔离。
        try { ws.removeAllListeners(); ws.on('error', () => {}); ws.close(); } catch (_e) {}
        const err = connectionErr || new Error('connection refused');
        // eslint-disable-next-line no-console
        if (attempt > 0 && attempt % 4 === 0) console.error('[mcp] ws reconnect attempt', attempt, '-', err.message);

        // Lazy launch: the first failure triggers the injected runner (spawns
        // Electron on demand). ensureElectronRunning is idempotent — no-op when
        // the port is already listening — so calling it on every retry is safe and
        // also re-launches after a manual kill of Electron.
        //
        // ⚠️ 它的失败**不能吞**。此前这里是 `catch (_e) {}`，于是"浏览器根本没起来"
        // 和"浏览器起来但 WS 还没好"表现完全一样：agent 先重试 120 秒，最后只拿到
        // "WS reconnect timeout: connection refused"，没有任何线索。现在把原因累积
        // 起来，超时那一刻一并报出。
        if (typeof ensureRunning === 'function') {
          try { await ensureRunning(); launchErr = null; }
          catch (e) { launchErr = e; }
        }

        if (Date.now() >= deadline) {
          const suffix = launchErr
            ? `; browser launch failed: ${launchErr.message}`
            : '';
          throw new Error('WS reconnect timeout: ' + err.message + suffix);
        }
        await wait(Math.min(retryBase * 2 ** attempt++, maxRetryDelay));
      }
    })().finally(() => { _connecting = null; });

    return _connecting;
  }

  // JSON-RPC call; resolves to the result, rejects on {error} / timeout /
  // connection failure. Uses the shared connection via getWs().
  function call(method, params = {}) {
    return getWs().then((conn) => new Promise((resolve, reject) => {
      const id = ++_rpcId;
      const timer = setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error('WS timeout')); }
      }, timeout);
      _pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || 'RPC error'));
        else resolve(msg.result);
      });
      try {
        conn.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        _pending.delete(id);
        reject(e);
      }
    }));
  }

  // Force-sever the underlying connection. The NEXT call reconnects (MW-4).
  // Detaches the socket's own handlers first so their deferred close/error
  // events can't clobber the refs of a freshly re-opened connection created
  // right after this returns (rapid reconnect race). In-flight calls are
  // rejected.
  function close() {
    const ws = _ws;
    _ws = null;
    _connecting = null;
    if (ws) {
      ws.removeAllListeners('close');
      ws.removeAllListeners('error');
      try { ws.close(); } catch (_e) {}
    }
    flushPending(new Error('client closed'));
  }

  return { call, close };
}
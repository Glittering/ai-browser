// main/mcp_ws.js — Persistent WebSocket JSON-RPC client used by the MCP server.
// One WebSocket is opened lazily and reused for every RPC; requests carry
// incrementing ids routed through an id -> resolver map, so concurrent calls
// on the same connection resolve to the correct response. Server-side event
// notifications (broadcast with no jsonrpc id) are dropped: the MCP surface is
// request/response, matching the pre-existing behavior of browse_subscribe
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
          return ws;
        }

        // Attempt failed — release this socket's connect-phase listeners fully so
        // its later error/close can't touch live state (MW-4).
        try { ws.removeAllListeners(); ws.close(); } catch (_e) {}
        const err = connectionErr || new Error('connection refused');
        // eslint-disable-next-line no-console
        if (attempt > 0 && attempt % 4 === 0) console.error('[mcp] ws reconnect attempt', attempt, '-', err.message);

        // Lazy launch: the first failure triggers the injected runner (spawns
        // Electron on demand). ensureElectronRunning is idempotent — no-op when
        // the port is already listening — so calling it on every retry is safe and
        // also re-launches after a manual kill of Electron.
        if (typeof ensureRunning === 'function') {
          try { await ensureRunning(); } catch (_e) {}
        }

        if (Date.now() >= deadline) throw new Error('WS reconnect timeout: ' + err.message);
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
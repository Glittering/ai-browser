// main/mcp_ws.js — Persistent WebSocket JSON-RPC client used by the MCP server.
// One WebSocket is opened lazily and reused for every RPC; requests carry
// incrementing ids routed through an id -> resolver map, so concurrent calls
// on the same connection resolve to the correct response. Server-side event
// notifications (broadcast with no jsonrpc id) are dropped: the MCP surface is
// request/response, matching the pre-existing behavior of browse_subscribe
// (enables CDP monitors + network-body cache; does not stream live events).
import WebSocket from 'ws';

export function createWsClient({ url, timeout = 15000 }) {
  let _ws = null;
  let _connecting = null;
  let _rpcId = 0;
  const _pending = new Map();

  function flushPending(err) {
    for (const [, cb] of _pending) cb({ error: { message: err.message } });
    _pending.clear();
  }

  function getWs() {
    if (_ws && _ws.readyState === WebSocket.OPEN) return Promise.resolve(_ws);
    if (_connecting) return _connecting;
    _connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      _ws = ws;
      ws.on('open', () => { _connecting = null; resolve(ws); });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        const cb = msg.id !== undefined ? _pending.get(msg.id) : undefined;
        if (cb) { _pending.delete(msg.id); cb(msg); }
        // Notifications (no id) are dropped — see the createWsClient comment.
      });
      ws.on('error', (e) => {
        _connecting = null; _ws = null;
        flushPending(new Error('WebSocket error: ' + e.message));
        reject(e);
      });
      ws.on('close', () => {
        if (_connecting) _connecting = null;
        _ws = null;
        flushPending(new Error('WebSocket closed'));
      });
    });
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

  // Force-close the underlying connection. Detaches the socket's own handlers
  // first so their deferred close/error events can't clobber the refs of a
  // freshly re-opened connection created right after this returns (rapid
  // reconnect race). In-flight calls are rejected.
  function close() {
    const ws = _ws;
    _connecting = null;
    _ws = null;
    if (ws) {
      ws.removeAllListeners('close');
      ws.removeAllListeners('error');
      try { ws.close(); } catch (_e) {}
    }
    flushPending(new Error('client closed'));
  }

  return { call, close };
}
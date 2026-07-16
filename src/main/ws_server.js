// main/ws_server.js — WebSocket JSON-RPC server
import { WebSocketServer } from 'ws';
import { parseMessage, ERROR_CODES } from '../shared/protocol.js';

let wss = null;

export function startWSServer(pageManager, port = 9223) {
  wss = new WebSocketServer({ port });

  wss.on('connection', (ws, _req) => {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subscriptions = new Set();

    // Register for event delivery
    pageManager.registerClient(sessionId, ws);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // Notification (no id) — subscribe/unsubscribe
      if (msg.id === undefined || msg.id === null) {
        if (msg.method === 'ui.subscribe') {
          const events = msg.params?.events || [];
          events.forEach(ev => subscriptions.add(ev));
          pageManager.addSubscription(sessionId, events);
        }
        if (msg.method === 'ui.unsubscribe') {
          const events = msg.params?.events || [];
          events.forEach(ev => subscriptions.delete(ev));
          pageManager.removeSubscription(sessionId, events);
        }
        return;
      }

      const { id, method, params = {} } = msg;
      const send = (payload) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload));
      };

      try {
        switch (method) {
          case 'ui.get_tree': {
            const tree = await pageManager.getTree(params.focusedOnly);
            send({ jsonrpc: '2.0', id, result: { tree } });
            break;
          }
          case 'ui.act': {
            const result = await pageManager.executeAction(
              params.action, params.target, params.params || {}
            );
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.subscribe': {
            const events = params.events || [];
            events.forEach(ev => subscriptions.add(ev));
            pageManager.addSubscription(sessionId, events);
            send({ jsonrpc: '2.0', id, result: { ok: true } });
            break;
          }
          case 'ui.unsubscribe': {
            const events = params.events || [];
            events.forEach(ev => subscriptions.delete(ev));
            pageManager.removeSubscription(sessionId, events);
            send({ jsonrpc: '2.0', id, result: { ok: true } });
            break;
          }
          case 'ui.navigate': {
            await pageManager.navigate(params.url);
            send({ jsonrpc: '2.0', id, result: { ok: true } });
            break;
          }
          case 'ui.get_focused': {
            const result = await pageManager.getFocused();
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.evaluate': {
            const value = await pageManager.evaluate(params.js);
            send({ jsonrpc: '2.0', id, result: { value } });
            break;
          }
          default:
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
            break;
        }
      } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
      }
    });

    ws.on('close', () => {
      pageManager.unregisterClient(sessionId);
    });
  });

  console.log('AI Browser WS server listening on ws://localhost:' + port);
  return { close: () => wss?.close() };
}
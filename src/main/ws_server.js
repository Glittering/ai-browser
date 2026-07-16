// main/ws_server.js — WebSocket JSON-RPC server v2 (multi-tab)
import { WebSocketServer } from 'ws';
import { parseMessage, ERROR_CODES } from '../shared/protocol.js';

let wss = null;

export function startWSServer(pageManager, port = 9223) {
  wss = new WebSocketServer({ port });

  wss.on('connection', (ws, _req) => {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subscriptions = new Set();

    pageManager.registerClient(sessionId, ws);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // Notification (no id)
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
      const tabId = params.tab;  // optional tab routing
      const send = (payload) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload));
      };

      try {
        switch (method) {
          case 'ui.get_tree': {
            const result = await pageManager.getTree(params.focusedOnly, tabId);
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.act': {
            const result = await pageManager.executeAction(
              params.action, params.target, params.params || {}, tabId
            );
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.navigate': {
            const ok = await pageManager.navigate(params.url, tabId);
            send({ jsonrpc: '2.0', id, result: { ok } });
            break;
          }
          case 'ui.evaluate': {
            const value = await pageManager.evaluate(params.js, tabId);
            send({ jsonrpc: '2.0', id, result: { value } });
            break;
          }
          // === Tab management ===
          case 'ui.new_tab': {
            const newTabId = pageManager.newTab(params.url || null);
            send({ jsonrpc: '2.0', id, result: { tab: newTabId } });
            break;
          }
          case 'ui.close_tab': {
            const ok = pageManager.closeTab(params.tab);
            send({ jsonrpc: '2.0', id, result: { ok } });
            break;
          }
          case 'ui.list_tabs': {
            const tabs = pageManager.listTabs();
            send({ jsonrpc: '2.0', id, result: { tabs } });
            break;
          }
          case 'ui.set_active_tab': {
            const ok = pageManager.setActive(params.tab);
            send({ jsonrpc: '2.0', id, result: { ok } });
            break;
          }
          // === Subscribe/unsubscribe (with response) ===
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
          case 'ui.get_focused': {
            const result = await pageManager.getFocused(tabId);
            send({ jsonrpc: '2.0', id, result });
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
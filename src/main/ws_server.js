// main/ws_server.js — WebSocket JSON-RPC server v2 (multi-tab)
import { WebSocketServer } from 'ws';
import { parseMessage, ERROR_CODES } from '../shared/protocol.js';

let wss = null;

// Helper: search tree by field value
function findInTree(node, field, value) {
  if (!node) return null;
  if (node[field] && node[field].indexOf && node[field].indexOf(value) >= 0) return node;
  if (node.children) for (const c of node.children) { const f = findInTree(c, field, value); if (f) return f; }
  return null;
}

export function startWSServer(pageManager, port = 9223, onQuit = null) {
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
            const js = String(params.js ?? '');
            // Guard rails on the raw WS path too. The MCP layer already rejects
            // these, but a direct ws client bypasses MCP, so enforce the same
            // contract here: cap length and reject obvious Node-exfil patterns.
            if (js.length > 5000) {
              send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'script exceeds 5000 char limit' } });
              break;
            }
            if (/\bprocess\.\b|\brequire\s*\(|\bchild_process\b|\bglobalThis\.process\b/.test(js)) {
              send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'script contains disallowed Node-specific identifier' } });
              break;
            }
            const value = await pageManager.evaluate(js, tabId);
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
          // === ui.wait — poll until condition or timeout ===
          case 'ui.wait': {
            // params: { condition: 'button_enabled'|'modal_appeared'|'text_contains', target, text, timeout_ms }
            const timeoutMs = params.timeout_ms || 10000;
            const pollMs = 500;
            const startTime = Date.now();
            let satisfied = false;

            const poll = async () => {
              while (Date.now() - startTime < timeoutMs) {
                const result = await pageManager.getTree(false, tabId);
                const tree = result?.tree;
                const ctx = result?.context;

                if (params.condition === 'button_enabled' && params.target) {
                  // Find button by label in tree
                  const btn = findInTree(tree, 'label', params.target);
                  if (btn && (!btn.states || btn.states.indexOf('disabled') < 0)) {
                    satisfied = true; break;
                  }
                }
                if (params.condition === 'modal_appeared') {
                  if (ctx?.modals && ctx.modals.length > 0) { satisfied = true; break; }
                }
                if (params.condition === 'text_contains' && params.text) {
                  const bodyText = await pageManager.evaluate('document.body.innerText', tabId);
                  if (bodyText && bodyText.indexOf(params.text) >= 0) { satisfied = true; break; }
                }
                if (params.condition === 'url_contains' && params.text) {
                  const url = await pageManager.evaluate('location.href', tabId);
                  if (url && url.indexOf(params.text) >= 0) { satisfied = true; break; }
                }

                await new Promise(r => setTimeout(r, pollMs));
              }
            };

            await poll();
            send({ jsonrpc: '2.0', id, result: { satisfied, elapsed_ms: Date.now() - startTime } });
            break;
          }
          // === ui.scroll — scroll page or element ===
          case 'ui.scroll': {
            const direction = params.direction || 'down';
            const amount = Math.max(-10000, Math.min(10000, Number(params.amount) || 500));
            // Pass target/direction/amount as JSON-encoded args — never
            // interpolate params.target into JS source, otherwise a malicious
            // caller can inject `target = "']); fetch('...') //"`.
            const target = typeof params.target === 'string' ? params.target : null;
            const js = `(function(t, d, a){
              if (t) {
                var all = document.querySelectorAll('[data-ai-id]');
                for (var i = 0; i < all.length; i++) {
                  if (all[i].getAttribute('data-ai-id') === t) {
                    all[i].scrollIntoView({ behavior: 'instant', block: 'center' });
                    return { ok: true };
                  }
                }
                return { ok: false, error: 'target not found' };
              }
              window.scrollBy(0, d === 'down' ? a : -a);
              return { ok: true };
            })(${JSON.stringify(target)}, ${JSON.stringify(direction)}, ${amount})`;
            const result = await pageManager.evaluate(js, tabId).catch(() => ({ ok: false }));
            send({ jsonrpc: '2.0', id, result: result || { ok: true } });
            break;
          }
          // === ui.network_body — get HTTP response body by URL pattern ===
          case 'ui.network_body': {
            const body = await pageManager.getNetworkBody(params.url_pattern || '', tabId);
            send({ jsonrpc: '2.0', id, result: { body: body } });
            break;
          }
          // === ui.quit — let MCP clients shut down the browser gracefully ===
          // The agent owns the browser lifecycle; without this it has no way
          // to release the process after finishing a task.
          case 'ui.quit': {
            send({ jsonrpc: '2.0', id, result: { ok: true } });
            // Defer so the response actually flushes before the WS closes.
            if (onQuit) setTimeout(() => { try { onQuit(); } catch (e) {} }, 200);
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
  return {
    close: () => {
      if (!wss) return;
      for (const client of wss.clients) {
        try { client.terminate(); } catch (e) {}
      }
      wss.close();
      wss = null;
    }
  };
}
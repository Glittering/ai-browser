// main/ws_server.js — WebSocket JSON-RPC server v2 (multi-tab)
import { WebSocketServer } from 'ws';
import { evaluateGuardError } from '../shared/guards.js';
import { config } from '../shared/config.js';

// Each startWSServer() owns a private WebSocketServer. Keeping it local (not a
// module global) means multiple servers can coexist — required by tests that
// spin up independent servers on ephemeral ports without one close() tearing
// down another's.
// Helper: search tree by field value
function findInTree(node, field, value) {
  if (!node) return null;
  if (node[field] && node[field].indexOf && node[field].indexOf(value) >= 0) return node;
  if (node.children) for (const c of node.children) { const f = findInTree(c, field, value); if (f) return f; }
  return null;
}

export function startWSServer(pageManager, port = config.wsPort, onQuit = null) {
  const wss = new WebSocketServer({ port });

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
            // P0 probe: params.ax routes to the AX read layer (getFullAXTree);
            // default path (preload extractor) is unchanged.
            const result = params.ax
              ? await pageManager.getTreeViaAx(tabId, {
                  subset: params.subset,
                  mode: params.mode,
                  focusedOnly: params.focusedOnly,
                })
              : await pageManager.getTree(params.focusedOnly, tabId);
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
          case 'ui.repaint': {
            // Force the compositor to redraw a tab's BrowserView. Needed because
            // "the window shows a stale page" has NO observable state to detect:
            // the DOM tree / evaluate already report the NEW page while the
            // screen shows the OLD one. So the agent's only handle on it is an
            // explicit "this window looks wrong, redraw it".
            const r = pageManager.repaint(tabId);
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          case 'ui.snapshot': {
            const r = await pageManager.snapshot({ js: params.js, label: params.label, tab: tabId });
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          case 'ui.diff': {
            const r = await pageManager.diff({
              snapshot: params.snapshot,
              js: params.js,
              rearm: params.rearm,
              forget: params.forget,
              tab: tabId,
            });
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          case 'ui.capabilities': {
            // "How should I operate THIS page?" — one call answers it: is the
            // graph DOM or canvas, is the body in an iframe, does the app hang a
            // model off window, which JSON endpoints exist, and therefore
            // whether to go structured-data / semantic-tree / pointer-gestures.
            const r = await pageManager.capabilities({
              tab: tabId,
              include_network: params.include_network,
              network_limit: params.network_limit,
            });
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          case 'ui.evaluate': {
            const js = String(params.js ?? '');
            // Guard rails (shared single source) — enforce length + reject
            // obvious Node-exfil patterns. The MCP layer applies the same guard;
            // a direct ws client bypasses MCP, so enforce the same contract here.
            const guardErr = evaluateGuardError(js);
            if (guardErr) {
              send({ jsonrpc: '2.0', id, error: { code: -32602, message: guardErr } });
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
          // === ui.canvas_* — canvas 绘制调用记录（语义层，非像素） ===
          case 'ui.canvas_configure': {
            // canvasConfigure 是 async（可能触发 hook 安装与按要求的重载），必须 await
            const result = await pageManager.canvasConfigure(tabId, {
              mode: params.mode,
              clear: params.clear === true,
              reload: params.reload === true,
            });
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.canvas_list': {
            const result = pageManager.canvasList(tabId);
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.canvas_read': {
            const result = pageManager.canvasRead(tabId, {
              canvasId: params.canvas_id,
              view: params.view,
              sinceSeq: params.since_seq,
              limit: params.limit,
            });
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.canvas_capture': {
            // 视觉兜底：默认不该被调用。只在语义层读不懂（WebGL / 纯像素 canvas）
            // 时由调用方显式触发；会消耗调用方的视觉 token。
            const result = await pageManager.canvasCapture(tabId, params.canvas_id);
            send({ jsonrpc: '2.0', id, result: result || { error: 'canvas not found or capture failed' } });
            break;
          }
          case 'ui.get_focused': {
            const result = await pageManager.getFocused(tabId);
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.peek': {
            // A (plan §9.5): safely reveal a folded/hoverable affordance and
            // return the AX diff. Non-committing (hover only).
            const result = await pageManager.peek(tabId, params.target, params);
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
          // === 网络抓包（可查询的 Network 面板）===
          // 列表/详情/清理/配置。错误码见 network_monitor.NETWORK_ERROR_CODES：
          // 不存在 / body 被淘汰 / body 拿不到 / 敏感头未开，各自独立，不静默 null。
          case 'ui.network_list': {
            const result = pageManager.networkList({
              tab: tabId,
              method: params.method,
              url_contains: params.url_contains,
              status: params.status,
              resource_type: params.resource_type,
              started_after: params.started_after,
              started_before: params.started_before,
              state: params.state,
              limit: params.limit,
              before_seq: params.before_seq,
            });
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.network_get': {
            try {
              const result = await pageManager.networkGet(String(params.network_id || ''), {
                include_request_headers: params.include_request_headers === true,
                include_request_body: params.include_request_body === true,
                include_response_headers: params.include_response_headers === true,
                include_response_body: params.include_response_body === true,
                include_sensitive_headers: params.include_sensitive_headers === true,
                request_body_offset: params.request_body_offset,
                response_body_offset: params.response_body_offset,
                body_limit: params.body_limit,
              });
              send({ jsonrpc: '2.0', id, result });
            } catch (e) {
              if (e && e.rpcCode) send({ jsonrpc: '2.0', id, error: { code: e.rpcCode, message: e.message, data: e.data || undefined } });
              else send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
            }
            break;
          }
          case 'ui.network_clear': {
            const result = pageManager.networkClear(tabId);
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.network_configure': {
            const result = pageManager.networkConfigure(tabId, {
              enabled: params.enabled,
              capture_bodies: params.capture_bodies,
            });
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          // === ui.network_body — DEPRECATED，保留一个版本 ===
          // 按 url_pattern 选最近完成的匹配项（内部转 network_get），响应仍为
          // 旧形状 {body:string|null}。下一主版本删除。
          case 'ui.network_body': {
            const body = await pageManager.getNetworkBody(params.url_pattern || '', tabId);
            send({
              jsonrpc: '2.0', id,
              result: {
                body: body,
                deprecated: true,
                replacement: 'ui.network_list + ui.network_get',
                warning: 'ui.network_body is deprecated and keeps only the first 5000 chars of the newest finished match — use ui.network_list/ui.network_get for method, headers, POST body and paging',
              },
            });
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
    // Actual bound port (for tests that pass port 0 to grab an ephemeral one).
    port: wss.address().port,
    close: () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch (e) {}
      }
      wss.close();
    }
  };
}
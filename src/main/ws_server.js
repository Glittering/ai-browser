// main/ws_server.js — WebSocket JSON-RPC server v2 (multi-tab)
import { WebSocketServer } from 'ws';
import { evaluateGuardError } from '../shared/guards.js';
import { withDeadline, actionDeadlineMs } from '../shared/deadline.js';
import { config } from '../shared/config.js';
// act 的参数形状归一（嵌套 params 与顶层平铺都接受）
import actParams from '../shared/act_params.cjs';
// 穿透影子根的 ref 查找。ui.scroll 的 target 也走它 —— 不穿透的话，目标在
// Web Component 里时会报 "target not found"，而元素其实就在那儿。
import findRefUtil from '../shared/find_ref.cjs';
// 错误日志：RPC 层异常必须落盘（此前只回一句 JSON-RPC error，现场永久丢失），
// 每次调用的摘要进环形缓冲，作为崩溃时的上下文。
import { recordError, noteCall, recentErrors } from './error_log.js';

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
// wait{button_enabled} 的目标解析。
//
// 老实现直接 findInTree(tree,'label',target) —— 按 **label 子串** 匹配。可整个 API
// 里 target 一律指元素 id（get_tree 给的那个），agent 拿 id 来等就永远等不到：
// 实测传 'lateBtn'（元素 id）8s 超时后 satisfied=false，而传按钮文案 3ms 就满足
// （e2e/audit_ws.cjs AU-E1/AU-E2）。agent 会误判成"按钮一直禁用"。
//
// 现在先按 id 精确匹配，命中不了再退化成 label 子串（老用法仍然成立）。
// 顺序不能反：label 是子串匹配，'go' 会命中任何文案里带 go 的节点。
function findWaitTarget(tree, target) {
  if (!target) return null;
  const byId = findInTree(tree, 'id', String(target));
  if (byId && byId.id === String(target)) return byId;
  const any = findInTree(tree, 'id', String(target));
  if (any) return any;
  return findInTree(tree, 'label', String(target));
}

// 进程启动时刻（秒）。供 ui.server_info 报出去 —— pid 会被复用，只比 pid
// 不够稳；pid + started_at 两个一起才足以判定"是不是同一个进程"。
const serverStartedAt = Math.floor(Date.now() / 1000);

export function startWSServer(pageManager, port = config.wsPort, onQuit = null) {
  // Bind loopback only — the protocol carries no auth. ws' default (host
  // omitted) is 0.0.0.0, which would expose the browser — including all its
  // persisted logins — to the entire local network. Override via
  // AI_BROWSER_WS_HOST only with eyes open.
  const wss = new WebSocketServer({ port, host: config.wsBindHost });

  // Passing a host pushes Node onto the async DNS-lookup listen path, so
  // wss.address() is null until 'listening'. Cache it and let callers await.
  let bound = null;
  const ready = new Promise((resolve, reject) => {
    wss.once('listening', () => { bound = wss.address(); resolve(bound); });
    wss.once('error', reject);
  });
  ready.then(() => {
    console.log(`AI Browser WS server listening on ws://${bound.address}:${bound.port}`);
  }).catch(() => {});

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

      const t0 = Date.now();
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
            // RPC 边界上的保底：这一层也套 deadline，与 page_manager 内部那一层
            // 同源（都用 actionDeadlineMs 算预算）。为什么两层都要：
            //   - page_manager 那层保护所有内部调用方（capability_probe、直接 API）；
            //   - 这一层保护"以后新增的页面路径忘了套"，并且**可以用 mock PageManager
            //     做单测**（真实 PageManager 依赖 Electron，vitest 里起不来）。
            // 同源意味着两层不会打架：预算一致，谁先到期谁报，语义相同。
            //
            // 参数形状：`params:{...}` 是规范形状，顶层平铺的已知动作参数会被
            // 提升（见 shared/act_params.cjs）。此前平铺的 text/html 被静默丢掉，
            // 动作照常执行但输入为空 —— 调用方看到的是 "type called with empty text"。
            const hoisted = actParams.hoistActParams(params);
            const actParamsObj = hoisted.params;
            const budget = actionDeadlineMs(params.action, actParamsObj);
            try {
              const result = await withDeadline(
                pageManager.executeAction(params.action, params.target, actParamsObj, tabId),
                budget, `action:${params.action}`
              );
              // 提升过就在回执里说明：调用方会知道"我平铺的参数被接受了"，
              // 而不是下次换个客户端又悄悄失效。
              if (hoisted.hoisted.length && result && typeof result === 'object' && !result.params_hoisted) {
                result.params_hoisted = hoisted.hoisted;
              }
              send({ jsonrpc: '2.0', id, result });
            } catch (e) {
              if (e && e.__deadline) {
                // 外层预算可能先于 page_manager 内层到期（内层还要等动作前探针）。
                // 所以这条兜底路径也要能识别"是对话框把页面冻住了"—— 否则用户
                // 看到的就是"点了删除，超时"，而屏幕上那个原生确认框没人应答。
                const dlg = await Promise.resolve()
                  .then(() => pageManager.recoverBlockedTab?.(tabId))
                  .catch(() => null);
                send({
                  jsonrpc: '2.0', id,
                  result: {
                    success: false,
                    error: dlg
                      ? `blocked by a browser-level JS dialog (${dlg.type}) — native sheet, not page DOM; the page is frozen while it is open. It has been ${dlg.accept ? 'accepted' : 'dismissed'} automatically; re-read the tree before retrying.`
                      : `${e.message} — the page's main thread is likely blocked; the action may have partially applied`,
                    timed_out: true,
                    deadline_ms: budget,
                    action: params.action,
                    ...(dlg ? { dialog: dlg, retry: 'verify_first' } : {}),
                  },
                });
              } else {
                throw e;
              }
            }
            break;
          }
          case 'ui.navigate': {
            // navigate 现在返回 {ok, error?}：成功形状与旧的 {ok:true} 一致，
            // 失败时多一个原因。此前只有布尔，agent 拿到 ok:false 无从判断
            // 该重试还是换 URL；而"页面永不 did-finish-load"是会真实发生的。
            const r = await pageManager.navigate(params.url, tabId, { waitUntil: params.wait_until });
            send({ jsonrpc: '2.0', id, result: r && typeof r === 'object' ? r : { ok: !!r } });
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
          case 'ui.paint_check': {
            // "这一页到底画出来了没有"—— 只读，不改任何东西。
            //
            // 为什么必须有这个入口：白屏是唯一一种"did-finish-load 到了、
            // readyState=complete、evaluate 读得到文字、CDP 截图也有内容，
            // 但屏幕上就是纯白"的失败形态。所有既有观测口在这里集体失明，
            // 于是用户说"白的"、工具说"好的"，谁也拿不出证据。
            // 判定口径见 shared/blank_page.cjs。
            //
            // heal:true 时才走自救阶梯（repaint → reload → 给结论并上报），
            // 默认只观测 —— 调用方问"是不是白的"时，不该顺手把页面重载掉。
            const tid = params.tab !== undefined ? params.tab : pageManager.activeTab;
            const r = params.heal ? await pageManager._auditPaint(tid) : await pageManager.paintCheck(tid);
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
            // 参数名是 js；expr 是 MCP 层的叫法，作为别名保留 —— 文档里写错一次
            // （2026-10-20 技能里写成 expr）就会得到 `{value: undefined}`，
            // 看上去像"页面没东西"，实际是表达式根本没执行。别名 + 空表达式报错，
            // 把"静默返回 undefined"这条路彻底堵掉。
            const rawJs = params.js !== undefined ? params.js : params.expr;
            const js = String(rawJs === undefined || rawJs === null ? '' : rawJs);
            if (!js.trim()) {
              send({
                jsonrpc: '2.0', id,
                error: { code: -32602, message: 'empty expression: pass {"js":"<expression>"} (alias: "expr")' },
              });
              break;
            }
            // Guard rails (shared single source) — enforce length + reject
            // obvious Node-exfil patterns. The MCP layer applies the same guard;
            // a direct ws client bypasses MCP, so enforce the same contract here.
            const guardErr = evaluateGuardError(js);
            if (guardErr) {
              send({ jsonrpc: '2.0', id, error: { code: -32602, message: guardErr } });
              break;
            }
            // frame_ref: run inside that cross-process frame's context.
            // Needed because the implicit route (a literal data-ai-id="axf-..."
            // inside the JS) silently no-ops when the caller builds the selector
            // by string concatenation — the JS then runs in the top frame and
            // reads null back for an element that exists.
            const value = await pageManager.evaluate(js, tabId, { frameRef: params.frame_ref || undefined });
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
          // 窗口首次显示的时刻与当时页面状态。
          // 存在的理由：白屏类缺陷的根因是"窗口显示了但渲染器还没画出第一帧"，
          // 而这只能从窗口侧观测 —— WS 端口在 createWindow 中途就开了，比
          // showInitialWindow 早，从 agent 侧轮询永远测不到那个时序。
          // 一次性记录：窗口只首次显示一次，之后一直是它。
          case 'ui.window_shown': {
            send({ jsonrpc: '2.0', id, result: { shown: pageManager.windowShownAt || null } });
            break;
          }
          case 'ui.set_active_tab': {
            const ok = pageManager.setActive(params.tab);
            send({ jsonrpc: '2.0', id, result: { ok } });
            break;
          }
          // 服务端的进程身份。存在的理由（2026-10-15 实测）：调用方**无法确认
          // 自己连上的是不是自己拉起的那个实例**。决定性实验——在"端口忙"预检
          // 之后让一个冒牌 WS server 抢占端口，e2e 套件照常发出 ui.new_tab /
          // ui.evaluate / ui.get_tree 却毫不知情：测的是别人的实例，结果毫无
          // 意义，而且不报错，只给出一堆莫名其妙的失败。
          // 有了 pid，调用方就能核对"是不是我 spawn 的那个进程"。
          case 'ui.server_info': {
            send({
              jsonrpc: '2.0', id,
              result: {
                pid: process.pid,
                // 进程启动时刻（秒）。pid 可被复用，两个数字一起才够稳。
                started_at: serverStartedAt,
                ws_port: port,
                platform: process.platform,
              },
            });
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
          case 'ui.auth_state': {
            // 登录态 / 登录墙自查。长任务里每个关键步骤前问一次，成本近似为零。
            // auth_wall.detected=true 是硬事实（URL 命中登录域 / 页面上有密码框），
            // 此时任何"操作没生效"的排查都该先停下 —— 你大概不在目标站点的工作页。
            const result = await pageManager.authState(tabId);
            send({ jsonrpc: '2.0', id, result });
            break;
          }
          case 'ui.screenshot': {
            // 视口截图（P0-1）。工具面此前只有元素树一只眼睛，树里没有的
            // （浮层/canvas/遮挡/渲染错位）就完全不可见 —— 而它们正是操作
            // 失败的主因。失败时"先看截图"从此有工具可依。
            // 参数：{ tab, format: 'png'|'jpeg'|'webp', quality: 0-100,
            //         fullPage: bool, clip: {x,y,width,height,scale} }
            const result = await pageManager.screenshot(tabId, params);
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
                  // Find button by id first (what get_tree hands the agent), label as fallback
                  const btn = findWaitTarget(tree, params.target);
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
                var el = ${findRefUtil.findRefExpr('t')};
                if (!el) return { ok: false, error: 'target not found' };
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                return { ok: true };
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
          case 'ui.downloads': {
            // 下载此前**完全没人处理**：Electron 默认取消，agent 点"导出"只看到
            // success，然后什么都没有，连错误都没有。落盘路径可预期
            // （<userData>/downloads/<tabId>/），这里就是让 agent 问到"文件在哪儿"。
            const r = pageManager.downloads({ tab: tabId });
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          // === ui.errors — 读主进程错误日志（本次进程的内存记录 + 文件路径）===
          // 存在的理由：界面里弹一个"js 崩溃"的原生框，栈只活在框里，点掉就没了。
          // 让调用方能主动问"刚才报过什么错"，不用靠人复述。
          // 历史（跨进程）在 path 指向的 JSONL 文件里；这里返回的是本次进程的。
          case 'ui.errors': {
            const r = recentErrors(params.limit, params.kind || null);
            send({ jsonrpc: '2.0', id, result: { ok: true, ...r } });
            break;
          }
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
        // 成功的调用只进环形缓冲（不落盘）：它的用处是"崩溃那一刻最近的上下文"，
        // 而不是给每次点击都记一行日志。
        noteCall(method, params, Date.now() - t0, true);
      } catch (e) {
        noteCall(method, params, Date.now() - t0, 'error: ' + ((e && e.message) || e));
        // RPC 层异常**必须落盘**。此前它只变成一句 JSON-RPC error 回给调用方，
        // 一旦客户端那边没截住（或用户只看到界面里闪一下），现场就永久丢了 ——
        // 事后既查不到崩在哪，也证不了"刚才是不是真的报过错"。
        recordError('ws_error', {
          method,
          params,
          message: (e && e.message) || String(e),
          stack: String((e && e.stack) || '').slice(0, 8000),
        });
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
      }
    });

    ws.on('close', () => {
      pageManager.unregisterClient(sessionId);
    });
  });

  return {
    // Resolves once the socket is actually bound (port 0 → ephemeral port known).
    ready,
    // Actual bound port/address; null until ready.
    get port() { return bound ? bound.port : null; },
    // Security invariant: must be a loopback literal.
    get host() { return bound ? bound.address : null; },
    close: () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch (e) {}
      }
      wss.close();
    }
  };
}
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
// 默认目标标签页的判据（explicit > session > active > first），理由与两条不可
// 退让的约束见 shared/tab_route.cjs 顶部（多 agent 并用时"目标被别人改掉"）。
import tabRoute from '../shared/tab_route.cjs';
import tabGroup from '../shared/tab_group.cjs';

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

// 这些方法**不碰页面**，所以"你的标签页没了"不该拦它们 —— 否则 agent 在标签页
// 被别人关掉之后，连 ui.new_tab / ui.list_tabs 这种自救动作都会被错误挡回去，
// 等于把人锁在门外。
const TABLESS_METHODS = new Set([
  'ui.new_tab', 'ui.list_tabs', 'ui.close_tab', 'ui.server_info', 'ui.errors',
  'ui.window', 'ui.window_bounds', 'ui.window_shown', 'ui.quit',
  'ui.subscribe', 'ui.unsubscribe',
]);
// 这些方法本来就在"管理标签页"，不能先替调用方开一个工作页再执行。
const TAB_OWN_METHODS = new Set([
  'ui.new_tab', 'ui.list_tabs', 'ui.close_tab', 'ui.set_active_tab',
  'ui.server_info', 'ui.errors', 'ui.window', 'ui.window_bounds',
  'ui.window_shown', 'ui.quit', 'ui.subscribe', 'ui.unsubscribe', 'ui.hello',
]);

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
    // 连接的身份与工作区。isAgentConn 只有 ui.hello 才会置真 —— 裸 WS（e2e、
    // 脚本、调试）保持老行为：不传 tab 就打当前页。
    let clientName = null;
    let isAgentConn = false;
    // 声明自己是 agent 的连接默认获得自动工作区；CLI 这类"人就坐在终端前"的
    // 入口显式关掉（auto_workspace:false），它想打当前页就是打当前页。
    let autoWorkspace = true;
    // 自报家门的两种写法都要认：MCP 发**通知**（无 id），有些客户端会发成
    // 普通请求（带 id 等回执）。只认通知的话，带 id 的那种会掉进 switch 变成
    // "Method not found"，而调用方通常只看结果不看错误 —— 表现就是"自动工作区
    // 有时生效有时不生效"，这类半生效最难查。
    const applyHello = (p) => {
      const params = p || {};
      clientName = String(params.label || params.client || '').trim().slice(0, 24) || null;
      isAgentConn = true;
      if (params.auto_workspace === false) autoWorkspace = false;
      if (process.env.AI_BROWSER_AUTO_WORKSPACE === '0') autoWorkspace = false;
      // capped:true —— 声明自己是 agent 才受"每组上限"约束（见 canOpenInGroup）。
      if (typeof pageManager.ensureGroup === 'function') {
        pageManager.ensureGroup(sessionId, clientName, { capped: true });
      }
      return { ok: true, agent: clientName || true, auto_workspace: autoWorkspace };
    };

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
        // ui.hello：连接自报家门。MCP / CLI 在拿到 socket 后立刻发。
        //
        // 为什么需要它：WS 是纯 JSON-RPC，服务端只看到一个 socket，不知道对面
        // 是"一个 agent"还是"某段脚本"。而"要不要给你一块自己的工作区"必须
        // 区分这两种人 —— 脚本（e2e、调试）期望的是老行为：不传 tab 就打当前页。
        // 所以只有**主动声明自己是 agent**的连接才自动获得工作区。
        if (msg.method === 'ui.hello') {
          applyHello(msg.params);
        }
        return;
      }

      const { id, method, params = {} } = msg;
      // 这次调用操作哪个标签页：调用方点名 > 本连接自己的标签页 > 人眼看的那一个。
      //
      // 以前这里是 `const tabId = params.tab`，缺省就落到全局 activeTab —— 单 agent
      // 时看不出问题，多个 agent 同时用时就是灾难：A 开一个标签页，所有人的默认
      // 目标都变成它；人切一下标签页，把所有 agent 的目标一起切走。判据集中在
      // shared/tab_route.cjs，这里只负责把会话维度接上去。
      //
      // 全程 try/catch + 能力探测：单测用的是 Mock PageManager（没有 tabs /
      // sessionTabOf），路由不该因此把每个方法都打成 500。
      let routed;
      try {
        if (typeof pageManager.resolveTargetTab === 'function') {
          routed = pageManager.resolveTargetTab({ explicit: params.tab, sessionId });
        } else {
          const known = (pageManager.tabs && typeof pageManager.tabs.keys === 'function')
            ? Array.from(pageManager.tabs.keys()) : [];
          routed = tabRoute.resolveTarget({
            explicit: params.tab,
            session: typeof pageManager.sessionTabOf === 'function' ? pageManager.sessionTabOf(sessionId) : null,
            active: pageManager.activeTab,
            tabs: known,
          });
          // 拿不到标签页清单（单测 mock）→ 不参与路由，按调用方给的来
          if (!known.length && (params.tab === undefined || params.tab === null)) {
            routed = { tab: null, source: 'unknown' };
          }
        }
      } catch (_) {
        routed = { tab: params.tab === undefined ? null : params.tab, source: 'unknown' };
      }
      let tabId = routed.tab;
      // 本次回复要附带的一次性提示（只在本连接刚拿到工作区时出现一次）。
      let workspaceNote = null;
      const send = (payload) => {
        if (workspaceNote && payload && payload.result &&
            typeof payload.result === 'object' && !Array.isArray(payload.result)) {
          if (!payload.result.workspace) payload.result.workspace = workspaceNote;
        }
        if (ws.readyState === 1) ws.send(JSON.stringify(payload));
      };
      // 会话标签页没了 → 必须在这一层拦住（否则会退回到别人的页面继续执行）。
      //
      // 但"点名了一个不存在的 tab"**不**在这里报：那是方法自己的校验，而且各方法
      // 的词汇更准（ui.repaint 报 no-such-tab、ui.diff 报 tab-mismatch，
      // 后者是语义检查而不是"找不到"）。在这里统一改写成 RPC error 会把
      // "跨 tab 比对被拒绝"这类可诊断的结论一并抹平。
      const routingError = () => {
        if (!routed.error || routed.source === 'gone') return false;
        send({ jsonrpc: '2.0', id, error: { code: -32001, message: routed.error, data: { source: routed.source } } });
        return true;
      };

      const t0 = Date.now();
      // ---- 自动工作区 ----------------------------------------------------
      //
      // agent 第一次要动页面、而它还没指定过任何目标时，给它一页**自己的**空标签，
      // 归到它自己的组里。这是"agent 的操作与人的操作完全隔离"的地基：默认目标
      // 再也不会落在人眼前那一页上（那是 v2.2.0 留下的最后一个口子 —— 会话没有
      // 绑定时就 fallback 到 active，而 active 永远是人正在看的页）。
      //
      // 四条不触发，缺一不可：
      //   1. 不是 agent（没发 ui.hello）：裸 WS（e2e / 脚本 / 调试）保持老行为，
      //      不传 tab 就打当前页 —— 否则所有回归和临时脚本都会突然对着一片空白。
      //   2. 方法本身在管标签页（new_tab / list_tabs / window …）：先开一页再列
      //      标签页是荒谬的。
      //   3. 调用方显式点了 tab，或本连接已经有绑定：那是明确意图，不许覆盖。
      //   4. AI_BROWSER_AUTO_WORKSPACE=0：留着给"我就想让它打当前页"的场景。
      if (isAgentConn && autoWorkspace && !TAB_OWN_METHODS.has(method) &&
          (params.tab === undefined || params.tab === null) &&
          typeof pageManager.newTab === 'function' &&
          typeof pageManager.sessionTabOf === 'function' &&
          pageManager.sessionTabOf(sessionId) === null) {
        try {
          const g = typeof pageManager.ensureGroup === 'function'
            ? pageManager.ensureGroup(sessionId, clientName) : null;
          const wid = pageManager.newTab(null, { show: false, group: g ? g.id : undefined });
          pageManager.bindSessionTab(sessionId, wid);
          tabId = wid;
          // 这条提示只出现一次（本连接第一次动手），所以可以写得具体些：
          // 它同时解释了"你拿到了一页空白"和"想看人的页面该怎么做"。
          workspaceNote = {
            tab: wid,
            group: g ? g.label : null,
            created: true,
            hint: 'Your own blank tab. The user\'s visible page was left untouched and is NOT your target — navigate here. To just LOOK at the user\'s page: browse_tabs {op:"list"}, find the tab with group "human", pass its tab explicitly (reading does not take it over).',
          };
        } catch (_) {
          // 建不出来就退回原目标：不能因为"想隔离"反而把这次调用打死。
        }
      }
      try {
        if (!TABLESS_METHODS.has(method) && routingError()) return;
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
              // 这次点击开出了新标签页（target=_blank / window.open）→ 把这个连接的
              // 工作目标挪过去。注意只是**目标**：人眼前的页面由 page_manager 决定
              // （opener 可见时才会真的切过去），后台任务不会被这个跟随顶到前台。
              if (result && result.opened_tab && result.opened_tab.id) {
                pageManager.bindSessionTab(sessionId, result.opened_tab.id);
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
            // hard:true 才做 1px 微调（会让页面重排两次，肉眼可见）。
            // 默认 soft：只 invalidate —— 高频调用不会把窗口刷成幻灯片。
            const r = pageManager.repaint(tabId, { hard: params && params.hard === true });
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
          case 'ui.window_bounds': {
            // 读：窗口 bounds / content bounds / 每个视图实际 bounds（一眼看出视图有没有
            // 跟上窗口）。写：setBounds + 立刻重排 + invalidate，然后回读实际结果。
            // 存在的理由：布局类缺陷（窗口缩放/全屏后内容缩成左上角一小块）此前无法
            // 复现也无法回归 —— 没有任何入口能改窗口尺寸。
            const r = pageManager.windowBounds(params && params.set ? params.set : null);
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
              // deep：扫完 window 之后，再补一层「实例关在闭包里」的模型探测。
              deep: params.deep,
              max_items: params.max_items,
            });
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          case 'ui.app_model': {
            // capabilities 的补集：它扫 window，这里补「实例藏在闭包里」那一类。
            // 两次实测把 A 档站点判成「只能帧指纹」，原因就是少了这一步。
            const r = await pageManager.appModel({
              tab: tabId,
              include_items: params.include_items,
              max_items: params.max_items,
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
            // show 缺省 = **不显示**：人正在看的那一页是人的东西，agent 开一个新
            // 页面不该把它顶掉（多 agent 时更是如此：谁也说不清该顶掉谁）。
            // 例外见 shared/tab_route.cjs 的 shouldShowNewTab：显式 show:true、
            // 或者当前根本没有可见标签页（否则人打开窗口看到一片空白）。
            const show = tabRoute.shouldShowNewTab({
              requested: params.show === undefined ? undefined : params.show === true,
              hasVisible: !!pageManager.activeTab,
              // 人眼前还是启动页 = 还没有"人的页面"可保护，agent 的第一页直接顶上去
              visibleIsStartup: pageManager.activeTab !== null &&
                pageManager.activeTab === pageManager.startupTab,
            });
            // 归属：这一页算谁的。agent 开的页进它自己的组（上限按组算），
            // 人点「+」开的页进 human 组（没有上限）。
            const g = typeof pageManager.ensureGroup === 'function'
              ? pageManager.ensureGroup(sessionId, clientName) : null;
            const groupId = g ? g.id : undefined;
            // 上限：**拒绝**而不是偷偷挤掉一页。挤掉是破坏性的（agent 可能正
            // 在那一页上跑流程），而拒绝是一次必须做的决定 —— 这正是上限存在
            // 的目的：逼 agent 把没用的页关掉，而不是无限开。
            //
            // 只对**声明过自己是 agent** 的连接生效：裸 WS（e2e / 脚本 / 调试）
            // 不受限，否则那些一次性开二十个标签的回归套件会突然开始报 group-full。
            const cap = (isAgentConn && g && typeof pageManager.canOpenInGroup === 'function')
              ? pageManager.canOpenInGroup(groupId) : { allowed: true };
            if (!cap.allowed) {
              const open = typeof pageManager.tabsInGroup === 'function'
                ? pageManager.tabsInGroup(groupId) : [];
              send({
                jsonrpc: '2.0', id,
                error: {
                  code: -32001,
                  message: `your tab group is full (${cap.count}/${cap.limit}) — close one before opening another`,
                  data: {
                    reason: 'group-full',
                    group: g.label, limit: cap.limit, count: cap.count,
                    tabs: open.map((t) => ({ tab: t.id, url: t.url })),
                    hint: 'browse_tabs {op:"close", tab:<id>} on one you no longer need',
                  },
                },
              });
              break;
            }
            const newTabId = pageManager.newTab(params.url || null, { show, group: groupId });
            // 新标签页立刻成为**这个连接的**工作目标（不影响别的连接、也不影响人）。
            if (typeof pageManager.bindSessionTab === 'function') pageManager.bindSessionTab(sessionId, newTabId);
            send({ jsonrpc: '2.0', id, result: { tab: newTabId, shown: show, group: g ? g.label : null } });
            break;
          }
          case 'ui.close_tab': {
            const target = params.tab !== undefined && params.tab !== null ? params.tab : tabId;
            const ok = pageManager.closeTab(target);
            // **只有自己关掉自己那个页**才解绑：那是一次明确的"我不用它了"，
            // 之后的调用照浏览器惯例落到当前可见页。
            // 别人的页被关掉时绑定要留着 —— 下一次调用必须明确报"你的页没了"，
            // 否则 agent 会在**另一个 agent 的页面**上继续执行，回执还是 success。
            if (ok && typeof pageManager.sessionTabOf === 'function' &&
                pageManager.sessionTabOf(sessionId) === target) {
              pageManager.bindSessionTab(sessionId, null);
            }
            send({ jsonrpc: '2.0', id, result: { ok, tab: target } });
            break;
          }
          case 'ui.list_tabs': {
            const tabs = pageManager.listTabs();
            // mine：只在自己那一条上出现（不加的人拿不到这个字段，省 token）。
            // 多 agent 时"我在哪个标签页上"必须能问出来，否则 agent 只能靠猜。
            const mine = typeof pageManager.sessionTabOf === 'function' ? pageManager.sessionTabOf(sessionId) : null;
            if (mine !== null && mine !== undefined) {
              for (const t of tabs) if (t.id === mine) t.mine = true;
            }
            // groups：每组的页数与上限。agent 要能**事先**知道自己还有几个名额，
            // 而不是撞到 group-full 才知道 —— 那时代码已经写到一半了。
            const groups = typeof pageManager.listGroups === 'function' ? pageManager.listGroups() : [];
            // evicted：被上限挤掉（只可能是页面自己弹窗撑爆的时候）的页，
            // 回采一次就清空 —— 不说的话 agent 会以为那一页"自己消失了"。
            const evicted = Array.isArray(pageManager.evictions) ? pageManager.evictions.splice(0) : [];
            send({
              jsonrpc: '2.0', id,
              result: {
                tabs,
                ...(groups.length ? {
                  groups: groups.map((g) => ({
                    id: g.id, label: g.label, count: g.count,
                    // limit 只对受约束的组有意义；不限量的组别报一个假的 8
                    limit: g.capped === true ? g.limit : null,
                    ...(g.id === tabGroup.groupIdForSession(sessionId) ? { mine: true } : {}),
                  })),
                } : {}),
                ...(evicted.length ? { evicted } : {}),
              },
            });
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
            // 语义：把这个会话的工作目标换成 params.tab，并（默认）把它显示出来。
            // show:false = "我只想换目标，别动人眼前的页面"。
            //
            // tab 不存在时回 `{ok:false, error:'no-such-tab'}`（**不是** JSON-RPC error）：
            // 这是"这一次切换没成功"，不是"这次调用本身不合法"，调用方要能用同一个
            // 回执通道区分它和"路由崩了"。契约由 test_ws_handlers 的 TAB-2 钉住。
            const target = params.tab;
            const exists = target !== undefined && target !== null &&
              pageManager.tabs && typeof pageManager.tabs.has === 'function' && pageManager.tabs.has(target);
            // 回执形状是 2026-10-19 那次事故的回归点（agent 曾收到 `{}`）：
            // 成功就回 `{ok:true}`，多余字段一个都不加 —— 只有调用方显式要
            // `show:false`（新语义）时才多一个 `shown`。
            if (!exists && pageManager.tabs && typeof pageManager.tabs.has === 'function') {
              send({ jsonrpc: '2.0', id, result: { ok: false, error: 'no-such-tab', tab: target } });
              break;
            }
            if (!exists) {
              // 没有 tabs 能力的调用方（单测 mock）：按老契约让 setActive 自己回
              const okMock = typeof pageManager.setActive === 'function' ? pageManager.setActive(target) : false;
              send({ jsonrpc: '2.0', id, result: okMock
                ? (params.show === false ? { ok: true, shown: false } : { ok: true })
                : { ok: false, error: 'no-such-tab' } });
              break;
            }
            if (typeof pageManager.bindSessionTab === 'function') pageManager.bindSessionTab(sessionId, target);
            const ok = params.show === false ? true : pageManager.setActive(target);
            send({ jsonrpc: '2.0', id, result: ok
              ? (params.show === false ? { ok: true, shown: false } : { ok: true })
              : { ok: false, error: 'no-such-tab', tab: target } });
            break;
          }
          // 窗口可见性 / 最小化。后台运行（无头式无人值守）的唯一开关，
          // 详见 page_manager.windowState 的注释。
          case 'ui.window': {
            if (typeof pageManager.windowState !== 'function') {
              send({ jsonrpc: '2.0', id, result: { ok: false, error: 'window control not available (no Electron window)' } });
              break;
            }
            let r;
            if (params.visible !== undefined) r = pageManager.setWindowVisible(params.visible === true, { focus: params.focus === true });
            else if (params.minimized !== undefined) r = await pageManager.setWindowMinimized(params.minimized === true);
            else r = pageManager.windowState();
            send({ jsonrpc: '2.0', id, result: r });
            break;
          }
          // 服务端的进程身份。存在的理由（2026-10-15 实测）：调用方**无法确认
          // 自己连上的是不是自己拉起的那个实例**。决定性实验——在"端口忙"预检
          // 之后让一个冒牌 WS server 抢占端口，e2e 套件照常发出 ui.new_tab /
          // ui.evaluate / ui.get_tree 却毫不知情：测的是别人的实例，结果毫无
          // 意义，而且不报错，只给出一堆莫名其妙的失败。
          // 有了 pid，调用方就能核对"是不是我 spawn 的那个进程"。
          // 自报家门的"请求"写法（带 id）：报完立刻回执，调用方好确认身份已生效。
          case 'ui.hello': {
            send({ jsonrpc: '2.0', id, result: applyHello(params) });
            break;
          }
          case 'ui.server_info': {
            send({
              jsonrpc: '2.0', id,
              result: {
                pid: process.pid,
                // 进程启动时刻（秒）。pid 可被复用，两个数字一起才够稳。
                started_at: serverStartedAt,
                ws_port: port,
                platform: process.platform,
                // 渲染路径：{gpu:true|false, reason:'default'|'env'|'fallback'}。
                // 白屏/缩放类缺陷的复现与"这条路有没有关系"都要靠它。
                ...(pageManager.renderPath ? { render_path: pageManager.renderPath } : {}),
                // 窗口状态：后台运行时要能问到"现在到底是不是隐藏的"，否则
                // "我没看到窗口却以为它在显示"这类问题只能靠猜。
                ...(pageManager.windowState ? { window: pageManager.windowState() } : {}),
                // 应用图标：source 表明这次 Dock 图标来自 bundle 的 icns 还是运行时
                // dock.setIcon（源码启动）。content_ratio 是实际设进去那张图的内容
                // 占比 —— macOS 的图标网格约 0.867；两条路径不一致就会"一会大一会
                // 小"，所以这里要能直接判定，而不是靠肉眼比。
                ...(pageManager.appIcon ? { icon: pageManager.appIcon } : {}),
                // 这个连接的工作标签页（多 agent 时用来核对自己绑到了哪一页）
                ...(pageManager.sessionTabOf ? { session_tab: pageManager.sessionTabOf(sessionId) } : {}),
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
          // === ui.download — 把当前页存进下载目录 ===
          // 用于"这一页本来就是一张图片/视频/PDF，我想留下文件"：
          // 浏览器把它显示出来了（见 shared/media_doc.cjs），但"要文件"这条路
          // 不能因此消失。工具条上那个「下载」按钮走的就是同一个实现。
          case 'ui.download': {
            const r = pageManager.downloadCurrent(tabId);
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
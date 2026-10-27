// preload/bridge.cjs — AI Browser entry (CommonJS, loaded by Electron preload)
// v6.9, split into modules: extractor.cjs / actions.cjs / watcher.cjs
// Responsible only for: IPC wiring + module orchestration.
// Requires local .cjs modules — the tab BrowserView MUST set sandbox:false
// (see page_manager.newTab) since a sandboxed preload can only require
// Electron's whitelist, not arbitrary local files.
const { contextBridge, ipcRenderer } = require("electron");
const { extractTree, extractPageContext } = require("./extractor.cjs");
const { executeAction } = require("./actions.cjs");
const { startTracking } = require("./watcher.cjs");

// Watch event → push to main via IPC
function sendEvent(event, data) {
  ipcRenderer.send("ai:event", { event: event, data: data || {} });
}

// ============================================================
// IPC EXPOSURE
// ============================================================

contextBridge.exposeInMainWorld("__ai_browser__", {
  sendTree: function(tree) { ipcRenderer.send("ai:tree", tree); },
  sendDiff: function(changes) { ipcRenderer.send("ai:diff", changes); },
  // window.open 垫片的桥（主 world 侧脚本见 main/window_open_shim_source.js）。
  // contextIsolation 下 preload 改不了页面的 window.open（那是 isolated
  // world 的 window），所以垫片本体由 CDP 注入进主 world，只把这一个
  // 出口经 contextBridge 暴露给它。
  // ⚠️ arity 必须固定为 4：contextBridge 两岸参数数量不一致时调用会抛错
  // （实测：垫片少传一个参数 → 抛错被 catch 吞掉 → window.open 静默返回
  // null，站点拿到的还是"弹窗被拦"的老症状）。垫片侧所有调用都传满 4 个。
  windowOpenBridge: function(op, token, url, name) {
    if (op === 'open') ipcRenderer.send('ai:window_open', { token: token, url: url, name: name || '' });
    else if (op === 'nav') ipcRenderer.send('ai:window_open_nav', { token: token, url: url });
    else if (op === 'close') ipcRenderer.send('ai:window_open_close', { token: token });
  },
  // 我们自己的界面页（renderer/download.html）用的最小通道：
  // 查这条下载的进度、打开文件、在 Finder 中显示。
  // ⚠️ 但它挂在**每个**标签页的 window 上（包括站点页面），所以主进程侧必须
  // 校验 sender 的 URL 是不是自家 renderer 页面 —— 见 index.js 的 isChromeSender。
  // 站点页面即使调到这里，也只会拿到 {found:false}。
  dl: {
    record: function() { return ipcRenderer.invoke('dl:record'); },
    open: function(p) { ipcRenderer.send('dl:open', p); },
    reveal: function(p) { ipcRenderer.send('dl:reveal', p); }
  }
});

// Extract tree request — echo back the request id so the main process can
// match this response to the caller (concurrent requests / multi-tab safe).
ipcRenderer.on("ai:extract", function(_event, params) {
  params = params || {};
  var id = params.id;
  try {
    var tree = extractTree();
    var ctx = extractPageContext();
    ipcRenderer.send("ai:tree", { tree: tree, context: ctx, id: id });
  } catch(e) {
    console.error("[bridge] extractTree crash:", e.message, e.stack);
    // 兜底必须**声明自己是兜底**。
    // 旧实现只把异常文本塞进一个节点的 label 就当树返回了：调用方看到一张
    // "只有一个节点、没有可操作元素"的页面，无从判断是"页面本来就空"还是
    // "我们没读成"。2026-10-19 实测在 about:blank 上就踩到了（document.cookie
    // 在 opaque origin 抛 SecurityError），而那一刻 page_coverage 也只能给
    // null —— 又一个"失败"和"没内容"长得一样的例子。
    // 现在 read_ok/read_error 显式写进 context，main 侧会保留它。
    ipcRenderer.send("ai:tree", {
      tree: { id: "root", role: "generic", label: "[error: " + e.message + "]", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } },
      context: { modals: [], forms: [], session: {}, auth_wall: null, stats: {}, read_ok: false, read_error: String(e && e.message || e) },
      id: id
    });
  }
});

// Context-only request — 登录态 / 登录墙自查用（ui.auth_state）。
// 只回 context，不建整棵树：长任务里每个关键步骤前都要问一次，建树的成本
// （以及它带来的 token 成本）在这里纯属浪费。
ipcRenderer.on("ai:context", function(_event, params) {
  params = params || {};
  var id = params.id;
  try {
    var ctx = extractPageContext();
    ipcRenderer.send("ai:tree", { tree: null, context: ctx, id: id });
  } catch(e) {
    ipcRenderer.send("ai:tree", {
      tree: null,
      context: { modals: [], forms: [], session: {}, auth_wall: null, stats: {}, read_ok: false, read_error: String(e && e.message || e) },
      id: id
    });
  }
});

// Action request
ipcRenderer.on("ai:action", function(_event, data) {
  data = data || {};
  var result = executeAction(data.target, data.action, data.params);
  result.id = data.id;
  ipcRenderer.send("ai:action_result", result);
});

// Evaluate request — run arbitrary JS in page context
ipcRenderer.on("ai:evaluate", function(_event, data) {
  data = data || {};
  try {
    var result = eval(data.js);
    // awaitPromise 的 preload 侧对应物：CDP 路径会等 Promise，这条老路径原先
    // 不等，于是 async IIFE 原样把 Promise 发回去，调用方看到 {}。页面里
    // "等一个请求再返回"的探测脚本因此全变成空回执。thenable 才等，普通值
    // 同步返回（不引入额外延迟）。
    if (result && typeof result.then === "function") {
      result.then(function(v) {
        ipcRenderer.send("ai:evaluate_result", { value: v, id: data.id });
      }, function(e) {
        ipcRenderer.send("ai:evaluate_result", { error: e && e.message ? e.message : String(e), id: data.id });
      });
      return;
    }
    ipcRenderer.send("ai:evaluate_result", { value: result, id: data.id });
  } catch(e) {
    ipcRenderer.send("ai:evaluate_result", { error: e.message, id: data.id });
  }
});

// Start watchers only after page is fully loaded.
// Observing during DOM construction causes massive mutation queues that block
// the renderer (each flush runs expensive querySelectorAll via scanCaptcha/scanMessages).
function startWatchers() {
  startTracking({ onEvent: sendEvent });
}
if (document.readyState === "complete") {
  setTimeout(startWatchers, 100);
} else {
  window.addEventListener("load", function() { setTimeout(startWatchers, 100); });
}
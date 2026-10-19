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
  // world 的 window），所以垫片本体由 CDP 注入进主 world，只把这三个
  // fire-and-forget 的出口经 contextBridge 暴露给它。
  windowOpen: function(token, url, name) {
    ipcRenderer.send("ai:window_open", { token: token, url: url, name: name || "" });
  },
  windowOpenNav: function(token, url) {
    ipcRenderer.send("ai:window_open_nav", { token: token, url: url });
  },
  windowOpenClose: function(token) {
    ipcRenderer.send("ai:window_open_close", { token: token });
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
    // Return empty fallback
    ipcRenderer.send("ai:tree", {
      tree: { id: "root", role: "generic", label: "[error: " + e.message + "]", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } },
      context: { modals: [], forms: [], session: {}, auth_wall: null, stats: {} },
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
      context: { modals: [], forms: [], session: {}, auth_wall: null, stats: {} },
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
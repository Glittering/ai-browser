// preload/bridge.js — AI Browser entry (CommonJS, loaded by Electron preload)
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
  sendDiff: function(changes) { ipcRenderer.send("ai:diff", changes); }
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
      context: { modals: [], forms: [], session: {}, stats: {} },
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
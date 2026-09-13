// preload/watcher.cjs — Mutation/state/captcha/message/JS-error watchers (CommonJS)
// Split out of bridge.js v6.9. No Electron dependency — side effects are
// emitted through an injected `onEvent(eventType, data)` callback so the
// module can be unit-tested under jsdom (bridge.js passes ipcRenderer.send).
// Exports: startTracking(callbacks), stopTracking()

// ============================================================
// 4. CAPTCHA + MESSAGE WATCHERS
// ============================================================

var observer = null;
var lastCaptchaSig = "";
var lastMessageSig = "";
var mutationQueue = [];
var mutationFlushTimer = null;
var scanTimer = null;
var MUTATION_FLUSH_DELAY = 500;
var SCAN_INTERVAL = 5000;

function scanCaptcha() {
  var byCSS = document.querySelectorAll("[class*=captcha],[class*=verify],[class*=slider],[class*=slide],[class*=drag],[id*=captcha],[id*=verify],[class*=JDJRV],[class*=geetest],[class*=yidun],[class*=small-jd]");
  var byAlt = document.querySelectorAll("img[alt*=验证码],img[alt*=captcha],img[alt*=verify],img[alt*=滑块],img[alt*=slide]");
  var all = [];
  for (var bi = 0; bi < byCSS.length; bi++) all.push(byCSS[bi]);
  for (var ai = 0; ai < byAlt.length; ai++) { if (all.indexOf(byAlt[ai]) < 0) all.push(byAlt[ai]); }

  var visible = [];
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect();
    if (r.width >= 0 || r.height >= 0) {
      visible.push({
        tag: all[i].tagName,
        cls: String(all[i].className || "").slice(0, 80),
        id: all[i].id || "",
        text: String(all[i].textContent || "").trim().slice(0, 50),
        bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      });
    }
  }

  // Also scan for canvases in captcha areas
  var canvases = document.querySelectorAll("canvas");
  for (var ci = 0; ci < canvases.length; ci++) {
    var cr = canvases[ci].getBoundingClientRect();
    if (cr.width > 10 && cr.height > 10) {
      // Check if canvas is inside a captcha-like container
      var parent = canvases[ci].parentElement;
      var pCls = (parent && parent.className || "") + (parent && parent.id || "");
      if (/captcha|verify|slider|slide|drag|yidun|geetest/i.test(pCls)) {
        visible.push({
          tag: "CANVAS",
          cls: (canvases[ci].className || "").slice(0, 40),
          id: canvases[ci].id || "",
          text: "[canvas captcha]",
          bounds: { x: Math.round(cr.x), y: Math.round(cr.y), width: Math.round(cr.width), height: Math.round(cr.height) },
          parent_cls: pCls.slice(0, 60)
        });
      }
    }
  }

  return visible;
}

function scanMessages() {
  var selectors = [
    "[class*=toast]", "[class*=message]", "[class*=notification]", "[class*=alert]",
    "[class*=snackbar]", "[class*=notice]", "[class*=tip]",
    "[role=alert]", "[role=status]", "[class*=banner]"
  ];
  var msgs = [];
  for (var si = 0; si < selectors.length; si++) {
    var els = document.querySelectorAll(selectors[si]);
    for (var ei = 0; ei < els.length; ei++) {
      if (els[ei].offsetParent === null && window.getComputedStyle(els[ei]).display === "none") continue;
      var r = els[ei].getBoundingClientRect();
      var t = (els[ei].textContent || "").trim();
      if (t && t.length < 200) {
        msgs.push({ text: t.slice(0, 100), bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
      }
    }
  }
  return msgs;
}

function runScan(emit) {
  scanTimer = null;
  var cap = scanCaptcha();
  if (cap.length > 0) {
    var sig = JSON.stringify(cap.map(function(c) { return c.cls + "|" + c.bounds.width + "x" + c.bounds.height; }));
    if (sig !== lastCaptchaSig) {
      lastCaptchaSig = sig;
      emit("captcha_appeared", { elements: cap });
    }
  }
  var msg = scanMessages();
  if (msg.length > 0) {
    var msig = JSON.stringify(msg.map(function(m) { return m.text; }));
    if (msig !== lastMessageSig) {
      lastMessageSig = msig;
      emit("message_appeared", { messages: msg });
    }
  }
}

function flushMutations(emit) {
  mutationFlushTimer = null;
  var mutations = mutationQueue;
  mutationQueue = [];
  if (mutations.length === 0) return;

  var stateChanges = [];

  for (var mi = 0; mi < mutations.length; mi++) {
    var m = mutations[mi];

    if (m.type === "attributes") {
      var attrName = (m.attributeName || "").toLowerCase();
      var trackedAttrs = ["disabled", "class", "open", "checked", "aria-expanded", "aria-selected", "hidden", "value", "readonly"];
      if (trackedAttrs.indexOf(attrName) >= 0) {
        var el = m.target;
        if (el instanceof HTMLElement) {
          var aiId = el.getAttribute("data-ai-id");
          if (aiId) {
            stateChanges.push({
              type: "state_changed",
              targetId: aiId,
              attribute: attrName,
              value: el.getAttribute(attrName)
            });
          }
        }
      }
    }

    if (m.type === "childList") {
      var parentId = m.target instanceof HTMLElement ? m.target.getAttribute("data-ai-id") : null;
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        stateChanges.push({
          type: "dom_changed",
          parentId: parentId,
          added: m.addedNodes.length,
          removed: m.removedNodes.length
        });
      }
    }
  }

  if (stateChanges.length > 0) {
    var batch = [];
    for (var si = 0; si < Math.min(stateChanges.length, 20); si++) batch.push(stateChanges[si]);
    emit("state_changed", { changes: batch });
  }
}

function bindObserver(emit) {
  if (observer) observer.disconnect();
  mutationQueue = [];
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = null;
  }
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  observer = new MutationObserver(function(mutations) {
    mutationQueue.push.apply(mutationQueue, mutations);
    if (!mutationFlushTimer) {
      mutationFlushTimer = setTimeout(function() { flushMutations(emit); }, MUTATION_FLUSH_DELAY);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "class", "open", "checked", "aria-expanded", "aria-selected", "hidden", "value", "readonly"]
  });

  // Captcha/message scan runs on its own low-frequency timer to avoid
  // blocking the renderer with querySelectorAll during page load.
  scanTimer = setInterval(function() { runScan(emit); }, SCAN_INTERVAL);
  setTimeout(function() { runScan(emit); }, 1000);
}

// ============================================================
// JS error capture
// ============================================================

var oldOnError = null;

function hookJsErrors(emit) {
  oldOnError = window.onerror;
  window.onerror = function(msg, url, line, col, err) {
    emit("js_error", { message: String(msg), url: String(url), line: line, col: col, stack: (err && err.stack ? String(err.stack).slice(0, 300) : "") });
    if (oldOnError) return oldOnError.apply(this, arguments);
    return false;
  };

  window.addEventListener("unhandledrejection", function(ev) {
    var reason = ev.reason;
    var msg = reason instanceof Error ? reason.message : String(reason);
    emit("js_error", { message: msg, type: "unhandledrejection", stack: (reason instanceof Error && reason.stack ? String(reason.stack).slice(0, 300) : "") });
  });
}

// ============================================================
// Public API
// ============================================================

function startTracking(callbacks) {
  callbacks = callbacks || {};
  function nullEmit() {}
  var emit = typeof callbacks.onEvent === "function" ? callbacks.onEvent : nullEmit;
  bindObserver(emit);
  hookJsErrors(emit);
}

function stopTracking() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  mutationQueue = [];
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = null;
  }
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (oldOnError !== null) {
    window.onerror = oldOnError;
    oldOnError = null;
  }
}

module.exports = { startTracking, stopTracking };
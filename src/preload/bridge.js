// preload/bridge.js — AI Browser v6 (Linus-grade: one file, zero fat, full coverage)
// CommonJS for Electron preload sandbox.
// Replaces: semantic_extractor.js + action_binder.js + state_tracker.js → inlined.
const { contextBridge, ipcRenderer } = require("electron");

// ============================================================
// 1. EXTRACT TREE — DOM → semantic tree with bounds + states
// ============================================================

function extractTree() {
  var seen = new WeakSet();
  var counter = 0;

  function isHidden(el) {
    if (!(el instanceof HTMLElement)) return true;
    var tag = el.tagName.toLowerCase();
    if (tag === "dialog") return false;
    var style = window.getComputedStyle(el);
    if (style.display === "none") return true;
    if (style.visibility === "hidden") return true;
    if (el.hasAttribute("aria-hidden") && el.getAttribute("aria-hidden") === "true") return true;
    if (el.hidden === true) return true;
    var p = el.parentElement;
    while (p && p !== document.body) {
      if (p.hidden === true) return true;
      if (p.hasAttribute("aria-hidden") && p.getAttribute("aria-hidden") === "true") return true;
      var ps = window.getComputedStyle(p);
      if (ps.display === "none") return true;
      p = p.parentElement;
    }
    return false;
  }

  function isPureLayout(el) {
    if (!(el instanceof HTMLElement)) return false;
    var tag = el.tagName.toLowerCase();
    if (tag !== "div" && tag !== "span") return false;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return false;
    var cls = (el.className || "").toLowerCase();
    if (cls.indexOf("codemirror") >= 0 || cls.indexOf("prosemirror") >= 0 || cls.indexOf("monaco") >= 0) return false;
    if (el.hasAttribute("role")) return false;
    if (typeof el.onclick === "function") return false;
    var hasAria = false;
    try { var attrs = el.attributes; for (var ai = 0; ai < attrs.length; ai++) { if (attrs[ai].name.indexOf("aria-") === 0) { hasAria = true; break; } } } catch(e) {}
    if (hasAria) return false;
    // Check if any child is semantic — if so, keep as container
    var children = el.children;
    for (var ci = 0; ci < children.length; ci++) {
      if (children[ci].tagName && INTERACTIVE_TAGS.indexOf(children[ci].tagName.toLowerCase()) >= 0) return false;
      if (children[ci].hasAttribute && children[ci].hasAttribute("role")) return false;
    }
    return true;
  }

  var INTERACTIVE_TAGS = [
    "a","button","input","select","textarea","option","details","dialog",
    "summary","video","audio","canvas","svg","img",
    "table","ul","ol","li","h1","h2","h3","h4","h5","h6","p","label","form",
    "nav","main","header","footer","section","article","aside"
  ];

  function isSemantic(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (isHidden(el)) return false;
    var tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.indexOf(tag) >= 0) return true;
    if (el.hasAttribute("role")) return true;
    if (typeof el.onclick === "function") return true;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return true;
    if (isPureLayout(el)) return false;
    if (tag === "div" || tag === "span") return false;
    // Non-interactive/non-visible tags — never semantic
    var EXCLUDED_TAGS = ["script", "link", "style", "meta", "noscript", "br", "wbr", "param", "source", "track"];
    if (EXCLUDED_TAGS.indexOf(tag) >= 0) return false;
    return true;
  }

  function inferRole(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range" || type === "number") return "slider";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "select";
    if (tag === "a" && (el.hasAttribute("href") || typeof el.onclick === "function")) return "link";
    if (tag === "details" || tag === "summary") return "button";
    if (tag === "dialog") return "dialog";
    if (tag === "option") return "option";
    if (tag === "img") return "image";
    if (tag === "canvas") return "canvas";
    var ariaRole = (el.getAttribute("role") || "").toLowerCase();
    if (ariaRole) return ariaRole;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return "textbox";
    if (typeof el.onclick === "function") return "button";
    return "generic";
  }

  function extractActions(el, role) {
    switch (role) {
      case "button": case "link": return ["click", "focus", "hover"];
      case "textbox": return ["type", "setContent", "clear", "focus"];
      case "select": return ["select", "focus"];
      case "slider": return ["scroll_to", "focus"];
      case "checkbox": case "radio": return ["click", "focus"];
      case "dialog": return ["open", "close"];
      default: return [];
    }
  }

  function detectEditorType(el) {
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return "contenteditable";
    var cls = (el.className || "").toLowerCase();
    if (cls.indexOf("codemirror") >= 0) return "codemirror";
    if (cls.indexOf("prosemirror") >= 0 || (el.querySelector && el.querySelector("[class*=ProseMirror]"))) return "prosemirror";
    if (cls.indexOf("monaco") >= 0) return "monaco";
    if (cls.indexOf("ql-editor") >= 0) return "quill";
    if (cls.indexOf("draft") >= 0 || (el.querySelector && el.querySelector(".public-DraftEditor-content"))) return "draft";
    // Also check parent for Draft.js (DraftEditor-content is nested)
    if (el.querySelector && el.querySelector("[class*=DraftEditor]")) return "draft";
    if (el.tagName.toLowerCase() === "textarea") return "textarea";
    return null;
  }

  function extractLabel(el) {
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;
    var title = el.getAttribute("title");
    if (title) return title;
    var text = (el.textContent || "").trim();
    if (text.length > 60) text = text.slice(0, 60);
    if (text) return text;
    var placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder;
    return "";
  }

  function extractBounds(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    } catch(e) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  function extractAttributes(el) {
    var attrs = {};
    try {
      for (var ai = 0; ai < el.attributes.length; ai++) {
        var a = el.attributes[ai];
        if (a.name === "data-ai-id") continue;
        if (a.name.indexOf("data-") === 0 || a.name.indexOf("aria-") === 0 || a.name === "name" || a.name === "id" || a.name === "class") {
          attrs[a.name] = a.value;
        }
      }
    } catch(e) {}
    return attrs;
  }

  function process(el) {
    if (seen.has(el)) return null;
    seen.add(el);
    if (!el.isConnected) return null;
    var tag = el.tagName.toLowerCase();
    if (!isSemantic(el)) {
      var elChildren = el.children;
      if (elChildren && elChildren.length > 0) {
        var results = [];
        for (var ci = 0; ci < elChildren.length; ci++) {
          var childNode = process(elChildren[ci]);
          if (childNode) {
            if (Array.isArray(childNode)) results.push.apply(results, childNode);
            else results.push(childNode);
          }
        }
        return results.length ? results : null;
      }
      return null;
    }

    var label = extractLabel(el);
    var role = inferRole(el);
    var actions = extractActions(el, role);
    var bounds = extractBounds(el);
    var attributes = extractAttributes(el);
    var nativeId = el.id || "";
    var editorType = detectEditorType(el);

    // Assign ref ID — use native id, fallback to generated
    var aiId = nativeId || "e:" + el.tagName.toLowerCase() + "-" + (counter++);
    el.setAttribute("data-ai-id", aiId);

    var states = [];
    if (el.disabled === true) states.push("disabled");
    if (el.readOnly === true) states.push("readonly");
    if (el.checked === true) states.push("checked");
    if (el === document.activeElement) states.push("focused");
    if (!isHidden(el)) states.push("visible");

    var node = {
      id: aiId,
      role: role,
      label: label,
      states: states.length ? states : undefined,
      actions: actions,
      bounds: bounds
    };
    if (Object.keys(attributes).length) node.attributes = attributes;
    if (editorType) node.editor_type = editorType;

    // Children — including iframe content if same-origin
    var elChildren = el.children;
    var childNodes = [];

    // Recurse into same-origin iframes
    if (tag === "iframe") {
      try {
        var iframeDoc = el.contentDocument || el.contentWindow.document;
        if (iframeDoc && iframeDoc.body) {
          var iframeBody = process(iframeDoc.body);
          if (iframeBody) childNodes.push({ id: "iframe-" + (el.id || counter), role: "iframe_body", label: (el.title || el.name || "iframe content"), children: iframeBody.children || [iframeBody] });
        }
      } catch(e) { /* cross-origin */ }
    }

    if (elChildren && elChildren.length) {
      for (var ci = 0; ci < elChildren.length; ci++) {
        var childNode = process(elChildren[ci]);
        if (childNode) {
          if (Array.isArray(childNode)) childNodes.push.apply(childNodes, childNode);
          else childNodes.push(childNode);
        }
      }
    }

    if (childNodes.length) node.children = childNodes;

    return node;
  }

  var root = process(document.body);
  if (!root) {
    return { id: "root", role: "generic", label: "", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }
  return root;
}

// ============================================================
// 2. EXTRACT PAGE CONTEXT — modals, forms, iframes, session
// ============================================================

function extractPageContext() {
  // MODALS — unified search across ALL patterns
  var modalSelectors = [
    "[class*=modal]", "[class*=dialog]", "[class*=popup]", "[class*=drawer]", "[class*=overlay]", "[class*=mask]",
    "[role=dialog]", "[role=alertdialog]"
  ];
  var modals = [];
  for (var si = 0; si < modalSelectors.length; si++) {
    var els = document.querySelectorAll(modalSelectors[si]);
    for (var ei = 0; ei < els.length; ei++) {
      var m = els[ei];
      if (m.offsetParent === null) continue;
      var btns = m.querySelectorAll("button,input[type=submit]");
      var inps = m.querySelectorAll("input:not([type=hidden]),textarea,select");
      if (btns.length === 0 && inps.length === 0) continue;

      var btnList = [];
      for (var bi = 0; bi < btns.length; bi++) {
        var t = (btns[bi].textContent || btns[bi].value || "").trim();
        if (!t) continue;
        btnList.push({ text: t.slice(0, 30), disabled: btns[bi].disabled || false });
      }

      var fieldList = [];
      for (var fi = 0; fi < inps.length; fi++) {
        fieldList.push({
          type: inps[fi].type || inps[fi].tagName.toLowerCase(),
          placeholder: (inps[fi].placeholder || "").slice(0, 40),
          required: inps[fi].required || false
        });
      }

      // Errors — 14 selectors + key phrase scan
      var errSel = ["[class*=error]","[class*=err]","[class*=invalid]","[class*=toast]","[class*=message]",
        "[class*=notification]","[class*=alert]","[class*=warning]","[class*=fail]","[class*=tip]",
        "[role=alert]","[role=status]","[class*=notice]","[class*=snackbar]"];
      var errors = [];
      for (var esi = 0; esi < errSel.length; esi++) {
        var errEls = m.querySelectorAll(errSel[esi]);
        for (var eei = 0; eei < errEls.length; eei++) {
          var et = (errEls[eei].textContent || "").trim();
          if (et && et.length < 200 && errors.indexOf(et) < 0) errors.push(et);
        }
      }
      // Key phrase scan
      var mText = m.innerText || "";
      var phrases = ["不存在","失败","错误","不能为空","请选择","请填写","not found","failed","error","required","cannot be empty","博主","验证","字数"];
      for (var pi = 0; pi < phrases.length; pi++) {
        var idx = mText.indexOf(phrases[pi]);
        if (idx >= 0) {
          var snippet = mText.slice(Math.max(0, idx - 10), idx + phrases[pi].length + 40);
          if (errors.indexOf(snippet) < 0) errors.push(snippet);
        }
      }

      // Required hints — character limits + Chinese hints + red star markers
      var required = [];
      // CSS required markers
      var reqEls = m.querySelectorAll("[class*=required],[class*=req],[class*=mandatory],[class*=asterisk]");
      for (var ri = 0; ri < reqEls.length; ri++) {
        var rt = (reqEls[ri].textContent || "").trim();
        if (rt && rt.length < 30 && required.indexOf(rt) < 0) required.push(rt);
      }
      // Character limits: N/M patterns
      var mTextForReq = m.innerText || "";
      var lines = mTextForReq.split("\n");
      for (var li = 0; li < lines.length; li++) {
        var rm = lines[li].match(/(\d+)\s*\/\s*(\d+)/);
        if (rm) { var t2 = lines[li].trim().slice(0, 50); if (required.indexOf(t2) < 0) required.push(t2); }
        if (/字数/.test(lines[li])) { var t3 = lines[li].trim().slice(0, 50); if (required.indexOf(t3) < 0) required.push(t3); }
      }
      // Chinese hints
      var hintMatch = mTextForReq.match(/请\s*[选择填写输入].{0,20}/g);
      if (hintMatch) {
        for (var hi = 0; hi < hintMatch.length; hi++) {
          var h = hintMatch[hi].trim().slice(0, 30);
          if (required.indexOf(h) < 0) required.push(h);
        }
      }
      // Scan for red * (asterisk character as required marker)
      var redStars = m.querySelectorAll("span,em,i,label,sup");
      for (var rsi = 0; rsi < redStars.length; rsi++) {
        var rsText = (redStars[rsi].textContent || "").trim();
        if (rsText === "*" || rsText === "＊" || rsText === "✱") {
          // Check sibling text
          var parent = redStars[rsi].parentElement;
          if (parent) {
            var sibling = (parent.textContent || "").trim().slice(0, 30).replace(/\*/g, "").trim();
            if (sibling && required.indexOf(sibling) < 0) required.push(sibling);
          }
        }
      }
      // ::before pseudo-element red star — check computed style
      var allInModal = m.querySelectorAll("*");
      var checkedCount = 0;
      for (var ai = 0; ai < allInModal.length && checkedCount < 100; ai++) {
        var el = allInModal[ai];
        try {
          var before = window.getComputedStyle(el, "::before");
          var content = before.getPropertyValue("content");
          if (content && content !== "none" && content !== "normal" && content !== '""' && content !== "''") {
            var color = before.getPropertyValue("color");
            if (color && (color.indexOf("rgb(255") >= 0 || color.indexOf("red") >= 0 || color.indexOf("#f") >= 0 || color.indexOf("#F") >= 0 || color.indexOf("#e") >= 0)) {
              // Red pseudo-element found — likely a red star
              var parentText = (el.textContent || "").trim().slice(0, 30);
              if (parentText && required.indexOf(parentText) < 0) required.push(parentText);
              checkedCount++;
            }
          }
        } catch(e) {}
      }

      modals.push({
        buttons: btnList,
        fields: fieldList,
        errors: errors.length ? errors : null,
        required_hints: required.length ? required : null
      });
    }
  }

  // FORMS
  var forms = document.querySelectorAll("form");
  var formList = [];
  for (var fi = 0; fi < forms.length; fi++) {
    var f = forms[fi];
    if (f.offsetParent === null) continue;
    var inps = f.querySelectorAll("input:not([type=hidden]),textarea,select");
    var fields = [];
    for (var ii = 0; ii < inps.length; ii++) {
      fields.push({
        id: inps[ii].id || inps[ii].name || "",
        type: inps[ii].type || inps[ii].tagName.toLowerCase(),
        placeholder: (inps[ii].placeholder || "").slice(0, 40),
        required: inps[ii].required || false
      });
    }
    if (fields.length) formList.push({ fields: fields });
  }

  // SESSION — more robust detection
  var hasPwdInput = document.querySelector("input[type=password]");
  var bodyText = document.body.innerText || "";
  var isLoginPage = bodyText.indexOf("登录") >= 0 || bodyText.indexOf("Sign In") >= 0 ||
    document.title.indexOf("登录") >= 0 || document.URL.indexOf("login") >= 0 || document.URL.indexOf("signin") >= 0;
  var hasAvatar = document.querySelector("[class*=avatar],img[class*=avatar],img[class*=user]");
  // Cookie-based check
  var hasLoginCookie = document.cookie.indexOf("token") >= 0 || document.cookie.indexOf("session") >= 0
    || document.cookie.indexOf("auth") >= 0;
  var loggedIn = !hasPwdInput && !isLoginPage && (hasAvatar !== null || hasLoginCookie || bodyText.length > 1000);

  return {
    title: document.title,
    url: document.URL,
    forms: formList.length ? formList : null,
    modals: modals.length ? modals : null,
    session: { logged_in: loggedIn },
    stats: {
      inputs: document.querySelectorAll("input:not([type=hidden])").length,
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a[href]").length,
      iframes: document.querySelectorAll("iframe").length
    }
  };
}

// ============================================================
// 3. EXECUTE ACTION — click, type, setContent, select, etc.
// ============================================================

function executeAction(elementId, action, params) {
  params = params || {};
  var el = document.querySelector('[data-ai-id="' + elementId + '"]');
  if (!el) return { success: false, error: "Target not found for ref: " + elementId };

  try {
    switch (action) {
      case "click":
        el.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
        el.click();
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
        return { success: true };

      case "type":
        return doType(el, params.text || "");

      case "setContent":
        return doSetContent(el, params.text || "", params.format || "text");

      case "clear":
        if (el.value !== undefined) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
        if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") el.innerHTML = "";
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };

      case "select":
        if (el.tagName.toLowerCase() !== "select") return { success: false, error: "Not a select element" };
        el.value = params.value || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };

      case "focus":
        el.focus();
        return { success: true };

      case "hover":
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        return { success: true };

      case "scroll_to":
        el.scrollIntoView({ behavior: "instant", block: "center" });
        return { success: true };

      case "submit":
        // Submit parent form
        var form = el.closest("form");
        if (form) { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return { success: true }; }
        return { success: false, error: "No parent form" };

      case "toggle":
        if (el.tagName.toLowerCase() === "details") { el.open = !el.open; return { success: true, state: el.open }; }
        if (el.getAttribute("role") === "switch" || el.type === "checkbox") { el.click(); return { success: true }; }
        return { success: false, error: "Cannot toggle" };

      default:
        return { success: false, error: "Unknown action: " + action };
    }
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// Native value setter for Vue/React inputs
function doType(el, text) {
  var tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && el.contentEditable !== "true" && el.getAttribute("contenteditable") !== "true") {
    // Try contenteditable
    if (el.querySelector && el.querySelector("[contenteditable=true]")) {
      el = el.querySelector("[contenteditable=true]");
    } else {
      return { success: false, error: "Not a text input" };
    }
  }

  if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") {
    // contenteditable — use execCommand
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { success: true };
  }

  // Standard input/textarea — native setter
  var nset = Object.getOwnPropertyDescriptor(
    tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
  ).set;
  nset.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return { success: true, value: el.value.slice(0, 40) };
}

// setContent — write to any editor type including Draft.js/ProseMirror
function doSetContent(el, text, format) {
  var paras = text.split("\n");
  var isEmptyPara = false;

  // 1. Try contenteditable — use execCommand paragraph by paragraph
  var editor = null;
  if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") {
    editor = el;
  } else {
    // Look inside for Draft.js, ProseMirror, CodeMirror editors
    editor = el.querySelector(".public-DraftEditor-content") ||
             el.querySelector("[class*=ProseMirror]") ||
             el.querySelector("[contenteditable=true]") ||
             el.querySelector("[class*=DraftEditor]");
    if (!editor) {
      // Try CodeMirror instance
      var cm = el.querySelector("[class*=CodeMirror]");
      if (cm && cm.CodeMirror) { cm.CodeMirror.setValue(text); return { success: true }; }
    }
  }

  if (!editor) {
    // Fallback: textarea
    var ta = el.querySelector("textarea") || (el.tagName.toLowerCase() === "textarea" ? el : null);
    if (ta) {
      var nset = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      nset.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, chars: ta.value.length };
    }
    return { success: false, error: "No editable element found" };
  }

  // Clear editor first
  editor.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);

  // Insert paragraph by paragraph with Enter key events
  for (var pi = 0; pi < paras.length; pi++) {
    var para = paras[pi];

    // Position cursor at end
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    if (para.length > 0) {
      document.execCommand("insertText", false, para);
    }

    // Insert Enter after each paragraph (except last)
    if (pi < paras.length - 1) {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }

    // Small delay between paragraphs
    var sync = new Date().getTime();
    while (new Date().getTime() - sync < 10) {} // 10ms pause for React sync
  }

  editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));

  // Verify placeholder disappeared
  var innerText = editor.innerText || "";
  if (innerText.indexOf("请输入正文") >= 0) {
    return { success: false, error: "Editor did not register input — placeholder persists" };
  }

  return { success: true, chars: innerText.length, blocks: editor.querySelectorAll ? editor.querySelectorAll("div, p").length : 0 };
}

// ============================================================
// 4. CAPTCHA + MESSAGE WATCHERS
// ============================================================

var observer = null;
var lastCaptchaSig = "";
var lastMessageSig = "";

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

function bindObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(function(mutations) {
    var stateChanges = [];

    for (var mi = 0; mi < mutations.length; mi++) {
      var m = mutations[mi];

      // Captcha detection (deduplicated)
      var cap = scanCaptcha();
      if (cap.length > 0) {
        var sig = JSON.stringify(cap.map(function(c) { return c.cls + "|" + c.bounds.width + "x" + c.bounds.height; }));
        if (sig !== lastCaptchaSig) {
          lastCaptchaSig = sig;
          ipcRenderer.send("ai:event", { event: "captcha_appeared", data: { elements: cap } });
        }
      }

      // Message/toast detection (deduplicated)
      var msg = scanMessages();
      if (msg.length > 0) {
        var msig = JSON.stringify(msg.map(function(m) { return m.text; }));
        if (msig !== lastMessageSig) {
          lastMessageSig = msig;
          ipcRenderer.send("ai:event", { event: "message_appeared", data: { messages: msg } });
        }
      }

      // State changes — disabled, class, open, checked, aria-expanded
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

      // DOM structure changes
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

    // Batch send state changes
    if (stateChanges.length > 0) {
      var batch = [];
      for (var si = 0; si < Math.min(stateChanges.length, 20); si++) batch.push(stateChanges[si]);
      ipcRenderer.send("ai:event", { event: "state_changed", data: { changes: batch } });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "class", "open", "checked", "aria-expanded", "aria-selected", "hidden", "value", "readonly"],
    characterData: true
  });

  // Initial scan
  var initCap = scanCaptcha();
  if (initCap.length > 0) {
    lastCaptchaSig = JSON.stringify(initCap.map(function(c) { return c.cls + "|" + c.bounds.width + "x" + c.bounds.height; }));
    ipcRenderer.send("ai:event", { event: "captcha_appeared", data: { elements: initCap } });
  }
  var initMsg = scanMessages();
  if (initMsg.length > 0) {
    lastMessageSig = JSON.stringify(initMsg.map(function(m) { return m.text; }));
    ipcRenderer.send("ai:event", { event: "message_appeared", data: { messages: initMsg } });
  }
}

// ============================================================
// 5. IPC EXPOSURE
// ============================================================

contextBridge.exposeInMainWorld("__ai_browser__", {
  sendTree: function(tree) { ipcRenderer.send("ai:tree", tree); },
  sendDiff: function(changes) { ipcRenderer.send("ai:diff", changes); }
});

// Extract tree request
ipcRenderer.on("ai:extract", function(_event, params) {
  try {
    var tree = extractTree();
    var ctx = extractPageContext();
    ipcRenderer.send("ai:tree", { tree: tree, context: ctx });
  } catch(e) {
    console.error("[bridge] extractTree crash:", e.message, e.stack);
    // Return empty fallback
    ipcRenderer.send("ai:tree", {
      tree: { id: "root", role: "generic", label: "[error: " + e.message + "]", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } },
      context: { modals: [], forms: [], session: {}, stats: {} }
    });
  }
});

// Action request
ipcRenderer.on("ai:action", function(_event, data) {
  var result = executeAction(data.target, data.action, data.params);
  ipcRenderer.send("ai:action_result", result);
});

// Evaluate request — run arbitrary JS in page context
ipcRenderer.on("ai:evaluate", function(_event, data) {
  try {
    var fn = new Function("return (" + data.js + ")()");
    var result = fn();
    ipcRenderer.send("ai:evaluate_result", { value: result });
  } catch(e) {
    ipcRenderer.send("ai:evaluate_result", { error: e.message });
  }
});

// Start watchers on DOM ready
function startWatchers() {
  bindObserver();
}
if (document.readyState === "complete" || document.readyState === "interactive") {
  startWatchers();
} else {
  document.addEventListener("DOMContentLoaded", function() { setTimeout(startWatchers, 500); });
}
window.addEventListener("load", startWatchers);
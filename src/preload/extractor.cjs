// preload/extractor.cjs — Semantic extraction (CommonJS)
// Split out of bridge.js v6.9. Pure DOM functions, no Electron dependency,
// so it can be unit-tested under jsdom.
// Exports: extractTree(), extractPageContext()
var valueContract = require("../shared/value_contract.cjs");
var truncateNodeValue = valueContract.truncateNodeValue;
var sensitiveInputKind = valueContract.sensitiveInputKind;

// ============================================================
// 1. EXTRACT TREE — DOM → semantic tree with bounds + states
// ============================================================

function extractTree() {
  var seen = new WeakSet();
  var counter = 0;
  var VERSION_TAG = "v6.9";

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
    "nav","main","header","footer","section","article","aside","iframe"
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
      default: return inferContainerActions(el);
    }
  }

  // 容器类节点（group / generic / image …）原先一律返回空动作。但**很多真实可交互
  // 元素恰恰落在这里**：画布节点的 <div>、自定义下拉、可拖卡片。只按 role 判定，
  // agent 就完全看不出它们可点/可拖 —— 实测在 React Flow 工作流编辑器上，66 个
  // 画布节点全是 `role:group, actions:[]`，"选中一个节点"这个最基本的操作因此无从
  // 下手（只能靠试）。
  //
  // 这里改用**行为信号**推断，而不是猜类名（类名是各框架私有的，猜不通用）：
  //   cursor 拽取态 / draggable 属性 → 可拖（并且按下松开即可点选，故同时给 click）
  //   cursor:pointer / 真实 onclick    → 可点
  //   显式 tabindex>=0                → 可 focus
  // 只补充**已有节点**的动作清单，不新增节点，所以不会撑大语义树体积。
  //
  // 刻意**不给推断节点加 hover**：hover 只有在"悬停会揭示东西"时才有意义，而这一点
  // 从行为信号看不出来，加了就是猜。实测加上后 177 个节点里 172 个都报 hover，
  // 纯噪声、白花 token，却什么都没告诉 agent。
  function inferContainerActions(el) {
    var acts = [];
    try {
      var cursor = "";
      try { cursor = (window.getComputedStyle(el).cursor || "").toLowerCase(); } catch (e) {}
      var draggable =
        (el.getAttribute && el.getAttribute("draggable") === "true") ||
        /^(grab|grabbing|move|col-resize|row-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|crosshair)$/.test(cursor);
      var clickable =
        draggable ||
        cursor === "pointer" ||
        (typeof el.onclick === "function") ||
        (el.hasAttribute && el.hasAttribute("data-ai-clickable"));
      var ti = el.getAttribute ? el.getAttribute("tabindex") : null;
      var focusable = ti !== null && ti !== undefined && Number(ti) >= 0;
      if (clickable) acts.push("click");
      if (draggable) acts.push("drag");
      if (focusable) acts.push("focus");
    } catch (e) { /* 推断失败就不给动作 —— 宁可少报，绝不猜一个假动作 */ }
    return acts;
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

  // 富文本块级读取：对任何 contenteditable / 富文本输出段落边界，而非把全文
  // 揉成一段（否则换行被吞、段落结构丢失）。纯结构化，不识别任何编辑器框架：
  // 先定位真正的可编辑元素（contenteditable=true，若自身不是则向下找），
  // 再取其顶层块级子元素；无块时按换行拆分。
  function extractEditorBlocks(editor) {
    try {
      if (!editor) return null;
      var isEditable = editor.contentEditable === 'true' ||
        (editor.getAttribute && editor.getAttribute('contenteditable') === 'true');
      var editable = isEditable
        ? editor
        : (editor.querySelector ? editor.querySelector('[contenteditable=true]') : null) || editor;
      var one = function(b, i) {
        var t = (b.innerText || (b.textContent ? b.textContent : '') || b.value || '').trim();
        if (!t) return null;
        return { i: i, role: 'paragraph', text: t.slice(0, 500) };
      };
      // 通用：取可编辑元素顶层块级子元素（Draft 的 [data-block] 即 DIV，天然覆盖）
      var kids = Array.prototype.slice.call(editable.children || [])
        .filter(function(c) { return /^(P|H1|H2|H3|H4|H5|H6|LI|PRE|BLOCKQUOTE|DIV)$/.test(c.tagName); });
      var items = kids.map(function(c, i) {
        var t = (c.innerText || (c.textContent ? c.textContent : '') || '').trim();
        if (!t) return null;
        return { i: i, role: c.tagName.toLowerCase(), text: t.slice(0, 500) };
      }).filter(Boolean);
      if (items.length === 0) {
        // 无显式块时按换行拆分（textarea 语义）
        var itx = editable.innerText || (editable.textContent ? editable.textContent : '');
        var tx = itx.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
        return tx.map(function(s, i) { return { i: i, role: 'paragraph', text: s.slice(0, 500) }; });
      }
      return items;
    } catch(e) { return null; }
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
    // editor_type 仅作"解读"元数据提示（agent 可读懂这是什么编辑器），
    // 操作路径已不依赖它——CDP 受信输入对任何框架通用。
    var editorType = detectEditorType(el);
    var editorBlocks = editorType ? extractEditorBlocks(el) : null;

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
    // Attach current value for input/textarea/contenteditable.
    // 截断走共享契约（src/shared/value_contract.cjs）：按 Unicode code point
    // 计数，截断时带 value_truncated / value_full_length / value_fetch_ref，
    // 未截断只给 value（不给普通节点加字段）。敏感控件不泄露值。
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var sensitive = sensitiveInputKind(el);
      if (sensitive) {
        node.value_sensitive = true;
        node.value_sensitive_reason = sensitive;
      } else {
        var v = el.value;
        if (v !== undefined && v !== "" && v !== null) {
          var cut = truncateNodeValue(v, aiId, 200);
          node.value = cut.value;
          if (cut.value_truncated) {
            node.value_truncated = true;
            node.value_full_length = cut.value_full_length;
            node.value_length_unit = cut.value_length_unit;
            node.value_fetch_ref = cut.value_fetch_ref;
          }
        }
      }
    } else if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") {
      var innerText = el.innerText;
      if (innerText && innerText.trim()) {
        var cutCe = truncateNodeValue(innerText, aiId, 200);
        node.value = cutCe.value;
        if (cutCe.value_truncated) {
          node.value_truncated = true;
          node.value_full_length = cutCe.value_full_length;
          node.value_length_unit = cutCe.value_length_unit;
          node.value_fetch_ref = cutCe.value_fetch_ref;
        }
      }
    }
    if (Object.keys(attributes).length) node.attributes = attributes;
    if (editorType) node.editor_type = editorType;
    if (editorBlocks) node.editor_blocks = editorBlocks;

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
  // Fallback: explicitly scan for iframes missed by process() traversal
  var allIframes = document.querySelectorAll("iframe");
  var extraIframes = [];
  for (var ii = 0; ii < allIframes.length; ii++) {
    var ifr = allIframes[ii];
    var iframeBody = null;
    var iframeText = "";
    try {
      var ifrDoc = ifr.contentDocument || ifr.contentWindow.document;
      if (ifrDoc && ifrDoc.body) {
        iframeText = (ifrDoc.body.innerText || "").slice(0, 200);
        // Use a fresh sub-process for iframe body
        var cb = function(el) {
          if (!el || seen.has(el)) return null;
          seen.add(el);
          if (!el.isConnected) return null;
          var tg = el.tagName.toLowerCase();
          var lbl = el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").slice(0, 40) || el.getAttribute("placeholder") || "";
          var rl = tg;
          if (tg === "button") rl = "button";
          else if (tg === "input") { var ty = (el.getAttribute("type") || "").toLowerCase(); rl = (ty === "checkbox") ? "checkbox" : (ty === "radio") ? "radio" : "textbox"; }
          else if (tg === "textarea") rl = "textbox";
          else if (tg === "a") rl = "link";
          else if (tg === "img") rl = "image";
          else if (tg === "iframe") rl = "iframe";
          else if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") rl = "textbox";
          var ariaRole = (el.getAttribute("role") || "").toLowerCase();
          if (ariaRole) rl = ariaRole;
          // Skip pure layout divs/spans inside iframe too
          if (tg === "div" || tg === "span") {
            if (!el.hasAttribute("role") && !(el.contentEditable === "true" || el.getAttribute("contenteditable") === "true")) {
              // recurse into children but don't create a node
              var ch = el.children;
              if (ch && ch.length) {
                var results = [];
                for (var ci = 0; ci < ch.length; ci++) { var cn = cb(ch[ci]); if (cn) { if (Array.isArray(cn)) results.push.apply(results, cn); else results.push(cn); } }
                return results.length ? results : null;
              }
              return null;
            }
          }
          var nd = { id: "iframe-el-" + counter++, role: rl, label: lbl };
          var ch2 = el.children;
          if (ch2 && ch2.length) {
            var cc = [];
            for (var ci2 = 0; ci2 < ch2.length; ci2++) { var cn2 = cb(ch2[ci2]); if (cn2) { if (Array.isArray(cn2)) cc.push.apply(cc, cn2); else cc.push(cn2); } }
            if (cc.length) nd.children = cc;
          }
          return nd;
        };
        iframeBody = cb(ifrDoc.body);
      }
    } catch(e) {}
    if (iframeBody) {
      extraIframes.push({ id: "iframe-" + counter++, role: "iframe_body", label: (ifr.title || ifr.name || "iframe content"), children: iframeBody.children || (Array.isArray(iframeBody) ? iframeBody : [iframeBody]), text: iframeText });
    } else if (iframeText) {
      extraIframes.push({ id: "iframe-text-" + counter++, role: "iframe_body", label: ifr.title || ifr.name || "iframe content", text: iframeText });
    } else {
      // At least add the iframe node itself
      extraIframes.push({ id: "iframe-empty-" + counter++, role: "iframe", label: ifr.title || ifr.name || "iframe" });
    }
  }
  if (extraIframes.length && root) {
    if (!root.children) root.children = [];
    root.children.push.apply(root.children, extraIframes);
  }
  if (!root) {
    return { id: "root", role: "generic", label: "", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }
  root._debug = { iframe_count: extraIframes.length, version: VERSION_TAG };
  return root;
}

// ============================================================
// 2. EXTRACT PAGE CONTEXT — modals, forms, iframes, session
// ============================================================

function extractPageContext() {
  // MODALS — unified search across ALL patterns.
  // Visibility rule: do NOT use `el.offsetParent === null` to skip hidden nodes —
  // position:fixed overlays (masks/dialogs/popups) always have offsetParent===null
  // even when fully visible, so that check silently drops every modal. Use a
  // layout-rect + computed-style test that tolerates fixed positioning instead.
  function isShown(el) {
    try {
      if (el.getClientRects().length === 0) return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    } catch (e) { return false; }
    return true;
  }
  var modalSelectors = [
    "[class*=modal]", "[class*=dialog]", "[class*=popup]", "[class*=drawer]", "[class*=overlay]", "[class*=mask]",
    "[role=dialog]", "[role=alertdialog]"
  ];
  var modals = [];
  for (var si = 0; si < modalSelectors.length; si++) {
    var els = document.querySelectorAll(modalSelectors[si]);
    for (var ei = 0; ei < els.length; ei++) {
      var m = els[ei];
      if (!isShown(m)) continue;
      // Buttons may be real <button> or ARIA/JS-styled fakes (div/span[role=button]).
      var btns = m.querySelectorAll("button,[role=button],input[type=submit],input[type=button]");
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
        var inp = inps[fi];
        var fieldEntry = {
          type: inp.type || inp.tagName.toLowerCase(),
          placeholder: (inp.placeholder || "").slice(0, 40),
          required: isRequired(inp)
        };

        // Field-level error: aria-describedby or adjacent error sibling
        var fieldError = null;
        var descId = inp.getAttribute("aria-describedby");
        if (descId) {
          var descEl = document.getElementById(descId);
          if (descEl && isShown(descEl)) {
            var dt = (descEl.textContent || "").trim();
            if (dt && dt.length < 100) fieldError = dt;
          }
        }
        if (!fieldError) {
          // Check siblings/parent for error-class elements near this field
          var parent = inp.parentElement;
          if (parent) {
            var siblings = parent.querySelectorAll("[class*=error],[class*=err],[class*=invalid],[role=alert]");
            for (var sbi = 0; sbi < siblings.length; sbi++) {
              var st = (siblings[sbi].textContent || "").trim();
              if (st && st.length > 0 && st.length < 100) { fieldError = st; break; }
            }
          }
        }
        if (fieldError) fieldEntry.error = fieldError;
        fieldList.push(fieldEntry);
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
    if (!isShown(f)) continue;
    var inps = f.querySelectorAll("input:not([type=hidden]),textarea,select");
    var fields = [];
    for (var ii = 0; ii < inps.length; ii++) {
      fields.push({
        id: inps[ii].id || inps[ii].name || "",
        type: inps[ii].type || inps[ii].tagName.toLowerCase(),
        placeholder: (inps[ii].placeholder || "").slice(0, 40),
        // 只读原生 required 会把只用 aria-required 标必填的站点（不少组件库如此）
        // 整片当成选填 —— agent 于是跳过必填项、提交必失败。ARIA 的 "true"/"false"
        // 都按字面认，其它值（含缺失）不认。
        required: isRequired(inps[ii])
      });
    }
    if (fields.length) formList.push({ fields: fields });
  }

  // 必填判定：原生 required 或 aria-required="true"。站点/组件库常只用 ARIA 标必填
  // （原生 required 会触发浏览器自带的气泡校验，很多站点刻意绕开它）。
  function isRequired(el) {
    if (el.required === true) return true;
    var ar = el.getAttribute ? el.getAttribute("aria-required") : null;
    return ar === "true";
  }

  // ---- 顶层错误 / 提示扫描（P0-2 / P1-6）----
  // context.modals[] 的 errSel 扫描只在 class 含 modal/dialog/popup/drawer/
  // overlay/mask 的容器内部生效，而"页面即表单"的站点根本没有这类容器 ——
  // 字段级小红字（无 role 的 <span class="field-error">）、表单级汇总、toast、
  // 服务端报错统统读不到：agent 提交了表单却看不到哪里错了。这里把同类扫描
  // 扩到整个 document，并落到**顶层** context。
  //
  // 刻意**不**把这些元素提升为语义树节点：站点用裸 span/div 承载提示文案是常态，
  // isPureLayout 剪掉它们正是为了压住语义树的 token 体积（真实页面上量极大）。
  // 只读文本、只进 context —— 主树一个节点都不加（实测节点数与改动前完全一致）。
  var ERROR_SEL = [
    "[class*=error]", "[class*=err]", "[class*=invalid]", "[class*=fail]",
    "[class*=warning]", "[class*=warn]", "[class*=toast]", "[class*=snackbar]",
    "[role=alert]"
  ];
  var HINT_SEL = [
    "[class*=tip]", "[class*=hint]", "[class*=notice]", "[class*=help]",
    "[class*=counter]", "[class*=remaining]", "[role=status]", "[aria-live]"
  ];
  // 字数/计数类文案（"0/256"）常被塞进连 class 都没有的裸 span —— 无 class 可依，
  // 只能认文本形态。限定"叶子元素 + 文本很短"来降噪，避免整页文本被收进来。
  var LIMIT_RE = /^[^\d]{0,10}\d+\s*\/\s*\d+[^\d]{0,10}$/;

  function textOf(el) {
    if (!isShown(el)) return "";
    var t = (el.textContent || "").trim();
    if (!t || t.length > 120) return "";
    return t;
  }
  // 报错对应到具体字段。两条可靠路径，都没有就宁可空着也不猜：
  //  1) 标准 ARIA 关联：哪个输入用 aria-describedby / aria-errormessage 指到这个
  //     报错元素（mTitle[aria-describedby=mErr] → mErr 的 field 就是 mTitle）。
  //  2) 同一容器内恰好一个输入控件（#tagWrap 里的 tagDup → tagInput）。
  // 刻意不做"找最近的 input"这类位置猜测：报错常集中渲染在表单底部/顶部，
  // 离它最近的 input 往往不是它对应的那个字段，猜出来的对应关系比没有更糟。
  function fieldOf(el) {
    var eid = el.id;
    if (eid) {
      try {
        var ref = document.querySelector(
          '[aria-errormessage~="' + eid + '"],[aria-describedby~="' + eid + '"]');
        if (ref) return ref.id || ref.name || "";
      } catch (e) {}
    }
    var p = el.parentElement;
    if (!p) return "";
    var inps = p.querySelectorAll("input:not([type=hidden]),textarea,select");
    if (inps.length !== 1) return "";
    return inps[0].id || inps[0].name || "";
  }
  function scanSelectors(sels) {
    var out = [];
    for (var si = 0; si < sels.length; si++) {
      var els;
      try { els = document.querySelectorAll(sels[si]); } catch (e) { continue; }
      for (var ei = 0; ei < els.length && out.length < 40; ei++) {
        var t = textOf(els[ei]);
        if (t && out.indexOf(t) < 0) out.push(t);
      }
    }
    return out;
  }

  var topErrors = scanSelectors(ERROR_SEL);
  var fieldErrors = [];
  var seenFieldErr = {};
  for (var fes = 0; fes < ERROR_SEL.length && fieldErrors.length < 40; fes++) {
    var feEls;
    try { feEls = document.querySelectorAll(ERROR_SEL[fes]); } catch (e) { continue; }
    for (var fei = 0; fei < feEls.length && fieldErrors.length < 40; fei++) {
      var fet = textOf(feEls[fei]);
      if (!fet) continue;
      var fid = fieldOf(feEls[fei]);
      if (!fid) continue;
      var fkey = fid + " " + fet;
      if (seenFieldErr[fkey]) continue;
      seenFieldErr[fkey] = 1;
      fieldErrors.push({ field: fid, text: fet });
    }
  }
  var topHints = scanSelectors(HINT_SEL);
  try {
    var cand = document.querySelectorAll("span,div,p,small,em,i,label,li,strong,b");
    for (var ci2 = 0; ci2 < cand.length && topHints.length < 40; ci2++) {
      if (cand[ci2].children && cand[ci2].children.length) continue; // 只认叶子，避免整页文本
      var ht = textOf(cand[ci2]);
      if (!ht || !LIMIT_RE.test(ht)) continue;
      if (topHints.indexOf(ht) < 0) topHints.push(ht);
    }
  } catch (e) {}

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
    // 顶层报错/提示：不依赖容器 class 是否含 modal 关键词，普通页面也能读到。
    // errors —— 全文档扫描到的可见错误文案；field_errors —— 能对应到具体输入
    // 框的那些（{field, text}）；hints —— 字数/提示/轻通知类辅助文案。
    errors: topErrors.length ? topErrors : null,
    field_errors: fieldErrors.length ? fieldErrors : null,
    hints: topHints.length ? topHints : null,
    session: { logged_in: loggedIn },
    stats: {
      inputs: document.querySelectorAll("input:not([type=hidden])").length,
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a[href]").length,
      iframes: document.querySelectorAll("iframe").length
    }
  };
}

module.exports = { extractTree, extractPageContext };
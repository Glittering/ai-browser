// preload/extractor.cjs — Semantic extraction (CommonJS)
// Split out of bridge.js v6.9. Pure DOM functions, no Electron dependency,
// so it can be unit-tested under jsdom.
// Exports: extractTree(), extractPageContext()

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
    // Attach current value for input/textarea/contenteditable
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var v = el.value;
      if (v !== undefined && v !== "" && v !== null) node.value = v.slice(0, 200);
    } else if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") {
      var innerText = el.innerText;
      if (innerText && innerText.trim()) node.value = innerText.slice(0, 200);
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
        var inp = inps[fi];
        var fieldEntry = {
          type: inp.type || inp.tagName.toLowerCase(),
          placeholder: (inp.placeholder || "").slice(0, 40),
          required: inp.required || false
        };

        // Field-level error: aria-describedby or adjacent error sibling
        var fieldError = null;
        var descId = inp.getAttribute("aria-describedby");
        if (descId) {
          var descEl = document.getElementById(descId);
          if (descEl && descEl.offsetParent !== null) {
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

module.exports = { extractTree, extractPageContext };
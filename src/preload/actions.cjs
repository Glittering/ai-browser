// preload/actions.cjs — Action execution (CommonJS)
// Split out of bridge.js v6.9. Pure DOM functions, no Electron dependency.
// Exports: executeAction()

// ============================================================
// 3. EXECUTE ACTION — click, type, setContent, select, etc.
// ============================================================

// 按 data-ai-id 找元素，**穿透影子根**。
//
// document.querySelector 不跨 shadow boundary：Web Component 里的元素（B站 opus
// 的 <bili-comments>、YouTube 的 <ytd-*>、各设计系统的 <ui-*>）即使抽取层给了
// data-ai-id，这里的顶层查询也找不到，报出来只是一句
// "Target not found for ref: xxx" —— 看起来像"元素不存在"，实际是"查询路径够不着"。
// 实测（2026-10-17）：B站帖子详情页的评论输入框就在 bili-comments 的 shadow root 里。
function findRef(root, elementId) {
  var el = null;
  try { el = root.querySelector('[data-ai-id="' + elementId + '"]'); } catch (e) { el = null; }
  if (el) return el;
  var all;
  try { all = root.querySelectorAll("*"); } catch (e) { return null; }
  for (var i = 0; i < all.length; i++) {
    var sr = all[i].shadowRoot;
    if (!sr) continue;
    var hit = findRef(sr, elementId);
    if (hit) return hit;
  }
  return null;
}

function executeAction(elementId, action, params) {
  params = params || {};
  var el = findRef(document, elementId);
  if (!el) return { success: false, error: "Target not found for ref: " + elementId };

  try {
    switch (action) {
      case "click":
        el.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
        // Single trusted dispatch: el.click() fires exactly one click event AND
        // runs the default behavior on checkbox/radio/submit/details. A manual
        // dispatchEvent(click) would fire a second click, double-triggering
        // non-idempotent handlers and toggling checkbox/radio back to original.
        el.click();
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

      case "paste":
        // 富文本粘贴（CDP 不可用时的顶层兜底；OOPIF 子帧 preload 到不了，
        // 那条路只有 CDP 的 Frame.executeJavaScript 能走）。
        // 合成 ClipboardEvent + DataTransfer：Draft.js / ProseMirror / Quill
        // 的粘贴处理器会把 text/html 转成内部文档模型，与真人粘贴等效。
        return doPaste(el, params);

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

// paste — rich-text injection via a synthetic ClipboardEvent.
// Same contract as page_manager._pasteViaCdp (params.html preferred over
// params.text); this is the preload-only fallback for when CDP is absent.
function doPaste(el, params) {
  var html = typeof params.html === "string" ? params.html : "";
  var text = typeof params.text === "string" ? params.text : "";
  if (!html && !text) {
    return { success: false, error: "paste called with neither html nor text — nothing to paste" };
  }
  var editor = el;
  if (!(editor.contentEditable === "true" || editor.getAttribute("contenteditable") === "true")) {
    var inner = el.querySelector("[contenteditable=true],input,textarea");
    if (inner) editor = inner;
    else return { success: false, error: "Target is not an editable element" };
  }
  editor.focus();
  var dt = new DataTransfer();
  if (html) dt.setData("text/html", html);
  dt.setData("text/plain", text || html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
  var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
  var notPrevented = editor.dispatchEvent(ev);
  if (notPrevented) {
    return {
      success: false,
      error: "paste event was not consumed by the page (defaultPrevented=false) — try a child node ref, or setContent for plain text"
    };
  }
  return { success: true, method: "synthetic-clipboard-event" };
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

module.exports = { executeAction, findRef };
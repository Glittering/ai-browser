// preload/actions.cjs — Action execution (CommonJS)
// Split out of bridge.js v6.9. Pure DOM functions, no Electron dependency.
// Exports: executeAction()

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

module.exports = { executeAction };
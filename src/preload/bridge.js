// preload/bridge.js — IPC bridge (CommonJS for Electron preload)
const { contextBridge, ipcRenderer } = require('electron');

// Inline extractTree (no ESM import)
function extractTree() {
  const seen = new WeakSet();
  let counter = 0;

  function isHidden(el) {
    if (!(el instanceof HTMLElement)) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'dialog') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden') return true;
    if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hidden === true) return true;
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (p.hidden === true) return true;
      if (p.hasAttribute('aria-hidden') && p.getAttribute('aria-hidden') === 'true') return true;
      const ps = window.getComputedStyle(p);
      if (ps.display === 'none') return true;
      p = p.parentElement;
    }
    return false;
  }

  function isPureLayout(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'div' && tag !== 'span') return false;
    const hasRole = el.hasAttribute('role') && el.getAttribute('role') !== '';
    const hasOnClick = typeof el.onclick === 'function';
    const hasAria = Array.from(el.attributes).some(a => a.name.startsWith('aria-'));
    const hasDataAttr = Array.from(el.attributes).some(a => a.name.startsWith('data-') && a.name !== 'data-ai-id');
    // contenteditable / CodeMirror / Monaco / ProseMirror are NOT pure layout
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return false;
    const cls = (el.className || '').toLowerCase();
    if (cls.indexOf('codemirror') >= 0 || cls.indexOf('prosemirror') >= 0 || cls.indexOf('monaco') >= 0) return false;
    if (hasRole || hasOnClick || hasAria || hasDataAttr) return false;
    return true;
  }

  const interactiveTags = new Set([
    'a','button','input','select','textarea','option','details','dialog',
    'summary','video','audio','track','embed','object','canvas','svg','img',
    'table','ul','ol','li','h1','h2','h3','h4','h5','h6','p','label','form',
    'nav','main','header','footer','section','article','aside'
  ]);

  function isSemantic(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (isHidden(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (interactiveTags.has(tag)) return true;
    if (el.hasAttribute('role')) return true;
    if (typeof el.onclick === 'function') return true;
    // contenteditable elements are semantic
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return true;
    if (isPureLayout(el)) return false;
    if (tag === 'div' || tag === 'span') return false;
    return true;
  }

  function inferRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range' || type === 'number') return 'slider';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'select';
    if (tag === 'a' && (el.hasAttribute('href') || typeof el.onclick === 'function')) return 'link';
    if (tag === 'details' || tag === 'summary') return 'button';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'option') return 'option';
    const ariaRole = (el.getAttribute('role') || '').toLowerCase();
    if (ariaRole) return ariaRole;
    // contenteditable div/span → textbox
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return 'textbox';
    if (typeof el.onclick === 'function') return 'button';
    return 'generic';
  }

  function extractActions(el, role) {
    switch (role) {
      case 'button': case 'link': return ['click', 'focus', 'hover'];
      case 'textbox': return ['type', 'setContent', 'clear', 'focus'];
      case 'select': return ['select', 'focus'];
      case 'slider': return ['scroll_to', 'focus'];
      case 'checkbox': case 'radio': return ['click', 'focus'];
      case 'dialog': return ['open', 'close'];
      default: return [];
    }
  }

  function deriveActionHints(el, role) {
    var hints = [];
    var aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    var cls = (el.className || '').toLowerCase();
    var id = (el.id || '').toLowerCase();
    var text = (el.textContent || '').toLowerCase().trim().slice(0, 50);
    var combined = aria + '|' + cls + '|' + id + '|' + text;
    if (role === 'button' || role === 'link' || typeof el.onclick === 'function') {
      if (/发布|submit|publish|post|发表|提交/.test(combined)) hints.push('publish');
      if (/保存|save|draft/.test(combined)) hints.push('save');
      if (/取消|cancel|discard/.test(combined)) hints.push('cancel');
      if (/删除|delete|remove/.test(combined)) hints.push('delete');
      if (/登录|login|signin/.test(combined)) hints.push('login');
    }
    return hints.length ? hints : null;
  }

  function detectEditorType(el) {
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    var cls = (el.className || '').toLowerCase();
    if (cls.indexOf('codemirror') >= 0) return 'codemirror';
    if (cls.indexOf('prosemirror') >= 0) return 'prosemirror';
    if (cls.indexOf('monaco') >= 0) return 'monaco';
    if (el.tagName.toLowerCase() === 'textarea') return 'textarea';
    return null;
  }

  function extractLabel(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const title = el.getAttribute('title');
    if (title) return title;
    let text = (el.textContent || '').trim();
    if (text.length > 60) text = text.slice(0, 60);
    if (text) return text;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return '';
  }

  function extractBounds(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch (e) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  function extractAttributes(el) {
    const attrs = {};
    for (const attr of el.attributes) {
      if (attr.name === 'data-ai-id') continue;
      if (attr.name.startsWith('data-') || attr.name.startsWith('aria-') ||
          attr.name === 'name' || attr.name === 'id' || attr.name === 'class') {
        attrs[attr.name] = attr.value;
      }
    }
    return attrs;
  }

  function process(el) {
    if (seen.has(el)) return null;
    seen.add(el);
    if (!el.isConnected) return null;
    if (!isSemantic(el)) {
      if (el.children.length > 0) {
        const results = [];
        for (const child of el.children) {
          const childNode = process(child);
          if (childNode) {
            if (Array.isArray(childNode)) results.push(...childNode);
            else results.push(childNode);
          }
        }
        return results.length ? results : null;
      }
      return null;
    }
    const label = extractLabel(el);
    const role = inferRole(el);
    const actions = extractActions(el, role);
    const bounds = extractBounds(el);
    const attributes = extractAttributes(el);
    const nativeId = el.id || '';
    const editorType = detectEditorType(el);
    const actionHints = deriveActionHints(el, role);
    let aiId = nativeId;
    if (!aiId) aiId = `e:${el.tagName.toLowerCase()}-${counter++}`;
    el.setAttribute('data-ai-id', aiId);

    const states = [];
    if (el.disabled === true) states.push('disabled');
    if (el.readOnly === true) states.push('readonly');
    if (el.checked === true) states.push('checked');
    if (el === document.activeElement) states.push('focused');
    if (!isHidden(el)) states.push('visible');

    const node = {
      id: aiId, role, label,
      states: states.length ? states : undefined,
      actions, bounds,
      attributes: Object.keys(attributes).length ? attributes : undefined,
    };
    if (editorType) node.editor_type = editorType;
    if (actionHints) node.action_hints = actionHints;

    const children = [];
    for (const child of el.children) {
      const childNode = process(child);
      if (childNode) {
        if (Array.isArray(childNode)) children.push(...childNode);
        else children.push(childNode);
      }
    }
    if (children.length) node.children = children;
    return node;
  }

  return process(document.body) || { id: 'root', role: 'generic', label: '', states: ['visible'], actions: [], bounds: {}, attributes: {} };
}

// Inline executeAction (v2 — supports setContent for rich editors)
function executeAction(elementId, action, params) {
  params = params || {};
  const el = document.querySelector('[data-ai-id="' + elementId + '"]');
  if (!el) return { success: false, error: 'Target not found' };
  try {
    switch (action) {
      case 'click':
        // Full mouse event sequence for SPA frameworks (Vue/React/Next.js)
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 }));
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
        return { success: true };
      case 'type':
        if (el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'textarea' &&
            el.contentEditable !== 'true')
          return { success: false, error: 'Invalid action' };
        el.value = params.text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      // NEW: setContent — write to any editor (contenteditable, CodeMirror, etc.)
      case 'setContent':
        var text = params.text || '';
        // 1. contenteditable div
        if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') {
          el.focus();
          el.innerHTML = text.replace(/\n/g, '<br>');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true };
        }
        // 2. textarea
        if (el.tagName.toLowerCase() === 'textarea') {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        // 3. Look inside for CodeMirror / Monaco / ProseMirror editor sub-elements
        var cmEditors = el.querySelectorAll('[class*=CodeMirror], [class*=codemirror]');
        for (var i = 0; i < cmEditors.length; i++) {
          var cm = cmEditors[i];
          if (cm.CodeMirror) {
            cm.CodeMirror.setValue(text);
            return { success: true };
          }
        }
        // 4. Monaco editor
        var monacoEls = el.querySelectorAll('[class*=monaco-editor]');
        for (var j = 0; j < monacoEls.length; j++) {
          var monacoEditor = monacoEls[j].__monaco_editor__;
          if (monacoEditor && monacoEditor.setValue) {
            monacoEditor.setValue(text);
            return { success: true };
          }
        }
        // 5. ProseMirror — dispatch paste event? Complex. Fallback to contenteditable
        var proseEls = el.querySelectorAll('[class*=ProseMirror], [contenteditable=true]');
        if (proseEls.length > 0) {
          proseEls[0].focus();
          proseEls[0].innerHTML = text.replace(/\n/g, '<br>');
          proseEls[0].dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: 'No editable element found in target' };
      case 'clear':
        if (el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'textarea' &&
            el.contentEditable !== 'true')
          return { success: false, error: 'Invalid action' };
        el.value = '';
        if (el.contentEditable === 'true') el.innerHTML = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      case 'select':
        if (el.tagName.toLowerCase() !== 'select') return { success: false, error: 'Invalid action' };
        el.value = params.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      case 'focus': el.focus(); return { success: true };
      case 'hover': el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); return { success: true };
      case 'scroll_to': el.scrollIntoView({ behavior: 'instant', block: 'center' }); return { success: true };
      default: return { success: false, error: 'Invalid action' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Expose to renderer
contextBridge.exposeInMainWorld('__ai_browser__', {
  sendTree: (tree) => ipcRenderer.send('ai:tree', tree),
  sendDiff: (changes) => ipcRenderer.send('ai:diff', changes),
});

// Respond to extract requests from main
ipcRenderer.on('ai:extract', (_event, params) => {
  let tree = extractTree();
  if (params?.focusedOnly && tree) {
    function findFocused(node) {
      if (node.states && node.states.includes('focused')) return node;
      if (node.children) for (const c of node.children) { const f = findFocused(c); if (f) return f; }
      return null;
    }
    tree = findFocused(tree) || tree;
  }
  ipcRenderer.send('ai:tree', tree);
});

// Respond to action requests from main
ipcRenderer.on('ai:action', (_event, { action, target, params }) => {
  const result = executeAction(target, action, params);
  ipcRenderer.send('ai:action_result', result);
});

// Captcha detection — watch for verification modals
function scanCaptcha() {
  // Query by class/id keywords
  const byCSS = document.querySelectorAll('[class*=captcha], [class*=verify], [class*=slider], [class*=slide], [class*=drag], [id*=captcha], [id*=verify], [class*=JDJRV], [class*=small-jd], [class*=cert]');
  // Also check alt text on images
  const byAlt = document.querySelectorAll('img[alt*=验证码], img[alt*=captcha], img[alt*=verify], img[alt*=滑块], img[alt*=slide], img[alt*=slider]');
  // Combine
  const all = new Set([...byCSS, ...byAlt]);
  const visible = [];
  const rectThreshold = 0; // include even zero-rect elements (shows captcha exists even if canvas renders)
  all.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width >= rectThreshold || r.height >= rectThreshold) {
      visible.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 80),
        id: el.id || '',
        alt: el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
        text: String(el.textContent || '').trim().slice(0, 50),
        bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      });
    }
  });
  return visible;
}

let observer = null, lastCaptchaSig = '';
function bindObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    const found = scanCaptcha();
    if (found.length > 0) {
      const sig = JSON.stringify(found.map(f => f.cls + '|' + f.bounds.x + ',' + f.bounds.y + ',' + f.bounds.width + ',' + f.bounds.height));
      if (sig !== lastCaptchaSig) {
        lastCaptchaSig = sig;
        ipcRenderer.send('ai:event', { event: 'captcha_appeared', data: { elements: found } });
      }
    }
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }
}
bindObserver();
document.addEventListener('DOMContentLoaded', () => { setTimeout(bindObserver, 500); });
window.addEventListener('load', () => { bindObserver(); const found = scanCaptcha(); if (found.length) { lastCaptchaSig = JSON.stringify(found.map(f=>f.cls+'|'+f.bounds.x+','+f.bounds.y+','+f.bounds.width+','+f.bounds.height)); ipcRenderer.send('ai:event', {event:'captcha_appeared', data:{elements:found}}); } });
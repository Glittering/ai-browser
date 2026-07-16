// preload/semantic_extractor.js — DOM → SemanticUITree v3
// NEW: extractPageContext() → page-level semantic summary (modals, forms, page_type)
export function extractTree() {
  return _extractTree(document.body);
}

// NEW: page-level context summary
export function extractPageContext() {
  const ctx = {
    title: document.title,
    url: document.URL,
    page_type: inferPageType(),
    forms: extractForms(),
    modals: extractModals(),
    session: inferSessionState(),
  };
  return ctx;
}

function inferPageType() {
  const url = document.URL.toLowerCase();
  const title = document.title.toLowerCase();
  // editor / article / login / search / list / form / dashboard patterns
  if (/editor|drafts|write|post|发表|撰写|写文章/.test(url + title)) return 'editor';
  if (/login|signin|登录|auth/.test(url + title)) return 'login';
  if (/search|query|q=/.test(url) || document.querySelector('input[type=search],input[name=q]')) return 'search';
  if (/dashboard|后台|admin|settings|设置/.test(url + title)) return 'dashboard';
  if (/article|blog|post|news|故事|文章/.test(url + title)) return 'article';
  if (/list|catalog|category|topic|话题|首页|hot|trending/.test(url + title)) return 'list';
  return 'page';
}

function extractForms() {
  const forms = document.querySelectorAll('form');
  const result = [];
  for (const f of forms) {
    if (f.offsetParent === null) continue;
    const inputs = f.querySelectorAll('input,textarea,select');
    const fields = [];
    for (const inp of inputs) {
      if (inp.type === 'hidden') continue;
      fields.push({
        id: inp.id || inp.name || '',
        type: inp.type || inp.tagName.toLowerCase(),
        placeholder: (inp.placeholder || '').slice(0, 40),
        required: inp.required || false,
        value: (inp.value || '').slice(0, 40),
      });
    }
    const buttons = f.querySelectorAll('button,input[type=submit]');
    const actions = [];
    for (const btn of buttons) {
      actions.push({
        text: (btn.textContent || btn.value || '').trim().slice(0, 30),
        disabled: btn.disabled || false,
      });
    }
    if (fields.length || actions.length) {
      result.push({ fields, actions });
    }
  }
  return result.length ? result : null;
}

function extractModals() {
  const modals = document.querySelectorAll('[class*=modal],[class*=dialog],[class*=popup],[class*=drawer],[role=dialog],[class*=overlay],[class*=mask]');
  const result = [];
  for (const modal of modals) {
    if (modal.offsetParent === null) continue;
    // Check if it's a meaningful modal (has buttons/inputs)
    const buttons = modal.querySelectorAll('button,input[type=submit]');
    const inputs = modal.querySelectorAll('input:not([type=hidden]),textarea');
    if (buttons.length === 0 && inputs.length === 0) continue;

    const btnList = [];
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim();
      if (!text) continue;
      btnList.push({
        text: text.slice(0, 30),
        disabled: btn.disabled || false,
        primary: /primary|确定|提交|publish|submit|confirm/.test(btn.className + text),
      });
    }

    const fieldList = [];
    for (const inp of inputs) {
      fieldList.push({
        type: inp.type || inp.tagName.toLowerCase(),
        placeholder: (inp.placeholder || inp.getAttribute('aria-label') || '').slice(0, 40),
        required: inp.required || false,
        value: (inp.value || '').slice(0, 30),
      });
    }

    // Error messages inside modal
    const errEls = modal.querySelectorAll('[class*=error],[class*=err],[class*=invalid],[class*=warn]');
    const errors = [];
    for (const e of errEls) {
      const t = (e.textContent || '').trim();
      if (t && t.length < 100) errors.push(t);
    }

    // Required indicators
    const reqEls = modal.querySelectorAll('[class*=required],[class*=req],.byte-form-item__label');
    const required = [];
    for (const r of reqEls) {
      const t = (r.textContent || '').trim();
      if (t && t.length < 30 && !required.includes(t)) required.push(t);
    }

    result.push({
      buttons: btnList,
      fields: fieldList,
      errors: errors.length ? errors : null,
      required_hints: required.length ? required : null,
    });
  }
  return result.length ? result : null;
}

function inferSessionState() {
  const hasPasswordInput = document.querySelector('input[type=password]');
  const hasLoginText = document.body.innerText.indexOf('登录') >= 0 || document.body.innerText.indexOf('Sign In') >= 0;
  return {
    logged_in: !hasPasswordInput && !hasLoginText,
  };
}

// === TREE EXTRACTION (v2: editor_type + action_hints) ===

function _extractTree(root) {
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
    const hasInteractiveChild = Array.from(el.children).some(ch => isSemantic(ch));
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return false;
    const cls = (el.className || '').toLowerCase();
    if (cls.indexOf('codemirror') >= 0 || cls.indexOf('prosemirror') >= 0 || cls.indexOf('monaco') >= 0) return false;
    if (hasRole || hasOnClick || hasAria || hasDataAttr || hasInteractiveChild) return false;
    return true;
  }

  function isSemantic(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (isHidden(el)) return false;
    const tag = el.tagName.toLowerCase();
    const interactiveTags = new Set([
      'a','button','input','select','textarea','option','details','dialog',
      'summary','video','audio','track','embed','object','canvas','svg','img',
      'table','ul','ol','li','h1','h2','h3','h4','h5','h6','p','label','form',
      'nav','main','header','footer','section','article','aside'
    ]);
    if (interactiveTags.has(tag)) return true;
    if (el.hasAttribute('role')) return true;
    if (typeof el.onclick === 'function') return true;
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return true;
    if (isPureLayout(el)) return false;
    if (tag === 'div' || tag === 'span') return false;
    return true;
  }

  function detectEditorType(el) {
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    const allEls = [el, ...Array.from(el.querySelectorAll('*'))];
    for (const sub of allEls) {
      const cls = (sub.className || '').toLowerCase();
      if (cls.indexOf('codemirror') >= 0) return 'codemirror';
      if (cls.indexOf('prosemirror') >= 0) return 'prosemirror';
      if (cls.indexOf('monaco') >= 0 || cls.indexOf('monaco-editor') >= 0) return 'monaco';
      if (cls.indexOf('bytemd') >= 0 || cls.indexOf('editor') >= 0) return 'richtext';
      if (cls.indexOf('ql-editor') >= 0) return 'quill';
    }
    return el.tagName.toLowerCase() === 'textarea' ? 'textarea' : null;
  }

  function deriveActionHints(el, role) {
    const hints = new Set();
    const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const text = (el.textContent || '').toLowerCase().trim().slice(0, 50);
    const combined = aria + '|' + cls + '|' + id + '|' + text;

    if (role === 'button' || role === 'link' || typeof el.onclick === 'function') {
      if (/发布|submit|publish|post|发表|提交/.test(combined)) hints.add('publish');
      if (/保存|草稿|save|draft/.test(combined)) hints.add('save');
      if (/取消|cancel|discard/.test(combined)) hints.add('cancel');
      if (/删除|delete|remove/.test(combined)) hints.add('delete');
      if (/编辑|edit|modify/.test(combined)) hints.add('edit');
      if (/登录|login|signin/.test(combined)) hints.add('login');
      if (/注册|register|signup/.test(combined)) hints.add('register');
    }
    return hints.size ? Array.from(hints) : null;
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
    if (tag === 'details') return 'button';
    if (tag === 'summary') return 'button';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'option') return 'option';
    const ariaRole = (el.getAttribute('role') || '').toLowerCase();
    if (ariaRole) return ariaRole;
    if (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true') return 'textbox';
    if (typeof el.onclick === 'function') return 'button';
    return 'generic';
  }

  function extractActions(el, role) {
    switch (role) {
      case 'button':
      case 'link':
        return ['click', 'focus', 'hover'];
      case 'textbox':
        return ['type', 'setContent', 'clear', 'focus'];
      case 'select':
        return ['select', 'focus'];
      case 'slider':
        return ['scroll_to', 'focus'];
      case 'checkbox':
      case 'radio':
        return ['click', 'focus'];
      case 'dialog':
        return ['open', 'close'];
      default:
        return [];
    }
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
      if (attr.name.startsWith('data-') || attr.name.startsWith('aria-')
          || attr.name === 'name' || attr.name === 'id' || attr.name === 'class') {
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
            if (Array.isArray(childNode)) {
              results.push(...childNode);
            } else {
              results.push(childNode);
            }
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
    if (!aiId) {
      aiId = 'e:' + el.tagName.toLowerCase() + '-' + counter++;
    }
    el.setAttribute('data-ai-id', aiId);

    const states = [];
    if (el.disabled === true) states.push('disabled');
    if (el.readOnly === true) states.push('readonly');
    if (el.checked === true) states.push('checked');
    if (el === document.activeElement) states.push('focused');
    if (!isHidden(el)) states.push('visible');

    const node = {
      id: aiId,
      role,
      label,
      states: states.length ? states : undefined,
      actions,
      bounds,
      attributes: Object.keys(attributes).length ? attributes : undefined,
    };

    if (editorType) node.editor_type = editorType;
    if (actionHints) node.action_hints = actionHints;

    const children = [];
    for (const child of el.children) {
      const childNode = process(child);
      if (childNode) {
        if (Array.isArray(childNode)) {
          children.push(...childNode);
        } else {
          children.push(childNode);
        }
      }
    }
    if (children.length) {
      node.children = children;
    }
    return node;
  }

  const rootNode = process(root);
  if (!rootNode) {
    return {
      id: 'root', role: 'generic', label: '',
      states: ['visible'], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 }
    };
  }
  return rootNode;
}
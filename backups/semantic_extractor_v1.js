// preload/semantic_extractor.js — DOM → SemanticUITree
export function extractTree() {
  return _extractTree(document.body);
}

function _extractTree(root) {
  const seen = new WeakSet();
  let counter = 0;

  function isHidden(el) {
    if (!(el instanceof HTMLElement)) return true;
    const tag = el.tagName.toLowerCase();
    // <dialog> is semantically hidden only when not opened, but should still appear in tree
    if (tag === 'dialog') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden') return true;
    if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hidden === true) return true;
    // ancestor hidden check
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
    // has semantic role, event listener, or aria, or child semantic elements => keep
    const hasRole = el.hasAttribute('role') && el.getAttribute('role') !== '';
    const hasOnClick = typeof el.onclick === 'function';
    const hasAria = Array.from(el.attributes).some(a => a.name.startsWith('aria-'));
    const hasDataAttr = Array.from(el.attributes).some(a => a.name.startsWith('data-') && a.name !== 'data-ai-id');
    const hasInteractiveChild = Array.from(el.children).some(ch => isSemantic(ch));
    if (hasRole || hasOnClick || hasAria || hasDataAttr || hasInteractiveChild) return false;
    return true;
  }

  function isSemantic(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (isHidden(el)) return false;
    // native interactive tags are semantic by default
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
    if (isPureLayout(el)) return false;
    // text nodes and non-interactive elements are not semantic
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
    if (type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'password' || type === '' || type === 'submit' || type === 'reset' || type === 'button') return 'textbox';
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
  if (typeof el.onclick === 'function') return 'button';
  return 'generic';
  }

  function extractActions(el, role) {
    switch (role) {
      case 'button':
      case 'link':
        return ['click', 'focus', 'hover'];
      case 'textbox':
        return ['type', 'clear', 'focus'];
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
      if (attr.name.startsWith('data-') || attr.name.startsWith('aria-') || attr.name === 'name' || attr.name === 'id' || attr.name === 'class') {
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
      // If layout container with children, recursively process children and flatten
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

    // assign data-ai-id on actual DOM element for action_binder lookup
    let aiId = nativeId;
    if (!aiId) {
      aiId = `e:${el.tagName.toLowerCase()}-${counter++}`;
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
    return { id: 'root', role: 'generic', label: '', states: ['visible'], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, attributes: {} };
  }
  return rootNode;
}

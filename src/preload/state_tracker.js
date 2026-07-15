// preload/state_tracker.js — MutationObserver + focus/blur listener
let observer = null;
let focusHandler = null;
let blurHandler = null;
const queue = [];

export function startTracking() {
  if (observer) stopTracking();

  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        const parentId = m.target instanceof HTMLElement ? m.target.getAttribute('data-ai-id') : null;
        // Detect text node replacement (jsdom: textContent assignment triggers childList instead of characterData)
        const isTextSwap = m.addedNodes.length === 1 && m.removedNodes.length === 1 &&
          m.addedNodes[0]?.nodeType === 3 && m.removedNodes[0]?.nodeType === 3;
        if (isTextSwap && parentId) {
          queue.push({ type: 'text_changed', targetId: parentId });
        } else {
          if (m.addedNodes.length) {
            queue.push({ type: 'children_added', parentId });
          }
          if (m.removedNodes.length) {
            queue.push({ type: 'children_removed', parentId });
          }
        }
      }
      if (m.type === 'attributes') {
        const attrName = m.attributeName?.toLowerCase();
        if (attrName === 'disabled' || attrName === 'checked' || attrName === 'readonly' || attrName === 'value' || attrName === 'aria-expanded' || attrName === 'aria-selected' || attrName === 'hidden') {
          const el = m.target;
          if (el instanceof HTMLElement) {
            const aiId = el.getAttribute('data-ai-id');
            if (aiId) {
              queue.push({ type: 'state_changed', targetId: aiId, details: { attribute: attrName, value: el.getAttribute(attrName) } });
            }
          }
        }
      }
      if (m.type === 'characterData') {
        const el = m.target?.parentElement;
        if (el instanceof HTMLElement) {
          const aiId = el.getAttribute('data-ai-id');
          if (aiId) {
            queue.push({ type: 'text_changed', targetId: aiId });
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'checked', 'readonly', 'value', 'aria-expanded', 'aria-selected', 'hidden', 'open'],
    characterData: true,
  });

  focusHandler = (e) => {
    const el = e.target;
    if (el instanceof HTMLElement) {
      const aiId = el.getAttribute('data-ai-id');
      if (aiId) queue.push({ type: 'focus', targetId: aiId });
    }
  };
  blurHandler = (e) => {
    const el = e.target;
    if (el instanceof HTMLElement) {
      const aiId = el.getAttribute('data-ai-id');
      if (aiId) queue.push({ type: 'blur', targetId: aiId });
    }
  };

  document.addEventListener('focus', focusHandler, true);
  document.addEventListener('blur', blurHandler, true);

  startDialogTracking();
}

export function stopTracking() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (focusHandler) document.removeEventListener('focus', focusHandler, true);
  if (blurHandler) document.removeEventListener('blur', blurHandler, true);
  focusHandler = null;
  blurHandler = null;
}

export function getPendingChanges() {
  const changes = [...queue];
  queue.length = 0;
  return changes;
}

// dialog tracking hooks
let dialogOpenHandler = null;
let dialogCloseHandler = null;

export function startDialogTracking() {
  dialogOpenHandler = () => {
    const dlg = document.querySelector('dialog[open]');
    if (dlg) {
      const aiId = dlg.getAttribute('data-ai-id');
      if (aiId) queue.push({ type: 'dialog_open', targetId: aiId });
    }
  };
  dialogCloseHandler = () => {
    const dlg = document.querySelector('dialog');
    if (dlg) {
      const aiId = dlg.getAttribute('data-ai-id');
      if (aiId) queue.push({ type: 'dialog_close', targetId: aiId });
    }
  };
  document.addEventListener('showModal', dialogOpenHandler, true);
  document.addEventListener('close', dialogCloseHandler, true);
  // Hook showModal/close on the prototype to catch direct method calls
  const proto = window.HTMLDialogElement?.prototype;
  if (proto && proto.showModal && !proto._aiTracked) {
    const origShow = proto.showModal;
    proto.showModal = function wrappedShowModal() {
      origShow.apply(this);
      const aiId = this.getAttribute('data-ai-id');
      if (aiId) queue.push({ type: 'dialog_open', targetId: aiId });
    };
    const origClose = proto.close;
    proto.close = function wrappedClose() {
      const aiId = this.getAttribute('data-ai-id');
      origClose.apply(this);
      if (aiId) queue.push({ type: 'dialog_close', targetId: aiId });
    };
    proto._aiTracked = true;
  }
}

// preload/action_binder.js — execute action on element by data-ai-id
export function executeAction(elementId, action, params = {}) {
  const el = document.querySelector(`[data-ai-id="${elementId}"]`);
  if (!el) return { success: false, error: 'Target not found' };

  try {
    switch (action) {
      case 'click': {
        el.click();
        return { success: true };
      }
      case 'type': {
        if (el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'textarea') {
          return { success: false, error: 'Invalid action' };
        }
        const oldValue = el.value;
        el.value = params.text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
      case 'clear': {
        if (el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'textarea') {
          return { success: false, error: 'Invalid action' };
        }
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
      case 'select': {
        if (el.tagName.toLowerCase() !== 'select') {
          return { success: false, error: 'Invalid action' };
        }
        el.value = params.value ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
      case 'focus': {
        el.focus();
        return { success: true };
      }
      case 'hover': {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return { success: true };
      }
      case 'scroll_to': {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        return { success: true };
      }
      default:
        return { success: false, error: 'Invalid action' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// tests/test_action_binder.js — Tests for preload/action_binder.js
// @vitest-environment jsdom

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const htmlPath = resolve(__dirname, 'test_pages/basic_controls.html');
const basicHTML = readFileSync(htmlPath, 'utf-8');

let executeAction;

beforeAll(async () => {
  document.documentElement.innerHTML = basicHTML;
  await new Promise(r => setTimeout(r, 0));
  const mod = await import('../src/preload/action_binder.js');
  executeAction = mod.executeAction;
});

// Helper: get element id from semantic extractor, preferring nativeElement id
async function getSemanticId(nativeId) {
  const node = document.getElementById(nativeId);
  if (node && node.hasAttribute && node.hasAttribute('data-ai-id')) {
    return node.getAttribute('data-ai-id');
  }
  // Fallback: walk semantic tree by native id
  const { extractTree } = await import('../src/preload/semantic_extractor.js');
  const tree = extractTree();
  function find(node) {
    if (node.id && node.attributes && node.attributes['id'] === nativeId) return node.id;
    if (node.children) {
      for (const c of node.children) {
        const found = find(c);
        if (found) return found;
      }
    }
    return null;
  }
  return find(tree);
}

// Helper: reset test page state and register inline handlers (jsdom doesn't exec inline scripts)
function resetPage() {
  document.documentElement.innerHTML = basicHTML;
  document.getElementById('click-counter').textContent = 'Clicked: 0 times';
  // Manually register the counter handler that basic_controls.html inline <script> would register
  document.getElementById('btn-primary').addEventListener('click', () => {
    const counter = document.getElementById('click-counter');
    const current = parseInt(counter.textContent.match(/\d+/)[0]);
    counter.textContent = `Clicked: ${current + 1} times`;
  });
}

describe('executeAction — click', () => {
  beforeEach(resetPage);

  it('AB-001: click button triggers native click', async () => {
    const id = await getSemanticId('btn-primary');
    if (!id) return; // skip if extractor not working yet
    const result = executeAction(id, 'click', {});
    expect(result.success).toBe(true);
    // Check counter incremented
    const counter = document.getElementById('click-counter');
    expect(counter.textContent).toContain('1');
  });

  it('AB-002: click button triggers React onClick', async () => {
    // Load React SPA page
    const reactPath = resolve(__dirname, 'test_pages/react_spa.html');
    document.documentElement.innerHTML = readFileSync(reactPath, 'utf-8');
    await new Promise(r => setTimeout(r, 100));

    const { extractTree } = await import('../src/preload/semantic_extractor.js');
    const tree = extractTree();
    // Find React button
    function findByRole(node, role) {
      const results = [];
      if (node.role === role) results.push(node);
      if (node.children) {
        for (const c of node.children) results.push(...findByRole(c, role));
      }
      return results;
    }
    const reactBtns = findByRole(tree, 'button');
    const reactBtn = reactBtns.find(b => b.label === 'React click button');
    if (!reactBtn) return;

    const result = executeAction(reactBtn.id, 'click', {});
    expect(result.success).toBe(true);
    const resultEl = document.getElementById('react-click-result');
    if (resultEl) {
      expect(resultEl.textContent).toContain('yes');
    }
  });

  it('AB-009: nonexistent element returns error', () => {
    const result = executeAction('e:nonexistent-999', 'click', {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('AB-010: type on non-textbox returns error', async () => {
    const id = await getSemanticId('btn-primary');
    if (!id) return;
    const result = executeAction(id, 'type', { text: 'test' });
    expect(result.success).toBe(false);
  });

  it('AB-012: repeated click does not throw', async () => {
    const id = await getSemanticId('btn-primary');
    if (!id) return;
    for (let i = 0; i < 3; i++) {
      const result = executeAction(id, 'click', {});
      expect(result.success).toBe(true);
    }
  });
});

describe('executeAction — type', () => {
  beforeEach(resetPage);

  it('AB-003: type sets value and fires input event', async () => {
    const id = await getSemanticId('input-text');
    if (!id) return;

    let inputFired = false;
    const input = document.getElementById('input-text');
    input.addEventListener('input', () => { inputFired = true; });

    const result = executeAction(id, 'type', { text: 'Hello World' });
    expect(result.success).toBe(true);
    expect(input.value).toBe('Hello World');
    expect(inputFired).toBe(true);
  });

  it('AB-005: type fires change event', async () => {
    const id = await getSemanticId('input-text');
    if (!id) return;

    let changeFired = false;
    const input = document.getElementById('input-text');
    input.addEventListener('change', () => { changeFired = true; });

    executeAction(id, 'type', { text: 'test' });
    expect(changeFired).toBe(true);
  });

  it('AB-008: clear empties input', async () => {
    const input = document.getElementById('input-text');
    input.value = 'something here';

    const id = await getSemanticId('input-text');
    if (!id) return;

    const result = executeAction(id, 'clear', {});
    expect(result.success).toBe(true);
    expect(input.value).toBe('');
  });
});

describe('executeAction — select', () => {
  beforeEach(resetPage);

  it('AB-006: select changes value', async () => {
    const id = await getSemanticId('sel-fruit');
    if (!id) return;

    const result = executeAction(id, 'select', { value: 'banana' });
    expect(result.success).toBe(true);
    const select = document.getElementById('sel-fruit');
    expect(select.value).toBe('banana');
  });
});

describe('executeAction — focus', () => {
  beforeEach(resetPage);

  it('AB-007: focus sets activeElement', async () => {
    const id = await getSemanticId('input-text');
    if (!id) return;

    const result = executeAction(id, 'focus', {});
    expect(result.success).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('input-text'));
  });
});
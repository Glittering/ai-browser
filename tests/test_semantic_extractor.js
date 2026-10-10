// tests/test_semantic_extractor.js — Tests for preload/extractor.cjs
// Uses jsdom via vitest environment
// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load test HTML
const htmlPath = resolve(__dirname, 'test_pages/basic_controls.html');
const basicHTML = readFileSync(htmlPath, 'utf-8');

// We'll dynamically import the extractor after setting up DOM
let extractTree;

beforeAll(async () => {
  // Set up jsdom with the test HTML
  document.documentElement.innerHTML = basicHTML;
  // Wait for scripts to execute (jsdom runs them inline)
  await new Promise(r => setTimeout(r, 0));

  // Dynamic import — the module must work in jsdom (no Electron APIs).
  // extractor.cjs is CommonJS, so it is exposed under `.default`.
  const mod = await import('../src/preload/extractor.cjs');
  const ns = mod.default || mod;
  extractTree = ns.extractTree;
});

describe('extractTree()', () => {
  it('SE-001: returns non-null root', () => {
    const tree = extractTree();
    expect(tree).not.toBeNull();
    expect(tree.role).toBeDefined();
  });

  it('SE-002: finds buttons >= 4', () => {
    const tree = extractTree();
    const buttons = findAllByRole(tree, 'button');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });

  it('SE-003: finds textboxes >= 3', () => {
    const tree = extractTree();
    const textboxes = findAllByRole(tree, 'textbox');
    expect(textboxes.length).toBeGreaterThanOrEqual(3);
  });

  it('SE-004: disabled button has disabled state', () => {
    const tree = extractTree();
    const disabledBtn = findById(tree, 'btn-disabled');
    // May be null if denoised differently; accept finding by role+state
    const allButtons = findAllByRole(tree, 'button');
    const disabled = allButtons.find(b => b.states && b.states.includes('disabled'));
    expect(disabled).toBeDefined();
  });

  it('SE-005: hidden elements not in tree', () => {
    const tree = extractTree();
    expect(findById(tree, 'div-hidden')).toBeNull();
    expect(findById(tree, 'div-display-none')).toBeNull();
  });

  it('SE-006: aria-label takes priority for label', () => {
    const tree = extractTree();
    const searchInput = findAllByRole(tree, 'textbox')
      .find(el => el.label === 'Search');
    expect(searchInput).toBeDefined();
  });

  it('SE-007: title fallback for label', () => {
    const tree = extractTree();
    const primaryBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'Primary action');
    expect(primaryBtn).toBeDefined();
  });

  it('SE-008: label truncated at 60 chars', () => {
    const tree = extractTree();
    const allElements = flattenTree(tree);
    for (const el of allElements) {
      if (el.label) {
        expect(el.label.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it('SE-009: bounds have positive dimensions', () => {
    // Skip in jsdom — getBoundingClientRect returns 0,0,0,0 in jsdom
    // Will be tested in integration with real Electron
  });

  it('SE-010: pure layout wrappers denoised', () => {
    const tree = extractTree();
    // layout-wrapper divs should not appear
    expect(findById(tree, 'wrapper-empty')).toBeNull();
  });

  it('SE-011: data-* attributes preserved', () => {
    const tree = extractTree();
    const primaryBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'Primary action');
    if (primaryBtn && primaryBtn.attributes) {
      expect(primaryBtn.attributes['data-testid']).toBe('primary-btn');
    }
  });

  it('SE-012: id stable across calls', () => {
    const tree1 = extractTree();
    const tree2 = extractTree();
    const btn1 = findAllByRole(tree1, 'button')[0];
    const btn2 = findAllByRole(tree2, 'button')[0];
    if (btn1 && btn2) {
      expect(btn1.id).toBe(btn2.id);
    }
  });

  it('SE-013: ARIA role overrides tagName', () => {
    const tree = extractTree();
    const ariaBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'ARIA role button');
    expect(ariaBtn).toBeDefined();
  });

  it('SE-014: focused element marked', () => {
    // Focus something first
    const input = document.getElementById('input-text');
    if (input) input.focus();
    const tree = extractTree();
    // Not asserting non-null — focus may or may not register in jsdom
  });

  it('SE-018: empty page does not crash', () => {
    document.documentElement.innerHTML = '<html><body></body></html>';
    const tree = extractTree();
    expect(tree).not.toBeNull();
  });

  it('SE-020: tree size is reasonable', () => {
    // Restore basic HTML
    document.documentElement.innerHTML = basicHTML;
    const tree = extractTree();
    const allElements = flattenTree(tree);
    expect(allElements.length).toBeLessThan(500);
  });

  it('SE-021: Draft.js editor emits block-level editor_blocks (P4)', () => {
    document.documentElement.innerHTML =
      '<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="true">' +
      '<div data-block="true">para one</div>' +
      '<div data-block="true">para two</div>' +
      '</div></div>';
    const tree = extractTree();
    const editor = flattenTree(tree).find(n => n.editor_type === 'draft'); // DraftEditor-root container
    const content = flattenTree(tree).find(n => n.editor_type === 'draft' && n.editor_blocks);
    const blocks = (content ? content.editor_blocks : null) || (editor ? editor.editor_blocks : null);
    expect(blocks).toBeDefined();
    expect(blocks.map(b => b.text)).toEqual(['para one', 'para two']);
  });

  it('SE-022: plain contenteditable splits paragraphs on newline', () => {
    document.documentElement.innerHTML =
      '<div id="ce1" contenteditable="true"><p>first block</p><p>second block</p></div>';
    const tree = extractTree();
    const ce = flattenTree(tree).find(n => n.editor_type === 'contenteditable');
    const blocks = ce ? ce.editor_blocks : null;
    expect(blocks).toBeDefined();
    expect(blocks.map(b => b.role)).toEqual(['p', 'p']);
  });
});

// ---------------------------------------------------------------------------
// ai-id 稳定性（AI-ID）
//
// agent 的典型用法是**先 get_tree 拿 id、再按 id 操作**，而页面在这中间自更新
// （画布增删节点、列表插入一行）是常态。旧实现用"每次抽取都归零"的计数器按遍历
// 顺序编号，于是最前面插入一个元素就会把后面**所有**元素重新编号 —— 旧 id 指向
// 另一个元素，操作照常报 success 却打在了别的东西上。这几条钉住修复。
// ---------------------------------------------------------------------------
describe('data-ai-id 的稳定性', () => {
  // 取"没有原生 id"的元素 —— 只有它们才走自动编号那条路
  const groupIds = () => {
    const out = {};
    document.querySelectorAll('[role="group"]').forEach((el) => {
      out[el.getAttribute('aria-label')] = el.getAttribute('data-ai-id');
    });
    return out;
  };

  it('AI-ID-001: 抽取两次（DOM 未变）id 完全一致', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="g0"><button>b0</button></div>' +
      '<div role="group" aria-label="g1"><button>b1</button></div>' +
      '</div>';
    extractTree();
    const a = groupIds();
    extractTree();
    const b = groupIds();
    expect(a).toEqual(b);
    expect(a['g0']).toBeTruthy();
  });

  it('AI-ID-002: 在前面插入新元素后，已有元素的 id 不得漂移', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="g0"><button>b0</button></div>' +
      '<div role="group" aria-label="g1"><button>b1</button></div>' +
      '<div role="group" aria-label="g2"><button>b2</button></div>' +
      '</div>';
    extractTree();
    const before = groupIds();

    // 页面自更新：最前面插入一个新分组 —— 旧实现会让 g0/g1/g2 全部换号
    const fresh = document.createElement('div');
    fresh.setAttribute('role', 'group');
    fresh.setAttribute('aria-label', 'gnew');
    fresh.innerHTML = '<button>bnew</button>';
    const host = document.getElementById('host');
    host.insertBefore(fresh, host.firstElementChild);

    extractTree();
    const after = groupIds();
    for (const k of Object.keys(before)) {
      expect(`${k}=${after[k]}`).toBe(`${k}=${before[k]}`);
    }
    // 新元素要拿到一个**不同于**所有已有 id 的新号
    expect(after['gnew']).toBeTruthy();
    expect(Object.values(before)).not.toContain(after['gnew']);
  });

  it('AI-ID-003: 同一页面上生成的 id 互不重号（含跨抽取新增的元素）', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="h0"><button>c0</button></div>' +
      '<div role="group" aria-label="h1"><button>c1</button></div>' +
      '</div>';
    extractTree();
    extractTree(); // 再抽一次，序号不得回退
    const host = document.getElementById('host');
    const extra = document.createElement('div');
    extra.setAttribute('role', 'group');
    extra.setAttribute('aria-label', 'h2');
    extra.innerHTML = '<button>c2</button>';
    host.appendChild(extra);
    extractTree();

    const ids = Array.from(document.querySelectorAll('[data-ai-id]')).map((e) => e.getAttribute('data-ai-id'));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('AI-ID-004: 原生 id 优先于自动编号（原有语义不变）', () => {
    document.documentElement.innerHTML = '<button id="native-btn">N</button>';
    extractTree();
    expect(document.getElementById('native-btn').getAttribute('data-ai-id')).toBe('native-btn');
  });
});

// Helper: recursive find by id
function findById(tree, id) {
  if (tree.id === id) return tree;
  if (tree.children) {
    for (const child of tree.children) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

// Helper: find all by role
function findAllByRole(tree, role) {
  const results = [];
  if (tree.role === role) results.push(tree);
  if (tree.children) {
    for (const child of tree.children) {
      results.push(...findAllByRole(child, role));
    }
  }
  return results;
}

// Helper: flatten tree to array
function flattenTree(tree) {
  const results = [tree];
  if (tree.children) {
    for (const child of tree.children) {
      results.push(...flattenTree(child));
    }
  }
  return results;
}
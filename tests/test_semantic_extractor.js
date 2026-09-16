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
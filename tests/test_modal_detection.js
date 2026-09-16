// Modal detection regression tests — regression for the B站 cover-crop modal
// that was silently dropped because it is position:fixed (offsetParent === null).
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const htmlPath = resolve(__dirname, 'test_pages/basic_controls.html');
document.documentElement.innerHTML = readFileSync(htmlPath, 'utf-8');

let ns;
beforeAll(async () => {
  ns = (await import('../src/preload/extractor.cjs'))?.default;
});

// jsdom does not run real layout: getClientRects/getBoundingClientRect all return 0.
// Emulate a genuinely rendered (position:fixed) overlay/button by stubbing geometry,
// which fixes the case that regressed: a visible fixed overlay must NOT be skipped.
function stubRendered(el) {
  const rect = { width: 400, height: 300 };
  el.getClientRects = () => [rect];
  el.getBoundingClientRect = () => Object.assign({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300 }, rect);
  return el;
}

describe('extractPageContext() modal detection', () => {
  it('ME-001: detects a visible position:fixed modal with a confirm button', async () => {
    document.querySelectorAll('#repro-modal').forEach(e => e.remove());
    const m = document.createElement('div');
    m.id = 'repro-modal';
    // NOTE: class deliberately carries NO modal/dialog/popup/mask keyword except "mask"
    m.className = 'cover-crop-mask';
    m.style.position = 'fixed';
    m.style.left = '0'; m.style.top = '0'; m.style.width = '400px'; m.style.height = '300px';
    m.innerHTML = '<button type="button">确 定</button>';
    document.body.appendChild(m);
    stubRendered(m);

    const ctx = ns.extractPageContext();
    const btnText = JSON.stringify((ctx.modals || []).map(x => x.buttons));
    expect(btnText.replace(/\s/g, '')).toContain('确定');
  });

  it('ME-002: does not report a hidden (display:none) modal', async () => {
    document.querySelectorAll('#repro-modal').forEach(e => e.remove());
    const m = document.createElement('div');
    m.id = 'repro-modal';
    m.className = 'modal';
    m.style.display = 'none';
    m.innerHTML = '<button>hidden confirm</button>';
    document.body.appendChild(m);
    // do NOT stub geometry: it should be treated as hidden

    const ctx = ns.extractPageContext();
    const hasModal = (ctx.modals || []).some(x =>
      JSON.stringify(x.buttons).indexOf('hidden confirm') >= 0);
    expect(hasModal).toBe(false);
  });
});
// tests/test_paste_action.js — preload doPaste 分支覆盖（jsdom + 最小 polyfill）
// jsdom 没有 DataTransfer/ClipboardEvent，注入刚够用的最小实现来真实走
// doPaste 的逻辑（而不是把函数体抄进测试——那测的是抄本，不是代码）。
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

// ---- 最小 polyfill：只实现 doPaste 用到的面 ----
class FakeDataTransfer {
  constructor() { this._d = new Map(); }
  setData(t, v) { this._d.set(t, String(v)); }
  getData(t) { return this._d.has(t) ? this._d.get(t) : ''; }
}
class FakeClipboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, { bubbles: init.bubbles !== false, cancelable: init.cancelable !== false, composed: init.composed !== false });
    this.clipboardData = init.clipboardData || null;
  }
}
beforeAll(() => {
  window.DataTransfer = FakeDataTransfer;
  window.ClipboardEvent = FakeClipboardEvent;
});

let actions;
beforeAll(async () => {
  const mod = await import('../src/preload/actions.cjs');
  actions = mod.default || mod;
});

function makeEditor() {
  document.body.innerHTML = '<div id="ed" data-ai-id="ed" contenteditable="true"></div>';
  return document.getElementById('ed');
}

describe('doPaste — preload rich-text injection', () => {
  it('PST-1: html payload reaches the paste listener as text/html (format survives)', () => {
    const ed = makeEditor();
    let seenHtml = null, seenText = null;
    ed.addEventListener('paste', (ev) => {
      seenHtml = ev.clipboardData.getData('text/html');
      seenText = ev.clipboardData.getData('text/plain');
      ev.preventDefault();
    });
    const r = actions.executeAction('ed', 'paste', { html: '<h2>标题</h2><pre><code>x=1</code></pre>' });
    expect(r.success).toBe(true);
    expect(seenHtml).toBe('<h2>标题</h2><pre><code>x=1</code></pre>');
    // text/plain 兜底由 html 剥标签生成 —— 编辑器拿不到 html 时仍有可读内容
    expect(seenText).toContain('标题');
    expect(seenText).toContain('x=1');
  });

  it('PST-2: text-only payload uses text verbatim (no tag stripping needed)', () => {
    const ed = makeEditor();
    let seenText = null;
    ed.addEventListener('paste', (ev) => { seenText = ev.clipboardData.getData('text/plain'); ev.preventDefault(); });
    const r = actions.executeAction('ed', 'paste', { text: '纯文本 内容' });
    expect(r.success).toBe(true);
    expect(seenText).toBe('纯文本 内容');
  });

  it('PST-3: html takes precedence over text when both given', () => {
    const ed = makeEditor();
    let seenHtml = null;
    ed.addEventListener('paste', (ev) => { seenHtml = ev.clipboardData.getData('text/html'); ev.preventDefault(); });
    actions.executeAction('ed', 'paste', { html: '<b>rich</b>', text: 'plain' });
    expect(seenHtml).toBe('<b>rich</b>');
  });

  it('PST-4: empty payload is a caller bug — explicit error, never silent success', () => {
    makeEditor();
    const r = actions.executeAction('ed', 'paste', {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('neither html nor text');
  });

  it('PST-5: unconsumed paste (defaultPrevented=false) reports failure with a next step', () => {
    const ed = makeEditor();
    // 不注册监听器 = 没人接管 = notPrevented=true
    const r = actions.executeAction('ed', 'paste', { html: '<p>x</p>' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('not consumed');
  });

  it('PST-6: non-editable target is rejected by name (not a generic failure)', () => {
    document.body.innerHTML = '<div id="plain" data-ai-id="plain">just text</div>';
    const r = actions.executeAction('plain', 'paste', { text: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('editable');
  });

  it('PST-7: paste targets an editor nested inside the node (Draft.js wrappers)', () => {
    document.body.innerHTML = '<div id="wrap" data-ai-id="wrap"><div class="public-DraftEditor-content" contenteditable="true"></div></div>';
    const inner = document.querySelector('.public-DraftEditor-content');
    let seen = null;
    inner.addEventListener('paste', (ev) => { seen = ev.clipboardData.getData('text/html'); ev.preventDefault(); });
    const r = actions.executeAction('wrap', 'paste', { html: '<h3>nested</h3>' });
    expect(r.success).toBe(true);
    expect(seen).toBe('<h3>nested</h3>');
  });
});

// ---- deadline 预算：paste 按 payload 给余量（纯函数）----
import { actionDeadlineMs, DEFAULT_ACTION_DEADLINE_MS } from '../src/shared/deadline.js';

describe('actionDeadlineMs — paste budget', () => {
  it('PST-DL-1: small payload gets the floor (>= default)', () => {
    expect(actionDeadlineMs('paste', { html: '<p>hi</p>' })).toBeGreaterThanOrEqual(DEFAULT_ACTION_DEADLINE_MS);
  });

  it('PST-DL-2: large payload scales up (editor paste pipelines are slow on big docs)', () => {
    const small = actionDeadlineMs('paste', { html: '<p>x</p>' });
    const big = actionDeadlineMs('paste', { html: '<p>' + 'x'.repeat(100000) + '</p>' });
    expect(big).toBeGreaterThan(small);
  });

  it('PST-DL-3: explicit timeout_ms still wins (escape hatch intact)', () => {
    expect(actionDeadlineMs('paste', { html: 'x'.repeat(100000), timeout_ms: 1234 })).toBe(1234);
  });
});

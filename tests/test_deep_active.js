// tests/test_deep_active.js — 「真正的焦点元素」必须穿透 shadow root。
// @vitest-environment jsdom
//
// 背景（2026-10-17 真实站点）：B站 评论框的 contenteditable 在 <bili-rich-text>
// 的 shadow root 里。type 打完之后校验用 `document.activeElement` 读回内容，
// 读到的是**宿主**（里面没有文本），于是返回
//   {"success":false,"error":"Input not verified","actual_chars":0}
// 而实际内容已经完整落地。调用方看到这个结论会再打一次 → **重复输入**。
// 这比直接报错更糟：它看起来像"上次没成功"。
//
// 修法：沿 shadowRoot.activeElement 下钻。这个文件钉住这条链，并钉住
// extractor 的 focused 状态 / focused_element_id 用的是同一个口径。

import { describe, it, expect, beforeAll } from 'vitest';

let deepActiveExpr;
let extractTree;

beforeAll(async () => {
  Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.dataset && this.dataset.w ? this.dataset.w : 100);
    const h = Number(this.dataset && this.dataset.h ? this.dataset.h : 40);
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  };
  const da = await import('../src/shared/deep_active.cjs');
  deepActiveExpr = (da.default || da).deepActiveExpr;
  const ex = await import('../src/preload/extractor.cjs');
  extractTree = (ex.default || ex).extractTree;
});

// 把表达式字符串当页面脚本执行（和主进程注入的方式等价）
function runExpr(expr) {
  // eslint-disable-next-line no-new-func
  return new Function('document', 'window', `return ${expr};`)(document, window);
}

function flatten(n, out = []) {
  if (!n) return out;
  out.push(n);
  (n.children || []).forEach((c) => flatten(c, out));
  return out;
}

// jsdom 的 ShadowRoot 没有实现 activeElement（真实浏览器有）。
// 这里补一个**只在测试里**的最小实现：焦点落到 shadow 内元素时，shadow root
// 的 activeElement 指向它。这正是规范行为，不是为了迁就被测代码。
function installShadowActiveElement() {
  if (typeof ShadowRoot === 'undefined') return;
  if (Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'activeElement')) return;
  Object.defineProperty(ShadowRoot.prototype, 'activeElement', {
    configurable: true,
    get() {
      const els = this.querySelectorAll ? this.querySelectorAll('*') : [];
      for (const el of els) {
        if (el.__focused) return el;
        if (el.shadowRoot && el.shadowRoot.activeElement) return el.shadowRoot.activeElement;
      }
      return null;
    },
  });
}

function focusIn(el) {
  el.focus();
  el.__focused = document.activeElement === el || true;
}

describe('DA 真正的焦点元素（穿透 shadow）', () => {
  it('DA-1: 没有 shadow 时就是 document.activeElement', () => {
    document.body.innerHTML = '<input id="i1">';
    const i1 = document.getElementById('i1');
    i1.focus();
    expect(runExpr(deepActiveExpr())).toBe(document.activeElement);
  });

  it('DA-2: 焦点在 shadow 里的 input 上，取到的是那个 input 而不是宿主', () => {
    installShadowActiveElement();
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id="inner">';
    const inner = sr.querySelector('#inner');
    focusIn(inner);
    const got = runExpr(deepActiveExpr());
    expect(document.activeElement).toBe(host); // 顶层的真相：只到宿主
    expect(got).toBeTruthy();
    expect(got.id, '必须穿透到 shadow 里的那个 input').toBe('inner');
  });

  it('DA-3: 三层嵌套 shadow 也能取到最里层', () => {
    installShadowActiveElement();
    document.body.innerHTML = '<div id="h1"></div>';
    const h1 = document.getElementById('h1');
    const s1 = h1.attachShadow({ mode: 'open' });
    s1.innerHTML = '<div id="h2"></div>';
    const h2 = s1.querySelector('#h2');
    const s2 = h2.attachShadow({ mode: 'open' });
    s2.innerHTML = '<div id="h3"></div>';
    const h3 = s2.querySelector('#h3');
    const s3 = h3.attachShadow({ mode: 'open' });
    s3.innerHTML = '<textarea id="deep"></textarea>';
    focusIn(s3.querySelector('#deep'));
    const got = runExpr(deepActiveExpr());
    expect(got && got.id).toBe('deep');
  });

  it('DA-4: 没有焦点时返回 body（不抛错、不返回 undefined）', () => {
    document.body.innerHTML = '<p>无焦点</p>';
    const got = runExpr(deepActiveExpr());
    expect(got).toBeTruthy();
    expect(got).toBe(document.body);
  });

  it('DA-5: extractor 的 focused 状态与 focused_element_id 用同一口径', () => {
    installShadowActiveElement();
    document.body.innerHTML = '<div id="host2"></div>';
    const host = document.getElementById('host2');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<textarea id="ta">内容</textarea>';
    focusIn(sr.querySelector('#ta'));

    const tree = extractTree();
    const nodes = flatten(tree);
    const ta = nodes.find((n) => n.role === 'textbox');
    expect(ta, 'shadow 里的 textarea 应该在树里').toBeTruthy();
    expect(ta.states || [], '它应该被标成 focused').toContain('focused');
    expect(tree.focused_element_id, 'focused_element_id 应指向 shadow 内的节点').toBe(ta.id);
    // 宿主本身不该被标成 focused（它不是接收输入的那个节点）
    const hostNode = nodes.find((n) => n.id === 'host2');
    expect(hostNode, '宿主是纯布局 div，不会单独成节点').toBeFalsy();
  });
});

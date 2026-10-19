// tests/test_label_rendered_text.js — label 必须是"看得见的文字"
//
// 背景（2026-10-19 受控页面实测）：`extractLabel` 原来用裸 `textContent`，
// 于是**不渲染的东西**也进了 label，而 label 是直接给 agent 当"这个元素写着
// 什么"读的。实测两类泄漏：
//   1. `<div style="display:none">…说明文字…</div>` 整段进了父节点 label；
//   2. `<canvas>` 页面的容器 label 里装的是 `<script>` 的 JS 源码。
// 更根本的是口径问题：文字覆盖率的分母用 innerText，分子来自 label，
// label 用 textContent 就是"分子分母两把尺子"。
//
// ⚠️ 这套测试的边界必须说清楚：**jsdom 没有实现 innerText**，
// 所以真实浏览器里的行为在这里无法端到端复现。这里能钉住的只有"选择逻辑"：
// 元素身上有 innerText 时用它，没有时回退 textContent。
// 真实浏览器里的效果（泛雅 label 551→289 字、coverage 不变、耗时不变）
// 只能靠实机验证，测试替代不了 —— 这条注释就是防止以后有人以为测试cover了它。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

let extractTree;

// jsdom 不跑布局：getClientRects() 恒空、getBoundingClientRect() 恒 0，
// 而可见性判定两者都看。给全文档补几何，让元素能被判为可见。
function renderAll() {
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    els[i].getClientRects = () => [{ width: 100, height: 20 }];
    els[i].getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20,
    });
  }
}

function findByRole(tree, role) {
  if (!tree) return null;
  if (tree.role === role) return tree;
  for (const c of tree.children || []) {
    const hit = findByRole(c, role);
    if (hit) return hit;
  }
  return null;
}

/** 在元素实例上伪造 Chrome 的 innerText 语义（只返回渲染后可见的文字）。 */
function fakeInnerText(el, text) {
  Object.defineProperty(el, 'innerText', { configurable: true, get: () => text });
}

describe('extractLabel 的文字口径', () => {
  beforeEach(async () => {
    const mod = await import('../src/preload/extractor.cjs');
    extractTree = (mod.default || mod).extractTree;
  });

  it('LBL-1: 元素有 innerText 时用它，display:none 里的字不进 label', () => {
    document.body.innerHTML =
      '<a id="t" href="/x">可见文字<span style="display:none">这段藏在 display:none 里</span></a>';
    renderAll();
    const el = document.getElementById('t');
    // 真实浏览器里 innerText 会是 "可见文字"：子 span 不渲染，被排除。
    fakeInnerText(el, '可见文字');
    const label = findByRole(extractTree(), 'link').label;
    expect(label).toBe('可见文字');
    expect(label).not.toContain('display:none');
  });

  it('LBL-2: 阳性对照 —— 没有 innerText 时回退 textContent（不许让元素变无声）', () => {
    // 同一条 HTML，只是不伪造 innerText（jsdom 默认 undefined）。
    // 这条不证明"回退是对的"，只证明"回退确实发生了" —— 没有它，
    // LBL-1 无法排除"label 本来就不含那段字"这种可能。
    document.body.innerHTML =
      '<a id="t" href="/x">可见文字<span style="display:none">这段藏在 display:none 里</span></a>';
    renderAll();
    const label = findByRole(extractTree(), 'link').label;
    expect(label).toContain('可见文字');
    expect(label).toContain('display:none');
  });

  it('LBL-3: innerText 为空时回退 textContent（<option> 这类元素）', () => {
    // Chrome 里 <option> 的 innerText 常常是空串，而它的文字是有效的可访问名。
    // 空串必须被当作"没有值"而不是"这个元素没有名字"。
    document.body.innerHTML = '<select id="s"><option id="o">北京</option></select>';
    renderAll();
    const opt = document.getElementById('o');
    fakeInnerText(opt, '');
    const tree = extractTree();
    const labels = [];
    (function walk(n) { if (!n) return; if (n.label) labels.push(n.label); (n.children || []).forEach(walk); })(tree);
    expect(labels.join('|')).toContain('北京');
  });

  it('LBL-4: label 仍然截断到 60 字（token 预算没被 innerText 打破）', () => {
    document.body.innerHTML = '<a id="t" href="/x">占位</a>';
    renderAll();
    fakeInnerText(document.getElementById('t'), '很长的文字'.repeat(40));
    const label = findByRole(extractTree(), 'link').label;
    expect(label.length).toBe(60);
  });
});

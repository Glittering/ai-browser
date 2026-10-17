// tests/test_click_boundary.js — 「人看着能点」的元素要进语义树，但不能重复收、也不能收无名货。
// @vitest-environment jsdom
//
// 背景（2026-10-17 实测，见 docs/AGENT_OPERABILITY_FEEDBACK.md 第 6 节）：
// 抽取层判可点性用的是 `typeof el.onclick === "function"`，而 Vue/React 一律走
// addEventListener —— 元素上的 onclick **属性**恒为 null。加上 isPureLayout 对裸
// div/span 一刀切，这类元素两条路都不通。实测 CSDN 顶部 10 个导航项、
// 百度「下载/辅助」、B站搜索按钮全部看不见。
//
// 修法是把判据换成渲染结果（cursor:pointer + 可见尺寸 + 可读名字），并加两条约束：
// ① 只收手型边界（父元素不是 pointer），否则可继承的 cursor 会让语义树膨胀 3 倍；
// ② 外层只是单个交互元素的外壳时不重复收（否则树里两个同名「首页」）。
//
// 这几条都容易在后续重构里被"优化掉"，所以必须有回归钉住。
//
// 关于 cursor 的处理：jsdom 的 getComputedStyle 不保证按 CSS 继承算 cursor，
// 所以下面凡是"子元素继承到了 pointer"的场景，都直接给子元素也写 inline
// `cursor:pointer`（这与真实浏览器里子元素的计算值完全一致），让判据在
// 不依赖 jsdom 继承实现的前提下被确定性地验证。

import { describe, it, expect, beforeAll } from 'vitest';

let extractTree;

// jsdom 的 getBoundingClientRect 恒为 0，会让"可见尺寸"判据把所有元素都否掉。
// 用 data-w/data-h/data-x/data-y 表达盒子，测试里就能精确控制"盖满/没盖满"。
function rectOf(el) {
  const w = Number(el.dataset.w ?? 100);
  const h = Number(el.dataset.h ?? 40);
  const x = Number(el.dataset.x ?? 0);
  const y = Number(el.dataset.y ?? 0);
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

beforeAll(async () => {
  Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  const mod = await import('../src/preload/extractor.cjs');
  const ns = mod.default || mod;
  extractTree = ns.extractTree;
});

function flatten(n, out = []) {
  if (!n) return out;
  out.push(n);
  (n.children || []).forEach((c) => flatten(c, out));
  return out;
}

function nodeById(tree, id) {
  return flatten(tree).find((n) => n.id === id) || null;
}

function labelNodes(tree, label) {
  // 排除根节点：根是 document.body，它的 label 取自整页文本，会命中任何查询词
  return flatten(tree).filter((n) => n !== tree && String(n.label || '').trim() === label);
}

describe('CB 手型边界 —— 人看着能点的裸 div/span', () => {
  it('CB-1: 裸 div + cursor:pointer + addEventListener + 文本 → 进树，自述 click', () => {
    document.body.innerHTML =
      '<div id="nav" class="layout-menu-item" style="cursor:pointer" data-w="232" data-h="36">博客</div>';
    // 模拟框架写法：只有 addEventListener，没有 onclick 属性
    document.getElementById('nav').addEventListener('click', () => {});
    expect(document.getElementById('nav').onclick).toBeNull();   // 前提：属性确实是空

    const n = nodeById(extractTree(), 'nav');
    expect(n, '只挂 addEventListener 的可点 div 必须进树').toBeTruthy();
    expect(n.actions || []).toContain('click');
    expect(String(n.label).trim()).toBe('博客');
  });

  it('CB-2: 阴性对照 —— 同样的 div 但没有 pointer → 不进树', () => {
    document.body.innerHTML =
      '<div id="plain" style="cursor:auto" data-w="232" data-h="36">博客</div>';
    expect(nodeById(extractTree(), 'plain')).toBeNull();
  });

  it('CB-3: 只收手型边界 —— 继承到 pointer 的后代不单独进树', () => {
    // 真实计算值：父子都是 pointer（cursor 可继承）。逐个收会让 CSDN 首页从
    // 254 个可点目标涨到 840 个节点，而它们点起来效果完全相同。
    document.body.innerHTML =
      '<div id="card" style="cursor:pointer" data-w="200" data-h="60">' +
      '  <span id="cardText" style="cursor:pointer" data-w="200" data-h="60">下载</span>' +
      '</div>';
    const tree = extractTree();
    expect(nodeById(tree, 'card'), '边界本身要进树').toBeTruthy();
    expect(nodeById(tree, 'cardText'), '边界内的后代不得重复进树').toBeNull();
  });

  it('CB-4: 外壳不重复收 —— div>(a 盖满) 只留 a，不留 div', () => {
    document.body.innerHTML =
      '<div id="menuItem" style="cursor:pointer" data-w="232" data-h="36">' +
      '  <a id="menuLink" href="/blog" style="cursor:pointer" data-w="232" data-h="36">博客</a>' +
      '</div>';
    const tree = extractTree();
    expect(nodeById(tree, 'menuLink'), '内层链接本来就在树里').toBeTruthy();
    expect(nodeById(tree, 'menuItem'), '外壳不得与内层重复').toBeNull();
    expect(labelNodes(tree, '博客').length, '同一个目标不得出现两个同名节点').toBe(1);
  });

  it('CB-5: 阳性对照 —— 大卡片里放小链接时，外层通路保留（两者是不同目标）', () => {
    document.body.innerHTML =
      '<div id="bigCard" style="cursor:pointer" data-w="400" data-h="300">整张卡片都能点' +
      '  <a id="smallLink" href="/x" style="cursor:pointer" data-w="80" data-h="20">详情</a>' +
      '</div>';
    const tree = extractTree();
    expect(nodeById(tree, 'bigCard'), '点卡片 ≠ 点卡片里的小链接，外层要留').toBeTruthy();
    expect(nodeById(tree, 'smallLink')).toBeTruthy();
  });

  it('CB-6: 无名且无图标 → 不进树（agent 拿到无名节点没法选）', () => {
    document.body.innerHTML =
      '<div id="anon" style="cursor:pointer" data-w="40" data-h="40"></div>';
    expect(nodeById(extractTree(), 'anon')).toBeNull();
  });

  it('CB-7: 只有图标、没有文本 → 进树', () => {
    document.body.innerHTML =
      '<div id="iconBtn" style="cursor:pointer" data-w="40" data-h="40">' +
      '  <svg width="16" height="16"></svg>' +
      '</div>';
    expect(nodeById(extractTree(), 'iconBtn'), '纯图标按钮也是真入口').toBeTruthy();
  });

  it('CB-8: 尺寸小到人手点不到（3×3）→ 不进树', () => {
    document.body.innerHTML =
      '<div id="dot" style="cursor:pointer" data-w="3" data-h="3">设置</div>';
    expect(nodeById(extractTree(), 'dot')).toBeNull();
  });

  it('CB-9: aria-label 可当作名字（不依赖文本）', () => {
    document.body.innerHTML =
      '<div id="ariaBtn" role="none" aria-label="搜索" style="cursor:pointer" data-w="40" data-h="40"></div>';
    const n = nodeById(extractTree(), 'ariaBtn');
    expect(n).toBeTruthy();
    expect(n.label).toBe('搜索');
  });

  it('CB-10: 不可见（display:none）优先于可点 —— 不进树', () => {
    document.body.innerHTML =
      '<div id="ghost" style="cursor:pointer;display:none" data-w="100" data-h="40">下载</div>';
    expect(nodeById(extractTree(), 'ghost')).toBeNull();
  });
});

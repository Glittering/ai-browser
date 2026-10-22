// tests/test_ax_editors.js — 树上「哪个 editable 才是正文」的消歧索引。
//
// 事故（2026-10-19 知乎）：顶部搜索框和正文编辑器都带 editable，按 editable
// 过滤先抓到搜索框（DOM 顺序在前），第一次 paste 直接糊进搜索框。树里那一行
// `[textbox] editable=richtext` 与正文那一行**长得一模一样**，agent 没有
// 任何依据可以选对。这个索引就是那份依据。
import { describe, it, expect } from 'vitest';
import { normalizeAxTree, summarizeEditors } from '../src/main/axExtractor.js';

const bool = (value) => ({ type: 'boolean', value });
const str = (value) => ({ type: 'string', value });
function node(id, role, name, { props = [], bounds = { x: 0, y: 0, width: 100, height: 40 }, childIds = [] } = {}) {
  return {
    nodeId: id, ignored: false, role: { value: role }, name: { value: name },
    properties: props, backendDOMNodeId: id + 1000, bounds, childIds,
  };
}

// 知乎式页面：搜索框在顶部、标题 input 其次、正文编辑器最大。
const ZHIHU = [
  node(1, 'rootWebArea', '', { bounds: { x: 0, y: 0, width: 1440, height: 900 }, childIds: [2, 3, 4] }),
  node(2, 'textbox', '搜索', {
    props: [{ name: 'editable', value: str('plaintext') }, { name: 'focusable', value: bool(true) },
      { name: 'placeholder', value: str('搜索你感兴趣的内容') }],
    bounds: { x: 900, y: 10, width: 300, height: 36 },
  }),
  node(3, 'textbox', '标题', {
    props: [{ name: 'editable', value: str('plaintext') }, { name: 'focusable', value: bool(true) }],
    bounds: { x: 100, y: 120, width: 720, height: 44 },
  }),
  node(4, 'generic', '', {
    props: [{ name: 'editable', value: str('richtext') }, { name: 'focusable', value: bool(true) }],
    bounds: { x: 100, y: 180, width: 720, height: 600 },
    childIds: [5],
  }),
  node(5, 'paragraph', '正文第一段', { bounds: { x: 100, y: 180, width: 700, height: 24 } }),
];

describe('tree.editors — 只在有歧义时出现', () => {
  it('ED-1 多个 editable → 树根带 editors，按面积降序', () => {
    const tree = normalizeAxTree(ZHIHU);
    expect(Array.isArray(tree.editors)).toBe(true);
    expect(tree.editors.length).toBe(3);
    const areas = tree.editors.map((e) => e.w * e.h);
    expect(areas).toEqual([...areas].sort((a, b) => b - a));
  });

  it('ED-2 面积最大的非搜索编辑区被标为 primary', () => {
    const tree = normalizeAxTree(ZHIHU);
    const primary = tree.editors.filter((e) => e.primary);
    expect(primary).toHaveLength(1);
    expect(primary[0].ref).toBe('ax-4'); // 正文容器
    expect(primary[0].editor_type).toBe('richtext');
    expect(primary[0].w).toBe(720);
    expect(primary[0].h).toBe(600);
  });

  it('ED-3 搜索框被标 searchlike（按 role / placeholder / label）', () => {
    const tree = normalizeAxTree(ZHIHU);
    const search = tree.editors.find((e) => e.ref === 'ax-2');
    expect(search.searchlike).toBe(true);
    expect(search.primary).toBeUndefined();
    expect(search.placeholder).toBe('搜索你感兴趣的内容');
  });

  it('ED-4 只有一个可编辑节点时不输出 editors（省 token）', () => {
    const tree = normalizeAxTree([
      node(1, 'rootWebArea', '', { childIds: [2] }),
      node(2, 'generic', '', {
        props: [{ name: 'editable', value: str('richtext') }],
        bounds: { x: 0, y: 0, width: 700, height: 500 },
      }),
    ]);
    expect(tree.editors).toBeUndefined();
  });

  it('ED-5 1px / 隐藏的表单元素不进清单', () => {
    const tree = normalizeAxTree([
      node(1, 'rootWebArea', '', { childIds: [2, 3] }),
      node(2, 'textbox', '', {
        props: [{ name: 'editable', value: str('plaintext') }],
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      }),
      node(3, 'generic', '', {
        props: [{ name: 'editable', value: str('richtext') }],
        bounds: { x: 0, y: 0, width: 700, height: 500 },
      }),
    ]);
    expect(tree.editors).toBeUndefined(); // 有效节点只剩 1 个
  });

  it('ED-6 只读编辑器不拿 primary', () => {
    const tree = normalizeAxTree([
      node(1, 'rootWebArea', '', { childIds: [2, 3] }),
      node(2, 'generic', '', {
        props: [{ name: 'editable', value: str('richtext') }, { name: 'read-only', value: bool(true) }],
        bounds: { x: 0, y: 0, width: 900, height: 700 },
      }),
      node(3, 'generic', '', {
        props: [{ name: 'editable', value: str('richtext') }, { name: 'focusable', value: bool(true) }],
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      }),
    ]);
    const primary = tree.editors.filter((e) => e.primary);
    expect(primary).toHaveLength(1);
    expect(primary[0].ref).toBe('ax-3'); // 次大的那个（可写）
    expect(tree.editors.find((e) => e.ref === 'ax-2').readonly).toBe(true);
  });

  it('ED-7 全是搜索框时不硬指 primary（首页场景）', () => {
    const tree = normalizeAxTree([
      node(1, 'rootWebArea', '', { childIds: [2, 3] }),
      node(2, 'searchbox', '搜索', {
        props: [{ name: 'editable', value: str('plaintext') }],
        bounds: { x: 0, y: 0, width: 400, height: 40 },
      }),
      node(3, 'textbox', '站内搜索', {
        props: [{ name: 'editable', value: str('plaintext') }],
        bounds: { x: 0, y: 60, width: 320, height: 36 },
      }),
    ]);
    expect(tree.editors.every((e) => !e.primary)).toBe(true);
  });
});

describe('summarizeEditors — 纯函数边界', () => {
  it('ED-8 空/单个 → undefined', () => {
    expect(summarizeEditors([])).toBeUndefined();
    expect(summarizeEditors(null)).toBeUndefined();
    expect(summarizeEditors([{ ref: 'a', area: 999999 }])).toBeUndefined();
  });

  it('ED-9 最多 8 条，area 不外露', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ref: 'ax-' + i, role: 'textbox', editor_type: 'textbox',
      label: '', w: 100, h: 100 + i, area: 100 * (100 + i), readonly: false,
    }));
    const out = summarizeEditors(many);
    expect(out).toHaveLength(8);
    expect(out[0].area).toBeUndefined();
    expect(out[0].ref).toBe('ax-11'); // 面积最大
  });
});

// tests/test_ax_extractor.js — AX read layer (P0) normalization contract.
// Pure Node test: feeds raw CDP Accessibility.AXNode[] (as observed in the
// feasibility probe: contenteditable->generic+editable=richtext, textarea->
// textbox+multiline, div[role=button] fake buttons, position:fixed modal dialog)
// and asserts the AX -> protocol TreeNode mapping + data-ai-id fusion.
import { describe, it, expect } from 'vitest';
import { normalizeAxTree, mergeFrameTrees, modalsFromAx, diffAx, filterInteractive, liteSnapshot, diffLite } from '../src/main/axExtractor.js';

// helpers to build a raw AXNode succinctly (matches CDP wire shape)
const bool = (value) => ({ type: 'boolean', value });
const str = (value) => ({ type: 'string', value });
function node(id, role, name, { props = [], backendDOMNodeId = id + 10000, bounds = { x: 0, y: 0, width: 100, height: 40 }, value, childIds = [] } = {}) {
  return { nodeId: id, ignored: false, role: { value: role }, name: { value: name }, value: value ? { value } : undefined, properties: props, backendDOMNodeId, bounds, childIds };
}
function byId(tree, id) {
  if (!tree) return null;
  if (tree.id === id) return tree;
  for (const c of tree.children || []) { const f = byId(c, id); if (f) return f; }
  return null;
}

describe('normalizeAxTree() — semantic layer fusion', () => {
  const raw = [
    node(1, 'button', '确 定', { props: [{ name: 'focusable', value: bool(true) }, { name: 'visible', value: bool(true) }] }),
    node(2, 'button', '取消', { props: [{ name: 'disabled', value: bool(true) }, { name: 'focusable', value: bool(true) }] }),
    node(3, 'textbox', '请输入标题', { props: [{ name: 'editable', value: str('plaintext') }, { name: 'focusable', value: bool(true) }, { name: 'settable', value: bool(true) }], value: '' }),
    node(4, 'textbox', '', { props: [{ name: 'editable', value: str('multiline') }, { name: 'multiline', value: bool(true) }], bounds: { x: 0, y: 0, width: 200, height: 120 } }),
    node(5, 'generic', '', { props: [{ name: 'editable', value: str('richtext') }, { name: 'focusable', value: bool(true) }], childIds: [6] }),
    node(6, 'paragraph', '第一段', { props: [] }),
    node(7, 'dialog', '发布弹窗', { props: [{ name: 'modal', value: bool(true) }], childIds: [1, 3] }),
  ];

  it('AX-001: fixed-modal fake <button> resolves as role=button', () => {
    const tree = normalizeAxTree(raw);
    expect(byId(tree, 'ax-1').role).toBe('button');
    expect(byId(tree, 'ax-1').label).toBe('确 定');
  });

  it('AX-002: disabled state read from AX natively', () => {
    const n = byId(normalizeAxTree(raw), 'ax-2');
    expect(n.states).toContain('disabled');
  });

  it('AX-003: textbox label comes from AX name (¿placeholder?)', () => {
    expect(byId(normalizeAxTree(raw), 'ax-3').label).toBe('请输入标题');
  });

  it('AX-004: plaintext editable normalized to textbox/editor_type=textbox', () => {
    const n = byId(normalizeAxTree(raw), 'ax-3');
    expect(n.role).toBe('textbox');
    expect(n.editor_type).toBe('textbox');
  });

  it('AX-005: multiline editable normalized to textbox/editor_type=textarea', () => {
    const n = byId(normalizeAxTree(raw), 'ax-4');
    expect(n.editor_type).toBe('textarea');
    expect(n.states).toContain('multiline');
  });

  it('AX-006: div[contenteditable] (generic+editable=richtext) folded to textbox', () => {
    const n = byId(normalizeAxTree(raw), 'ax-5');
    expect(n.role).toBe('textbox');
    expect(n.editor_type).toBe('richtext');
    expect(n.states).toContain('editable=richtext');
    expect(byId(n, 'ax-6').role).toBe('paragraph');
    expect(byId(n, 'ax-6').label).toBe('第一段');
  });

  it('AX-007: every node carries an id + bounds + backendDOMNodeId for fusion', () => {
    const n = byId(normalizeAxTree(raw), 'ax-1');
    expect(n.id).toBe('ax-1');
    expect(n.bounds).toMatchObject({ width: 100, height: 40 });
    expect(n.backendDOMNodeId).toBe(10001);
    expect(n.actions).toContain('click');
  });
});

describe('modalsFromAx()', () => {
  it('AX-008: derives modal + its buttons from AX role=dialog, no class lookup', () => {
    const raw = [
      node(7, 'dialog', '发布弹窗', { props: [{ name: 'modal', value: bool(true) }], childIds: [1, 2] }),
      node(1, 'button', '确 定', { props: [{ name: 'visible', value: bool(true) }] }),
      node(2, 'button', '取消', { props: [{ name: 'disabled', value: bool(true) }] }),
    ];
    const modals = modalsFromAx(raw);
    expect(modals).toHaveLength(1);
    const texts = modals[0].buttons.map((b) => b.text);
    expect(texts).toContain('确 定');
    expect(modals[0].buttons.find((b) => b.text === '取消').disabled).toBe(true);
  });
});

describe('diffAx() — non-committing reveal diff (plan §9.5 / A)', () => {
  it('AX-009: reports the submenu entries newly revealed by a hover', () => {
    const before = [
      node(1, 'menuitem', '创作中心', { props: [{ name: 'focusable', value: bool(true) }] }),
      node(2, 'menuitem', '写文章', { props: [{ name: 'focusable', value: bool(true) }] }),
    ];
    // After hovering 创作中心, a folded 写文章 entry materializes.
    const after = [
      node(1, 'menuitem', '创作中心', { props: [{ name: 'focusable', value: bool(true) }] }),
      node(2, 'menuitem', '写文章', { props: [{ name: 'focusable', value: bool(true) }] }),
      node(3, 'menuitem', '内容管理', { props: [{ name: 'focusable', value: bool(true) }], backendDOMNodeId: 30001 }),
    ];
    const { revealed, hidden } = diffAx(before, after);
    expect(revealed.map((r) => r.label)).toContain('内容管理');
    expect(revealed.find((r) => r.label === '内容管理').id).toBe('ax-30001'); // stable backendDOMNodeId key
    expect(hidden).toHaveLength(0);
  });

  it('AX-010: hides entries that disappear after the pointer moves away', () => {
    const before = [
      node(1, 'menuitem', '创作中心', { props: [] }),
      node(2, 'menuitem', '写文章', { props: [], backendDOMNodeId: 20001 }),
    ];
    const after = [node(1, 'menuitem', '创作中心', { props: [] })];
    const { revealed, hidden } = diffAx(before, after);
    expect(revealed).toHaveLength(0);
    expect(hidden.map((h) => h.label)).toContain('写文章');
  });

  it('AX-011: non-interactive newly-presented nodes are omitted', () => {
    const before = [node(1, 'menuitem', '创作中心', { props: [] })];
    const after = [
      node(1, 'menuitem', '创作中心', { props: [] }),
      node(9, 'statictext', '说明性文字', { props: [] }),
    ];
    const { revealed } = diffAx(before, after);
    expect(revealed).toHaveLength(0); // statictext isn't interactive
  });
});

describe('mergeFrameTrees() — OOPIF down-drill (P0)', () => {
  // Main frame: one paragraph textbox. Child frame: richtext editor already
  // normalized with a caller-prefixed idFor (ax-{fid}-{backendDOMNodeId}).
  const mainRaw = [node(1, 'textbox', '标题', { props: [{ name: 'editable', value: str('plaintext') }, { name: 'focusable', value: bool(true) }] })];
  const mainTree = normalizeAxTree(mainRaw);

  it('AX-012: no sub-frames → main tree returned untouched', () => {
    const merged = mergeFrameTrees(mainTree, []);
    expect(merged).toBe(mainTree);
    expect(byId(merged, 'ax-1').role).toBe('textbox');
  });

  it('AX-013: lifts sub-frame editable nodes under an Iframe gate', () => {
    const subRaw = [
      node(20, 'generic', '', { props: [{ name: 'editable', value: str('richtext') }, { name: 'focusable', value: bool(true) }] }),
      node(21, 'paragraph', '正文', { props: [] }),
    ];
    const subTree = normalizeAxTree(subRaw, { idFor: (n) => 'ax-fx-' + (n.backendDOMNodeId || n.nodeId) });
    const merged = mergeFrameTrees(mainTree, [{ key: 'frame-1', label: 'york/read-draft', tree: subTree }]);

    expect(byId(merged, 'ax-1')).toBeTruthy();                    // main title preserved
    const gate = merged.children.find((c) => c.role === 'Iframe');
    expect(gate).toBeTruthy();
    expect(gate.id).toBe('frame-1');
    expect(byId(gate, 'ax-fx-10020').editor_type).toBe('richtext'); // prefixed id not colliding
    expect(byId(merged, 'ax-10020')).toBeNull();                    // no unprefixed collision
  });

  it('AX-014: single-leaf main tree promoted to container so gates can attach', () => {
    const leafMain = normalizeAxTree([node(1, 'combobox', '搜索', { props: [{ name: 'editable', value: str('plaintext') }] })]);
    const subTree = normalizeAxTree([node(30, 'button', '发布', { props: [{ name: 'focusable', value: bool(true) }] })], { idFor: (n) => 'ax-s-' + (n.backendDOMNodeId || n.nodeId) });
    const merged = mergeFrameTrees(leafMain, [{ key: 'sub0', label: 'iframe', tree: subTree }]);
    expect(merged.role).toBe('generic');                          // promoted container
    expect(merged.children.length).toBeGreaterThanOrEqual(2);
    expect(byId(merged, 'ax-s-10030').role).toBe('button');
  });
});

describe('filterInteractive() — prune layout-only branches (fix #4)', () => {
  it('FX-001: strips a pure layout-only branch', () => {
    const tree = normalizeAxTree([
      node(1, 'generic', '', { props: [], childIds: [2, 3] }),
      node(2, 'generic', '', { props: [], childIds: [4] }), // layout wrapper
      node(4, 'generic', '', { props: [], childIds: [5] }),
      node(5, 'generic', '', { props: [] }),               // dead leaf inside layout
      node(3, 'button', '确 定', { props: [{ name: 'focusable', value: bool(true) }] }),
    ]);
    const pruned = filterInteractive(tree);
    expect(pruned).toBeTruthy();                            // root kept as wrapper
    expect(byId(pruned, 'ax-3')).toBeTruthy();               // interactive button kept
    expect(byId(pruned, 'ax-1')).toBeTruthy();               // root
    // layout hierarchy collapsed — the dead leaves are gone
    expect(byId(pruned, 'ax-4')).toBeNull();
    expect(byId(pruned, 'ax-5')).toBeNull();
  });

  it('FX-002: keeps a card with multiple links together (no over-pruning)', () => {
    const card = node(1, 'generic', '', { props: [], childIds: [2, 3, 4] });
    const tree = normalizeAxTree([
      card,
      node(2, 'link', '作者', { props: [{ name: 'focusable', value: bool(true) }], childIds: [] }),
      node(3, 'link', '正文', { props: [{ name: 'focusable', value: bool(true) }] }),
      node(4, 'link', '购物', { props: [{ name: 'focusable', value: bool(true) }] }),
    ]);
    const pruned = filterInteractive(tree);
    expect(byId(pruned, 'ax-2').role).toBe('link');
    expect(byId(pruned, 'ax-3').role).toBe('link');
    expect(byId(pruned, 'ax-4').role).toBe('link');
  });

  it('FX-003: returns null when everything is layout-only', () => {
    const tree = normalizeAxTree([node(1, 'generic', '', { props: [], childIds: [2] }), node(2, 'generic', '', { props: [] })]);
    expect(filterInteractive(tree)).toBeNull();
  });
});

describe('liteSnapshot() / diffLite() — incremental read (fix #4)', () => {
  it('LS-001: snapshots only interactive nodes keyed by backendDOMNodeId', () => {
    const raw = [
      node(1, 'generic', '', { props: [], backendDOMNodeId: 9001 }),
      node(2, 'link', '作者', { props: [{ name: 'focusable', value: bool(true) }], backendDOMNodeId: 9002 }),
      node(3, 'button', '确 定', { props: [{ name: 'focusable', value: bool(true) }], backendDOMNodeId: 9003 }),
    ];
    const lite = liteSnapshot(raw);
    expect(lite.has(9001)).toBe(false); // layout-only excluded
    expect(lite.has(9002)).toBe(true);
    expect(lite.has(9003)).toBe(true);
    expect(lite.get(9002).label).toBe('作者');
  });

  it('LS-002: diffLite reports newly revealed vs hidden by backendDOMNodeId', () => {
    const prev = new Map([
      [9002, { id: 'ax-9002', role: 'link', label: '作者' }],
      [9003, { id: 'ax-9003', role: 'button', label: '确 定' }],
    ]);
    const next = new Map([
      [9002, { id: 'ax-9002', role: 'link', label: '作者' }],
      [9004, { id: 'ax-9004', role: 'link', label: '新卡片' }],
    ]);
    const d = diffLite(prev, next);
    expect(d.hidden).toHaveLength(1);
    expect(d.hidden[0].label).toBe('确 定');
    expect(d.revealed).toHaveLength(1);
    expect(d.revealed[0].label).toBe('新卡片');
  });
});
// ---- P2-1：行标题必须留在树里 -------------------------------------------
// B站稿件管理列表每行只剩 `[button] 编辑`，因为标题文本挂在一个被 AX 标为
// ignored 的包裹层（flex 行里的 span）下，整棵子树被丢掉。ignored 是"这层没
// 语义"，不是"这里没内容"。
function ignoredNode(id, role, { childIds = [], name = '' } = {}) {
  return { nodeId: id, ignored: true, role: { value: role }, name: { value: name }, properties: [], childIds };
}

describe('normalizeAxTree() — ignored wrappers must not swallow content (P2-1)', () => {
  it('AX-IGN-1: text under an ignored span is lifted to the list item', () => {
    const raw = [
      node(1, 'list', '', { childIds: [2] }),
      node(2, 'listitem', '', { childIds: [3, 6] }),
      ignoredNode(3, 'generic', { childIds: [4] }),          // <span class="title"> (presentational)
      node(4, 'StaticText', '我用 AI 浏览器发了一篇文章', { childIds: [5] }),
      node(5, 'InlineTextBox', '我用 AI 浏览器发了一篇文章'),
      node(6, 'button', '编辑', { props: [{ name: 'focusable', value: bool(true) }], childIds: [7] }),
      node(7, 'StaticText', '编辑'),
    ];
    const tree = normalizeAxTree(raw);
    const li = byId(tree, 'ax-2'); // default idFor = ax-{nodeId}
    expect(li).toBeTruthy();
    const texts = (li.children || []).map((c) => c.label);
    expect(texts).toContain('我用 AI 浏览器发了一篇文章');
    expect(texts).toContain('编辑');
  });

  it('AX-IGN-2: an ignored root wrapper still yields a real root', () => {
    const raw = [
      ignoredNode(1, 'generic', { childIds: [2] }),
      node(2, 'RootWebArea', '页面', { childIds: [3] }),
      node(3, 'button', '保存', { props: [{ name: 'focusable', value: bool(true) }] }),
    ];
    const tree = normalizeAxTree(raw);
    expect(tree.role).toBe('RootWebArea');
    expect(byId(tree, 'ax-3').label).toBe('保存');
  });

  it('AX-IGN-3: a node reachable through two paths is emitted exactly once', () => {
    // AX 有时把同一个 node 同时挂在 ignored 包裹层和真实父节点下。提升时必须
    // 去重，否则同一段文案会在树里出现两次、id 重复。
    const raw = [
      node(1, 'generic', '', { childIds: [2, 3] }),
      ignoredNode(2, 'generic', { childIds: [4] }),
      node(3, 'generic', '', { childIds: [4] }),
      node(4, 'StaticText', '同一个文本'),
    ];
    const tree = normalizeAxTree(raw);
    const count = (function w(t) { let n = t.label === '同一个文本' ? 1 : 0; for (const c of t.children || []) n += w(c); return n; })(tree);
    expect(count).toBe(1);
  });

  it('AX-IGN-4: modal buttons behind an ignored wrapper are still collected', () => {
    const raw = [
      node(1, 'dialog', '发布弹窗', { props: [{ name: 'modal', value: bool(true) }], childIds: [2] }),
      ignoredNode(2, 'generic', { childIds: [3] }),
      node(3, 'button', '确定发布', { props: [{ name: 'focusable', value: bool(true) }] }),
    ];
    const m = modalsFromAx(raw);
    expect(m).toHaveLength(1);
    expect(m[0].buttons.map((b) => b.text)).toEqual(['确定发布']);
  });
});

describe('filterInteractive() — a pruned row must still say which row it is (P2-1)', () => {
  const rowTree = () => ({
    id: 'root', role: 'generic', label: '', states: ['visible'], actions: [],
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      {
        id: 'li-1', role: 'listitem', label: '', states: ['visible'], actions: [], bounds: { x: 0, y: 0, width: 100, height: 40 },
        children: [
          { id: 't-1', role: 'StaticText', label: '第二篇：跨帧编辑器的那些坑', states: [], actions: [], bounds: { x: 0, y: 0, width: 60, height: 20 }, children: [{ id: 'i-1', role: 'InlineTextBox', label: '第二篇：跨帧编辑器的那些坑', states: [], actions: [], bounds: { x: 0, y: 0, width: 60, height: 20 } }] },
          { id: 'b-1', role: 'button', label: '编辑', states: [], actions: ['click', 'focus', 'hover'], bounds: { x: 0, y: 0, width: 30, height: 20 }, children: [{ id: 'b-t', role: 'StaticText', label: '编辑', states: [], actions: [], bounds: { x: 0, y: 0, width: 30, height: 20 } }] },
        ],
      },
    ],
  });

  it('AX-FI-1: pruned listitem keeps the title as its label', () => {
    const out = filterInteractive(rowTree());
    const li = byId(out, 'li-1');
    expect(li).toBeTruthy();
    expect(li.label).toBe('第二篇：跨帧编辑器的那些坑');
    // 纹理节点仍被剪掉（不靠堆节点换信息）
    expect(li.children.map((c) => c.id)).toEqual(['b-1']);
  });

  it('AX-FI-2: an existing label is never overwritten', () => {
    const t = rowTree();
    t.children[0].label = '已有行名';
    const out = filterInteractive(t);
    expect(byId(out, 'li-1').label).toBe('已有行名');
  });

  it('AX-FI-3: non-row roles do not get a synthesized label', () => {
    const t = rowTree();
    t.children[0].role = 'generic';
    const out = filterInteractive(t);
    expect(byId(out, 'li-1').label).toBe('');
  });
});

// ---- P2-2：AX 侧的必填 / 无效态 ------------------------------------------
describe('normalizeAxTree() — states.required / states.invalid (P2-2)', () => {
  it('AX-VS-1: AX required property becomes states.required', () => {
    const raw = [
      node(1, 'textbox', '标题', {
        props: [{ name: 'required', value: bool(true) }, { name: 'editable', value: str('plaintext') }, { name: 'focusable', value: bool(true) }],
      }),
    ];
    const t = normalizeAxTree(raw);
    expect(t.states).toContain('required');
  });

  it('AX-VS-2: AX invalid property becomes states.invalid (and names grammar/spelling)', () => {
    const raw = [
      node(1, 'textbox', '标题', { props: [{ name: 'invalid', value: str('true') }] }),
      node(2, 'textbox', '拼写', { props: [{ name: 'invalid', value: str('spelling') }] }),
      node(3, 'textbox', '正常', { props: [{ name: 'invalid', value: str('false') }] }),
    ];
    const t = normalizeAxTree(raw);
    expect(t.children[0].states).toContain('invalid');
    expect(t.children[1].states).toContain('invalid');
    expect(t.children[1].states).toContain('invalid=spelling');
    expect(t.children[2].states).not.toContain('invalid');
  });
});

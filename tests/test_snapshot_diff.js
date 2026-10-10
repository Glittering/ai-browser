// tests/test_snapshot_diff.js — the diff that decides "did my action do anything".
//
// This logic deserves its own tests more than most: a bug here does not crash,
// it silently turns every verification green. That is the worst failure mode in
// this project (a test that reports success while proving nothing), so every
// case here is written to be falsifiable — including the negative controls that
// prove the diff does NOT invent changes.
import { describe, it, expect } from 'vitest';
import { diffValues, previewOf, previewValue, safeByteLength, DEFAULT_SNAPSHOT_JS, DIFF_MAX_ENTRIES } from '../src/main/snapshot_diff.js';

const changedOf = (a, b) => diffValues(a, b).hasChanges;

describe('diffValues — 基本判定', () => {
  it('SD-001: 完全相同的值判定为未变化', () => {
    expect(changedOf({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(false);
  });

  it('SD-002: 标量改变判定为已变化', () => {
    const d = diffValues({ a: 1 }, { a: 2 });
    expect(d.hasChanges).toBe(true);
    expect(d.changed).toEqual([{ path: 'a', from: 1, to: 2, reason: 'value' }]);
  });

  it('SD-003: 类型变化要标出 reason=type，而不是当成普通值变化', () => {
    const d = diffValues({ a: 'str' }, { a: 2 });
    expect(d.changed[0].reason).toBe('type');
  });

  it('SD-004: 键顺序不同不算变化（否则每次 diff 都"有变化"）', () => {
    expect(changedOf({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });
});

describe('diffValues — 新增与删除', () => {
  it('SD-005: 新增键进 added，带完整路径', () => {
    const d = diffValues({ a: 1 }, { a: 1, b: 2 });
    expect(d.added).toEqual([{ path: 'b', value: 2 }]);
    expect(d.removed).toEqual([]);
  });

  it('SD-006: 删除键进 removed', () => {
    const d = diffValues({ a: 1, b: 2 }, { a: 1 });
    expect(d.removed).toEqual([{ path: 'b', value: 2 }]);
  });

  it('SD-007: 深层嵌套的路径要完整（a.b.c[2].d）', () => {
    const d = diffValues({ a: { b: { c: [{ d: 1 }] } } }, { a: { b: { c: [{ d: 2 }] } } });
    expect(d.changed[0].path).toBe('a.b.c[0].d');
  });

  it('SD-008: 输出顺序确定（同样输入两次得到同样顺序）', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { z: 9, a: 8, m: 7 };
    expect(diffValues(a, b).changed.map(c => c.path)).toEqual(diffValues(a, b).changed.map(c => c.path));
    expect(diffValues(a, b).changed.map(c => c.path)).toEqual(['a', 'm', 'z']);
  });

  it('SD-005b: 新增的容器值只给结构摘要，不把内容整块塞进 diff', () => {
    const d = diffValues({}, { node: { id: 7, type: 'KSampler', widgets: { a: 1, b: 2 } } });
    expect(d.added[0].value).toContain('keys');
    expect(JSON.stringify(d.added).length).toBeLessThan(200);
  });

  it('SD-005c: 新增的字符串超长要截断，但不得短字符串被改样', () => {
    expect(diffValues({}, { s: 'x'.repeat(500) }).added[0].value.length).toBeLessThan(200);
    expect(diffValues({}, { s: 'short' }).added[0].value).toBe('short');
  });
});

describe('diffValues — 数组按索引逐元素比对（不是集合比对）', () => {
  it('SD-009: 尾部新增识别为 added', () => {
    const d = diffValues({ n: [1, 2] }, { n: [1, 2, 3] });
    expect(d.added).toEqual([{ path: 'n[2]', value: 3 }]);
  });

  it('SD-010: 头部删除识别为 removed（剩余元素整体左移，逐项报出）', () => {
    // [1,2,3] → [2,3]：按下标比对时 index 0 和 1 的值都变了，index 2 被移除。
    // 这正是"按索引而非集合比对"的可见后果，调用方能看出是一次整体左移，
    // 而集合比对会只报"少了 1"、把 2 和 3 的移动完全藏起来。
    const d = diffValues({ n: [1, 2, 3] }, { n: [2, 3] });
    expect(d.changed.map(c => c.path)).toEqual(['n[0]', 'n[1]']);
    expect(d.removed).toEqual([{ path: 'n[2]', value: 3 }]);
  });

  it('SD-011: 中间元素改变识别为该下标的 changed', () => {
    const d = diffValues({ n: ['a', 'b'] }, { n: ['a', 'c'] });
    expect(d.changed).toEqual([{ path: 'n[1]', from: 'b', to: 'c', reason: 'value' }]);
  });

  it('SD-012: 节点"移动"应报为逐项变化，而不是消失+新增（工作流图里这两者含义完全不同）', () => {
    // 画布节点数组：顺序变了，但没有任何节点被创建或删除
    const before = { nodes: [{ id: 'a' }, { id: 'b' }] };
    const after = { nodes: [{ id: 'b' }, { id: 'a' }] };
    const d = diffValues(before, after);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed.length).toBe(2);
    expect(d.changed.every(c => c.path.startsWith('nodes['))).toBe(true);
  });
});

describe('diffValues — 数值噪声不得冒充变化', () => {
  it('SD-013: 浮点尾差（同一坐标的两种打印）不算变化', () => {
    // 实测来源：画布吸附把 y 吸到 201354.48743718592，JSON 往返后可能是 ...1859
    expect(changedOf({ y: 201354.48743718592 }, { y: 201354.4874371859 })).toBe(false);
  });

  it('SD-014: 真实的坐标变化必须被检出（不能因容差而漏报）', () => {
    expect(changedOf({ y: 201354.487 }, { y: 201354.487 + 22 })).toBe(true);
  });

  it('SD-015: 两个 NaN 视为相等（否则每次 diff 都报 NaN→NaN 变化）', () => {
    expect(changedOf({ v: NaN }, { v: NaN })).toBe(false);
  });

  it('SD-016: NaN → 数字 必须被检出', () => {
    expect(changedOf({ v: NaN }, { v: 1 })).toBe(true);
  });

  it('SD-017: null 与 undefined 不等价（不能被当成"都没变"）', () => {
    expect(changedOf({ v: null }, { v: undefined })).toBe(true);
  });
});

describe('diffValues — 输出必须有上限（否则会撑爆 agent 上下文）', () => {
  it('SD-018: 超量差异被截断并报告 dropped', () => {
    const big = (n) => { const o = {}; for (let i = 0; i < n; i++) o['k' + i] = i; return o; };
    const d = diffValues({}, big(DIFF_MAX_ENTRIES + 50));
    expect(d.added.length).toBe(DIFF_MAX_ENTRIES);
    expect(d.dropped).toBeGreaterThan(0);
  });

  it('SD-019: 截断后 hasChanges 仍为真（不能因为截断而变成"没变化"）', () => {
    const big = (n) => { const o = {}; for (let i = 0; i < n; i++) o['k' + i] = i; return o; };
    expect(diffValues({}, big(DIFF_MAX_ENTRIES + 10)).hasChanges).toBe(true);
  });
});

describe('阴性对照 —— diff 自己不得凭空造出变化', () => {
  it('SD-020: 同一份数据反复比对 100 次，全部判定为未变化', () => {
    const snap = {
      url: 'https://x/y', title: 'T',
      nodes: { 'button#3': { t: 'button', l: 'Go', v: null, w: 80, h: 30 } },
      list: [1, 2, 3], nested: { a: { b: { c: 'x' } } }, zero: 0, empty: '', nil: null, no: false,
    };
    for (let i = 0; i < 100; i++) {
      expect(changedOf(snap, JSON.parse(JSON.stringify(snap)))).toBe(false);
    }
  });

  it('SD-021: 深拷贝（结构相同、引用不同）不算变化', () => {
    const a = { n: [{ id: 1, v: 'a' }] };
    const b = { n: [{ id: 1, v: 'a' }] };
    expect(a.n).not.toBe(b.n);
    expect(changedOf(a, b)).toBe(false);
  });

  it('SD-022: 两个空对象之间无差异', () => {
    expect(changedOf({}, {})).toBe(false);
  });
});

describe('preview / 体积报告', () => {
  it('SD-023: 直接摘要一个数组只报元素个数，不把内容塞进去', () => {
    expect(previewValue([1, 2, 3])).toBe('[3 items]');
  });

  it('SD-023b: 摘要一个含数组的对象只报顶层键（不递归展开数组内容）', () => {
    expect(previewValue({ a: [1, 2, 3] })).toBe('{1 keys: a}');
  });

  it('SD-024: previewValue 对超长字符串截断', () => {
    const s = previewValue('x'.repeat(500));
    expect(s.length).toBeLessThan(200);
  });

  it('SD-024b: previewOf 是 JSON 字符串，按固定上限截断', () => {
    const big = {}; for (let i = 0; i < 200; i++) big['k' + i] = i;
    const s = previewOf(big);
    expect(s.length).toBeLessThanOrEqual(301);
    expect(s.endsWith('…')).toBe(true);
  });

  it('SD-025: 循环引用不抛错（safeByteLength 返回 -1 而不是崩掉）', () => {
    const a = {}; a.self = a;
    expect(safeByteLength(a)).toBe(-1);
  });

  it('SD-026: undefined 的体积是 0 而不是抛错', () => {
    expect(safeByteLength(undefined)).toBe(0);
  });
});

describe('默认快照表达式', () => {
  // vitest 的默认环境没有 DOM，所以这里只做**静态**检查：在真实页面里求值由
  // e2e（tools/_oneoff/diff_capabilities_e2e.cjs 的 2-x 组）覆盖，那里有真浏览器。
  it('SD-027: 是合法的 JS 表达式（能被 Function 构造，不抛语法错）', () => {
    expect(() => new Function('return ' + DEFAULT_SNAPSHOT_JS)).not.toThrow();
  });

  it('SD-028: 表达式自带 try/catch —— 抛错时返回 __error 而不是把整个快照变成 undefined', () => {
    // 这是最危险的失败模式：空快照会让 diff 恒判"未变化"，于是所有验证假绿。
    const src = DEFAULT_SNAPSHOT_JS;
    expect(src).toContain('__error');
    expect(src).toContain('catch');
  });

  it('SD-029: 无 DOM 时确实返回 __error（证明那条 catch 真的兜住了）', () => {
    // 反向证明：如果这里没兜住，snapshot 会变成 undefined，diff 就会把
    // "什么都没采到" 报成 "页面没变化" —— 那会让每一次验证都假绿。
    const v = new Function('return ' + DEFAULT_SNAPSHOT_JS)();
    expect(v.__error).toBeTruthy();
    expect(v.nodes).toBeUndefined();
  });

  it('SD-030: 表达式同时覆盖语义元素与整页文本（普通 div 的变化也要抓得到）', () => {
    // 只扫"带语义的元素"会漏掉普通 <div> 里的状态文本 —— 实测正是因此把
    // "点按钮把 idle 改成 clicked" 判成了 unchanged。文本兜底不可省。
    expect(DEFAULT_SNAPSHOT_JS).toContain('innerText');
    expect(DEFAULT_SNAPSHOT_JS).toMatch(/querySelectorAll\(\s*'a,button/);
  });
});
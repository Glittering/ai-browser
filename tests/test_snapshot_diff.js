// tests/test_snapshot_diff.js — the diff that decides "did my action do anything".
//
// This logic deserves its own tests more than most: a bug here does not crash,
// it silently turns every verification green. That is the worst failure mode in
// this project (a test that reports success while proving nothing), so every
// case here is written to be falsifiable — including the negative controls that
// prove the diff does NOT invent changes.
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { diffValues, previewOf, previewValue, safeByteLength, DEFAULT_SNAPSHOT_JS, DIFF_MAX_ENTRIES, evictOldest, SNAPSHOT_MAX } from '../src/main/snapshot_diff.js';
import { EVAL_MAX_LENGTH } from '../src/shared/guards.js';

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
  // vitest 的默认环境没有 DOM，所以这里做**静态**检查；下面另有一个用 jsdom
  // 真跑一遍表达式的分组（"默认快照 —— 行为"），因为静态检查永远发现不了
  // "表达式能跑、但判据是错的"这类缺陷。
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

  it('SD-031: 表达式必须短于 ui.evaluate 的 5000 字符守门', () => {
    // 这个默认表达式每次快照都要发进页面。它目前走内部求值、不经过
    // evaluateGuardError，所以超长不会被**拒**——但一个超出已文档化 eval 契约的
    // 默认值，是留给"以后有人把它接到守门路径上"的陷阱。注释写在字符串外面，
    // 就是为了让它保持精简。
    expect(DEFAULT_SNAPSHOT_JS.length).toBeLessThan(EVAL_MAX_LENGTH);
  });
});

describe('快照基线回收', () => {
  // 此前除显式 forget 外没有任何东西删除快照：长会话会把取过的每个基线都留着，
  // 而默认快照含整页文本。淘汰写错会把 agent 还要用的基线悄悄丢掉，且症状远在
  // 别处（"unknown-snapshot"），所以这一组必须存在。
  const fill = (n) => { const m = new Map(); for (let i = 0; i < n; i++) m.set('s' + i, i); return m; };

  it('SD-039: 未超上限时不丢任何东西', () => {
    const m = fill(SNAPSHOT_MAX);
    expect(evictOldest(m)).toBe(0);
    expect(m.size).toBe(SNAPSHOT_MAX);
  });

  it('SD-040: 超上限时按插入顺序从最旧的开始丢', () => {
    const m = fill(SNAPSHOT_MAX + 3);
    expect(evictOldest(m)).toBe(3);
    expect(m.size).toBe(SNAPSHOT_MAX);
    expect(m.has('s0')).toBe(false);
    expect(m.has('s2')).toBe(false);
    expect(m.has('s3')).toBe(true);          // 刚好活下来
    expect(m.has('s' + (SNAPSHOT_MAX + 2))).toBe(true);
  });

  it('SD-041: 重新 set 一个已存在的 key 会让它变成"最近使用"（LRU 而非 FIFO）', () => {
    const m = fill(SNAPSHOT_MAX);
    // 使用 s0（Map 上先删后加 = 移到队尾），再压入一个新基线
    const v = m.get('s0');
    m.delete('s0'); m.set('s0', v);
    m.set('fresh', 1);
    evictOldest(m);
    expect(m.has('s0')).toBe(true);          // 刚用过 → 留下
    expect(m.has('s1')).toBe(false);         // 反而它成了最旧的
  });

  it('SD-042: 空 map 与上限 0 都不炸', () => {
    expect(evictOldest(new Map())).toBe(0);
    expect(evictOldest(fill(5), 0)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 行为回归 —— 用 jsdom 真跑一遍 DEFAULT_SNAPSHOT_JS。
//
// 这一组存在的理由：上面全是静态/纯函数断言，它们能证明"函数没写错"，但证明
// 不了"表达式在真 DOM 上量到的是对的东西"。下面两条缺陷**都不崩、也不报错**，
// 只是让每一次验证假绿或淹在噪声里 —— 正是最需要被钉住的那一类。
// ---------------------------------------------------------------------------

/**
 * Run DEFAULT_SNAPSHOT_JS against a real (jsdom) DOM.
 * jsdom has no layout engine: every getBoundingClientRect() is 0x0, which the
 * expression's zero-size filter would skip for every element — so we stub a
 * non-zero box, otherwise these tests would silently assert on an empty
 * snapshot and pass for the wrong reason.
 */
function snapshotOfHtml(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  const win = dom.window;
  win.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  };
  const fn = new Function('window', 'document', 'location', 'getComputedStyle', 'return ' + DEFAULT_SNAPSHOT_JS);
  const value = fn(win, win.document, win.location, win.getComputedStyle.bind(win));
  dom.window.close();
  return value;
}

describe('默认快照 —— 行为（jsdom）', () => {
  it('SD-032: 元素 key 不随位置漂移 —— 顶部插入 1 个元素只报 1 条 added', () => {
    // 旧实现用 `tag#index` 做 key：顶部插入一个元素，下面每个元素的 key 全部
    // 右移。实测 1 次插入被报成 `4 added + 3 removed + 3 changed`（7 条噪声），
    // 真正的信号被埋掉 —— 而"插入一个通知条/列表行/懒加载项"是绝大多数页面
    // 都会做的事。
    const before = snapshotOfHtml(
      '<div id="status">idle</div><button id="a">Alpha</button><button id="b">Beta</button><button id="c">Gamma</button>'
    );
    const after = snapshotOfHtml(
      '<button id="new">Injected</button><div id="status">idle</div><button id="a">Alpha</button><button id="b">Beta</button><button id="c">Gamma</button>'
    );
    const d = diffValues(before, after);
    expect(d.added.map((a) => a.path)).toEqual(['nodes.button#new']);
    expect(d.removed).toEqual([]);
    // 没有任何**元素**被报成"变了"；剩下的 changed 只该是整页文本/计数这类
    // 确实变了的东西。
    expect(d.changed.filter((c) => c.path.startsWith('nodes'))).toEqual([]);
  });

  it('SD-033: 无 id 的同标签兄弟也不漂移（靠 label 去重）', () => {
    const before = snapshotOfHtml('<button>Alpha</button><button>Beta</button><button>Gamma</button>');
    const after = snapshotOfHtml('<button>Injected</button><button>Alpha</button><button>Beta</button><button>Gamma</button>');
    const d = diffValues(before, after);
    expect(d.added.map((a) => a.path)).toEqual(['nodes.button~Injected']);
    expect(d.removed).toEqual([]);
    expect(d.changed.filter((c) => c.path.startsWith('nodes'))).toEqual([]);
  });

  it('SD-034: 唯一身份的元素的文案变化报 changed，而不是 removed + added', () => {
    // key 取身份（这里 id=go）而非文案，所以按钮文案 Start→Stop 是**内容**变化，
    // 应该读到 `changed`。若 key 里混进了文案，就会被读成"按钮被换掉了"。
    const before = snapshotOfHtml('<button id="go">Start</button>');
    const after = snapshotOfHtml('<button id="go">Stop</button>');
    const d = diffValues(before, after);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed.some((c) => c.path === 'nodes.button#go.l')).toBe(true);
  });

  it('SD-035: 完全相同的两个无标识元素必须拿到两个不同的 key（不许静默合并）', () => {
    // 合并的后果是"其中一个变了却不报" —— 又一次假绿。
    const v = snapshotOfHtml('<button>Same</button><button>Same</button>');
    expect(Object.keys(v.nodes)).toHaveLength(2);
  });

  it('SD-036: 4000 字符之后的等长变化必须被检出（text 假绿的回归）', () => {
    // 旧实现只截前 4000 字符 + 记 textLen：等长变化落在 4000 之后时两者都不变，
    // 于是"changed"被报成"unchanged"。整页文本是这个工具对普通 <div> 的唯一
    // 观测手段，所以这是纯粹的假绿。
    const filler = 'x'.repeat(4200);
    const before = snapshotOfHtml(`<p>${filler}</p><div id="out">AAAA</div>`);
    const after = snapshotOfHtml(`<p>${filler}</p><div id="out">BBBB</div>`);
    expect(diffValues(before, after).hasChanges).toBe(true);
  });

  it('SD-037: 对照组 —— 同一处变化放在前 4000 字符内同样被检出', () => {
    // 阳性对照：证明"观测手段本身有效"，否则 SD-036 绿了也不能说明什么。
    const filler = 'x'.repeat(4200);
    const before = snapshotOfHtml(`<div id="out">AAAA</div><p>${filler}</p>`);
    const after = snapshotOfHtml(`<div id="out">BBBB</div><p>${filler}</p>`);
    expect(diffValues(before, after).hasChanges).toBe(true);
  });

  it('SD-038: 阴性对照 —— 同一份页面反复快照必须判 unchanged', () => {
    // 新增的 key 派生与分段指纹都不许自己造出噪声，否则每次 diff 都"有变化"，
    // 这个工具就废了。
    const html = '<div id="s">idle</div><button id="a">Alpha</button><input placeholder="q"><a href="/x">link</a>';
    const a = snapshotOfHtml(html);
    for (let i = 0; i < 20; i++) {
      expect(diffValues(a, snapshotOfHtml(html)).hasChanges).toBe(false);
    }
  });
});
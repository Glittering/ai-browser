// tests/test_capability_probe.js — the "which route on this page?" decision.
//
// These are table tests over the exact hint strings the in-page probe emits.
// They exist because the ranking got it wrong in a way only a real site
// revealed: the probe produces `_nodes (13 items)`, the ranker was matching
// `has ._nodes`, so every candidate scored -1 and a page with a perfectly
// usable data model was downgraded to a generic "check the endpoints" answer.
// A table test turns that class of mistake into an instant local failure.
import { describe, it, expect } from 'vitest';
import { rankAppGlobals, PROBE_JS, probeCapabilities } from '../src/main/capability_probe.js';
import { JSDOM } from 'jsdom';

const g = (key, hint, where = 'iframe[0]') => ({ where, key, hint, type: 'object' });

describe('rankAppGlobals — 必须指向真正持有数据的对象', () => {
  it('CP-001: ComfyUI 的 graph(_nodes) 必须排在 LiteGraph(getState) 之前', () => {
    // 实测原始输出。LiteGraph 是库（导出构造器），graph 才是模型（13 个节点）。
    // 反过来推荐会让 agent 去操作库而不是数据。
    const r = rankAppGlobals([g('LiteGraph', 'getState'), g('graph', '_nodes (13 items)')]);
    expect(r[0].g.key).toBe('graph');
    expect(r[1].g.key).toBe('LiteGraph');
  });

  it('CP-002: hint 的真实格式是 "_nodes (13 items)"，不是 "has ._nodes"', () => {
    // 这条就是当初的 bug：前缀写错 → 全 -1 → L1_structured_data 退化成 L1_api。
    const r = rankAppGlobals([g('graph', '_nodes (13 items)')]);
    expect(r.length).toBe(1);
    expect(r[0].g.key).toBe('graph');
  });

  it('CP-003: "nodes" 与 "_nodes" 都算，但 _nodes 分数更高', () => {
    const a = rankAppGlobals([g('x', 'nodes (3 items)')])[0].score;
    const b = rankAppGlobals([g('y', '_nodes (3 items)')])[0].score;
    expect(b).toBeGreaterThan(a);
  });

  it('CP-004: 带类型后缀的 hint 仍能匹配（"graph (obj)" / "links (15)"）', () => {
    const r = rankAppGlobals([g('app', 'graph (obj)'), g('g2', 'links (15)')]);
    expect(r.map((x) => x.g.key)).toEqual(['app', 'g2']);
  });

  it('CP-005: 完全不像模型的全局对象要被排除（否则会推荐到无关对象上）', () => {
    const r = rankAppGlobals([
      g('someRandomThing', 'foo, bar, baz'),
      g('config', 'a, b, c'),
    ]);
    expect(r.length).toBe(0);
  });

  it('CP-006: 空的 globals 输入不炸（很多普通页面就没有应用对象）', () => {
    expect(rankAppGlobals([])).toEqual([]);
    expect(rankAppGlobals(null)).toEqual([]);
    expect(rankAppGlobals([g('x', null)])).toEqual([]);
  });

  it('CP-007: 三候选时排序稳定（_nodes > graph > getState）', () => {
    const r = rankAppGlobals([
      g('c', 'getState'), g('a', 'graph (obj)'), g('b', '_nodes (13 items)'),
    ]);
    expect(r.map((x) => x.g.key)).toEqual(['b', 'a', 'c']);
  });

  it('CP-008: 同分时保持输入顺序（稳定排序，可复现）', () => {
    const input = [g('first', 'graph (obj)'), g('second', 'graph (obj)')];
    const a = rankAppGlobals(input).map((x) => x.g.key);
    const b = rankAppGlobals(input.slice().reverse()).map((x) => x.g.key);
    // 稳定排序：相同分数按原顺序，不因输入顺序抖动
    expect(a).toEqual(['first', 'second']);
    expect(b).toEqual(['second', 'first']);
  });

  it('CP-009: loadGraphData 这类"能整图加载"的方法也算强信号', () => {
    const r = rankAppGlobals([g('lib', 'getState'), g('app', 'loadGraphData')]);
    expect(r[0].g.key).toBe('app');
  });

  it('CP-010: rhtv 那种纯 DOM 画布不应被误判成有数据模型', () => {
    // 实测：rhtv 的 globals 是空的（无应用对象），所以推荐 L1_api + L2。
    expect(rankAppGlobals([]).length).toBe(0);
  });
});
describe('PROBE_JS —— 表驱动测试赖以成立的 hint 格式（执行真探针）', () => {
  // 上面每一张表都断言在"探针产出的 hint 字符串"上，却没有任何测试验证过探针
  // 真的产出那个格式。emitter 与表一旦漂移（例如把 '_nodes (13 items)' 写成
  // 'has ._nodes'），全部表驱动测试照样全绿，而真实站点上排名整体失效 —— 正是
  // 本文件开头记录的那个事故。这里把探针本身跑起来，把格式钉住。
  function probeWith(globals, html = '<canvas></canvas>') {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
    const win = dom.window;
    for (const [k, v] of Object.entries(globals)) win[k] = v;
    const fn = new Function('window', 'document', 'location', 'return ' + PROBE_JS);
    const out = fn(win, win.document, win.location);
    dom.window.close();
    return out;
  }

  it('CP-011: 数组属性产出 "<name> (N items)"，与表驱动的假设一致', () => {
    const out = probeWith({ graph: { _nodes: [1, 2, 3] } });
    expect(out.globals.find((x) => x.key === 'graph').hint).toBe('_nodes (3 items)');
  });

  it('CP-012: 方法属性产出裸方法名（不带括号、不带 detail）', () => {
    const out = probeWith({ graph: { getState() {}, serialize() {} } });
    expect(out.globals.find((x) => x.key === 'graph').hint).toBe('getState');
  });

  it('CP-013: 对象属性产出 "<name> (obj)"', () => {
    const out = probeWith({ app: { graph: { a: 1 } } });
    expect(out.globals.find((x) => x.key === 'app').hint).toBe('graph (obj)');
  });

  it('CP-014: 库与真模型并存时，排名把模型排在库前面（emitter × 表驱动 串起来）', () => {
    const out = probeWith({ LiteGraph: { getState() {} }, graph: { _nodes: [1, 2] } });
    const keys = out.globals.map((x) => x.key);
    expect(keys).toContain('LiteGraph');
    expect(keys).toContain('graph');
    expect(rankAppGlobals(out.globals)[0].g.key).toBe('graph');
  });

  it('CP-015: 没有应用对象的页面 globals 为空（不自己造候选）', () => {
    const out = probeWith({});
    expect(out.globals).toEqual([]);
  });
});

// ---- 泛雅事故：树薄不等于 canvas ----
import { describeThinTree, recommend } from '../src/main/capability_probe.js';

describe('describeThinTree() — 三种"树看不到内容"的归因必须分开', () => {
  const base = { elements: 27, actionable: 13, canvasTop: 0, canvasInFrames: 0, opaqueFrames: [] };

  it('CP-016: 有跨进程 iframe、没有 canvas → 不许说 canvas-rendered（原始 bug）', () => {
    // 实测原话：'only 27 elements (13 actionable) — the UI is largely canvas-rendered'
    // 而同一份回执里 canvas_top=0、cross-process iframe=1。归因错了，agent 会被
    // 推去做 L3 指针手势（在"canvas"上瞎点），而正确动作是去读那个 frame。
    const why = describeThinTree({
      ...base,
      opaqueFrames: [{ src: 'https://mooc2-ans.xidian.edu.cn/mooc2-ans/mycourse/studentcourse?x=1', box: [180, 52, 1100, 646] }],
    });
    expect(why).not.toContain('canvas-rendered');
    expect(why).toContain('cross-process iframe');
    expect(why).toContain('studentcourse'); // 给出可用的地址
  });

  it('CP-017: 真有 canvas 时才说 canvas（并给出 顶层/帧内 的拆分）', () => {
    const why = describeThinTree({ ...base, canvasTop: 0, canvasInFrames: 7 });
    expect(why).toContain('canvas-rendered');
    expect(why).toContain('7 canvas');
    expect(why).toContain('0 top-level');
  });

  it('CP-018: 既没 canvas 也没帧 → 说"页面本身稀疏/可能还在加载"，不许编原因', () => {
    const why = describeThinTree(base);
    expect(why).not.toContain('canvas-rendered');
    expect(why).not.toContain('iframe');
    expect(why).toContain('sparse');
  });

  it('CP-019: 只有 canvas 时才提 canvas —— 两者并存时 canvas 优先（它更硬）', () => {
    const why = describeThinTree({ ...base, canvasTop: 2, opaqueFrames: [{ src: 'https://a.test/' }] });
    expect(why).toContain('canvas-rendered');
  });
});

describe('recommend() — 内容藏在 iframe 里时不能给出空建议', () => {
  const thin = (n, actionable) => Array.from({ length: n }, (_, i) => ({
    role: i < actionable ? 'link' : 'generic',
    actions: i < actionable ? ['click'] : [],
  }));

  it('CP-020: 泛雅形状 → recommended 非空，且归因指向 iframe 而非 canvas', () => {
    const r = recommend({
      flat: thin(27, 13),
      dom: {
        topCanvas: 0,
        iframes: [{ index: 0, src: 'https://x.test/f', sameOrigin: false, box: [180, 52, 1100, 646] }],
        globals: [],
      },
      endpoints: [],
    });
    expect(r.recommended.length).toBeGreaterThan(0);
    expect(r.recommended).toContain('L2_semantic_tree');
    const l2 = r.routes.find((x) => x.route === 'L2_semantic_tree');
    expect(l2.why).not.toContain('canvas-rendered');
    expect(l2.evidence.cross_process_frames).toBe(1);
    expect(l2.evidence.canvas_rendered).toBe(false);
    const note = r.routes.find((x) => x.route === 'NOTE_cross_process_iframe');
    expect(note).toBeTruthy();
    expect(note.evidence.frames[0].src).toBe('https://x.test/f');
  });

  it('CP-021: 零尺寸帧（广告/埋点）不算内容帧', () => {
    const r = recommend({
      flat: thin(10, 2),
      dom: { topCanvas: 0, iframes: [{ index: 0, src: 'https://ad.test/', sameOrigin: false, box: [0, 0, 0, 0] }], globals: [] },
      endpoints: [],
    });
    expect(r.recommended).toEqual([]);
    expect(r.routes.some((x) => x.route === 'NOTE_cross_process_iframe')).toBe(false);
  });

  it('CP-022: 元素足够多时走 rich 分支，不误报 canvas/iframe', () => {
    const flat = [
      ...thin(70, 20),
      ...Array.from({ length: 10 }, () => ({ role: 'heading', actions: [] })),
      ...Array.from({ length: 5 }, () => ({ role: 'text', actions: [] })),
    ];
    const r = recommend({
      flat,
      dom: { topCanvas: 1, iframes: [{ index: 0, src: 'https://x.test/f', sameOrigin: false, box: [0, 0, 800, 600] }], globals: [] },
      endpoints: [],
    });
    const l2 = r.routes.find((x) => x.route === 'L2_semantic_tree');
    expect(l2.preferred).toBe(true);
    expect(l2.why).toContain('distinct roles');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeCapabilities 的取数边界（CAP-EP-*）
//
// 之前这个函数**没有任何单测**（表驱动测试只覆盖了 rankAppGlobals 与 PROBE_JS
// 这两块纯逻辑），于是它的一个硬伤一直没被发现：它调 NetworkMonitor.list 时传的是
// `{ tabId }`，而那个函数读的是 `filter.tab` —— 过滤静默失效，返回的是**所有标签页**
// 的请求。实测证据：在只有 excalidraw.com 一个页面的实例上，endpoints 里出现了
// /ztbox 与 /sugrec（百度的接口）。agent 会拿着这份清单去 fetch 与本页无关的接口。
//
// 这组用例用一个会**真的按 filter.tab 过滤**的假 monitor，所以传错参数名就会红。
function fakePM({ endpoints = [], globals = [] } = {}) {
  const seen = [];
  return {
    seen,
    activeTab: 7,
    _getView: () => ({ webContents: { getURL: () => 'https://a.test/' } }),
    getTree: async () => ({ tree: { role: 'root', label: '', children: [] }, context: {} }),
    evaluate: async () => ({
      url: 'https://a.test/', title: 'T', topDom: 5, topCanvas: 0,
      iframes: [], globals, canvases: [],
    }),
    networkMonitor: {
      // 关键：像真的一样按 filter.tab 过滤。参数名错 → 全部返回 → 断言红。
      list: async (filter) => {
        seen.push(filter);
        const rows = endpoints.filter((r) => filter.tab == null || r.tab_id === filter.tab);
        return { requests: rows };
      },
    },
  };
}

describe('probeCapabilities — 只能看到自己这个 tab 的网络请求', () => {
  it('CAP-EP-01 传给 NetworkMonitor.list 的过滤键是 tab', async () => {
    const pm = fakePM();
    await probeCapabilities(pm, { tab: 7 });
    expect(pm.seen.length).toBeGreaterThan(0);
    expect(pm.seen[0].tab).toBe(7);
    expect(pm.seen[0].tabId).toBeUndefined();
  });

  it('CAP-EP-02 别的 tab 的请求不能出现在 endpoints 里', async () => {
    const pm = fakePM({
      endpoints: [
        { tab_id: 7, method: 'GET', url: 'https://a.test/api/doc', status: 200 },
        { tab_id: 99, method: 'GET', url: 'https://baidu.com/sugrec', status: 200 },
        { tab_id: 99, method: 'POST', url: 'https://baidu.com/ztbox', status: 200 },
      ],
    });
    const r = await probeCapabilities(pm, { tab: 7 });
    const paths = r.endpoints.map((e) => e.path);
    expect(paths).toContain('/api/doc');
    expect(paths.join(',')).not.toMatch(/sugrec|ztbox/);
  });

  it('CAP-EP-03 显式给 tab 时不能退化成不过滤', async () => {
    const pm = fakePM({
      endpoints: [{ tab_id: 42, method: 'GET', url: 'https://other.test/x', status: 200 }],
    });
    const r = await probeCapabilities(pm, { tab: 7 });
    expect(r.endpoints).toEqual([]);
  });
});

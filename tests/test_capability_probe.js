// tests/test_capability_probe.js — the "which route on this page?" decision.
//
// These are table tests over the exact hint strings the in-page probe emits.
// They exist because the ranking got it wrong in a way only a real site
// revealed: the probe produces `_nodes (13 items)`, the ranker was matching
// `has ._nodes`, so every candidate scored -1 and a page with a perfectly
// usable data model was downgraded to a generic "check the endpoints" answer.
// A table test turns that class of mistake into an instant local failure.
import { describe, it, expect } from 'vitest';
import { rankAppGlobals } from '../src/main/capability_probe.js';

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
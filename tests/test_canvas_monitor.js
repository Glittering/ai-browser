// tests/test_canvas_monitor.js — canvas 抓取状态机（纯逻辑，不依赖 Electron）。
//
// 这个模块此前是 3 个"零单测"模块里最大的一个（270 行），只能靠 e2e canvas 套件
// 间接发现回归（docs/AUDIT-2026-10-30.md P2-5）。它承载三条硬约束：
//   · 有界：每 tab 最多 5000 条 / 4MB，超出淘汰最旧并如实累计 dropped_calls
//     （canvas 密集页面每帧几十次调用，不设上限会吃光内存）；
//   · 诚实：WebGL 拿不到业务语义必须标 opaque，不能假装读到了；
//   · 关 tab 要真的消失（forget 连空壳一起删，否则 tabs Map 无界累积）。
import { describe, it, expect } from 'vitest';
import CanvasMonitor, { isCanvasHookEnabled } from '../src/main/canvas_monitor.js';

const call = (c, k, m = 'fillText', extra = {}) => ({ c, k, m, t: 'x', ...extra });

describe('canvas_monitor — 接收与聚合', () => {
  it('CM-1: ingest 后能按 canvas 列出，并从绘制调用反推 2D', () => {
    const mon = new CanvasMonitor();
    mon.ingest(1, { calls: [call('cv1', 'text'), call('cv1', 'rect')] });

    const out = mon.list(1);
    expect(out.canvases).toHaveLength(1);
    expect(out.canvases[0].canvas_id).toBe('cv1');
    // 没有 getContext 记录时，靠 fillText/rect 反推（实测首帧常常没有 getContext）
    expect(out.canvases[0].kind).toBe('2d');
    expect(out.canvases[0].readability).toBe('semantic');
    expect(out.retention.calls).toBe(2);
  });

  it('CM-2: getContext 记录优先于调用反推（webgl 不许被误判成 2d）', () => {
    const mon = new CanvasMonitor();
    mon.ingest(1, { calls: [{ c: 'cv9', m: 'getContext', k: 'webgl' }] });
    mon.ingest(1, { calls: [call('cv9', 'gl', 'drawArrays')] });

    const out = mon.list(1);
    expect(out.canvases[0].kind).toBe('webgl');
    // 诚实：WebGL 拿不到业务语义
    expect(out.canvases[0].readability).toBe('opaque');
    const read = mon.read(1, { canvasId: 'cv9' });
    expect(read.warnings.join(' ')).toMatch(/WebGL/);
  });

  it('CM-3: 非法 payload 不抛，返回 0/0', () => {
    const mon = new CanvasMonitor();
    expect(mon.ingest(1, null)).toEqual({ accepted: 0, dropped: 0 });
    expect(mon.ingest(1, { calls: 'nope' })).toEqual({ accepted: 0, dropped: 0 });
  });
});

describe('canvas_monitor — 有界（内存硬约束）', () => {
  it('CM-4: 超过 maxCalls 时淘汰最旧的，并如实累计 dropped_calls', () => {
    const mon = new CanvasMonitor({ maxCalls: 5 });
    const r = mon.ingest(1, { calls: Array.from({ length: 8 }, (_, i) => call('cv', 'text', 'fillText', { t: 'n' + i })) });
    expect(r.accepted).toBe(8);
    expect(r.dropped).toBe(3);

    const out = mon.list(1);
    expect(out.retention.calls).toBe(5);
    expect(out.retention.dropped_calls).toBe(3);

    // 留下的是最新的 5 条（seq 4..8）
    const read = mon.read(1, { view: 'calls' });
    expect(read.calls.map((c) => c.seq)).toEqual([4, 5, 6, 7, 8]);
  });

  it('CM-5: 字节上限也会淘汰（不只是条数）', () => {
    const mon = new CanvasMonitor({ maxCalls: 1000, maxBytes: 120 });
    const big = { c: 'cv', k: 'text', m: 'fillText', t: 'x'.repeat(100) };
    mon.ingest(1, { calls: [big, big, big] });
    const out = mon.list(1);
    expect(out.retention.calls, '必须被字节上限压下来').toBeLessThan(3);
    expect(out.retention.dropped_calls).toBeGreaterThan(0);
    expect(out.retention.bytes).toBeLessThanOrEqual(120);
  });
});

describe('canvas_monitor — 读数分页', () => {
  it('CM-6: since_seq 游标与 limit 都生效，has_more 如实标出', () => {
    const mon = new CanvasMonitor();
    mon.ingest(1, { calls: Array.from({ length: 10 }, () => call('cv', 'text')) });

    const first = mon.read(1, { view: 'calls', limit: 4 });
    expect(first.calls).toHaveLength(4);
    expect(first.pagination.has_more).toBe(true);
    expect(first.pagination.next_seq).toBe(4);

    const second = mon.read(1, { view: 'calls', limit: 4, sinceSeq: first.pagination.next_seq });
    expect(second.calls.map((c) => c.seq)).toEqual([5, 6, 7, 8]);
  });

  it('CM-7: summary 视图把 text 与 region 分开，不混成一锅', () => {
    const mon = new CanvasMonitor();
    mon.ingest(1, { calls: [call('cv', 'text', 'fillText'), call('cv', 'rect', 'fillRect')] });
    const s = mon.read(1, { canvasId: 'cv' });
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0].text).toBe('x');
    expect(s.regions).toHaveLength(1);
    expect(s.regions[0].kind).toBe('rect');
    // 区域只是绘制边界，不是"可点区域"
    expect(s.warnings.join(' ')).toMatch(/not proven interactive/);
  });
});

describe('canvas_monitor — 模式与生命周期', () => {
  it('CM-8: mode 默认继承 defaultMode，setMode 后按 tab 生效', () => {
    const mon = new CanvasMonitor();
    expect(mon.getMode(1)).toBe('semantic');

    mon.setDefaultMode('trace');
    expect(mon.getMode(2), '未建过状态的 tab 用默认值').toBe('trace');

    mon.setMode(1, 'off');
    expect(mon.getMode(1)).toBe('off');
    expect(mon.getMode(2), '别的 tab 不许被牵连').toBe('trace');

    // 非法 mode 不许改状态
    expect(mon.setMode(1, 'bogus')).toBe('off');
  });

  it('CM-9: clear 只清数据、保留配置（canvas_configure{clear:true} 的语义）', () => {
    const mon = new CanvasMonitor();
    mon.setMode(1, 'trace');
    mon.ingest(1, { calls: [call('cv', 'text'), call('cv', 'text')] });

    const r = mon.clear(1);
    expect(r.cleared_calls).toBe(2);
    expect(mon.list(1).retention.calls).toBe(0);
    expect(mon.list(1).canvases).toHaveLength(0);
    // 关键：清数据不等于忘配置
    expect(mon.getMode(1), 'clear 之后 mode 必须还在（否则 canvas_configure 自相矛盾）').toBe('trace');
    expect(mon.tabs.size, 'clear 保留空壳，关 tab 才用 forget').toBe(1);
  });

  it('CM-10: forget 彻底删掉该 tab（关 tab 用），别的 tab 不受影响', () => {
    const mon = new CanvasMonitor();
    mon.ingest(1, { calls: [call('cv', 'text')] });
    mon.ingest(2, { calls: [call('cv', 'text')] });
    expect(mon.tabs.size).toBe(2);

    const r = mon.forget(1);
    expect(r.forgotten).toBe(true);
    expect(mon.tabs.size, 'tabs Map 不许留下空壳（它没有淘汰上限）').toBe(1);
    expect(mon.tabs.has(2)).toBe(true);

    // 重复 forget 不抛
    expect(mon.forget(1)).toEqual({ forgotten: false });
  });

  it('CM-11: markHook 的 warnings 去重（同一句只留一条）', () => {
    const mon = new CanvasMonitor();
    mon.markHook(1, false, ['cdp debugger not attached']);
    mon.markHook(1, false, ['cdp debugger not attached']);
    mon.markHook(1, true, ['another']);
    const out = mon.list(1);
    expect(out.hook_installed).toBe(true);
    expect(out.warnings).toEqual(['cdp debugger not attached', 'another']);
  });

  it('CM-12: isCanvasHookEnabled 只把明确的关闭值当关闭', () => {
    for (const v of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) expect(isCanvasHookEnabled(v)).toBe(false);
    for (const v of ['1', 'on', 'true', 'yes', '']) expect(isCanvasHookEnabled(v)).toBe(true);
    expect(isCanvasHookEnabled(undefined), '环境变量没设 = 开').toBe(true);
    expect(isCanvasHookEnabled(null)).toBe(true);
  });
});

// tests/test_page_probe.js — 「动作到底改没改页面」这个原语本身。
//
// 这组断言钉的是三条曾经害人的判断：
//   1. 探针失败 ≠ 页面没变（null 必须一路传到回执，绝不能被当成 false）
//   2. 写类动作报 success 但主文档零变化 → 必须降级 effect_state，
//      否则回执自相矛盾（"已生效，别重试" + 观测"什么都没变"）
//   3. click 的零变化是**合法**的（点已选中的 radio），不能降级，
//      但要给一句能指导下一步的话
import { describe, it, expect } from 'vitest';
import { diffProbe, applyProbe, shouldProbe, settleMs, PAGE_PROBE_JS } from '../src/shared/page_probe.js';

const P = (t, n, d, u = 'https://a.test/x') => ({
  t, h: 'h' + t, n, d, u,
});

describe('diffProbe — 四个信号任一变化即 changed', () => {
  it('PP-1 完全相同的两张快照 → false', () => {
    const a = P(100, 500, 10);
    expect(diffProbe(a, { ...a }).changed).toBe(false);
  });

  it('PP-2 文本长度相同但内容变了（hash 变）→ true', () => {
    expect(diffProbe(P(100, 500, 0), { t: 100, h: 'other', n: 500, d: 0, u: 'https://a.test/x' }).changed).toBe(true);
  });

  it('PP-3 DOM 节点数变化（弹窗插入）→ true', () => {
    expect(diffProbe(P(100, 500, 0), P(100, 520, 0)).changed).toBe(true);
  });

  it('PP-4 焦点字段长度变化（输入落地）→ true', () => {
    const d = diffProbe(P(100, 500, 0), P(100, 500, 42));
    expect(d.changed).toBe(true);
    expect(d.delta.focused_chars).toBe(42);
  });

  it('PP-5 URL 变化（SPA 路由）→ true', () => {
    expect(diffProbe(P(100, 500, 0), P(100, 500, 0, 'https://a.test/y')).changed).toBe(true);
  });

  it('PP-6 任一侧探针失败 → changed:null（不是 false）', () => {
    expect(diffProbe(null, P(1, 1, 1)).changed).toBe(null);
    expect(diffProbe(P(1, 1, 1), { __err: 'boom' }).changed).toBe(null);
    expect(diffProbe(P(1, 1, 1), undefined).changed).toBe(null);
  });

  it('PP-7 delta 给出三个可读的增量', () => {
    const d = diffProbe(P(100, 500, 10), P(160, 503, 70));
    expect(d.delta).toEqual({ text_chars: 60, dom_nodes: 3, focused_chars: 60 });
  });
});

describe('applyProbe — 只观测，结论分级', () => {
  const before = P(100, 500, 0);

  it('PP-8 有变化时只加 page_changed，不塞 delta/hint（省 token）', () => {
    const out = applyProbe({ success: true }, before, P(140, 500, 40), 'type');
    expect(out.page_changed).toBe(true);
    expect(out.page_delta).toBeUndefined();
    expect(out.effect_hint).toBeUndefined();
    expect(out.effect_state).toBeUndefined(); // 不越权改分类
  });

  it('PP-9 写类动作 + 零变化 → effect_state 降为 unknown，retry=verify_first', () => {
    const out = applyProbe({ success: true }, before, { ...before }, 'paste');
    expect(out.page_changed).toBe(false);
    expect(out.effect_state).toBe('unknown');
    expect(out.retry).toBe('verify_first');
    expect(out.effect_hint).toMatch(/byte-identical/);
    // 必须明确禁止盲重试 —— 这是掘金那次内容翻倍的直接教训
    expect(out.effect_hint).toMatch(/duplicates the content/);
  });

  it('PP-10 click 零变化不降级（合法无变化），但提示可能是点到包裹层', () => {
    const out = applyProbe({ success: true, clicked_via: 'cdp-mouse' }, before, { ...before }, 'click');
    expect(out.page_changed).toBe(false);
    expect(out.effect_state).toBeUndefined();
    expect(out.effect_hint).toMatch(/wrapper element/);
    expect(out.effect_hint).toMatch(/iframe/i); // 主文档视角的边界要写清
  });

  it('PP-11 已有 error 时不覆盖更具体的说明', () => {
    const out = applyProbe(
      { success: false, error: 'editor rejected payload', effect_hint: 'specific' },
      before, { ...before }, 'setContent'
    );
    expect(out.effect_hint).toBe('specific');
  });

  it('PP-12 探针不可用时原样返回（不多一个字段）', () => {
    const res = { success: true };
    expect(applyProbe(res, null, null, 'click')).toEqual(res);
  });

  it('PP-13 失败回执也带 page_changed（判断是否部分生效）', () => {
    const out = applyProbe({ success: false, error: 'timed out' }, before, P(200, 500, 0), 'type');
    expect(out.page_changed).toBe(true);
  });
});

describe('probe 开关与等待', () => {
  it('PP-14 只读动作不拍快照', () => {
    for (const a of ['get_value', 'focus', 'hover', 'scroll_to', 'wheel']) {
      expect(shouldProbe(a)).toBe(false);
    }
    for (const a of ['click', 'type', 'paste', 'upload', 'drag', 'press', 'setContent', 'clear']) {
      expect(shouldProbe(a)).toBe(true);
    }
  });

  it('PP-15 写类动作等得短、click 等得长（框架提交+一帧）', () => {
    expect(settleMs('paste')).toBeLessThan(settleMs('click'));
    expect(settleMs('click')).toBeGreaterThanOrEqual(150);
  });

  it('PP-16 探针脚本自包含、不含未定义引用', () => {
    expect(PAGE_PROBE_JS).toMatch(/^\(function\(\)\{/);
    expect(PAGE_PROBE_JS).toMatch(/document\.activeElement/);
    // 单引号/双引号都不能出现裸的未转义换行拼接问题；这里只钉住它可被解析
    expect(() => new Function('return ' + PAGE_PROBE_JS)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canvas 指纹（2026-10-29）
//
// 为什么单独一组：上面 16 条全是 DOM 信号，而**纯 canvas 应用的写入在 DOM 上常常
// 是零字节**。实测 Excalidraw：拖出一个矩形，DOM 节点数与文本哈希都不变，于是
// page_changed 只能靠"选中后右侧属性面板出现"这种副作用偶然为真；动作一旦不产生
// 面板变化（移动已有图元、画布空白处涂色），就会报 false 并附一句"payload 很可能
// 没落地" —— 把成功的写入说成失败。
//
// 三条边界必须同时钉住，缺一条就会走向反面：
//   1. 只 canvas 变 → changed:true（新增的能力）
//   2. 有 canvas 但两边都不变 → changed:false（不能变成恒真）
//   3. 没有 canvas 指纹（c 缺失）→ 与加这个信号之前**逐字节一致**（旧行为不许漂移）
const PC = (t, n, d, c, u = 'https://a.test/x') => ({ t, h: 'h' + t, n, d, u, c });

describe('diffProbe — canvas 帧指纹', () => {
  it('PP-17 DOM 一字未变、只有画布重绘 → changed:true 且 domChanged:false', () => {
    const d = diffProbe(PC(100, 500, 0, 'abc:40:2'), PC(100, 500, 0, 'def:44:2'));
    expect(d.changed).toBe(true);
    expect(d.domChanged).toBe(false);
    expect(d.canvasChanged).toBe(true);
  });

  it('PP-18 有指纹但两边相同 → changed:false（阳性对照：不能恒真）', () => {
    const d = diffProbe(PC(100, 500, 0, 'abc:40:2'), PC(100, 500, 0, 'abc:40:2'));
    expect(d.changed).toBe(false);
    expect(d.canvasChanged).toBe(false);
    expect(d.domChanged).toBe(false);
  });

  it('PP-19 页面没有 canvas 指纹 → canvasChanged:null，结论仍由 DOM 决定', () => {
    const same = diffProbe(P(100, 500, 0), P(100, 500, 0));
    expect(same.canvasChanged).toBeNull();
    expect(same.changed).toBe(false);
    const moved = diffProbe(P(100, 500, 0), P(100, 501, 0));
    expect(moved.canvasChanged).toBeNull();
    expect(moved.changed).toBe(true);
  });

  it('PP-20 只有一侧有指纹（探针执行期间 hook 刚装上）→ 不下结论', () => {
    expect(diffProbe(PC(100, 500, 0, 'abc:1:0'), P(100, 500, 0)).canvasChanged).toBeNull();
    expect(diffProbe(P(100, 500, 0), PC(100, 500, 0, 'abc:1:0')).canvasChanged).toBeNull();
  });

  it('PP-21 仅画布变化时回执要说明"DOM 没动"，且不把写类动作判成没落地', () => {
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      PC(100, 500, 0, 'abc:40:2'), PC(100, 500, 0, 'def:47:2'), 'drag',
    );
    expect(out.page_changed).toBe(true);
    expect(out.canvas_changed).toBe(true);
    expect(out.effect_hint).toMatch(/canvas/i);
    // 关键：不能因为"DOM 没变"就把已经观测到画布变化的写操作降级成 unknown
    expect(out.effect_state).toBe('committed');
    expect(out.retry).toBeUndefined();
  });

  it('PP-22 DOM 正常变化时不多说一个字（不制造噪音）', () => {
    const out = applyProbe({ success: true }, PC(100, 500, 0, 'a:1:0'), PC(120, 500, 0, 'b:2:0'), 'click');
    expect(out.page_changed).toBe(true);
    expect(out.canvas_changed).toBeUndefined();
    expect(out.effect_hint).toBeUndefined();
  });

  it('PP-23 两边都不变时写类动作仍降级 effect_state（canvas 信号不掩盖真失败）', () => {
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      PC(100, 500, 0, 'abc:40:2'), PC(100, 500, 0, 'abc:40:2'), 'paste',
    );
    expect(out.page_changed).toBe(false);
    expect(out.effect_state).toBe('unknown');
    expect(out.retry).toBe('verify_first');
    expect(out.effect_hint).toMatch(/payload/i);
  });

  it('PP-24 探针脚本读的是固定名 window.__aiCanvasFp', () => {
    expect(PAGE_PROBE_JS).toContain('__aiCanvasFp');
  });
});

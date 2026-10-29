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
// c = 帧指纹；k = 绘制计数（判断空闲窗口里"画过没有"）；v = visibilityState。
// 后两个是空闲标定的正证据，缺了它们只能得到 canvasIdle:null（不可判）。
const PC = (t, n, d, c, u = 'https://a.test/x', k = 0, v = 'visible') => ({ t, h: 'h' + t, n, d, u, c, k, v });

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

  it('PP-22 DOM 变化 + 画布也变 → 不解释、不制造噪音（canvas 字段仍如实报）', () => {
    const out = applyProbe({ success: true }, PC(100, 500, 0, 'a'), PC(120, 500, 0, 'b'), 'click');
    expect(out.page_changed).toBe(true);
    expect(out.canvas_changed).toBe(true);
    expect(out.dom_changed).toBe(true);
    // 有 DOM 变化时不该再解释"为什么算变了"——原因明摆着
    expect(out.effect_hint).toBeUndefined();
  });

  it('PP-22b 没有 canvas 的页面完全不带 canvas 字段（与加信号之前一致）', () => {
    const out = applyProbe({ success: true }, P(100, 500, 0), P(120, 500, 0), 'click');
    expect(out.page_changed).toBe(true);
    expect('canvas_changed' in out).toBe(false);
    expect('dom_changed' in out).toBe(false);
    expect('canvas_idle' in out).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// 空闲标定（PP-25..27）：把"这一页自己会重绘"与"我的动作让它重绘"分开。
//
// 这一组来自一次红队评审：只比帧指纹能挡掉"同内容重绘"，但挡不掉"每帧内容都不同"
// 的页面（时钟指针、协作者光标、进度条、直播、ECharts 动画区间）。那些页面上
// "画布变了"永远成立 —— 若不标定，page_changed 会重新变成恒真，恰好把
// page_probe 存在的意义（抓"点了没反应"）反过来废掉。
//
// 判据：动作之前先采一次，隔 150ms 再采一次。两次不同 = 这一页自己在动。
describe('diffProbe — 空闲标定（画布会不会自己动）', () => {
  it('PP-25 自漂页：画布变化不可归因 → canvas_changed=null，不谎称"变了"', () => {
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      PC(100, 500, 0, 'f1'), PC(100, 500, 0, 'f2'), 'drag',
      { idleBaseline: PC(100, 500, 0, 'f0') }, // 空闲期指纹就在变
    );
    expect(out.page_changed).toBe(false);
    expect(out.canvas_changed).toBeNull();
    expect(out.canvas_idle).toBe(false);
    expect(out.dom_changed).toBe(false);
    // 观测手段在这里是坏的，所以不能说"payload 很可能没落地"
    expect(out.effect_hint).toMatch(/unusable/i);
    // drag 的"无变化"本来就是合法的（阈值/吸附会吞掉小位移），所以不降级
    expect(out.effect_state).toBe('committed');
  });

  it('PP-25b 自漂页 + 写类动作（paste）→ 降级成"先验证"，因为观测手段坏了', () => {
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      PC(100, 500, 0, 'f1'), PC(100, 500, 0, 'f2'), 'paste',
      { idleBaseline: PC(100, 500, 0, 'f0') },
    );
    expect(out.canvas_changed).toBeNull();
    expect(out.canvas_idle).toBe(false);
    expect(out.effect_state).toBe('unknown');
    expect(out.retry).toBe('verify_first');
  });

  it('PP-26 静止页 + 画布变化 → 可归因，判 changed 并说明别重做', () => {
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      // 空闲窗口里一次绘制都没有（k 一直是 3）→ 页面确实静止，变化可归因给动作
      PC(100, 500, 0, 'f1', undefined, 3), PC(100, 500, 0, 'f2', undefined, 9), 'drag',
      { idleBaseline: PC(100, 500, 0, 'f1', undefined, 3) },
    );
    expect(out.page_changed).toBe(true);
    expect(out.canvas_changed).toBe(true);
    expect(out.canvas_idle).toBe(true);
    expect(out.dom_changed).toBe(false);
    expect(out.effect_hint).toMatch(/do not redo/i);
    expect(out.effect_state).toBe('committed');
  });

  it('PP-26b 空闲期在画（哪怕画的是同一帧）→ 不可归因', () => {
    // 这条是修正后的判据，之前写错过：原来用"空闲期两次采样指纹不同"来判断
    // 页面是否自己在画，于是「60fps 画同一个画面」的页面有相当概率被取到同一个
    // 前缀哈希，被判成静止，接着把页面自己的动画算成我的功劳 —— 错在放行方向。
    // 绘制计数单调递增，空闲期涨了就是画了，与采样相位无关。
    const out = applyProbe(
      { success: true, effect_state: 'committed' },
      PC(100, 500, 0, 'f1', undefined, 5), PC(100, 500, 0, 'f2', undefined, 9), 'drag',
      { idleBaseline: PC(100, 500, 0, 'f1', undefined, 2) }, // k 2→5，画了 3 笔
    );
    expect(out.canvas_idle).toBe(false);
    expect(out.canvas_changed).toBeNull();
    expect(out.page_changed).toBe(false);
  });

  it('PP-27 自漂页但 DOM 也变了 → 结论由 DOM 决定，画布仍标为不可用', () => {
    const out = applyProbe(
      { success: true }, PC(100, 500, 0, 'f1'), PC(100, 620, 0, 'f2'), 'click',
      { idleBaseline: PC(100, 500, 0, 'f0') },
    );
    expect(out.page_changed).toBe(true);   // DOM +120 节点，这是可信的
    expect(out.canvas_changed).toBeNull(); // 画布这一半不可用，如实说
    expect(out.canvas_idle).toBe(false);
    expect(out.dom_changed).toBe(true);
  });

  it('PP-28 证据不足时必须给 null，不许猜"它不会自漂"', () => {
    // 页面被节流冻住了：空闲期一次绘制都没有，动作之后也还是没画。
    // 此时既没有"它不会动"的证据，也没有"它动了"的证据 —— 唯一诚实的答案是 null。
    const out = applyProbe(
      { success: true },
      PC(100, 500, 0, 'f1', undefined, 3, 'hidden'),
      PC(100, 500, 0, 'f1', undefined, 3, 'hidden'),
      'click',
      { idleBaseline: PC(100, 500, 0, 'f1', undefined, 3, 'hidden') },
    );
    expect(out.canvas_idle).toBeNull();
    // canvas_changed 仍然是 false（画布确实没变，这是有价值的确定信息），
    // 但 canvas_idle 必须是 null：能说"没变"，不能说"它不会自己变"。
    expect(out.canvas_changed).toBe(false);
    expect('canvas_idle' in out).toBe(true);
  });

  it('PP-28b 动作唤醒了页面动画 → 判自漂（不能算成我的功劳）', () => {
    // 最阴的一种：动作前冻着，动作后一直画。仅看"动作后画了"会误判成
    // "页面本来不画，这一笔是我干的" —— 必须看动作**之后**它停没停。
    const out = applyProbe(
      { success: true },
      PC(100, 500, 0, 'f1', undefined, 3, 'hidden'),
      PC(100, 500, 0, 'f2', undefined, 9, 'hidden'),
      'click',
      {
        idleBaseline: PC(100, 500, 0, 'f1', undefined, 3, 'hidden'),
        postBaseline: PC(100, 500, 0, 'f3', undefined, 24, 'hidden'), // 还在画
      },
    );
    expect(out.canvas_idle).toBe(false);
    expect(out.canvas_changed).toBeNull();
    expect(out.page_changed).toBe(false);
  });

  it('PP-28c 动作后画了一次就停 → 可归因（静态页的常态）', () => {
    const out = applyProbe(
      { success: true },
      PC(100, 500, 0, 'f1', undefined, 3, 'visible'),
      PC(100, 500, 0, 'f2', undefined, 6, 'visible'),
      'drag',
      {
        idleBaseline: PC(100, 500, 0, 'f1', undefined, 3, 'visible'),
        postBaseline: PC(100, 500, 0, 'f2', undefined, 6, 'visible'), // 停了
      },
    );
    expect(out.canvas_idle).toBe(true);
    expect(out.canvas_changed).toBe(true);
    expect(out.page_changed).toBe(true);
  });

  it('PP-29 动作之后画面还在变 → 即使空闲期静止也判自漂', () => {
    // 动作唤醒了页面动画的典型形态：动作前冻着，动作后一直画。
    const out = applyProbe(
      { success: true },
      PC(100, 500, 0, 'f1', undefined, 5, 'visible'),
      PC(100, 500, 0, 'f2', undefined, 9, 'visible'),
      'click',
      {
        idleBaseline: PC(100, 500, 0, 'f1', undefined, 2, 'visible'), // 空闲期静止
        postBaseline: PC(100, 500, 0, 'f3', undefined, 20, 'visible'), // 动作后仍在变
      },
    );
    expect(out.canvas_idle).toBe(false);
    expect(out.canvas_changed).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PP-30 默认导出必须覆盖全部具名导出
//
// 这条来自一次真实的、代价很大的失误：page_manager 用的是
// `import pageProbe from '../shared/page_probe.js'`（默认导出对象），而
// IDLE_WINDOW_MS 只加进了命名导出。于是 `pageProbe.IDLE_WINDOW_MS` 是 undefined，
// `setTimeout(r, undefined)` 等于 0ms —— "空闲标定"退化成"立刻再采一次"，
// 两次采样的绘制计数完全相同，页面被误判成静止，动画页上的"画布变了"被算成
// 动作生效。没人报错，单元测试也全绿（它们 import 的是命名空间）。
//
// 这与本项目另外三次是同一类：**同一个概念在两层形状不同，调用方不报错、
// 只是拿到 undefined 或别人的数据**。区别是这次连"拿到别人的数据"都没有，
// 拿到的是 undefined → 静默降级。
//
// 逐键核对而不是写死清单：以后往命名导出加东西，忘了同步默认导出就会红。
import * as pageProbeNs from '../src/shared/page_probe.js';

describe('shared/page_probe 导出形状', () => {
  it('PP-30 默认导出对象覆盖全部具名导出（漏一个就是静默 undefined）', () => {
    const names = Object.keys(pageProbeNs).filter((k) => k !== 'default');
    expect(names.length).toBeGreaterThan(3);
    const missing = names.filter((k) => pageProbeNs.default[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('PP-31 IDLE_WINDOW_MS 是有限正数（0/undefined 会让标定变成空转）', () => {
    const v = pageProbeNs.default.IDLE_WINDOW_MS;
    expect(typeof v).toBe('number');
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });
});

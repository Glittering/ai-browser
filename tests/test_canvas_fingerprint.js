// tests/test_canvas_fingerprint.js — canvas 帧指纹的行为契约（**执行**真实源码）
//
// 单独成文件而不是塞进 test_canvas_hook_source.js，理由有二：
//   1. 那个文件测的是"产出的字符串里有没有该有的东西"（契约漂移），这个文件测的是
//      "跑起来到底怎么表现"（行为）。两者失败的排查方向完全不同。
//   2. 这里 import 了 node:vm 与 node 侧的桩，和纯字符串断言混在一起时，
//      一次语法问题会让整个套件报"0 test"，看不出是哪个层次坏了。
//
// 教训（本文件第一次落地时就踩了）：hook 源码是**模板字符串**，在里面写反引号会
// 提前闭合模板，产出的不是 JS。而这种错误**不会**在 import 时暴露（buildCanvasHookSource
// 只是拼字符串），它会以"测试文件 parse 错"的形态冒出来，错误信息指向测试文件而不是
// 源头。所以下面每条用例的第一步都是 `new Function(src)` —— 先把语法钉死。
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { buildCanvasHookSource } from '../src/main/canvas_hook_source.js';
import { PAGE_PROBE_JS } from '../src/shared/page_probe.js';
import { DEFAULT_SNAPSHOT_JS } from '../src/main/snapshot_diff.js';

function bootHook(mode) {
  const proto = {
    fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
    drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {},
    stroke() {}, fill() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    setTransform() {}, getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    isPointInPath() { return false; },
  };
  const sand = {
    document: { createElement() { return {}; } },
    CanvasRenderingContext2D: { prototype: proto },
    setTimeout: (fn) => { fn(); return 0; },
    __report: () => {},
    console,
  };
  sand.window = sand;
  sand.top = sand;
  vm.createContext(sand);
  const src = buildCanvasHookSource({ bindingName: '__report', bridgeKey: '__bridge', mode });
  new Function(src); // 模板被提前闭合的话，这里就抛出
  vm.runInContext(src, sand);
  const ctx = () => {
    const c = Object.create(proto);
    c.canvas = { width: 800, height: 600 };
    return c;
  };
  return { sand, ctx };
}

describe('canvas 帧指纹 — 暴露与初值', () => {
  it('CF-01 暴露不可枚举的 window.__aiCanvasFp，初始全零', () => {
    const { sand } = bootHook('semantic');
    expect(typeof sand.__aiCanvasFp).toBe('function');
    // 不可枚举：不能被页面自己的 Object.keys(window) 扫到
    expect(Object.prototype.propertyIsEnumerable.call(sand, '__aiCanvasFp')).toBe(false);
    expect(sand.__aiCanvasFp()).toEqual({ n: 0, fp: 0, frames: 0, on: 1 });
  });

  it('CF-02 mode=off 返回 null，而不是 {n:0} —— "没在录"≠"录了但空"', () => {
    const { sand, ctx } = bootHook('off');
    ctx().fillRect(0, 0, 10, 10);
    expect(sand.__aiCanvasFp()).toBeNull();
  });

  it('CF-03 页面无法顶掉这个属性（configurable:false）', () => {
    const { sand } = bootHook('semantic');
    // 属性不可配置时，页面想用 defineProperty 换成"永远返回常量"的函数会被拒绝。
    // 否则被观测方可以单方面关掉验证能力，而工具看不出来。
    expect(() => {
      Object.defineProperty(sand, '__aiCanvasFp', { value: () => ({ fp: 0, n: 0, frames: 0 }), configurable: true });
    }).toThrow();
  });
});

describe('canvas 帧指纹 — 内容相同就是同一个指纹', () => {
  it('CF-04 同一帧内容重放 → fp 不变（这是整套验证的地基）', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    const frame = () => {
      c.clearRect(0, 0, 800, 600);
      c.fillRect(0, 0, 800, 600);
      c.fillRect(10, 10, 100, 50);
    };
    frame();
    const a = sand.__aiCanvasFp();
    frame();
    const b = sand.__aiCanvasFp();
    expect(a.fp).not.toBe(0);
    // fp 必须相同：否则每一次自漂式重绘都会被 page_probe/ui.diff 报成 changed，
    // 而"点了没反应"这件事就再也检测不出来了。
    expect(b.fp).toBe(a.fp);
  });

  it('CF-05 多画一个形状 → fp 变（这条才是"写入被看见"的证据）', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    c.clearRect(0, 0, 800, 600); c.fillRect(0, 0, 800, 600); c.fillRect(10, 10, 100, 50);
    const before = sand.__aiCanvasFp().fp;
    c.clearRect(0, 0, 800, 600); c.fillRect(0, 0, 800, 600); c.fillRect(10, 10, 100, 50);
    c.fillRect(200, 200, 60, 60);
    expect(sand.__aiCanvasFp().fp).not.toBe(before);
  });

  it('CF-06 整屏 fillRect 也开启新一帧（有些渲染器从不清屏）', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    // 只做整屏铺底，不做 clearRect：帧边界必须由这次 fillRect 给出，
    // 否则 fp 会从页面打开起一直累积成一个"会话日志哈希"。
    c.fillRect(0, 0, 800, 600);
    const a = sand.__aiCanvasFp();
    expect(a.frames).toBe(1);
    expect(a.fp).toBe(0); // 帧刚开始，还没有内容

    c.fillRect(10, 10, 100, 50);
    const b = sand.__aiCanvasFp();
    expect(b.frames).toBe(1);
    expect(b.fp).not.toBe(0);

    // 下一帧：整屏铺底 + 完全一样的内容 → fp 应该回到同一个值
    c.fillRect(0, 0, 800, 600);
    c.fillRect(10, 10, 100, 50);
    expect(sand.__aiCanvasFp().fp).toBe(b.fp);
  });

  it('CF-08 增量绘制（从不整屏清屏）也累积 —— 否则"画了新笔画"永远看不见', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    // 这类渲染器只把新笔画叠上去，没有帧边界（白板的增量提交流、某些图表库）
    c.beginPath(); c.moveTo(0, 0); c.lineTo(10, 10); c.stroke();
    const a = sand.__aiCanvasFp();
    expect(a.fp).not.toBe(0);
    expect(a.frames).toBe(0); // 确认真的没有帧边界走到
    c.beginPath(); c.moveTo(20, 20); c.lineTo(30, 30); c.stroke();
    expect(sand.__aiCanvasFp().fp).not.toBe(a.fp);
  });

  it('CF-09 同一页面上两个 canvas 的绘制都进指纹（页面级变化检测）', () => {
    // Excalidraw 实测就是 2 个 2D canvas（主画布 + 离屏）。指纹是**每个 realm 一份**，
    // 不是每个 canvas 一份：我们要回答的是"这一页的画布有没有被画过"，
    // 按 canvas 分开只会让调用方多读几份而没有额外判断力。
    const { sand, ctx } = bootHook('semantic');
    const main = ctx();
    const off = ctx();
    main.fillRect(0, 0, 100, 100);
    const afterMain = sand.__aiCanvasFp();
    off.fillRect(0, 0, 10, 10); // 另一张画布
    expect(sand.__aiCanvasFp().fp).not.toBe(afterMain.fp);
  });

  it('CF-07 上下文状态调用不进指纹（一个像素都没画就不算变更）', () => {
    const { sand, ctx } = bootHook('trace'); // trace 才会记录 save/restore/translate
    const c = ctx();
    c.fillRect(0, 0, 800, 600);
    c.fillRect(10, 10, 100, 50);
    const before = sand.__aiCanvasFp();
    c.save(); c.translate(10, 10); c.restore();
    const after = sand.__aiCanvasFp();
    // state 记录改的是上下文状态，不是像素；让它进 fp，等于 ECharts / 广告位 /
    // 1×1 反爬 canvas 上一次"什么都没画"的 render 也会被报成"画布变了"。
    expect(after.fp).toBe(before.fp);
    expect(after.n).toBeGreaterThan(before.n); // 仍然计数（trace 要看得到它们）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 接入层：**执行**探针与快照脚本，确认被比较的值里没有单调计数器
//
// 这一组存在的理由是一次真实的退化：hook 里的 fp 语义是对的（同内容 → 同 fp），
// 但 page_probe 把它包装成 `fp:n:frames` 的拼接串再比较。n 与 frames 单调递增，
// 于是"内容逐字节相同的重绘"（时钟、光标、动画循环）也会让字符串变化 ——
// page_changed 变成恒真，恰好把 page_probe 存在的意义反过来废掉。
//
// 教训不是"要小心"，而是：**单测证明了 A，产品用的是 A 的包装 B**。两边各自都
// "对"，合起来是错的。所以这里不查字符串里写了什么，而是真的跑一遍脚本。
function probeSandbox(fpApi) {
  const sand = {
    document: {
      body: { innerText: 'hello world', textContent: 'hello world' },
      activeElement: null,
      visibilityState: 'visible',
      getElementsByTagName: () => new Array(7),
      title: 'T',
      querySelectorAll: () => [],
    },
    location: { href: 'https://a.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout: (fn) => { fn(); return 0; },
    console,
  };
  sand.window = sand;
  if (fpApi) sand.__aiCanvasFp = fpApi;
  vm.createContext(sand);
  return sand;
}

describe('接入层 — 被比较的值只含帧指纹', () => {
  it('CF-10 PAGE_PROBE_JS 的 c 只取 fp；n/frames 变了它不变', () => {
    const run = (n, frames, fp) => {
      const sand = probeSandbox(() => ({ fp, n, frames, on: 1 }));
      return vm.runInContext(PAGE_PROBE_JS, sand);
    };
    const a = run(10, 3, 12345);
    const b = run(99, 42, 12345); // 画了更多遍，内容一模一样
    expect(a.c).toBe('12345');
    expect(b.c).toBe(a.c); // ← 计数器绝不能进来
    expect(Number(a.k)).toBe(10); // 计数仍然上报，只是不参与内容比较
  });

  it('CF-11 DEFAULT_SNAPSHOT_JS 的 canvas 是标量，不是带计数器的对象', () => {
    const run = (n, frames, fp) => {
      const sand = probeSandbox(() => ({ fp, n, frames, on: 1 }));
      return vm.runInContext(DEFAULT_SNAPSHOT_JS, sand);
    };
    const a = run(10, 3, 777);
    const b = run(88, 31, 777);
    expect(a.canvas).toBe(777);
    expect(typeof a.canvas).not.toBe('object');
    // 快照进 diff 的就是这个值：只要它跟着计数器走，停在原地的页面也会被报 changed
    expect(b.canvas).toBe(a.canvas);
  });

  it('CF-12 页面没装 hook 时 c 为 null、快照没有 canvas 字段（不能伪造成 0）', () => {
    const p = vm.runInContext(PAGE_PROBE_JS, probeSandbox(null));
    expect(p.c).toBeNull();
    const s = vm.runInContext(DEFAULT_SNAPSHOT_JS, probeSandbox(null));
    expect('canvas' in s).toBe(false);
  });
});

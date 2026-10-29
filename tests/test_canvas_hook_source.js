// tests/test_canvas_hook_source.js — canvas 注入脚本的契约测试
//
// buildCanvasHookSource() 产出的是一段**字符串**，要被
// Page.addScriptToEvaluateOnNewDocument（不传 worldName）注入页面 main world。
// 它是纯函数、不依赖 Electron，所以可以在单测里验证：
//   1. 产出的源码语法合法（否则注入后整页脚本报错，页面直接坏掉）
//   2. 关键契约没漂移（binding 名、bridge key、mode、要包裹的方法）
//
// 真正的"能不能录到 fillText"由 e2e/canvas_ws.cjs 在真实浏览器里验。

import { describe, it, expect } from 'vitest';
import { buildCanvasHookSource } from '../src/main/canvas_hook_source.js';

const build = (opts) => buildCanvasHookSource(opts);

describe('buildCanvasHookSource', () => {
  it('产出的源码语法合法（可被引擎解析）', () => {
    const src = build({ bindingName: '__aiCanvasReport', bridgeKey: '__aiCanvasBridge' });
    expect(typeof src).toBe('string');
    expect(src.length).toBeGreaterThan(1000);
    // 语法不合法会直接抛 SyntaxError
    expect(() => new Function(src)).not.toThrow();
  });

  it('注入的 binding 名与 bridge key 来自入参', () => {
    const src = build({ bindingName: 'BND_1', bridgeKey: 'KEY_1' });
    expect(src).toContain('BND_1');
    expect(src).toContain('KEY_1');
    // 不同名字必须产出不同源码，避免拼接写死
    expect(src).not.toBe(build({ bindingName: 'BND_2', bridgeKey: 'KEY_2' }));
  });

  it('mode 来自入参（off / semantic / trace）', () => {
    expect(build({ mode: 'off' })).toContain('off');
    expect(build({ mode: 'trace' })).toContain('trace');
    // 未传时回落到 semantic
    expect(build({})).toContain('semantic');
  });

  it('包裹了 2D 的主要绘制方法（这是"读得懂 canvas"的根基）', () => {
    const src = build({});
    for (const m of ['fillText', 'strokeText', 'fillRect', 'strokeRect', 'clearRect', 'drawImage']) {
      expect(src, `应包裹 ${m}`).toContain(m);
    }
  });

  it('覆盖 WebGL 上下文（至少要能标记它不透明）', () => {
    const src = build({});
    expect(src).toContain('WebGLRenderingContext');
    expect(src).toContain('WebGL2RenderingContext');
  });

  it('覆盖 OffscreenCanvas', () => {
    const src = build({});
    expect(src).toContain('OffscreenCanvas');
  });

  it('幂等：重复安装不重复包裹（避免记录翻倍）', () => {
    const src = build({});
    // 脚本靠这些标记位做幂等短路
    expect(src).toContain('__aiCanvasHook');
    expect(src).toMatch(/__ai2dInstalled|__aiGLInstalled|__aiCanvasWrapper/);
  });

  it('上报载荷带版本、导航、帧与调用列表（主进程据此解析）', () => {
    const src = build({});
    // 载荷由 JSON.stringify 统一构造（不允许手写转义）：{ v, nav, frame, calls }
    expect(src).toContain('v: 1');
    expect(src).toContain('nav: NAV');
    expect(src).toContain('frame: FRAME');
    expect(src).toContain('calls: objs');
  });

  it('载荷不得手写转义引号（曾在模板内被吃掉反斜杠导致整页 SyntaxError）', () => {
    const src = build({});
    expect(src).not.toContain('\\"v\\":1');
    // 生成的代码本身必须语法合法 —— 这一条是上面语法用例的显式护栏
    expect(() => new Function(src)).not.toThrow();
  });

  it('走 tee 语义：先让原生 API 执行，再记录（不改变页面行为）', () => {
    const src = build({});
    expect(src).toContain('Reflect.apply');
  });

  it('bridge 暴露 setMode / flush，供主进程在运行时切换与强制回传', () => {
    const src = build({});
    expect(src).toContain('setMode');
    expect(src).toContain('flush');
    expect(src).toContain('getMode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 帧指纹（window.__aiCanvasFp）—— **执行**这棵源码，而不是在字符串里找关键词。
//
// 教训（本项目踩过一次 CP-011..015 之前的坑）：只对着"源码里应该出现什么字符串"
// 做断言，格式一漂移全部照绿，而真实行为早已失效。这里在 node:vm 里给一个最小
// 的假 window + 假 CanvasRenderingContext2D，真的调 fillRect/clearRect，
// 再读指纹。任何一环没接上（wrap 没装、push 没累积、getter 没暴露）都会失败。
//
// 为什么这个指纹重要：纯 canvas 应用的写入在 DOM 上常常零字节（实测 Excalidraw
// 拖出一个矩形，DOM 一个字都没变）。page_probe 与 ui.diff 全靠它才能看见画布变化。
import vm from 'node:vm';

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
  vm.runInContext(build({ bindingName: '__report', bridgeKey: '__bridge', mode }), sand);
  const ctx = () => {
    const c = Object.create(proto);
    c.canvas = { width: 800, height: 600 };
    return c;
  };
  return { sand, ctx };
}

describe('canvas 帧指纹（执行真实源码）', () => {
  it('暴露了不可枚举的 window.__aiCanvasFp，初始为全零', () => {
    const { sand } = bootHook('semantic');
    expect(typeof sand.__aiCanvasFp).toBe('function');
    // 不可枚举：不能被页面自己的 Object.keys(window) 扫到
    expect(Object.prototype.propertyIsEnumerable.call(sand, '__aiCanvasFp')).toBe(false);
    expect(sand.__aiCanvasFp()).toEqual({ n: 0, fp: 0, frames: 0, on: 1 });
  });

  it('画了什么就反映什么：同一帧内容重放得到同一个 fp', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    const frame = () => { c.clearRect(0, 0, 800, 600); c.fillRect(0, 0, 800, 600); c.fillRect(10, 10, 100, 50); };
    frame();
    const a = sand.__aiCanvasFp();
    frame();
    const b = sand.__aiCanvasFp();
    expect(a.fp).not.toBe(0);
    expect(a.frames).toBe(1);
    expect(b.frames).toBe(2);
    // 这是最关键的一条：内容没变的帧必须得到同一个指纹，否则每次 diff 都会
    // 因为动画/重绘报 changed，验证能力等于零。
    expect(b.fp).toBe(a.fp);
  });

  it('多画一个形状 → fp 变（这条才是"写入被看见"的证据）', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    c.clearRect(0, 0, 800, 600); c.fillRect(0, 0, 800, 600); c.fillRect(10, 10, 100, 50);
    const before = sand.__aiCanvasFp().fp;
    c.clearRect(0, 0, 800, 600); c.fillRect(0, 0, 800, 600); c.fillRect(10, 10, 100, 50);
    c.fillRect(200, 200, 60, 60);
    expect(sand.__aiCanvasFp().fp).not.toBe(before);
  });

  it('clear 之外的绘制也会累积（有些渲染器从不清屏）', () => {
    const { sand, ctx } = bootHook('semantic');
    const c = ctx();
    c.fillRect(0, 0, 10, 10);
    const a = sand.__aiCanvasFp();
    c.fillRect(0, 0, 20, 10);
    const b = sand.__aiCanvasFp();
    expect(a.frames).toBe(0);
    expect(a.fp).not.toBe(0);
    expect(b.fp).not.toBe(a.fp);
  });

  it('mode=off 时返回 null，而不是 {n:0} —— "没在录"≠"录了但空"', () => {
    const { sand, ctx } = bootHook('off');
    ctx().fillRect(0, 0, 10, 10);
    expect(sand.__aiCanvasFp()).toBeNull();
  });
});

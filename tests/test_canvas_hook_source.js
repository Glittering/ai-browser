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

// tests/test_app_model.js — 「实例关在闭包里」这条路的判据
//
// 这些用例存在，是因为**同一个错判发生了两次**：suxieban 与 yunser 都被
// 判成「纯 canvas、没有应用模型」，而它们分别是 fabric 5.2.1 和
// window.DrawBoard，读写能力完整。capability_probe 扫 window 扫不到实例，
// 于是把一个 A 档站点降级成「只能帧指纹」。
//
// 这里不测「函数被调用过」，而是**执行真的页面脚本**（buildAppModelSource
// 产出的那一份），用 jsdom 造出和真实站点同构的最小页面：库 → 原型方法 →
// DOM 事件监听 → 实例。探针必须在这上面真的抓到 this，单测才算过。
//
// 另一半是安全性：tee 不能改变页面行为、必须可原样卸载、expr 类不许碰原型。
// 这三条任何一条破了，都是「我的观测改了被观测对象」。
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  ADAPTERS,
  GENERIC_HINT,
  buildAppModelSource,
  summarize,
  readFabric,
  readKonva,
  readPaper,
  readCodeMirror,
  readMonaco,
  readExcalidraw,
} from '../src/main/app_model_source.js';

// jsdom 的 getBoundingClientRect 恒返回 0，探针要求 >4 才派发合成鼠标。
// 补一个固定尺寸（这是 jsdom 的限制，不是产品逻辑要放宽的判据）。
function makeDom(html, setup) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 };
  };
  if (setup) setup(w);
  return dom;
}

function probe(dom, opts) {
  return dom.window.eval(buildAppModelSource(opts));
}

// 造一个和真实 fabric 站点同构的最小页面：
//   window.fabric → Canvas 构造器 → 原型方法 → upper-canvas 上绑 mousemove →
//   页面自己的回调调用 inst.__onMouseMove()（这正是 fabric 的绑法）
const FABRIC_PAGE = `
  window.fabric = { version: '5.2.1' };
  window.fabric.Canvas = function () {};
  fabric.Canvas.prototype.__onMouseMove = function () { return 'moved'; };
  fabric.Canvas.prototype._onMouseMove = function () { return 'inner'; };
  fabric.Canvas.prototype.renderAll = function () { this.r = (this.r || 0) + 1; return 'rendered'; };
  fabric.Canvas.prototype.getObjects = function () { return this._objs || []; };
  fabric.Canvas.prototype.add = function (o) { (this._objs = this._objs || []).push(o); return this; };
  document.body.insertAdjacentHTML('beforeend',
    '<div class="canvas-container"><canvas class="lower-canvas"></canvas><canvas class="upper-canvas"></canvas></div>');
  var inst = new fabric.Canvas();
  window.__inst = inst;
  inst._objs = [{ type: 'rect', left: 10, top: 20, width: 100, height: 50, scaleX: 2 }];
  window.__origOnMove = fabric.Canvas.prototype.__onMouseMove;
  window.__origRender = fabric.Canvas.prototype.renderAll;
  // fabric 的真实绑法：把原型事件方法绑在 upper-canvas 上。合成事件到达这里时
  // 再动态查找 inst.__onMouseMove —— 于是会不会走到 tee，取决于探针有没有先装好。
  document.querySelector('canvas.upper-canvas').addEventListener('mousemove', function () {
    inst.__onMouseMove();
  });
`;

describe('readXxx — 每个库的读取器（喂假实例，不碰页面）', () => {
  it('AM-01: fabric 读几何时把 scale 算进尺寸', () => {
    const inst = {
      getObjects: () => [
        { type: 'rect', left: 10, top: 20, width: 100, height: 50, scaleX: 2, scaleY: 1, fill: '#3b82f6' },
        { type: 'textbox', left: 5, top: 60, width: 80, height: 24, text: 'hello' },
      ],
    };
    const r = readFabric([inst]);
    expect(r.kind).toBe('objects');
    expect(r.count).toBe(2);
    expect(r.items[0].w).toBe(200);
    expect(r.items[0].h).toBe(50);
    expect(r.items[1].text).toBe('hello');
  });

  it('AM-02: supports 必须是实测 typeof，不许把清单硬编码上去', () => {
    // 只有 getObjects 的实例 → supports 里绝不能出现 toJSON/toSVG。
    const r = readFabric([{ getObjects: () => [] }]);
    expect(r.supports).toEqual(['getObjects']);
    expect(r.supports).not.toContain('toJSON');
  });

  it('AM-03: Konva 走 stage → layer → children 三层', () => {
    const stage = {
      getLayers: () => [
        {
          getChildren: () => [
            { getClassName: () => 'Rect', x: () => 5, y: () => 6 },
            { getClassName: () => 'Text', x: () => 7, y: () => 8, text: () => 'hi' },
          ],
        },
      ],
    };
    const r = readKonva([stage]);
    expect(r.count).toBe(2);
    expect(r.items[1]).toMatchObject({ type: 'Text', x: 7, y: 8, text: 'hi' });
  });

  it('AM-04: paper 用 position 定坐标、bounds 只补尺寸（bounds 含描边，会偏半个线宽）', () => {
    const proj = {
      activeLayer: {
        children: [
          { className: 'Path', position: { x: 10, y: 20 }, bounds: { x: 9.5, y: 19.5, width: 30, height: 40 } },
        ],
      },
    };
    const r = readPaper([proj]);
    expect(r.items[0]).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('AM-05: CodeMirror / Monaco 都归一到 text', () => {
    const cm = readCodeMirror([{ getValue: () => '# t\n\n- a' }]);
    expect(cm.kind).toBe('text');
    expect(cm.items[0].text).toContain('- a');
    const mc = readMonaco([{ getValue: () => 'x=1', uri: { toString: () => 'inmemory://m1' } }]);
    expect(mc.items[0].uri).toBe('inmemory://m1');
  });

  it('AM-06: Excalidraw 走 getSceneElements', () => {
    const r = readExcalidraw([
      { getSceneElements: () => [{ type: 'rectangle', x: 1, y: 2, width: 30, height: 40 }], updateScene: () => {} },
    ]);
    expect(r.count).toBe(1);
    expect(r.items[0]).toMatchObject({ type: 'rectangle', x: 1, y: 2, w: 30, h: 40 });
    expect(r.supports).toContain('updateScene');
  });
});

describe('探针在真实同构页面上抓实例（执行 buildAppModelSource 的产出）', () => {
  it('AM-07: 普通页面（无库）不报假库，并给可执行的兜底', () => {
    const dom = makeDom('<canvas class="plain"></canvas>');
    const raw = probe(dom);
    expect(raw.ok).toBe(true);
    expect(raw.libs.length).toBe(0);
    const s = summarize(raw);
    expect(s.ok).toBe(true);
    expect(s.notes[0]).toBe(GENERIC_HINT);
  });

  it('AM-08: fabric 页面 —— 靠一条合成 mousemove 抓到闭包实例并读出几何', () => {
    const dom = makeDom('', (w) => w.eval(FABRIC_PAGE));
    const raw = probe(dom);
    const f = raw.libs.find((l) => l.lib === 'fabric');
    expect(f, 'fabric 应被 detect 命中').toBeTruthy();
    expect(f.acquired).toBe(true);
    expect(f.version).toBe('5.2.1');
    expect(f.count).toBe(1);
    expect(f.items[0].w).toBe(200);
    // 探针自己要说清做了什么：合成鼠标算「打扰页面」，不能假装没发生。
    expect(raw.poked).toBeGreaterThan(0);
    const s = summarize(raw);
    expect(s.side_effect).toContain('synthetic mousemove');
  });

  it('AM-09: 幂等 —— 连跑两次只包一层 tee，卸载后原型回到原始函数', () => {
    const dom = makeDom('', (w) => w.eval(FABRIC_PAGE));
    probe(dom);
    const inst = dom.window.__inst;
    probe(dom);
    // tee 不改行为：计数照常 +1，返回值原样透传。
    const before = inst.r || 0;
    expect(inst.renderAll()).toBe('rendered');
    expect(inst.r).toBe(before + 1);

    const orig = dom.window.__origRender;
    expect(dom.window.fabric.Canvas.prototype.renderAll.__aiAmTeed).toBe(true);
    dom.window.eval('window.__aiAppModel.restore()');
    expect(dom.window.fabric.Canvas.prototype.renderAll).toBe(orig);
    expect(dom.window.fabric.Canvas.prototype.renderAll.__aiAmTeed).toBeUndefined();
  });

  it('AM-10: 自愈 —— 页面自己重定义原型方法后，下一次调用要重新包上', () => {
    const dom = makeDom('', (w) => w.eval(FABRIC_PAGE));
    expect(probe(dom).libs[0].acquired).toBe(true);

    // 页面热更新把原型方法整个换掉（tee 被覆盖，标记也一起没了）
    dom.window.eval('fabric.Canvas.prototype.__onMouseMove = function(){ return "replaced"; };');
    // 清掉上次抓到的实例，否则「已有实例」会掩盖「这次没抓到」
    dom.window.eval('window.__aiAppModel.hits = {};');

    const raw2 = probe(dom);
    expect(raw2.libs[0].acquired, '重定义后必须重新包，否则第二次永远是空').toBe(true);
  });

  it('AM-11: 装了 hook 但页面从不调用 → 如实报未获取，不伪造 read_expr', () => {
    const dom = makeDom('', (w) => {
      w.eval(`
        window.fabric = { version: '5.2.1' };
        window.fabric.Canvas = function () {};
        fabric.Canvas.prototype.__onMouseMove = function () {};
        fabric.Canvas.prototype.renderAll = function () {};
        fabric.Canvas.prototype.getObjects = function () { return []; };
        document.body.insertAdjacentHTML('beforeend',
          '<div class="canvas-container"><canvas class="lower-canvas"></canvas><canvas class="upper-canvas"></canvas></div>');
      `); // 故意不 new、不绑事件
    });
    const raw = probe(dom);
    const f = raw.libs.find((l) => l.lib === 'fabric');
    expect(f.acquired).toBe(false);
    expect(f.read_expr).toBeNull();
    expect(String(f.note)).toContain('did not call it');
    const s = summarize(raw);
    expect(s.notes.join(' ')).toContain('detected but not acquired');
  });

  it('AM-12: expr 类（Konva 注册表）不得碰任何原型，也不该派发合成鼠标', () => {
    const dom = makeDom('', (w) => {
      w.eval(`
        window.Konva = { version: '9.3.0', stages: [{
          getLayers: function(){ return [{ getChildren: function(){
            return [{ getClassName: function(){return 'Rect';}, x: function(){return 5;}, y: function(){return 6;} }];
          } }]; }
        }] };
      `);
    });
    const raw = probe(dom);
    const k = raw.libs.find((l) => l.lib === 'konva');
    expect(k.acquired).toBe(true);
    expect(k.count).toBe(1);
    expect(raw.poked).toBe(0);
    expect(dom.window.__aiAppModel.hits).toEqual({});
  });

  it('AM-13: maxItems 生效且明确标出 truncated', () => {    const dom = makeDom('', (w) => {
      w.eval(FABRIC_PAGE);
      w.__inst._objs = [
        { type: 'rect', left: 1, top: 1, width: 1, height: 1 },
        { type: 'rect', left: 2, top: 2, width: 2, height: 2 },
        { type: 'rect', left: 3, top: 3, width: 3, height: 3 },
      ];
    });
    const raw = probe(dom, { maxItems: 1 });
    const f = raw.libs.find((l) => l.lib === 'fabric');
    expect(f.count).toBe(3);
    expect(f.items.length).toBe(1);
    expect(f.truncated).toBe(true);
  });
});

describe('read_expr 的可执行性', () => {
  // e2e 的 AM-E13 在单测里的对应物。最初 hook 类适配器只给了后缀
  // (`.getObjects()`)，read_expr 交出去就是这 14 个字符 —— agent 喂给
  // ui.evaluate 时 this 是 undefined，当场 TypeError，而所有其它断言照样 PASS。
  // 「字段叫 read_expr」就必须真能读。
  it('AM-21: hook 类的 read_expr 必须是能在页面顶层求值的完整表达式', () => {
    const dom = makeDom('', (w) => w.eval(FABRIC_PAGE));
    const f = probe(dom).libs.find((l) => l.lib === 'fabric');
    expect(f.acquired).toBe(true);
    expect(f.read_expr).toContain('__aiAppModel.hits.fabric[0]');
    const v = dom.window.eval(f.read_expr); // 真的求值，不是看字符串像不像
    expect(Array.isArray(v)).toBe(true);
    expect(v.length).toBe(1);
    expect(v[0].type).toBe('rect');
  });

  it('AM-22: restore 之后 read_expr 返回 null，而不是抛错', () => {
    const dom = makeDom('', (w) => w.eval(FABRIC_PAGE));
    const expr = probe(dom).libs.find((l) => l.lib === 'fabric').read_expr;
    dom.window.eval('window.__aiAppModel.restore()');
    // 失效要可判断（null），不能变成异常 —— 否则 agent 拿到的是一句
    // "TypeError: cannot read property '0' of undefined"，无从区分是页面变了
    // 还是我们拼错了。
    expect(() => dom.window.eval(expr)).not.toThrow();
    expect(dom.window.eval(expr)).toBeNull();
  });

  it('AM-23: expr 类的 read_expr 原样交给调用方（它本来就是完整表达式）', () => {
    const dom = makeDom('', (w) => {
      w.eval('window.Konva = { version: "9", stages: [{ getLayers: function(){ return []; } }] };');
    });
    const k = probe(dom).libs.find((l) => l.lib === 'konva');
    expect(k.read_expr).toBe('window.Konva.stages');
    expect(dom.window.eval(k.read_expr).length).toBe(1);
  });
});

describe('summarize — 输出契约', () => {  it('AM-14: 没有派发就不许写 side_effect（自述字段不能恒真）', () => {
    const s = summarize({ ok: true, poked: 0, libs: [] });
    expect(s.side_effect).toBeNull();
  });

  it('AM-15: 导航后钩子失效必须标出来', () => {
    const s = summarize({ ok: true, poked: 0, libs: [] });
    expect(s.stale_after_navigation).toBe(true);
    expect(s.discipline).toContain('not evidence');
  });

  it('AM-16: include_items:false 仍给 count，别把摘要变成空对象', () => {
    const s = summarize({ ok: true, poked: 0, libs: [{ lib: 'fabric', acquired: true, count: 7, items: [1, 2] }] }, { include_items: false });
    expect(s.libs[0].count).toBe(7);
    expect(s.libs[0].items).toBeUndefined();
  });

  it('AM-17: 探针自身报错时透传，不当成「没有模型」', () => {
    const s = summarize({ ok: false, error: 'boom' });
    expect(s.ok).toBe(false);
    expect(s.error).toBe('boom');
  });
});

describe('适配器表自身的约束', () => {
  it('AM-18: 每条适配器都得有 id / detect / acquire / read', () => {
    for (const a of ADAPTERS) {
      expect(a.id, 'id 缺失').toBeTruthy();
      expect(typeof a.detect, `${a.id}.detect`).toBe('string');
      expect(['hook', 'expr'], `${a.id}.acquire`).toContain(a.acquire);
      expect(typeof a.read, `${a.id}.read`).toBe('function');
      if (a.acquire === 'expr') expect(a.acquireExpr, `${a.id} 需要 acquireExpr`).toBeTruthy();
      if (a.acquire === 'hook') {
        expect(a.hookProto, `${a.id} 需要 hookProto`).toBeTruthy();
        // fabric 5 的事件入口是 __onMouseMove。只 hook 单下划线那个实测抓不到，
        // 这条断言就是那次踩坑的护栏。
        expect(a.hookMethods.length).toBeGreaterThan(0);
      }
    }
  });

  it('AM-19: fabric 的 hookMethods 必须包含双下划线的 __onMouseMove', () => {
    const f = ADAPTERS.find((a) => a.id === 'fabric');
    expect(f.hookMethods).toContain('__onMouseMove');
  });

  it('AM-20: 读取函数必须能被 String() 内联（不引用外部作用域）', () => {
    // 内联后函数体里若出现本模块的标识符，页面里执行必然 ReferenceError。
    // 用一条不含这些名字的字符串检查，成本低但抓得准。
    const forbidden = ['GENERIC_HINT', 'ADAPTERS', 'buildAppModelSource', 'summarize'];
    for (const a of ADAPTERS) {
      const src = String(a.read);
      for (const name of forbidden) {
        expect(src.includes(name), `${a.id}.read 引用了 ${name}`).toBe(false);
      }
    }
  });
});

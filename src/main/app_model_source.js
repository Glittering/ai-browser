// main/app_model_source.js — 「页面把模型关在闭包里」的通用解法
//
// 背景（2026-10-30 两轮实测，第二轮推翻了第一轮）：draw.yunser.com 与
// suxieban.com 先后被判成「纯 canvas、没有应用模型」。复测证明这个判断是**错的**：
// suxieban 是 fabric 5.2.1（`getObjects` / `toJSON` / `toSVG` / `loadFromJSON` 全在），
// yunser 有 `window.DrawBoard` 构造器（`getState` / `loadState` / `save` 全在）。
// 判错的不是站点，是找法：capability_probe 扫的是 **window 上的对象**，
// 而这两个站把实例关在闭包里，window 上只留了库本身（`window.fabric`）或构造器。
//
// 所以这里做三件事，缺一不可：
//   1. 按「库指纹」认库（DOM class / 全局构造器 / 版本号），不靠猜 window 上的名字
//   2. 在库的原型上挂一个**只记 this** 的 tee，再派发一条合成 mousemove，让页面
//      自己的代码走一趟 —— 实例就落到手里。不接管行为：Reflect.apply 原样执行
//   3. 每个库一个 read(list)，只调 getter，返回同一形状的 items
//
// 为什么不能只 hook 不认库：hook 抓到的 `this` 在压缩产物里是 `zz` / `t` 这种
// 构造器，不认识它就是一堆魔法字段。认库才知道「去哪读」。
//
// 这个模块只产字符串 + 纯函数，不依赖 Electron，可在纯 Node / jsdom 下单测。

// ---------------------------------------------------------------------------
// 每库一个读取器。签名统一为 read(list) —— list 永远是「实例数组」，
// 单个实例的库就是长度 1。统一成数组是为了 Konva.stages / paper.projects
// 这类本身就是注册表的库不必特殊处理。
//
// ⚠️ 这些函数会被 String() 内联进页面执行，**不能引用本文件作用域里的任何变量**。
// 这也是测试能直接拿同一个函数喂假对象的原因：实现与判据共用一份代码。
// ---------------------------------------------------------------------------

export function readFabric(list) {
  var items = [];
  var total = 0;
  var supports = [];
  var errored = null;
  for (var i = 0; i < list.length; i++) {
    var inst = list[i];
    var objs;
    try { objs = inst.getObjects() || []; } catch (e) { errored = String(e && e.message || e); continue; }
    total += objs.length;
    for (var j = 0; j < objs.length; j++) {
      var o = objs[j];
      var it = { type: String(o.type || '?') };
      it.x = Math.round(Number(o.left) || 0);
      it.y = Math.round(Number(o.top) || 0);
      it.w = Math.round((Number(o.width) || 0) * (Number(o.scaleX) || 1));
      it.h = Math.round((Number(o.height) || 0) * (Number(o.scaleY) || 1));
      if (o.text !== undefined && o.text !== null) it.text = String(o.text).slice(0, 120);
      if (typeof o.fill === 'string') it.fill = o.fill;
      if (typeof o.stroke === 'string') it.stroke = o.stroke;
      if (o.angle) it.angle = Math.round(o.angle);
      items.push(it);
    }
    if (!supports.length) {
      var probe = ['getObjects', 'toJSON', 'toSVG', 'loadFromJSON', 'add', 'remove', 'getActiveObject', 'setActiveObject'];
      for (var k = 0; k < probe.length; k++) {
        if (typeof inst[probe[k]] === 'function') supports.push(probe[k]);
      }
    }
  }
  return { kind: 'objects', count: total, items: items, supports: supports, error: errored };
}

export function readKonva(list) {
  var items = [];
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var st = list[i];
    var layers = [];
    try { layers = st.getLayers() || []; } catch (e) { continue; }
    for (var a = 0; a < layers.length; a++) {
      var kids = [];
      try { kids = layers[a].getChildren() || []; } catch (e) { continue; }
      for (var b = 0; b < kids.length; b++) {
        var n = kids[b];
        total++;
        var it = { type: String((n.getClassName && n.getClassName()) || n.className || '?') };
        try { it.x = Math.round(n.x()); it.y = Math.round(n.y()); } catch (e) {}
        try { if (typeof n.text === 'function' && n.text()) it.text = String(n.text()).slice(0, 120); } catch (e) {}
        items.push(it);
      }
    }
  }
  return { kind: 'nodes', count: total, items: items, supports: ['getLayers', 'getChildren', 'find', 'toJSON'] };
}

export function readPaper(list) {
  var items = [];
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var proj = list[i];
    var layer = proj && proj.activeLayer;
    var kids = (layer && layer.children) || [];
    total += kids.length;
    for (var j = 0; j < kids.length; j++) {
      var c = kids[j];
      var it = { type: String((c.className || '?')).toLowerCase() };
      try {
        // position 是逻辑坐标，bounds 是**含描边的外框**。先取 position，
        // bounds 只补尺寸 —— 反过来会让一条 1px 描边的线整体偏半个线宽。
        if (c.position) { it.x = Math.round(c.position.x); it.y = Math.round(c.position.y); }
        if (c.bounds) {
          if (it.x === undefined) { it.x = Math.round(c.bounds.x); it.y = Math.round(c.bounds.y); }
          it.w = Math.round(c.bounds.width); it.h = Math.round(c.bounds.height);
        }
      } catch (e) {}
      try { if (c.content) it.text = String(c.content).slice(0, 120); } catch (e) {}
      items.push(it);
    }
  }
  return { kind: 'items', count: total, items: items, supports: ['activeLayer', 'project.exportJSON'] };
}

export function readCodeMirror(list) {
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var cm = list[i];
    var v = '';
    try { v = String(cm.getValue()); } catch (e) {}
    items.push({ type: 'text', chars: v.length, text: v.slice(0, 2000) });
  }
  return { kind: 'text', count: items.length, items: items, supports: ['getValue', 'setValue', 'getDoc', 'replaceRange'] };
}

export function readMonaco(list) {
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var v = '';
    try { v = String(m.getValue()); } catch (e) {}
    var uri = '';
    try { uri = String(m.uri && m.uri.toString ? m.uri.toString() : ''); } catch (e) {}
    items.push({ type: 'text', uri: uri, chars: v.length, text: v.slice(0, 2000) });
  }
  return { kind: 'text', count: items.length, items: items, supports: ['getValue', 'setValue', 'getModel', 'applyEdits'] };
}

export function readExcalidraw(list) {
  var items = [];
  var total = 0;
  var errors = null;
  for (var i = 0; i < list.length; i++) {
    var ex = list[i];
    var els = [];
    try { els = ex.getSceneElements() || []; } catch (e) { errors = String(e && e.message || e); continue; }
    total += els.length;
    for (var j = 0; j < els.length; j++) {
      var e2 = els[j];
      var it = { type: String(e2.type || '?') };
      it.x = Math.round(Number(e2.x) || 0);
      it.y = Math.round(Number(e2.y) || 0);
      it.w = Math.round(Number(e2.width) || 0);
      it.h = Math.round(Number(e2.height) || 0);
      if (typeof e2.text === 'string' && e2.text) it.text = e2.text.slice(0, 120);
      items.push(it);
    }
  }
  var sup = [];
  var probe = ['getSceneElements', 'updateScene', 'getAppState', 'history', 'scrollToContent'];
  if (list[0]) {
    for (var p = 0; p < probe.length; p++) {
      if (typeof list[0][probe[p]] === 'function') sup.push(probe[p]);
    }
  }
  return { kind: 'elements', count: total, items: items, supports: sup, error: errors };
}

// ---------------------------------------------------------------------------
// 适配器表 —— 每条都写明「怎么认出来」「实例从哪来」「怎么读」。
//
// acquire 只有两种取值：
//   'hook'  → 原型 tee + 合成鼠标（实例在闭包里，只能等页面自己走一趟）
//   'expr'  → 页面里现成的注册表 / DOM 属性 / 全局 API（不需要碰任何原型）
//
// 能用 'expr' 的一律用 'expr'：不包装原型就没有副作用，也不需要卸载。
// ---------------------------------------------------------------------------
export const ADAPTERS = [
  {
    id: 'fabric',
    // 双重指纹：DOM class（lower-canvas / canvas-container）+ 全局库对象。
    // 只看 class 会误判那些用了 fabric 但删了 class 的站点；只看 window.fabric
    // 会误判引了库却没初始化的页面。
    detect: '!!(window.fabric && window.fabric.Canvas && window.fabric.Canvas.prototype && document.querySelector("canvas.lower-canvas"))',
    version: '(window.fabric && window.fabric.version) || null',
    acquire: 'hook',
    hookProto: 'window.fabric.Canvas.prototype',
    // ```__onMouseMove`` 是 fabric 5 的真正事件入口。只 hook `_onMouseMove`
    // 实测完全抓不到（那一个是内层实现，DOM 上绑的是双下划线那个）。
    hookMethods: ['__onMouseMove', '_onMouseMove', 'renderAll', 'requestRenderAll', 'renderTopLayer', 'add', 'remove', 'setActiveObject'],
    read: readFabric,
    readExpr: '.getObjects()',
    writeHint: 'add(new fabric.Rect({...})) / loadFromJSON(snapshot) / remove(obj) — then re-read getObjects()',
  },
  {
    id: 'konva',
    detect: '!!(window.Konva && window.Konva.stages && window.Konva.stages.length)',
    version: '(window.Konva && window.Konva.version) || null',
    acquire: 'expr',
    // Konva 自己维护了全局 stage 注册表，不必 hook。
    acquireExpr: 'window.Konva.stages',
    read: readKonva,
    readExpr: 'window.Konva.stages',
    writeHint: 'new Konva.Rect({...}).addTo(layer); layer.batchDraw()',
  },
  {
    id: 'paper',
    detect: '!!(window.paper && window.paper.projects && window.paper.projects.length)',
    version: '(window.paper && window.paper.version) || null',
    acquire: 'expr',
    acquireExpr: 'window.paper.projects',
    read: readPaper,
    readExpr: 'window.paper.projects',
    writeHint: 'new paper.Path.Rectangle({...}); paper.project.view.update()',
  },
  {
    id: 'excalidraw',
    detect: '!!(window.excalidraw && window.excalidraw.$excalidraw && typeof window.excalidraw.$excalidraw.getSceneElements === "function")',
    version: null,
    acquire: 'expr',
    acquireExpr: '[window.excalidraw.$excalidraw]',
    read: readExcalidraw,
    readExpr: 'window.excalidraw.$excalidraw.getSceneElements()',
    writeHint: 'updateScene({elements:[...]}) — 官方站 window 上没有模型，这条路只在「站点把它包出来」时成立',
  },
  {
    id: 'codemirror',
    detect: '!!document.querySelector(".CodeMirror")',
    version: null,
    acquire: 'expr',
    // CM5 把实例挂在宿主元素上（el.CodeMirror），这是官方约定，不必 hook。
    acquireExpr: '(function(){var n=document.querySelectorAll(".CodeMirror"),o=[];for(var i=0;i<n.length;i++){if(n[i].CodeMirror)o.push(n[i].CodeMirror)}return o})()',
    read: readCodeMirror,
    readExpr: 'document.querySelector(".CodeMirror").CodeMirror.getValue()',
    writeHint: 'setValue(text) — 写完回读 getValue()',
  },
  {
    id: 'monaco',
    detect: '!!(window.monaco && window.monaco.editor && typeof window.monaco.editor.getModels === "function")',
    version: null,
    acquire: 'expr',
    // 全局 API 直接给全部 model，是所有编辑器里最省事的一个。
    acquireExpr: 'window.monaco.editor.getModels()',
    read: readMonaco,
    readExpr: 'window.monaco.editor.getModels()',
    writeHint: 'model.setValue(text) / model.applyEdits([...])',
  },
];

// 未命中任何库时给的兜底指引。写进输出，而不是让 agent 自己发明。
// 页面里的总账本名。Node 侧拼 read_expr 时要用同一个字符串 ——
// 两处各写一份，改了一个漏另一个，read_expr 就会指向一个不存在的对象。
export const HUB_GLOBAL = '__aiAppModel';

export const GENERIC_HINT =
  'no known library matched. Two things to try before falling back to gestures: '
  + '(1) the site may still export structure — look for an export/save entry (JSON, SVG, or a PNG-per-layer '
  + 'snapshot like draw.yunser.com\'s getDataUrl) and read the file instead of the pixels; '
  + '(2) instances are often closed over — tee ONE prototype method the page calls on its own: '
  + 'const P=SomeLib.prototype; const o=P.someHotMethod; P.someHotMethod=function(){window.__x=this;return o.apply(this,arguments)}; '
  + 'then dispatch one synthetic mousemove/resize so the page calls it, and read window.__x. '
  + 'Never call an unknown method just to force it.';

/**
 * 页面内探针脚本。
 *
 * 两阶段是刻意的：先把所有 hook 装完，再**只派发一次**合成鼠标。
 * 逐适配器边装边触发会在同一画布上重复派发，页面会收到多次 hover。
 */
export function buildAppModelSource(opts = {}) {
  const maxItems = Math.max(1, Math.min(500, Number(opts.maxItems) || 200));

  const specs = ADAPTERS.map((a) => {
    // read_expr 必须是**能在页面顶层直接求值**的完整表达式。
    //
    // 这里踩过一次：`hook` 类的适配器只给了后缀（`.getObjects()`），于是
    // read_expr 交出去的值是 ".getObjects()" —— agent 照着喂 ui.evaluate，
    // `this` 是 undefined，当场 TypeError，而探针一路 PASS。e2e 的 AM-E13
    // 就是为这条存在的：它真的把 read_expr 喂给 ui.evaluate。
    //
    // 三元包一层是因为 hits 可能被 restore() 清空或页面导航后消失 ——
    // 那种情况下表达式要返回 null（可判断），而不是抛错。
    let readExpr = null;
    if (a.readExpr) {
      if (a.acquire === 'hook') {
        const base = `window.${HUB_GLOBAL}.hits.${a.id}[0]`;
        readExpr = `(window.${HUB_GLOBAL} && window.${HUB_GLOBAL}.hits.${a.id} && ${base} ? ${base}${a.readExpr} : null)`;
      } else {
        readExpr = a.readExpr;
      }
    }
    return {
      id: a.id,
      detect: a.detect,
      version: a.version,
      acquire: a.acquire,
      acquireExpr: a.acquireExpr || null,
      hookProto: a.hookProto || null,
      hookMethods: a.hookMethods || [],
      readSrc: String(a.read),
      readExpr: readExpr,
      writeHint: a.writeHint || null,
    };
  });

  return `(function () {
  "use strict";
  var SPECS = ${JSON.stringify(specs)};
  var MAX_ITEMS = ${maxItems};
  var HUB_KEY = ${JSON.stringify(HUB_GLOBAL)};
  try {
    var G = window;
    var HUB = G[HUB_KEY];
    if (!HUB || HUB.v !== 1) {
      HUB = G[HUB_KEY] = {
        v: 1,
        hits: {},        // id -> [instances]
        orig: {},        // id -> { proto, methods: { name: fn } }，供 restore
        pokes: 0
      };
    }

    // 真正把原型还回去。此前这里只写了 delete window.__aiAppModel，那只是
    // 丢掉账本、tee 仍挂在原型上 —— 自述的「可卸载」与执行器不一致，
    // 和语义树 advertise 假动作是同一类错误（宁可少说，也绝不撒谎）。
    HUB.restore = function () {
      var restored = 0;
      for (var id in HUB.orig) {
        var rec = HUB.orig[id];
        if (!rec || !rec.proto) continue;
        for (var m in rec.methods) {
          try { rec.proto[m] = rec.methods[m]; restored++; } catch (e) {}
        }
      }
      HUB.hits = {};
      HUB.orig = {};
      return restored;
    };

    function pushHit(id, inst) {
      if (!inst) return;
      var list = HUB.hits[id] || (HUB.hits[id] = []);
      for (var i = 0; i < list.length; i++) if (list[i] === inst) return;
      if (list.length < 8) list.push(inst);
    }

    // 只记 this，随后原样转发。参数、返回值、异常、this 一律不变 ——
    // 包装失败的代价必须小于「不包装」，所以任何一步出错都退回直接调用。
    function wrap(proto, name, id) {
      var orig = proto[name];
      if (typeof orig !== "function") return false;
      if (orig.__aiAmTeed) return true;
      var tee = function () {
        try { pushHit(id, this); } catch (e) {}
        return orig.apply(this, arguments);
      };
      tee.__aiAmTeed = true;
      try { proto[name] = tee; } catch (e) { return false; }
      var rec = HUB.orig[id] || (HUB.orig[id] = { proto: proto, methods: {} });
      if (!rec.methods[name]) rec.methods[name] = orig;
      return true;
    }

    // 幂等 + 自愈：页面自己重定义原型方法时，我们的 tee 会被覆盖。
    // 每次调用都检查一遍，缺了就补 —— 否则「装过一次」的标记会让后续调用永远抓不到。
    function ensureHooks(spec) {
      var proto = null;
      try { proto = eval(spec.hookProto); } catch (e) { return { ok: false, error: "hookProto threw: " + (e && e.message) }; }
      if (!proto) return { ok: false, error: "hookProto resolved to null" };
      var hit = [], miss = [];
      for (var i = 0; i < spec.hookMethods.length; i++) {
        var m = spec.hookMethods[i];
        if (typeof proto[m] !== "function") { miss.push(m); continue; }
        if (wrap(proto, m, spec.id)) hit.push(m);
      }
      return { ok: hit.length > 0, methods: hit, missing: miss };
    }

    // 一条合成 mousemove 足以让页面自己的代码走一趟原型（fabric 的方法没被
    // bind 成实例属性，所以合成事件也能到达 tee）。优先 upper-canvas：那是
    // fabric 的事件层，lower-canvas 只负责画。
    function poke(maxCanvas) {
      var order = [];
      var up = document.querySelectorAll("canvas.upper-canvas");
      for (var i = 0; i < up.length; i++) order.push(up[i]);
      var all = document.querySelectorAll("canvas");
      for (var j = 0; j < all.length && order.length < maxCanvas; j++) {
        if (order.indexOf(all[j]) < 0) order.push(all[j]);
      }
      var n = 0;
      for (var k = 0; k < order.length && n < maxCanvas; k++) {
        var r;
        try { r = order[k].getBoundingClientRect(); } catch (e) { continue; }
        if (!(r.width > 4 && r.height > 4)) continue;
        try {
          order[k].dispatchEvent(new MouseEvent("mousemove", {
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            bubbles: true, cancelable: true, view: window
          }));
          n++;
        } catch (e) {}
      }
      HUB.pokes += n;
      return n;
    }

    // ---- 阶段一：检测 + 装 hook（不读任何状态） ----
    var found = [];
    for (var s = 0; s < SPECS.length; s++) {
      var spec = SPECS[s];
      var present = false;
      try { present = !!eval(spec.detect); } catch (e) { present = false; }
      if (!present) continue;
      var ver = null;
      if (spec.version) { try { ver = eval(spec.version); } catch (e) {} }
      var hookInfo = null;
      if (spec.acquire === "hook") hookInfo = ensureHooks(spec);
      found.push({ spec: spec, version: ver, hookInfo: hookInfo, acquired: false });
    }

    // ---- 阶段二：只派发一次 ----
    var needPoke = false;
    for (var f2 = 0; f2 < found.length; f2++) {
      var h = found[f2].hookInfo;
      if (h && h.ok) { needPoke = true; break; }
    }
    var poked = needPoke ? poke(4) : 0;

    // ---- 阶段三：取实例 + 读 ----
    var out = { ok: true, libs: [], poked: poked, considered: SPECS.length };
    for (var g = 0; g < found.length; g++) {
      var rec = found[g];
      var sp = rec.spec;
      var list = null;
      var acquireNote = null;
      if (sp.acquire === "expr") {
        try { list = eval(sp.acquireExpr); } catch (e) { acquireNote = "acquireExpr threw: " + (e && e.message); }
      } else {
        list = HUB.hits[sp.id] || null;
        if (!list || !list.length) {
          acquireNote = rec.hookInfo && !rec.hookInfo.ok
            ? "hook failed: " + (rec.hookInfo.error || ("no methods matched (" + (rec.hookInfo.missing || []).join(", ") + ")"))
            : "hook installed but the page did not call it after one synthetic mousemove";
        }
      }
      if (!list) list = [];
      if (!list.length) {
        out.libs.push({
          lib: sp.id, version: rec.version, acquired: false,
          hook: rec.hookInfo, note: acquireNote,
          read_expr: null, write_hint: sp.writeHint
        });
        continue;
      }
      var raw = null;
      var readErr = null;
      try {
        var fn = eval("(" + sp.readSrc + ")");
        raw = fn(list);
      } catch (e) { readErr = String(e && e.message || e); }

      var items = (raw && raw.items) || [];
      var truncated = items.length > MAX_ITEMS;
      if (truncated) items = items.slice(0, MAX_ITEMS);

      out.libs.push({
        lib: sp.id,
        version: rec.version,
        acquired: true,
        instance_count: list.length,
        hook: rec.hookInfo,
        kind: (raw && raw.kind) || "unknown",
        count: (raw && raw.count) || 0,
        items: items,
        truncated: truncated,
        // supports 是**实测探测**的结果（对实例逐个 typeof），不是硬编码清单。
        // 「广告的动作必须在执行器里真有」这条纪律同样适用于这里。
        supports: (raw && raw.supports) || [],
        error: readErr || (raw && raw.error) || null,
        read_expr: sp.readExpr,
        write_hint: sp.writeHint
      });
    }

    out.installed = Object.keys(HUB.hits).filter(function (k) { return HUB.hits[k] && HUB.hits[k].length; });
    // 只对 hook 类适配器有意义（expr 类从不碰原型）。expr 类站点执行它是空操作。
    out.uninstall = "window." + HUB_KEY + ".restore()";
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})()`;
}

/**
 * 归一化 + 给调用方的下一步。
 *
 * 这里做三件 Node 侧才有的事：把「读到了几个库」折成一句可判断的话、
 * 在**没命中任何库**时给出可执行的兜底、把 read_expr 的失效条件写清楚
 * （钩子活在当前文档里，导航即消失 —— 不标出来，agent 会在下一页照抄一个 null）。
 */
export function summarize(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'probe returned no object' };
  if (raw.ok === false) return { ok: false, error: raw.error || 'probe failed' };

  const libs = Array.isArray(raw.libs) ? raw.libs : [];
  const acquired = libs.filter((l) => l && l.acquired);
  const notes = [];

  if (!libs.length) {
    notes.push(GENERIC_HINT);
  } else if (!acquired.length) {
    for (const l of libs) {
      notes.push(`${l.lib}: detected but not acquired — ${l.note || l.error || 'unknown reason'}`);
    }
    notes.push(
      'the library is present but its instance never surfaced. Next: ui.evaluate to tee ONE method '
      + 'the page calls on its own (e.g. a render/update/mousemove handler on the library prototype), '
      + 'then move the pointer over the canvas and read the captured `this`.'
    );
  }

  return {
    ok: true,
    poked: Number(raw.poked) || 0,
    // 诚实标注探针自身的副作用：合成 mousemove 会让页面跑一遍 hover 逻辑。
    // 「读取不得打扰页面」是目标而不是既成事实，做了什么要说出来。
    side_effect: raw.poked > 0
      ? `dispatched ${raw.poked} synthetic mousemove(s) to visible canvas(es) to surface closed-over instances`
      : null,
    libs: libs.map((l) => ({
      lib: l.lib,
      version: l.version || null,
      acquired: !!l.acquired,
      kind: l.kind || null,
      count: l.count || 0,
      instance_count: l.instance_count || 0,
      truncated: !!l.truncated,
      supports: l.supports || [],
      items: opts.include_items === false ? undefined : (l.items || []),
      read_expr: l.acquired ? l.read_expr : null,
      write_hint: l.write_hint || null,
      error: l.error || null,
      note: l.note || null,
      hook: l.hook || null,
    })),
    installed: Array.isArray(raw.installed) ? raw.installed : [],
    // 钩子与实例引用都活在**当前文档**里。
    stale_after_navigation: true,
    notes,
    discipline: 'read is proven by the probe itself; any write through read_expr/write_hint must be '
      + 'followed by another ui.app_model (or ui.snapshot + ui.diff) — a library call returning without '
      + 'throwing is not evidence that the scene changed',
  };
}

export default buildAppModelSource;

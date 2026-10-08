// main/canvas_hook_source.js — 注入页面 main world 的 canvas 绘制调用记录器源码
//
// 为什么必须是 main world：`contextIsolation: true` 让 preload 只活在 isolated
// world，改自己 world 的原型截不到页面代码的调用。要看到页面画了什么，脚本必须
// 跑在页面自己的 realm 里 —— 因此用 Page.addScriptToEvaluateOnNewDocument
// （不传 worldName）+ 首个真实导航之前安装。
//
// 为什么是 tee 而不是接管：canvas 是有状态的立即模式 API，同一像素可能经历
// clip / composite / filter / 阴影 / 多次覆盖 / putImageData。包装函数必须
// 先 `Reflect.apply(original, this, args)` 让原生 API 正常执行（返回值、异常、
// this、绘制顺序一律不变），再在独立 try/catch 里记录。记录失败不影响页面。
//
// 这个模块只产字符串，不依赖 Electron，可在纯 Node 下单测。

export function buildCanvasHookSource(opts = {}) {
  const binding = JSON.stringify(String(opts.bindingName || ''));
  const key = JSON.stringify(String(opts.bridgeKey || ''));
  const mode = JSON.stringify(String(opts.mode || 'semantic'));

  return `(function () {
  "use strict";
  var BINDING = ${binding};
  var KEY = ${key};
  try {
  var G = (typeof window !== "undefined") ? window : self;
  if (!G) return;
  if (G[KEY] && G[KEY].__aiCanvasHook) return;

  var isWindow = !!(G.document && G.document.createElement);
  var NAV = "nav-" + Math.random().toString(36).slice(2, 8);
  var FRAME = !isWindow ? "frame-worker" : ((G.top === G) ? "frame-main" : "frame-sub");

  var MAX_TEXT_CP = 4096;        // 单条文本上限（Unicode code point）
  var MAX_SHADER_CHARS = 16384;  // 单个 shader 源码上限
  var MAX_BATCH = 200;           // 单批调用条数
  var MAX_BATCH_BYTES = 128 * 1024;
  var MAX_PATH_POINTS = 512;     // 路径采样点上限，超出只保留计数和 bounds
  var MAX_URL_CHARS = 2048;

  var mode = ${mode};
  var recording = (mode !== "off");
  var report = G[BINDING];

  var canvasCount = 0;
  var canvasMap = new WeakMap();   // canvas 元素 -> meta
  var ctxStateMap = new WeakMap(); // ctx -> state
  var pending = [];
  var pendingBytes = 0;
  var scheduled = false;
  var lastSig = null;
  var lastEntry = null;

  // ---- 小工具 ----------------------------------------------------------

  function num(v, d) { var n = Number(v); return (typeof n === "number" && isFinite(n)) ? n : d; }
  function r2(v) { return Math.round(num(v, 0) * 100) / 100; }
  function strOf(v, d) { return (typeof v === "string") ? v : d; }

  function hash32(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  function fontSize(font) {
    try {
      var m = /([0-9.]+)\s*(px|pt|em|rem|%)?/.exec(String(font || ""));
      if (m) return num(m[1], 10);
    } catch (e) {}
    return 10;
  }

  function matOf(ctx) {
    try {
      if (typeof ctx.getTransform === "function") {
        var m = ctx.getTransform();
        return [num(m.a, 1), num(m.b, 0), num(m.c, 0), num(m.d, 1), num(m.e, 0), num(m.f, 0)];
      }
    } catch (e) {}
    return [1, 0, 0, 1, 0, 0];
  }

  function applyPt(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // 四角经当前 transform 变换后的 AABB（canvas backing-store 坐标）。
  function rectBounds(m, x, y, w, h) {
    var p0 = applyPt(m, x, y), p1 = applyPt(m, x + w, y),
        p2 = applyPt(m, x + w, y + h), p3 = applyPt(m, x, y + h);
    var xs = [p0[0], p1[0], p2[0], p3[0]], ys = [p0[1], p1[1], p2[1], p3[1]];
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
    var x1 = Math.max.apply(null, xs), y1 = Math.max.apply(null, ys);
    return { x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) };
  }

  function boundsFromPoints(pts) {
    if (!pts || !pts.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < x0) x0 = pts[i][0];
      if (pts[i][1] < y0) y0 = pts[i][1];
      if (pts[i][0] > x1) x1 = pts[i][0];
      if (pts[i][1] > y1) y1 = pts[i][1];
    }
    if (!isFinite(x0)) return null;
    return { x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) };
  }

  function styleVal(v) {
    if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) : v;
    if (typeof v === "number") return isFinite(v) ? r2(v) : null;
    if (v && typeof v === "object") {
      try { if (typeof G.CanvasGradient === "function" && v instanceof G.CanvasGradient) return "[gradient]"; } catch (e) {}
      try { if (typeof G.CanvasPattern === "function" && v instanceof G.CanvasPattern) return "[pattern]"; } catch (e) {}
      return "[object]";
    }
    return null;
  }

  function styleOf(ctx) {
    var out = {};
    var map = {
      font: "font", textAlign: "text_align", textBaseline: "text_baseline",
      direction: "direction", fillStyle: "fill_style", strokeStyle: "stroke_style",
      lineWidth: "line_width", globalAlpha: "global_alpha",
      globalCompositeOperation: "global_composite_operation"
    };
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var v;
      try { v = ctx[k]; } catch (e) { continue; }
      if (v === undefined || v === null) continue;
      var sv = styleVal(v);
      if (sv === null) continue;
      out[map[k]] = sv;
    }
    return out;
  }

  // ---- 上报 ------------------------------------------------------------

  function flush() {
    scheduled = false;
    if (!pending.length) return;
    var entries = pending;
    pending = []; pendingBytes = 0; lastSig = null; lastEntry = null;
    // 注意：本函数体位于外层模板字符串内部。在这里手写转义的引号会被模板
    // 吃掉反斜杠，生成出字符串被提前闭合的坏码，注入后整页脚本直接报错。
    // 因此统一用 JSON.stringify 构造载荷，完全不手写转义。
    // 同理，本文件模板内部的注释不要使用反引号，否则会提前终止模板。
    var objs = [];
    for (var i = 0; i < entries.length; i++) {
      entries[i].rec.n = entries[i].n;
      objs.push(entries[i].rec);
    }
    if (!objs.length) return;
    var payload;
    try {
      payload = JSON.stringify({ v: 1, nav: NAV, frame: FRAME, calls: objs });
    } catch (e) { return; }
    try { if (report) report(payload); } catch (e) {}
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    try { setTimeout(flush, 0); } catch (e) { flush(); }
  }

  // 同一批次内签名相同的连续调用合并成 repeat_count（动画循环的主要降本手段）。
  function push(rec) {
    if (!recording) return;
    if (!report) { try { report = G[BINDING]; } catch (e) {} }
    if (!report) return;
    var sig;
    try { sig = JSON.stringify(rec); } catch (e) { return; }
    if (!sig) return;
    if (mode !== "trace" && lastEntry && lastSig === sig) {
      lastEntry.n += 1;
      pendingBytes += sig.length;
    } else {
      var entry = { rec: rec, n: 1, sig: sig, bytes: sig.length + 24 };
      pending.push(entry);
      pendingBytes += entry.bytes;
      lastEntry = entry; lastSig = sig;
    }
    if (pending.length >= MAX_BATCH || pendingBytes >= MAX_BATCH_BYTES) flush();
    else schedule();
  }

  // ---- canvas / ctx 身份 ------------------------------------------------

  function metaFor(el, kind) {
    var m = null;
    try { m = canvasMap.get(el); } catch (e) {}
    if (m) {
      if (kind && kind !== "unknown" && m.kind === "unknown") m.kind = kind;
      return m;
    }
    canvasCount += 1;
    m = { id: "canvas:" + NAV + ":" + FRAME + ":" + canvasCount, kind: kind || "unknown" };
    try { canvasMap.set(el, m); } catch (e) {}
    try { el.__aiCanvasId = m.id; } catch (e) {}
    return m;
  }

  function stOf(ctx, kind) {
    var st = null;
    try { st = ctxStateMap.get(ctx); } catch (e) {}
    if (st) return st;
    var cv = null;
    try { cv = ctx.canvas; } catch (e) {}
    var m = metaFor(cv || ctx, kind || "unknown");
    st = { id: m.id, epoch: 1, w: 0, h: 0, path: { n: 0, pts: [], opaque: false }, draws: 0 };
    try { ctxStateMap.set(ctx, st); } catch (e) {}
    try { ctx.__aiCanvasId = m.id; } catch (e) {}
    return st;
  }

  // canvas resize → 新 scene_epoch（旧记录的坐标体系已失效）。
  function syncSize(ctx, st) {
    var cv = null;
    try { cv = ctx.canvas; } catch (e) {}
    if (!cv) return;
    var w = 0, h = 0;
    try { w = num(cv.width, 0); h = num(cv.height, 0); } catch (e) {}
    if (st.w === w && st.h === h) return;
    var first = (st.w === 0 && st.h === 0);
    st.w = w; st.h = h;
    if (!first) {
      st.epoch += 1;
      push({ c: st.id, m: "resize", k: "state", w: w, h: h, e: st.epoch });
    }
  }

  function addPoint(st, m, x, y) {
    var p = st.path;
    p.n += 1;
    if (p.pts.length < MAX_PATH_POINTS) p.pts.push(applyPt(m, x, y));
  }

  // ---- 2D 记录 ---------------------------------------------------------

  function recordText(ctx, method, args) {
    var st = stOf(ctx, "2d");
    syncSize(ctx, st);
    var str = args[0] == null ? "" : String(args[0]);
    var cps = Array.from(str);
    var full = cps.length;
    var out = str, tt = false;
    if (full > MAX_TEXT_CP) { out = cps.slice(0, MAX_TEXT_CP).join(""); tt = true; }
    var x = num(args[1], 0), y = num(args[2], 0);
    var m = matOf(ctx);
    var w = 0, asc = 0, desc = 0;
    try {
      var tm = ctx.measureText(str);
      if (tm) {
        w = num(tm.width, 0);
        asc = num(tm.actualBoundingBoxAscent, 0);
        desc = num(tm.actualBoundingBoxDescent, 0);
      }
    } catch (e) {}
    var fs = fontSize(ctx.font);
    if (!w) w = full * fs * 0.6;
    var h = (asc + desc) || fs;
    var align = strOf(ctx.textAlign, "start");
    var left = x;
    if (align === "center" || align === "middle") left = x - w / 2;
    else if (align === "right" || align === "end") left = x - w;
    var base = strOf(ctx.textBaseline, "alphabetic");
    var top = y - asc;
    if (base === "top" || base === "hanging") top = y;
    else if (base === "middle") top = y - h / 2;
    else if (base === "bottom" || base === "ideographic") top = y - h;
    push({
      c: st.id, m: method, k: "text", t: out, tt: tt, tl: full,
      b: rectBounds(m, left, top, w, h), st: styleOf(ctx)
    });
  }

  function recordRect(ctx, method, args) {
    var st = stOf(ctx, "2d");
    syncSize(ctx, st);
    var x = num(args[0], 0), y = num(args[1], 0), w = num(args[2], 0), h = num(args[3], 0);
    var m = matOf(ctx);
    var rec = {
      c: st.id, m: method, k: (method === "clearRect" ? "clear" : "rect"),
      b: rectBounds(m, x, y, w, h), st: styleOf(ctx)
    };
    // 全量 clear 等价于场景重置 → 新 epoch。
    if (method === "clearRect" && st.w > 0 && st.h > 0 &&
        x <= 0 && y <= 0 && (x + w) >= st.w && (y + h) >= st.h) {
      st.epoch += 1;
      rec.e = st.epoch;
    }
    push(rec);
  }

  function imageKind(img) {
    if (!img) return "unknown";
    try {
      var n = img.constructor && img.constructor.name;
      if (n) {
        n = String(n);
        if (n === "HTMLImageElement") return "image";
        if (n === "HTMLCanvasElement") return "canvas";
        if (n === "HTMLVideoElement") return "video";
        if (n === "ImageBitmap") return "imagebitmap";
        if (n === "OffscreenCanvas") return "offscreen";
        if (n === "SVGImageElement") return "svgimage";
        return n.toLowerCase();
      }
    } catch (e) {}
    return "unknown";
  }

  function recordDrawImage(ctx, args) {
    var st = stOf(ctx, "2d");
    syncSize(ctx, st);
    var img = args[0];
    var src = { kind: imageKind(img) };
    try { src.width = num(img.width, 0); src.height = num(img.height, 0); } catch (e) {}
    try {
      var u = (img && (img.currentSrc || img.src)) ? String(img.currentSrc || img.src) : null;
      if (u) {
        // data: URL 只记类型和长度 —— 不复制像素。
        if (u.indexOf("data:") === 0) {
          src.url = "data:" + (u.split(";")[0].slice(5) || "") + ";len=" + u.length;
          src.data_url = true;
        } else {
          src.url = u.length > MAX_URL_CHARS ? u.slice(0, MAX_URL_CHARS) : u;
        }
      }
    } catch (e) {}
    var m = matOf(ctx);
    var dx, dy, dw, dh, srect = null;
    if (args.length >= 9) {
      srect = { x: num(args[1], 0), y: num(args[2], 0), width: num(args[3], 0), height: num(args[4], 0) };
      dx = num(args[5], 0); dy = num(args[6], 0); dw = num(args[7], 0); dh = num(args[8], 0);
    } else if (args.length >= 5) {
      dx = num(args[1], 0); dy = num(args[2], 0); dw = num(args[3], 0); dh = num(args[4], 0);
    } else {
      dx = num(args[1], 0); dy = num(args[2], 0);
      dw = num(src.width, 0); dh = num(src.height, 0);
    }
    push({
      c: st.id, m: "drawImage", k: "image", src: src, srect: srect,
      b: rectBounds(m, dx, dy, dw, dh), st: styleOf(ctx)
    });
  }

  function recordPathDraw(ctx, method, args) {
    var st = stOf(ctx, "2d");
    syncSize(ctx, st);
    var p = st.path;
    // 显式 Path2D 参数的内部指令无法用标准 API 反射 —— 如实标记，不猜。
    var opaque = !!(args.length && args[0] && typeof args[0] === "object") || p.opaque;
    var rule = null;
    for (var i = 0; i < args.length; i++) {
      if (typeof args[i] === "string") { rule = String(args[i]); break; }
    }
    push({
      c: st.id, m: method, k: "path",
      p: { segments: p.n, opaque_path: opaque, approximate: true },
      fill_rule: rule,
      b: boundsFromPoints(p.pts),
      st: styleOf(ctx)
    });
  }

  function recordPixel(ctx, method, args) {
    var st = stOf(ctx, "2d");
    syncSize(ctx, st);
    var id = args[0];
    var w = 0, h = 0;
    try { w = num(id.width, 0); h = num(id.height, 0); } catch (e) {}
    push({
      c: st.id, m: method, k: "pixel",
      dst: { x: num(args[1], 0), y: num(args[2], 0) },
      image: { width: w, height: h },
      pixels_captured: false
    });
  }

  function recordState(ctx, method, args) {
    if (mode !== "trace") return;
    var st = stOf(ctx, "2d");
    var rec = { c: st.id, m: method, k: "state" };
    if (method === "clip") rec.b = boundsFromPoints(st.path.pts);
    else if (args.length && typeof args[0] === "number") rec.args = Array.prototype.slice.call(args, 0, 6).map(function (v) { return r2(v); });
    push(rec);
  }

  // ---- WebGL 记录 ------------------------------------------------------

  function glRecord(ctx, method, args) {
    var st = stOf(ctx, "webgl");
    syncSize(ctx, st);
    if (method === "shaderSource") {
      var src = args[1] == null ? "" : String(args[1]);
      push({
        c: st.id, m: "shaderSource", k: "webgl",
        shader: {
          length: src.length,
          truncated: src.length > MAX_SHADER_CHARS,
          hash: hash32(src),
          source: src.length > MAX_SHADER_CHARS ? src.slice(0, MAX_SHADER_CHARS) : src
        }
      });
      return;
    }
    if (method === "drawArrays" || method === "drawElements") {
      st.draws += 1;
      push({
        c: st.id, m: method, k: "webgl",
        gl: {
          mode: num(args[0], 0),
          count: num(method === "drawArrays" ? args[2] : args[1], 0),
          type: method === "drawElements" ? num(args[2], 0) : undefined
        }
      });
      return;
    }
    if (method === "texImage2D") {
      var tw = 0, th = 0;
      if (args.length >= 9) { tw = num(args[3], 0); th = num(args[4], 0); }
      else if (args[1] && typeof args[1] === "object") { tw = num(args[1].width, 0); th = num(args[1].height, 0); }
      push({ c: st.id, m: method, k: "webgl", texture: { width: tw, height: th } });
      return;
    }
    if (method === "bufferData") {
      var bl = 0;
      try { if (args[1] && args[1].byteLength) bl = num(args[1].byteLength, 0); } catch (e) {}
      push({ c: st.id, m: method, k: "webgl", buffer: { byte_length: bl } });
      return;
    }
    if (method === "viewport") {
      push({
        c: st.id, m: method, k: "webgl",
        b: { x: num(args[0], 0), y: num(args[1], 0), width: num(args[2], 0), height: num(args[3], 0) }
      });
    }
  }

  // ---- 原型包装 --------------------------------------------------------

  function wrap(proto, name, make) {
    if (!proto) return;
    var orig;
    try { orig = proto[name]; } catch (e) { return; }
    if (typeof orig !== "function" || orig.__aiCanvasWrapper) return;
    var wrapped;
    try { wrapped = make(orig); } catch (e) { return; }
    // 保持 length/name：有代码会检查它们。
    try { Object.defineProperty(wrapped, "length", { value: orig.length, configurable: true }); } catch (e) {}
    try { Object.defineProperty(wrapped, "name", { value: name, configurable: true }); } catch (e) {}
    try { wrapped.__aiCanvasWrapper = true; } catch (e) {}
    try { proto[name] = wrapped; } catch (e) {}
  }

  // 关键顺序：先原生执行，再记录。记录异常吞掉，绝不改变返回值/异常/this/顺序。
  function tee(proto, name, record) {
    wrap(proto, name, function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) record(this, arguments); } catch (e) {}
        return r;
      };
    });
  }

  function install2d(proto) {
    if (!proto || proto.__ai2dInstalled) return;
    proto.__ai2dInstalled = true;

    tee(proto, "fillText", function (ctx, args) { recordText(ctx, "fillText", args); });
    tee(proto, "strokeText", function (ctx, args) { recordText(ctx, "strokeText", args); });
    tee(proto, "fillRect", function (ctx, args) { recordRect(ctx, "fillRect", args); });
    tee(proto, "strokeRect", function (ctx, args) { recordRect(ctx, "strokeRect", args); });
    tee(proto, "clearRect", function (ctx, args) { recordRect(ctx, "clearRect", args); });
    tee(proto, "drawImage", function (ctx, args) { recordDrawImage(ctx, args); });
    tee(proto, "fill", function (ctx, args) { recordPathDraw(ctx, "fill", args); });
    tee(proto, "stroke", function (ctx, args) { recordPathDraw(ctx, "stroke", args); });
    tee(proto, "putImageData", function (ctx, args) { recordPixel(ctx, "putImageData", args); });

    // 路径构建：默认不逐条产出，只在 fill/stroke 时给出摘要。
    wrap(proto, "beginPath", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { var st = stOf(this, "2d"); st.path = { n: 0, pts: [], opaque: false }; } catch (e) {}
        return r;
      };
    });
    wrap(proto, "moveTo", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); addPoint(st, matOf(this), num(arguments[0], 0), num(arguments[1], 0)); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "lineTo", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); addPoint(st, matOf(this), num(arguments[0], 0), num(arguments[1], 0)); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "bezierCurveTo", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); var m = matOf(this);
          addPoint(st, m, num(arguments[0], 0), num(arguments[1], 0));
          addPoint(st, m, num(arguments[2], 0), num(arguments[3], 0));
          addPoint(st, m, num(arguments[4], 0), num(arguments[5], 0)); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "quadraticCurveTo", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); var m = matOf(this);
          addPoint(st, m, num(arguments[0], 0), num(arguments[1], 0));
          addPoint(st, m, num(arguments[2], 0), num(arguments[3], 0)); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "rect", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); var m = matOf(this);
          var x = num(arguments[0], 0), y = num(arguments[1], 0), w = num(arguments[2], 0), h = num(arguments[3], 0);
          addPoint(st, m, x, y); addPoint(st, m, x + w, y); addPoint(st, m, x + w, y + h); addPoint(st, m, x, y + h); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "arc", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); var m = matOf(this);
          var x = num(arguments[0], 0), y = num(arguments[1], 0), rr = Math.abs(num(arguments[2], 0));
          addPoint(st, m, x - rr, y - rr); addPoint(st, m, x + rr, y + rr); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "ellipse", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { var st = stOf(this, "2d"); var m = matOf(this);
          var x = num(arguments[0], 0), y = num(arguments[1], 0),
              rx = Math.abs(num(arguments[2], 0)), ry = Math.abs(num(arguments[3], 0));
          addPoint(st, m, x - rx, y - ry); addPoint(st, m, x + rx, y + ry); } } catch (e) {}
        return r;
      };
    });
    wrap(proto, "closePath", function (orig) {
      return function () {
        var r = Reflect.apply(orig, this, arguments);
        try { if (recording) { stOf(this, "2d").path.n += 1; } } catch (e) {}
        return r;
      };
    });

    // 状态类：只为解释 draw call 服务，默认不产出记录。
    var stateMethods = ["save", "restore", "translate", "scale", "rotate", "transform",
      "setTransform", "resetTransform", "clip", "setLineDash"];
    for (var i = 0; i < stateMethods.length; i++) {
      (function (n) {
        tee(proto, n, function (ctx, args) { recordState(ctx, n, args); });
      })(stateMethods[i]);
    }
  }

  function installGL(proto) {
    if (!proto || proto.__aiGLInstalled) return;
    proto.__aiGLInstalled = true;
    var list = ["shaderSource", "drawArrays", "drawElements", "texImage2D", "bufferData", "viewport"];
    for (var i = 0; i < list.length; i++) {
      (function (n) {
        tee(proto, n, function (ctx, args) { glRecord(ctx, n, args); });
      })(list[i]);
    }
  }

  function wrapGetContext(proto) {
    wrap(proto, "getContext", function (orig) {
      return function (type) {
        var ctx = Reflect.apply(orig, this, arguments);
        try {
          var t = String(type || "").toLowerCase();
          var kind = "unknown";
          if (t === "2d") kind = "2d";
          else if (t === "webgl" || t === "webgl2" || t === "experimental-webgl") kind = "webgl";
          else if (t === "webgpu") kind = "webgpu";
          var meta = metaFor(this, kind);
          var w = 0, h = 0;
          try { w = num(this.width, 0); h = num(this.height, 0); } catch (e) {}
          if (ctx) {
            var st = stOf(ctx, kind);
            st.id = meta.id; st.w = w; st.h = h;
            if (kind === "2d") install2d(Object.getPrototypeOf(ctx));
            else if (kind === "webgl") installGL(Object.getPrototypeOf(ctx));
          }
          push({ c: meta.id, m: "getContext", k: "meta", kind: kind, api: t, w: w, h: h });
        } catch (e) {}
        return ctx;
      };
    });
  }

  // ---- 安装 ------------------------------------------------------------

  try {
    if (G.HTMLCanvasElement && G.HTMLCanvasElement.prototype) wrapGetContext(G.HTMLCanvasElement.prototype);
    if (G.OffscreenCanvas && G.OffscreenCanvas.prototype) wrapGetContext(G.OffscreenCanvas.prototype);
    if (G.HTMLCanvasElement && typeof G.HTMLCanvasElement.prototype.transferControlToOffscreen === "function") {
      wrap(G.HTMLCanvasElement.prototype, "transferControlToOffscreen", function (orig) {
        return function () {
          var r = Reflect.apply(orig, this, arguments);
          try { push({ c: metaFor(this, "unknown").id, m: "transferControlToOffscreen", k: "meta", transferred: true }); } catch (e) {}
          return r;
        };
      });
    }
    install2d(G.CanvasRenderingContext2D && G.CanvasRenderingContext2D.prototype);
    install2d(G.OffscreenCanvasRenderingContext2D && G.OffscreenCanvasRenderingContext2D.prototype);
    installGL(G.WebGLRenderingContext && G.WebGLRenderingContext.prototype);
    installGL(G.WebGL2RenderingContext && G.WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 不可枚举的 bridge：主进程靠它切换 mode / 手动 flush。
  var bridge = {
    __aiCanvasHook: true,
    nav: NAV,
    frame: FRAME,
    setMode: function (m) { mode = String(m || "semantic"); recording = (mode !== "off"); },
    getMode: function () { return mode; },
    flush: flush
  };
  try {
    Object.defineProperty(G, KEY, { value: bridge, configurable: true, enumerable: false, writable: false });
  } catch (e) { try { G[KEY] = bridge; } catch (e2) {} }

  try {
    if (typeof G.addEventListener === "function") {
      G.addEventListener("pagehide", flush);
      G.addEventListener("beforeunload", flush);
    }
  } catch (e) {}
  } catch (e) {}
})();`;
}

export default buildCanvasHookSource;

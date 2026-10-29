// e2e/app_model_ws.cjs — 「实例关在闭包里」这条路，必须在真浏览器里成立一次
//
// 单测（tests/test_app_model.js）证明的是逻辑：库指纹怎么认、tee 怎么装、
// read 怎么归一。但它跑在 jsdom 上，而 jsdom 的 getBoundingClientRect 恒 0、
// 没有真实事件派发链路 —— 也就是说，"派发一条合成 mousemove 就能让页面
// 自己的代码走到 tee" 这个核心假设，在单测里是被 mock 兜住的。
//
// 这个套件把那层兜底拿掉：真 Electron、真 Chromium、真事件、真原型。
// 它要回答的问题只有一个 —— 在一个 window 上没有模型、实例只在闭包里的画布上，
// ui.capabilities{deep:true} 能不能把模型挖出来，并且把路线推荐改对。
//
// Run:  AI_BROWSER_PORT=9333 node e2e/app_model_ws.cjs

const { windowEnv } = require('./_window_mode.cjs');
const harness = require("./_harness.cjs");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures -------------------------------------------------------------
//
// 三个页面刻意做成同一个形状（库 → 原型方法 → DOM 事件 → 实例），差别只在
// 实例怎么藏：fabric 藏在闭包（唯一出路是 tee + 派发），Konva 自己在
// Konva.stages 里登记（不需要碰原型），plain 什么都没有（阴性对照）。

const FABRIC_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>AM-fabric</title>
<style>html,body{margin:0}canvas{width:600px;height:400px;display:block;position:absolute;left:0;top:0}</style>
</head><body>
<div class="canvas-container"><canvas class="lower-canvas"></canvas><canvas class="upper-canvas"></canvas></div>
<script>
  // 只保留探针真正用到的表面：能认出库、能读到对象、能算 supports。
  // 不是完整 fabric —— 这个 fixture 要测的是探针，不是 fabric 本身。
  window.fabric = { version: 'fixture-1' };
  window.fabric.Canvas = function () {};
  fabric.Canvas.prototype.__onMouseMove = function () { return 'moved'; };
  fabric.Canvas.prototype.renderAll = function () { this.n = (this.n || 0) + 1; return 'rendered'; };
  fabric.Canvas.prototype.getObjects = function () { return this._objs || []; };
  fabric.Canvas.prototype.toJSON = function () { return { objects: this._objs || [] }; };
  fabric.Canvas.prototype.toSVG = function () { return '<svg/>'; };
  fabric.Canvas.prototype.loadFromJSON = function () {};
  fabric.Canvas.prototype.add = function (o) { (this._objs = this._objs || []).push(o); };
  fabric.Canvas.prototype.remove = function () {};

  var inst = new fabric.Canvas();
  inst._objs = [
    { type: 'rect', left: 10, top: 20, width: 100, height: 50, scaleX: 2, fill: '#3b82f6' },
    { type: 'textbox', left: 5, top: 90, width: 80, height: 24, text: 'fixture-hello' }
  ];
  // 关键：实例**不挂 window**，只在闭包里 —— 与 suxieban 的真实形态一致。
  window.__amSeen = 0;
  document.querySelector('canvas.upper-canvas').addEventListener('mousemove', function () {
    window.__amSeen++;
    inst.__onMouseMove();
  });
</script>
</body></html>`;

const KONVA_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>AM-konva</title><style>canvas{width:600px;height:400px;display:block}</style></head><body>
<canvas></canvas>
<script>
  window.Konva = { version: 'fixture-9', stages: [{
    getLayers: function () {
      return [{ getChildren: function () {
        return [
          { getClassName: function () { return 'Rect'; }, x: function () { return 5; }, y: function () { return 6; } },
          { getClassName: function () { return 'Text'; }, x: function () { return 7; }, y: function () { return 8; }, text: function () { return 'konva-hi'; } }
        ];
      } }];
    }
  }] };
</script>
</body></html>`;

const PLAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>AM-plain</title></head><body><h1>nothing here</h1><canvas></canvas></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const u = String(req.url || "");
      if (u.startsWith("/fabric")) res.end(FABRIC_PAGE);
      else if (u.startsWith("/konva")) res.end(KONVA_PAGE);
      else res.end(PLAIN_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.once("connect", () => fin(true));
    s.once("error", () => fin(false));
    setTimeout(() => fin(false), 500);
  });
}

function waitForPort(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const once = async () => {
      if (await checkPort(port)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting port " + port));
      setTimeout(once, 250);
    };
    once();
  });
}

const guard = require("./_spawn_guard.cjs");

let PASS = 0, FAIL = 0;
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`);
};
const note = (text) => console.log(`  NOTE | ${text}`);

async function spawnElectron(port) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, ...windowEnv('appmodel'), AI_BROWSER_PORT: String(port) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) {
    childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-${port}`);
  }
  const child = spawn(electronPath, ["."], {
    cwd: ROOT, stdio: "ignore", detached: true, env: childEnv,
  });
  guard.track(child);
  await waitForPort(port, 30000);
  return child;
}

const un = (r) => (r && r.result) || r;
const cap = (b, tab, params) => b.call("ui.capabilities", Object.assign({ tab }, params || {})).then(un);

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error("!! port " + WS_PORT + " 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程");
    process.exit(3);
  }

  console.log("spawn electron port", WS_PORT);
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, "app-model");

  // ---- 1. 阴性对照：普通页面 ----
  //
  // 这条不是走过场：没有它，下面每一条 PASS 也可能是「探针永远报有模型」。
  console.log("\n[AM 1] 普通页面 —— deep 不许报出假库");
  const t1 = un(await b.call("ui.new_tab", { url: HOST + "/plain" }));
  await sleep(1200);
  const plainDeep = await cap(b, t1.tab, { deep: true, include_network: false });
  check("AM-E1 deep 在无库页面上不报假命中",
    plainDeep && plainDeep.app_model && plainDeep.app_model.ok === true &&
    (plainDeep.app_model.libs || []).length === 0,
    "libs=" + JSON.stringify((plainDeep.app_model && plainDeep.app_model.libs || []).map(x => x.lib)));
  check("AM-E2 无命中时路线里没有 L1_app_object_model",
    !(plainDeep.route.recommended || []).includes('L1_app_object_model'),
    "recommended=" + JSON.stringify(plainDeep.route.recommended));
  check("AM-E3 无命中时给出可执行的兜底，而不是空白",
    (plainDeep.app_model.notes || []).some((n) => /prototype/.test(n)),
    JSON.stringify(plainDeep.app_model.notes).slice(0, 120));

  // ---- 2. 开关本身：不传 deep 就不挖 ----
  console.log("\n[AM 2] fabric 页面 —— 不传 deep 时不该白跑一趟");
  const t2 = un(await b.call("ui.new_tab", { url: HOST + "/fabric" }));
  await sleep(1500);
  const noDeep = await cap(b, t2.tab, { include_network: false });
  check("AM-E4 默认 app_model=null（deep 是显式开关）", noDeep.app_model === null,
    "app_model=" + JSON.stringify(noDeep.app_model));
  check("AM-E5 默认路线里没有 L1_app_object_model",
    !(noDeep.route.recommended || []).includes('L1_app_object_model'),
    "recommended=" + JSON.stringify(noDeep.route.recommended));

  // ---- 3. 核心：deep 把闭包里的实例挖出来 ----
  console.log("\n[AM 3] fabric 页面 —— deep 挖出闭包实例并改正路线");
  const deep1 = await cap(b, t2.tab, { deep: true, include_network: false });
  const am = deep1.app_model || {};
  const fab = (am.libs || []).find((l) => l.lib === 'fabric');
  check("AM-E6 认出 fabric 并标出版本", !!fab && fab.version === 'fixture-1',
    JSON.stringify(fab && { lib: fab.lib, version: fab.version }));
  check("AM-E7 抓到闭包实例（window 上没有）", !!fab && fab.acquired === true,
    JSON.stringify(fab && { acquired: fab.acquired, note: fab.note }));
  check("AM-E8 读出对象数与几何（scale 已算进宽度）",
    !!fab && fab.count === 2 && fab.items[0].w === 200,
    JSON.stringify(fab && { count: fab.count, w0: fab.items[0] && fab.items[0].w }));
  check("AM-E9 文本对象能读回内容",
    !!fab && fab.items.some((it) => it.text === 'fixture-hello'),
    JSON.stringify(fab && fab.items.map(i => i.text).filter(Boolean)));
  check("AM-E10 supports 是实测的（含 toJSON/toSVG/loadFromJSON）",
    !!fab && ['getObjects', 'toJSON', 'toSVG', 'loadFromJSON'].every((m) => (fab.supports || []).includes(m)),
    JSON.stringify(fab && fab.supports));
  check("AM-E11 路线首选被改成 L1_app_object_model",
    (deep1.route.recommended || [])[0] === 'L1_app_object_model' &&
    (deep1.route.routes || [])[0].route === 'L1_app_object_model',
    "recommended=" + JSON.stringify(deep1.route.recommended));
  check("AM-E12 探针如实报告自己派发过合成鼠标",
    typeof am.side_effect === 'string' && /synthetic mousemove/.test(am.side_effect),
    String(am.side_effect));

  // ---- 4. read_expr 必须真的可执行 ----
  //
  // 这是最容易变成装饰的一个字段：给了表达式、agent 照着跑，拿到 null 或抛错，
  // 而我们还一路 PASS。所以这里真的把它喂给 ui.evaluate。
  console.log("\n[AM 4] read_expr 直接可执行");
  const expr = fab && fab.read_expr;
  let readBack = null;
  try {
    const r = un(await b.call("ui.evaluate", { tab: t2.tab, js: 'JSON.stringify(' + expr + '.map(function(o){return o.type}))' }));
    readBack = r && r.value;
  } catch (e) { readBack = 'ERR ' + e.message; }
  check("AM-E13 read_expr 喂给 ui.evaluate 能读到同一批对象",
    typeof readBack === 'string' && readBack.includes('rect') && readBack.includes('textbox'),
    String(readBack).slice(0, 120));

  // ---- 5. 幂等：第二次调用不能因为「装过」就空 ----
  console.log("\n[AM 5] 连调两次");
  const deep2 = await cap(b, t2.tab, { deep: true, include_network: false });
  const fab2 = (deep2.app_model && deep2.app_model.libs || []).find((l) => l.lib === 'fabric');
  check("AM-E14 第二次仍拿到实例（幂等，不靠缓存）", !!fab2 && fab2.acquired === true && fab2.count === 2,
    JSON.stringify(fab2 && { acquired: fab2.acquired, count: fab2.count }));

  // ---- 6. expr 类：不碰原型、不派发鼠标 ----
  console.log("\n[AM 6] Konva 注册表 —— 纯 expr 路径");
  const t3 = un(await b.call("ui.new_tab", { url: HOST + "/konva" }));
  await sleep(1200);
  const kv = await cap(b, t3.tab, { deep: true, include_network: false });
  const konva = (kv.app_model && kv.app_model.libs || []).find((l) => l.lib === 'konva');
  check("AM-E15 Konva 走注册表拿到实例", !!konva && konva.acquired === true && konva.count === 2,
    JSON.stringify(konva && { acquired: konva.acquired, count: konva.count }));
  check("AM-E16 expr 路径不派发合成鼠标（poked=0）",
    kv.app_model && kv.app_model.poked === 0,
    "poked=" + (kv.app_model && kv.app_model.poked));

  for (const t of [t1.tab, t2.tab, t3.tab]) {
    try { await b.call("ui.close_tab", { tab: t }); } catch (e) {}
  }

  console.log(`\nPASS=${PASS} FAIL=${FAIL}`);
  server.close();
  try { process.kill(-child.pid, "SIGTERM"); } catch (e) {}
  process.exit(FAIL ? 1 : 0);
}

const timer = setTimeout(() => {
  console.error("!! 全局超时 —— 观测窗要比被测行为长一个量级，这一次仍然不够");
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);
timer.unref && timer.unref();

main().catch((e) => {
  console.error("!! " + (e && e.stack || e));
  process.exit(1);
});

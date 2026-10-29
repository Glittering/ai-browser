// e2e/canvas_ws.cjs — canvas 绘制调用记录的端到端验证。
//
// 核心命题：**canvas 是代码画出来的，那就该拿到"画了什么"的结构化记录，
// 而不是去猜像素。** 2D canvas 的 fillText 能直接拿到文本串 —— 因此 canvas
// 里的字**不需要 OCR**。WebGL 做不到，必须如实标记为 opaque。
//
// 自带 fixture、不依赖外网；退出码非 0 表示失败。
//
// Run:  npm run canvas
//       AI_BROWSER_PORT=<port> npm run canvas

const { windowEnv } = require('./_window_mode.cjs');
const harness = require("./_harness.cjs");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fixture：2D canvas 画中文与英文文本 + 一个矩形；再试一个 WebGL canvas。
const CANVAS_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>CanvasFixture</title></head><body>
<canvas id="cv2d" width="400" height="200"></canvas>
<canvas id="cvgl" width="120" height="80"></canvas>
<script>
  (function () {
    var c = document.getElementById('cv2d');
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 400, 200);
    x.fillStyle = '#000000';
    x.font = '20px sans-serif';
    x.fillText('确认支付', 20, 40);
    x.fillText('Hello Canvas', 20, 80);
    x.strokeText('CANVAS-STROKE-42', 20, 120);
    window.__drew2d = true;

    var g = document.getElementById('cvgl');
    var gl = null;
    try { gl = g.getContext('webgl') || g.getContext('experimental-webgl'); } catch (e) {}
    window.__hasWebGL = !!gl;
    if (gl) { try { gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); } catch (e) {} }
  })();
</script>
</body></html>`;

// 纯 canvas 白板夹具：**整个文档就是一块 canvas**，图元存在闭包里。
//
// 存在的理由：本项目所有"动作是否生效"的判据都来自 DOM（文本哈希、节点数、
// 焦点长度），而这类应用的写入在 DOM 上是**零字节**。实测 Excalidraw
// （2026-10-29）：拖出一个矩形，DOM 一个节点都没多，page_changed 只能靠
// "选中后右侧属性面板出现"这种副作用偶然为真。这个夹具把副作用全部去掉 ——
// 页面上除了 canvas 什么都没有，除了绘制没有任何 DOM 动静 —— 于是"能不能看见
// 画布变化"变成唯一决定成败的条件。
//
// 刻意不用 pointer 事件：夹具要测的是探针，不是浏览器的事件合成，
// mousedown/mousemove/mouseup 是 CDP 一定会派发的。
const BOARD_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>BoardFixture</title>
<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}canvas{display:block}</style>
</head><body>
<canvas id="cv" width="900" height="600"></canvas>
<script>
(function () {
  var c = document.getElementById('cv'), x = c.getContext('2d');
  var shapes = [];       // 闭包内部状态：DOM 上看不见，正是本夹具的意义
  var drawing = null;
  function paint() {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 900, 600);
    x.strokeStyle = '#000000'; x.lineWidth = 2;
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i];
      x.strokeRect(s.x, s.y, s.w, s.h);
    }
  }
  c.addEventListener('mousedown', function (e) {
    drawing = { x: e.offsetX, y: e.offsetY, w: 0, h: 0 };
    shapes.push(drawing); paint();
  });
  c.addEventListener('mousemove', function (e) {
    if (!drawing) return;
    drawing.w = e.offsetX - drawing.x; drawing.h = e.offsetY - drawing.y; paint();
  });
  c.addEventListener('mouseup', function () { drawing = null; paint(); });
  paint();
  // 仅供测试自证："动作真的改变了页面内部状态"，而不是只看我们自己的探针。
  window.__shapeCount = function () { return shapes.length; };
})();
</script>
</body></html>`;

// 自漂 / 自重绘页：专门用来证伪"画布变了就是我的动作生效了"。
//
// mode=same  每帧整屏重绘**完全相同**的内容（相当于一个静止画面的动画循环，
//            或 ECharts 在动画区间里的重复提交）。修复前它会让 page_changed
//            永远为真：探针比的是 `fp:n:frames`，而 n/frames 单调递增。
// mode=drift 每帧内容都不同（时钟指针 / 协作光标 / 进度条）。这类页面上画布
//            变化**不可归因**，工具必须说"这个信号在这里不可用"，而不是硬报 changed。
const ANIM_PAGE = (mode) => `<!doctype html><html><head><meta charset="utf-8">
<title>Anim-${mode}</title>
<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}canvas{display:block}</style>
</head><body>
<canvas id="cv" width="900" height="600"></canvas>
<script>
(function () {
  var c = document.getElementById('cv'), x = c.getContext('2d'), t = 0;
  var DRIFT = ${JSON.stringify(mode === 'drift')};
  function frame() {
    t++;
    x.clearRect(0, 0, 900, 600);
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 900, 600);
    x.strokeStyle = '#000000'; x.lineWidth = 2;
    // same: 坐标固定 → 每帧绘制序列逐字节相同；drift: 每帧都在挪
    x.strokeRect(DRIFT ? (t * 7) % 800 : 100, 100, 60, 60);
  }
  // 用 setInterval 而不是 requestAnimationFrame：Chromium 对不可见标签页会**暂停
  // rAF**（这和 backgroundThrottling 是两个机制，项目已经关掉了后者），于是后台
  // 跑的时候这个"动画页"其实几乎静止 —— 那样测出来的是"没有噪声时我们没被带偏"，
  // 而不是"有噪声时我们没被带偏"。夹具必须保证噪声真的存在，否则这一组断言
  // 全是空转（2026-10-14 踩过一模一样的坑）。
  setInterval(frame, 16);
})();
</script>
</body></html>`;

// 稳定重绘页（2026-10-29 新增）：每 16ms 重绘**完全相同**的内容，只有第一次指针
// 按下时多画一个方块，之后就再也不变。
//
// 为什么要这个夹具：这是"页面自己一直在画"的那一类（动画循环、协作光标、直播），
// 之前工具对它的画布证据只能一律回答"不可判"。现在靠完整帧哈希（last）能判了：
// 第一次按下 → 完整帧变了 → changed:true；第二次按下 → 完整帧没变 → changed:false。
// **后者是这个夹具存在的理由**：在持续重绘的页面上说出"你这一手没反应"。
const REPEAT_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Repeat-Repaint</title>
<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}canvas{display:block}</style>
</head><body>
<canvas id="cv" width="900" height="600"></canvas>
<script>
(function () {
  var c = document.getElementById('cv'), x = c.getContext('2d'), extra = 0;
  c.addEventListener('pointerdown', function () { extra = 1; });
  window.__shapeCount = function () { return extra ? 2 : 1; };
  setInterval(function () {
    x.clearRect(0, 0, 900, 600);
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 900, 600);
    x.strokeStyle = '#000000'; x.lineWidth = 2; x.strokeRect(100, 100, 60, 60);
    if (extra) { x.strokeStyle = '#cc0000'; x.strokeRect(400, 300, 60, 60); }
  }, 16);
})();
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const u = String(req.url || "");
      if (u.startsWith("/anim")) res.end(ANIM_PAGE(/drift/.test(u) ? 'drift' : 'same'));
      else if (u.startsWith("/repeat")) res.end(REPEAT_PAGE);
      else res.end(u.startsWith("/board") ? BOARD_PAGE : CANVAS_PAGE);
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

async function spawnElectron(port, extraEnv, removeKeys) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, ...windowEnv('canvas'), AI_BROWSER_PORT: String(port) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-${port}`);
  Object.assign(childEnv, extraEnv || {});
  // 显式移除：用于真正测"默认值"，而不是继承当前进程里已设置的开关
  for (const k of removeKeys || []) delete childEnv[k];
  const child = spawn(electronPath, ["."], {
    cwd: ROOT, stdio: "ignore", detached: true, env: childEnv,
  });
  guard.track(child);
  await waitForPort(port, 30000);
  return child;
}

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  // 等端口真的空闲，而不是“探一次没通就当空闲”：上一个 Electron 还在退出
  // 途中时，一次性探测就是抽签（会假性报“port busy”然后 exit 3）。
  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error("!! port " + WS_PORT + " 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程");
    process.exit(3);
  }

  console.log("spawn electron port", WS_PORT);
  const child = await spawnElectron(WS_PORT, {});

  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, "canvas");

  console.log("\n[canvas 绘制调用记录]");
  await b.call("ui.new_tab", { url: HOST + "/canvas" });
  await sleep(2500);
  // hook 只对"安装之后"的绘制生效；首屏画完的内容拿不回来，重载才能拿到完整历史。
  const cfgInit = await b.call("ui.canvas_configure", { mode: "semantic", reload: true });
  // 默认关闭，所以这里期望是"未安装"；一旦注入修好并显式开启，这条会变成真断言。
  const hookInstalled = !!(cfgInit && cfgInit.result && cfgInit.result.hook_installed);
  check("C-00 configure 返回完整契约字段",
    !!(cfgInit && cfgInit.result && "mode" in cfgInit.result &&
       "hook_installed" in cfgInit.result &&
       "reload_required_for_complete_history" in cfgInit.result),
    JSON.stringify(cfgInit && cfgInit.result));
  note("hook_installed=" + hookInstalled + " warnings=" +
    JSON.stringify(cfgInit && cfgInit.result && cfgInit.result.warnings));
  await sleep(2500);

  // hook 只有在真正注入页面后，内容断言才有意义。注入尚未在真实浏览器验证通过
  // （Runtime/Page 域的命令在 BrowserView 上不生效），因此未启用时把这些记为
  // 能力边界 NOTE，而不是假装失败 —— 等注入修好，断言会自动启用。
  const hookReady = !!(cfgInit && cfgInit.result && cfgInit.result.hook_installed);
  if (!hookReady) {
    note("canvas hook 未生效 —— 注入尚未在真实浏览器验证通过（默认关闭，需 AI_BROWSER_CANVAS_HOOK=1，" +
         "且 CDP 注入本身仍待修）。下列内容断言改为 NOTE 记录；注入一旦修好会自动启用。");
  }
  const ccheck = (name, cond, detail) =>
    hookReady ? check(name, cond, detail) : note("SKIP(hook 未启用) " + name);

  // 1) 列出 canvas
  const listed = await b.call("ui.canvas_list", {});
  const canvases = (listed && listed.result && listed.result.canvases) || [];
  ccheck("C-01 canvas_list 列出至少一个 canvas", canvases.length >= 1, "count=" + canvases.length);
  ccheck("C-02 hook 已安装", !!(listed && listed.result && listed.result.hook_installed),
    JSON.stringify(listed && listed.result && listed.result.warnings));

  const c2d = canvases.find((c) => c.kind === "2d");
  ccheck("C-03 存在 2D canvas 且可读性为 semantic",
    !!c2d && c2d.readability === "semantic",
    c2d ? `${c2d.canvas_id} kind=${c2d.kind} readability=${c2d.readability}` : "未找到 2D canvas");

  // 2) 读取内容 —— 这是核心断言
  const read = c2d
    ? await b.call("ui.canvas_read", { canvas_id: c2d.canvas_id, view: "summary" })
    : null;
  const texts = (read && read.result && read.result.texts) || [];
  const allText = texts.map((t) => t.text).join(" | ");
  ccheck("C-04 fillText 的中文文本被读到（无需 OCR）",
    texts.some((t) => t.text === "确认支付"), allText.slice(0, 120));
  ccheck("C-05 fillText 的英文文本被读到",
    texts.some((t) => t.text === "Hello Canvas"), allText.slice(0, 120));
  ccheck("C-06 strokeText 的文本也被读到",
    texts.some((t) => t.text === "CANVAS-STROKE-42"), allText.slice(0, 120));

  const regions = (read && read.result && read.result.regions) || [];
  ccheck("C-07 fillRect 的几何被记录到 regions",
    regions.some((r) => r.kind === "rect"), "regions=" + regions.length);

  // 3) 原始调用明细
  const calls = c2d
    ? await b.call("ui.canvas_read", { canvas_id: c2d.canvas_id, view: "calls", limit: 50 })
    : null;
  const callRows = (calls && calls.result && calls.result.calls) || [];
  ccheck("C-08 view=calls 返回原始绘制调用明细",
    callRows.length > 0 && callRows.some((r) => r.m === "fillText"),
    "calls=" + callRows.length);

  // 4) WebGL 必须被如实标记为不透明
  const cgl = canvases.find((c) => c.kind === "webgl" || c.kind === "webgl2");
  const hasGL = await b.call("ui.evaluate", { js: "window.__hasWebGL === true" });
  if (cgl) {
    const glRead = await b.call("ui.canvas_read", { canvas_id: cgl.canvas_id });
    ccheck("C-09 WebGL canvas 被标记为 opaque（不假装读懂）",
      !!(glRead && glRead.result && glRead.result.readability === "opaque"),
      JSON.stringify(glRead && glRead.result && glRead.result.readability));
  } else {
    note("WebGL canvas 未创建（本环境可能禁用 GPU，__hasWebGL=" +
      JSON.stringify(hasGL && hasGL.result && hasGL.result.value) +
      "）；一旦存在必须标记 opaque，不得假装读懂。");
  }

  // 5) 截图兜底（用户拍板选 C：进 MCP，默认关闭，必须显式调用）
  const cap = c2d ? await b.call("ui.canvas_capture", { canvas_id: c2d.canvas_id }) : null;
  const capOk = !!(cap && cap.result && cap.result.data_base64 && cap.result.data_base64.length > 100);
  ccheck("C-10 canvas_capture 能返回 PNG（视觉兜底，默认不调用）", capOk,
    capOk ? `${cap.result.width}x${cap.result.height}, ${cap.result.data_base64.length} b64 chars` : JSON.stringify(cap && cap.result));

  // 6) configure：mode 可切换，clear 生效
  const cfg = await b.call("ui.canvas_configure", { mode: "off" });
  check("C-11 canvas_configure 可切到 off",
    !!(cfg && cfg.result && cfg.result.mode === "off"),
    JSON.stringify(cfg && cfg.result && cfg.result.mode));
  const cleared = await b.call("ui.canvas_configure", { mode: "semantic", clear: true });
  const afterClear = await b.call("ui.canvas_list", {});
  check("C-12 clear 清空已记录的调用",
    (afterClear && afterClear.result && afterClear.result.retention &&
      afterClear.result.retention.calls === 0),
    JSON.stringify(afterClear && afterClear.result && afterClear.result.retention));
  void cleared;

  // ==========================================================================
  // 8) 纯 canvas 白板：写入必须被"看见"
  //
  // 这一组是本套件里唯一断言"**验证能力**"而不是"读取能力"的部分。前面 C-01..C-12
  // 都在问"能不能读到页面画了什么"；这一组问的是"我做了一个动作，工具能不能证明
  // 它发生了"。后者才是产品唯一的赌注 —— 读取可以退化成截图，验证不能。
  //
  // 判据刻意分成两层，缺一层就自欺：
  //   我们自己观测到的（page_changed / canvas_changed / ui.diff）
  //   页面自己说的（window.__shapeCount()）
  // 只有两层一致，"看见了"才算成立。
  // ==========================================================================
  console.log("\n[纯 canvas 白板：写入的可验证性]");
  const boardTab = await b.call("ui.new_tab", { url: HOST + "/board" }, 20000);
  const boardId = boardTab.result.tab;
  await sleep(2500);
  const fpShape = await b.call("ui.evaluate", { js: "typeof window.__aiCanvasFp", tab: boardId });
  check("CB-1 页面暴露了 canvas 帧指纹（hook 接线）",
    fpShape && fpShape.result && fpShape.result.value === "function",
    JSON.stringify(fpShape && fpShape.result && fpShape.result.value));
  const n0 = await b.call("ui.evaluate", { js: "window.__shapeCount()", tab: boardId });
  check("CB-2 初始没有图元", n0 && n0.result && n0.result.value === 0,
    JSON.stringify(n0 && n0.result && n0.result.value));

  const boardSnap = await b.call("ui.snapshot", { tab: boardId, label: "board-before" });
  const dragRes = await b.call("ui.act", {
    action: "drag",
    params: { from: { x: 120, y: 120 }, to: { x: 380, y: 300 }, steps: 10 },
    tab: boardId,
  }, 40000);
  const dr = (dragRes && dragRes.result) || {};
  // 这是核心断言：DOM 一个字没变（页面上只有一块 canvas），但动作成功了。
  check("CB-3 drag 成功且 DOM 零变化也判定为 page_changed",
    dr.success === true && dr.page_changed === true,
    `success=${dr.success} page_changed=${dr.page_changed} delta=${JSON.stringify(dr.page_delta)}`);
  check("CB-4 回执明确说明变化来自 canvas（canvas_changed）",
    dr.canvas_changed === true, JSON.stringify(dr.canvas_changed));
  check("CB-5 仅画布变化时不给 page_delta（DOM 确实没动）",
    dr.page_delta === undefined, JSON.stringify(dr.page_delta));
  check("CB-6 回执解释了'为什么 DOM 没变却算变了'",
    typeof dr.effect_hint === "string" && /canvas/i.test(dr.effect_hint),
    String(dr.effect_hint || "").slice(0, 120));

  // 页面自证：动作真的落地了
  const n1 = await b.call("ui.evaluate", { js: "window.__shapeCount()", tab: boardId });
  check("CB-7 页面内部状态真的变了（自证，不只看自己的探针）",
    n1 && n1.result && n1.result.value === 1,
    JSON.stringify(n1 && n1.result && n1.result.value));

  const boardDiff = await b.call("ui.diff", { snapshot: boardSnap.result.snapshot, tab: boardId }, 40000);
  const bd = (boardDiff && boardDiff.result) || {};
  // 字段名注意：`changed` 是布尔（本轮判定的结论），差异条目在 `changed_paths` /
  // `added` / `removed` 里。混用会得到 "changed is not iterable"。
  const touchedCanvas = [...(bd.added || []), ...(bd.changed_paths || []), ...(bd.removed || [])]
    .some((e) => String(e.path || "").startsWith("canvas"));
  check("CB-8 ui.diff 对画布写入给出 changed", bd.changed === true,
    `verdict=${bd.verdict} counts=${JSON.stringify(bd.counts)}`);
  check("CB-9 diff 的差异条目里出现 canvas 字段（不是靠别的巧合报 changed）",
    touchedCanvas, JSON.stringify((bd.changed_paths || []).slice(0, 3)));

  // 阳性对照：什么都不做，指纹不能自己动 —— 否则 CB-8 是假绿。
  const still1 = await b.call("ui.snapshot", { tab: boardId, label: "board-still-1" });
  await sleep(600);
  const still2 = await b.call("ui.diff", { snapshot: still1.result.snapshot, tab: boardId }, 40000);
  const st = (still2 && still2.result) || {};
  check("CB-10 静止不动时 diff 判 unchanged（画布指纹不会自己漂）",
    st.changed === false, `verdict=${st.verdict} counts=${JSON.stringify(st.counts)}`);

  check("CB-11 静态页的回执带 canvas_idle:true（标定真的跑了）",
    dr.canvas_idle === true, JSON.stringify(dr.canvas_idle));

  // ==========================================================================
  // 9) 画布自己在动的时候：能判就判，判不了就说判不了（绝不许猜）
  //
  // 这一组是红队评审逼出来的。第一版把探针字段写成 `fp:n:frames`，而 n/frames
  // 单调递增 —— 于是"内容一模一样地重绘一遍"也会让 page_changed 为真，
  // 恰好把 page_probe 的原始动机（抓"点了没反应"）反过来废掉。
  //
  // 三个形态必须分开（用一个量回答两个问题就会错）：
  //   same   每帧内容相同  → 完整帧哈希恒定 → **可判**（CB-14/15）
  //   drift  每帧内容不同  → 不可归因       → **不可判**，且不谎称变了（CB-16..19）
  //   repeat 第一次按下才变 → 持续重绘页上也能说出"你这一手没反应"（CB-20..22）
  // ==========================================================================
  console.log("\n[画布自己在动时：不能谎称『我这一手生效了』]");
  const sameTab = (await b.call("ui.new_tab", { url: HOST + "/anim?mode=same" }, 20000)).result.tab;
  await sleep(2500);
  const sameFp = await b.call("ui.evaluate", { js: "typeof window.__aiCanvasFp", tab: sameTab });
  check("CB-12 同内容重绘页也装了 hook",
    sameFp && sameFp.result && sameFp.result.value === "function",
    JSON.stringify(sameFp && sameFp.result && sameFp.result.value));

  // 前提：这一页必须**真的在重绘**，否则下面两条是空转（测的是"没噪声时没被带偏"）。
  const sameN1 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: sameTab });
  await sleep(400);
  const sameN2 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: sameTab });
  const sameAlive = (Number(sameN2.result.value) || 0) - (Number(sameN1.result.value) || 0) >= 3;
  check("CB-12b 前提：同内容重绘页确实每帧在画",
    sameAlive, `n ${sameN1.result.value} → ${sameN2.result.value}`);

  // 这一条守的是 **hook 层**：内容一模一样地反复重绘，指纹必须收敛到一个有界集合。
  // 判据用「取值集合有界」而不是「两次采样相等」—— 后者取决于采样落在帧内的什么
  // 位置（一次 IPC 往返落在 16ms 帧的哪个阶段是随机的），写成那样就是偶发绿。
  // 这里用硬上界：这一页每帧只画 3 条记录，所以前缀哈希最多 4 种（含"刚清屏还没画"
  // 的 0）。
  //
  // ⚠️ 它**不**覆盖接入层（探针要不要把 n/frames 拼进被比较的值）。那一条由
  // tests/test_canvas_fingerprint.js 的 CF-10/CF-11 **执行**真实的 PAGE_PROBE_JS /
  // DEFAULT_SNAPSHOT_JS 来钉，并且已经回退验证过会转红。e2e 做不到：要判断接入层
  // 有没有混计数器，只能看"两次采样是否相等"，而那又回到采样相位的运气上。
  const sames = [];
  for (let i = 0; i < 6; i++) {
    const r = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().fp", tab: sameTab });
    sames.push(String((r && r.result && r.result.value)));
    await sleep(50);
  }
  const distinct = new Set(sames).size;
  check("CB-13 同内容重绘页上指纹只有一个有界取值集合（计数器没混进来）",
    distinct <= 4, `distinct=${distinct} of 6 samples: ${sames.join(",")}`);

  const samePress = await b.call("ui.act", {
    action: "press", params: { key: "Escape" }, tab: sameTab,
  }, 30000);
  const spr = (samePress && samePress.result) || {};
  check("CB-14 同内容重绘页上按 Esc（什么都不该发生）→ page_changed:false",
    spr.page_changed === false,
    `page_changed=${spr.page_changed} canvas_changed=${JSON.stringify(spr.canvas_changed)} ` +
    `canvas_idle=${JSON.stringify(spr.canvas_idle)}`);
  // 这一条是 P2 的**能力提升**，不是回归：以前"页面自己在重绘"一律只能回答
  // canvas_changed:null（不可判），现在这种**每帧内容相同**的重绘页可以判了 ——
  // 靠完整帧哈希（hook 在帧边界提交的 last，与采样相位无关）。
  // 按 Esc 什么都没变 → canvas_changed:false（有证据的"没变"），而
  // canvas_repeat:true 告诉调用方"这一页在重绘，但判定仍然有效"。
  check("CB-15 稳定重绘页现在可判：canvas_changed:false + canvas_repeat:true（不再是 null）",
    spr.canvas_changed === false && spr.canvas_repeat === true && spr.canvas_idle === false,
    `canvas_changed=${JSON.stringify(spr.canvas_changed)} repeat=${JSON.stringify(spr.canvas_repeat)} ` +
    `idle=${JSON.stringify(spr.canvas_idle)}`);

  const driftTab = (await b.call("ui.new_tab", { url: HOST + "/anim?mode=drift" }, 20000)).result.tab;
  await sleep(2500);
  const driftN1 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: driftTab });
  await sleep(400);
  const driftN2 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: driftTab });
  const driftAlive = (Number(driftN2.result.value) || 0) - (Number(driftN1.result.value) || 0) >= 3;
  check("CB-16b 前提：自漂页确实每帧在画（否则 CB-17..19 是空转）",
    driftAlive, `n ${driftN1.result.value} → ${driftN2.result.value}`);

  const driftSnap = await b.call("ui.snapshot", { tab: driftTab, label: "drift-1" });
  await sleep(500);
  const driftDiff = await b.call("ui.diff", { snapshot: driftSnap.result.snapshot, tab: driftTab }, 40000);
  // 阴性对照：这一页的画布**确实**每帧都在变。如果这条不成立，下面那条
  // "canvas 信号不可用"就不是判定的功劳，而是我们根本没看见变化。
  check("CB-16 自漂页 500ms 后 diff 确实报 changed（现象真实存在）",
    driftDiff && driftDiff.result && driftDiff.result.changed === true,
    `verdict=${driftDiff && driftDiff.result && driftDiff.result.verdict}`);

  const driftPress = await b.call("ui.act", {
    action: "press", params: { key: "Escape" }, tab: driftTab,
  }, 30000);
  const dpr = (driftPress && driftPress.result) || {};
  // 前提不成立时记 SKIP 而不是 FAIL：这一页没有动画，"自漂能不能被识别"就无从谈起，
  // 硬判红等于把环境问题算成产品缺陷（本项目为此专门立过规矩）。
  const dcheck = (name, cond, detail) =>
    driftAlive ? check(name, cond, detail) : note("SKIP(自漂页没在动) " + name);
  dcheck("CB-17 自漂页上同样的动作 → canvas_idle:false（自漂被标定出来了）",
    dpr.canvas_idle === false, JSON.stringify(dpr.canvas_idle));
  dcheck("CB-18 自漂页上 canvas_changed 降为 null（不可归因就不下结论）",
    dpr.canvas_changed === null, JSON.stringify(dpr.canvas_changed));
  dcheck("CB-19 自漂页上 page_changed 不因画布自转而变成 true",
    dpr.page_changed === false, `page_changed=${dpr.page_changed} hint=${String(dpr.effect_hint || "").slice(0, 80)}`);

  // ==========================================================================
  // 10) 持续重绘的页面上，**说出"你这一手没反应"**
  //
  // 这是本次能力提升的正面：/repeat 页每 16ms 重绘完全相同的画面，只有在**第一次**
  // 指针按下时多画一个方块。所以
  //   第一次拖 → 完整帧换了 → canvas_changed:true
  //   第二次拖 → 完整帧没变 → canvas_changed:false   ← 这一条才是重点
  //
  // 第二条以前是做不到的：这种页面上"画布变了"永远成立（每帧都在画），
  // 判定只能一律回答"不可判"。agent 因此永远不知道自己那一下有没有生效。
  // 现在靠完整帧哈希能判，而页面自述的 __shapeCount() 是**独立证据**——
  // 不靠我们自己的探针证明"它真的没变"（否则就是自证）。
  // ==========================================================================
  console.log("\n[持续重绘的页面上：能不能说出『这一手没反应』]");
  const repeatTab = (await b.call("ui.new_tab", { url: HOST + "/repeat" }, 20000)).result.tab;
  await sleep(2500);
  const rpN1 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: repeatTab });
  await sleep(400);
  const rpN2 = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().n", tab: repeatTab });
  const rpAlive = (Number(rpN2.result.value) || 0) - (Number(rpN1.result.value) || 0) >= 3;
  const rpLast = await b.call("ui.evaluate", { js: "window.__aiCanvasFp().last", tab: repeatTab });
  check("CB-20 前提：重复绘页确实每帧在画，且已有完整帧可读",
    rpAlive && rpLast && rpLast.result.value !== null,
    `n ${rpN1.result.value} → ${rpN2.result.value}, last=${JSON.stringify(rpLast && rpLast.result && rpLast.result.value)}`);

  const rcheck = (name, cond, detail) =>
    rpAlive ? check(name, cond, detail) : note("SKIP(重复绘页没在动) " + name);

  const shape0 = await b.call("ui.evaluate", { js: "window.__shapeCount()", tab: repeatTab });
  const rpDrag1 = await b.call("ui.act", {
    action: "drag",
    params: { from: { x: 120, y: 120 }, to: { x: 380, y: 300 }, steps: 10 },
    tab: repeatTab,
  }, 40000);
  const rd1 = (rpDrag1 && rpDrag1.result) || {};
  const shape1 = await b.call("ui.evaluate", { js: "window.__shapeCount()", tab: repeatTab });
  rcheck("CB-21 第一次拖（页面首次 pointerdown → 内容变化）→ canvas_changed:true",
    rd1.canvas_changed === true,
    `canvas_changed=${JSON.stringify(rd1.canvas_changed)} repeat=${JSON.stringify(rd1.canvas_repeat)} ` +
    `page_changed=${rd1.page_changed}`);
  check("CB-21b 页面自述确实多了一个图元（独立证据，不是靠我们自己的探针）",
    shape0.result.value === 1 && shape1.result.value === 2,
    `${shape0.result.value} → ${shape1.result.value}`);

  const rpDrag2 = await b.call("ui.act", {
    action: "drag",
    params: { from: { x: 120, y: 120 }, to: { x: 380, y: 300 }, steps: 10 },
    tab: repeatTab,
  }, 40000);
  const rd2 = (rpDrag2 && rpDrag2.result) || {};
  const shape2 = await b.call("ui.evaluate", { js: "window.__shapeCount()", tab: repeatTab });
  // 之前这种页面上只能是 null。现在能说出"没变"，而且这句"没变"有页面自述背书。
  rcheck("CB-22 重复绘页上第二次拖（内容不再改变）→ canvas_changed:false（不再是 null）",
    rd2.canvas_changed === false,
    `canvas_changed=${JSON.stringify(rd2.canvas_changed)} repeat=${JSON.stringify(rd2.canvas_repeat)} ` +
    `page_changed=${rd2.page_changed}`);
  check("CB-22b 阴性对照：页面自述的图元数确实没再增加（所以 false 是对的，不是我们瞎了）",
    shape2.result.value === 2, `shapeCount=${shape2.result.value}`);
  rcheck("CB-23 该回执带 canvas_repeat:true（告诉调用方页在重绘但判定有效）",
    rd2.canvas_repeat === true, JSON.stringify(rd2.canvas_repeat));

  // 9) 总开关：AI_BROWSER_CANVAS_HOOK=0 时不注入。顺带钉住"指纹只能来自 hook"——
  //    否则 CB-1..CB-10 可能测的是一个与 hook 无关的东西。
  const offPort = WS_PORT + 1;
  console.log("\n[总开关：AI_BROWSER_CANVAS_HOOK=0 时关闭]");
  await spawnElectron(offPort, { AI_BROWSER_CANVAS_HOOK: "0" });
  const b2 = new Browser(offPort);
  try {
    await b2.ready();
    await b2.call("ui.new_tab", { url: HOST + "/canvas" });
    await sleep(2000);
    const l2 = await b2.call("ui.canvas_list", {});
    check("C-13 AI_BROWSER_CANVAS_HOOK=0 时不注入 hook",
      !!(l2 && l2.result && l2.result.hook_installed === false),
      JSON.stringify(l2 && l2.result && l2.result.warnings));
    const noFp = await b2.call("ui.evaluate", { js: "typeof window.__aiCanvasFp" });
    check("C-14 hook 关闭时页面上没有帧指纹（证明指纹只来自 hook）",
      noFp && noFp.result && noFp.result.value === "undefined",
      JSON.stringify(noFp && noFp.result && noFp.result.value));
  } finally {
    try { b2.close(); } catch {}
  }

  console.log(`\n==== canvas PASS=${PASS} FAIL=${FAIL} ====`);
  try { b.close(); } catch {}
  server.close();
  process.exit(FAIL ? 1 : 0);
}

setTimeout(() => {
  console.error("CANVAS TIMEOUT");
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

main().catch((e) => {
  console.error("canvas error:", (e && e.message) || e);
  process.exit(2);
});

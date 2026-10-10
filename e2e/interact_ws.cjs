// e2e/interact_ws.cjs — 指针手势与键盘的合同测试（真实受信输入）。
//
// 为什么需要这个套件：
//   1) 拖拽（移动 / 连线 / 平移 / 排序）是画布类应用的核心操作，而合成 PointerEvent
//      拖不动采用 Pointer Capture 的框架 —— 实测 React Flow 的画布节点 `moved` 恒为
//      0,0。所以拖拽必须走 CDP 的 Input.dispatchMouseEvent，evaluate 兜底救不了。
//   2) 拖拽有两个容易被写错、且会**静默产生错误结果**的细节，本套件专门钉住：
//        a. 必须以"按下后的第一个 move"为位移基准 —— 按下后不在同点补一次 move，
//           位移会稳定少 1/steps（14 步时请求 (-180,150) 只走到 (-167,139)）。
//        b. 起点若落在另一个可寻址元素上（视觉重叠），事件照常派发、success 照常
//           返回，页面却纹丝不动。必须显式警告，否则调用方只会以为"拖拽不生效"。
//   3) 删除节点 / 撤销 / 取消选中这类操作只有受信按键能做。
//
// Run:  npm run interact
//       AI_BROWSER_PORT=<port> npm run interact

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture --------------------------------------------------------------
// 所有参与交互的元素都带 role="group"：语义树会把纯布局 div 剪掉，而真实的画布
// 节点正是 `role:group` 的容器 —— 这样 fixture 与真实站点同构。
//
// #dragbox  可拖容器（cursor:grab）。内部 #handle 是连接点（class 词元 handle +
//           data-handlepos），用于验证 from_anchor:'right' 能否落到真实连接点上。
//           拖拽实现刻意采用"按下后第一个 move 作为基准"这一常见写法，
//           用来回归上面 2a 那个会被吃掉的偏移。
// #covered  中心被 #cover 完全盖住的容器 —— 用来触发 2b 的"抓错元素"警告。
// #dropzone 落点区，pointerup 落在其范围内才算 drop 成功。
// #victim  受信按键的删除目标。
const INTERACT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>InteractFixture</title>
<style>
  body { margin: 0; font: 13px sans-serif; }
  #dragbox  { position: absolute; left: 200px; top: 200px; width: 180px; height: 120px;
              background: #dbeafe; border: 1px solid #2563eb; cursor: grab; }
  #dropzone { position: absolute; left: 700px; top: 200px; width: 220px; height: 180px;
              background: #dcfce7; border: 2px dashed #16a34a; }
  #handle   { position: absolute; right: 0; top: 50%; width: 12px; height: 12px;
              background: #1d4ed8; cursor: crosshair; }
  #covered  { position: absolute; left: 200px; top: 420px; width: 160px; height: 80px;
              background: #fef9c3; border: 1px solid #ca8a04; cursor: grab; }
  #cover    { position: absolute; left: 240px; top: 440px; width: 120px; height: 60px;
              background: rgba(0,0,0,0.06); }
  #panbox   { position: absolute; left: 200px; top: 540px; width: 160px; height: 80px;
              background: #fae8ff; border: 1px solid #a21caf; cursor: grab; }
</style>
</head><body>
<div id="dragbox" role="group" aria-label="draggable box"><div id="handle" class="handle" data-handlepos="right"></div></div>
<div id="dropzone" role="group" aria-label="drop zone">DROPZONE<div id="fakehandle" class="handle" data-handlepos="right" style="position:absolute;right:0;top:50%;width:16px;height:32px;pointer-events:none;opacity:0"></div></div>
<div id="covered" role="group" aria-label="covered box">COVERED</div>
<div id="cover" role="group" aria-label="overlay">OVERLAY</div>
<div id="panbox" role="group" aria-label="middle-drag pan box">PANBYMIDDLE</div>
<button id="victim">DELETE-ME</button>
<div id="keylog">none</div>
<div id="wheellog">none</div>
<script>
  window.__log = { down: [], move: [], up: [], drops: [], keys: [], anyDown: [], wheels: [], panDown: [], panUp: [] };
  // 右键拖是画布类应用常见的"平移"绑定；Electron 里右键会弹原生菜单，先挡掉。
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // 滚轮：ui.scroll 只是 window.scrollBy，对画布类应用无效；画布靠 wheel 事件缩放平移。
  // 这里记录真的收到了 wheel，以及修饰键（画布缩放通常是 ctrl+wheel）。
  window.addEventListener('wheel', function (e) {
    window.__log.wheels.push([Math.round(e.deltaY), e.ctrlKey]);
    document.getElementById('wheellog').textContent = 'wheel:' + (e.ctrlKey ? 'ctrl+' : '') + Math.round(e.deltaY);
  }, { passive: true });
  // 记录"任意位置"的按下：用于验证显式起点坐标（空白处起拖 = 平移画布/框选）。
  document.addEventListener('pointerdown', function (e) {
    window.__log.anyDown.push([e.clientX, e.clientY]);
  }, true);

  // 相同的拖拽实现挂到两个容器上。以"按下后的第一个 move"为基准点是常见写法，
  // 调用方若不在按下后于同点补一次 move，这一步的偏移就被吃掉（位移稳定少 1/steps）。
  function makeDraggable(el) {
    var ref = null, pressed = false;
    el.addEventListener('pointerdown', function (e) {
      pressed = true; ref = null;
      window.__log.down.push([el.id, e.clientX, e.clientY]);
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    });
    window.addEventListener('pointermove', function (e) {
      if (!pressed) return;
      if (!ref) { ref = { x: e.clientX, y: e.clientY }; }
      window.__log.move.push([e.clientX, e.clientY]);
      el.style.transform = 'translate(' + (e.clientX - ref.x) + 'px,' + (e.clientY - ref.y) + 'px)';
    });
    window.addEventListener('pointerup', function (e) {
      if (!pressed) return;
      pressed = false;
      window.__log.up.push([e.clientX, e.clientY]);
      var dz = document.getElementById('dropzone').getBoundingClientRect();
      if (e.clientX >= dz.left && e.clientX <= dz.right && e.clientY >= dz.top && e.clientY <= dz.bottom) {
        window.__log.drops.push([e.clientX, e.clientY]);
        document.getElementById('dropzone').textContent = 'DROPPED';
      }
    });
  }
  makeDraggable(document.getElementById('dragbox'));
  makeDraggable(document.getElementById('covered'));

  // #panbox 只在**中键/右键**按下时平移 —— 画布类应用的常见绑定（左键留给框选）。
  // 它是 drag.button 的阳性对照：左键拖它必须纹丝不动，否则"键选对了"无从证明。
  (function () {
    var el = document.getElementById('panbox'), ref = null, btn = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 1 && e.button !== 2) return;
      btn = e.button; ref = { x: e.clientX, y: e.clientY };
      window.__log.panDown.push([e.button, e.clientX, e.clientY]);
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    });
    window.addEventListener('pointermove', function (e) {
      if (ref === null || btn === null || e.buttons === 0) return;
      el.style.transform = 'translate(' + (e.clientX - ref.x) + 'px,' + (e.clientY - ref.y) + 'px)';
    });
    window.addEventListener('pointerup', function (e) {
      if (btn === null) return;
      window.__log.panUp.push([e.button]);
      ref = null; btn = null;
    });
  })();

  window.addEventListener('keydown', function (e) {
    window.__log.keys.push([e.key, e.code, !!(e.metaKey || e.ctrlKey), e.shiftKey]);
    if (e.key === 'Delete') { var v = document.getElementById('victim'); if (v) v.remove(); }
    if (e.key === 'Escape') { document.getElementById('keylog').textContent = 'ESCAPED'; }
  });
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(INTERACT_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    function once() {
      const s = net.connect(port, WS_HOST);
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting port " + port));
        setTimeout(once, 250);
      });
    }
    once();
  });
}

let PASS = 0, FAIL = 0;
const check = (name, cond, detail) => { cond ? PASS++ : FAIL++; console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`); };
const note = (text) => console.log(`  NOTE | ${text}`);

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run interact"
    );
    process.exit(3);
  } catch { /* free */ }

  const electronPath = require("electron");
  console.log("spawn electron @", electronPath, "port", WS_PORT);
  const guard = require("./_spawn_guard.cjs");
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(WS_PORT) };
  // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动 —— 不起窗口、不监听 WS。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 默认独立 profile：~/.ai-browser 是用户的真实 profile（带登录态），测试不该碰。
  if (!childEnv.AI_BROWSER_USER_DATA) {
    childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${WS_PORT}`;
  }
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
  guard.track(child);
  await waitForPort(WS_PORT, 30000);

  const b = new Browser(WS_PORT);
  await b.ready();

  const ev = async (js, tab) => {
    const r = await b.call("ui.evaluate", { js, tab });
    return r && r.result !== undefined ? r.result.value : undefined;
  };
  const rectOf = async (domId, tab) => JSON.parse(
    (await ev(`(function(){var e=document.getElementById(${JSON.stringify(domId)});
      if(!e)return 'null';var r=e.getBoundingClientRect();
      return JSON.stringify([Math.round(r.left),Math.round(r.top)]);})()`, tab)) || "null"
  );
  const logOf = async (tab) => JSON.parse((await ev("JSON.stringify(window.__log)", tab)) || "{}");

  const tab = (await b.call("ui.new_tab", { url: HOST + "/" })).result.tab;
  await sleep(1500);
  // get_tree 负责写入 data-ai-id —— 没有它 ui.act 找不到元素。
  await b.call("ui.get_tree", { tab });
  const aiId = async (domId) => ev(
    `(function(){var e=document.getElementById(${JSON.stringify(domId)});return e?e.getAttribute('data-ai-id'):null;})()`,
    tab
  );

  const boxId = await aiId("dragbox");
  const dropId = await aiId("dropzone");
  const coveredId = await aiId("covered");
  const victimId = await aiId("victim");
  console.log("fixture ids:", JSON.stringify({ boxId, dropId, coveredId, victimId }));
  if (!boxId || !dropId || !coveredId || !victimId) {
    console.error("!! fixture 元素未全部进入语义树，无法继续（窗口尺寸 / 语义剪枝可能变了）");
    guard.killAll();
    process.exit(1);
  }

  // ---- D. 受信拖拽 --------------------------------------------------------
  console.log("\n[D 受信拖拽]");

  let before = await rectOf("dragbox", tab);
  let r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { dx: 120, dy: 60 } })).result;
  await sleep(400);
  let after = await rectOf("dragbox", tab);
  const moved = [after[0] - before[0], after[1] - before[1]];
  check("D-01 drag dx/dy 位移精确（不多不少）",
    moved[0] === 120 && moved[1] === 60, `请求(120,60) 实得(${moved[0]},${moved[1]})`);
  check("D-02 结果标注 dragged_via=cdp-drag 且起点命中目标",
    r && r.dragged_via === "cdp-drag" && r.start_hit_target === true,
    JSON.stringify({ via: r && r.dragged_via, hit: r && r.start_hit_target }));
  const lg = await logOf(tab);
  check("D-03 页面收到完整的按下→移动→松开手势",
    lg.down.length === 1 && lg.move.length >= 5 && lg.up.length === 1,
    `down=${lg.down.length} move=${lg.move.length} up=${lg.up.length}`);
  note("D-03 意义：合成 PointerEvent 无法替代真实受信鼠标序列（采用 Pointer Capture 的框架不动）");

  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { dx: 10, dy: 0, hold: ["Shift"] } })).result;
  check("D-04 drag hold:['Shift'] 仍正常完成（修饰键在位）",
    r && r.success === true, JSON.stringify(r && r.error));

  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { to_target: dropId, to_anchor: "center" } })).result;
  await sleep(400);
  const dropped = await ev(`document.getElementById('dropzone').textContent`, tab);
  check("D-05 drag to_target 落到目标元素上（drop 处理器触发）",
    dropped === "DROPPED", `dropzone 文本=${JSON.stringify(dropped)}`);
  check("D-06 结果里给出实际落点与落点上的元素",
    !!(r && r.drag_to && r.to_at !== undefined), JSON.stringify({ to: r && r.drag_to, to_at: r && r.to_at }));

  // D-07 连接点解析必须"可命中"才算数。先把容器放回空位：上一条 to_target 用例
  // 已经把它拖到落点区上，而落点区后加入 DOM、会盖住它 —— 那时它的连接点确实
  // 不可命中（自证检查会如实降级为 edge）。这里是测"连接点本身"，要先排除干扰。
  await ev("(function(){document.getElementById('dragbox').style.transform='';return true;})()", tab);
  await sleep(200);
  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { to_target: dropId, from_anchor: "right" } })).result;
  check("D-07 from_anchor:'right' 解析到真实连接点（可命中的才算）",
    !!(r && r.drag_from && r.drag_from.via === "handle"),
    JSON.stringify(r && r.drag_from));

  // 抓错元素：中心被覆盖 → 必须显式警告，而不是静默"成功但没动"
  before = await rectOf("covered", tab);
  r = (await b.call("ui.act", { action: "drag", target: coveredId, tab, params: { dx: 40, dy: 0 } })).result;
  await sleep(400);
  after = await rectOf("covered", tab);
  check("D-08 起点落在别的元素上时 start_hit_target=false 且带 warning",
    !!(r && r.start_hit_target === false && r.warning),
    JSON.stringify({ hit: r && r.start_hit_target, at: r && r.from_at_id, warn: r && r.warning }));
  check("D-09 该情形下元素确实没有移动（警告不是多余的）",
    after[0] === before[0] && after[1] === before[1], `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // 同上，但用 from_offset 把起点挪到没被盖住的地方 → 正常
  r = (await b.call("ui.act", { action: "drag", target: coveredId, tab, params: { dx: 40, dy: 0, from_offset: { x: -60, y: -30 } } })).result;
  await sleep(400);
  after = await rectOf("covered", tab);
  check("D-10 from_offset 可把起点挪开遮挡，拖拽恢复正常",
    !!(r && r.start_hit_target === true) && after[0] - before[0] === 40,
    `hit=${r && r.start_hit_target} dx=${after[0] - before[0]}`);

  before = await rectOf("dragbox", tab);
  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { dx: 4000, dy: 0 } })).result;
  await sleep(300);
  after = await rectOf("dragbox", tab);
  check("D-11 落点超出视口时报错而不是静默拖出去",
    !!(r && r.success === false && /outside the viewport/.test(r.error || "")), JSON.stringify(r && r.error));
  check("D-12 上述失败下元素未被移动",
    after[0] === before[0] && after[1] === before[1], `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: {} })).result;
  check("D-13 未给 to / to_target / dx,dy 时报错并说明怎么用",
    !!(r && r.success === false && /to_target|dx,dy/.test(r.error || "")), JSON.stringify(r && r.error));

  // D-14 绝对坐标落点。先把容器放回空位：前面的 to_target 用例已经把它拖到落点区
  // 上方，而落点区是后加入 DOM 的、会盖住它 —— 那时它的中心已经不归自己了
  // （这正是 D-08 要证明的现象，但会污染这一条）。
  await ev("(function(){document.getElementById('dragbox').style.transform='';return true;})()", tab);
  await sleep(200);
  const b0 = await rectOf("dragbox", tab);
  r = (await b.call("ui.act", { action: "drag", target: boxId, tab, params: { to_x: 400, to_y: 520 } })).result;
  await sleep(400);
  const pt = await rectOf("dragbox", tab);
  // 指针从容器中心走到 (400,520)，容器按同一位移平移 —— 断言这个位移，而不是断言落点坐标。
  const want = [b0[0] + (400 - (b0[0] + 90)), b0[1] + (520 - (b0[1] + 60))];
  check("D-14 drag 支持绝对坐标落点 to_x/to_y",
    !!(r && r.success === true) && Math.abs(pt[0] - want[0]) <= 1 && Math.abs(pt[1] - want[1]) <= 1,
    `起点 ${JSON.stringify(b0)} 落点 ${JSON.stringify(pt)} 期望 ${JSON.stringify(want)} act=${JSON.stringify(r)}`);

  // D-15 显式起点坐标：空白处起拖（平移画布 / 框选）不需要任何可寻址元素
  const lgBefore = await logOf(tab);
  r = (await b.call("ui.act", { action: "drag", tab, params: { from: { x: 900, y: 600 }, dx: 60, dy: 40 } })).result;
  await sleep(300);
  const lgAfter = await logOf(tab);
  const newDowns = (lgAfter.anyDown || []).length - (lgBefore.anyDown || []).length;
  check("D-15 显式起点坐标可在空白处起拖（无需 target 元素）",
    !!(r && r.success === true && r.drag_from && r.drag_from.via === "explicit") && newDowns === 1,
    JSON.stringify({ act: r && { ok: r.success, from: r.drag_from }, newDowns }));
  // D-16 不可命中的"连接点"（pointer-events:none / opacity:0 的装饰）不得被当成连接点。
  // 这是实测踩到的坑：真实画布上 handle 全是 pe:none + op:0，按下去命中的其实是
  // 节点本体，应用据此判定为"拖节点"而非"连线"；若还报 via:'handle'，调用方会
  // 一直以为自己连对了地方。#dropzone 里就放了这么一个假连接点。
  r = (await b.call("ui.act", { action: "drag", target: dropId, tab, params: { dx: 5, dy: 0, from_anchor: "right" } })).result;
  check("D-16 不可命中的装饰性 handle 不被误报为连接点（如实降级为 edge）",
    !!(r && r.drag_from && r.drag_from.via === "edge"),
    JSON.stringify(r && r.drag_from));

  // D-17..D-20 拖拽按键。画布类应用常把"平移"绑在中键/右键上（左键留给框选），
  // 只支持左键的拖拽在真实画布上就只剩"框选"一种结果。阳性对照是 #panbox：
  // 它只认中键/右键，左键拖它必须不动。
  const panId = await aiId("panbox");
  const resetPan = () => ev("(function(){document.getElementById('panbox').style.transform='';return true;})()", tab);

  const pan0 = await rectOf("panbox", tab);
  const lgP0 = await logOf(tab);
  r = (await b.call("ui.act", { action: "drag", target: panId, tab, params: { dx: 60, dy: 20, button: "middle" } })).result;
  await sleep(400);
  let lgP = await logOf(tab);
  const pan1 = await rectOf("panbox", tab);
  check("D-17 drag button:'middle' 派发的是中键（页面收到 button===1）",
    !!(r && r.success === true && r.button === "middle") &&
      (lgP.panDown || []).length - (lgP0.panDown || []).length === 1 &&
      lgP.panDown[lgP.panDown.length - 1][0] === 1,
    JSON.stringify({ actButton: r && r.button, got: lgP.panDown[lgP.panDown.length - 1] }));
  check("D-18 中键拖拽真的平移了只认中键的容器，且位移精确",
    pan1[0] - pan0[0] === 60 && pan1[1] - pan0[1] === 20,
    `${JSON.stringify(pan0)} -> ${JSON.stringify(pan1)} 期望 (+60,+20)`);

  // D-19 对照组：同一个容器换左键拖，必须纹丝不动。
  // 没有这一条，D-17/D-18 就不能排除"容器其实对任何键都平移"。
  await resetPan();
  await sleep(200);
  const panA = await rectOf("panbox", tab);
  r = (await b.call("ui.act", { action: "drag", target: panId, tab, params: { dx: 60, dy: 20 } })).result;
  await sleep(400);
  const panB = await rectOf("panbox", tab);
  check("D-19 对照：同一容器用左键拖纹丝不动（默认不误发中键）",
    !!(r && r.success === true) && panB[0] === panA[0] && panB[1] === panA[1],
    `${JSON.stringify(panA)} -> ${JSON.stringify(panB)}（应不变）`);

  await resetPan();
  await sleep(200);
  const panC = await rectOf("panbox", tab);
  const lgP2 = await logOf(tab);
  r = (await b.call("ui.act", { action: "drag", target: panId, tab, params: { dx: 30, dy: 10, button: "right" } })).result;
  await sleep(400);
  lgP = await logOf(tab);
  const panD = await rectOf("panbox", tab);
  check("D-20 drag button:'right' 派发的是右键（页面收到 button===2）并生效",
    !!(r && r.success === true && r.button === "right") &&
      (lgP.panDown || []).length - (lgP2.panDown || []).length === 1 &&
      lgP.panDown[lgP.panDown.length - 1][0] === 2 &&
      panD[0] - panC[0] === 30 && panD[1] - panC[1] === 10,
    JSON.stringify({ actButton: r && r.button, got: lgP.panDown[lgP.panDown.length - 1], move: [panD[0] - panC[0], panD[1] - panC[1]] }));
  note("D-17..D-20 意义：真实画布上「中键/右键拖=平移、左键拖=框选」，没有按键就无法驱动平移");

  // ---- W. 受信滚轮（画布缩放/平移的唯一通路）-----------------------------
  console.log("\n[W 受信滚轮]");
  const wheelsOf = async () => (await logOf(tab)).wheels || [];

  const w0 = await wheelsOf();
  let wr = (await b.call("ui.act", { action: "wheel", tab, params: { dy: -300, at: { x: 640, y: 368 } } })).result;
  await sleep(300);
  const w1 = await wheelsOf();
  check("W-01 wheel 真实把 wheel 事件送达页面（deltaY 正确）",
    !!(wr && wr.success === true) && w1.length - w0.length >= 1 && w1[w1.length - 1][0] === -300,
    JSON.stringify({ act: wr && wr.delta, got: w1[w1.length - 1] }));

  wr = (await b.call("ui.act", { action: "wheel", tab, params: { dy: -200, at: { x: 640, y: 368 }, hold: ["Control"] } })).result;
  await sleep(300);
  const w2 = await wheelsOf();
  check("W-02 wheel 的 hold:['Control'] 传到了页面（ctrlKey=true，画布缩放就靠它）",
    !!(wr && wr.success === true) && w2[w2.length - 1][1] === true, JSON.stringify(w2[w2.length - 1]));

  wr = (await b.call("ui.act", { action: "wheel", tab, params: {} })).result;
  check("W-03 wheel 未给 dx/dy 时报错并说明怎么用",
    !!(wr && wr.success === false && /need dx or dy/.test(wr.error || "")), JSON.stringify(wr && wr.error));
  note("W-03 意义：ui.scroll 对画布类应用完全无效（它只做 window.scrollBy），wheel 才是缩放/平移的通路");

  // ---- K. 受信按键 --------------------------------------------------------
  console.log("\n[K 受信按键]");

  const k1 = (await b.call("ui.act", { action: "press", target: victimId, tab, params: { key: "Delete" } })).result;
  await sleep(500);
  const victimGone = await ev("document.getElementById('victim') === null", tab);
  check("K-01 press Delete 真实触发页面 keydown 并改变了 DOM",
    !!(k1 && k1.success === true) && victimGone === true,
    JSON.stringify({ pressed: k1 && k1.pressed, gone: victimGone }));

  const k2 = (await b.call("ui.act", { action: "press", tab, params: { key: "Escape" } })).result;
  await sleep(300);
  const escText = await ev("document.getElementById('keylog').textContent", tab);
  check("K-02 无 target 时按键发给当前焦点（Escape 被页面收到）",
    !!(k2 && k2.success === true) && escText === "ESCAPED", JSON.stringify(escText));

  const k3 = (await b.call("ui.act", { action: "press", tab, params: { keys: ["a", "b", "c"] } })).result;
  check("K-03 press keys 序列按顺序全部送达",
    !!(k3 && k3.success === true) && JSON.stringify(k3.pressed) === JSON.stringify(["a", "b", "c"]),
    JSON.stringify(k3 && k3.pressed));

  const k4 = (await b.call("ui.act", { action: "press", tab, params: { key: "Meta+a" } })).result;
  await sleep(300);
  const lg4 = await logOf(tab);
  const lastKey = (lg4.keys || [])[lg4.keys.length - 1] || [];
  check("K-04 组合键 Meta+a 的修饰位真的传到页面（metaKey=true）",
    !!(k4 && k4.success === true) && lastKey[0] === "a" && lastKey[2] === true, JSON.stringify(lastKey));

  const k5 = (await b.call("ui.act", { action: "press", tab, params: { key: "NoSuchKey" } })).result;
  check("K-05 不认识的键名明确报错，而不是发一个错键",
    !!(k5 && k5.success === false && /unsupported key/.test(k5.error || "")), JSON.stringify(k5 && k5.error));

  // ---- A. 语义树里的动作可发现性 ------------------------------------------
  console.log("\n[A 动作可发现性]");
  const tree2 = (await b.call("ui.get_tree", { tab })).result;
  const flat2 = [];
  (function walk(n) { flat2.push(n); for (const c of n.children || []) walk(c); })(tree2.tree || tree2);
  const byId = (id) => flat2.find((n) => n.id === id);
  const boxNode = byId(boxId);
  check("A-01 可拖容器在语义树里自述 drag 动作（agent 不必靠试）",
    !!(boxNode && (boxNode.actions || []).includes("drag")), JSON.stringify(boxNode && boxNode.actions));
  check("A-02 可拖容器同时自述 click（按下松开即点选）",
    !!(boxNode && (boxNode.actions || []).includes("click")), JSON.stringify(boxNode && boxNode.actions));
  const dzNode = byId(dropId);
  check("A-03 对照：不可拖的容器不会被标记 drag（否则 A-01 没有信息量）",
    !(dzNode && (dzNode.actions || []).includes("drag")), JSON.stringify(dzNode && dzNode.actions));

  console.log(`\n==== interact PASS=${PASS} FAIL=${FAIL} ====`);
  b.close();
  guard.killAll();
  server.close();
  process.exit(FAIL > 0 ? 1 : 0);
}

const globalTimer = setTimeout(() => {
  console.error("INTERACT E2E TIMEOUT");
  try { require("./_spawn_guard.cjs").killAll(); } catch { /* ignore */ }
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref();

main().catch((e) => {
  console.error("interact e2e error:", e && e.message);
  try { require("./_spawn_guard.cjs").killAll(); } catch { /* ignore */ }
  process.exit(1);
});

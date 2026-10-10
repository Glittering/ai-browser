// e2e/view_ws.cjs — 视图刷新 + 操作校验（ui.repaint / ui.snapshot / ui.diff）
//
// 两个命题，各自都来自真实故障：
//
// 1) **"页面已经变了但窗口不刷新"**（用户实测：已经切到无限画布/ComfyUI 了，
//    视图却不动，来回点几次标签才更新）。
//    根因不是"没触发"，而是**只有标签切换会强制合成器重绘** —— setActive /
//    closeTab 里那句 removeBrowserView + addBrowserView + setBounds 是唯一的
//    重绘手段，导航路径上一处都没有。history.pushState 的 SPA 路由切换
//    连 load 事件都不发，于是永远等不到。
//    判据用 `repaint_count`（累计值），而不是"看截图"：截图要人眼，计数能证伪。
//    ⚠️ 计数查询本身会 +1，所有差值都扣掉这一次。
//
// 2) **"操作返回 success 但什么都没发生"** —— 本项目最忌讳的谎报。
//    ui.diff 把"动作 → 回读 → 比对"变成一次调用；这套件钉住它既能发现真变化，
//    也不会把"没变"误报成变了。
//
// 自带 fixture、不依赖外网；退出码非 0 表示失败。
// Run:  npm run view
//       AI_BROWSER_PORT=<port> npm run view

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SPA fixture：按钮触发 history.pushState（不产生任何 load 事件）+ 子 iframe 延迟导航。
// iframe 用**真实 HTTP 路径**而不是 data: —— data: 页面里嵌 data: iframe 会被拦，
// srcdoc 又不产生导航事件，那样就测不到 did-frame-finish-load（测不到 ≠ 钩子不存在）。
const INDEX_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>ViewFixture</title><style>body{font:16px system-ui;margin:0;padding:30px}
#v{height:120px;background:#eee}</style></head><body>
<div id="hud">view=A</div>
<div id="v">A</div>
<button id="go">switch to B</button>
<div id="out">idle</div>
<input id="in1" placeholder="type here" value="">
<ul id="list"><li>alpha</li><li>beta</li></ul>
<iframe id="fr" style="width:560px;height:120px;border:1px solid #999" src="/blank.html"></iframe>
<script>
  window.__counter = 0;
  window.__bump = function () { window.__counter++; };
  document.getElementById('go').addEventListener('click', function () {
    history.pushState({}, '', '#view-b');
    document.getElementById('hud').textContent = 'view=B';
    document.getElementById('v').textContent = 'B';
  });
  window.__probe = function () {
    return {
      hud: document.getElementById('hud').textContent,
      hash: location.hash,
      out: document.getElementById('out').textContent,
      value: document.getElementById('in1').value,
      counter: window.__counter,
      items: Array.prototype.map.call(document.querySelectorAll('#list li'), function (li) { return li.textContent; }),
      frame: (function () {
        try { var f = document.getElementById('fr');
          return f.contentDocument && f.contentDocument.getElementById('inner') ? 'ready' : 'blank'; }
        catch (e) { return 'err'; }
      })()
    };
  };
</script>
</body></html>`;
const BLANK_PAGE = '<!doctype html><html><body>blank</body></html>';
const LATE_PAGE = '<!doctype html><html><body><p id="inner">IFRAME READY</p></body></html>';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      const html = url === "/late.html" ? LATE_PAGE
        : url === "/blank.html" ? BLANK_PAGE
        : INDEX_PAGE;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
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

async function spawnElectron(port) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: "0" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-view-${port}`;
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
  guard.track(child);
  await waitForPort(port, 30000);
  return child;
}

const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    await waitForPort(WS_PORT, 600);
    console.error("!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run view");
    process.exit(3);
  } catch { /* free */ }

  console.log("spawn electron port", WS_PORT);
  await spawnElectron(WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();
  const tab = unwrap(await b.call("ui.new_tab", { url: HOST + "/" })).tab;
  await sleep(2500);

  const ev = async (js) => {
    const r = await b.call("ui.evaluate", { tab, js });
    return r && r.result !== undefined ? r.result.value : undefined;
  };
  const probe = async () => JSON.parse(await ev("JSON.stringify(window.__probe())"));
  // 累计重绘计数。**每次调用自身 +1**，所以所有差值都要扣掉 1。
  const repaintCount = async () => (unwrap(await b.call("ui.repaint", { tab })) || {}).repaint_count || 0;

  // ===================== R. 视图刷新 =====================
  console.log("\n[R. 视图刷新：页面变了窗口必须跟着重绘]");
  await sleep(700);
  const r0 = await repaintCount();

  // R-01: SPA 路由切换（history.pushState，连 load 事件都不发）
  await ev(`document.getElementById('go').click(), 1`);
  await sleep(800);
  const r1 = await repaintCount();
  const stA = await probe();
  check("R-01 did-navigate-in-page 触发重绘（净增 = 差值-1，1 是本次查询自身）",
    (r1 - r0 - 1) >= 1, `count ${r0}→${r1} (净增 ${r1 - r0 - 1})`);
  check("R-02 页面确实切到了 view=B", stA.hash === "#view-b" && stA.hud === "view=B",
    JSON.stringify({ hash: stA.hash, hud: stA.hud }));

  // R-03: 阴性对照 —— 静置时不得自激，否则会不停闪烁耗电
  const r2 = await repaintCount();
  await sleep(1500);
  const r3 = await repaintCount();
  check("R-03 静置 1.5s 不自激（净增 ≤ 0）", (r3 - r2 - 1) <= 0,
    `count ${r2}→${r3} (净增 ${r3 - r2 - 1})`);

  // R-04: 子 iframe 再次导航（ComfyUI 模式：主文档早已 finish，子帧后加载）
  const f0 = await repaintCount();
  await ev(`document.getElementById('fr').src = '/late.html?_=' + Date.now(), 1`);
  let frameReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if ((await probe()).frame === "ready") { frameReady = true; break; }
  }
  await sleep(500);
  const f1 = await repaintCount();
  check("R-04 did-frame-finish-load 触发重绘", (f1 - f0 - 1) >= 1,
    `count ${f0}→${f1} (净增 ${f1 - f0 - 1})`);
  check("R-05 iframe 内容确实加载完成", frameReady);

  // R-06: ui.repaint 幂等 + 对不存在的 tab 明确报错（不静默假成功）
  const p1 = unwrap(await b.call("ui.repaint", { tab }));
  const p2 = unwrap(await b.call("ui.repaint", { tab }));
  const pBad = unwrap(await b.call("ui.repaint", { tab: 999999 }));
  check("R-06 ui.repaint 连续调用都 ok", p1.ok === true && p2.ok === true,
    JSON.stringify({ p1: p1.ok, p2: p2.ok }));
  check("R-07 不存在的 tab 明确报错而不是假装成功",
    pBad.ok === false && pBad.error === "no-such-tab", JSON.stringify(pBad));
  // R-08: 重绘不得改动页面数据（阴性对照）
  const before8 = await probe();
  await b.call("ui.repaint", { tab });
  await sleep(400);
  const after8 = await probe();
  check("R-08 重绘不改变任何页面数据", JSON.stringify(before8) === JSON.stringify(after8));

  // ===================== D. 操作校验（ui.snapshot / ui.diff）=====================
  console.log("\n[D. ui.diff：把'操作→回读→比对'变成一行]");

  // D-01: 传错参数层级必须明确报错，不得静默报成功。
  // 实测踩过：WS 契约把动作参数放在 params.params，照 MCP 的扁平形状写
  // {text:...} 会变成空文本 → 命中幂等短路 → **什么都没打却报 success**。
  const raw = await b.call("ui.get_tree", { tab });
  const tree = (raw && raw.result ? raw.result.tree : null) || (raw && raw.tree) || raw;
  const root = tree && tree.result ? tree.result : tree;
  const flat = [];
  (function walk(n) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(root);
  // 按 role 精确挑，不能用 label 正则扫全树（body 的文本包含按钮文案）
  const textbox = flat.find((n) => n.role === "textbox");

  if (textbox) {
    const wrongNesting = unwrap(await b.call("ui.act", {
      action: "type", target: textbox.id, text: "wrong nesting", tab,
    }));
    check("D-01 传错参数层级 → 明确报错，不得静默报成功",
      wrongNesting.success === false && /empty text|params\.params/.test(wrongNesting.error || ""),
      JSON.stringify({ success: wrongNesting.success, method: wrongNesting.method,
        error: String(wrongNesting.error || "").slice(0, 70) }));
  } else {
    check("D-01 找到输入框", false, "no textbox in semantic tree");
  }

  // D-02..D-06: 自定义表达式的 diff 语义
  const EXPR = '({items: Array.prototype.map.call(document.querySelectorAll("#list li"), function(li){return li.textContent;}), c: window.__counter})';
  const snap = unwrap(await b.call("ui.snapshot", { tab, js: EXPR, label: "baseline" }));
  check("D-02 snapshot 返回 id 与体积", !!(snap.ok && snap.snapshot) && typeof snap.bytes === "number",
    JSON.stringify({ id: snap.snapshot, bytes: snap.bytes }));
  check("D-03 preview 能确认采到的是目标对象", /items/.test(snap.preview || ""), snap.preview);

  const d0 = unwrap(await b.call("ui.diff", { tab, snapshot: snap.snapshot }));
  check("D-04 阴性对照：没改动时必须判 unchanged（不得凭空报变化）",
    d0.verdict === "unchanged" && d0.changed === false,
    `verdict=${d0.verdict} counts=${JSON.stringify(d0.counts)}`);

  await ev(`window.__bump(), window.__bump(), 1`);
  const d1 = unwrap(await b.call("ui.diff", { tab, snapshot: snap.snapshot }));
  check("D-05 改动时判 changed，且给出路径与前后值",
    d1.verdict === "changed" && d1.changed_paths.some((p) => p.path === "c" && p.from === 0 && p.to === 2),
    JSON.stringify(d1.changed_paths));

  await ev(`document.getElementById('list').insertAdjacentHTML('beforeend','<li>gamma</li>'), 1`);
  const d2 = unwrap(await b.call("ui.diff", { tab, snapshot: snap.snapshot }));
  check("D-06 数组尾部新增识别为 added（不是笼统的 changed）",
    d2.added.some((a) => a.path === "items[2]" && a.value === "gamma"),
    JSON.stringify(d2.added));

  // rearm 语义：本次仍按旧基线判定，**下一次**才用新基线
  const d3 = unwrap(await b.call("ui.diff", { tab, snapshot: snap.snapshot, rearm: true }));
  const d3b = unwrap(await b.call("ui.diff", { tab, snapshot: snap.snapshot }));
  check("D-07 rearm：本次仍按旧基线判 changed，随后不再改动则 unchanged",
    d3.verdict === "changed" && d3.rearmed === true && d3b.verdict === "unchanged",
    `本次=${d3.verdict} 之后=${d3b.verdict}`);

  // D-08: 默认快照（agent 不必为每个站点写 JS）
  const snap2 = unwrap(await b.call("ui.snapshot", { tab }));
  check("D-08 默认 DOM 快照可用（无需自定义表达式）", snap2.ok === true, `bytes=${snap2.bytes}`);
  const dA = unwrap(await b.call("ui.diff", { tab, snapshot: snap2.snapshot }));
  check("D-09 默认快照的阴性对照", dA.verdict === "unchanged", JSON.stringify(dA.counts));
  await ev(`document.getElementById('out').textContent = 'done', 1`);
  const dB = unwrap(await b.call("ui.diff", { tab, snapshot: snap2.snapshot }));
  // #out 是**普通 div**（无 role/label/value）——只扫语义元素会漏掉它，
  // 于是"点按钮改了状态"这种最典型的变化会被判成 unchanged。
  check("D-10 普通 div 的文本变化也抓得到（idle→done）",
    dB.verdict === "changed" && dB.changed_paths.some((p) => /idle/.test(JSON.stringify(p.from)) && /done/.test(JSON.stringify(p.to))),
    JSON.stringify(dB.changed_paths.filter((p) => /idle|done/.test(JSON.stringify(p))).slice(0, 2)));

  // D-11..D-14: 错误路径必须明确报错，绝不静默当作"没变化"
  check("D-11 不带 snapshot id → missing-snapshot",
    unwrap(await b.call("ui.diff", { tab })).error === "missing-snapshot");
  const badSnap = unwrap(await b.call("ui.snapshot", { tab, js: '(function(){throw new Error("boom")})()' }));
  check("D-12 快照表达式抛错 → 明确报错，而非变成空快照（空快照会让所有校验假绿）",
    badSnap.ok === false && /boom/.test(badSnap.error || ""), JSON.stringify(badSnap));
  const snap3 = unwrap(await b.call("ui.snapshot", { tab, js: 'window.__counter' }));
  check("D-13 跨 tab 比对被拒绝（否则会拿无关页面做对比，报出一堆假变化）",
    unwrap(await b.call("ui.diff", { tab: 999999, snapshot: snap3.snapshot })).error === "tab-mismatch");
  await b.call("ui.diff", { tab, snapshot: snap3.snapshot, forget: true });
  check("D-14 forget 后快照失效并明确报错",
    unwrap(await b.call("ui.diff", { tab, snapshot: snap3.snapshot })).error === "unknown-snapshot");

  // ===================== C. ui.capabilities =====================
  console.log("\n[C. ui.capabilities：这一页该怎么操作]");
  const cap = unwrap(await b.call("ui.capabilities", { tab }));
  check("C-01 探针返回 ok", cap.ok === true, cap.error || "");
  check("C-02 报出语义树规模与 role 分布",
    cap.tree && cap.tree.elements > 0 && Object.keys(cap.tree.roles || {}).length > 0,
    `elements=${cap.tree && cap.tree.elements}`);
  check("C-03 报出 canvas / iframe 情况",
    cap.canvas && typeof cap.canvas.top === "number" && Array.isArray(cap.iframes),
    `canvas.top=${cap.canvas && cap.canvas.top} iframes=${(cap.iframes || []).length}`);
  check("C-04 探到同源 iframe 并说明其规模",
    (cap.iframes || []).some((f) => f.sameOrigin && f.innerElements > 0),
    JSON.stringify((cap.iframes || [])[0] || null));
  check("C-05 给出路线建议，且每条都带理由与证据",
    cap.route && Array.isArray(cap.route.routes) && cap.route.routes.every((r) => r.why && r.evidence !== undefined),
    "recommended=" + JSON.stringify(cap.route && cap.route.recommended));
  check("C-06 建议里含那条通用纪律（每次写入都要 diff 证明）",
    /ui\.diff/.test((cap.route && cap.route.discipline) || ""), cap.route && cap.route.discipline);

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  b.close();
  server.close();
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { console.error("ERR", e.message, e.stack); process.exit(1); });
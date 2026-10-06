// e2e/capabilities_ws.cjs — Capability test suite over the live WS API.
// Self-contained: spawns Electron, serves local fixture pages (no network needed),
// and asserts five product capabilities an agent actually depends on:
//   A. text box manipulation (incl. CJK, long text, readonly/disabled/maxlength)
//   B. canvas — what the semantic tree does and does NOT give you
//   C. page source retrieval (outerHTML / head / by data-ai-id)
//   D. network capture — pulling response bodies by URL pattern
//   E. live DOM debugging edits showing up in the semantic tree
// Exits non-zero if any check fails.
//
// Run:  npm run capabilities
//       AI_BROWSER_PORT=<port> npm run capabilities

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
// 端口可配：默认 9223。启动 Electron 时必须把这个值传下去，否则浏览器仍监听 9223。
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures -------------------------------------------------------------

// A: every text-bearing flavour of input, plus readonly/disabled/maxlength.
// B: canvas drawn as a red rect (pixels only reachable via evaluate, not the tree).
// C: <title> + <meta> + a <p> addressable by data-ai-id.
const CAPS_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>CapabilitiesFixture</title>
<meta name="description" content="CAP-META-DESC-77">
</head><body>
<p id="dbgP">DBG-ORIGINAL</p>
<h1 id="hdr">CAP-HEADING</h1>
<input id="txt" type="text" placeholder="text box">
<input id="pwd" type="password">
<input id="num" type="number">
<textarea id="ta" rows="3"></textarea>
<div id="ce" contenteditable="true"></div>
<input id="ro" type="text" value="RO-ORIG" readonly>
<input id="dis" type="text" value="DIS-ORIG" disabled>
<input id="ml" type="text" maxlength="8">
<canvas id="cv" width="200" height="100"></canvas>
<script>
  (function(){
    var c = document.getElementById('cv');
    var x = c.getContext('2d');
    x.fillStyle = '#ff0000';
    x.fillRect(10, 10, 50, 20);
    window.__canvasReady = true;
  })();
</script>
</body></html>`;

// D: fires same-origin XHR/fetch traffic whose bodies we then pull by URL pattern.
const NET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NetFixture</title></head>
<body><p id="np">net fixture</p>
<script>
  window.__fire = function(u){ return fetch(u).then(function(r){ return r.text(); }); };
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p === "/api/alpha") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.end("ALPHA-PAYLOAD-1");
      }
      if (p === "/api/beta") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.end("BETA-PAYLOAD-2");
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Same strict CSP as the smoke fixture: no 'unsafe-eval', connect-src 'self'.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self';"
      );
      if (p === "/net") res.end(NET_PAGE);
      else res.end(CAPS_PAGE);
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
// 能力边界 / 事实记录：不计入 PASS/FAIL。
const note = (text) => console.log(`  NOTE | ${text}`);

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  // own the instance: fail if something already holds the port
  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run capabilities"
    );
    process.exit(3);
  } catch { /* free */ }

  const electronPath = require("electron");
  console.log("spawn electron @", electronPath, "port", WS_PORT);
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(WS_PORT) };
  // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动 —— 不起窗口、
  // 不监听 WS，测试永远等不到端口。这里要的是真正的应用进程，故剔除。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (process.env.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = process.env.AI_BROWSER_USER_DATA;
  const child = spawn(electronPath, ["."], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: childEnv,
  });
  await waitForPort(WS_PORT, 30000);
  console.log("WS ready on", WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();

  // ---- tree / DOM read helpers -------------------------------------------
  const treeOf = async (tab) => {
    const raw = await b.call("ui.get_tree", { tab });
    const r = (raw && raw.result) || {};
    return r.tree || r.root || r;
  };
  const findNode = (node, id) => {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const n of node) { const f = findNode(n, id); if (f) return f; }
      return null;
    }
    if (node && node.id === id) return node;
    if (node && node.children) return findNode(node.children, id);
    return null;
  };
  const nodeOf = async (tab, id) => findNode(await treeOf(tab), id);
  const treeVal = async (tab, id) => {
    const n = await nodeOf(tab, id);
    return n ? n.value : undefined;
  };
  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const domVal = (tab, id) => ev(`document.getElementById(${JSON.stringify(id)}).value`, tab);
  const domText = (tab, id) => ev(`document.getElementById(${JSON.stringify(id)}).innerText`, tab);
  const typeInto = (tab, id, text) => b.call("ui.act", { action: "type", target: id, params: { text }, tab });
  const clearInto = (tab, id) => b.call("ui.act", { action: "clear", target: id, tab });

  // =======================================================================
  // A. 文本框操作
  // =======================================================================
  console.log("\n[A. 文本框操作]");
  const capTab = (await b.call("ui.new_tab", { url: HOST + "/caps" })).result?.tab;
  await sleep(1600);
  await b.call("ui.get_tree", { tab: capTab }); // write data-ai-id into the live DOM

  const EN = "Hello-Agent-42";
  await typeInto(capTab, "txt", EN);
  await sleep(300);
  check("A-01 input[type=text] 英文写入 → tree.value 读回", (await treeVal(capTab, "txt")) === EN, JSON.stringify(await treeVal(capTab, "txt")));
  check("A-02 input[type=text] 英文写入 → 真实 DOM value 一致", (await domVal(capTab, "txt")) === EN, JSON.stringify(await domVal(capTab, "txt")));

  const CN = "你好世界";
  await typeInto(capTab, "txt", CN);
  await sleep(300);
  const a3 = await treeVal(capTab, "txt");
  check("A-03 input[type=text] 中文写入 → tree.value 读回", a3 === CN, JSON.stringify(a3));
  const a4 = await domVal(capTab, "txt");
  check("A-04 input[type=text] 中文写入 → 真实 DOM value 一致", a4 === CN, JSON.stringify(a4));

  await clearInto(capTab, "txt");
  await sleep(300);
  const a5 = await domVal(capTab, "txt");
  check("A-05 clear 后真实 DOM value 为空", a5 === "", JSON.stringify(a5));
  const a6 = await treeVal(capTab, "txt");
  check("A-06 clear 后 tree.value 为空/缺失", a6 === undefined || a6 === "", JSON.stringify(a6));

  await typeInto(capTab, "pwd", "密码ABC");
  await sleep(300);
  const a7 = await domVal(capTab, "pwd");
  check("A-07 input[type=password] 中文写入 → 真实 DOM value", a7 === "密码ABC", JSON.stringify(a7));
  check("A-08 input[type=password] 中文写入 → tree.value 读回", (await treeVal(capTab, "pwd")) === "密码ABC", JSON.stringify(await treeVal(capTab, "pwd")));

  await typeInto(capTab, "num", "12345");
  await sleep(300);
  const a9 = await domVal(capTab, "num");
  check("A-09 input[type=number] 数字写入 → 真实 DOM value", a9 === "12345", JSON.stringify(a9));
  check("A-10 input[type=number] 数字写入 → tree.value 读回", (await treeVal(capTab, "num")) === "12345", JSON.stringify(await treeVal(capTab, "num")));

  const taAct = await typeInto(capTab, "ta", "a\nb\nc");
  await sleep(400);
  const a11 = await domVal(capTab, "ta");
  check("A-11 textarea 多行写入 → 换行被保留（真实 DOM）", String(a11).indexOf("\n") >= 0 && String(a11).replace(/\n/g, "") === "abc", JSON.stringify(a11));
  const a12 = await treeVal(capTab, "ta");
  check("A-12 textarea 多行写入 → 换行被保留（tree.value）", String(a12).indexOf("\n") >= 0, JSON.stringify(a12));
  check("A-13 textarea 多行写入后 act 应如实报告换行没写进去（success 应为 false）", !(taAct && taAct.result && taAct.result.success === true), JSON.stringify(taAct && taAct.result));
  note("A-11..A-13 是真实能力缺口，不是断言写错：_inputViaCdp 按 '\\n' 切段后，段间换行用 "
    + "_cdpKey({key:'Enter'}) 发出（page_manager.js:782），而 _cdpKey 只发 rawKeyDown+keyUp 且 text:''"
    + "（page_manager.js:555-566），rawKeyDown 忽略 text —— textarea 因此拿不到换行，'a\\nb\\nc' 变成 'abc'。"
    + "而它的校验用 norm() 去掉了所有空白，所以照样 success:true 谎报成功（A-13）。"
    + "同一个 Enter 在原生 contenteditable 里同样不产生换行/分段（见 A-22）；smoke 里 ProseMirror 能分段，"
    + "是因为富文本框架自己接了 keydown 处理 Enter，不是本项目输入链路的功劳。"
    + "可行写法：把文本里的换行写成 \\r（A-14b / A-22b 均通过，浏览器归一为 \\n）—— "
    + "_inputViaCdp 只按 \\n 切段，\\r 会走逐字符键入并成功插入换行。");

  await typeInto(capTab, "ta", "中文多行\n第二行");
  await sleep(400);
  const a14 = await domVal(capTab, "ta");
  check("A-14 textarea 中文多行写入 → 真实 DOM value 保留换行", String(a14).indexOf("中文多行") >= 0 && String(a14).indexOf("\n") >= 0, JSON.stringify(a14));

  // 换行是否还有别的可行表达：改用 \r（_inputViaCdp 只按 \n 切段，\r 会走逐字符键入）
  await typeInto(capTab, "ta", "p\rq");
  await sleep(400);
  const a14b = String(await domVal(capTab, "ta") || "");
  check("A-14b 用 \\r 表达换行时 textarea 能否拿到换行（换行的替代写法探测）", a14b.indexOf("\n") >= 0 || a14b.indexOf("\r") >= 0, JSON.stringify(a14b));

  const LONG_TEXT = Array.from({ length: 1000 }, (_, i) => "abcdefghijklmnopqrstuvwxyz"[i % 26]).join("");
  const tLong0 = Date.now();
  await typeInto(capTab, "ta", LONG_TEXT);
  await sleep(500);
  console.log("  [timing] 1000 字符逐字符键入耗时 " + (Date.now() - tLong0) + "ms");
  const a15 = String(await domVal(capTab, "ta") || "");
  check("A-15 textarea 超长文本(1000) 写入 → 真实 DOM 长度正确", a15.length === 1000, "len=" + a15.length);
  const a16 = String(await treeVal(capTab, "ta") || "");
  check("A-16 textarea 超长文本 → tree.value 为前 200 字符（语义树对 value 截断到 200）",
    a16.length === 200 && LONG_TEXT.slice(0, 200) === a16, "len=" + a16.length);
  note("语义树 node.value 一律 slice(0,200)（preload/extractor.cjs:256）—— 超长文本必须靠 ui.evaluate 读完整值，不能只看树");

  await clearInto(capTab, "ta");
  await sleep(400);
  const a17 = await domVal(capTab, "ta");
  check("A-17 textarea clear 后真实 DOM 为空", a17 === "", JSON.stringify(a17));

  // 多行文本的可行路径（A-11/A-14 缺口的绕法）：直接 evaluate 赋值。
  await ev("(function(){var t=document.getElementById('ta');t.value='x\\ny\\nz';t.dispatchEvent(new Event('input',{bubbles:true}));return t.value;})()", capTab);
  await sleep(300);
  const a18 = String(await domVal(capTab, "ta") || "");
  check("A-18 绕法：ui.evaluate 直接赋值可写入带换行文本 → DOM 保留换行", a18 === "x\ny\nz", JSON.stringify(a18));
  check("A-19 绕法写入的换行在 tree.value 中也能读回", String(await treeVal(capTab, "ta")).indexOf("\n") >= 0, JSON.stringify(await treeVal(capTab, "ta")));
  await clearInto(capTab, "ta");
  await sleep(300);

  await typeInto(capTab, "ce", "可编辑中文");
  await sleep(400);
  const a20 = await domText(capTab, "ce");
  check("A-20 contenteditable 中文写入 → 真实 DOM innerText", String(a20).indexOf("可编辑中文") >= 0, JSON.stringify(a20));
  const a21 = await treeVal(capTab, "ce");
  check("A-21 contenteditable 中文写入 → tree.value 读回", String(a21).indexOf("可编辑中文") >= 0, JSON.stringify(a21));

  // 对照：同一个 Enter 在 contenteditable 里会生成块元素，段落结构是保留的
  await typeInto(capTab, "ce", "第一行\n第二行");
  await sleep(500);
  const a22 = String(await domText(capTab, "ce") || "");
  check("A-22 contenteditable 多行写入（\\n）→ 段落/换行保留", a22.indexOf("第一行") >= 0 && a22.indexOf("第二行") >= 0 && a22.indexOf("\n") >= 0, JSON.stringify(a22));
  await typeInto(capTab, "ce", "甲行\r乙行");
  await sleep(500);
  const a22b = String(await domText(capTab, "ce") || "");
  check("A-22b contenteditable 用 \\r 表达换行 → 换行/分段生效", a22b.indexOf("甲行") >= 0 && a22b.indexOf("乙行") >= 0 && a22b.indexOf("\n") >= 0, JSON.stringify(a22b));

  // readonly — 写入应无效
  const roBefore = await domVal(capTab, "ro");
  const roAct = await typeInto(capTab, "ro", "RO-NEW");
  await sleep(400);
  const roAfter = await domVal(capTab, "ro");
  check("A-23 readonly 输入框写入无效 → 真实 DOM 保持原值", roBefore === "RO-ORIG" && roAfter === "RO-ORIG", `${JSON.stringify(roBefore)} -> ${JSON.stringify(roAfter)}`);
  const roTree = await treeVal(capTab, "ro");
  check("A-24 readonly 输入框写入无效 → tree.value 保持原值", roTree === "RO-ORIG", JSON.stringify(roTree));
  check("A-25 readonly 写入被 act 如实报告为未生效", !(roAct && roAct.result && roAct.result.success === true), JSON.stringify(roAct && roAct.result));

  // disabled — 不可输入
  const disBefore = await domVal(capTab, "dis");
  const disAct = await typeInto(capTab, "dis", "DIS-NEW");
  await sleep(400);
  const disAfter = await domVal(capTab, "dis");
  check("A-26 disabled 输入框不可输入 → 真实 DOM 保持原值", disBefore === "DIS-ORIG" && disAfter === "DIS-ORIG", `${JSON.stringify(disBefore)} -> ${JSON.stringify(disAfter)}`);
  const disNode = await nodeOf(capTab, "dis");
  check("A-27 disabled 输入框在语义树中带 disabled 状态", !!(disNode && Array.isArray(disNode.states) && disNode.states.indexOf("disabled") >= 0), JSON.stringify(disNode && disNode.states));
  check("A-28 disabled 写入被 act 如实报告为未生效", !(disAct && disAct.result && disAct.result.success === true), JSON.stringify(disAct && disAct.result));

  // maxlength — 截断
  await typeInto(capTab, "ml", "12345678901234567890");
  await sleep(500);
  const mlDom = String(await domVal(capTab, "ml") || "");
  check("A-29 maxlength=8 截断 → 真实 DOM 长度为 8", mlDom.length === 8, "len=" + mlDom.length + " value=" + JSON.stringify(mlDom));
  const mlTree = String(await treeVal(capTab, "ml") || "");
  check("A-30 maxlength=8 截断 → tree.value 长度为 8", mlTree.length === 8, "len=" + mlTree.length + " value=" + JSON.stringify(mlTree));

  // =======================================================================
  // B. canvas —— 能力边界如实记录
  // =======================================================================
  console.log("\n[B. canvas]");
  const cvNode = await nodeOf(capTab, "cv");
  check("B-01 语义树能识别 canvas 节点", !!(cvNode && cvNode.role === "canvas"), cvNode ? `role=${cvNode.role} id=${cvNode.id}` : "node missing");
  const cvSize = await ev("(function(){var c=document.getElementById('cv');return c.width+'x'+c.height;})()", capTab);
  check("B-02 ui.evaluate 能读到 canvas 的 width/height", cvSize === "200x100", String(cvSize));
  const px = await ev("(function(){var c=document.getElementById('cv');var d=c.getContext('2d').getImageData(20,20,1,1).data;return d[0]+','+d[1]+','+d[2]+','+d[3];})()", capTab);
  check("B-03 ui.evaluate 用 getImageData 取到像素（红色矩形 rgba）", px === "255,0,0,255", String(px));
  const cvHasContent = !!(cvNode && (cvNode.value !== undefined || cvNode.text !== undefined || cvNode.editor_blocks !== undefined));
  check("B-04 语义树的 canvas 节点不含任何内容/像素字段（能力边界的正面证据）", !cvHasContent, JSON.stringify(cvNode));
  note("canvas 内容不在语义树中 —— 本项目不截图/OCR，canvas 只能靠 ui.evaluate 自行 getImageData 取像素；"
    + "语义树只告诉你“这里有一个 200x100 的 canvas”，读图内容必须由 agent 自己写 JS。");

  // =======================================================================
  // C. 网页源码获取
  // =======================================================================
  console.log("\n[C. 网页源码获取]");
  const html = String(await ev("document.documentElement.outerHTML", capTab) || "");
  check("C-01 evaluate 取 documentElement.outerHTML → 长度合理", html.length > 400, "len=" + html.length);
  check("C-02 outerHTML 含 fixture 特征字符串 CAP-HEADING", html.indexOf("CAP-HEADING") >= 0, "has=" + (html.indexOf("CAP-HEADING") >= 0));
  const ttl = await ev("document.title", capTab);
  check("C-03 取 <head> 的 title", ttl === "CapabilitiesFixture", JSON.stringify(ttl));
  const meta = await ev("(function(){var m=document.querySelector('meta[name=description]');return m?m.content:null;})()", capTab);
  check("C-04 取 <head> 的 meta[name=description]", meta === "CAP-META-DESC-77", JSON.stringify(meta));
  // 先 get_tree 拿 data-ai-id，再用它定位并取 outerHTML
  const hdrNode = await nodeOf(capTab, "hdr");
  const hdrId = hdrNode && hdrNode.id;
  check("C-05 get_tree 拿到标题元素的 data-ai-id", !!hdrId, JSON.stringify(hdrId));
  const hdrHtml = String(await ev(
    `(function(){var e=document.querySelector('[data-ai-id="' + ${JSON.stringify(hdrId)} + '"]');return e?e.outerHTML:null;})()`,
    capTab) || "");
  check("C-06 用 data-ai-id 定位并取该元素 outerHTML", hdrHtml.indexOf("CAP-HEADING") >= 0 && hdrHtml.indexOf("<h1") >= 0, JSON.stringify(hdrHtml).slice(0, 120));

  // =======================================================================
  // D. 抓包分析（按 URL 模式拉 body）
  // =======================================================================
  console.log("\n[D. 抓包分析 — 按 URL 模式拉响应 body]");
  const netTab = (await b.call("ui.new_tab", { url: HOST + "/net" })).result?.tab;
  await sleep(1500);
  const netEvents = [];
  b.on("network_response", (d) => { if (d) netEvents.push(d); });
  await b.call("ui.subscribe", { events: ["network_response"] });
  await sleep(400);

  await ev("(function(){fetch('/api/alpha');return 'sent';})()", netTab);
  await sleep(1500);
  const alphaHits = netEvents.filter((e) => String(e.url).indexOf("/api/alpha") >= 0);
  check("D-01 订阅后收到 /api/alpha 的 network_response 事件", alphaHits.length >= 1, "events=" + alphaHits.length);
  const bodyAlpha = (await b.call("ui.network_body", { url_pattern: "/api/alpha", tab: netTab }))?.result?.body;
  check("D-02 network_body 按 URL 片段拉到 alpha 的 body", bodyAlpha === "ALPHA-PAYLOAD-1", JSON.stringify(bodyAlpha));

  await ev("(function(){fetch('/api/beta');return 'sent';})()", netTab);
  await sleep(1500);
  const betaHits = netEvents.filter((e) => String(e.url).indexOf("/api/beta") >= 0);
  check("D-03 收到 /api/beta 的 network_response 事件", betaHits.length >= 1, "events=" + betaHits.length);
  const bodyBeta = (await b.call("ui.network_body", { url_pattern: "/api/beta", tab: netTab }))?.result?.body;
  check("D-04 network_body 按 URL 片段拉到 beta 的 body", bodyBeta === "BETA-PAYLOAD-2", JSON.stringify(bodyBeta));

  const bodyAlpha2 = (await b.call("ui.network_body", { url_pattern: "/api/alpha", tab: netTab }))?.result?.body;
  check("D-05 多个请求按不同 URL 片段各自命中，互不串台",
    bodyAlpha2 === "ALPHA-PAYLOAD-1" && bodyBeta === "BETA-PAYLOAD-2",
    "alpha=" + JSON.stringify(bodyAlpha2) + " beta=" + JSON.stringify(bodyBeta));
  const bodyNone = (await b.call("ui.network_body", { url_pattern: "/api/nope-does-not-exist", tab: netTab }))?.result?.body;
  check("D-06 无匹配的 URL 片段返回 null（不误命中其它请求）", bodyNone === null || bodyNone === undefined, JSON.stringify(bodyNone));

  // =======================================================================
  // E. 网页调试修改（DOM 改写在语义树里真的生效）
  // =======================================================================
  console.log("\n[E. 网页调试修改]");
  const eBefore = await nodeOf(capTab, "dbgP");
  check("E-00 修改前语义树能读到目标段落", !!(eBefore && String(eBefore.label).indexOf("DBG-ORIGINAL") >= 0), JSON.stringify(eBefore && eBefore.label));
  await ev("(function(){document.getElementById('dbgP').textContent='DBG-NEW-TEXT';return document.getElementById('dbgP').textContent;})()", capTab);
  await sleep(300);
  const eAfter = await nodeOf(capTab, "dbgP");
  check("E-01 evaluate 改文本 → get_tree 读回新文本", !!(eAfter && String(eAfter.label).indexOf("DBG-NEW-TEXT") >= 0), JSON.stringify(eAfter && eAfter.label));

  await ev("(function(){var p=document.createElement('p');p.id='dbgNew';p.textContent='DBG-INSERTED';document.body.appendChild(p);return p.id;})()", capTab);
  await sleep(300);
  const eIns = await nodeOf(capTab, "dbgNew");
  check("E-02 evaluate 插入新元素 → get_tree 读到新节点", !!(eIns && String(eIns.label).indexOf("DBG-INSERTED") >= 0), JSON.stringify(eIns && eIns.label));

  await ev("(function(){document.getElementById('dbgP').style.display='none';return document.getElementById('dbgP').style.display;})()", capTab);
  await sleep(300);
  const eHidden = await nodeOf(capTab, "dbgP");
  check("E-03 evaluate 改样式 display:none → 该元素从语义树中消失", eHidden === null, eHidden ? "still present: " + JSON.stringify(eHidden.label) : "absent (as expected)");

  await ev("(function(){document.getElementById('dbgP').style.display='';return document.getElementById('dbgP').style.display;})()", capTab);
  await sleep(300);
  const eBack = await nodeOf(capTab, "dbgP");
  check("E-04 恢复 display → 该元素重新出现在语义树中", !!eBack, eBack ? JSON.stringify(eBack.label) : "absent");
  note("语义树的可见性以实时 DOM 为准（isHidden 检查 computed style）—— DOM 改写后无需刷新，重新 get_tree 即反映新状态。");

  console.log("\n==== capabilities PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("capabilities error:", e && e.stack ? e.stack : e.message); process.exit(2); });
setTimeout(() => { console.error("capabilities TIMEOUT"); process.exit(2); }, GLOBAL_TIMEOUT_MS);

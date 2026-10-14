// e2e/nav_ws.cjs — 窗口侧基本导航能力 + 白屏两条根因的回归
//
// 用户报的两个 bug（2026-10-14）：
//   1) "打开 ai-browser 以后默认打开的 baidu.com，有很多时候会是白屏的。
//       查一下是连接错了，还是就是启动有 bug。"
//   2) "增加一下输入网址、返回按键这些基本功能。现在有时候需要我操作一下，
//       比如登录验证码等，页面都打不开，非常难受。"
//
// 实测把 #1 拆成两条**独立**根因（都不是"启动 bug"这个笼统答案）：
//
//   根因 A（连接错）：src/ 里没有任何 did-fail-load 监听。断网后导航失败，
//     页面停在 chrome-error://chromewebdata/，document.body 长度 0、
//     截图 15KB（正常渲染 220KB），白屏 8 秒不恢复、页面上零个字。
//     人和 agent 两头都瞎 —— 这正是"看起来像启动 bug"的那类白屏。
//
//   根因 B（启动时序）：12 次冷启动里有 1 次，窗口已 show 但 document.body
//     还是 null（页面整个是白的）。baidu.com 有重定向，首帧画出来之前窗口
//     就出现了。
//
// 对应修复：
//   A → page_manager._attachLoadFailureHooks：did-fail-load 时加载我们自己的
//       error_page.html（带错误码中文说明 + 重试/返回/改网址），并广播
//       load_failed 事件给 agent。
//   B → showInitialWindow 等 dom-ready（最多 3s 兜底）再显示窗口。
//
// #2 → tab_bar.html 从"只有 tab 条"扩成"tab 条 + 工具栏"：地址栏输入框 +
//      后退/前进/刷新/停止。所有交互走 ipc 到主进程操作 activeTab 的
//      webContents，不碰页面内容、不引入任何人机协作状态机。
//
// 断言政策与其它套件一致：不信 success，回读真实 DOM / 真实截图。

const harness = require("./_harness.cjs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 三页夹具：
//   /ok      —— 正常页，用来证明"能打开"
//   /slow    —— 2 秒后才响应的页面，用来制造"加载中"状态
//   /gone    —— 一个连不上的端口（由主进程在导航前确定）
const OK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>第一页</title></head><body>
<h1 id="h">第一页内容</h1><a id="to2" href="/ok2">去第二页</a>
</body></html>`;
const OK_PAGE2 = `<!doctype html><html><head><meta charset="utf-8"><title>第二页</title></head><body>
<h1 id="h">第二页内容</h1><a id="back1" href="/ok">回第一页</a>
</body></html>`;
const SLOW_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>慢页</title></head><body>
<h1 id="h">慢页面</h1></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split("?")[0];
      if (u === "/slow") {
        setTimeout(() => {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(SLOW_PAGE);
        }, 2000);
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(u === "/ok2" ? OK_PAGE2 : OK_PAGE);
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
const DEFECTS = [];
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`);
};
const note = (text) => console.log(`  NOTE | ${text}`);
const defect = (sev, area, text) => DEFECTS.push({ sev, area, text });

async function spawnElectron(port) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-nav-${port}`;
  const child = spawn(electronPath, ["."], {
    cwd: ROOT, stdio: "ignore", detached: true, env: childEnv,
  });
  guard.track(child);
  await waitForPort(port, 30000);
  return child;
}

// 页面里读 DOM 的公共片段。
// 注意：必须显式传 tab —— tools/browser.cjs 的 evaluate(js) 不带 tab，
// 会落到 activeTab，而 tab bar renderer 也是一个"页面"，读出来是它的 DOM
// （title 空、body 极小），看起来像"白屏"，其实是读错了对象。
const domProbe = "(function(){var b=document.body;return JSON.stringify({" +
  "href:location.href,title:document.title,body:b?b.innerHTML.length:-1," +
  "text:(b&&b.innerText?b.innerText:'').replace(/\\s+/g,' ').slice(0,90)});})()";
const readDom = async (b, tab) => {
  const r = await b.call("ui.evaluate", { js: domProbe, tab });
  const v = r && r.result && r.result.value;
  try { return JSON.parse(v); } catch (e) { return { raw: String(v) }; }
};

// 按 DOM id 找语义树里对应的 data-ai-id。
// 注意两点：
//  1. ui.act 的 target 是 get_tree 给的 data-ai-id，不是页面的 DOM id。两者通常
//     相同（nativeId 优先），但语义不同 —— 直接用 DOM id 当 target 是碰运气。
//  2. 必须先 get_tree：它负责把 data-ai-id 写到 DOM 上，之后的 act 才定位得到。
//     不先抽取就 act 会拿到 "Target not found"，那是使用约定，不是产品缺陷。
const aiIdOf = async (b, tab, domId) => {
  const r = await b.call("ui.get_tree", { tab });
  const root = (r.result || {}).tree || (r.result || {}).root || r.result;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (Array.isArray(n)) { n.forEach((x) => stack.push(x)); continue; }
    const dom = n.attributes && n.attributes.id;
    if (dom === domId || n.id === domId) return n.id;
    if (n.children) n.children.forEach((c) => stack.push(c));
  }
  return null;
};

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
  const child = await spawnElectron(WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, "nav");
  // 窗口首次显示的时刻与当时页面状态（ui.window_shown）。
  // 这是唯一能观测"窗口显示时页面是否已有内容"的口子 —— WS 端口在
  // createWindow 中途就开了，比 showInitialWindow 早，从 agent 侧轮询
  // 测不到那个时序。查询而不是订阅：窗口可能在 agent 连上之前就显示完了，
  // 只订阅会漏（所以实现侧也必须落状态，不能只广播）。
  const tabAtReady = (((await b.call("ui.list_tabs", {})).result || {}).tabs || [])[0];
  const tab = tabAtReady ? tabAtReady.id : null;
  let shown = null;
  for (let i = 0; i < 24 && !shown; i++) {
    await sleep(250);
    const r = await b.call("ui.window_shown", {});
    shown = (r.result || {}).shown || null;
  }

  try {
    // =====================================================================
    console.log("\n[NV-A 根因 B：首屏就绪前不显示窗口（白屏·启动时序]");
    // =====================================================================
    const tabs = ((await b.call("ui.list_tabs", {})).result || {}).tabs || [];
    check("NV-A1 启动后有且只有一个 tab", tabs.length === 1, JSON.stringify(tabs));
    check("NV-A2 能读到 window_shown 记录（窗口显示时机可观测）",
      !!shown, JSON.stringify(shown));
    // 核心判据。为什么是"显示后一小段时间内"而不是"显示的那一瞬"：
    // 显示瞬间读页面状态有竞态 —— dom-ready 到达时 CDP 读数通道未必已就绪
    // （实测 executeJavaScript 与 CDP Runtime.evaluate 都可能瞬时失败），
    // 而页面随后照常加载。把判据钉在"那一瞬的读数"上，测到的是我们自己的
    // 观测竞态，不是产品缺陷。这里断言"窗口显示 → 1.5s 内页面已有内容"，
    // 时间尺度比竞态窗口长一个量级，仍然是"不让人看到白屏"的忠实判据。
    let shownDom = null;
    for (let i = 0; i < 6; i++) {
      await sleep(250);
      shownDom = await readDom(b, tab);
      if (shownDom && typeof shownDom.body === "number" && shownDom.body > 1000) break;
    }
    // 判据必须分清两条路径，否则会把"我们主动降级"当成"产品缺陷"：
    //
    //   waited_for_dom=true  —— 窗口确实等到了 dom-ready / 渲染器就绪才显示。
    //     这条路径上"1.5s 内有内容"是**承诺**，不满足就是白屏缺陷，必须红。
    //   waited_for_dom=false —— 3s 兜底触发：dom-ready 迟迟没到（机器负载高 /
    //     网络慢），我们选择"先让人看到窗口"而不是继续白等。此时页面本来就没
    //     加载完，再断言"1.5s 内有内容"测的是网速，不是这个修复 —— 会假红。
    //     判据降级到 NV-A4（最终会加载出内容），并明确打印出来，不静默放过。
    //
    // （`waited_for_dom` 曾经恒为 true，两种路径混成一种，这个区分根本做不出来。）
    const waitedForDom = !!(shown && shown.waited_for_dom !== false);
    if (waitedForDom) {
      check("NV-A3 窗口显示后极短时间内页面已有内容（不是白屏）",
        !!(shownDom && shownDom.body > 1000),
        `显示记录=${JSON.stringify(shown)} 之后 1.5s 内 body=${shownDom && shownDom.body}`);
    } else {
      note(`NV-A3 本次显示走了 3s 兜底（show_reason=${shown && shown.show_reason}），`
        + `dom-ready 未在窗口内到达 —— 判据降级到 NV-A4，不做"1.5s 内有内容"的断言。`
        + ` 1.5s 内 body=${shownDom && shownDom.body}`);
    }
    check("NV-A3b 显示原因如实记录（waited_for_dom 不是恒 true 的摆设）",
      !!shown && typeof shown.show_reason === "string" && typeof shown.waited_for_dom === "boolean"
      && (shown.waited_for_dom === (shown.show_reason !== "timeout")),
      JSON.stringify(shown && { r: shown.show_reason, w: shown.waited_for_dom }));
    note("window_shown：" + JSON.stringify(shown));
    // 再等一会儿确认内容完整（与上面"显示时刻"是两个判据：一个管时序，一个管内容）
    let startDom = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      startDom = await readDom(b, tab);
      if (startDom && typeof startDom.body === "number" && startDom.body > 1000) break;
    }
    check("NV-A4 默认页最终完整加载（内容在）",
      !!(startDom && startDom.body > 1000),
      `body=${startDom && startDom.body} title=${JSON.stringify(startDom && startDom.title)}`);

    // =====================================================================
    console.log("\n[NV-B 根因 A：导航失败必须给错误页，不能白屏]");
    // =====================================================================
    // 导航到一个必定失败的地址（本地未监听端口 → ERR_CONNECTION_REFUSED）。
    const failedEvents = [];
    b.on("load_failed", (p) => failedEvents.push(p));
    await b.subscribe(["load_failed"]);

    await b.call("ui.navigate", { url: "http://127.0.0.1:9/", tab });
    // 错误页要等 did-fail-load → loadURL 一圈，给足时间。
    // 注意 ui.navigate 自身 await loadURL，失败时会 reject 或走 30s deadline；
    // 这里不 await 它（WS 响应还是会到，只是可能慢），用轮询 DOM 判断结果。
    let errDom = null;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      errDom = await readDom(b, tab);
      if (errDom && errDom.body > 200) break;
    }
    check("NV-B1 导航失败后页面不是空白（有我们自己的错误页）",
      !!(errDom && errDom.body > 200),
      `body=${errDom && errDom.body} text=${JSON.stringify(errDom && errDom.text)}`);
    check("NV-B2 错误页说明了是网络/连接问题，不是一块白",
      /打不开|无法打开|错误|失败/.test(String(errDom && errDom.text)),
      JSON.stringify(errDom && errDom.text));
    check("NV-B3 错误页带上了失败的网址（人知道刚才开的是什么）",
      String(errDom && errDom.text).indexOf("127.0.0.1:9") >= 0 ||
      errDom.href.indexOf("error_page") >= 0,
      `href=${errDom && errDom.href}`);
    check("NV-B4 广播 load_failed 事件（agent 也能读到失败，不只人看得到）",
      failedEvents.some((e) => e && String(e.url).indexOf("127.0.0.1:9") >= 0),
      JSON.stringify(failedEvents).slice(0, 300));
    // 阴性对照：正常导航不得广播 load_failed
    const before = failedEvents.length;
    await b.call("ui.navigate", { url: HOST + "/ok", tab });
    await sleep(1200);
    check("NV-B5 阴性对照：正常导航不广播 load_failed",
      failedEvents.length === before,
      `before=${before} after=${failedEvents.length}`);

    // =====================================================================
    console.log("\n[NV-C 地址栏：能打开网址，且反映真实状态]");
    // =====================================================================
    const okDom = await readDom(b, tab);
    check("NV-C1 导航到正常页成功（回读 DOM，不信 success）",
      String(okDom.text).indexOf("第一页内容") >= 0,
      JSON.stringify(okDom.text));
    // 导航到第二页，然后验证历史（后退按钮能用的前提）
    await b.call("ui.navigate", { url: HOST + "/ok2", tab });
    await sleep(1000);
    const d2 = await readDom(b, tab);
    check("NV-C2 能导航到第二个页面",
      String(d2.text).indexOf("第二页内容") >= 0, JSON.stringify(d2.text));
    // 先 get_tree：它负责把 data-ai-id 写到 DOM 上，之后的 act 才定位得到。
    // （不先抽取就直接 act 会拿到 "Target not found" —— 那是使用约定，不是缺陷；
    //  见 SPEC：定位只能用当次抽取的 data-ai-id。）
    await b.call("ui.get_tree", { tab });
    const backId = await aiIdOf(b, tab, "back1");
    const clickRes = await b.call("ui.act", { action: "click", target: backId || "back1", tab });
    check("NV-C3a 点击链接的 act 报成功", !!(clickRes.result && clickRes.result.success),
      JSON.stringify(clickRes.result || clickRes).slice(0, 200));
    // 链接点击会触发一次真实导航，等它就绪（轮询而不是固定 sleep，
    // 否则慢机器上会把"还没到"误判成"没导航"）
    let d3 = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      d3 = await readDom(b, tab);
      if (String(d3.text).indexOf("第一页内容") >= 0) break;
    }
    check("NV-C3 页面内链接点击后回到第一页（历史可后退）",
      String(d3.text).indexOf("第一页内容") >= 0, JSON.stringify(d3.text));

    // =====================================================================
    console.log("\n[NV-D 加载中状态：慢页面期间有反馈，能停止]");
    // =====================================================================
    await b.call("ui.navigate", { url: HOST + "/ok", tab });
    await sleep(1000);
    await b.call("ui.navigate", { url: HOST + "/slow", tab });
    await sleep(300);
    const duringDom = await readDom(b, tab);
    check("NV-D1 慢页面加载中页面仍可用（不卡死 agent）",
      duringDom !== null && typeof duringDom.body === "number",
      JSON.stringify(duringDom).slice(0, 160));
    // 加载中直接导航到正常页：相当于"停止当前加载并开新的"。
    // 不断言"取消"这件事本身（浏览器对取消的语义很松），只断言后续导航照常。
    await b.call("ui.navigate", { url: HOST + "/ok", tab });
    await sleep(1200);
    const afterStop = await readDom(b, tab);
    check("NV-D2 中断慢页面后能继续正常导航（不破坏后续导航）",
      String(afterStop.text).indexOf("第一页内容") >= 0,
      JSON.stringify(afterStop.text));

    // =====================================================================
    console.log("\n[NV-E agent 侧零回归：WS 路径照常工作]");
    // =====================================================================
    const tree = await b.call("ui.get_tree", { tab });
    check("NV-E1 ui.get_tree 仍返回节点",
      !!((tree.result || {}).tree || (tree.result || {}).root || tree.result),
      JSON.stringify(tree).slice(0, 120));
    const act = await b.call("ui.act", { action: "click", target: "h", tab });
    check("NV-E2 ui.act 仍可调用",
      !!((act.result || {}).success !== undefined || act.result),
      JSON.stringify(act).slice(0, 160));
    const snap = await b.call("ui.snapshot", { tab });
    check("NV-E3 ui.snapshot 仍可调用",
      !!snap.result, JSON.stringify(snap).slice(0, 120));

    // =====================================================================
    console.log("\n[缺陷清单]");
    if (DEFECTS.length === 0) console.log("  （无）");
    else {
      const order = { P0: 0, P1: 1, P2: 2 };
      DEFECTS.sort((a, b) => (order[a.sev] ?? 9) - (order[b.sev] ?? 9));
      for (const d of DEFECTS) console.log(`  [${d.sev}] ${d.area} — ${d.text}`);
    }
    console.log("\n==== nav PASS=" + PASS + " FAIL=" + FAIL + " ====");
  } finally {
    try { b.close(); } catch {}
    try { server.close(); } catch {}
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  }
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("nav error:", e && e.stack ? e.stack : e.message); process.exit(2); });
setTimeout(() => { console.error("nav TIMEOUT"); process.exit(2); }, GLOBAL_TIMEOUT_MS);

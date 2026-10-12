// e2e/audit_ws.cjs — 功能点审计：把 10 个既有套件**没有覆盖到**的 WS 面逐个实测。
//
// 背景：既有套件按"能力"组织（ Richtext / canvas / network …），覆盖很厚，但覆盖矩阵
// 是按能力画的，不是按方法画的。按方法一对照就发现三个洞：
//   ui.get_focused  —— 零 e2e
//   ui.downloads    —— 只有单测（DLM），没有一次真实下载走过全链路
//   ui.quit         —— 零覆盖
// 另外有三个动作在语义树里**广告**了、却从没被任何 e2e 调用过：
//   setContent / focus / scroll_to
// 以及 ui.wait 的四个 condition 里三个没测过。
//
// 断言政策与本项目其它套件一致：操作类断言一律回读真实 DOM / 真实文件系统，
// 不信 act 自己报的 success；每条"应该收不到"都配阳性对照。
//
// Run:  npm run audit
//       AI_BROWSER_PORT=<port> npm run audit

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 240000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 夹具：一个页面装下所有待测面。
//   - 三种可写控件（input / textarea / contenteditable）→ setContent
//   - 尽可能多的 role（含 dialog / combobox / menu / tab / switch / spinbutton …）
//     → AU-A 要当"虚假广告"的通用检查用，角色越全越能抓到来者
//   - input[type=range] → role=slider → 广告 ["scroll_to","focus"]
//   - 一个真表单 → submit 动作
//   - /download 端点 + <a download> → 真实下载链路
//   - 3000px 的占位 + 深处的按钮 → scroll_to
const AUDIT_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>AuditFixture</title>
<style>body{margin:0}#dlg{border:1px solid #333;padding:8px}#spacer{height:3000px}
[draggable="true"]{cursor:grab;border:1px dashed #999;padding:4px}</style>
</head><body>
<h2>audit</h2>
<div class="row"><label for="ti">文本</label><input id="ti" type="text" value=""></div>
<div class="row"><label for="ta">多行</label><textarea id="ta"></textarea></div>
<div id="ce" contenteditable="true" style="border:1px solid #999;min-height:40px"></div>
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<input id="rng" type="range" min="0" max="10" value="3">
<input id="fi" type="file">
<input id="ck" type="checkbox"><input id="rd" type="radio" name="r">
<div role="dialog" id="dlg"><p>对话框内容</p><button id="dlgBtn" type="button">知道了</button></div>
<dialog id="natDlg"><p>原生对话框</p><button id="natDlgBtn">好</button></dialog>
<div role="combobox" id="cb" tabindex="0">组合框</div>
<div role="listbox" id="lb"><div role="option" id="op1">选项一</div></div>
<div role="menu" id="mn"><div role="menuitem" id="mi1">菜单项</div></div>
<div role="tablist" id="tl"><div role="tab" id="tb1">标签一</div></div>
<div role="tree" id="tr"><div role="treeitem" id="ti1">树项</div></div>
<div role="grid" id="gr"><div role="row" id="rw1"><div role="gridcell" id="gc1">格子</div></div></div>
<div role="switch" id="sw">开关</div>
<div role="spinbutton" id="sp" tabindex="0">微调</div>
<div role="searchbox" id="sb">搜索</div>
<div id="dragMe" draggable="true">可拖拽</div>
<div id="clickMe" style="cursor:pointer">可点击</div>
<button id="btn" type="button">普通按钮</button>
<a id="lnk" href="#x">链接</a>
<form id="fm"><input id="fmin"><button id="fmsub" type="submit">提交表单</button></form>
<p id="out">未提交</p>
<a id="dl" href="/download" download>下载文件</a>
<div id="spacer"></div>
<button id="deepBtn" type="button" style="margin-top:2500px">深处按钮</button>
<button id="lateBtn" type="button" disabled>晚点生效</button>
<script>
  document.getElementById('fm').addEventListener('submit', function (e) {
    e.preventDefault();
    document.getElementById('out').textContent = '已提交:' + document.getElementById('fmin').value;
  });
  setTimeout(function () { document.getElementById('lateBtn').disabled = false; }, 1200);
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf("/download") === 0) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="audit-download.txt"');
        res.end("audit download payload\n");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(AUDIT_PAGE);
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
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${port}`;
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

  try {
    await waitForPort(WS_PORT, 600);
    console.error("!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run audit");
    process.exit(3);
  } catch { /* free */ }

  console.log("spawn electron port", WS_PORT);
  const child = await spawnElectron(WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();

  const rawTree = (tab) => b.call("ui.get_tree", { tab });
  const treeOf = async (tab) => {
    const raw = await rawTree(tab);
    const r = (raw && raw.result) || {};
    return (r.tree || r.root || r);
  };
  const ctxOf = async (tab) => {
    const raw = await rawTree(tab);
    return (raw && raw.result && raw.result.context) || null;
  };
  const findNode = (node, pred) => {
    if (!node) return null;
    if (Array.isArray(node)) { for (const n of node) { const f = findNode(n, pred); if (f) return f; } return null; }
    if (pred(node)) return node;
    if (node.children) return findNode(node.children, pred);
    return null;
  };
  const byId = async (tab, id) => findNode(await treeOf(tab), (n) => n.id === id);
  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const act = (action, target, params, tab) =>
    b.call("ui.act", { action, target, params: params || {}, tab });

  try {
    const tab = (await b.call("ui.new_tab", { url: HOST + "/audit" })).result?.tab;
    await b.call("ui.set_active_tab", { tab });
    await sleep(2000);

    // =====================================================================
    console.log("\n[AU-A 语义树广告的每一个动作都必须真实存在（反虚假广告）]");
    // =====================================================================
    // 这不是"dialog 专项"，而是一条通用规则：**树广告的每个动作，调用时都不得拿到
    // "Unknown action"**。夹具因此铺了尽可能多的 role。历史上 dialog 广告了
    // ["open","close"] 而两边执行器都没有这两个 case，agent 照着做必然失败。
    const tree = await treeOf(tab);
    const nodes = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      nodes.push(n);
      if (n.children) n.children.forEach(walk);
    };
    walk(tree);
    const advertised = new Set();
    for (const n of nodes) for (const a of (n.actions || [])) advertised.add(a);
    note("本页 " + nodes.length + " 个节点广告到的动作集合：" + JSON.stringify([...advertised].sort()));

    // 逐个调用：每个广告动作各找第一个广告它的节点来执行。
    // 只断言"不是 Unknown action" —— 成功与否取决于页面状态，不是这一条要判的。
    const phantom = [];
    for (const a of [...advertised].sort()) {
      const host = nodes.find((n) => (n.actions || []).indexOf(a) >= 0);
      if (!host) continue;
      let r = null;
      try { r = (await act(a, host.id, a === "type" || a === "setContent" ? { text: "x" } : {}, tab)).result || {}; }
      catch (e) { r = { error: String(e && e.message || e) }; }
      if (String(r.error || "").indexOf("Unknown action") >= 0) phantom.push(a + "@" + host.id);
    }
    check("AU-A1 广告集合里的每个动作都真的能调用（不得出现 Unknown action）",
      phantom.length === 0, phantom.length ? "虚假广告：" + JSON.stringify(phantom) : "全部可调用");

    const dlgNode = nodes.find((n) => n.role === "dialog");
    check("AU-A2 树里能找到 role=dialog 节点（否则这一条无从测）",
      !!dlgNode, dlgNode ? "id=" + dlgNode.id + " actions=" + JSON.stringify(dlgNode.actions) : "absent");
    // 曾经这里广告 ["open","close"]。修法不是去实现 open/close，而是不再广告：
    // "打开/关闭一个对话框"没有通用实现（真 <dialog> 有 showModal/close，
    // <div role=dialog> 只能点它里面的按钮 —— 那是猜），而弹窗里真正能点的按钮
    // 本身就带 ["click","focus"]，所以给空数组不损失任何能力。
    check("AU-A3 dialog 节点不再广告 open/close（宁可少报，绝不猜一个假动作）",
      !!dlgNode && !(dlgNode.actions || []).some((a) => a === "open" || a === "close"),
      dlgNode ? "actions=" + JSON.stringify(dlgNode.actions) : "no dialog node");

    // slider 广告 scroll_to；textbox 广告 focus。这两个动作实现了（走 preload 回退），
    // 但从没被任何 e2e 调用过 —— 这里补上，并且**回读真实效果**。
    const rngNode = await byId(tab, "rng");
    const scrollRes = rngNode ? ((await act("scroll_to", rngNode.id, {}, tab)).result || {}) : null;
    check("AU-A4 slider 广告的 scroll_to 可调用（不报 Unknown action）",
      !!(scrollRes && String(scrollRes.error || "").indexOf("Unknown action") < 0),
      JSON.stringify(scrollRes));
    const tiNode = await byId(tab, "ti");
    const focusRes = tiNode ? ((await act("focus", tiNode.id, {}, tab)).result || {}) : null;
    check("AU-A5 textbox 广告的 focus 可调用（不报 Unknown action）",
      !!(focusRes && String(focusRes.error || "").indexOf("Unknown action") < 0),
      JSON.stringify(focusRes));
    // 阳性对照：确实实现了的动作
    const btnNode = await byId(tab, "btn");
    const clickRes = btnNode ? ((await act("click", btnNode.id, {}, tab)).result || {}) : null;
    check("AU-A6 阳性对照：click 返回 success",
      !!(clickRes && clickRes.success === true), JSON.stringify(clickRes));

    // =====================================================================
    console.log("\n[AU-B ui.get_focused]");
    // =====================================================================
    await act("click", "ti", {}, tab);
    await sleep(300);
    // 阳性对照：先证明焦点**确实**在那个输入框上（观测手段有效），
    // 否则 get_focused 返回 null 可以推给"根本没 focus 上"。
    const activeId = await ev("(function(){return document.activeElement?document.activeElement.id:null;})()", tab);
    check("AU-B1 阳性对照：点击后 document.activeElement 就是 ti",
      activeId === "ti", "activeElement.id=" + JSON.stringify(activeId));
    const focused = (await b.call("ui.get_focused", { tab })).result;
    check("AU-B2 ui.get_focused 返回当前焦点元素的 id",
      focused === "ti", "get_focused=" + JSON.stringify(focused) + " (activeElement.id=" + JSON.stringify(activeId) + ")");
    if (focused !== "ti") {
      defect("P1", "ui.get_focused",
        "ui.get_focused 恒返回 null。实现读 result.tree.focused_element_id，而 extractor.cjs "
        + "从不产出这个字段（全仓库只有 page_manager.js 一处引用它）—— 语义树里焦点信息只在"
        + "节点自己的 states:[...,\"focused\"] 里，从没汇总到根上。");
    }
    const focusedNoTab = (await b.call("ui.get_focused", {})).result;
    check("AU-B3 ui.get_focused 不传 tab 时用当前活动 tab（同样返回 ti）",
      focusedNoTab === "ti", "get_focused=" + JSON.stringify(focusedNoTab));

    // =====================================================================
    console.log("\n[AU-C 从没被 e2e 调用过的动作：setContent / focus / scroll_to / submit]");
    // =====================================================================
    const sc1 = (await act("setContent", "ti", { text: "写入输入框" }, tab)).result || {};
    await sleep(200);
    const tiVal = await ev("(function(){return document.getElementById('ti').value;})()", tab);
    check("AU-C1 setContent 写 input → 真实 DOM value 生效",
      String(sc1.success) === "true" && tiVal === "写入输入框",
      "act=" + JSON.stringify(sc1) + " dom.value=" + JSON.stringify(tiVal));

    const sc2 = (await act("setContent", "ce", { text: "写入编辑器" }, tab)).result || {};
    await sleep(200);
    const ceText = await ev("(function(){return document.getElementById('ce').innerText;})()", tab);
    check("AU-C2 setContent 写 contenteditable → 真实 DOM 文本生效",
      String(sc2.success) === "true" && String(ceText).indexOf("写入编辑器") >= 0,
      "act=" + JSON.stringify(sc2) + " dom.text=" + JSON.stringify(ceText));

    await act("focus", "ta", {}, tab);
    await sleep(200);
    const activeAfterFocus = await ev("(function(){return document.activeElement?document.activeElement.id:null;})()", tab);
    check("AU-C3 focus 动作 → document.activeElement 真的是目标（不信 success）",
      activeAfterFocus === "ta",
      "act 报 success 且 activeElement.id=" + JSON.stringify(activeAfterFocus) + "（应为 ta）");

    await ev("(function(){window.scrollTo(0,0);})()", tab);
    await sleep(200);
    const y0 = await ev("(function(){return window.scrollY;})()", tab);
    const st = (await act("scroll_to", "deepBtn", {}, tab)).result || {};
    await sleep(400);
    const y1 = await ev("(function(){return window.scrollY;})()", tab);
    check("AU-C4 scroll_to → 页面真的滚动了（scrollY 从 0 变大）",
      String(st.success) === "true" && Number(y0) === 0 && Number(y1) > 0,
      "act=" + JSON.stringify(st) + " scrollY " + y0 + " -> " + y1);

    await act("type", "fmin", { text: "表单内容" }, tab);
    await sleep(200);
    const sub = (await act("submit", "fmsub", {}, tab)).result || {};
    await sleep(400);
    const outText = await ev("(function(){return document.getElementById('out').textContent;})()", tab);
    check("AU-C5 submit 动作 → 表单 submit 事件真的触发（页面输出变化）",
      String(outText).indexOf("已提交:表单内容") >= 0,
      "act=" + JSON.stringify(sub) + " out=" + JSON.stringify(outText));

    // =====================================================================
    console.log("\n[AU-D ui.downloads 全链路（此前只有单测，没有一次真实下载）]");
    // =====================================================================
    const dlBefore = (await b.call("ui.downloads", { tab })).result || {};
    check("AU-D1 下载前 ui.downloads 不虚报（新 tab 记录为空）",
      Array.isArray(dlBefore.downloads) && dlBefore.downloads.length === 0 &&
      Array.isArray(dlBefore.ready) && dlBefore.ready.length === 0,
      JSON.stringify(dlBefore).slice(0, 200));

    const dlAct = (await act("click", "dl", {}, tab)).result || {};
    await sleep(2500);
    const dlAfter = (await b.call("ui.downloads", { tab })).result || {};
    const recs = dlAfter.downloads || [];
    check("AU-D2 点击下载链接 → ui.downloads 出现一条记录",
      recs.length === 1, "act=" + JSON.stringify(dlAct) + " downloads=" + JSON.stringify(recs).slice(0, 300));
    const rec = recs[0] || {};
    const onDisk = rec.path ? fs.existsSync(rec.path) : false;
    const sizeOnDisk = onDisk ? fs.statSync(rec.path).size : -1;
    check("AU-D3 记录里的 path 真的在磁盘上，且大小与 received_bytes 一致",
      onDisk && rec.state === "completed" && sizeOnDisk > 0 &&
      Number(rec.received_bytes) === sizeOnDisk,
      "path=" + rec.path + " exists=" + onDisk + " state=" + rec.state +
      " received_bytes=" + rec.received_bytes + " size_on_disk=" + sizeOnDisk);
    check("AU-D4 ready 只含 completed 的记录（interrupted 不算可用）",
      Array.isArray(dlAfter.ready) && dlAfter.ready.length === 1 && dlAfter.ready[0].path === rec.path,
      "ready=" + JSON.stringify(dlAfter.ready).slice(0, 200));
    check("AU-D5 文件名被净化过（不含路径分隔符）且 dir 与 path 同目录",
      rec.filename === path.basename(String(rec.filename)) &&
      path.dirname(String(rec.path)) === String(dlAfter.dir).replace(/\/$/, "") + "/" + String(tab),
      "filename=" + rec.filename + " dir=" + dlAfter.dir + " path=" + rec.path);
    if (!(onDisk && rec.state === "completed")) {
      defect("P0", "ui.downloads",
        "真实下载链路没有走通：点击 <a download> 后 ui.downloads 记录 "
        + JSON.stringify(rec).slice(0, 200));
    }

    // =====================================================================
    console.log("\n[AU-E ui.wait 的四个 condition（既有套件只测过 text_contains）]");
    // =====================================================================
    // lateBtn 初始 disabled，1.2s 后生效 —— 正好用来测 button_enabled。
    // 注意传的是**元素 id**（agent 从 get_tree 拿到的那个），不是按钮文案。
    const t0 = Date.now();
    const wBtn = (await b.call("ui.wait", {
      condition: "button_enabled", target: "lateBtn", timeout_ms: 8000, tab,
    })).result || {};
    const wBtnMs = Number(wBtn.elapsed_ms);
    check("AU-E1 wait{button_enabled, target:<元素 id>} 能等到",
      wBtn.satisfied === true, JSON.stringify(wBtn) + " 实际耗时=" + (Date.now() - t0) + "ms");
    if (wBtn.satisfied !== true) {
      defect("P1", "ui.wait/button_enabled",
        "wait{condition:'button_enabled', target:'lateBtn'}（元素 id）在 8s 超时后仍报 "
        + "satisfied=false。实现用 findInTree(tree,'label',target) 按**label 子串**匹配，"
        + "而全 API 的 target 都指元素 id —— agent 拿 get_tree 给的 id 来等，必然等不到，"
        + "还会误判成\"按钮一直禁用\"。");
    }
    // 阳性对照：传按钮**文案**就能等到（证明观测手段有效、按钮确实生效了）
    const wBtnLabel = (await b.call("ui.wait", {
      condition: "button_enabled", target: "晚点生效", timeout_ms: 8000, tab,
    })).result || {};
    check("AU-E2 阳性对照：同一按钮传文案就能等到（证明按钮真的生效了）",
      wBtnLabel.satisfied === true, JSON.stringify(wBtnLabel));

    const wModal = (await b.call("ui.wait", { condition: "modal_appeared", timeout_ms: 5000, tab })).result || {};
    check("AU-E3 wait{modal_appeared} 对已有 dialog 的页面立即满足",
      wModal.satisfied === true, JSON.stringify(wModal));

    const wUrl = (await b.call("ui.wait", {
      condition: "url_contains", text: "/audit", timeout_ms: 5000, tab,
    })).result || {};
    check("AU-E4 wait{url_contains} 能匹配当前 URL",
      wUrl.satisfied === true, JSON.stringify(wUrl));

    const wMiss = (await b.call("ui.wait", {
      condition: "text_contains", text: "这句永远不存在", timeout_ms: 1200, tab,
    })).result || {};
    check("AU-E5 wait 条件不满足时如实报 satisfied=false（不谎报）",
      wMiss.satisfied === false && Number(wMiss.elapsed_ms) >= 1000, JSON.stringify(wMiss));

    // =====================================================================
    console.log("\n[AU-F WS 协议边界]");
    // =====================================================================
    const unknown = await b.call("ui.no_such_method", {});
    check("AU-F1 未知方法返回 -32601（而不是静默丢请求）",
      !!(unknown && unknown.error && unknown.error.code === -32601),
      JSON.stringify(unknown).slice(0, 200));

    const tabs1 = ((await b.call("ui.list_tabs", {})).result || {}).tabs || [];
    const tab2 = (await b.call("ui.new_tab", { url: HOST + "/audit" })).result?.tab;
    await sleep(800);
    const tabs2 = ((await b.call("ui.list_tabs", {})).result || {}).tabs || [];
    check("AU-F2 new_tab 后 list_tabs 数量 +1",
      tabs2.length === tabs1.length + 1, tabs1.length + " -> " + tabs2.length);
    await b.call("ui.close_tab", { tab: tab2 });
    await sleep(600);
    const tabs3 = ((await b.call("ui.list_tabs", {})).result || {}).tabs || [];
    check("AU-F3 close_tab 后 list_tabs 数量回落",
      tabs3.length === tabs1.length, tabs2.length + " -> " + tabs3.length);
    const closed = await byId(tab2, "btn");
    check("AU-F4 关掉的 tab 再 get_tree 不再返回内容（不是缓存糊弄）",
      closed === null, closed ? "still returns nodes" : "absent");

    // =====================================================================
    console.log("\n[AU-H 权限请求 —— 此前零覆盖，且它是\"静默失败\"的高发面]");
    // =====================================================================
    // 站点要定位/摄像头/通知，不装 setPermissionRequestHandler 时每个请求被静默
    // 拒绝，agent 分不清"这站点没这功能"和"被权限挡住"。现在默认白名单只放
    // pointerLock / clipboard-sanitized-write / fullscreen，其余**明确拒绝 + 广播
    // permission_denied 事件**（带怎么放行的 hint）。这里验的是"拒绝是明确的"。
    const denied = [];
    b.on("permission_denied", (p) => denied.push(p));
    const subRes = await b.subscribe(["permission_denied"]);
    check("AU-H1 能订阅 permission_denied 事件",
      !!(subRes && subRes.result), JSON.stringify(subRes).slice(0, 200));

    // geolocation 不在默认白名单 → 必被拒。站点侧必须拿到明确的 error，不能 hang。
    // ui.evaluate 走 CDP 且 awaitPromise:false，所以不能用 Promise 直接回值 ——
    // 改写成"结果落到 window.__geo，外面轮询"。这样 hang（一直 PENDING）也能被认出来。
    await ev(
      "(function(){window.__geo='PENDING';"
      + "navigator.geolocation.getCurrentPosition("
      + "function(){window.__geo='GRANTED';},"
      + "function(e){window.__geo='DENIED:'+e.code;});"
      + "return 'STARTED';})()", tab);
    let geoOutcome = "PENDING";
    for (let i = 0; i < 20 && geoOutcome === "PENDING"; i++) {
      await sleep(250);
      geoOutcome = String(await ev("(function(){return window.__geo;})()", tab));
    }
    check("AU-H2 geolocation（不在默认白名单）被明确拒绝，站点拿到 error 而不是 hang",
      geoOutcome === "DENIED:1",
      "outcome=" + JSON.stringify(geoOutcome) + "（PENDING 一直不变 = 静默 hang，比报错更糟）");
    await sleep(600);
    check("AU-H3 拒绝时广播 permission_denied（agent 能区分\"没这功能\"和\"被挡住\"）",
      denied.some((d) => d && d.permission === "geolocation"),
      JSON.stringify(denied).slice(0, 300));
    check("AU-H4 广播里带放行方法（hint），不是只报一句被拒",
      denied.some((d) => d && String(d.hint || "").indexOf("AI_BROWSER_PERMISSIONS") >= 0),
      JSON.stringify(denied[denied.length - 1] || null).slice(0, 300));
    // 阴性对照：不请求任何权限时不得凭空广播拒绝
    const deniedBefore = denied.length;
    const noopRes = await ev("(function(){return 1+1;})()", tab);
    await sleep(400);
    check("AU-H5 阴性对照：不请求权限时不广播 permission_denied",
      denied.length === deniedBefore && noopRes === 2,
      "before=" + deniedBefore + " after=" + denied.length);

    // =====================================================================
    console.log("\n[AU-G ui.quit —— 全仓库零覆盖的方法，放最后测]");
    // =====================================================================
    const quitRes = await b.call("ui.quit", {});
    check("AU-G1 ui.quit 返回 {ok:true}",
      !!(quitRes && quitRes.result && quitRes.result.ok === true), JSON.stringify(quitRes));
    // 然后 WS 必须真的断：不断就是"报了成功但什么都没发生"。
    // 观察窗要给足：quit 是 setTimeout(200ms) 延迟执行的，之后还要拆 BrowserView、
    // 关 WS server、app.quit() —— 实测 1s 内完成。第一版这里只等 3s 且中途被一次
    // 成功的 list_tabs 打断，把"还没退完"误判成"没退"（假红），已改成轮询到底。
    let quitAt = null;
    for (let i = 1; i <= 10 && !quitAt; i++) {
      await sleep(1000);
      const up = await checkPort(WS_PORT);
      if (!up) quitAt = i;
    }
    check("AU-G2 quit 后 WS 端口真的消失（不是只回一个 ok）",
      quitAt !== null, quitAt ? "端口在第 " + quitAt + "s 消失" : "轮询 10s 后端口仍在监听");
    if (quitAt === null) {
      defect("P1", "ui.quit",
        "ui.quit 返回 {ok:true}，但 10s 后 WS 端口仍在监听、进程未退出。"
        + "实现路径：onQuit → cleanupAndQuit → pageManager.close() → wsServer.close() → app.quit()，"
        + "任何一步抛错都会被 try/catch 吞掉且 stdio:'ignore' 看不见，需要单独复现。");
    }

    // =====================================================================
    console.log("\n[缺陷清单]");
    if (DEFECTS.length === 0) console.log("  （无）");
    else {
      const order = { P0: 0, P1: 1, P2: 2 };
      DEFECTS.sort((a, b) => (order[a.sev] ?? 9) - (order[b.sev] ?? 9));
      for (const d of DEFECTS) console.log(`  [${d.sev}] ${d.area} — ${d.text}`);
    }
    console.log("\n==== audit PASS=" + PASS + " FAIL=" + FAIL + " ====");
  } finally {
    try { b.close(); } catch {}
    try { server.close(); } catch {}
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  }
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("audit error:", e && e.stack ? e.stack : e.message); process.exit(2); });
setTimeout(() => { console.error("audit TIMEOUT"); process.exit(2); }, GLOBAL_TIMEOUT_MS);

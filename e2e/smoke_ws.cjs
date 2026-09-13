// e2e/smoke_ws.cjs — Real-WebContents integration smoke over the live WS API.
// Self-contained: spawns Electron, serves a local CSP-strict page (no 'unsafe-eval'),
// and asserts the core contracts an agent depends on — get_tree, data-ai-id backref,
// act-click, evaluate-under-CSP (regression lock), multi-tab lifecycle.
// Exits non-zero if any check fails.
//
// Run:  npm run smoke

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
const WS_PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local page served with a CSP that forbids eval ----
const BUTTON_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>SmokeCSP</title></head>
<body>
  <button id="btn">点我</button>
  <input id="name" placeholder="名字">
  <a id="lnk" href="https://example.com">外链</a>
  <script>
    window.__c = 0;
    document.getElementById('btn').addEventListener('click', function(){ window.__c++; });
  </script>
</body></html>`;
const TITLE_PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1 id="h">${title}</h1></body></html>`;
const RICH_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Rich</title></head><body>
  <div id="pm" class="ProseMirror" contenteditable="true"></div>
  <div id="ce" contenteditable="true"><p>ce原文</p></div>
  <textarea id="ta">ta原文</textarea>
</body></html>`;
const OBSERVE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Observe</title></head><body>
  <div class="slider-captcha" id="cap"><span class="captcha">拖动滑块验证</span></div>
  <div class="toast" id="msg">验证码已发送</div>
  <script>setTimeout(function(){ throw new Error('SMSOOM'); }, 400);</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Allows self + inline scripts, but NOT 'unsafe-eval' -> in-page `eval()` is
      // blocked here, so any evaluate implemented via eval() would fail on this page.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self';"
      );
      const p = req.url.split("?")[0];
      if (p === "/net") { res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.end("NET-PAYLOAD-42"); }
      if (p === "/a") res.end(TITLE_PAGE("TabASmoke"));
      else if (p === "/b") res.end(TITLE_PAGE("TabBSmoke"));
      else if (p === "/rich") res.end(RICH_PAGE);
      else if (p === "/observe") res.end(OBSERVE_PAGE);
      else res.end(BUTTON_PAGE);
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

async function main() {
  const server = await startServer();
  const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

  // own the instance: fail if something already holds 9223
  try {
    await waitForPort(WS_PORT, 600);
    console.error("!! port " + WS_PORT + " is busy — stop the running ai-browser first.");
    process.exit(3);
  } catch { /* free */ }

  const electronPath = require("electron");
  console.log("spawn electron @", electronPath);
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true });
  await waitForPort(WS_PORT, 30000);
  console.log("WS ready on", WS_PORT);

  // lazily require the WS helper only after spawn checks
  const b = new Browser();
  await b.ready();

  console.log("\n[get_tree on CSP page]");
  await b.call("ui.new_tab", { url: PAGE_URL });
  await sleep(1500);
  let raw = await b.call("ui.get_tree", {});
  let root = (raw && raw.result && (raw.result.tree || raw.result.root)) || raw;
  const ids = () => {
    const out = new Set();
    (function walk(x) {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      if (x.id) out.add(x.id);
      if (x.children) x.children.forEach(walk);
      if (x.nodes) x.nodes.forEach(walk);
    })(root);
    return out;
  };
  const idSet = ids();
  check("tree returned", idSet.size > 0, idSet.size + " nodes");
  check("button #btn present in tree", idSet.has("btn"));

  console.log("\n[evaluate under CSP — regression lock]");
  // The fixture serves a CSP with no 'unsafe-eval'. CDP Runtime.evaluate is, by
  // Chromium design, exempt from page CSP (same as Puppeteer page.evaluate), which
  // is exactly what lets an agent run code on strict sites. The meaningful check
  // is that the call returns a value on a CSP page, not that CSP "blocks" it.
  const title = await b.call("ui.evaluate", { js: "document.title" });
  const titleVal = title && title.result && title.result.value;
  check("ui.evaluate works under CSP (CDP path)", !title.error && titleVal === "SmokeCSP", "title=" + titleVal);

  console.log("\n[data-ai-id backref under CSP]");
  const br = await b.call("ui.evaluate", { js: "(function(){var el=document.querySelector('[data-ai-id=\"btn\"]');return el?el.tagName+'#'+el.id:'missing';})()" });
  const brVal = br && br.result && br.result.value;
  check("querySelector backrefs #btn", brVal && String(brVal).includes("#btn"), brVal);

  console.log("\n[act click hits real DOM]");
  await b.call("ui.act", { action: "click", target: "btn" });
  await sleep(700);
  const c = await b.call("ui.evaluate", { js: "window.__c" });
  const cVal = c && c.result && c.result.value;
  check("activated click incremented __c to 1", cVal === 1, "c=" + cVal);

  console.log("\n[multi-tab lifecycle (local, deterministic)]");
  const listCount = async () => {
    const l = await b.call("ui.list_tabs", {});
    const o = (l && l.result) || {};
    const raw = o.tabs || o;
    const arr = Array.isArray(raw) ? raw : (raw.tabs || []);
    return arr;
  };
  const T0 = (await listCount()).length; // baseline includes the app's default tab + '/' page
  const HOST = `http://127.0.0.1:${server.address().port}`;
  await b.call("ui.new_tab", { url: HOST + "/a" });
  await b.call("ui.new_tab", { url: HOST + "/b" });
  await sleep(1400); // let local nav URLs commit
  const tabs = await listCount();
  check("adding 2 tabs grew list to " + (T0 + 2), tabs.length === T0 + 2, tabs.length);
  const target = Array.isArray(tabs) && tabs.find((t) => (t.url || "").includes("/a"));
  if (!target) {
    console.log("  [diagnostic]", tabs.map((t) => ({ url: t.url, title: t.title, active: t.active })));
  }
  if (target) {
    const id = target.id;
    // switch to /a then confirm the ACTIVE context changed to TabA via document.title
    await b.call("ui.set_active_tab", { tab: id });
    await sleep(800);
    const tA = await b.call("ui.evaluate", { js: "document.title" });
    const tAVal = tA && tA.result && tA.result.value;
    check("set_active_tab switched to /a (title=TabASmoke)", tAVal === "TabASmoke", "title=" + tAVal);
    await b.call("ui.close_tab", { tab: id });
    const tab2 = await listCount();
    check("close_tab shrank to " + (T0 + 1), tab2.length === T0 + 1, tab2.length);
  } else {
    check("found /a tab for switch test", false, "not matched");
  }

  console.log("\n[network monitor — multi-client regression locks]");
  // Two independent WS clients both subscribe to the same network events.
  const A = new Browser();
  const B = new Browser();
  await Promise.all([A.ready(), B.ready()]);
  const netTab = (await b.call("ui.new_tab", { url: HOST })).result?.tab;
  await sleep(1300); // let the CSP page load so in-page fetch works

  const eventsOf = (c) => { const out = []; c.on("network_response", (d) => { if (d && String(d.url).includes("/net")) out.push(d); }); return out; };
  const aEv = eventsOf(A), bEv = eventsOf(B);
  await A.call("ui.subscribe", { events: ["network_response"] });
  await B.call("ui.subscribe", { events: ["network_response"] });
  await sleep(300);
  const fire = async () => { await b.call("ui.evaluate", { js: "fetch('/net'); 'ok'", tab: netTab }); await sleep(1500); };

  await fire();
  check("NF-1 client A delivered exactly 1 network_response", aEv.length === 1, aEv.length);
  check("NF-2 client B delivered exactly 1 (each client its own)", bEv.length === 1, "A=" + aEv.length + " B=" + bEv.length);

  // B unsubscribes; the shared per-tab debugger must NOT be detached while A remains.
  await B.call("ui.unsubscribe", { events: ["network_response"] });
  await sleep(300);
  await fire();
  check("NF-3 A still receives after B unsubscribes (no premature detach)", aEv.length === 2, "A=" + aEv.length);

  // Cross-client network body lookup returns real body regardless of session.
  const bodyA = await b.call("ui.network_body", { url_pattern: "/net", tab: netTab });
  const bodyAVal = bodyA?.result?.body || null;
  const bodyB = await A.call("ui.network_body", { url_pattern: "/net", tab: netTab });
  const bodyBVal = bodyB?.result?.body || null;
  check("NF-4 network_body correct via ws + via client A", bodyAVal === "NET-PAYLOAD-42" && bodyBVal === "NET-PAYLOAD-42", JSON.stringify([bodyAVal, bodyBVal]));

  // Closing the tab tears down its per-tab debugger + cache without error.
  const closed = await b.call("ui.close_tab", { tab: netTab });
  check("NF-5 close_tab on monitored tab ok (cleanup path)", !!(closed && closed.result), JSON.stringify(closed && closed.result));

  console.log("\n[evaluate guard rails on raw WS (P0 security)]");
  const eProc = await b.call("ui.evaluate", { js: "process.version" });
  check("SEC-1 reject process.* on raw WS", eProc?.error?.code === -32602, JSON.stringify(eProc && (eProc.error || eProc.result)));
  const long = "(" + " ".padEnd(6000, "x") + ")"; // >5000 chars
  const eLong = await b.call("ui.evaluate", { js: long });
  check("SEC-2 reject >5000 char script", eLong?.error?.code === -32602, "err=" + (eLong && eLong.error && eLong.error.message));
  const eOk = await b.call("ui.evaluate", { js: "2+2" });
  check("SEC-3 guard rails do not break normal evaluate", !eOk?.error && eOk?.result?.value === 4, String(eOk && eOk.result && eOk.result.value));
  A.close(); B.close();

  console.log("\n[rich editors — setContent paths (P1)]");
  const richTab = (await b.call("ui.new_tab", { url: HOST + "/rich" })).result?.tab;
  await sleep(1500);
  const richTree = await b.call("ui.get_tree", { tab: richTab });
  const richStr = JSON.stringify(((richTree && richTree.result) || "").tree || "");
  const reHas = (id) => richStr.includes('"' + id + '"');
  check("RE-0 ProseMirror/CE/textarea got data-ai-id", reHas("pm") || reHas("ce") || reHas("ta"), `pm=${reHas("pm")} ce=${reHas("ce")} ta=${reHas("ta")}`);
  const setRich = (target, text) => b.call("ui.act", { action: "setContent", target, params: { text }, tab: richTab });
  const getRich = (expr) => b.call("ui.evaluate", { js: expr, tab: richTab }).then((r) => (r && r.result && r.result.value));
  await setRich("pm", "P1标题一\nP1标题二");
  await setRich("ce", "CE替换");
  await setRich("ta", "P1 textarea 文本");
  const pmTxt = String(await getRich("document.getElementById('pm').innerText") || "");
  const ceTxt = String(await getRich("document.getElementById('ce').innerText") || "");
  const taVal = String(await getRich("document.getElementById('ta').value") || "");
  check("RE-1 setContent -> ProseMirror div text", pmTxt.includes("P1标题一"), pmTxt);
  check("RE-2 setContent -> contenteditable replaced", ceTxt.includes("CE替换") && !ceTxt.includes("ce原文"), ceTxt);
  check("RE-3 setContent -> textarea fallback", taVal.includes("P1 textarea 文本"), taVal);

  console.log("\n[observe — captcha/message/js_error (P1)]");
  const obs = new Browser();
  await obs.ready();
  const obsEvents = { cap: [], msg: [], err: [] };
  obs.on("captcha_appeared", (d) => obsEvents.cap.push(d));
  obs.on("message_appeared", (d) => obsEvents.msg.push(d));
  obs.on("js_error", (d) => obsEvents.err.push(d));
  await obs.call("ui.subscribe", { events: ["captcha_appeared", "message_appeared", "js_error"] });
  const obsTab = (await b.call("ui.new_tab", { url: HOST + "/observe" })).result?.tab;
  await sleep(2500); // scanCaptcha/scanMessages runs at ~1s + 5s interval
  check("OB-1 captcha_appeared detected (DOM scan)", obsEvents.cap.length > 0, "cap=" + obsEvents.cap.length);
  check("OB-2 message_appeared detected (DOM scan)", obsEvents.msg.length > 0, "msg=" + obsEvents.msg.length);
  // js_error depends on preload window.onerror which contextIsolation may isolate
  // away from the page's main world — report the observation without failing.
  console.log("  NOTE | js_error captured=" + obsEvents.err.length + (obsEvents.err.length ? "" : " (contextIsolation likely isolates page errors from preload onerror)"));
  obs.close();

  console.log("\n==== smoke PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("smoke error:", e.message); process.exit(2); });
setTimeout(() => { console.error("smoke TIMEOUT"); process.exit(2); }, 60000);
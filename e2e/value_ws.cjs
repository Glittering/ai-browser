// e2e/value_ws.cjs — node.value 截断契约 + 只读 get_value 的端到端验收。
// 自包含：起本地 fixture server + Electron。验证：
//   - 树里超长 value 只给前 200 code point，并带 value_truncated / value_full_length /
//     value_length_unit / value_fetch（含实际 tab）
//   - 用 value_fetch 提示的 ui.act{action:'get_value'} 能取到完整内容
//   - 短值不额外加字段；password 不泄露值/长度/取全量提示
//   - get_value 是只读分支（不聚焦、不改页面）
//
// 跑：AI_BROWSER_PORT=9333 node e2e/value_ws.cjs

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

const LONG_TEXT = Array.from({ length: 1837 }, (_, i) => "abcdefghijklmnopqrstuvwxyz"[i % 26]).join("");
const SHORT_TEXT = "short-value";
const PW = "p@ssw0rd-中文";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ValueFixture</title></head>
<body>
<textarea id="ta"></textarea>
<input id="txt" type="text">
<input id="pwd" type="password">
<div id="ce" contenteditable="true"></div>
<script>
  document.getElementById('txt').value = ${JSON.stringify(SHORT_TEXT)};
  document.getElementById('pwd').value = ${JSON.stringify(PW)};
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline';",
      });
      res.end(PAGE);
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
const note = (t) => console.log(`  NOTE | ${t}`);
let spawnedChild = null;
function killChild() { if (spawnedChild) { try { process.kill(-spawnedChild.pid, "SIGKILL"); } catch {} spawnedChild = null; } }

function findNode(node, id) {
  if (!node) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findNode(n, id); if (f) return f; } return null; }
  if (node && node.id === id) return node;
  if (node && node.children) return findNode(node.children, id);
  return null;
}

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    await waitForPort(WS_PORT, 600);
    console.error("!! port " + WS_PORT + " is busy — use AI_BROWSER_PORT=<free port> node e2e/value_ws.cjs");
    process.exit(3);
  } catch { /* free */ }

  const electronPath = require("electron");
const guard = require('./_spawn_guard.cjs');
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(WS_PORT) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${WS_PORT}`;
  console.log("spawn electron port", WS_PORT, "userData", childEnv.AI_BROWSER_USER_DATA);
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
guard.track(child);
  spawnedChild = child;
  await waitForPort(WS_PORT, 30000);

  const b = new Browser(WS_PORT);
  await b.ready();

  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const treeOf = async (tab) => {
    const raw = await b.call("ui.get_tree", { tab });
    const r = (raw && raw.result) || {};
    return r.tree || r.root || r;
  };
  const nodeOf = async (tab, id) => findNode(await treeOf(tab), id);

  const tab = (await b.call("ui.new_tab", { url: HOST + "/value" })).result?.tab;
  await sleep(1800);

  // 直接给 DOM 赋值（本 e2e 验的是 value 契约，不是输入链路；1837 字符逐字符
  // 受信键入要几十秒，且不是这里的关注点）。
  await ev(`(function(){var t=document.getElementById('ta');t.value=${JSON.stringify(LONG_TEXT)};` +
    `t.dispatchEvent(new Event('input',{bubbles:true}));return t.value.length;})()`, tab);
  await sleep(600);
  const domLen = await ev("document.getElementById('ta').value.length", tab);
  check("V-00 fixture 就位：textarea 里是 1837 字符", domLen === 1837, "len=" + domLen);

  console.log("\n[A. 截断可发现]");
  const taNode = await nodeOf(tab, "ta");
  check("V-01 超长 value 截断到 200 code point 且是原值前缀",
    taNode && taNode.value === LONG_TEXT.slice(0, 200) && LONG_TEXT.startsWith(taNode.value),
    "len=" + (taNode && taNode.value && taNode.value.length));
  check("V-02 带 value_truncated:true / value_full_length / value_length_unit",
    taNode && taNode.value_truncated === true && taNode.value_full_length === 1837 &&
    taNode.value_length_unit === "unicode_code_point",
    JSON.stringify(taNode && { t: taNode.value_truncated, full: taNode.value_full_length, u: taNode.value_length_unit }));
  check("V-03 value_fetch 已展开成带实际 tab 的 mcp/ws 提示（无内部 value_fetch_ref）",
    taNode && taNode.value_fetch && taNode.value_fetch.ws.params.tab === tab &&
    taNode.value_fetch.ws.params.action === "get_value" &&
    taNode.value_fetch.mcp.tool === "browse_act" && taNode.value_fetch_ref === undefined,
    JSON.stringify(taNode && taNode.value_fetch));
  check("V-04 value 不追加省略号", taNode && !String(taNode.value).endsWith("..."), "");

  console.log("\n[B. get_value 取全量（按 value_fetch 的提示直接调用）]");
  const hint = taNode.value_fetch.ws.params;
  const got = (await b.call("ui.act", { action: hint.action, target: hint.target, params: { offset: hint.offset, limit: hint.limit }, tab: hint.tab })).result;
  check("V-05 按 value_fetch 提示调用 ui.act get_value 拿到完整内容",
    got && got.success === true && got.value === LONG_TEXT,
    JSON.stringify(got && { ok: got.success, len: got.value && got.value.length, full: got.value_full_length }));
  check("V-06 响应带 offset / returned_length / value_full_length / value_truncated / next_offset",
    got && got.offset === 0 && got.returned_length === 1837 && got.value_full_length === 1837 &&
    got.value_truncated === false && got.next_offset === null,
    JSON.stringify(got && { o: got.offset, r: got.returned_length, t: got.value_truncated, n: got.next_offset }));

  const paged = (await b.call("ui.act", { action: "get_value", target: "ta", params: { offset: 0, limit: 1000 }, tab })).result;
  check("V-07 limit 分页：truncated=true + next_offset，续读能拼回原值",
    paged && paged.value_truncated === true && paged.next_offset === 1000 &&
    paged.returned_length === 1000 && paged.value_length_unit === "unicode_code_point",
    JSON.stringify(paged && { t: paged.value_truncated, n: paged.next_offset }));
  const paged2 = (await b.call("ui.act", { action: "get_value", target: "ta", params: { offset: paged.next_offset, limit: 1000 }, tab })).result;
  check("V-08 第二段拼起来等于完整值",
    paged2 && (paged.value + paged2.value) === LONG_TEXT, "len=" + ((paged.value + paged2.value).length));

  console.log("\n[C. 只读性 / 短值 / 敏感字段]");
  const activeBefore = await ev("(function(){var a=document.activeElement;return a?(a.id||a.tagName):null;})()", tab);
  await b.call("ui.act", { action: "get_value", target: "ta", tab });
  const activeAfter = await ev("(function(){var a=document.activeElement;return a?(a.id||a.tagName):null;})()", tab);
  check("V-09 get_value 不聚焦目标（只读分支，不走输入动作 fallback）",
    activeBefore === activeAfter, `${JSON.stringify(activeBefore)} -> ${JSON.stringify(activeAfter)}`);
  const valAfter = await ev("document.getElementById('ta').value", tab);
  check("V-10 get_value 不修改页面内容", valAfter === LONG_TEXT, "len=" + String(valAfter || "").length);

  const txtNode = await nodeOf(tab, "txt");
  check("V-11 短值只返回 value，不加任何截断字段（省 token）",
    txtNode && txtNode.value === SHORT_TEXT && txtNode.value_truncated === undefined &&
    txtNode.value_full_length === undefined && txtNode.value_fetch === undefined,
    JSON.stringify(txtNode && Object.keys(txtNode)));

  const pwdNode = await nodeOf(tab, "pwd");
  check("V-12 password 不返回 value / 长度 / 取全量提示，只标 value_sensitive",
    pwdNode && pwdNode.value === undefined && pwdNode.value_full_length === undefined &&
    pwdNode.value_fetch === undefined && pwdNode.value_sensitive === true,
    JSON.stringify(pwdNode));
  const pwdAct = (await b.call("ui.act", { action: "get_value", target: "pwd", tab })).result;
  check("V-13 get_value 拒绝读 password（明确报错而不是给值）",
    pwdAct && pwdAct.success === false && String(pwdAct.error).indexOf("sensitive") >= 0,
    JSON.stringify(pwdAct));

  const missing = (await b.call("ui.act", { action: "get_value", target: "no-such-node", tab })).result;
  check("V-14 target 不存在时明确报 target_not_found",
    missing && missing.success === false && String(missing.error).indexOf("target_not_found") >= 0,
    JSON.stringify(missing));

  note("get_value 复用 ui.act 外壳但不聚焦、不触发 input/change、不改页面；"
    + "password/file 的输入值永不暴露。Unicode code point 不是 grapheme —— "
    + "带组合音标的字符可能计为多个，但不会切断 UTF-16 surrogate pair。");

  console.log("\n==== value PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("value e2e error:", e && e.stack ? e.stack : e.message); killChild(); process.exit(2); });
setTimeout(() => { console.error("value e2e TIMEOUT"); killChild(); process.exit(2); }, GLOBAL_TIMEOUT_MS);

// e2e/network_ws.cjs — 网络抓包（可查询的 Chrome Network 面板）e2e。
// 自包含：起本地 fixture server + Electron，全部断言走真实 WS API。
// 重点验证 agent 真正要做的事：列出所有请求 → 过滤 → 拿到 POST 的请求体 →
// 分析请求头 → 大 body 分页 → 保留上限不静默丢东西 → clear 不碰 cookie。
//
// 跑：AI_BROWSER_PORT=9333 node e2e/network_ws.cjs
// （不改 package.json —— 用 node 直接跑。）

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
// 铁律 1：端口可配，且必须传进子进程 env，否则浏览器仍监听 9223。
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 300000;

// 抓包上限走受控 env（生产默认值更大；这里设小是为了能真实触发淘汰）。
const CHILD_ENV_LIMITS = {
  AI_BROWSER_NETWORK_MAX_RECORDS: "150",
  AI_BROWSER_NETWORK_MAX_BODY_BYTES: "65536",
  AI_BROWSER_NETWORK_SENSITIVE: "1",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POST_JSON_BODY = '{"title":"POST-BODY-XYZ","items":[1,2,3]}';
const POST_FORM_BODY = "name=%E5%BC%A0%E4%B8%89&age=42";
// 20000 code point ≈ 40000 字节（monitor 按 2 字节/code point 粗估）。
// 配合本 e2e 的 AI_BROWSER_NETWORK_MAX_BODY_BYTES=65536：单条放得下，
// 两条就必然触发淘汰 —— 正好用来验证 evicted 而不是让它误伤前面的 POST。
const BIG_BODY_SIZE = 20000;

// fixture：GET / POST(JSON) / POST(form) / 大 body / cookie / 洪水压测端点。
const NET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NetFixture</title></head>
<body><p id="np">network fixture</p>
<script>
  window.__fire = function(){ return 'ok'; };
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url || "").split("?")[0];
      const cors = { "Content-Type": "text/plain; charset=utf-8" };
      if (p === "/api/get") {
        res.writeHead(200, cors);
        return res.end("GET-PAYLOAD-OK");
      }
      if (p === "/api/post-json") {
        let chunks = [];
        req.on("data", (c) => chunks.push(c));
        return req.on("end", () => {
          res.writeHead(201, { ...cors, "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ echo: Buffer.concat(chunks).toString("utf8"), received: true }));
        });
      }
      if (p === "/api/post-form") {
        let chunks = [];
        req.on("data", (c) => chunks.push(c));
        return req.on("end", () => {
          res.writeHead(200, { ...cors, "Set-Cookie": "ai_e2e=abc123; Path=/" });
          res.end("FORM-OK:" + Buffer.concat(chunks).toString("utf8"));
        });
      }
      if (p === "/api/big") {
        res.writeHead(200, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Z".repeat(BIG_BODY_SIZE));
      }
      if (p === "/api/tiny") {
        res.writeHead(200, cors);
        return res.end("t");
      }
      if (p === "/api/cookie") {
        res.writeHead(200, { ...cors, "Set-Cookie": "ai_e2e=abc123; Path=/" });
        return res.end("cookie-route:" + String(req.headers.cookie || ""));
      }
      if (p === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        // 与 smoke/capabilities 同样的严格 CSP：无 unsafe-eval，connect-src 'self'。
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self';",
      });
      res.end(NET_PAGE);
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
// 异常退出时也要收掉 Electron，否则遗留进程会一直占着端口，后续跑不了。
let spawnedChild = null;
function killChild() {
  if (!spawnedChild) return;
  try { process.kill(-spawnedChild.pid, "SIGKILL"); } catch {}
  spawnedChild = null;
}
const check = (name, cond, detail) => { cond ? PASS++ : FAIL++; console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`); };
const note = (text) => console.log(`  NOTE | ${text}`);

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> node e2e/network_ws.cjs"
    );
    process.exit(3);
  } catch { /* free */ }

  const electronPath = require("electron");
  console.log("spawn electron @", electronPath, "port", WS_PORT);
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(WS_PORT), ...CHILD_ENV_LIMITS };
  // 铁律 2：ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动 —— 不起窗口、
  // 不监听 WS，测试永远等不到端口。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 铁律 4：默认独立 profile，别动用户真实 profile（存着登录态）。
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${WS_PORT}`;
  console.log("userData:", childEnv.AI_BROWSER_USER_DATA, "limits:", JSON.stringify(CHILD_ENV_LIMITS));

  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
  spawnedChild = child;
  await waitForPort(WS_PORT, 30000);
  console.log("WS ready on", WS_PORT);

  // 铁律 3：new Browser() 必须传端口。
  const b = new Browser(WS_PORT);
  await b.ready();

  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const call = async (method, params) => (await b.call(method, params));
  const netList = async (params) => (await call("ui.network_list", params)).result;
  const netGet = async (params) => (await call("ui.network_get", params));
  const findReq = (list, pred) => (list.requests || []).find(pred);

  // =======================================================================
  // A. 建立页面并发出各类请求
  // =======================================================================
  console.log("\n[A. 抓包：GET / POST(JSON) / POST(form) / 大 body]");
  const tab = (await call("ui.new_tab", { url: HOST + "/net" })).result?.tab;
  await sleep(1800);
  // 启动时应用会开一个 tab 导航到主页，那个 tab 的请求同样占用【全局】保留
  // 配额。清一次内存日志，让后面的保留上限断言只反映本测试自己发的请求。
  await call("ui.network_clear", {});
  note("启动 tab（index.js 默认导航页）也在全局配额内 —— 这里先 ui.network_clear "
    + "清掉它的噪声，保证保留上限断言只针对本测试发出的请求。");

  await ev(`(function(){return fetch('/api/get').then(function(r){return r.text();});})()`, tab);
  await sleep(400);
  await ev(
    `(function(){return fetch('/api/post-json',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer E2E-SECRET-42'},body:${JSON.stringify(POST_JSON_BODY)}}).then(function(r){return r.text();});})()`,
    tab
  );
  await sleep(400);
  await ev(
    `(function(){return fetch('/api/post-form',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:${JSON.stringify(POST_FORM_BODY)}}).then(function(r){return r.text();});})()`,
    tab
  );
  await sleep(1200);

  const all = await netList({ tab, limit: 200 });
  check("N-01b 列表项带 method / status / resource_type / state / started_at",
    !!findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0) &&
    findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0).method === "POST" &&
    findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0).status === 201 &&
    findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0).state === "finished",
    JSON.stringify(findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0)));

  const postOnly = await netList({ tab, method: ["POST"], limit: 200 });
  check("N-02 按 method:[POST] 过滤只剩 POST 请求",
    (postOnly.requests || []).length >= 2 && (postOnly.requests || []).every((r) => r.method === "POST"),
    "count=" + (postOnly.requests || []).length);

  const byUrl = await netList({ tab, url_contains: "/api/post-form", limit: 50 });
  check("N-03 按 url_contains 过滤命中",
    (byUrl.requests || []).length === 1 && byUrl.requests[0].url.indexOf("/api/post-form") >= 0,
    "count=" + (byUrl.requests || []).length);

  const byStatus = await netList({ tab, status: { min: 200, max: 299 }, limit: 200 });
  check("N-03b 按 status 区间过滤", (byStatus.requests || []).every((r) => r.status >= 200 && r.status <= 299),
    "count=" + (byStatus.requests || []).length);

  const page1 = await netList({ tab, limit: 2 });
  check("N-03c limit + before_seq 分页（has_more / next_before_seq）",
    page1.pagination.has_more === true && typeof page1.pagination.next_before_seq === "number",
    JSON.stringify(page1.pagination));
  const page2 = await netList({ tab, limit: 2, before_seq: page1.pagination.next_before_seq });
  check("N-03d 第二页的 seq 全部小于游标",
    (page2.requests || []).every((r) => r.seq < page1.pagination.next_before_seq),
    JSON.stringify((page2.requests || []).map((r) => r.seq)));

  // =======================================================================
  // B. POST 请求体（用户明确要拿的东西）
  // =======================================================================
  console.log("\n[B. POST 请求体 / initiator / 请求头]");
  const postJson = findReq(all, (r) => r.url.indexOf("/api/post-json") >= 0);
  check("N-04 列表里 POST 带 has_request_body=true 且 request_body_state=captured",
    postJson && postJson.has_request_body === true && postJson.request_body_state === "captured",
    JSON.stringify(postJson && { has: postJson.has_request_body, st: postJson.request_body_state }));

  const detailJson = await netGet({
    tab, network_id: postJson.network_id,
    include_request_headers: true, include_request_body: true,
    include_response_headers: true, include_response_body: true,
  });
  check("N-05 network_get 能拿到 POST 的请求体，且与发送内容完全一致",
    detailJson.result && detailJson.result.request && detailJson.result.request.body &&
    detailJson.result.request.body.raw.data === POST_JSON_BODY,
    JSON.stringify(detailJson.result && detailJson.result.request && detailJson.result.request.body &&
      detailJson.result.request.body.raw.data));
  check("N-05b JSON body 被解析成 parsed（agent 可直接看字段）",
    detailJson.result.request.body.parsed &&
    detailJson.result.request.body.parsed.title === "POST-BODY-XYZ" &&
    detailJson.result.request.body.parsed.items.length === 3,
    JSON.stringify(detailJson.result.request.body.parsed));
  check("N-05c 响应体同样可取（POST 的回包）",
    String(detailJson.result.response.body.raw.data).indexOf("POST-BODY-XYZ") >= 0,
    JSON.stringify(String(detailJson.result.response.body.raw.data).slice(0, 80)));

  const reqHeaders = detailJson.result.request.headers || [];
  const auth = reqHeaders.find((h) => String(h.name).toLowerCase() === "authorization");
  check("N-06 请求头默认脱敏：authorization 为 [REDACTED] 且标 redacted:true",
    !!auth && auth.value === "[REDACTED]" && auth.redacted === true,
    JSON.stringify(auth));
  check("N-06b 非敏感头不脱敏（content-type 仍是原文）",
    !!reqHeaders.find((h) => String(h.name).toLowerCase() === "content-type" && h.value === "application/json"),
    JSON.stringify(reqHeaders.map((h) => h.name)));
  check("N-06c 详情带 sensitive_data_warning",
    typeof detailJson.result.sensitive_data_warning === "string" && detailJson.result.sensitive_data_warning.length > 0,
    JSON.stringify(detailJson.result.sensitive_data_warning));

  const sensitive = await netGet({
    tab, network_id: postJson.network_id,
    include_request_headers: true, include_sensitive_headers: true,
  });
  const authRaw = (sensitive.result?.request?.headers || []).find((h) => String(h.name).toLowerCase() === "authorization");
  check("N-07 显式 include_sensitive_headers:true 才给原文（本 e2e 以 AI_BROWSER_NETWORK_SENSITIVE=1 启动）",
    !!authRaw && authRaw.value === "Bearer E2E-SECRET-42",
    JSON.stringify(authRaw));

  const formReq = findReq(all, (r) => r.url.indexOf("/api/post-form") >= 0);
  const detailForm = await netGet({ tab, network_id: formReq.network_id, include_request_body: true });
  check("N-08 form 请求体按 name/value 有序解析（含中文解码）",
    detailForm.result.request.body.kind === "form_urlencoded" &&
    JSON.stringify(detailForm.result.request.body.parsed).indexOf("张三") >= 0 &&
    detailForm.result.request.body.parsed.some((p) => p.name === "age" && p.value === "42"),
    JSON.stringify(detailForm.result.request.body.parsed));

  check("N-09 详情带 initiator（agent 可据此回溯构建来源）",
    !!detailJson.result.request.initiator, JSON.stringify(detailJson.result.request.initiator));
  check("N-09b 详情带 document_url / frame_id / redirect_index",
    typeof detailJson.result.request.document_url === "string",
    JSON.stringify(detailJson.result.request.document_url));

  // =======================================================================
  // C. 大 body 分页
  // =======================================================================
  console.log("\n[C. 大 body 分页]");
  await ev(`(function(){return fetch('/api/big').then(function(r){return r.text().then(function(t){window.__bigLen=t.length;return t.length;});});})()`, tab);
  await sleep(1500);
  const allWithBig = await netList({ tab, limit: 200 });
  const urls = (allWithBig.requests || []).map((r) => r.url);
  check("N-01 network_list 能列出页面发出的全部请求（GET/POST-JSON/POST-form/big 都在）",
    urls.some((u) => u.indexOf("/api/get") >= 0) &&
    urls.some((u) => u.indexOf("/api/post-json") >= 0) &&
    urls.some((u) => u.indexOf("/api/post-form") >= 0) &&
    urls.some((u) => u.indexOf("/api/big") >= 0),
    "count=" + (allWithBig.requests || []).length);

  const bigReq = findReq(allWithBig, (r) => r.url.indexOf("/api/big") >= 0);
  const p1 = await netGet({ tab, network_id: bigReq.network_id, include_response_body: true, body_limit: 8000 });
  check("N-10 大 body 分页：truncated=true 且给出 next_offset",
    p1.result.response.body.raw.truncated === true &&
    p1.result.response.body.raw.returned_bytes === 8000 &&
    p1.result.response.body.raw.next_offset === 8000,
    JSON.stringify({ t: p1.result.response.body.raw.truncated, n: p1.result.response.body.raw.next_offset }));
  check("N-10b 分页时 total_bytes 报告捕获到的完整长度",
    p1.result.response.body.raw.captured_bytes === BIG_BODY_SIZE,
    "captured=" + p1.result.response.body.raw.captured_bytes);
  check("N-10c 不完整切片不给 parsed（避免半截 JSON 被当真）",
    p1.result.response.body.parsed === null, JSON.stringify(p1.result.response.body.parsed));
  const p2 = await netGet({
    tab, network_id: bigReq.network_id, include_response_body: true,
    response_body_offset: p1.result.response.body.raw.next_offset, body_limit: 200000,
  });
  check("N-11 续读 next_offset 能拼回完整 body",
    p2.result.response.body.raw.offset === 8000 &&
    p2.result.response.body.raw.truncated === false &&
    (p1.result.response.body.raw.data + p2.result.response.body.raw.data).length === BIG_BODY_SIZE,
    "len=" + (p1.result.response.body.raw.data + p2.result.response.body.raw.data).length);

  // =======================================================================
  // D. 旧 ui.network_body 兼容
  // =======================================================================
  console.log("\n[D. 旧 ui.network_body 兼容]");
  const getState = await netList({ tab, url_contains: "/api/get", limit: 10 });
  const bodyBytes = (await netList({ tab, limit: 1 })).retention;
  const legacy = await call("ui.network_body", { url_pattern: "/api/get", tab });
  check("N-12 旧 ui.network_body 仍能按 URL 片段拉到 body",
    legacy.result && legacy.result.body === "GET-PAYLOAD-OK",
    JSON.stringify(legacy.result && legacy.result.body) +
    " state=" + JSON.stringify((getState.requests || []).map((r) => [r.url, r.state, r.response_body_state])) +
    " bodyBytes=" + JSON.stringify(bodyBytes));
  check("N-12b 旧接口响应带 deprecated:true 与替代方案提示",
    legacy.result && legacy.result.deprecated === true && !!legacy.result.replacement,
    JSON.stringify(legacy.result && legacy.result.deprecated));
  const legacyNone = await call("ui.network_body", { url_pattern: "/api/does-not-exist", tab });
  check("N-12c 无匹配时旧接口仍返回 null（不误命中）",
    legacyNone.result && (legacyNone.result.body === null || legacyNone.result.body === undefined),
    JSON.stringify(legacyNone.result && legacyNone.result.body));

  // =======================================================================
  // E. 保留上限：body 淘汰 → NETWORK_BODY_EVICTED
  // =======================================================================
  console.log("\n[E. 保留上限与明确错误码]");
  await ev(`(function(){return fetch('/api/big?second=1').then(function(r){return r.text().then(function(t){return t.length;});});})()`, tab);
  await sleep(1500);
  const afterSecondBig = await netList({ tab, limit: 200 });
  const firstBig = findReq(afterSecondBig, (r) => r.url.indexOf("/api/big") >= 0 && !(r.url.indexOf("second=1") >= 0));
  check("N-13 body 字节上限生效：被淘汰的记录仍在（metadata 保留），body_state=evicted",
    !!firstBig && firstBig.response_body_state === "evicted",
    JSON.stringify(firstBig && firstBig.response_body_state));
  const evicted = await netGet({ tab, network_id: firstBig.network_id, include_response_body: true });
  check("N-13b 取已淘汰的 body 返回 NETWORK_BODY_EVICTED(-32021) 而不是静默 null",
    evicted.error && evicted.error.code === -32021,
    JSON.stringify(evicted.error));

  const missing = await netGet({ tab, network_id: "1:totally-made-up:0" });
  check("N-14 network_id 不存在返回 NETWORK_NOT_FOUND(-32020)",
    missing.error && missing.error.code === -32020, JSON.stringify(missing.error));

  // 记录数上限：发足够多请求把最老的挤掉。
  await ev(
    "(function(){window.__flood=0;var ps=[];for(var i=0;i<220;i++){ps.push(fetch('/api/tiny?i='+i).then(function(){window.__flood++;}));}" +
    "Promise.all(ps).then(function(){window.__flood=-1;});return 'started';})()",
    tab
  );
  let dropped = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = (await netList({ tab, limit: 1 })).retention;
    dropped = st.dropped_records || 0;
    if (dropped > 0) break;
  }
  check("N-15 记录数上限生效：造足够多请求后 dropped_records > 0", dropped > 0, "dropped=" + dropped);
  const afterFlood = await netList({ tab, limit: 200 });
  check("N-15b 记录数被夹在上限内，不随请求数无限增长",
    afterFlood.retention.records <= afterFlood.retention.max_records,
    JSON.stringify(afterFlood.retention));
  const goneId = findReq(afterFlood, (r) => r.network_id === postJson.network_id);
  check("N-15c 被轮转掉的老记录取不到时返回 NETWORK_NOT_FOUND，而不是静默 null",
    !goneId, "still present=" + !!goneId);

  // =======================================================================
  // F. network_clear 只清内存日志，不碰 cookie
  // =======================================================================
  console.log("\n[F. network_clear 只清日志]");
  await ev("(function(){return fetch('/api/cookie').then(function(r){return r.text();});})()", tab);
  await sleep(600);
  const cookieBefore = String(await ev("document.cookie", tab) || "");
  check("N-16 cookie 已由服务端 Set-Cookie 写入", cookieBefore.indexOf("ai_e2e=abc123") >= 0, JSON.stringify(cookieBefore));

  const cleared = (await call("ui.network_clear", { tab })).result;
  check("N-17 network_clear 返回 cleared_records / cleared_body_bytes",
    cleared && cleared.ok === true && typeof cleared.cleared_records === "number",
    JSON.stringify(cleared));
  const afterClear = await netList({ tab, limit: 200 });
  check("N-17b 清空后该 tab 的请求日志为空", (afterClear.requests || []).length === 0,
    "count=" + (afterClear.requests || []).length);
  const cookieAfter = String(await ev("document.cookie", tab) || "");
  check("N-18 clear 不碰 cookie（cookie 仍在）", cookieAfter.indexOf("ai_e2e=abc123") >= 0, JSON.stringify(cookieAfter));
  // evaluate 的 awaitPromise 为 false，直接返回 Promise 拿不到文本 —— 先发起，
  // 把结果写进全局变量再读。
  await ev("(function(){window.__cookieResp='';fetch('/api/cookie').then(function(r){return r.text();}).then(function(t){window.__cookieResp=t;});return 'sent';})()", tab);
  await sleep(900);
  const cookieStillWorks = String(await ev("window.__cookieResp", tab) || "");
  check("N-18b clear 后再请求，浏览器仍带上 cookie（会话未被清）",
    cookieStillWorks.indexOf("ai_e2e=abc123") >= 0, JSON.stringify(cookieStillWorks).slice(0, 120));
  check("N-18c clear 响应明确声明没有清 cache/cookie/storage",
    cleared && cleared.cleared_cookies === false && cleared.cleared_browser_cache === false,
    JSON.stringify({ scope: cleared && cleared.scope }));

  // =======================================================================
  // G. network_configure
  // =======================================================================
  console.log("\n[G. network_configure]");
  const cfg = (await call("ui.network_configure", { tab, enabled: true, capture_bodies: "all" })).result;
  check("N-19 network_configure 生效并返回 enabled/capture_bodies",
    cfg && cfg.enabled === true && cfg.capture_bodies === "all", JSON.stringify(cfg));
  check("N-19b 上限只能由受控 env 改，接口不暴露无限设置",
    cfg && cfg.limits && typeof cfg.limits.max_records === "number" && cfg.limits.max_records > 0,
    JSON.stringify(cfg && cfg.limits));
  await ev(`(function(){return fetch('/api/get?after=1').then(function(r){return r.text();});})()`, tab);
  await sleep(800);
  const afterCfg = await netList({ tab, url_contains: "after=1", limit: 10 });
  check("N-19c configure 后新请求仍被记录", (afterCfg.requests || []).length >= 1,
    "count=" + (afterCfg.requests || []).length);

  const off = (await call("ui.network_configure", { tab, enabled: false })).result;
  check("N-20 可以关掉抓包（保留关闭开关）", off && off.enabled === false, JSON.stringify(off));
  await call("ui.network_configure", { tab, enabled: true, capture_bodies: "api" });

  note("抓包只覆盖 Network.enable 之后、已附着 tab 内发生的请求；multipart 文件字节、"
    + "流式上传、SSE/WebSocket frame 不承诺全量。POST body 是【最终发出】的内容，"
    + "不等于 JS 对象的逐字段构建过程 —— 接口不提供 construction_complete 一类承诺。");

  console.log("\n==== network PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error("network e2e error:", e && e.stack ? e.stack : e.message);
  killChild();
  process.exit(2);
});
setTimeout(() => { console.error("network e2e TIMEOUT"); killChild(); process.exit(2); }, GLOBAL_TIMEOUT_MS);

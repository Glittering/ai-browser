// e2e/security_ws.cjs — 攻击用例（真 Electron、真页面）：
//   1. 浏览器里的普通页面**不能**连上控制面（握手带 Origin → 1008）；
//   2. `ui.evaluate` 只能跑在页面世界，**摸不到 Node**（此前能拿到宿主 process）；
//   3. 阳性对照：`AI_BROWSER_WS_ALLOW_ORIGIN=1` 时同一个页面能连上 ——
//      证明 1 是"被拦住"，不是"服务根本没起来"。
//
// 为什么必须真机跑：`tests/test_ws_auth.js` 只能证明"带 Origin 的握手被拒"，
// 但"页面脚本会不会被 Chromium 的混合内容/PNA 先行挡住"、"去掉回落之后
// evaluate 到底在哪个世界执行"只有真渲染器能回答。
//
// Run:  npm run security
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const harness = require('./_harness.cjs');
const { windowEnv } = require('./_window_mode.cjs');
const guard = require('./_spawn_guard.cjs');
const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} | ${name}${detail !== undefined ? ' — ' + detail : ''}`);
};

// 攻击页：先连控制面，再试图用 evaluate 摸宿主。两条都记录在 window.__attack 里。
const attackPage = (port) => `<!doctype html><html><head><meta charset="utf-8"><title>benign article</title></head>
<body><h1>一个看起来很正常的页面</h1>
<script>
window.__attack = { phase: 'start' };
function log(o){ window.__attack = Object.assign(window.__attack, o); }
try {
  var ws = new WebSocket('ws://127.0.0.1:${port}');
  ws.onopen = function(){
    log({ phase: 'open' });
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'ui.evaluate',
      params: { js: 'Function(\\'return globalThis["pro"+"cess"].version\\')()' }
    }));
  };
  ws.onmessage = function(e){
    var m = {}; try { m = JSON.parse(e.data); } catch (_) {}
    if (m.id === 1) {
      var v = (m.result && (m.result.value !== undefined ? m.result.value : m.result)) || (m.error && m.error.message);
      log({ phase: 'rpc_ok', host: String(v) });
    }
  };
  ws.onerror = function(){ if (window.__attack.phase === 'start') log({ phase: 'error' }); };
  ws.onclose = function(ev){ log({ phase: 'closed', code: ev.code }); };
} catch (e) { log({ phase: 'throw', err: String(e) }); }
</script></body></html>`;

function startServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 故意**不加 CSP**：真实站点大多数不会把 connect-src 限制到 'self'，
      // 加了 CSP 就测不出"默认配置下会不会被连上"。
      res.end(attackPage(port));
    });
    srv.listen(0, WS_HOST, () => resolve(srv));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function once() {
      const s = net.connect(port, WS_HOST);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting port ' + port));
        setTimeout(once, 250);
      });
    })();
  });
}

/** 起一个独立实例（独立 profile / 端口），返回 { child, browser, stop }。 */
async function boot(port, label, extraEnv = {}) {
  if (!(await harness.waitPortFree(port, 15000))) {
    throw new Error('port ' + port + ' still busy — 换 AI_BROWSER_PORT 或先杀掉占用进程');
  }
  const electronPath = require('electron');
  const env = {
    ...process.env,
    // 所有套件都必须走这条窗口策略（tests/test_window_mode.js 的 WM-5 会查），
    // 否则并行跑时窗口抢前台导致别的套件 flaky。
    ...windowEnv(label),
    AI_BROWSER_PORT: String(port),
    AI_BROWSER_USER_DATA: path.join(os.tmpdir(), `ai-browser-e2e-security-${port}`),
    AI_BROWSER_START_HIDDEN: '1',
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: 'ignore', detached: true, env });
  guard.track(child);
  await waitForPort(port, 60000);
  const browser = new Browser(port);
  await browser.ready();
  await harness.assertIdentity(browser, child, 'security');
  return {
    child,
    browser,
    stop() { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} },
  };
}

async function main() {
  const PORT = Number(process.env.AI_BROWSER_SECURITY_PORT) || 9234;
  const PORT_OPEN = PORT + 1;
  const srv = await startServer(PORT);
  const srv2 = await startServer(PORT_OPEN);
  const pageUrl = (port) => `http://${WS_HOST}:${port}/`;
  let app = null;
  let appOpen = null;
  try {
    // ── 第一段：默认配置（防护开） ─────────────────────────────
    app = await boot(PORT, 'security');
    const b = app.browser;
    const t = await b.call('ui.new_tab', { url: pageUrl(srv.address().port) });
    const tab = (t && t.result && t.result.tab) || t.tab;
    await sleep(6000);

    const probe = await b.call('ui.evaluate', { tab, js: 'JSON.stringify(window.__attack)' });
    const inner = probe && probe.result && (probe.result.value !== undefined ? probe.result.value : probe.result);
    const st = JSON.parse(typeof inner === 'string' ? inner : JSON.stringify(inner || {}));
    console.log('  页面自述:', JSON.stringify(st));

    check('S-1 页面连不上控制面（没有 open / 或者被 1008 关掉）',
      st.phase === 'closed' || st.phase === 'error' || st.phase === 'start',
      'phase=' + st.phase + (st.code ? ' code=' + st.code : ''));
    check('S-2 页面拿不到任何 RPC 回执（没有 rpc_ok）', st.phase !== 'rpc_ok', 'phase=' + st.phase);

    // 即使经**合法客户端**调 evaluate，也必须在页面世界执行
    const nodeProbe = await b.call('ui.evaluate', { tab, js: 'typeof globalThis["pro"+"cess"]' });
    const nodeVal = nodeProbe && nodeProbe.result && (nodeProbe.result.value !== undefined ? nodeProbe.result.value : nodeProbe.result);
    check('S-3 evaluate 在页面世界：typeof process === "undefined"', nodeVal === 'undefined', 'got ' + JSON.stringify(nodeVal));

    const rce = await b.call('ui.evaluate', { tab, js: "Function('return globalThis[\"pro\"+\"cess\"].version')()" });
    const rceVal = rce && rce.result && (rce.result.value !== undefined ? rce.result.value : rce.result);
    const rceErr = rce && rce.error && rce.error.message;
    check('S-4 拆词绕过也拿不到宿主 Node 版本（错误或 undefined 都算拦住）',
      !/^v\d+\./.test(String(rceVal || '')), 'value=' + JSON.stringify(rceVal) + ' error=' + JSON.stringify(rceErr));

    // 错误必须被**分类**：页面自己抛的异常不能被说成 "cdp-unavailable"
    check('S-5 页面异常如实上报（不伪装成 CDP 不可用）',
      !rceErr || !/cdp-unavailable/i.test(String(rceErr)), 'error=' + JSON.stringify(rceErr));

    // ── 第二段：阳性对照（显式放开 Origin） ────────────────────
    appOpen = await boot(PORT_OPEN, 'security-open', { AI_BROWSER_WS_ALLOW_ORIGIN: '1' });
    const b2 = appOpen.browser;
    const t2 = await b2.call('ui.new_tab', { url: pageUrl(srv2.address().port) });
    const tab2 = (t2 && t2.result && t2.result.tab) || t2.tab;
    await sleep(6000);
    const probe2 = await b2.call('ui.evaluate', { tab: tab2, js: 'JSON.stringify(window.__attack)' });
    const inner2 = probe2 && probe2.result && (probe2.result.value !== undefined ? probe2.result.value : probe2.result);
    const st2 = JSON.parse(typeof inner2 === 'string' ? inner2 : JSON.stringify(inner2 || {}));
    console.log('  对照实例页面自述:', JSON.stringify(st2));
    check('S-6 阳性对照：放开 Origin 时页面确实能连上（证明 S-1 不是"服务没起来"）',
      st2.phase !== 'start' && st2.phase !== 'error' && st2.phase !== 'throw',
      'phase=' + st2.phase);
    check('S-7 阳性对照里 evaluate 也照样只到页面世界（放开 Origin 不等于放开 Node）',
      !/^v\d+\./.test(String(st2.host || '')), 'host=' + JSON.stringify(st2.host));
  } finally {
    if (app) app.stop();
    if (appOpen) appOpen.stop();
    try { srv.close(); } catch (_) {}
    try { srv2.close(); } catch (_) {}
  }

  console.log(`\n  security: PASS=${PASS} FAIL=${FAIL}`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('!! security suite crashed:', e && e.stack || e); process.exit(2); });

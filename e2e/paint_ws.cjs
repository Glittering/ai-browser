// e2e/paint_ws.cjs —— 白屏自检 + 自救阶梯的回归套件
//
// 事故（2026-10-25）：用户报"打开了百度有时候是纯白屏"。
// 这一类的特征是**所有回调都成功**：did-finish-load 到了、readyState=complete、
// ui.evaluate 读得到 397 个字的正文、CDP 截图也有内容 —— 只有用户眼睛看到的是白的。
// 于是工具侧集体失明：agent 说"页面正常"，用户说"白的"，谁也拿不出证据。
//
// 本套件钉三件事：
//   P1 正常页 → 判 ok，不许误报（误报会触发 reload，把用户填了一半的表单刷掉）
//   P2 纯白但有文字 → 判 blank-with-text，并进 list_tabs 的 paint 字段
//   P3 heal 走完阶梯（repaint → reload → give-up）就**停**，不进入重载死循环；
//      且 conclusions 落盘/广播 —— 救不动的白屏必须有人能看见
//
// 自带 fixture、不依赖外网。Run: npm run paint

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9243;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

// 两个 fixture：
//   /normal —— 白底 + 深色文字（正常页面，白度很高但颜色数上千）
//   /white  —— 纯白背景 + 纯白文字：DOM 里有几百个字，屏幕上什么都没有。
//              这就是"内容层失败"的最小复现，不需要真的去制造合成器故障。
const NORMAL = `<!doctype html><html><head><meta charset="utf-8"><title>normal</title>
<style>body{margin:0;background:#fff;color:#222;font:14px/1.7 -apple-system,sans-serif;padding:24px}
h1{font-size:20px}button{padding:6px 12px}</style></head><body>
<h1>这是一个正常页面</h1>
<p>它有正文、有按钮、有颜色层次 —— 白度依然很高（白底页面本来就这样），
所以判定必须靠"唯一颜色数"把白底内容页和真白屏分开。</p>
<button id="b">按钮</button>
</body></html>`;

const WHITE = `<!doctype html><html><head><meta charset="utf-8"><title>white</title>
<style>html,body{margin:0;height:100%;background:#ffffff;color:#ffffff}
p{margin:0;padding:24px;font:14px/1.7 -apple-system,sans-serif}</style></head><body>
<p>这段文字在 DOM 里有一百多个字符，但它的颜色和背景完全一样，所以屏幕上什么都没有。
判定依据只能是"像素纯白 + DOM 里有文字"，两者缺一不可：只看像素会把白底页全判成故障，
只看 DOM 又永远发现不了画不出来这件事。再加一条：页面有文字不代表它有内容层故障，
也可能只是作者把字刷白了 —— 所以自救有上限，救不动就如实上报，不许循环重载。</p>
</body></html>`;

let PASS = 0;
let FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = String(req.url || '').startsWith('/white') ? WHITE : NORMAL;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnElectron(port) {
  const electronPath = require('electron');
  const childEnv = { ...process.env, ...windowEnv('paint'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  // ELECTRON_RUN_AS_NODE 会让二进制降级成 node REPL（只打印 Welcome to Node.js 就退出）
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-paint-${port}`);
  const child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: childEnv });
  const lines = [];
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  });
  child.__stderrLines = lines;
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  return child;
}

// 等页面真的就绪再判：new_tab 回执 8ms 就返回，而真实导航排在
// "占位页 did-finish-load + 垫片注入"之后（约 100–200ms），固定 sleep 会偶发
// 拍到 loading 状态（那一轮 P1 就是这么红的）。判定逻辑本身没问题 ——
// not-ready 是刻意不判缺陷的 —— 但断言必须等对时刻。
async function waitReady(b, tab, wantUrl, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      // 必须同时看 URL：new_tab 会先后停在 about:blank 和 loading.html 两个占位页上，
      // 它们的 readyState 早就 complete 了。只看 readyState 会"等到了"占位页，
      // 然后对着还没开始的真实导航下判断（第一版就是这么偶发红的）。
      const r = unwrap(await b.call('ui.evaluate', {
        tab, js: 'JSON.stringify({rs:document.readyState,href:location.href})',
      }));
      const raw = r && r.value !== undefined ? r.value : r;
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (s && (s.rs === 'complete' || s.rs === 'interactive') && (!wantUrl || String(s.href).startsWith(wantUrl))) {
        return s.rs;
      }
    } catch (_) { /* 还在导航中，渲染器可能短暂不可读 */ }
    await sleep(150);
  }
  return 'timeout';
}

async function paint(b, tab, opts = {}) {
  return unwrap(await b.call('ui.paint_check', { tab, ...opts }));
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${base}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'paint');

  // ---- P1 正常页：不许误报 ----
  console.log('\n[P1] 白底内容页 → ok（误报的代价是 reload 掉用户正在填的表单）');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${base}/normal` })).tab;
    const rs = await waitReady(b, tab, `${base}/normal`);
    await sleep(300);
    const r = await paint(b, tab);
    check('P1 页面已就绪（否则 not-ready 会掩盖判定）', rs !== 'timeout', `readyState=${rs}`);
    check('P1 返回 ok', r && r.ok === true, JSON.stringify(r && r.error));
    check('P1 判定为 ok', r.verdict === 'ok', `verdict=${r.verdict} reason=${r.reason}`);
    check('P1 blank=false', r.blank === false, String(r.blank));
    // 白底页白度本来就高，这条断言钉住"白度高 ≠ 白屏"
    check('P1 白度确实很高但仍判 ok', (r.white_ratio || 0) >= 0.8 && r.verdict === 'ok',
      `white_ratio=${r.white_ratio} unique=${r.unique}`);
    check('P1 布局审计：视图铺满内容区', r.layout_ok !== false, JSON.stringify({ bounds: r.bounds, expected: r.expected }));
    const tabs = unwrap(await b.call('ui.list_tabs', {}))?.tabs || [];
    const mine = tabs.find((t) => t.id === tab) || {};
    check('P1 正常页不带 paint 字段（不给调用方制造噪音）', mine.paint === undefined, JSON.stringify(mine.paint));
    unwrap(await b.call('ui.close_tab', { tab }));
  }

  // ---- P2 纯白但有文字：必须报出来 ----
  console.log('\n[P2] 纯白 + DOM 里有文字 → blank-with-text，且 list_tabs 能看见');
  let whiteTab = null;
  {
    whiteTab = unwrap(await b.call('ui.new_tab', { url: `${base}/white` })).tab;
    await waitReady(b, whiteTab, `${base}/white`);
    await sleep(300);
    const r = await paint(b, whiteTab);
    check('P2 判 blank-with-text', r.verdict === 'blank-with-text', `verdict=${r.verdict} reason=${r.reason}`);
    check('P2 blank=true', r.blank === true, String(r.blank));
    check('P2 像素接近全白', (r.white_ratio || 0) >= 0.99, String(r.white_ratio));
    check('P2 颜色数极少', (r.unique || 0) <= 32, String(r.unique));
    check('P2 能读到 DOM 文字（证明不是"页面还空着"）', (r.dom && r.dom.text_len) > 50, String(r.dom && r.dom.text_len));
    const tabs = unwrap(await b.call('ui.list_tabs', {}))?.tabs || [];
    const mine = tabs.find((t) => t.id === whiteTab) || {};
    check('P2 list_tabs 带 paint.verdict', mine.paint && mine.paint.verdict === 'blank-with-text',
      JSON.stringify(mine.paint));
  }

  // ---- P3 自救有上限 ----
  console.log('\n[P3] heal：repaint → reload → give-up，然后停（不许重载死循环）');
  {
    const r = await paint(b, whiteTab, { heal: true });
    check('P3 救完之后仍然是白（这个页面救不回来）', r.verdict === 'blank-with-text', `verdict=${r.verdict}`);
    check('P3 结论是 give-up（不是继续重试）', r.action === 'give-up', `action=${r.action}`);
    // 关键：再一次 heal 不许再重载。用导航计数验证"真的没再重载"。
    const navBefore = unwrap(await b.call('ui.evaluate', {
      tab: whiteTab,
      js: '(function(){window.__navCount=(window.__navCount||0);return String(performance.now()|0);})()',
    }));
    await sleep(200);
    const again = await paint(b, whiteTab, { heal: true });
    check('P3 第二次 heal 仍报 give-up（步数不会被清零）', again.action === 'give-up', `action=${again.action}`);
    // 页面没被反复刷掉：标记还在
    const marker = unwrap(await b.call('ui.evaluate', { tab: whiteTab, js: 'performance.now() > 0' }));
    check('P3 页面仍可读（没有被刷成空白文档）', marker && marker.value !== false, JSON.stringify(marker));
    check('P3 导航计数探针就位', !!navBefore, JSON.stringify(navBefore));
  }

  // ---- P4 换个正常页 → 状态自愈，不留历史 ----
  console.log('\n[P4] 同一个 tab 导航到正常页 → 结论自动回到 ok，paint 字段消失');
  {
    unwrap(await b.call('ui.navigate', { tab: whiteTab, url: `${base}/normal` }));
    const rs = await waitReady(b, whiteTab, `${base}/normal`);
    await sleep(300);
    const r = await paint(b, whiteTab);
    check('P4 已导航到新文档（不是还在 /white 上判）', rs !== 'timeout', `readyState=${rs}`);
    check('P4 判 ok', r.verdict === 'ok', `verdict=${r.verdict} reason=${r.reason}`);
    const tabs = unwrap(await b.call('ui.list_tabs', {}))?.tabs || [];
    const mine = tabs.find((t) => t.id === whiteTab) || {};
    check('P4 paint 字段已消失', mine.paint === undefined, JSON.stringify(mine.paint));
    const again = await paint(b, whiteTab, { heal: true });
    check('P4 正常页不触发任何补救', again.action === 'none', `action=${again.action}`);
  }

  // ---- P5 后台 tab 不参与 ----
  console.log('\n[P5] 后台 tab 不做自检（不在屏幕上，白不白没有用户可见后果）');
  {
    const other = unwrap(await b.call('ui.new_tab', { url: `${base}/normal` })).tab;
    await waitReady(b, other, `${base}/normal`);
    await sleep(400);
    const tabs = unwrap(await b.call('ui.list_tabs', {}))?.tabs || [];
    const back = tabs.find((t) => t.id === whiteTab) || {};
    check('P5 后台 tab 没有被标成异常', back.paint === undefined, JSON.stringify(back.paint));
    unwrap(await b.call('ui.close_tab', { tab: other }));
  }

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
    const lines = (child && child.__stderrLines) || [];
    if (lines.length) {
      console.log('  主进程最后 10 行：');
      for (const l of lines.slice(-10)) console.log('    | ' + l.slice(0, 200));
    }
  }
  b.close();
  server.close();
  guard.killChild(child);
  await sleep(300);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

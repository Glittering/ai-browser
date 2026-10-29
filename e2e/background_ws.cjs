// e2e/background_ws.cjs —— 窗口不在前台/不显示时，agent 能不能把活干完
//
// 用户的要求（2026-10-28）："必须可以不在前台显示的情况下，agent 可以完成所有操作。
// 不是无头浏览器，但是可以跟无头浏览器一样无感知运行，并且随时可以点开，使用它，
// 还不影响 agent 进行任何任务。"
//
// 这条要求以前是**做不到**的，而且不是"差一点"，是三处硬伤：
//   1. _focusWindow 的 auto 分支会在窗口被隐藏/最小化时把它 showInactive 回来 ——
//      隐藏根本不是稳定状态，agent 每操作一次窗口就自己爬出来一次；
//   2. 没挂进窗口的 BrowserView 没有合成表面：读树/点击/输入/导航都正常，但
//      ui.screenshot 返回 0 字节、ui.paint_check 直接 no-frame。截图恰恰是 agent
//      判断"这一页到底画出什么"的唯一手段；
//   3. 白屏自检在窗口不可见时仍会判缺陷并按阶梯 reload —— 后台无人值守时等于
//      自己制造一场重载风暴。
//
// 现在：所有标签页都挂进窗口、用 z 序决定谁可见（有表面 = 可截图）；窗口可见性
// 只由人（Dock activate）和显式 ui.window 决定；窗口不可见时不做白屏判定。
//
// 套件钉住：
//   B1 AI_BROWSER_START_HIDDEN=1 启动 → 窗口从一开始就不显示，能力齐全
//   B2 隐藏状态下：读树 / 点击 / 输入 / 滚动 / 上传 / 截图 / 自检 / 导航 / 网络 / 对话框
//   B3 后台标签页（不是隐藏窗口，是另一页）同样能截图、能自检
//   B4 重新显示：可见标签页不变，窗口状态可读回
//
// Run: npm run background

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9252;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

async function rpc(conn, method, params = {}) {
  const msg = await conn.call(method, params);
  if (msg && msg.error) return { ok: false, error: msg.error.message };
  return { ok: true, result: msg && msg.result !== undefined ? msg.result : msg };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>bg</title>
<style>body{font:14px/1.6 -apple-system,sans-serif;padding:20px}
.tall{height:2400px;background:linear-gradient(#fff,#33517a)}</style></head><body>
<h1 id="h">后台能力</h1>
<button id="b" onclick="document.getElementById('r').textContent='clicked'">按钮</button>
<button id="d" onclick="alert('bg-dialog')">弹对话框</button>
<div id="r">idle</div>
<input id="t">
<input id="f" type="file">
<canvas id="c" width="120" height="60"></canvas>
<div class="tall"></div>
<script>
  var x = document.getElementById('c').getContext('2d');
  x.fillStyle = '#33517a'; x.fillRect(0, 0, 120, 60);
  window.__fetched = [];
  fetch(location.href + '?api=1').then(function (r) { return r.text(); })
    .then(function (t) { window.__fetched.push(t.length); });
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = String(req.url || '');
      if (u.indexOf('api=1') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, from: 'fixture' }));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function spawnElectron(port, extraEnv) {
  const env = { ...process.env, ...windowEnv('background'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (!env.AI_BROWSER_USER_DATA) env.AI_BROWSER_USER_DATA = path.join(os.tmpdir(), `ai-browser-e2e-bg-${port}`);
  const child = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env });
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

async function waitPath(conn, tab, want, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await rpc(conn, 'ui.evaluate', { tab, js: 'location.pathname' });
      if (r.ok && String(r.result && r.result.value) === want) return true;
    } catch (_) { /* 导航中 */ }
    await sleep(120);
  }
  return false;
}

/**
 * 读树拿 ref → 动手 → 如果回执说 No target（读树之后页面又渲染了一次，ref 过期了）
 * 就重读一次再来一遍。
 *
 * 为什么要有这个：这条套件测的是"窗口隐藏时还能不能操作"，不是"ref 永不失效"。
 * 全量并发跑的时候页面偶尔会在读树与派发之间重绘一帧，一句 No target 就把整条
 * 套件打断在第一步（实测过一次，单跑 37/37 全过）。重试一次是诚实的：
 * 它不掩盖能力缺失（真点不动的话重读也点不动）。
 */
async function actWithRef(conn, tab, matcher, params, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const ref = await findRef(conn, tab, matcher);
    if (!ref) { last = { ok: false, error: 'ref-not-found' }; await sleep(150); continue; }
    last = await rpc(conn, 'ui.act', { action: params.action, target: ref, ...params });
    if (last.ok && last.result && last.result.success !== false) return last;
    await sleep(200);
  }
  return last;
}

async function findRef(conn, tab, matcher) {
  const r = await rpc(conn, 'ui.get_tree', { tab });
  if (!r.ok) return null;
  const walk = (n) => {
    if (!n) return null;
    if (matcher(n)) return n.id;
    for (const c of (n.children || [])) { const f = walk(c); if (f) return f; }
    return null;
  };
  return walk(r.result && r.result.tree);
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${base}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  // 关键：一开始就处于后台模式（无人值守的常态）
  const child = await spawnElectron(WS_PORT, { AI_BROWSER_START_HIDDEN: '1' });
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'background');

  // ---- B1 启动即隐藏，但能力齐全 ----
  console.log('\n[B1] AI_BROWSER_START_HIDDEN=1：窗口从一开始就不显示，页面照样能读能拍');
  let tab = null;
  {
    const w = await rpc(b, 'ui.window', {});
    check('B1 窗口不可见', w.ok && w.result.visible === false, JSON.stringify(w.result).slice(0, 200));
    check('B1 窗口未最小化（是 hide 而不是 minimize）', w.result.minimized === false, String(w.result.minimized));

    // 启动页是 index.js 建的第一个 tab；直接在上面干活的姿势也必须是通的
    const tabs = (await rpc(b, 'ui.list_tabs', {})).result.tabs;
    tab = tabs[0] && tabs[0].id;
    check('B1 启动标签页存在', !!tab, JSON.stringify(tabs.map((t) => t.id)));

    const nav = await rpc(b, 'ui.navigate', { tab, url: `${base}/bg` });
    check('B1 隐藏状态下导航成功', nav.ok && nav.result.ok !== false, JSON.stringify(nav).slice(0, 160));
    check('B1 页面已就绪', await waitPath(b, tab, '/bg'));

    const tree = await rpc(b, 'ui.get_tree', { tab });
    check('B1 隐藏状态下能读语义树', tree.ok && !!tree.result.tree, JSON.stringify(tree).slice(0, 120));

    const shot = await rpc(b, 'ui.screenshot', { tab });
    const bytes = (shot.result && shot.result.data || '').length;
    check('B1 隐藏状态下截图非空（有真实合成表面）', shot.ok && bytes > 5000, bytes + ' bytes');

    const pc = await rpc(b, 'ui.paint_check', { tab });
    check('B1 隐藏状态下自检不返回 no-frame', pc.ok && pc.result.verdict !== 'no-frame', pc.result && pc.result.verdict);
  }

  // ---- B2 隐藏状态下的全套能力 ----
  console.log('\n[B2] 窗口隐藏时：点击 / 输入 / 滚动 / 上传 / 导航 / 网络 / 对话框');
  {
    const click = await actWithRef(b, tab, (n) => n.id === 'b' || String(n.label || '') === '按钮', { action: 'click' });
    check('B2 点击成功', click.ok && click.result.success !== false, JSON.stringify(click).slice(0, 160));
    await sleep(150);
    check('B2 点击真的生效', (await rpc(b, 'ui.evaluate', { tab, js: 'document.getElementById("r").textContent' })).result.value === 'clicked');

    const type = await actWithRef(b, tab, (n) => n.id === 't' || n.role === 'textbox', { action: 'type', text: 'hidden-ok' });
    check('B2 输入成功', type.ok && type.result.success !== false, JSON.stringify(type).slice(0, 160));
    check('B2 输入真的落地', (await rpc(b, 'ui.evaluate', { tab, js: 'document.getElementById("t").value' })).result.value === 'hidden-ok');

    const before = (await rpc(b, 'ui.evaluate', { tab, js: 'scrollY' })).result.value;
    const scroll = await rpc(b, 'ui.scroll', { tab, dy: 800 });
    check('B2 滚动调用成功', scroll.ok, JSON.stringify(scroll).slice(0, 120));
    await sleep(200);
    const after = (await rpc(b, 'ui.evaluate', { tab, js: 'scrollY' })).result.value;
    check('B2 滚动真的动了', Number(after) > Number(before), `${before} → ${after}`);

    // 上传：真实文件走 CDP DOM.setFileInputFiles，和窗口可见性无关
    const tmpFile = path.join(os.tmpdir(), 'aib-bg-upload.txt');
    fs.writeFileSync(tmpFile, 'uploaded while hidden\n');
    const refFile = await findRef(b, tab, (n) => n.id === 'f' || n.role === 'file-input');
    const up = await rpc(b, 'ui.act', { action: 'upload', target: refFile, file: tmpFile });
    check('B2 上传成功', up.ok && up.result.success !== false, JSON.stringify(up).slice(0, 160));
    const files = await rpc(b, 'ui.evaluate', { tab, js: '(document.getElementById("f").files[0]||{}).name||""' });
    check('B2 文件真的挂到了 input 上', files.result.value === 'aib-bg-upload.txt', String(files.result.value));

    // 对话框：原生 sheet 在隐藏窗口上不能弹出来卡住流程，必须由 CDP 应答
    const refDlg = await findRef(b, tab, (n) => n.id === 'd' || String(n.label || '') === '弹对话框');
    const t0 = Date.now();
    const dlg = await rpc(b, 'ui.act', { action: 'click', target: refDlg, timeout_ms: 8000 });
    check('B2 触发 alert 的点击没有卡死', dlg.ok && Date.now() - t0 < 8000, JSON.stringify(dlg).slice(0, 200));
    check('B2 对话框被自动应答（回执里有 dialog）',
      !!(dlg.result && (dlg.result.dialog || dlg.result.dialog_auto)), JSON.stringify(dlg.result || {}).slice(0, 200));
    // 渲染器被阻塞过的页面必须还能读
    const afterDlg = await rpc(b, 'ui.get_tree', { tab });
    check('B2 对话框之后页面仍可读', afterDlg.ok && !!afterDlg.result.tree, JSON.stringify(afterDlg).slice(0, 120));

    // 网络：隐藏状态下抓包照常（走 CDP，和窗口无关）
    const net = await rpc(b, 'ui.network_list', { tab });
    const reqs = (net.result && net.result.requests) || [];
    check('B2 抓到了 XHR（api=1）', reqs.some((r) => String(r.url || '').indexOf('api=1') >= 0),
      JSON.stringify(reqs.map((r) => String(r.url).slice(-24))).slice(0, 200));

    // 再导航一次：证明隐藏状态下连续干活不会退化
    const nav2 = await rpc(b, 'ui.navigate', { tab, url: `${base}/bg2` });
    check('B2 隐藏状态下第二次导航成功', nav2.ok && nav2.result.ok !== false, JSON.stringify(nav2).slice(0, 160));
    check('B2 第二次导航真的到了', await waitPath(b, tab, '/bg2'));
    const shot2 = await rpc(b, 'ui.screenshot', { tab });
    check('B2 导航后截图仍非空', ((shot2.result && shot2.result.data) || '').length > 5000,
      ((shot2.result && shot2.result.data) || '').length + ' bytes');
  }

  // ---- B3 后台标签页（窗口可见时的另一页） ----
  console.log('\n[B3] 窗口可见时，非可见标签页同样能截图 / 自检');
  let bgTab = null;
  {
    await rpc(b, 'ui.window', { visible: true });
    await sleep(400);
    const visible = (await rpc(b, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    const r1 = await rpc(b, 'ui.new_tab', { url: `${base}/bg3` });
    bgTab = r1.result.tab;
    check('B3 新标签页不抢视野（人眼前还是原来那页）', r1.result.shown === false, JSON.stringify(r1.result));
    check('B3 可见页没变', JSON.stringify(visible) === JSON.stringify((await rpc(b, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id)), '');
    check('B3 后台页已就绪', await waitPath(b, bgTab, '/bg3'));

    const shot = await rpc(b, 'ui.screenshot', { tab: bgTab });
    check('B3 后台标签页截图非空', ((shot.result && shot.result.data) || '').length > 5000,
      ((shot.result && shot.result.data) || '').length + ' bytes');
    const pc = await rpc(b, 'ui.paint_check', { tab: bgTab });
    check('B3 后台标签页自检给出结论（不是 no-frame）', pc.ok && pc.result.verdict !== 'no-frame', pc.result && pc.result.verdict);
    const click = await rpc(b, 'ui.act', { action: 'click', target: await findRef(b, bgTab, (n) => n.id === 'b' || String(n.label || '') === '按钮'), tab: bgTab });
    check('B3 后台标签页点击成功', click.ok && click.result.success !== false, JSON.stringify(click).slice(0, 160));
  }

  // ---- B4 重新显示：什么都不变 ----
  console.log('\n[B4] 点开窗口（ui.window visible:true）：可见标签页不变，状态可读回');
  {
    const before = (await rpc(b, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    const hide = await rpc(b, 'ui.window', { visible: false });
    check('B4 能再次隐藏', hide.ok && hide.result.visible === false, JSON.stringify(hide.result).slice(0, 160));
    await sleep(200);
    // 隐藏期间继续干活
    const r = await rpc(b, 'ui.evaluate', { tab: bgTab, js: 'document.readyState' });
    check('B4 二次隐藏后仍可执行脚本', r.ok && r.result.value === 'complete', String(r.result && r.result.value));
    const show = await rpc(b, 'ui.window', { visible: true });
    check('B4 能重新显示', show.ok && show.result.visible === true, JSON.stringify(show.result).slice(0, 160));
    await sleep(500);
    const after = (await rpc(b, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    check('B4 可见标签页没有被改动', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    const pc = await rpc(b, 'ui.paint_check', { tab: after[0] });
    check('B4 重新显示后可见页能正常自检', pc.ok && pc.result.verdict !== 'no-frame', pc.result && pc.result.verdict);

    // 最小化也是一条正常状态（Windows/Linux 上"看不见"的常见形态）
    const min = await rpc(b, 'ui.window', { minimized: true });
    check('B4 能最小化', min.ok && min.result.minimized === true, JSON.stringify(min.result).slice(0, 160));
    const r2 = await rpc(b, 'ui.evaluate', { tab: bgTab, js: '1+1' });
    check('B4 最小化状态下仍可执行脚本', r2.ok && r2.result.value === 2, String(r2.result && r2.result.value));
    const rest = await rpc(b, 'ui.window', { minimized: false });
    check('B4 能恢复', rest.ok && rest.result.minimized === false, JSON.stringify(rest.result).slice(0, 160));
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
  b.close(); server.close();
  guard.killChild(child);
  await sleep(300);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

// e2e/dialog_ws.cjs — 浏览器级对话框（alert / confirm / beforeunload）回归套件
//
// 为什么要单独一个套件（2026-10-24，用户在掘金删重复评论时被卡住）：
//
// 掘金删除评论时弹的是 `confirm('确定删除这条评论吗？')`。Chromium 把这类对话框
// 交给 embedder，Electron 画成**原生 sheet**：不在 DOM、不在 AX 树、截图里是一层
// 系统 UI，而**打开期间整个渲染器被阻塞** —— Runtime.evaluate 都不返回，于是
// agent 看到的是"点删除 → 超时"，屏幕上那个确认按钮永远没人点。
//
// 修法在工具层：主进程订阅 CDP Page.javascriptDialogOpening，按策略用
// Page.handleJavaScriptDialog 应答（这条命令由浏览器进程执行，不需要渲染器），
// 并把结果写进 act 回执的 `dialog` 字段。这个套件守的不变量是：
//
//   ① 任何动作都不会因为对话框而超时/挂住；
//   ② 回执必须说明"刚才弹了什么、被怎么处理了"（否则 agent 不知道发生过确认）；
//   ③ 处理完页面立即可用（渲染器已解冻）；
//   ④ beforeunload 不能把导航永久拦住（Electron 侧等价物是 will-prevent-unload）。
//
// 自带 fixture、不依赖外网。Run: npm run dialog

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

// ---------------------------------------------------------------- fixtures
const FIXTURES = {
  '/confirm.html': `<!doctype html><html><head><meta charset="utf-8"><title>confirm</title></head><body>
<h1>confirm fixture</h1>
<button id="del" onclick="if(!confirm('确定删除这条评论吗？')){document.getElementById('out').textContent='cancelled';return;} document.getElementById('item').remove(); document.getElementById('out').textContent='deleted';">删除评论</button>
<div id="item">待删除的条目</div>
<div id="out">idle</div>
</body></html>`,
  '/alert.html': `<!doctype html><html><head><meta charset="utf-8"><title>alert</title></head><body>
<h1>alert fixture</h1>
<button id="a" onclick="alert('这是个 alert');document.getElementById('out').textContent='after-alert';">弹 alert</button>
<div id="out">idle</div>
</body></html>`,
  '/unload.html': `<!doctype html><html><head><meta charset="utf-8"><title>unload</title></head><body>
<h1>beforeunload fixture</h1>
<script>window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = '有未保存内容'; });</script>
<a id="go" href="/plain.html">离开此页</a>
</body></html>`,
  '/plain.html': `<!doctype html><html><head><meta charset="utf-8"><title>plain</title></head><body>
<h1>PLAIN-REACHED</h1></body></html>`,
};

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
      const url = (req.url || '/').split('?')[0];
      const body = FIXTURES[url];
      if (body === undefined) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnElectron(port) {
  const electronPath = require('electron');
  const childEnv = { ...process.env, ...windowEnv('dialog'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-dialog-${port}`);
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

function findClickable(node, text) {
  let fallback = null;
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (String(n.label || '').indexOf(text) >= 0) {
      const role = String(n.role || '');
      const hasClick = (n.actions || []).indexOf('click') >= 0;
      if (role === 'link' || role === 'button') { hit = n.id; return; }
      if (hasClick && !fallback) fallback = n.id;
    }
    (n.children || []).forEach(walk);
  })(node);
  return hit || fallback;
}

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${HOST}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! port ' + WS_PORT + ' 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程');
    process.exit(3);
  }
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'dialog');

  // ---------------------------------------------------------------- C1 confirm
  console.log('\n[C1] confirm：点删除不再超时，且回执说明发生了什么');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/confirm.html` })).tab;
    await sleep(1200);
    const tree = unwrap(await b.call('ui.get_tree', { tab, subset: 'interactive' }));
    const id = findClickable(tree && tree.tree, '删除评论');

    const t0 = Date.now();
    const r = unwrap(await b.call('ui.act', { tab, action: 'click', target: id }));
    const ms = Date.now() - t0;

    check('C1 找到「删除评论」按钮', !!id, 'no clickable');
    check('C1 动作没有超时', !!r && !r.timed_out, `timed_out=${r && r.timed_out}`);
    check('C1 动作在 5s 内返回（对话框没把渲染器冻住）', ms < 5000, `${ms}ms`);
    check('C1 回执带 dialog.type=confirm', r && r.dialog && r.dialog.type === 'confirm', JSON.stringify(r && r.dialog));
    check('C1 回执带对话框原文', r && r.dialog && /确定删除/.test(String(r.dialog.message || '')), String(r && r.dialog && r.dialog.message));
    check('C1 默认策略是接受（auto）', r && r.dialog && r.dialog.accept === true && r.dialog.auto === true);

    // 页面状态：确认后 handler 继续执行到 'deleted'
    const st = unwrap(await b.call('ui.evaluate', {
      tab,
      js: "(() => ({ out: document.getElementById('out').textContent, item: !!document.getElementById('item') }))()",
    }));
    const v = st && st.value;
    check('C1 确认后 handler 继续执行（out=deleted）', v && v.out === 'deleted', JSON.stringify(v));
    check('C1 条目真的被删除', v && v.item === false, JSON.stringify(v));

    // 处理完页面立即可用（没冻住）
    const t1 = Date.now();
    const ping = unwrap(await b.call('ui.evaluate', { tab, js: '1+1' }));
    check('C1 处理完页面立即可评估', ping && ping.value === 2, JSON.stringify(ping));
    check('C1 评估没有变慢（<2s）', Date.now() - t1 < 2000, `${Date.now() - t1}ms`);

    // 不该留下"仍打开的对话框"
    const tabs = (unwrap(await b.call('ui.list_tabs', {})) || {}).tabs || [];
    const me = tabs.find((t) => t.id === tab) || {};
    check('C1 列表里没有残留 dialog', !me.dialog, JSON.stringify(me.dialog));

    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- C2 alert
  console.log('\n[C2] alert：只有一个按钮，自动确认并回报');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/alert.html` })).tab;
    await sleep(1200);
    const tree = unwrap(await b.call('ui.get_tree', { tab, subset: 'interactive' }));
    const id = findClickable(tree && tree.tree, '弹 alert');
    const r = unwrap(await b.call('ui.act', { tab, action: 'click', target: id }));
    check('C2 回执带 dialog.type=alert', r && r.dialog && r.dialog.type === 'alert', JSON.stringify(r && r.dialog));
    const st = unwrap(await b.call('ui.evaluate', {
      tab, js: "(() => document.getElementById('out').textContent)()",
    }));
    check('C2 alert 关闭后 handler 继续执行', st && st.value === 'after-alert', JSON.stringify(st));
    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- C3 beforeunload
  console.log('\n[C3] beforeunload：导航不能被永久拦住');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/unload.html` })).tab;
    await sleep(1200);
    const t0 = Date.now();
    const nav = unwrap(await b.call('ui.navigate', { tab, url: `${HOST}/plain.html`, wait_until: 'domcontentloaded' }));
    await sleep(800);
    const st = unwrap(await b.call('ui.evaluate', { tab, js: 'document.title' }));
    check('C3 导航在 15s 内完成（没被 beforeunload 卡住）', Date.now() - t0 < 15000, `${Date.now() - t0}ms`);
    check('C3 真的到了目标页', st && st.value === 'plain', JSON.stringify(st) + ' nav=' + JSON.stringify(nav && nav.error));
    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- verdict
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

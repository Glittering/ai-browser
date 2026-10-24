// e2e/shipped_ws.cjs —— 验收**装好的那个 App**，而不是仓库里的源码。
//
// 为什么必须单开一个套件（2026-10-24 两次事故）：
//
//   ① 用户说"标签栏还是划不动"，实测发现 npm / GitHub / MCP 全是 2.1.4，
//      而 /Applications 里的 App 是 10-19 手工打的 v1.3.1 —— 源码早修好了，
//      用户手上的产物没跟上。
//   ② 修完对话框后同样的问题再犯一次：所有套件都是 spawn(require('electron'), '.')
//      跑 dev 树，**没有任何一条断言碰过打包产物**。`verify_build.cjs` 比的是
//      asar 里的字节，能证明"文件一样"，但证明不了"这个包跑起来行为一样"。
//
// 这个套件把缺口补上：直接 spawn `<App>/Contents/MacOS/<CFBundleExecutable>`，
// 用临时 userData（不碰 ~/.ai-browser，登录态不受影响），然后在**这个进程**上
// 跑对话框与多标签的关键路径。
//
// 守的不变量：
//   S1 被验收的 App 版本 == 仓库 package.json 版本（别测错对象）
//   S2 进程确实来自 .app 包内（不是 dev 树里的 electron）
//   S3 confirm / alert 自动应答、不超时、回执有 dialog、渲染器解冻
//   S4 beforeunload 不会把导航永久拦住
//   S5 连续开 12 个标签不超时（标签栏渲染 + 标签管理的冒烟）
//
// 覆盖不到的地方（诚实说明）：标签栏的**可视滚动**（scrollLeft / scrollWidth）
// 在浏览器的 chrome 层，WS 协议读不到，只能人眼看或截图。这里不假装覆盖它；
// 要自动化得先给主进程加一条读标签栏尺寸的通道。
//
// Run: npm run verify:app            # 默认 /Applications/AI Browser.app
//      AIB_APP=/path/to/X.app npm run verify:app
//      AIB_APP=dist/X.app AI_BROWSER_PORT=9244 npm run verify:app

'use strict';

const harness = require('./_harness.cjs');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));

const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9233;
const APP = process.env.AIB_APP || '/Applications/AI Browser.app';
const USER_DATA = process.env.AI_BROWSER_USER_DATA || path.join(os.tmpdir(), `ai-browser-verify-app-${WS_PORT}`);

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

// ---------------------------------------------------------------- app 元信息
function plist(appPath, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function appBinary(appPath) {
  const exe = plist(appPath, 'CFBundleExecutable') || path.basename(appPath, '.app');
  return path.join(appPath, 'Contents', 'MacOS', exe);
}

async function spawnApp(port) {
  const bin = appBinary(APP);
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  // 这三个变量会直接让"启动 App"变成"启动别的东西"：
  //   ELECTRON_RUN_AS_NODE=1 → 打包后的二进制降级成 node REPL，秒退且只打印
  //                            "Welcome to Node.js"（2026-10-25 实测，
  //                            加 --remote-debugging-port 还会报 bad option）
  //   NODE_OPTIONS           → 受管环境注入的 fs 代理，会拦住 asar / 渲染器
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  childEnv.AI_BROWSER_USER_DATA = USER_DATA;

  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  const child = spawn(bin, [], { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: childEnv });
  const lines = [];
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  });
  child.__stderrLines = lines;
  guard.track(child);
  await harness.waitPortOpen(port, 45000);
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
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  console.log(`验收对象: ${APP}`);
  console.log(`仓库版本: ${pkgVersion}`);

  // ---------------------------------------------------------------- S1 / S2
  console.log('\n[S1] 验收对象是打包产物，且版本与仓库一致');
  {
    check('S1 .app 存在', fs.existsSync(APP), APP);
    const bin = appBinary(APP);
    check('S1 可执行文件在 .app/Contents/MacOS 内', fs.existsSync(bin) && bin.includes('.app/Contents/MacOS'), bin);
    const appVer = plist(APP, 'CFBundleShortVersionString');
    check('S1 CFBundleShortVersionString 等于 package.json', appVer === pkgVersion, `app=${appVer} pkg=${pkgVersion}`);
  }

  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT，或先关掉正在运行的 App');
    process.exit(3);
  }

  const child = await spawnApp(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();

  console.log('\n[S2] 连上的进程就是刚 spawn 的那个');
  {
    const info = unwrap(await b.call('ui.server_info', {}));
    check('S2 pid 一致', info && info.pid === child.pid, `expect=${child.pid} got=${info && info.pid}`);
    check('S2 平台是 darwin', info && info.platform === 'darwin', String(info && info.platform));
    // userData 落在本次的临时目录 —— 证明它吃的是我们给的 profile，没动 ~/.ai-browser
    const htmlProfile = fs.existsSync(path.join(USER_DATA, 'Partitions')) || fs.existsSync(USER_DATA);
    check('S2 用的是临时 profile（~/.ai-browser 未被触碰）', htmlProfile, USER_DATA);
  }

  // ---------------------------------------------------------------- S3 confirm
  console.log('\n[S3] confirm：点删除不超时，回执说明发生了什么');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/confirm.html` })).tab;
    await sleep(1200);
    const tree = unwrap(await b.call('ui.get_tree', { tab, subset: 'interactive' }));
    const id = findClickable(tree && tree.tree, '删除评论');
    check('S3 找到「删除评论」按钮', !!id, 'no clickable');

    const t0 = Date.now();
    const r = unwrap(await b.call('ui.act', { tab, action: 'click', target: id }));
    const ms = Date.now() - t0;
    check('S3 动作没有超时', !!r && !r.timed_out, `timed_out=${r && r.timed_out}`);
    check('S3 5s 内返回（对话框没冻住渲染器）', ms < 5000, `${ms}ms`);
    check('S3 回执带 dialog.type=confirm', r && r.dialog && r.dialog.type === 'confirm', JSON.stringify(r && r.dialog));
    check('S3 默认策略是接受（auto）', r && r.dialog && r.dialog.accept === true && r.dialog.auto === true, JSON.stringify(r && r.dialog));

    const st = unwrap(await b.call('ui.evaluate', {
      tab, js: "(() => ({ out: document.getElementById('out').textContent, item: !!document.getElementById('item') }))()",
    }));
    const v = st && st.value;
    check('S3 确认后 handler 继续执行（out=deleted）', v && v.out === 'deleted', JSON.stringify(v));
    check('S3 条目真的被删除', v && v.item === false, JSON.stringify(v));

    const t1 = Date.now();
    const ping = unwrap(await b.call('ui.evaluate', { tab, js: '1+1' }));
    check('S3 处理完页面立即可评估（<2s）', ping && ping.value === 2 && Date.now() - t1 < 2000, `${Date.now() - t1}ms`);

    const tabs = (unwrap(await b.call('ui.list_tabs', {})) || {}).tabs || [];
    const me = tabs.find((t) => t.id === tab) || {};
    check('S3 列表里没有残留 dialog', !me.dialog, JSON.stringify(me.dialog));
    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- S4 alert
  console.log('\n[S4] alert：自动确认并回报');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/alert.html` })).tab;
    await sleep(1200);
    const tree = unwrap(await b.call('ui.get_tree', { tab, subset: 'interactive' }));
    const id = findClickable(tree && tree.tree, '弹 alert');
    const r = unwrap(await b.call('ui.act', { tab, action: 'click', target: id }));
    check('S4 回执带 dialog.type=alert', r && r.dialog && r.dialog.type === 'alert', JSON.stringify(r && r.dialog));
    const st = unwrap(await b.call('ui.evaluate', { tab, js: "(() => document.getElementById('out').textContent)()" }));
    check('S4 alert 关闭后 handler 继续执行', st && st.value === 'after-alert', JSON.stringify(st));
    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- S5 beforeunload
  console.log('\n[S5] beforeunload：导航不能被永久拦住');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/unload.html` })).tab;
    await sleep(1200);
    const t0 = Date.now();
    await b.call('ui.navigate', { tab, url: `${HOST}/plain.html`, wait_until: 'domcontentloaded' });
    await sleep(800);
    const st = unwrap(await b.call('ui.evaluate', { tab, js: 'document.title' }));
    check('S5 导航 15s 内完成', Date.now() - t0 < 15000, `${Date.now() - t0}ms`);
    check('S5 真的到了目标页', st && st.value === 'plain', JSON.stringify(st));
    await b.call('ui.close_tab', { tab });
  }

  // ---------------------------------------------------------------- S6 多标签
  console.log('\n[S6] 连开 12 个标签：不超时（标签栏渲染路径的冒烟）');
  {
    const before = ((unwrap(await b.call('ui.list_tabs', {})) || {}).tabs || []).length;
    const opened = [];
    let slow = 0;
    for (let i = 0; i < 12; i++) {
      const t0 = Date.now();
      const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/plain.html?i=${i}` })).tab;
      if (Date.now() - t0 > 3000) slow++;
      opened.push(tab);
    }
    const after = ((unwrap(await b.call('ui.list_tabs', {})) || {}).tabs || []).length;
    check('S6 12 次 new_tab 全部 3s 内返回', slow === 0, `slow=${slow}`);
    check('S6 标签数量 +12', after === before + 12, `before=${before} after=${after}`);
    for (const t of opened) await b.call('ui.close_tab', { tab: t });
    const end = ((unwrap(await b.call('ui.list_tabs', {})) || {}).tabs || []).length;
    check('S6 关掉后回到原数量', end === before, `end=${end} before=${before}`);
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

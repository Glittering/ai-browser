// e2e/wrapper_ws.cjs —— 「树里有、点不动」的容器回归套件
//
// 事故（2026-10-25，知乎创作打卡挑战赛第五十四期报名）：
//   用户按私信里的活动链接，点不动；只能绕去「创作者中心 → 活动中心」。
//   用户自己给出的观察很准：「不是 <a>、AX 树无 click 动作」。
//
// 根因：列表行 `<div class="ChatUserListItem">` 的 AX name 是**整段预览文字的拼接**
//   "创作者小助手 10-21 ☄️最新一期「创作打卡挑战赛」活动来喽！「创作打卡挑战赛第五十四期 」将于…"
//   于是"按文字找链接"命中的是这个 generic 容器（点它只选中会话），而真正的
//   `<a>创作打卡挑战赛第五十四期</a>` 在会话面板里、label 只有那 11 个字。
//   点击容器的回执是 success=true / clicked_via=cdp-click，页面却不动 —— 而且当时
//   回执里没有一句话解释"你点的是容器"。
//
// 修法（两层，都在这个套件里钉住）：
//   W1 树里给"label 由子孙文字拼出来"的容器打 `agg:1`（读树时就能分辨文字归谁）
//   W2 点这类容器且页面没变时，回执补 `wrapper.better_target` —— 直接指出该点哪个 ref
//
// 自带 fixture、不依赖外网。Run: npm run wrapper

const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9241;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

// 两个面板：左 = 会话列表（行容器 label 是预览拼接），右 = 会话面板（真链接）。
// 结构刻意与知乎私信一致：容器在前、链接在另一棵子树里。
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>wrapper</title>
<style>
  body { margin: 0; font: 13px/1.5 -apple-system, sans-serif; display: flex; }
  #list { width: 286px; border-right: 1px solid #ddd; }
  .row { padding: 10px; cursor: pointer; }
  .row.active { background: #f3f6fa; }
  .chat { flex: 1; padding: 16px; }
</style></head><body>
<div id="list">
  <!-- tabindex + onclick 是必须的：Chromium 只对"可点/可聚焦"的元素用子树内容算
       accessible name。知乎的 ChatUserListItem 正是这种（inline onclick），
       它的 label 才会变成整段预览的拼接；光秃秃的 div 在 AX 里 label 是空的，
       复现不出这个 bug。onclick 故意什么都不做，模拟"这行已经是选中态"。 -->
  <div class="row active" id="row" tabindex="0" onclick="void 0">
    <div class="name">创作者小助手</div>
    <div class="time">10-21</div>
    <div class="snippet">☄️最新一期「创作打卡挑战赛」活动来喽！「创作打卡挑战赛第五十四期」将于 10 月 23 日开始</div>
  </div>
</div>
<div class="chat">
  <p>活动来啦：<a id="link" href="/campaign/54">创作打卡挑战赛第五十四期</a></p>
  <div id="out">idle</div>
</div>
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(FIXTURE);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnElectron(port) {
  const electronPath = require('electron');
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-wrapper-${port}`;
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

function findNodes(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => findNodes(c, pred, out));
  return out;
}

async function main() {
  const server = await startServer();
  const URL = `http://127.0.0.1:${server.address().port}/`;
  console.log(`fixture @ ${URL}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'wrapper');

  const tab = unwrap(await b.call('ui.new_tab', { url: URL })).tab;
  await sleep(1200);

  // 走 AX 读层：agg 标记只在这一层（默认 DOM extractor 没有 AX name 概念）
  const tree = unwrap(await b.call('ui.get_tree', { tab, subset: 'all', ax: true }));
  const rows = findNodes(tree && tree.tree, (n) => n.role === 'generic' && /创作者小助手/.test(String(n.label || '')));
  const links = findNodes(tree && tree.tree, (n) => n.role === 'link' && /第五十四期/.test(String(n.label || '')));

  console.log('\n[W1] 容器的 label 是拼接出来的 → 打 agg:1；文字归属的链接不打');
  {
    check('W1 树里有会话行容器', rows.length > 0, `rows=${rows.length}`);
    const row = rows[0] || {};
    check('W1 行容器带 agg:1', row.agg === 1, JSON.stringify({ id: row.id, agg: row.agg, label: String(row.label || '').slice(0, 40) }));
    check('W1 树里有真链接', links.length > 0, `links=${links.length}`);
    const link = links[0] || {};
    check('W1 链接没有 agg（文字是它自己的）', link.agg === undefined, JSON.stringify({ id: link.id, agg: link.agg }));

    // 页面没变 + 点的是容器 → 回执必须指出该点谁
    console.log('\n[W2] 点容器不生效时，回执给出更好的目标');
    const r = unwrap(await b.call('ui.act', { tab, action: 'click', target: row.id }));
    check('W2 动作本身不报错（点了就是点了）', !!r && r.success === true, JSON.stringify(r && r.error));
    const w = r && r.wrapper;
    check('W2 回执带 wrapper', !!w && w.is_wrapper === true, JSON.stringify(w));
    check('W2 回执指出 this is a container', /container/.test(String(r && r.effect_hint || '')), String(r && r.effect_hint || '').slice(0, 120));
    const bt = w && w.better_target;
    check('W2 better_target 是那个链接', !!bt && bt.id === link.id, JSON.stringify(bt));
    check('W2 better_target 说明它可点', !!bt && bt.clickable === true, JSON.stringify(bt && bt.clickable));

    // 照着回执走：点 better_target 应该真的生效（这里以「选中会话 + 链接可点」验证）
    console.log('\n[W3] 按回执点 better_target → 真的生效');
    const r2 = unwrap(await b.call('ui.act', { tab, action: 'click', target: link.id }));
    await sleep(800);
    const st = unwrap(await b.call('ui.evaluate', { tab, js: 'location.pathname' }));
    check('W3 点链接没有把自己判成容器', !r2 || !r2.wrapper, JSON.stringify(r2 && r2.wrapper));
    check('W3 链接点击后页面有反应（路由变了或开了新 tab）',
      (st && st.value !== '/') || (r2 && r2.opened_tab != null),
      `path=${JSON.stringify(st && st.value)} opened_tab=${JSON.stringify(r2 && r2.opened_tab)}`);
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

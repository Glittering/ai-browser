// e2e/window_open_ws.cjs — window.open("") + location 赋值 这条链路的回归套件
//
// 为什么单独建一个套件（2026-10-20 凌晨，用户第三次报"点进入学习不跳转"）：
//
// 超星系老站的惯用法是
//     var w = window.open("", "_blank");
//     w.location = res.url;
// 这条路前后修过两次（200a712 让 window.open 返回可用对象，56222e7 把 location
// 改成 PutForwards 访问器），**每次都只修了当时看着的那一层**。这次实测发现
// 第三层：window.open 派生出来的 tab **自己身上没有垫片**
// （shim:false / openNative:true），所以在那里面再走一次同样的写法就退化回
// 原始 bug —— 点"进入学习"打开课程页，课程页里再点"进入学习/考试"就没反应。
//
// 教训不是"再修一次"，而是：**修完必须有东西守着**。这个套件守一条不变量：
//
//   任意一层 window.open("") 打开的页面，都必须能再走同一条路。
//
// 递归一层就够暴露结构性问题 —— 如果垫片只装在 agent 新建的 tab 上，
// 第二层必然红。
//
// 自带 fixture、不依赖外网。Run: npm run winopen
//   AI_BROWSER_PORT=<port> npm run winopen     （run_all 会自动分配）

const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
// 每一层都是同一个写法（href="#" + onclick，和超星站点一模一样），
// 因为要证明的是"这条路可以递归走通"，不是"某个特定按钮能点"。
const LAYER = (title, next, mark) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title></head><body>
<h1>${title}</h1>
<p>${mark}</p>
<a href="#" id="go" onclick="var w=window.open('', '_blank'); window.__diag='got:'+(!!w)+' loc:'+(w?typeof w.location:'-')+' err:none'; try{ w.location='${next}'; }catch(e){ window.__diag+=' THROW:'+e.message; } return false;">进入学习</a>
</body></html>`;

const FIXTURES = {
  '/a.html': LAYER('第一层', '/l1.html', 'FIRST-LAYER'),
  '/l1.html': LAYER('第二层', '/l2.html', 'SECOND-LAYER'),
  '/l2.html': `<!doctype html><html><head><meta charset="utf-8"><title>第三层</title></head><body>
<h1>THIRD-LAYER-REACHED</h1></body></html>`,
  // 普通弹窗（带真实 url 的 window.open）：不该被垫片搞坏
  '/popup.html': `<!doctype html><html><head><meta charset="utf-8"><title>popup</title></head><body>
<h1>POPUP-SOURCE</h1>
<a href="#" onclick="window.open('/l2.html', '_blank'); return false;">打开真实弹窗</a>
</body></html>`,
};

// ---------------------------------------------------------------- 断言计数
let PASS = 0;
let FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

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
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-winopen-${port}`);
  // stderr 收下来不丢：这条链路的失败几乎都发生在主进程侧（IPC 有没有收到、
  // tab 建没建、nav 有没有被排队），stdio:ignore 等于把唯一线索扔掉。
  const child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: childEnv });
  const lines = [];
  child.stderr.on('data', (d) => {
    const s = String(d);
    for (const l of s.split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  });
  child.__stderrLines = lines;
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  return child;
}

/** 失败时把主进程最后几行日志打出来 —— 比"没有新 tab"有用得多。 */
function dumpChildLog(child, n = 12) {
  const lines = (child && child.__stderrLines) || [];
  if (!lines.length) { console.log('  (主进程 stderr 为空)'); return; }
  console.log('  主进程最后 ' + Math.min(n, lines.length) + ' 行：');
  for (const l of lines.slice(-n)) console.log('    | ' + l.slice(0, 200));
}

// ---------------------------------------------------------------- tab 工具
async function listTabs(b) {
  const r = unwrap(await b.call('ui.list_tabs', {}));
  return (r && r.tabs) || [];
}

/** 等一个"之前不存在"的 tab 出现。返回 tab 对象或 null。 */
async function waitNewTab(b, beforeIds, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = await listTabs(b);
    const fresh = now.filter((t) => beforeIds.indexOf(t.id) < 0);
    if (fresh.length) return fresh[0];
    await sleep(150);
  }
  return null;
}

/** 等某个 tab 的 URL 匹配（占位页先 about:blank，随后 nav 才载入真实地址）。 */
async function waitUrl(b, tabId, re, timeoutMs = 10000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const t = (await listTabs(b)).find((x) => x.id === tabId);
    last = (t && t.url) || '';
    if (re.test(last)) return last;
    await sleep(150);
  }
  return last;
}

/** 在一个 tab 里问：垫片在不在？window.open 还是原生的吗？ */
async function shimState(b, tabId) {
  const expr = 'JSON.stringify({shim: !!window.__aiWindowOpenShimV2,'
    + ' openNative: /native code/.test(String(window.open)),'
    + ' bridge: !!(window.__ai_browser__ && typeof window.__ai_browser__.windowOpenBridge === "function")})';
  // ⚠️ 参数名是 js，不是 expr。UI/文档曾经写 expr，传错会静默返回 undefined
  // （evaluate 对空表达式就是 undefined），表现像"页面没东西"。
  const r = unwrap(await b.call('ui.evaluate', { tab: tabId, js: expr }));
  try { return JSON.parse(r && r.value) || {}; } catch { return { raw: r }; }
}

/**
 * 在树里找"能点的那个节点"。
 *
 * ⚠️ 只按 label 匹配会命中**祖先**（body/generic 的 label 是聚合文字，里面
 * 同样包含"进入学习"）—— 点到祖先上不会触发 <a> 的 onclick，诊断结果就是
 * "onclick 没跑"，很容易被误读成垫片的问题（第一次跑本套件就踩了这个坑）。
 * 所以优先 role=link/button，其次才退回到带 click 动作的最深节点。
 */
function findClickable(node, text) {
  let fallback = null;
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    const lab = String(n.label || '');
    if (lab.indexOf(text) >= 0) {
      const role = String(n.role || '');
      const hasClick = (n.actions || []).indexOf('click') >= 0;
      if (role === 'link' || role === 'button') { hit = n.id; return; }
      if (hasClick && !fallback) fallback = n.id;
    }
    (n.children || []).forEach(walk);
  })(node);
  return hit || fallback;
}

/** 找到某个 tab 里那个"进入学习"链接的 data-ai-id 并点它。 */
async function clickGo(b, tabId, text = '进入学习') {
  const tree = unwrap(await b.call('ui.get_tree', { tab: tabId, subset: 'interactive' }));
  const id = findClickable(tree && tree.tree, text);
  if (!id) return { success: false, error: 'link_not_in_tree' };
  return unwrap(await b.call('ui.act', { tab: tabId, action: 'click', target: id }));
}

// ---------------------------------------------------------------- main
async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${HOST}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! port ' + WS_PORT + ' 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程');
    process.exit(3);
  }

  console.log(`spawn electron port ${WS_PORT}`);
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'window_open');

  // 清理第一层：agent 直接开的 tab 里必须也有垫片（这条以前是靠窗口手测的）
  console.log('\n[L0] agent 新建的 tab');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${HOST}/a.html` })).tab;
    await sleep(5000); // Windows: the window.open shim is injected via CDP after did-finish-load; needs more time
    const st = await shimState(b, tab);
    check('L0 agent 新建的 tab 有垫片', st.shim === true, JSON.stringify(st));
    check('L0 且 window.open 已被替换（不是原生）', st.openNative === false, JSON.stringify(st));
    check('L0 bridge 通道可用', st.bridge === true, JSON.stringify(st));
    await b.call('ui.close_tab', { tab });
  }

  // 第一层：window.open("") + location
  console.log('\n[L1] window.open("") 打开第一层');
  let tab1 = null;
  {
    const src = unwrap(await b.call('ui.new_tab', { url: `${HOST}/a.html` })).tab;
    await sleep(5000); // Windows: the window.open shim is injected via CDP after did-finish-load; needs more time
    const before = (await listTabs(b)).map((t) => t.id);
    const act = await clickGo(b, src);
    check('L1 点击成功返回', act && act.success !== false, JSON.stringify(act));

    // 页面自己记的一行：window.open 返回了什么、location 是什么类型、赋值有没有抛。
    // 这行是分层的照妖镜 —— "对象都没拿到" 和 "拿到了但不导航" 是两种病。
    const diag = unwrap(await b.call('ui.evaluate', { tab: src, js: 'String(window.__diag || "(onclick 没跑)")' }));
    console.log('  页面 diag: ' + (diag && diag.value));

    const fresh = await waitNewTab(b, before);
    check('L1 确实开出了新 tab', !!fresh, fresh ? '' : '10s 内没有新 tab');
    if (!fresh) dumpChildLog(child);
    if (fresh) {
      const url = await waitUrl(b, fresh.id, /\/l1\.html/);
      // 核心断言：不能停在 about:blank。停在 blank 就是原始 bug 的样子。
      check('L1 新 tab 导航到了 /l1.html（不是 about:blank）', /\/l1\.html/.test(url), `url=${url}`);
      const st = await shimState(b, fresh.id);
      // ★ 这条就是本次要钉的不变量：window.open 派生的 tab 自己也得带垫片，
      //   否则在它里面再走同一条路就退化。
      check('L1 ★ 派生 tab 里有垫片（能在里面再开一层）', st.shim === true, JSON.stringify(st));
      tab1 = fresh.id;
    }
    await b.call('ui.close_tab', { tab: src });
  }

  // 第二层：在派生 tab 里再走一次同一条路 —— 结构性缺陷在这里现形
  console.log('\n[L2] 在派生 tab 里再开一层（递归）');
  let tab2 = null;
  if (tab1 === null) {
    check('L2 前置条件：需要 L1 的 tab', false, 'L1 没开出 tab，跳过即视为失败');
  } else {
    const before = (await listTabs(b)).map((t) => t.id);
    const act = await clickGo(b, tab1);
    check('L2 点击成功返回', act && act.success !== false, JSON.stringify(act));

    const fresh = await waitNewTab(b, before);
    check('L2 第二层也开出了新 tab', !!fresh, fresh ? '' : '10s 内没有新 tab');
    if (fresh) {
      const url = await waitUrl(b, fresh.id, /\/l2\.html/);
      check('L2 新 tab 导航到了 /l2.html', /\/l2\.html/.test(url), `url=${url}`);
      const st = await shimState(b, fresh.id);
      check('L2 第三层 tab 里也有垫片', st.shim === true, JSON.stringify(st));
      // 内容真的到了才算"跳转成功"，URL 对但白屏也是失败
      const txt = unwrap(await b.call('ui.evaluate', {
        tab: fresh.id, js: 'document.body ? document.body.innerText.slice(0,80) : ""',
      }));
      check('L2 目标页正文真的渲染出来了', /THIRD-LAYER-REACHED/.test(String(txt && txt.value)),
        String(txt && txt.value).slice(0, 60));
      tab2 = fresh.id;
    }
  }

  // 普通弹窗（带真实 url 的 window.open）不该被垫片搞坏
  console.log('\n[PX] 带真实 url 的普通弹窗');
  {
    const src = unwrap(await b.call('ui.new_tab', { url: `${HOST}/popup.html` })).tab;
    await sleep(5000); // Windows: the window.open shim is injected via CDP after did-finish-load; needs more time
    const before = (await listTabs(b)).map((t) => t.id);
    const tree = unwrap(await b.call('ui.get_tree', { tab: src, subset: 'interactive' }));
    const id = findClickable(tree && tree.tree, '打开真实弹窗');
    if (id) await b.call('ui.act', { tab: src, action: 'click', target: id });
    else check('PX 树里找到「打开真实弹窗」', false, 'no clickable node');
    const fresh = await waitNewTab(b, before);
    check('PX window.open(url) 也开出了新 tab', !!fresh, fresh ? '' : '没有新 tab');
    if (fresh) {
      const url = await waitUrl(b, fresh.id, /\/l2\.html/);
      check('PX 普通弹窗目标地址正确', /\/l2\.html/.test(url), `url=${url}`);
    }
    await b.call('ui.close_tab', { tab: src });
  }

  // ---------------------------------------------------------------- verdict
  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
  }
  for (const id of [tab1, tab2]) { if (id) { try { await b.call('ui.close_tab', { tab: id }); } catch (_) {} } }
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

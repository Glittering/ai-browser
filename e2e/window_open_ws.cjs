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
// 教训不是"再修一次"，而是：**修完必须有东西守着**。这个套件守两条不变量：
//
//   1. 任意一层 window.open("") 打开的页面，都必须能再走同一条路。
//   2. 站点在第三参数里请求的尺寸必须变成视图的几何（没请求的照旧整号）——
//      这条是 2026-11-02 加的：特性串以前被丢掉，登录浮层长成整号标签页。
//
// 递归一层就够暴露结构性问题 —— 如果垫片只装在 agent 新建的 tab 上，
// 第二层必然红。几何同理：只测"缩小的那个"，缩错方向的修法也能绿，所以
// 每个几何断言都配一个同批跑的整号负对照。
//
// 自带 fixture、不依赖外网。Run: npm run winopen
//   AI_BROWSER_PORT=<port> npm run winopen     （run_all 会自动分配）

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
  // 几何套件用：同一页里两种写法 —— 写尺寸（浮层）与不写尺寸（整号）。
  // 两个都在一页里是刻意的：只测前者，"把所有 window.open 都缩成小窗"这种
  // 过头的修法照样能绿（对照必须来自同一次运行、同一个窗口）。
  '/geo.html': `<!doctype html><html><head><meta charset="utf-8"><title>geo</title></head><body>
<h1>GEO-SOURCE</h1>
<a href="#" onclick="window.__diag='got:'+!!window.open('/small.html','_blank','width=420,height=520,left=60,top=40'); return false;">开浮层</a>
<a href="#" onclick="window.__diag2='got:'+!!window.open('/small.html','_blank'); return false;">开整号</a>
</body></html>`,
  '/small.html': `<!doctype html><html><head><meta charset="utf-8"><title>small</title></head><body>
<h1>POPUP-TARGET</h1></body></html>`,
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
  // 垫片现在**默认关**（它替换页面可见的原生 window.open，站点一次 toString 就看得见，
  // 不能让全站付这个代价）。本套件测的正是"老站写法"那条路，所以显式全开：
  // `on` 同时打开注入侧的垫片和 preload 的桥（垫片本体在主 world，消息要经桥送出来）。
  const childEnv = { ...process.env, ...windowEnv('window_open'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0', AI_BROWSER_POPUP_SHIM: 'on' };
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

/** 视图当前的实际矩形（ui.window_bounds 的 views 表）+ 窗口内容区。 */
async function viewBounds(b, tabId) {
  const r = unwrap(await b.call('ui.window_bounds', {}));
  const v = r && r.views && r.views[tabId];
  return v ? { v, content: r.content } : null;
}

/** 页面自己看到的视口 —— 站点按它排版，比我们的记账更接近"用户看到的"。 */
async function innerSize(b, tabId) {
  const r = unwrap(await b.call('ui.evaluate', { tab: tabId, js: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})' }));
  try { return JSON.parse(r && r.value) || {}; } catch { return {}; }
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

  // ---------------------------------------------------------------- Bug 1: window.open 派生 tab 的 group / show
  // v2.3.0 修的是 setWindowOpenHandler 那条路（group + show），但窗口打开真正
  // 生效的路径是 ai:window_open IPC（垫片主 world -> bridge -> IPC）：那条路漏掉
  // opts，所以 agent 后台页弹窗会进人的组、且抢视野。本阶段钉死两条 invariant：
  //   L3-1 派生 tab 归在 agent 组里（不是人的组）
  //   L3-2 opener 是后台页时派生 tab 不抢视野（active 没被它顶掉）
  console.log('\n[L3] window.open 派生 tab：归属 + 不抢视野（Bug 1）');
  {
    const bg1 = unwrap(await b.call('ui.new_tab', { url: `${HOST}/a.html` })).tab;
    await sleep(3000);
    const bg2 = unwrap(await b.call('ui.new_tab', { url: `${HOST}/a.html` })).tab;
    // 等 /a.html 真实加载完再找“进入学习”—— 之前只等了 3s，链接树可能还没上树
    await sleep(5000);
    const tnow = await listTabs(b);
    const bg2info = tnow.find((t) => t.id === bg2) || {};
    check('L3 opener（第二个 agent tab）本身就在 agent 组', /^agent:/.test(String(bg2info.group || '')) && bg2info.group_kind === 'agent',
      JSON.stringify({ id: bg2, group: bg2info.group, group_kind: bg2info.group_kind }));
    const before = (await listTabs(b)).map((t) => t.id);
    const act = await clickGo(b, bg2);
    check('L3 后台 agent tab 点击打开成功', act && act.success !== false, JSON.stringify(act));
    const fresh = await waitNewTab(b, before);
    check('L3 window.open 从后台 agent tab 开了新 tab', !!fresh, '10s 内没有新 tab');
    if (fresh) {
      const ginfo = (await listTabs(b)).find((t) => t.id === fresh.id) || {};
      check('L3 派生 tab 归在 agent 组里（不是人组）', /^agent:/.test(String(ginfo.group || '')) && ginfo.group_kind === 'agent',
        JSON.stringify({ id: fresh.id, group: ginfo.group, group_kind: ginfo.group_kind }));
      check('L3 后台 opener 的派生 tab 未抢视野（active 没被它顶掉）', ginfo.active === false,
        JSON.stringify({ id: fresh.id, active: ginfo.active, group: ginfo.group }));
      tab1 = fresh.id;
    }
    for (const t of [bg1, bg2]) { if (t) { try { await b.call('ui.close_tab', { tab: t }); } catch (_) {} } }
    if (tab1) { try { await b.call('ui.close_tab', { tab: tab1 }); } catch (_) {} }
  }

  // ---------------------------------------------------------------- 弹窗几何
  // 站点写 window.open(url, name, 'width=420,height=520,...') 请求的是一个浮层。
  // 以前第三参数整份被丢掉（垫片形参就叫 _features，handler 只解构 url），于是登录框
  // 长成整号标签页 —— 用户看到的是"弹窗一片白/整屏换了一页"，弹窗页自己也按 1280
  // 宽排版。这一阶段钉的是**视图真实的矩形**，不是我们的记账：
  //   写了尺寸 → 就那么大；没写尺寸 → 照旧整号（负对照必须同批跑，否则
  //   "把所有弹窗都缩成小窗"这种过头修法照样能绿）。
  console.log('\n[GEO] window.open 的尺寸请求变成视图几何');
  {
    const src = unwrap(await b.call('ui.new_tab', { url: `${HOST}/geo.html` })).tab;
    await sleep(5000); // Windows: 垫片在 did-finish-load 之后经 CDP 注入，要等
    const before = (await listTabs(b)).map((t) => t.id);

    // —— 浮层那一发
    await clickGo(b, src, '开浮层');
    const small = await waitNewTab(b, before);
    check('GEO 写了尺寸的 window.open 开出了新 tab', !!small, small ? '' : '10s 内没有新 tab');
    let smallId = small && small.id;
    if (smallId) {
      const url = await waitUrl(b, smallId, /\/small\.html/);
      check('GEO 浮层导航到了 /small.html', /\/small\.html/.test(url), `url=${url}`);
      await sleep(2500);   // 让布局审计 / 白屏自检各跑一轮（它们会"纠正"视图尺寸）
      const got = await viewBounds(b, smallId);
      const full = await viewBounds(b, src);
      if (got && full) {
        const box = full.v;             // 整号 tab 就是"可用区"的实测形状
        const wantW = Math.min(420, box.width);
        const wantH = Math.min(520, box.height);
        check('GEO 视图宽度 = 请求的 420（不是整号）', Math.abs(got.v.width - wantW) <= 2,
          JSON.stringify({ got: got.v, full: box }));
        check('GEO 视图高度 = 请求的 520', Math.abs(got.v.height - wantH) <= 2, JSON.stringify(got.v));
        check('GEO left/top 生效：浮层压在父页右上角那块，不是铺满',
          Math.abs(got.v.x - 60) <= 2 && Math.abs(got.v.y - (box.y + 40)) <= 2,
          JSON.stringify({ got: got.v, base: box }));
        const in2 = await viewBounds(b, smallId);
        check('GEO ★ 等过审计的一轮，它仍是浮层（没被"纠正"回整屏）',
          in2 && Math.abs(in2.v.width - wantW) <= 2, JSON.stringify(in2 && in2.v));
        const tabInfo = (await listTabs(b)).find((t) => t.id === smallId) || {};
        check('GEO list_tabs 把浮层矩形报出去（agent 才知道按整屏点会打空）',
          !!tabInfo.popup && Math.abs(tabInfo.popup.width - wantW) <= 2, JSON.stringify(tabInfo));
        const ins = await innerSize(b, smallId);
        check('GEO 页面看到的视口就是那块地方（innerWidth≈420，不是整屏）',
          ins.w > 0 && Math.abs(ins.w - wantW) <= 20, JSON.stringify(ins));
      } else {
        check('GEO 拿到了 views/src 两块几何', false, JSON.stringify({ got, full }));
      }
    }

    // —— 负对照：没写尺寸照旧整号
    const before2 = (await listTabs(b)).map((t) => t.id);
    await clickGo(b, src, '开整号');
    const plain = await waitNewTab(b, before2);
    check('GEO 没写尺寸的 window.open 也开出了新 tab', !!plain, plain ? '' : '10s 内没有新 tab');
    if (plain) {
      await waitUrl(b, plain.id, /\/small\.html/);
      const got = await viewBounds(b, plain.id);
      const ref = await viewBounds(b, src);
      if (got && ref) {
        check('GEO ★ 负对照：普通标签页仍然铺满（把 noopener 当弹窗就是这条红）',
          Math.abs(got.v.width - ref.v.width) <= 2 && Math.abs(got.v.height - ref.v.height) <= 2,
          JSON.stringify({ got: got.v, ref: ref.v }));
        const info = (await listTabs(b)).find((t) => t.id === plain.id) || {};
        check('GEO 负对照不带 popup 字段', info.popup === undefined, JSON.stringify(info));
      }
      await b.call('ui.close_tab', { tab: plain.id });
    }
    await b.call('ui.close_tab', { tab: src });
    if (smallId) { try { await b.call('ui.close_tab', { tab: smallId }); } catch (_) {} }
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

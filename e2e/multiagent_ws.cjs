// e2e/multiagent_ws.cjs —— 多个 agent 同时用同一个浏览器
//
// 事故模型（2026-10-27 用户提出）：默认目标以前是**全局** activeTab，也就是
// "人眼看的那一页"。单 agent 时它恰好等于"agent 正在干的活"，看不出问题；
// 多个 agent 同时用时立刻崩：
//   - A 开一个标签页 → 所有人的默认目标都变成它；
//   - B 只说"点一下提交"，点在 A 的页面上；
//   - 人切一下标签页看热闹 → 把所有 agent 的目标一起切走。
// 共同点：**动作落在哪个页面，取决于别人做了什么**。回执 success、页面真的变了，
// 但不是该变的那个 —— 最难查的一类 bug。
//
// 这个套件钉住四条不变量：
//   M1 每个连接有自己的工作标签页（list_tabs 里的 mine 只在自己那条上）
//   M2 新建标签页**不抢人眼前的页面**（第一个除外：那时人眼前还是启动页）
//   M3 省略 tab 时打到自己的页面，别人的页面一动不动
//   M4 真并发：两个会话同时动作，各自的结果互不污染
//   M5 目标被关掉要**明确报错**，不许就近挑一个页面继续干
//
// Run: npm run multiagent

const harness = require('./_harness.cjs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9251;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const fails = [];
// 阶段标记 + 看门狗。
//
// 为什么需要：tools/browser.cjs 的 call() 没有超时，一旦某个 RPC 不回复，
// 整个套件会**静默挂住**，在 run_all 里表现为"420s 后 TIMEOUT / 无摘要"——
// 没有停在哪儿、也没有失败明细。看门狗把它变成一句可诊断的报错。
let STAGE = 'init';
let CHILD = null;          // 供看门狗打印子进程最后几行（否则超时那天没有任何线索）
const stage = (s) => { STAGE = s; };
{
  const wd = setTimeout(() => {
    console.error(`\n!! WATCHDOG: 卡在 [${STAGE}] 超过 150s —— 这个阶段有 RPC 没返回`);
    // 子进程还活着吗？stderr 说了什么？超时现场唯一的两个线索。
    try {
      if (CHILD) console.error(`   子进程 ${CHILD.pid} ${CHILD.exitCode === null ? '仍在' : '已退出 code=' + CHILD.exitCode}`);
    } catch (_) {}
    const lines = (CHILD && CHILD.__stderrLines) || [];
    if (lines.length) {
      console.error('   主进程最后 12 行：');
      for (const l of lines.slice(-12)) console.error('     | ' + String(l).slice(0, 200));
    } else {
      console.error('   （主进程没有 stderr 输出）');
    }
    guard.killAll();
    process.exit(9);
  }, 150000);
  if (wd.unref) wd.unref();
}
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 一次 RPC，把"成功/失败"摊平成 {ok, result, error}，免得每处都判两次。 */
async function rpc(conn, method, params = {}) {
  const msg = await conn.call(method, params);
  // 把 error.data 也带出来：组满这种"拒绝但可救"的错误，可关闭清单就在 data 里，
  // 丢了它就只能断言"报错了"，无法验证"它告诉了我该怎么办"。
  if (msg && msg.error) return { ok: false, error: msg.error.message, code: msg.error.code, data: msg.error.data };
  return { ok: true, result: msg && msg.result !== undefined ? msg.result : msg };
}

const PAGE = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>body{font:14px/1.6 -apple-system,sans-serif;padding:20px}</style></head><body>
<h1 id="who">${name}</h1>
<button id="b" onclick="document.getElementById('r').textContent='clicked-by-${name}'">按钮</button>
<div id="r">idle</div>
<input id="t" value="">
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE(String(req.url || '/').replace('/', '') || 'x'));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function spawnElectron(port) {
  const env = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  // 组上限压小，才能在几秒内把"满了怎么办"测出来（默认 8 要开很多页）。
  env.AI_BROWSER_TAB_LIMIT = '4';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (!env.AI_BROWSER_USER_DATA) env.AI_BROWSER_USER_DATA = path.join(require('node:os').tmpdir(), `ai-browser-e2e-multi-${port}`);
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

/** 等到 pathname 就是想等的那个（new_tab 会先停在占位页，readyState 已经是 complete）。 */
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

async function text(conn, tab, js) {
  const r = await rpc(conn, 'ui.evaluate', { tab, js });
  return r.ok ? (r.result && r.result.value) : undefined;
}

/**
 * 在语义树里找一个节点的 data-ai-id。
 * 不写死 'b'/'t'：真实的 ref 由读层决定（元素有 id 时可能直接用 id，也可能被
 * 分配成 e:button-N）。agent 走的也是这条路，测试跟着走才测得住。
 */
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
  stage('spawn');
  const child = await spawnElectron(WS_PORT);
  CHILD = child;
  stage('spawned');

  // 两个 Browser 实例 = 两条 WS 连接 = 两个 agent 会话（MCP 那边每个进程一条）
  //
  // 带重试：`waitPortOpen` 只证明"这个端口能连上"，证明不了"连上的是我刚拉起的
  // 那个进程"。上一个实例还在退出途中时端口可能短暂由它占着，客户端连过去的瞬间
  // 它就死了 —— 那一次连接会一直挂到超时（2026-10-28 实测，看门狗报"卡在 spawned"）。
  // 这里用 server_info 的 pid 认人，认错了就重连，最多三次。
  let A = null, B = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    A = new Browser(WS_PORT);
    B = new Browser(WS_PORT);
    try {
      await A.ready(10000);
      await B.ready(10000);
    } catch (e) {
      A.close(); B.close();
      console.log(`  [connect] 第 ${attempt} 次没连上（${e.message}），重试…`);
      await sleep(800);
      continue;
    }
    const info = await A.call('ui.server_info', {});
    const pid = info && info.result && info.result.pid;
    if (pid === child.pid) break;
    A.close(); B.close();
    console.log(`  [connect] 第 ${attempt} 次连到别的实例（pid=${pid}，期望 ${child.pid}），重试…`);
    await sleep(800);
    A = null; B = null;
  }
  if (!A || !B) throw new Error('三次都没能连上本次拉起的实例');
  await harness.assertIdentity(A, child, 'multiagent');

  // ---- M1 各自的工作标签页 ----
  stage('M1');
  console.log('\n[M1] 两个连接各有自己的标签页');
  let tabA = null, tabB = null;
  {
    const ra = await rpc(A, 'ui.new_tab', { url: `${base}/A` });
    check('M1 A 建标签页成功', ra.ok && !!ra.result.tab, JSON.stringify(ra));
    tabA = ra.result && ra.result.tab;
    // 第一个标签页会顶掉启动页（那时人眼前还是 baidu，没有"人的页面"可保护）
    check('M1 A 的**第一个**标签页显示出来（替换启动页）', ra.ok && ra.result.shown === true, JSON.stringify(ra.result));
    check('M1 A 已就绪', await waitPath(A, tabA, '/A'));

    const rb = await rpc(B, 'ui.new_tab', { url: `${base}/B` });
    tabB = rb.result && rb.result.tab;
    check('M1 B 建标签页成功', rb.ok && !!tabB, JSON.stringify(rb));
    check('M1 B 的标签页**不**抢视野', rb.ok && rb.result.shown === false, JSON.stringify(rb.result));

    const la = await rpc(A, 'ui.list_tabs', {});
    const mineA = (la.result.tabs || []).filter((t) => t.mine).map((t) => t.id);
    check('M1 A 看到 mine 只有自己的', mineA.length === 1 && mineA[0] === tabA, JSON.stringify(mineA));
    const lb = await rpc(B, 'ui.list_tabs', {});
    const mineB = (lb.result.tabs || []).filter((t) => t.mine).map((t) => t.id);
    check('M1 B 看到 mine 只有自己的', mineB.length === 1 && mineB[0] === tabB, JSON.stringify(mineB));
    const visible = (lb.result.tabs || []).filter((t) => t.active).map((t) => t.id);
    check('M1 人眼前的页面仍是 A 的那个', visible.length === 1 && visible[0] === tabA, JSON.stringify(visible));
    check('M1 B 已就绪', await waitPath(B, tabB, '/B'));
  }

  // ---- M2/M3 省略 tab 时各打各的 ----
  stage('M2');
  console.log('\n[M2] 省略 tab 参数 → 打到自己的页面，别人的一动不动');
  {
    const ta = await rpc(A, 'ui.get_tree', {});
    check('M2 A 不传 tab 读到的是自己的页面', JSON.stringify(ta.result || {}).includes('A'), '');
    const refA = await findRef(A, tabA, (n) => n.id === 't' || n.role === 'textbox');
    const refB = await findRef(B, tabB, (n) => n.id === 'b' || String(n.label || '') === '按钮');
    check('M2 两边都能定位到目标元素', !!refA && !!refB, refA + ' / ' + refB);

    const typeA = await rpc(A, 'ui.act', { action: 'type', target: refA, text: 'from-A' });
    check('M2 A 打输入成功', typeA.ok && typeA.result.success !== false, JSON.stringify(typeA).slice(0, 160));
    await sleep(150);
    check('M2 A 的输入落在 A 的页面', (await text(A, tabA, 'document.getElementById("t").value')) === 'from-A');
    check('M2 B 的页面没有被写脏', (await text(B, tabB, 'document.getElementById("t").value')) === '', '');

    const clickB = await rpc(B, 'ui.act', { action: 'click', target: refB });
    check('M2 B 点击成功', clickB.ok && clickB.result.success !== false, JSON.stringify(clickB).slice(0, 160));
    await sleep(150);
    check('M2 B 的点击落在 B 的页面', (await text(B, tabB, 'document.getElementById("r").textContent')) === 'clicked-by-B');
    check('M2 A 的页面没有被点', (await text(A, tabA, 'document.getElementById("r").textContent')) === 'idle');
  }

  // ---- M4 真并发 ----
  stage('M4');
  console.log('\n[M4] 两个会话同时干活（各自页面里连续动作，同时进行），结果不串台');
  {
    // 注意：这里**不是**两个 agent 往同一个输入框里并发输入 —— 那本来就该互相踩
    // （值校验会如实报 "input not verified"）。真实的并发形态是：各在各的页面上。
    const runA = (async () => {
      for (let i = 0; i < 5; i++) {
        const r = await rpc(A, 'ui.evaluate', { js: 'window.__n=(window.__n||0)+1;void 0' });
        if (!r.ok) return false;
        await sleep(60);
      }
      return true;
    })();
    const runB = (async () => {
      for (let i = 0; i < 5; i++) {
        const r = await rpc(B, 'ui.evaluate', { js: 'window.__m=(window.__m||0)+1;void 0' });
        if (!r.ok) return false;
        await sleep(60);
      }
      return true;
    })();
    const [okA, okB] = await Promise.all([runA, runB]);
    check('M4 两个会话并行跑完各自的 5 步', okA && okB, JSON.stringify({ okA, okB }));
    const na = await text(A, tabA, 'window.__n||0');
    const nb = await text(B, tabB, 'window.__m||0');
    check('M4 A 的页面只被自己动过（5 次）', na === 5, String(na));
    check('M4 B 的页面只被自己动过（5 次）', nb === 5, String(nb));

    // 再加一组：并发做真实动作（一边点击一边输入），验证互不阻塞
    const refA2 = await findRef(A, tabA, (n) => n.id === 'b' || String(n.label || '') === '按钮');
    const t0 = Date.now();
    const both = await Promise.all([
      rpc(A, 'ui.act', { action: 'click', target: refA2 }),
      rpc(B, 'ui.evaluate', { js: 'document.getElementById("t").value.length' }),
    ]);
    check('M4 并发的一个动作 + 一次读取都成功', both.every((r) => r.ok), JSON.stringify(both.map((r) => r.ok)));
    check('M4 并发没有被串行化到不可用（<3s）', Date.now() - t0 < 3000, (Date.now() - t0) + 'ms');
    await sleep(200);
    check('M4 A 的点击生效', (await text(A, tabA, 'document.getElementById("r").textContent')) === 'clicked-by-A', '');
  }

  // ---- M5 目标被别人关掉：明确报错，不许就近挑一个 ----
  stage('M5');
  console.log('\n[M5] 自己的标签页被**别人**关掉 → 明确报错（不许在别人的页面上继续执行）');
  {
    // 关的人是 A —— 这才是危险场景：B 什么都没做，它的页面却消失了。
    const close = await rpc(A, 'ui.close_tab', { tab: tabB });
    check('M5 A 关掉了 B 的标签页', close.ok && close.result.ok === true, JSON.stringify(close));
    const after = await rpc(B, 'ui.get_tree', {});
    check('M5 B 的下一次调用报错而不是打到别人的页面上',
      after.ok === false && /gone|does not exist/i.test(after.error || ''), JSON.stringify(after).slice(0, 200));
    // 自救路径不能被自己挡住：new_tab / list_tabs 必须仍然可用
    const rec = await rpc(B, 'ui.new_tab', { url: `${base}/B2` });
    check('M5 报错之后仍能自救（ui.new_tab 可用）', rec.ok && !!rec.result.tab, JSON.stringify(rec).slice(0, 160));
    tabB = rec.result && rec.result.tab;
    await waitPath(B, tabB, '/B2');
    check('M5 自救后的新标签页能正常读', (await rpc(B, 'ui.get_tree', {})).ok);
    // 自己关掉自己的页 = 明确的"我不用了" → 之后照浏览器惯例落到当前可见页
    const selfClose = await rpc(B, 'ui.close_tab', { tab: tabB });
    check('M5 自己关自己的页成功', selfClose.ok && selfClose.result.ok === true, JSON.stringify(selfClose));
    const next = await rpc(B, 'ui.get_tree', {});
    check('M5 自己关掉之后不报错（落回可见页，浏览器惯例）', next.ok && !!next.result.tree, JSON.stringify(next).slice(0, 160));
    const rec2 = await rpc(B, 'ui.new_tab', { url: `${base}/B3` });
    tabB = rec2.result.tab;
    await waitPath(B, tabB, '/B3');
  }

  // ---- M6 只换目标、不换视野 ----
  stage('M6');
  console.log('\n[M6] switch（set_active_tab show:false）只换目标，不动人眼前的页面');
  {
    const before = (await rpc(A, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    const sw = await rpc(A, 'ui.set_active_tab', { tab: tabB, show: false });
    check('M6 switch 成功且标记为不显示', sw.ok && sw.result.shown === false, JSON.stringify(sw).slice(0, 160));
    const after = (await rpc(A, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    check('M6 可见页面没有变化', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    const mine = (await rpc(A, 'ui.list_tabs', {})).result.tabs.filter((t) => t.mine).map((t) => t.id);
    check('M6 A 的目标已经换成 B 的那个页面', mine.length === 1 && mine[0] === tabB, JSON.stringify(mine));
    // 换回来，别影响后面的收尾
    await rpc(A, 'ui.set_active_tab', { tab: tabA, show: false });
  }

  // ---- M7 自报家门 → 自动工作区 ----
  stage('M7');
  console.log('\n[M7] hello 之后第一次动手：拿到自己的空白工作页，人的页面一动不动');
  const C = new Browser(WS_PORT);
  await C.ready();
  {
    const hello = await rpc(C, 'ui.hello', { label: 'Probe-C' });
    check('M7 hello 被接受并回执', hello.ok && hello.result && hello.result.ok === true, JSON.stringify(hello).slice(0, 160));
    const humanBefore = (await rpc(A, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    const first = await rpc(C, 'ui.get_tree', {});
    const ws = first.result && first.result.workspace;
    check('M7 第一次调用自动开了工作页并给一次性提示', !!ws && ws.created === true, JSON.stringify(ws).slice(0, 220));
    check('M7 提示说明了怎么读用户的页面', !!ws && /group .?human/i.test(ws.hint || ''), ws && ws.hint);
    const url = first.result && first.result.context && first.result.context.url;
    check('M7 工作页是空白页（不是人正在看的那一页）', url === 'about:blank', String(url));
    const humanAfter = (await rpc(A, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active).map((t) => t.id);
    check('M7 人眼前的页面没有被换掉', JSON.stringify(humanBefore) === JSON.stringify(humanAfter),
      JSON.stringify({ humanBefore, humanAfter }));
    const own = (await rpc(C, 'ui.list_tabs', {})).result.tabs.find((t) => t.mine);
    check('M7 工作页归在自己的组里', !!own && own.group_kind === 'agent' && own.group_label === 'Probe-C',
      JSON.stringify(own));
  }

  // ---- M8 每组上限 ----
  stage('M8');
  console.log('\n[M8] 组有上限：满了拒绝 + 给出可关闭清单；关掉一页就能继续');
  {
    let full = null;
    for (let i = 0; i < 10 && !full; i++) {
      const r = await rpc(C, 'ui.new_tab', { url: `${base}/C${i}` });
      if (!r.ok) full = r;
    }
    check('M8 超过上限时 new_tab 被拒绝', !!full && /full/i.test(full.error || ''), JSON.stringify(full).slice(0, 200));
    check('M8 拒绝回执带 reason / limit / 可关闭清单',
      !!full && full.data && full.data.reason === 'group-full' && full.data.limit === 4 &&
      Array.isArray(full.data.tabs) && full.data.tabs.length > 0, JSON.stringify(full && full.data).slice(0, 240));
    const g = (await rpc(C, 'ui.list_tabs', {})).result.groups.find((x) => x.mine);
    check('M8 list_tabs 事先报出本组用量与上限', !!g && g.count === g.limit && g.limit === 4, JSON.stringify(g));
    const victim = full.data.tabs[0].tab;
    const closed = await rpc(C, 'ui.close_tab', { tab: victim });
    const reopened = await rpc(C, 'ui.new_tab', { url: `${base}/C-again` });
    check('M8 关掉一页之后可以继续开', closed.ok && closed.result.ok === true && reopened.ok,
      JSON.stringify({ closed: closed.result, reopened: reopened.result }).slice(0, 200));
  }

  // ---- M9 组与组之间互不影响 ----
  stage('M9');
  console.log('\n[M9] 一个组满载不影响别人；分组清单各自独立');
  {
    const aOpen = await rpc(A, 'ui.new_tab', { url: `${base}/A-still-works` });
    check('M9 A 仍然能开新页', aOpen.ok, JSON.stringify(aOpen).slice(0, 160));
    const groups = (await rpc(A, 'ui.list_tabs', {})).result.groups || [];
    const labels = groups.map((x) => x.label).sort();
    check('M9 三个组各自独立存在', labels.length >= 3 && labels.indexOf('Probe-C') >= 0, JSON.stringify(labels));
    const mineA = groups.filter((x) => x.mine).map((x) => x.label);
    check('M9 每个连接只把自己那一组算作 mine', mineA.length === 1 && mineA[0] !== 'Probe-C', JSON.stringify(mineA));
    const all = (await rpc(A, 'ui.list_tabs', {})).result.tabs;
    check('M9 每个标签页都带归属', all.every((t) => typeof t.group === 'string' && t.group.length > 0),
      JSON.stringify(all.map((t) => t.group)));
  }
  C.close();

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
  A.close(); B.close(); server.close();
  guard.killChild(child);
  await sleep(300);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

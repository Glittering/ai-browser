// e2e/input_routing_ws.cjs —— 收不到输入的时候，**不许说成功**
//
// Run: npm run input_routing
//      端口默认 9256/9257（两个实例）；占用时给 AI_BROWSER_INPUT_ROUTING_PORT=9400。
//
// # 为什么单独一个套件
//
// 判据与补救（给那一页补一发 CDP 焦点伪造）都在默认配置里跑，那份证据在
// multiagent 的 M11 —— 它要的是"后台页点得动"。这个套件钉的是**另外半边**：
// 补救做不到时要如实失败，而且失败要说清"什么都没发生"。这半边只能在
// **关掉补救**的进程里跑，而 env 是 spawn 时定的，没法在同一个实例里切换 ——
// 所以这里起两个 Electron，各带一种配置。
//
// # 两个配置各自要证的事
//
//   [A] AI_BROWSER_INPUT_FOCUS=0 —— 只关掉"补那一招"，不关掉"别说谎"。
//       后台页（自报 hidden）的点击必须：拒绝 + 页面一动不动 + 文案点名开关；
//       阳性对照：把它顶到人眼前（AI_BROWSER_FOCUS 照旧是 auto）之后，**同一发**
//       点击就落地了 —— 这证明拒绝的判据是"那一页收不收得到"，不是动作链路坏了。
//       顺手验一条文案里的出路是真出路：JS 路径（ui.evaluate）在 hidden 页照样写得进。
//
//   [B] AI_BROWSER_FOCUS=never —— 连产品平时给活动页的那一招都不许用。这是
//       2026-11-03 实测里**证伪**掉"活动页一定 visible"那一格的那次运行：
//       never 下活动页自己也是 hidden，模拟输入同样被丢弃，而旧回执照样写
//       success:true。那种组合下 ui.act 结构性地做不到，只能如实失败。
//
// ⚠️ 两个子进程都跑在**隐藏窗口**下（_window_mode.cjs）。窗口一旦真显示过，
// 页面就一路 visible，这两种失败都不会再出现 —— 那是正确行为，不是这个套件要测的。

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
// 端口跟着 security 的规矩走：**不用 AI_BROWSER_PORT**。run_all 是按
// `BASE_PORT + 套件序号` 连续分配端口的，而这个套件要两个实例 —— 用 +1 就会撞上
// 下一个套件。自己占一段（默认 9256/9257），要换给 `AI_BROWSER_INPUT_ROUTING_PORT`。
const PORT = Number(process.env.AI_BROWSER_INPUT_ROUTING_PORT) || 9256;
const PORT_B = PORT + 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const fails = [];
let STAGE = 'init';
const stage = (s) => { STAGE = s; };
{
  const wd = setTimeout(() => {
    console.error(`\n!! WATCHDOG: 全程超过 180s，卡在 [${STAGE}] —— 这个阶段的 RPC 没返回`);
    console.error('   （这个套件要起**两个** Electron，预算比单实例的套件宽）');
    guard.killAll();
    process.exit(9);
  }, 180000);
  if (wd.unref) wd.unref();
}
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

// 一个按钮 + 一个输入框，各自把结果写在**页面自己**身上。回执说 success 与否都由
// 这两处读回来判：本套件要钉的正是"回执与页面现实对不对得上"。
const PAGE = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>
<h1 id="who">${name}</h1>
<button id="b" onclick="document.getElementById('r').textContent='clicked'">按钮</button>
<div id="r">idle</div>
<input id="t" value="">
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const name = String(req.url || '/').replace(/^\/|\/$/g, '') || 'x';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE(name));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/** 起一个带指定 env 的实例，并把"连上的是不是它"核对掉。 */
async function spawnInstance(port, extraEnv) {
  const env = { ...process.env, ...windowEnv('input_routing'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.AI_BROWSER_USER_DATA = path.join(os.tmpdir(), `ai-browser-e2e-input-${port}`);
  if (!await harness.waitPortFree(port, 15000)) throw new Error('端口 ' + port + ' 被占用 —— 给一个 AI_BROWSER_INPUT_ROUTING_PORT');
  const child = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env });
  const lines = [];
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push(l); if (lines.length > 200) lines.splice(0, lines.length - 200); });
  child.__stderrLines = lines;
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  const b = new Browser(port);
  await b.ready(10000);
  await harness.assertIdentity(b, child, 'input_routing');
  return { child, b };
}

async function call(b, method, params = {}) {
  const msg = await b.call(method, params);
  if (msg && msg.error) return { ok: false, error: msg.error.message, data: msg.error.data };
  return { ok: true, result: msg && msg.result !== undefined ? msg.result : msg };
}
const text = async (b, tab, js) => (await call(b, 'ui.evaluate', { tab, js })).result?.value;

async function waitPath(b, tab, want, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (String(await text(b, tab, 'location.pathname')) === want) return true;
    await sleep(120);
  }
  return false;
}

/** 语义树里找 ref（agent 用的就是这条路，写死 'b'/'t' 会测不到读层）。 */
async function findRef(b, tab, matcher) {
  const r = await call(b, 'ui.get_tree', { tab });
  if (!r.ok) return null;
  const walk = (n) => {
    if (!n) return null;
    if (matcher(n)) return n.id;
    for (const c of (n.children || [])) { const f = walk(c); if (f) return f; }
    return null;
  };
  return walk(r.result && r.result.tree);
}

/** 开两页：第一页自动显示（占住"人眼前"），第二页明确 show:false = 本套件的主角。 */
async function openPair(b, base, tag) {
  const r1 = await call(b, 'ui.new_tab', { url: `${base}/${tag}-front` });
  const front = r1.result && r1.result.tab;
  const r2 = await call(b, 'ui.new_tab', { url: `${base}/${tag}-back`, show: false });
  const back = r2.result && r2.result.tab;
  const ready = !!front && !!back && await waitPath(b, front, `/${tag}-front`) && await waitPath(b, back, `/${tag}-back`);
  return { front, back, ready };
}

function teardown(inst) {
  try { inst.b.close(); } catch (_) { /* 已经断了 */ }
  guard.killChild(inst.child);
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${base}`);

  // ---- [A] 补救关掉：退路是如实报错，不是假装成功 ----
  stage('A:spawn');
  console.log('\n[A] AI_BROWSER_INPUT_FOCUS=0：不补救，但也不许说谎');
  {
    const inst = await spawnInstance(PORT, { AI_BROWSER_INPUT_FOCUS: '0' });
    const b = inst.b;
    stage('A:checks');
    await call(b, 'ui.hello', { label: 'Input-A' });
    const pair = await openPair(b, base, 'off');
    check('A 两页就绪（前台页 + 出生起就在后台的那一页）', pair.ready, JSON.stringify(pair).slice(0, 200));
    const vis = await text(b, pair.back, 'document.visibilityState');
    check('A 前提：后台那一页自报 hidden', vis === 'hidden', String(vis));

    const ref = await findRef(b, pair.back, (n) => n.id === 'b' || String(n.label || '') === '按钮');
    check('A 读层不受可见性影响（get_tree 照样拿得到 ref）', !!ref, String(ref));
    const refused = await call(b, 'ui.act', { action: 'click', target: ref, tab: pair.back });
    check('A 补救关掉时点击**如实失败**（success:false + input_blocked:true）',
      refused.ok && refused.result && refused.result.success === false && refused.result.input_blocked === true,
      JSON.stringify(refused.result || refused.error).slice(0, 240));
    check('A 文案点名是开关关掉的，而不是含糊地说"页面不可达"',
      refused.ok && /AI_BROWSER_INPUT_FOCUS=0/.test(refused.result.error || ''),
      String(refused.result && refused.result.error).slice(0, 200));
    check('A **什么都没发生**：页面里的计数器仍是 idle（旧形态这里是 idle + success:true）',
      (await text(b, pair.back, 'document.getElementById("r").textContent')) === 'idle',
      String(await text(b, pair.back, 'document.getElementById("r").textContent')));

    // 出路得是真的出路：错误文案推荐 JS 路径，那它在 hidden 页必须真的能用。
    const jsWrite = await call(b, 'ui.evaluate', { tab: pair.back, js: 'document.getElementById("t").value="走JS写进"; document.getElementById("t").value' });
    check('A 出路之一（JS 路径）在 hidden 页照样写得进',
      jsWrite.ok && jsWrite.result && jsWrite.result.value === '走JS写进', JSON.stringify(jsWrite.result || jsWrite.error).slice(0, 200));

    // 阳性对照：置顶走的是 AI_BROWSER_FOCUS（这里仍是 auto），于是这一页开始收得到，
    // 刚才被拒绝的**同一发**点击立刻落地。拒绝跟着页面状态走，不是动作链路坏了。
    await call(b, 'ui.set_active_tab', { tab: pair.back });
    await sleep(250);
    const after = await call(b, 'ui.act', { action: 'click', target: ref, tab: pair.back });
    check('A 阳性对照：顶到人眼前（拿到焦点伪造）之后同一发点击落地',
      after.ok && after.result.success !== false
      && (await text(b, pair.back, 'document.getElementById("r").textContent')) === 'clicked',
      JSON.stringify({ res: after.result || after.error, r: await text(b, pair.back, 'document.getElementById("r").textContent') }).slice(0, 240));
    teardown(inst);
    await sleep(400);
  }

  // ---- [B] AI_BROWSER_FOCUS=never：连活动页都收不到，只能说 ----
  stage('B:spawn');
  console.log('\n[B] AI_BROWSER_FOCUS=never：这一发结构性地做不到，回执必须跟着现实');
  {
    const inst = await spawnInstance(PORT_B, { AI_BROWSER_FOCUS: 'never' });
    const b = inst.b;
    stage('B:checks');
    await call(b, 'ui.hello', { label: 'Input-B' });
    const pair = await openPair(b, base, 'never');
    check('B 两页就绪', pair.ready, JSON.stringify(pair).slice(0, 200));
    const rows = ((await call(b, 'ui.list_tabs', {})).result.tabs || []);
    const activeId = (rows.filter((t) => t.active)[0] || {}).id;
    check('B 有一页是"人眼前那一页"（下面要打的正是它）', !!activeId, JSON.stringify(rows.map((t) => [t.id, t.active])).slice(0, 200));
    // 证伪的那一格：活动页也报 hidden。以前据此推断"活动页一定 visible"，
    // 于是这一发点击被丢弃却回了 success:true。
    const visActive = await text(b, activeId, 'document.visibilityState');
    check('B 前提：AI_BROWSER_FOCUS=never 下**活动页也自报 hidden**', visActive === 'hidden', String(visActive));

    const ref = await findRef(b, activeId, (n) => n.id === 'b' || String(n.label || '') === '按钮');
    const refused = await call(b, 'ui.act', { action: 'click', target: ref, tab: activeId });
    check('B 活动页的点击也如实失败（不再谎报 success:true）',
      refused.ok && refused.result && refused.result.success === false && refused.result.input_blocked === true,
      JSON.stringify(refused.result || refused.error).slice(0, 240));
    check('B 文案点名 AI_BROWSER_FOCUS=never（调用方据此知道是配置组合，不是站点故障）',
      refused.ok && /AI_BROWSER_FOCUS=never/.test(refused.result.error || ''),
      String(refused.result && refused.result.error).slice(0, 200));
    check('B 页面一动不动：回执说没送达，页面也说没发生',
      (await text(b, activeId, 'document.getElementById("r").textContent')) === 'idle',
      String(await text(b, activeId, 'document.getElementById("r").textContent')));

    const refIn = await findRef(b, activeId, (n) => n.id === 't' || n.role === 'textbox');
    const typed = await call(b, 'ui.act', { action: 'type', target: refIn, text: '打不进', tab: activeId });
    check('B 键入同样如实失败，而且输入框是空的（键盘路径不是漏网的那一条）',
      typed.ok && typed.result.success === false && typed.result.input_blocked === true
      && (await text(b, activeId, 'document.getElementById("t").value')) === '',
      JSON.stringify({ res: typed.result || typed.error, v: await text(b, activeId, 'document.getElementById("t").value') }).slice(0, 240));
    teardown(inst);
    await sleep(400);
  }

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
  }
  server.close();
  guard.killAll();
  await sleep(300);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

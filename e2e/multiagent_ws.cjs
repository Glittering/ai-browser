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
// 后面几条是同一套归属机制长出来的新责任（2026-11-03 对照 Chromium 之后补）：
//   M8b 组满时页面自己弹窗：牺牲品的排除条件（写了一半的页不许关，宁可超限）
//   M10 声音只跟人眼前那一页：agent 的后台页不出声，但**照旧在播**（静音 ≠ 暂停）
//   M11 后台那一页也收得到受信输入：M2/M8b 不再需要先把页顶到人眼前才点得动
//
// ⚠️ 这个套件是**隐藏窗口**跑的（见 _window_mode.cjs）—— 那正是多 agent 的真实形态，
// 也正是 M11 那条缺陷只在其中现形的形态。可见窗口里所有页都收得到输入，测不出来。
//
// Run: npm run multiagent

const { windowEnv } = require('./_window_mode.cjs');
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

// 会弹一屏的页面（M8b 用）。弹的是**自己**：这样每一代弹窗都还带着 #pop，
// 第二轮"全部有草稿"的实验能从刚弹出来的那一页继续发起。
// __c / __r 是负证据用的：click 落没落地、window.open 返回了什么，只看
// list_tabs 分不出"没执行"和"执行了但主进程没建页"这两种完全不同的坏。
const POPUP_PAGE = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>
<h1 id="who">${name}</h1>
<button id="pop" onclick="window.__c=(window.__c||0)+1;window.__r='-';try{var w=window.open('/popup-child','_blank');window.__r=w?'win':'null'}catch(e){window.__r='THROW:'+e.message}return false;">弹一屏</button>
<input id="t" value="">
</body></html>`;

/**
 * 一段真的能播出的声音（8k 采样 / mono / 16bit / 8s 正弦，循环）。
 *
 * 存在的理由只有一个：M10 要证明"被按住的页"是**还在播、只是不出声**，而不是被
 * 顺手暂停了 —— 后者会让 agent 看到的 currentTime 停住，那是另一种完全不同的故障，
 * 而光看 list_tabs 的 muted 字段分不出这两种。
 *
 * 长度必须**远长过一次观测**：早先做 0.4s 的循环，currentTime 在两次采样之间绕回
 * 起点（实测 0.4 → 0.391 → 0.173），于是"仍在播"被读成"暂停"，红的是断言自己。
 * 8 秒是这个阶段时长的十倍，绕不回。
 */
function wavDataUri() {
  const rate = 8000;
  const n = Math.floor(rate * 8);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  }
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

// 播放由 #play 的 click 触发：Chromium 的自动播放策略要真实用户手势，而
// ui.act 走的正是 CDP 受信输入（等价于真人点）。
//
// 顺手给这一页加了 autoplay —— 但**没有**放开策略：手势到底有没有传到页面，
// 由负证据说：click 没带手势又被拦时 play() 会 reject，window.__p 就写成
// 'err:...'，下面第一条断言立刻红。所以这一条同时在钉"受信输入真的进了这一页"。
const AUDIO_PAGE = (wav) => `<!doctype html><html><head><meta charset="utf-8"><title>audio</title></head><body>
<h1 id="who">audio</h1>
<audio id="a" src="${wav}" loop autoplay controls></audio>
<button id="play" onclick="var p=document.getElementById('a').play();p&&p.then?p.then(function(){window.__p='ok'},function(e){window.__p='err:'+e.message}):window.__p='ok'">放</button>
<input id="t" value="">
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const wavUri = wavDataUri();
    const s = http.createServer((req, res) => {
      const name = String(req.url || '/').replace(/^\/|\/$/g, '') || 'x';
      const html = name.indexOf('popup') === 0 ? POPUP_PAGE(name)
        : name === 'audio-host' ? AUDIO_PAGE(wavUri)
          : PAGE(name);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function spawnElectron(port) {
  const env = { ...process.env, ...windowEnv('multiagent'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
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

  // ---- M8b 弹窗挤位时的牺牲品 ----
  //
  // 组满时**页面自己**弹出来的窗口不能拒绝（站点的脚本在等它），只能挑一页关掉。
  // 2026-11-03 对照 Chrome Memory Saver 的"不许丢弃"清单，把两条本项目真实存在的
  // 状态补成排除条件：有没提交的输入、有进行中的下载。我们的淘汰是整页关闭，比
  // discard 狠（discard 之后表单还在，我们一关全没），所以保护只能更紧不能更松。
  stage('M8b');
  console.log('\n[M8b] 组满时页面弹窗：先牺牲最久没用的；写了一半的页不许被牺牲，宁可超限');
  {
    const D = new Browser(WS_PORT);
    await D.ready(10000);
    await rpc(D, 'ui.hello', { label: 'Probe-D' });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const r = await rpc(D, 'ui.new_tab', { url: `${base}/popup-host-${i}` });
      ids.push(r.result && r.result.tab);
      await sleep(60);          // usedAt 要有先后，不能让四页撞在同一毫秒
    }
    const [t1, t2, t3, t4] = ids;
    for (const tid of ids) {
      // 必须等**真的文档**到位：new_tab 会先停在占位页，而占位页里没有 #pop / #t。
      // 不等就点，findRef 会拿到 null，ui.act 报"element not found"，整段变成假红。
      if (!await waitPath(D, tid, `/popup-host-${ids.indexOf(tid)}`)) {
        check('M8b 页面已到位 ' + tid, false, String(await text(D, tid, 'location.href')));
      }
    }
    const gOf = async () => {
      const lt = (await rpc(D, 'ui.list_tabs', {})).result;
      const g = (lt.groups || []).find((x) => x.mine);
      return { id: g && g.id, count: g && g.count, limit: g && g.limit, tabs: lt.tabs || [], evicted: lt.evicted || [] };
    };
    // 每一发 ui.act 打的都是**没顶到人眼前**的那一页 —— 这里不再先把页提上去。
    //
    // 早先这一段每条 act 之前都要 set_active_tab 一次，因为隐藏窗口里没置顶的那一页
    // 根本收不到受信输入（2026-11-03 实测：hidden 文档上 CDP 的 mousePressed/mouseReleased
    // 与键盘事件被整条丢弃，click 静默无效、type 报 Input not verified）。那个缺陷
    // 自己的钉子在 M11，修好之后这里必须回到"自然形态"：**置顶是个 workaround，
    // 留着它就等于把这一段的输入路径永远测成前台那一条**（淘汰保护照旧测得到，
    // 但"后台页点不动"这个故障会重新变得无人看守）。
    const g0 = await gOf();
    check('M8b 先把本组填到上限', ids.every(Boolean) && g0.count === 4 && g0.limit === 4, JSON.stringify(g0).slice(0, 200));

    // ① 阳性对照：什么都没保护时，行为照旧 —— 最久没用的那一页被挤掉
    const popRef = await findRef(D, t4, (n) => n.id === 'pop' || String(n.label || '') === '弹一屏');
    check('M8b 弹窗按钮定位得到（不是占位页上的空气）', !!popRef, String(popRef));
    const click1 = await rpc(D, 'ui.act', { action: 'click', target: popRef, tab: t4 });
    await sleep(1200);
    const g1 = await gOf();
    const alive1 = new Set(g1.tabs.map((t) => t.id));
    const mine1 = g1.tabs.filter((t) => t.group === g1.id);
    const popupTab = mine1.filter((t) => t.id !== t1 && t.id !== t2 && t.id !== t3 && t.id !== t4)[0];
    // 负证据：只看 list_tabs 分不出"onclick 没跑"和"onclick 跑了但主进程没建页"，
    // 而这两种坏的修法完全不同（前者是点击/读层的问题，后者是 setWindowOpenHandler）。
    const neg1 = await text(D, t4, 'JSON.stringify({c:window.__c,r:window.__r,href:location.pathname})');
    check('M8b 弹窗真的开出来了（拒绝等于让站点的流程断在半路）',
      click1.ok && !!popupTab && /\/popup-child/.test(String(popupTab.url || '')),
      JSON.stringify({ click: click1.result || click1.error, neg: neg1, mine: mine1.map((t) => t.url) }).slice(0, 320));
    check('M8b 什么都没保护时照旧牺牲最久没用的那一页，并且**说出来**',
      g1.evicted.length === 1 && g1.evicted[0].tab === t1 && g1.evicted[0].reason === 'group-full'
      && !alive1.has(t1) && g1.count === 4,
      JSON.stringify({ evicted: g1.evicted, count: g1.count }).slice(0, 220));

    // ② 剩下三页都写了一半 → 没有任何一页可以牺牲 → 宁可超限
    //    ① 失败时退回用 t4 当弹窗源：这一段要证的是"保护生效"，不是"弹窗能开"；
    //    直接 crash 会把后面的 M10 一起吞掉，什么证据都留不下。
    const p1 = popupTab ? popupTab.id : t4;
    if (popupTab && !await waitPath(D, p1, '/popup-child')) check('M8b 弹窗那一页已到位', false, String(await text(D, p1, 'location.href')));
    // 草稿要写在**每一页**上，包括当弹窗源的那一页 p1。② 要证的是"没有任何一页可以
    // 牺牲 → 宁可超限"，而 p1 是 window.open 刚建出来的新页、按 usedAt 排最新 ——
    // 不给它也造一份草稿，它就永远是那个可以被关掉的牺牲品，断言红得和 protecting
    // 无关。（早先靠 raise(p1) 把它变成 activeTab 来排除，那是 workaround 顺带遮住的
    // 另一件事，现在显式做。）
    const draftTabs = p1 === t4 ? [t2, t3, t4] : [t2, t3, t4, p1];
    const typedAll = [];
    for (const tid of draftTabs) {
      const ref = await findRef(D, tid, (n) => n.id === 't' || n.role === 'textbox');
      typedAll.push(await rpc(D, 'ui.act', { action: 'type', target: ref, text: '写到一半', tab: tid }));
    }
    check('M8b 可牺牲的页每一页都造出草稿', typedAll.every((r) => r.ok && r.result.success !== false),
      JSON.stringify(typedAll.map((r) => r.result || r.error)).slice(0, 240));
    check('M8b 草稿真的在页面里（不是只记在账上）',
      (await text(D, t2, 'document.getElementById("t").value')) === '写到一半', '');
    const popRef2 = await findRef(D, p1, (n) => n.id === 'pop' || String(n.label || '') === '弹一屏');
    check('M8b 弹窗那一页也带按钮（每一代都能再弹一次）', !!popRef2, String(popRef2));
    await rpc(D, 'ui.act', { action: 'click', target: popRef2, tab: p1 });
    await sleep(1200);
    const g2 = await gOf();
    const alive2 = new Set(g2.tabs.map((t) => t.id));
    check('M8b 有没提交输入的页不被牺牲（组里每一页都写着草稿 → 一页都没关）',
      g2.evicted.length === 0 && alive2.has(t2) && alive2.has(t3) && alive2.has(t4) && alive2.has(p1),
      JSON.stringify({ evicted: g2.evicted, alive: Array.from(alive2) }).slice(0, 240));
    check('M8b 宁可超限：本组页数超了上限，也不吞掉正在写的东西',
      g2.count > g2.limit, JSON.stringify({ count: g2.count, limit: g2.limit }));
    check('M8b 弹窗仍然开出来了（保护的是牺牲品，不是弹窗本身）', g2.count === g2.limit + 1,
      JSON.stringify({ count: g2.count }).slice(0, 120));

    // ③ 拒绝清单要把带草稿的页标出来：agent 自己决定关哪一页时，这个信息是它唯一能用的
    const rejected = await rpc(D, 'ui.new_tab', { url: `${base}/popup-denied` });
    const list = (rejected.data && rejected.data.tabs) || [];
    check('M8b 满了的拒绝回执把"关掉会丢东西"的页标出来',
      !rejected.ok && rejected.data && rejected.data.reason === 'group-full'
      && list.filter((x) => x.draft === true).length >= draftTabs.length, JSON.stringify(list).slice(0, 260));
    D.close();
  }

  // ---- M10 声音只跟人眼前那一页 ----
  //
  // 所有标签页挂在同一个窗口上，可见性靠 z 序，**音频没有 z 序**：agent 在后台开的
  // 视频页会一路响，而人找不到那个喇叭去关它。这条钉住三件事，缺一件就是另一种坏：
  //   agent 的后台页不出声 / 人眼前那一页照旧出声 / 按住的是**输出**而不是播放本身
  // 第三件最容易写错成 pause —— 那样 agent 看到的 currentTime 会停住，等于把
  // "听不见"变成"没在跑"，而后者是站点故障，不是我们要造出来的。
  stage('M10');
  console.log('\n[M10] agent 的后台页不出声，但照旧在播（静音 ≠ 暂停）');
  {
    const F = new Browser(WS_PORT);
    await F.ready(10000);
    await rpc(F, 'ui.hello', { label: 'Probe-F' });
    const rAud = await rpc(F, 'ui.new_tab', { url: `${base}/audio-host` });
    const aud = rAud.result && rAud.result.tab;
    check('M10 agent 的后台页已就绪', !!aud && await waitPath(F, aud, '/audio-host'), JSON.stringify(rAud).slice(0, 160));

    const rowOf = async (conn, id) => (await rpc(conn, 'ui.list_tabs', {})).result.tabs.find((t) => t.id === id) || {};
    check('M10 后台页从出生就被按住声音', (await rowOf(F, aud)).muted === true,
      JSON.stringify(await rowOf(F, aud)).slice(0, 200));
    // "人的那一页"按**组**取，不按 activeTab 取：M8b 之后 activeTab 可能停在某个
    // agent 的页上，而那一页照规则是被按住的 —— 拿它当"人的页"会红得莫名其妙。
    const ltf = (await rpc(F, 'ui.list_tabs', {})).result;
    const humanTab = (ltf.tabs || []).filter((t) => t.group === 'human')[0] || null;
    check('M10 有一页是人的组（启动那一页不会被淘汰：人组不限数）', !!humanTab,
      JSON.stringify((ltf.tabs || []).map((t) => t.group)).slice(0, 200));
    check('M10 人的那一页没有 muted（人组永远不按住声音）', !!humanTab && humanTab.muted === undefined,
      JSON.stringify(humanTab).slice(0, 200));

    const playRef = await findRef(F, aud, (n) => n.id === 'play' || String(n.label || '') === '放');
    // 这里先把它顶到人眼前，是为了**声音归属**那条断言（顶上去 → 放开），不是为了
    // 把点击送进去 —— 后台页点得不动是 M11 的事。Chromium 的自动播放策略只认真实
    // 手势，而 ui.act 走的正是 CDP 受信输入，所以两种置顶状态下这一发都该点得动。
    const raised = await rpc(F, 'ui.set_active_tab', { tab: aud });
    await sleep(250);
    check('M10 顶到人眼前 → 声音放开', raised.ok && (await rowOf(F, aud)).muted === undefined,
      JSON.stringify(await rowOf(F, aud)).slice(0, 200));
    const played = await rpc(F, 'ui.act', { action: 'click', target: playRef, tab: aud });
    check('M10 播放按钮点得动', played.ok, JSON.stringify(played).slice(0, 160));
    await sleep(500);
    check('M10 play() 没有被自动播放策略拦掉', (await text(F, aud, 'window.__p')) === 'ok',
      String(await text(F, aud, 'window.__p')));

    // 回到后台：把**别的**那一页顶上去。优先用人的那一页（它不会被按住，
    // 顶它不影响任何断言），极端情况下（人的页被关光）退回任意一个非 aud 的页。
    const otherTab = humanTab
      || (await rpc(F, 'ui.list_tabs', {})).result.tabs.filter((t) => t.id !== aud)[0];
    await rpc(F, 'ui.set_active_tab', { tab: otherTab.id });
    await sleep(250);
    check('M10 回到后台 → 重新按住', (await rowOf(F, aud)).muted === true,
      JSON.stringify(await rowOf(F, aud)).slice(0, 200));
    const c0 = Number(await text(F, aud, 'document.getElementById("a").currentTime'));
    await sleep(500);
    const c1 = Number(await text(F, aud, 'document.getElementById("a").currentTime'));
    check('M10 **被按住声音的页仍在播**（currentTime 往前走 = 按住的是输出，不是暂停）',
      (await rowOf(F, aud)).muted === true && c1 > c0, JSON.stringify({ muted: true, c0, c1 }));

    const back = await rpc(F, 'ui.set_active_tab', { tab: aud });
    await sleep(250);
    const c2 = Number(await text(F, aud, 'document.getElementById("a").currentTime'));
    check('M10 再顶回人眼前 → 放开，而播放一次都没被打断',
      (await rowOf(F, aud)).muted === undefined && c2 > c1, JSON.stringify({ c1, c2 }).slice(0, 160));
    // 人的那一页**永远**不按住：它是"人在用"的意思，不是"哪个 agent 的"。
    // 上面已经在两种置顶状态下各查过一次，这里只补一句：刚被顶下去当背景的那一页
    // 如果是人的页，它照旧不出声状态不受影响。
    if (humanTab) {
      check('M10 人的那一页当背景时也不按住', (await rowOf(F, humanTab.id)).muted === undefined,
        JSON.stringify(await rowOf(F, humanTab.id)).slice(0, 200));
    }

    // 关掉的如果是"人眼前那一页"，声音的归属要跟着重算（判据换人）
    await rpc(F, 'ui.set_active_tab', { tab: aud });
    await rpc(F, 'ui.close_tab', { tab: aud });
    await sleep(200);
    const nowActive = (await rpc(F, 'ui.list_tabs', {})).result.tabs.filter((t) => t.active)[0];
    check('M10 关掉有声的那一页之后，新的人眼前那一页不出声状态正常',
      !!nowActive && nowActive.muted === undefined, JSON.stringify(nowActive).slice(0, 200));
    F.close();
  }

  // ---- M11 没顶到人眼前的那一页也收得到受信输入 ----
  //
  // 这一条是上面所有阶段的地基，也是 2026-11-03 逐杠杆实测换来的结论：窗口从未显示过
  // 时，页面自报 document.visibilityState:'visible' 的**唯一条件**是它拿到过 CDP 的
  // Emulation.setFocusEmulationEnabled（产品平时只给活动页）；没拿到的页一律 hidden，
  // 而 Chromium 对 hidden 文档**丢弃**模拟输入 —— 不报错、不排队、也不改投给别人。
  // 旧形态最坏的地方不是丢，是丢完还回 `{success:true, clicked_via:'cdp-click'}`。
  //
  // 所以这一段要的四件事按顺序是：前提成立（那一页自己报 hidden）→ 动作真的落进
  // **那一页** → 别的地方一动不动（丢弃不是改投）→ 闸门没有顺手搬动任何东西
  // （z 序 / activeTab / 声音归属照旧）。判据在 shared/input_routing.cjs，
  // 执行侧的钉子是 PM-51..59，这里钉的是真实 Chromium。
  stage('M11');
  console.log('\n[M11] 后台那一页不用顶到人眼前：点击与键入照样落地，而且没人被搬动');
  {
    const G = new Browser(WS_PORT);
    await G.ready(10000);
    await rpc(G, 'ui.hello', { label: 'Probe-G' });
    // 本组的**第一**页会自动显示出来（替换启动页），M11 要的是"出生起就在后台"的那种
    // 形状 —— 所以先占住前台那一页，再开第二页并明确 show:false。
    const rFront = await rpc(G, 'ui.new_tab', { url: `${base}/front-page` });
    const front = rFront.result && rFront.result.tab;
    check('M11 前台那一页已就绪（它是"什么都没串台"的对照组）',
      !!front && await waitPath(G, front, '/front-page'), JSON.stringify(rFront).slice(0, 160));
    const rBack = await rpc(G, 'ui.new_tab', { url: `${base}/back-page`, show: false });
    const back = rBack.result && rBack.result.tab;
    check('M11 后台页已就绪，且回执明说它没显示',
      !!back && rBack.result.shown === false && await waitPath(G, back, '/back-page'),
      JSON.stringify(rBack).slice(0, 160));

    // 前提必须是**页面自己报的** hidden，而不是测试假设的"它在后台"。这一句红了
    // 说明环境变了（比如窗口被谁显示出来了），后面所有断言都失去意义。
    const visBefore = await text(G, back, 'document.visibilityState');
    check('M11 前提：后台那一页自报 hidden（旧形态下它的输入会被整条丢弃）',
      visBefore === 'hidden', String(visBefore));

    const tabs0 = (await rpc(G, 'ui.list_tabs', {})).result.tabs || [];
    const active0 = tabs0.filter((t) => t.active).map((t) => t.id);
    const refBtn = await findRef(G, back, (n) => n.id === 'b' || String(n.label || '') === '按钮');
    const refIn = await findRef(G, back, (n) => n.id === 't' || n.role === 'textbox');
    check('M11 后台页的按钮与输入框定位得到（读层本来就不受可见性影响）', !!refBtn && !!refIn, refBtn + ' / ' + refIn);

    const clickBack = await rpc(G, 'ui.act', { action: 'click', target: refBtn, tab: back });
    check('M11 后台页点击回执 success，而且没有 input_blocked',
      clickBack.ok && clickBack.result && clickBack.result.success !== false && clickBack.result.input_blocked !== true,
      JSON.stringify(clickBack.result || clickBack.error).slice(0, 220));
    check('M11 **点击真的落进那一页**（旧形态这里是 idle，而回执照样写 success）',
      (await text(G, back, 'document.getElementById("r").textContent')) === 'clicked-by-back-page',
      String(await text(G, back, 'document.getElementById("r").textContent')));

    const typeBack = await rpc(G, 'ui.act', { action: 'type', target: refIn, text: '后台也写', tab: back });
    check('M11 后台页的键入也落地（键盘事件与鼠标事件是两条 CDP 路径）',
      typeBack.ok && typeBack.result.success !== false
      && (await text(G, back, 'document.getElementById("t").value')) === '后台也写',
      JSON.stringify({ res: typeBack.result || typeBack.error, val: await text(G, back, 'document.getElementById("t").value') }).slice(0, 240));

    // 负证据①：丢弃**不是**改投。事件被吞掉的时候，对照组那一页一次都没被点过。
    check('M11 对照页一动不动（串台会表现成"success 而且别人的页面变了"，那是另一种坏）',
      (await text(G, front, 'document.getElementById("r").textContent')) === 'idle',
      String(await text(G, front, 'document.getElementById("r").textContent')));

    // 负证据②：闸门只补焦点态，不搬东西。置顶 / 改 activeTab / 改声音归属都不在
    // 它的授权范围内（PM-58 在桩里钉同一条，这里钉真实窗口）。
    const tabs1 = (await rpc(G, 'ui.list_tabs', {})).result.tabs || [];
    const rowBack = tabs1.find((t) => t.id === back) || {};
    check('M11 activeTab 没有被换走（修输入不是把页搬到人眼前）',
      JSON.stringify(tabs1.filter((t) => t.active).map((t) => t.id)) === JSON.stringify(active0),
      JSON.stringify({ before: active0, after: tabs1.filter((t) => t.active).map((t) => t.id) }));
    check('M11 那一页仍在后台、仍被按住声音（补焦点态不许顺带改这两件事）',
      rowBack.active !== true && rowBack.muted === true, JSON.stringify(rowBack).slice(0, 200));
    const ws = await rpc(G, 'ui.window', {});
    check('M11 窗口照旧没有显示出来（这是"后台跑"的全部意义）',
      ws.ok && ws.result && ws.result.visible === false, JSON.stringify(ws.result || ws.error).slice(0, 200));

    await rpc(G, 'ui.close_tab', { tab: back });
    await rpc(G, 'ui.close_tab', { tab: front });
    G.close();
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

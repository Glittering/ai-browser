// e2e/layout_ws.cjs —— 几何不变量：窗口 / 视图 / 渲染视口三者必须对得上
//
// 事故（2026-10-25，用户截图）：窗口约 1300×807，但页面被画进左上角约 325×260 的
// 一块区域，其余全白；标签栏整条空白。DOM、evaluate、CDP 截图全都正常 ——
// **只有窗口像素是错的**，所以既有观测口一条都发现不了。
//
// 成因是"窗口几何变了，合成器手里的 surface 还是旧尺寸"：合成器把那张大图缩进新的
// bounds，于是内容看起来缩成一小块。这类脱节有个可判定的特征 ——
//   view.bounds ≠ 内容区  ，或  window.innerWidth ≠ view.bounds.width
// 本套件把这三条等式钉住，并在窗口缩放之后重新校验（缩放是最常见的触发点）。
//
// Run: npm run layout

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9245;
const TAB_BAR_HEIGHT = 74;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>layout</title>
<style>html,body{margin:0;height:100%;font:14px/1.6 -apple-system,sans-serif}
#box{position:fixed;left:0;top:0;width:100%;height:100%;box-sizing:border-box;
padding:16px;border:2px solid #4e6ef2}
</style></head><body><div id="box">
<h1>几何不变量</h1>
<p>这一页铺满视口，边框贴着视口四边。如果页面被缩放渲染（surface 尺寸和 bounds
对不上），内容就会缩进左上角 —— 那时 window.innerWidth 与视图宽度不再相等。</p>
</div></body></html>`;

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
  const childEnv = { ...process.env, ...windowEnv('layout'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-layout-${port}`);
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

async function metrics(b, tab) {
  const r = unwrap(await b.call('ui.evaluate', {
    tab,
    js: 'JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})',
  }));
  const raw = r && r.value !== undefined ? r.value : r;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
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
  await harness.assertIdentity(b, child, 'layout');

  const tab = unwrap(await b.call('ui.new_tab', { url: URL })).tab;
  for (let i = 0; i < 60; i++) {
    const m = await metrics(b, tab);
    if (m && m.iw > 0) break;
    await sleep(200);
  }
  await sleep(600);

  console.log('\n[G1] 初始状态：视图几何 == 内容区，渲染视口 == 视图宽');
  {
    const g = unwrap(await b.call('ui.window_bounds', {}));
    const view = (g.views || {})[tab] || {};
    const content = g.content || {};
    check('G1 能读到窗口与视图几何', !!g.bounds && !!view.width, JSON.stringify({ bounds: g.bounds, view }));
    check('G1 视图从标签栏下方开始', view.y === TAB_BAR_HEIGHT, `view.y=${view.y} tabBar=${TAB_BAR_HEIGHT}`);
    check('G1 视图宽度 == 窗口内容宽度', view.width === content.width, `view=${view.width} content=${content.width}`);
    check('G1 视图高度 == 内容高度 - 标签栏', view.height === content.height - TAB_BAR_HEIGHT,
      `view=${view.height} expected=${content.height - TAB_BAR_HEIGHT}`);
    const m = await metrics(b, tab);
    check('G1 渲染视口宽度 == 视图宽度（被缩放时这条会先红）', m && Math.abs(m.iw - view.width) <= 2,
      `innerWidth=${m && m.iw} view=${view.width}`);
    check('G1 devicePixelRatio 是正常值（2 或 1）', m && (m.dpr === 2 || m.dpr === 1), `dpr=${m && m.dpr}`);
  }

  console.log('\n[G2] 窗口缩放后：三条等式仍然成立（这是"内容缩成一小块"的高发路径）');
  for (const size of [{ width: 800, height: 600 }, { width: 1100, height: 900 }, { width: 900, height: 700 }]) {
    unwrap(await b.call('ui.window_bounds', { set: size }));
    // 收敛式等待：产品在几何变化后 160ms 会做一次"渲染视口是否跟上"的确认，
    // 跟不上就 hard 重绘一次。这里允许它在 1.5s 内收敛，但**必须收敛**。
    let g = null;
    let m = null;
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      g = unwrap(await b.call('ui.window_bounds', {}));
      m = await metrics(b, tab);
      const v = (g.views || {})[tab] || {};
      if (m && v.width && Math.abs(m.iw - v.width) <= 2) break;
    }
    const view = (g.views || {})[tab] || {};
    const content = g.content || {};
    check(`G2 ${size.width}x${size.height} 视图跟随窗口`,
      view.width === content.width && Math.abs(view.height - (content.height - TAB_BAR_HEIGHT)) <= 2,
      `view=${view.width}x${view.height} content=${content.width}x${content.height}`);
    check(`G2 ${size.width}x${size.height} 渲染视口跟随视图`,
      m && Math.abs(m.iw - view.width) <= 2, `innerWidth=${m && m.iw} view=${view.width}`);
  }

  console.log('\n[G3] 自检报告布局一致（layout_ok），且渲染口径与视图吻合');
  {
    const p = unwrap(await b.call('ui.paint_check', { tab }));
    check('G3 paint_check 判定 ok', p.verdict === 'ok', `verdict=${p.verdict} reason=${p.reason}`);
    check('G3 layout_ok = true', p.layout_ok !== false, JSON.stringify({ layout_ok: p.layout_ok, bounds: p.bounds, expected: p.expected }));
    const view = ((unwrap(await b.call('ui.window_bounds', {})).views || {})[tab]) || {};
    check('G3 自检的 iw 与视图宽度一致（这条能抓住 surface 尺寸脱节）',
      Math.abs((p.dom && p.dom.iw) - view.width) <= 2,
      `iw=${p.dom && p.dom.iw} view=${view.width}`);
  }

  console.log('\n[G4] 不抽搐：导航期间视图几何一次都不许变，高频路径不许用 hard 重绘');
  {
    const hardBefore = ((unwrap(await b.call('ui.window_bounds', {})).repaints) || {}).hard || 0;
    // 直接量"大一下小一下"：导航过程中每 25ms 采一次视图宽度，必须是同一个数。
    const samples = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        try {
          const g = unwrap(await b.call('ui.window_bounds', {}));
          const v = (g.views || {})[tab] || {};
          if (v.width) samples.push(v.width + 'x' + v.height);
        } catch (_) { /* 采集中导航可能短暂不可读 */ }
        await sleep(25);
      }
    })();
    unwrap(await b.call('ui.navigate', { tab, url: URL + '?again=1' }));
    await sleep(1200);
    stop = true;
    await sampler;
    const uniq = [...new Set(samples)];
    check('G4 导航期间视图尺寸保持恒定（变了就是肉眼可见的"大一下小一下"）',
      uniq.length === 1, `samples=${samples.length} distinct=${JSON.stringify(uniq)}`);

    const g = unwrap(await b.call('ui.window_bounds', {}));
    const rp = g.repaints || {};
    check('G4 这次导航没有触发 hard 重绘（1px 微调会重排两次）',
      (rp.hard || 0) - hardBefore === 0, `hard before=${hardBefore} after=${JSON.stringify(rp)}`);

    // soft 重绘：不许改几何（这是它和 hard 的唯一区别）
    const before = ((unwrap(await b.call('ui.window_bounds', {})).views || {})[tab]) || {};
    const r = unwrap(await b.call('ui.repaint', { tab }));
    await sleep(200);
    const after = ((unwrap(await b.call('ui.window_bounds', {})).views || {})[tab]) || {};
    check('G4 ui.repaint 默认不改几何（soft）',
      before.width === after.width && before.height === after.height,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    check('G4 ui.repaint 报告 ok', r && r.ok === true, JSON.stringify(r && r.error));

    // hard 才是"允许重排两次"的那一档，且必须回到原尺寸
    const r2 = unwrap(await b.call('ui.repaint', { tab, hard: true }));
    await sleep(250);
    const after2 = ((unwrap(await b.call('ui.window_bounds', {})).views || {})[tab]) || {};
    const rp2 = unwrap(await b.call('ui.window_bounds', {})).repaints || {};
    check('G4 hard 重绘后几何回到原值（1px 微调是临时的）',
      after2.width === before.width && after2.height === before.height,
      `${JSON.stringify(before)} -> ${JSON.stringify(after2)}`);
    check('G4 hard 重绘被计数（可被回归/诊断观察）', (rp2.hard || 0) >= 1, JSON.stringify(rp2));
    check('G4 hard 重绘回执 ok', r2 && r2.ok === true, JSON.stringify(r2 && r2.error));
  }

  console.log('\n[G5] 导航本身不触发任何重绘（invalidate 在导航时会画出一帧小尺寸画面）');
  {
    const before = (unwrap(await b.call('ui.window_bounds', {})).repaints) || { soft: 0, hard: 0 };
    for (let i = 0; i < 2; i++) {
      unwrap(await b.call('ui.navigate', { tab, url: URL + '?n=' + i }));
      await sleep(1500);
    }
    const after = (unwrap(await b.call('ui.window_bounds', {})).repaints) || { soft: 0, hard: 0 };
    check('G5 两次导航没有增加 soft 重绘（导航路径不挂重绘）',
      (after.soft || 0) - (before.soft || 0) === 0,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    check('G5 两次导航没有增加 hard 重绘', (after.hard || 0) - (before.hard || 0) === 0,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    const p = unwrap(await b.call('ui.paint_check', { tab }));
    check('G5 导航后画面依然正常（不做重绘也不会留旧画面）',
      p.verdict === 'ok' && p.layout_ok !== false, `verdict=${p.verdict} layout_ok=${p.layout_ok}`);
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

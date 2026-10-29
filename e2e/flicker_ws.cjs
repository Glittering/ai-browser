// e2e/flicker_ws.cjs —— 帧级回归：加载时画面不许"缩一下"
//
// 事故（2026-10-25，连续四轮才定位）：每次页面加载后会出现 1–3 帧（≈50ms）
// **整页被画进左上角、内容宽度只剩 25%**，然后恢复正常。用户原话：
// "刷新 baidu 还是会先左上角特别小，闪一下，然后正常。"
//
// 真因：白屏自检截图用了 `Page.captureScreenshot({clip:{...,scale:0.25}})`。
// 带 clip.scale 会让 Chromium **按该比例临时重建 surface**，而自检恰好跑在
// did-finish-load+450ms —— 那几十毫秒里窗口正在重新合成，于是把那张 1/4 的图
// 贴上 1–3 帧。尺度（25%）与时机（+500ms）两处都对得上。
//
// 这个套件存在的原因：**这类缺陷只有窗口像素看得见**（DOM / evaluate / CDP 截图
// 全都正常），而人眼只能事后抱怨。所以要有一台"帧级相机"来钉住它。
//
// 关键实现细节（都踩过）：
//   - 必须用 avfoundation 固定 60fps 录；`screencapture -v` 是变帧率（~28.7fps），
//     50ms 的闪现会被整段丢掉 —— 前四轮就是这么"录不到"的。
//   - 裁切坐标必须按 Quartz 实时 rect 现算；写死坐标时窗口一动就拍到静态画面，
//     结果是**假阴性**（我因此误判过两轮）。
//   - 必须自检采集有效性：如果整段 ink 完全不变，说明压根没拍到目标窗口，此时
//     任何"通过"都不算数。
//
// 依赖：ffmpeg + 带 Quartz/PIL 的 python3（缺了就 SKIP，不误报红）。
// Run: npm run flicker

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9246;
const LOGS_PER_RUN = 3;            // 重复几次加载（每次都该"零缩小帧"）
const REC_SECS = 6;               // 每轮录多久（要覆盖"起播抖动 + reload + 重绘"）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

let PASS = 0, FAIL = 0, SKIP = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}
function skip(why) { SKIP++; console.log(`  SKIP | ${why}`); }

// 铺满视口 + 上下两条**每次加载换颜色**的通栏色带：
//   - 通栏 → 非白像素的外接宽度恒为 100%，"缩成一小块"就是一道干净的尺子（100% vs 25%）
//   - 换色 → 静态页重复 reload 时像素也会真的变化，否则"采集有效性"无从判断
//     （第 2/3 轮正因为页面完全一致，帧间差异 = 0，被误判成"没拍到窗口"）
function fixtureBody() {
  const h1 = Math.floor(Math.random() * 360);
  const h2 = (h1 + 137) % 360;
  return `<!doctype html><html><head><meta charset="utf-8"><title>flicker</title>
<style>html,body{margin:0;height:100%;font:14px/1.7 -apple-system,sans-serif;
background:#fff;color:#111}
.bar{height:14px}
.bar.bottom{position:fixed;left:0;right:0;bottom:0}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 6px}</style></head><body>
<div class="bar" style="background:hsl(${h1},65%,45%)"></div>
<div style="padding:24px">
<h1>帧级回归用的页面</h1>
<p>这一页铺满视口。加载完成后只要有任意一帧被画成"缩小版"，非白像素的外接宽度
就会掉到 60% 以下 —— 套件据此判定失败。上下两条通栏色带是量尺。</p>
<p>页面本身不需要特殊结构：这类缺陷发生在合成层，和 DOM 无关。</p>
<p>${'正文占位。'.repeat(80)}</p>
</div>
<div class="bar bottom" style="background:hsl(${h2},65%,45%)"></div>
</body></html>`;
}

// 挑一个"装得下这套工具"的 python：系统自带的通常没 pyobjc/PIL。
// 顺序：显式指定 → PATH 上的几个 → 已知的托管环境（开发机专用，找不到就 SKIP）。
function pickPython() {
  const cands = [
    process.env.AIB_PYTHON,
    'python3',
    '/Users/Zhuanz/.workbuddy/binaries/python/envs/default/bin/python',
    'python3.13',
    'python3.12',
    '/opt/homebrew/bin/python3',
  ].filter(Boolean);
  for (const p of cands) {
    const r = spawnSync(p, ['-c', 'import Quartz, numpy, PIL'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fixtureBody());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnApp(port) {
  const electronPath = require('electron');
  const childEnv = {
    ...process.env,
    ...windowEnv('flicker'),
    AI_BROWSER_PORT: String(port),
    AI_BROWSER_WATCHDOG: '0',
    // 让窗口自己浮到前台（我们的 focus 策略里 always 会 show/moveTop/focus）——
    // 不依赖 AppleScript 授权，也不会误激活别的 Electron 应用。
    AI_BROWSER_FOCUS: 'always',
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-flicker-${port}`;
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

let PY = null;                       // 由 pickPython() 决定，见 main()
function py(args) {
  const r = spawnSync(PY, [path.join(__dirname, '_win_capture.py'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function main() {
  // 依赖检查：缺一个就 SKIP（这套件是取证工具，不该在缺工具时误报红）
  PY = pickPython();
  if (!PY) {
    console.log('\n[SKIP] 找不到带 pyobjc/PIL/numpy 的 python，跳过帧级回归');
    console.log('       安装：pip3 install pyobjc-framework-Quartz pillow numpy');
    console.log('       或指定：AIB_PYTHON=/path/to/python npm run flicker');
    process.exit(0);
  }
  const probe = py(['probe']);
  let pj = null;
  try { pj = JSON.parse(probe.out.split('\n').pop()); } catch (e) { /* 下面统一处理 */ }
  if (!pj || !pj.ok) {
    console.log(`\n[SKIP] 取证工具不可用（${(pj && pj.reason) || probe.out || probe.err}）`);
    console.log('       需要 ffmpeg + pyobjc-framework-Quartz + pillow + numpy');
    if (pj && pj.reason === 'MISSING_FFMPEG') console.log('       brew install ffmpeg');
    process.exit(0);
  }
  console.log(`python ${PY}\nffmpeg screen 设备索引 ${pj.device}`);

  const server = await startServer();
  const URL = `http://127.0.0.1:${server.address().port}/`;
  console.log(`fixture @ ${URL}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const child = await spawnApp(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'flicker');

  // 先建一个 tab（这一步同时把窗口叫到前台，AI_BROWSER_FOCUS=always）
  const tab = unwrap(await b.call('ui.new_tab', { url: URL })).tab;
  await sleep(1500);
  const g = unwrap(await b.call('ui.window_bounds', {}));
  const view = (g.views || {})[tab] || {};
  console.log(`窗口 ${JSON.stringify(g.bounds)}  视图 ${view.width}x${view.height}`);

  for (let round = 1; round <= LOGS_PER_RUN; round++) {
    const mov = `/tmp/ai-browser-flicker-${round}.mov`;
    const framesDir = `/tmp/_flicker_frames_r${round}`;
    // 每轮现读几何：裁切区域由 App 自己给（view.getBounds + contentBounds 偏移），
    // 不猜标题栏/tab 栏高度 —— 猜错就会拍到隔壁窗口，量出来的全是垃圾。
    const gb = unwrap(await b.call('ui.window_bounds', {}));
    const vb = (gb.views || {})[tab] || null;
    if (!vb) { skip(`第 ${round} 轮：拿不到视图 bounds`); continue; }
    const offsetY = Math.max(0, (gb.content.y - gb.bounds.y));
    const geom = JSON.stringify({ view: vb, offsetY });
    // 录制必须在后台跑：它要覆盖"加载发生的那一刻"，所以先开录、再触发 reload。
    const rec = spawn(PY, [path.join(__dirname, '_win_capture.py'), 'record',
      String(child.pid), String(REC_SECS), mov, geom]);
    let recOut = '';
    rec.stdout.on('data', (d) => { recOut += String(d); });
    rec.stderr.on('data', (d) => { recOut += String(d); });
    // 等它拿到窗口、并真正开始录（record 会在 spawn ffmpeg 之前打印 recording）
    for (let i = 0; i < 80 && !recOut.includes('recording'); i++) await sleep(50);
    if (recOut.includes('NO_WINDOW')) { rec.kill(); skip(`第 ${round} 轮：找不到窗口`); continue; }
    if (recOut.includes('NOT_ONSCREEN')) { rec.kill(); skip(`第 ${round} 轮：窗口不在屏幕上，录制无意义`); continue; }
    if (!recOut.includes('recording')) { rec.kill(); skip(`第 ${round} 轮：录制没起来 ${recOut.slice(0, 120)}`); continue; }

    // 光"等 1.5 秒"不够：ffmpeg 从 spawn 到真正出帧有几百毫秒抖动，抖大一点
    // reload 就落在开录之前 —— 整段画面恒定，看起来像"没拍到窗口"（实测第 2 轮踩过）。
    // 所以按"文件真的在长"来确认已开录，再等 300ms 让首帧稳定。
    let recStarted = false;
    for (let i = 0; i < 120; i++) {
      try { if (fs.statSync(mov).size > 120000) { recStarted = true; break; } } catch (e) { /* 还没建 */ }
      await sleep(50);
    }
    if (!recStarted) { rec.kill(); skip(`第 ${round} 轮：录制文件没开始增长`); continue; }
    await sleep(300);
    unwrap(await b.call('ui.evaluate', { tab, js: 'location.reload()' }).catch(() => null));
    await new Promise((r) => rec.on('exit', r));

    const meta = recOut.split('\n').filter((l) => l.trim().startsWith('{'));
    const cropLine = meta.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).find((o) => o.crop);
    if (!cropLine) { skip(`第 ${round} 轮：拿不到裁切参数 ${recOut.slice(0, 120)}`); continue; }

    const an = py(['analyze', mov, cropLine.crop, framesDir]);
    let res = null;
    try { res = JSON.parse(an.out.split('\n').filter(Boolean).pop()); } catch (e) { /* 下面统一报错 */ }
    if (!res || !res.frames) { skip(`第 ${round} 轮：解帧失败 ${an.out.slice(0, 120)}`); continue; }

    console.log(`\n[R${round}] ${cropLine.video ? cropLine.video.join('x') + ' 裁剪 ' + cropLine.crop + ' → ' : ''}` +
      `frames=${res.frames} 内容宽最窄 ${res.cw_min}% @f${res.cw_min_frame} 帧间差异峰值 ${res.diff_max}（${res.changed_frames} 帧有变化）`);
    // 采集有效性：整段画面一帧都没变 = 没拍到目标窗口，此时的"通过"是假的。
    // 用帧间差异而不是 ink 波动 —— 静态页重复 reload 的 ink 可能一模一样。
    check(`R${round} 采集有效（拍到了目标窗口，画面有可见变化）`, (res.diff_max || 0) > 1.0,
      `diff_max=${res.diff_max} changed_frames=${res.changed_frames}`);
    check(`R${round} 加载过程中没有"缩成一小块"的帧`, res.tiny_count === 0,
      `tiny=${JSON.stringify(res.tiny)}`);
  }

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
    console.log(`\n取证：帧图在 /tmp/_flicker_frames_r*，视频在 /tmp/ai-browser-flicker-*.mov`);
    const lines = (child && child.__stderrLines) || [];
    if (lines.length) {
      console.log('  主进程最后 6 行：');
      for (const l of lines.slice(-6)) console.log('    | ' + l.slice(0, 180));
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

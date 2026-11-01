// e2e/shot_ws.cjs —— ui.screenshot 取帧档位的回归套件
//
// 事故（2026-11-02）：agent 在百度、dumate 的 tab 上截图，各拿到一句
// `captureScreenshot timeout after 20000ms — the page main thread is likely blocked`，
// 而屏幕上明明是一张正常画面 —— 用户那边看到的是"页面好好的，工具说截不到"。
//
// # 根因不是"主线程卡住"那么一句话（对照实测，四种组合全测）
//
//   屏幕上是这一页 + 空闲    ：capturePage 20ms ✓   CDP 61ms ✓
//   被兄弟视图盖住  + 空闲    ：capturePage 9ms ✓    CDP >12s ✗  ← 页面没忙，CDP 照样不返回
//   屏幕上是这一页 + 主线程占死：capturePage >20s ✗   CDP 等到松手才答（本套件 S1 实测）
//   被兄弟视图盖住  + 主线程占死：capturePage 18ms ✓   CDP >12s ✗
//
// CDP 的 Page.captureScreenshot 是**渲染进程主线程上的命令**（带 fromSurface:true 也只
// 是像素来源在合成器，接单仍在主线程），所以它对两种情况都答不出来：
//   ① 视图被同窗口另一张视图整个盖住 —— 永远等不到帧，页面空不空闲都一样；
//   ② 屏幕上那一页的主线程被脚本占死 —— 要等它松手。
// capturePage() 拷的是那张视图自己的合成表面，被盖住时 17ms 就回、而且是**活帧**。
// 所以档位由"它是不是屏幕上那一张"决定（page_manager._isCoveredByOtherTab），
// 另一档兜底 —— 而不是像以前那样只有一条路，把所有失败都推给"页面主线程卡住"。
//
// 现场（百度、dumate 那两次超时）是第 ① 格：agent 截的是**后台**标签页。
// 那一格现在由 surface 档秒级应答（S5）；第 ② 格没有秒级答案，本套件的断言落在
// "不再谎称截不到 + 等待有上界"（S1），不假装它变快了。
//
// 本套件钉住的事（都在**可见窗口**下跑，理由见 _window_mode.cjs）：
//   S1 屏幕上那一页 + 主线程占死 → 仍然给得出图（旧路径这里是一句 20s 超时，
//      比页面松手还慢就等于永远拿不到），且等待有上界
//   S2 机制对照：同一时刻排队要主线程的 evaluate 确实拿不到值 —— 反空过，
//      证明 S1 测的是"主线程占死"而不是"页面空闲"
//   S3 那一发 busy 循环确实跑过、也确实占了那么久（结束后 title 变成 busy-done）
//   S4 截到的位图是**这一页**的（主色调 = fixture 底色），且表面没有透明像素
//   S5 被盖住的 tab（现场就是这种）：surface 档秒回，给的正是它自己那一页的像素，
//      不是压在它上面的那一页；附属探测排不通时如实标 password_probe=skipped
//   S6 屏幕上 + 空闲：默认档与显式 surface 档给同一张画面（换档位不等于换内容）
//   S7 fullPage / clip / webp 只能由 CDP 应答 —— 语义要求，不是漏修
//   S8 点名 source=surface 时不许偷偷换档：成功或如实报错，二选一
//
// 自带 fixture、不依赖外网。Run: npm run shot

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const guard = require('./_spawn_guard.cjs');
const { analyzePngAlpha } = require('./_png_alpha.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9251;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

// /busy?ms=N —— 首屏画完（两帧 rAF）之后用 while 把渲染进程主线程占住 N 毫秒。
//   底色必须是纯色块：S4/S5 用"主色调"证明拿到的是这一页的帧，不是压在它上面的
//   另一个标签页的帧。
//   busy 一定放在两帧 rAF 之后：否则测的是"还没有帧"，不是"有帧但取不到"。
const BUSY = (ms) => `<!doctype html><html><head><meta charset="utf-8"><title>busy</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}</style></head><body>
<div style="position:absolute;left:400px;top:200px;width:300px;height:200px;background:#0000ff">忙</div>
<script>
requestAnimationFrame(function(){requestAnimationFrame(function(){
  var until=Date.now()+${ms};while(Date.now()<until){}
  document.title='busy-done';
});});
</script></body></html>`;

// /normal —— 空闲页（白底 + 深色正文），S6/S7 的对照组。
const NORMAL = `<!doctype html><html><head><meta charset="utf-8"><title>normal</title>
<style>body{margin:0;background:#fff;color:#222;font:14px/1.7 sans-serif;padding:24px}</style></head><body>
<h1>空闲页面</h1><p>这一页的主线程没有别的事，两档取帧都该立刻给得出同一张画面。</p>
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
      const u = String(req.url || '');
      let body = NORMAL;
      const m = /\/busy\?ms=(\d+)/.exec(u);
      if (m) body = BUSY(Number(m[1]));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnElectron(port) {
  const electronPath = require('electron');
  const childEnv = { ...process.env, ...windowEnv('shot'), AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  // ELECTRON_RUN_AS_NODE 会让二进制降级成 node REPL（只打印 Welcome to Node.js 就退出）
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = path.join(require('node:os').tmpdir(), `ai-browser-e2e-shot-${port}`);
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

// 等这一页**到位图里**（state=ready 且 URL 已经是目标页）：busy fixture 的阻塞从第二帧
// rAF 才开始，在它开始之前抢下发，才是"主线程占死但表面已经有帧"的那个时刻。
// 只看 readyState 会拍到 about:blank / loading.html 那两个占位页（它们早就 complete）。
async function waitShown(b, tab, wantUrl, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = unwrap(await b.call('ui.list_tabs', {}));
      const row = ((r && r.tabs) || []).find((t) => t.id === tab) || {};
      if (String(row.url || '').startsWith(wantUrl) && row.state === 'ready') return true;
    } catch (_) { /* 还在导航 */ }
    await sleep(120);
  }
  return false;
}

async function titleOf(b, tab) {
  try {
    const r = unwrap(await b.call('ui.list_tabs', {}));
    return String((((r && r.tabs) || []).find((t) => t.id === tab) || {}).title || '');
  } catch (_) { return ''; }
}

// 主色调里的第一个颜色（解不开就返回 null，让调用方判"解不开"而不是"颜色不对"）
function topColor(st) {
  if (!st || !st.ok || !st.dominant || !st.dominant.length) return null;
  return st.dominant[0].color;
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${base}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'shot');

  // 阻塞窗口取 14s：既明显短于 20s deadline（旧路径必然报超时），又留够
  // "截图回来之后还在阻塞里"的时间做 in-block 探针。
  const BUSY_MS = 14000;

  // =====================================================================
  // S1/S2/S3/S4：屏幕上是这一页 + 主线程被占死
  // =====================================================================
  // ⚠️ 实测更正（2026-11-02，见下面的计时）：裸 Electron 探针曾记下称"屏幕上那一页
  // 主线程占死时 CDP 3.9s 能给帧"，本套件里**复现不了** —— 单发 CDP 截图要等到页面
  // 主线程松手才答（shotMs ≈ 阻塞窗口剩余时间）。也就是说 Chromium 的
  // Page.captureScreenshot 即使带 fromSurface:true，仍然是渲染进程主线程上的命令。
  // 探针那次数值作废（当时的对照里另有并发请求，见 S2 的说明），这里以本套件为准。
  // 所以屏幕上那一页 + 主线程占死这一格，**没有**秒级答案；这条修复真正救的是
  // S5 那一格（被盖住的 tab —— 用户现场就是它）。本组断言的落点因此是：
  //   ① 不再谎称"截不到"（旧路径在 20s 报超时，比页面松手还慢就永远拿不到图）；
  //   ② 等待有上界（阻塞窗口 + 一点余量），而不是无限挂住。
  console.log('\n[S1-S4] 屏幕上那一页 + 主线程占死：给得出图，但确实要等页面松手');
  const busyUrl = `${base}/busy?ms=${BUSY_MS}`;
  const busyTab = unwrap(await b.call('ui.new_tab', { url: busyUrl, show: true })).tab;
  const shown = await waitShown(b, busyTab, busyUrl);
  check('S0 前置：这一页已经到位图里了（state=ready，不是还没开始导航）', shown, 'waitShown 超时');
  await sleep(450);   // 两帧 rAF + 进入 while 循环的时刻

  // 先单发截图 —— 计时必须是这一发自己的，不能和别的请求混在一起量
  // （上一版把 evaluate 和截图并发发出，两者的耗时互相污染，得出过一个假数值）。
  const t0 = Date.now();
  const shotRaw = await b.call('ui.screenshot', { tab: busyTab, format: 'png' }, 45000);
  const shotMs = Date.now() - t0;
  const shot = unwrap(shotRaw);
  console.log(`  · 单发截图计时：${shotMs}ms（阻塞窗口 ${BUSY_MS}ms）`);

  check('S1 主线程占死时 ui.screenshot 仍然成功（旧路径这里是一句 20s 超时）',
    shot && shot.ok === true, JSON.stringify(shot && shot.error));
  check('S1 屏幕上那一页由 CDP 档应答（surface 档在这一格同样要不到新帧，见探针表）',
    shot.source === 'cdp', `source=${shot.source} 用时 ${shotMs}ms`);
  check('S1 等待有上界：阻塞窗口 + 余量以内（不是无限挂住，也不比页面松手更慢半步）',
    shotMs <= BUSY_MS + 4000, `shotMs=${shotMs} BUSY_MS=${BUSY_MS}`);

  // in-block 探针：只有当截图真的在阻塞窗口**之内**回来时，"同一时刻 evaluate 排不通"
  // 才测得到东西。这一格如果等到松手才答，就没有 in-block 时刻可探 —— 明说，不硬造断言。
  if (shotMs < BUSY_MS - 2500) {
    const eT0 = Date.now();
    const evalRaw2 = await b.call('ui.evaluate', { tab: busyTab, js: '1+1' }, 30000);
    const evalMs2 = Date.now() - eT0;
    const evalVal2 = unwrap(evalRaw2);
    const evalErr2 = evalRaw2 && evalRaw2.error ? String(evalRaw2.error.message)
      : (evalVal2 && evalVal2.error ? String(evalVal2.error) : null);
    check('S1b 反空过：截图在阻塞窗口内回来后，同一时刻 evaluate 排不通（主线程确实被占着）',
      evalErr2 !== null || (evalVal2 && evalVal2.value !== 2), `err=${evalErr2} value=${JSON.stringify(evalVal2 && evalVal2.value)}`);
  } else {
    console.log(`  · S1b 跳过：这一发等到主线程松手才答（${shotMs}ms ≥ 窗口-2.5s），没有 in-block 时刻可探`);
  }

  const st = analyzePngAlpha(shot && shot.data);
  check('S4 截帧解得开（不是空图）', !!st.ok, JSON.stringify({ err: st.error, bytes: shot && shot.bytes }));
  check('S4 主色调是这一页的底色 #ff00ff —— 取到的不是压在它上面的那张视图',
    topColor(st) === '#ff00ff', `top=${topColor(st)} dominant=${JSON.stringify(st.dominant)}`);
  check('S4 表面里没有透明像素（别的标签页透不进来的那条不变量）',
    st.ok && st.transparent === 0, JSON.stringify({ colorType: st.colorType, transparent: st.transparent }));

  // busy 循环真的跑过：窗口结束后 title 会变成 busy-done（脚本最后一行）。
  await sleep(Math.max(0, BUSY_MS - shotMs + 1500));
  const doneTitle = await titleOf(b, busyTab);
  check('S3 那一发阻塞确实执行完了（title 变成 busy-done）',
    doneTitle === 'busy-done', `title=${doneTitle}`);

  // =====================================================================
  console.log('\n[S2] 机制对照：同一页面上排队要主线程的请求确实排不通（证明 S1 不是空环境）');
  // =====================================================================
  // Runtime.evaluate 和 Page.captureScreenshot 都是渲染进程主线程上的 CDP 命令。
  // 这一发把"队列真的被占死"这件事单独钉住：busy 期间 evaluate 拿不到值。
  const busy2Ms = 12000;
  const busy2Url = `${base}/busy?ms=${busy2Ms}`;
  const busy2Tab = unwrap(await b.call('ui.new_tab', { url: busy2Url, show: true })).tab;
  await waitShown(b, busy2Tab, busy2Url);
  await sleep(450);
  const e2T0 = Date.now();
  const evalRaw = await b.call('ui.evaluate', { tab: busy2Tab, js: '1+1' }, 30000);
  const evalMs = Date.now() - e2T0;
  const evalVal = unwrap(evalRaw);
  const evalErr = evalRaw && evalRaw.error ? String(evalRaw.error.message)
    : (evalVal && evalVal.error ? String(evalVal.error) : null);
  check('S2 反空过：busy 期间 evaluate 拿不到值（1+1 都算不出来 = 主线程确实被 while 占着）',
    evalErr !== null || (evalVal && evalVal.value !== 2), `err=${evalErr} value=${JSON.stringify(evalVal && evalVal.value)}`);
  check('S2 且它等到的是自己的超时，不是秒回（秒回说明 busy 还没开始）',
    evalMs >= 3000, `evalMs=${evalMs}`);
  try { await b.call('ui.close_tab', { tab: busy2Tab }); } catch (_) { /* 已经关掉了 */ }

  // =====================================================================
  console.log('\n[S5] 后台（被盖住）标签页：surface 档秒回，且不许拿成压在它上面那一页');
  // =====================================================================
  // 用户现场正是这样：活动 tab 是登录页，出问题的截图请求打在**后台**那个百度 tab 上。
  // 这里前台是一整屏白色（/normal），后台是整屏品红（/busy）—— 如果 surface 拿的是
  // "窗口上那块矩形现在显示的东西"，回执会是一张白图，而它不会报错。
  const front = unwrap(await b.call('ui.new_tab', { url: `${base}/normal`, show: true })).tab;
  const wasShown = await waitShown(b, front, `${base}/normal`);
  check('S5 前置：前台那一页（白底）已经在屏幕上', wasShown, 'waitShown 超时');
  const backMs = 9000;
  const backUrl = `${base}/busy?ms=${backMs}`;
  const back = unwrap(await b.call('ui.new_tab', { url: backUrl, show: false })).tab;
  await waitShown(b, back, backUrl);
  await sleep(450);
  const bT0 = Date.now();
  const backShot = unwrap(await b.call('ui.screenshot', { tab: back, format: 'png' }, 45000));
  const backShotMs = Date.now() - bT0;
  const bst = analyzePngAlpha(backShot && backShot.data);
  check('S5 后台 tab 在主线程占死时也截得到图', backShot.ok === true,
    JSON.stringify(backShot && backShot.error));
  check('S5 而且是被盖住那一档答的：source=surface、一次截图命令都不必等主线程',
    backShot.source === 'surface', `source=${backShot.source} 用时 ${backShotMs}ms`);
  check('S5 耗时是秒级（旧路径这里要空等一整个 20s deadline）',
    backShotMs < 6000, `shotMs=${backShotMs}`);
  // 附属探测在这一格才真的被测到：图已经到手（几十毫秒），而探密码框 / 读 dpr 的
  // evaluate 排在占死的主线程后面 —— 1.5s 就掐掉，如实标 skipped，绝不把这张好帧
  // 拖成挂住，也绝不把"没探成"说成"没有密码框"。
  check('S5 探测排不通时如实标 password_probe=skipped（不当成"没有密码框"）',
    backShot.password_probe === 'skipped',
    JSON.stringify({ probe: backShot.password_probe, warning: backShot.warning }));
  check('S5 且警告里说清"这一帧可能含已输入的密码"',
    /typed secrets/.test(String(backShot.warning || '')), JSON.stringify(backShot.warning));
  check('S5 dpr 由"位图宽 / 视图宽"算出（不必去问占死的主线程）',
    typeof backShot.device_pixel_ratio === 'number' && backShot.device_pixel_ratio > 0,
    JSON.stringify({ dpr: backShot.device_pixel_ratio, w: backShot.width, h: backShot.height }));
  check('S5 拿到的就是后台那一页的像素（品红，不是前台的白色）',
    topColor(bst) === '#ff00ff', `top=${topColor(bst)} dominant=${JSON.stringify(bst.dominant)}`);
  // 后台那一页的 busy 真的跑过（否则又是一条空断言）：窗口结束后 title 变 busy-done。
  await sleep(Math.max(0, backMs - backShotMs + 1200));
  check('S5 反空过：后台那一页的阻塞循环确实执行了（title=busy-done）',
    (await titleOf(b, back)) === 'busy-done', `title=${await titleOf(b, back)}`);

  // 反过来验一次"取对帧"：现在把 back 顶到屏幕前，front 变成被盖住的那一张。
  // 同一批视图、同一档 surface，颜色必须跟着视图走 —— 说明档位取的是**那张视图**的表面。
  unwrap(await b.call('ui.set_active_tab', { tab: back }));
  await sleep(400);
  const nowCovered = unwrap(await b.call('ui.screenshot', { tab: front, format: 'png' }, 45000));
  const ncst = analyzePngAlpha(nowCovered && nowCovered.data);
  check('S5b 换活动页后被盖住的是 front：它这一发主色调变成白（跟着视图，不跟着屏幕位置）',
    nowCovered.ok === true && nowCovered.source === 'surface' && topColor(ncst) === '#ffffff',
    JSON.stringify({ ok: nowCovered.ok, src: nowCovered.source, top: topColor(ncst) }));

  // =====================================================================
  console.log('\n[S6] 屏幕上 + 空闲：默认档与显式 surface 档给同一张画面');
  // =====================================================================
  unwrap(await b.call('ui.set_active_tab', { tab: front }));
  await sleep(300);
  const s = unwrap(await b.call('ui.screenshot', { tab: front, format: 'png' }, 45000));
  const c = unwrap(await b.call('ui.screenshot', { tab: front, format: 'png', source: 'surface' }, 45000));
  const sst = analyzePngAlpha(s && s.data);
  const cst = analyzePngAlpha(c && c.data);
  // 屏幕上是这一页 → auto 先走 CDP（这一档还会顺带把 dpr 探明白）；
  // 两档给的是同一块表面，所以尺寸/主色调必须一致 —— 换档位不等于换内容。
  check('S6 屏幕上那一页默认走 cdp 档', s.ok === true && s.source === 'cdp',
    JSON.stringify({ ok: s.ok, src: s.source, err: s.error }));
  check('S6 显式 source=surface 仍然工作（没有把另一档删掉）', c.ok === true && c.source === 'surface',
    JSON.stringify({ ok: c.ok, src: c.source, err: c.error }));
  check('S6 两档尺寸一致（同一块表面，只是取法不同）',
    sst.ok && cst.ok && sst.width === cst.width && sst.height === cst.height,
    JSON.stringify({ cdp: sst.width + 'x' + sst.height, surface: cst.width + 'x' + cst.height }));
  check('S6 两档主色调一致（都是这一页的白）', topColor(sst) === topColor(cst) && topColor(sst) === '#ffffff',
    `cdp=${topColor(sst)} surface=${topColor(cst)}`);
  check('S6 两档都给得出 dpr，调用方才能把像素坐标换算回页面坐标',
    typeof s.device_pixel_ratio === 'number' && s.device_pixel_ratio > 0
    && typeof c.device_pixel_ratio === 'number' && c.device_pixel_ratio > 0,
    JSON.stringify({ cdp: s.device_pixel_ratio, surface: c.device_pixel_ratio }));
  check('S6 空闲页的密码框探测照常给结论（skipped 只属于探不动的那些）',
    s.password_probe === undefined && c.password_probe === undefined,
    JSON.stringify({ cdp: s.password_probe, surface: c.password_probe }));

  // =====================================================================
  console.log('\n[S7] 必须问渲染进程的请求不许由 surface 档应答');
  // =====================================================================
  // fullPage 要 captureBeyondViewport（视口外的布局），clip 是文档坐标，webp 没有
  // 本地编码器 —— 这三样只能走 CDP，也就只能继续接受"主线程占住就要等"这个约束。
  const clipShot = unwrap(await b.call('ui.screenshot', { tab: front, clip: { x: 0, y: 0, width: 300, height: 200 } }, 45000));
  const fullShot = unwrap(await b.call('ui.screenshot', { tab: front, fullPage: true }, 45000));
  const webpShot = unwrap(await b.call('ui.screenshot', { tab: front, format: 'webp' }, 45000));
  check('S7 clip 请求走 cdp（本地裁剪会把文档坐标和当前视口混成一个坐标系）',
    clipShot.ok === true && clipShot.source === 'cdp',
    JSON.stringify({ ok: clipShot.ok, src: clipShot.source, err: clipShot.error }));
  check('S7 fullPage 请求走 cdp（位图里没有视口外的内容）',
    fullShot.ok === true && fullShot.source === 'cdp',
    JSON.stringify({ ok: fullShot.ok, src: fullShot.source, err: fullShot.error }));
  check('S7 webp 请求走 cdp（nativeImage 没有 toWebP）',
    webpShot.ok === true && webpShot.source === 'cdp',
    JSON.stringify({ ok: webpShot.ok, src: webpShot.source, err: webpShot.error }));

  // =====================================================================
  console.log('\n[S8] 点名档位就不许偷偷换档');
  // =====================================================================
  // 显式只要 surface 而它拿不到位图时，必须如实报错（换档=给一张调用方没要的图）。
  // 这里用"刚创建、还没画过的 tab"来造空表面。
  const fresh = unwrap(await b.call('ui.new_tab', { url: 'about:blank', show: false })).tab;
  const only = unwrap(await b.call('ui.screenshot', { tab: fresh, source: 'surface' }, 45000));
  check('S8 source=surface 时档位不会被偷偷换掉（成功或如实报错，二选一）',
    only.ok === true ? only.source === 'surface' : /no-surface-frame/.test(String(only.error)),
    JSON.stringify({ ok: only.ok, src: only.source, err: only.error }));

  // 未知/越界的 source 在规范化层就挡掉，不会走到取帧。
  const badSrc = unwrap(await b.call('ui.screenshot', { tab: front, source: 'screenshot' }, 45000));
  check('S8b 非法 source 直接报错（而不是当成 auto 悄悄取一张）',
    badSrc.ok === false && /source must be one of/.test(String(badSrc.error)),
    JSON.stringify({ ok: badSrc.ok, err: badSrc.error }));

  for (const t of [busyTab, front, back, fresh]) {
    try { await b.call('ui.close_tab', { tab: t }); } catch (_) { /* 已经关掉了 */ }
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

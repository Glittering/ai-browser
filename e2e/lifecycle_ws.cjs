// e2e/lifecycle_ws.cjs —— BrowserView 生命周期治理的回归套件（2026-10-30 白屏事故）。
//
// 事故：用户报"又白屏了"，截图标题栏正常、内容全白、底部一条深红横幅、左侧露一小块
// 橙棕。查 error.jsonl 发现同一个 uncaught_exception 反复 22 次：
//     Cannot read properties of undefined (reading 'isDestroyed') at pushNavState
// 根因（用真 Electron 探针实测，不是推测）：
//   - webContents.close()/destroy() 之后，BrowserView 对象还在，但 view.webContents
//     变成 undefined —— 裸写 `view.webContents.isDestroyed()` 就抛 TypeError；
//   - pushNavState 被 setInterval 每 1.5s 无条件调用，于是每 1.5s 崩一次：
//     崩溃 → uncaughtException → reportFatal → showErrorBanner → layoutWithBanner
//     → 又碰悬空视图 → 二次崩溃 → 进程半死（端口 listen 但 WS 握不上手）；
//   - tabBarView 没有 render-process-gone 监听、没有任何重建逻辑 → 标签栏永久空白；
//   - 横幅一旦挂上只能靠人点 × 收起 → 底部深红条挂了几小时，页面还被挤掉 34px。
//
// 修复后本套件用 AI_BROWSER_SELFTEST=chrome-gone 主动把 tabBarView.webContents 置为
// 悬空，验证三件事（缺一不可）：
//   L1 不再抛 uncaught_exception —— 否则进程会半死；
//   L2 出现 tabbar_rebuilt —— 证明视图真的被自愈重建，而不是"恰好没崩"；
//   L3 WS 仍然握得上、ui.server_info 正常 —— 证明进程没被二次崩溃打死；
//   L4 横幅自动收敛（第二个实例注入 fatal，短 autohide）—— 深红条不再永久挂着。
//
// 这些都是"底层不变量"：以前没有测试覆盖过"视图失效后主进程还能不能活"。
// 隐藏模式即可（chrome-gone 与窗口可见性无关；白屏自检跳过不影响本套件的判据）。
// Run: npm run lifecycle
'use strict';

const { windowEnv } = require('./_window_mode.cjs');
const harness = require('./_harness.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const BASE_PORT = Number(process.env.AI_BROWSER_PORT) || 9257;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

let PASS = 0, FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 起一个隔离实例：独立端口 + 独立 userData，日志不会和别的实例串。 */
async function spawnElectron(port, userData, extraEnv) {
  const electronPath = require('electron');
  const childEnv = {
    ...process.env,
    ...windowEnv('lifecycle'),
    AI_BROWSER_PORT: String(port),
    AI_BROWSER_USER_DATA: userData,
    AI_BROWSER_WATCHDOG: '0',
    ...extraEnv,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  const child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: childEnv });
  const lines = [];
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 300) lines.splice(0, lines.length - 300);
  });
  child.__stderrLines = lines;
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  return child;
}

/** 读隔离实例的 error.jsonl，按 kind 统计。 */
function readLog(userData) {
  const p = path.join(userData, 'logs', 'error.jsonl');
  if (!fs.existsSync(p)) return null;
  const out = [];
  for (const l of fs.readFileSync(p, 'utf8').trim().split('\n')) {
    try { out.push(JSON.parse(l)); } catch (_) {}
  }
  return out;
}
const countKind = (log, k) => log ? log.filter((e) => e.kind === k).length : -1;

async function runChromeGone() {
  const port = BASE_PORT;
  const userData = path.join(os.tmpdir(), `ai-browser-e2e-lifecycle-${port}`);
  fs.rmSync(userData, { recursive: true, force: true });
  if (!(await harness.waitPortFree(port, 15000))) {
    console.error('!! 端口 ' + port + ' 被占用'); process.exit(3);
  }
  const child = await spawnElectron(port, userData, { AI_BROWSER_SELFTEST: 'chrome-gone' });
  const b = new Browser(port);
  try {
    await b.ready();
    await harness.assertIdentity(b, child, 'lifecycle:chrome-gone');

    // 等覆盖 2s(注入) + 5.5s(自报) + 余量。pushNavState 每 1.5s 一轮，自愈
    // 最迟在注入后 ~1.5s 触发。
    await sleep(7000);

    const log = readLog(userData);
    const uncaughtErrs = (log || []).filter((e) => e.kind === 'uncaught_exception');
    console.log('\n[L1-L2] chrome-gone 日志：行=' + (log ? log.length : 'null')
      + ' uncaught_exception=' + uncaughtErrs.length
      + ' tabbar_rebuilt=' + countKind(log, 'tabbar_rebuilt')
      + ' error_banner=' + countKind(log, 'error_banner'));

    check('L1 视图悬空后不再抛 uncaught_exception（进程不会半死）',
      uncaughtErrs.length === 0,
      uncaughtErrs.map((e) => e.message).join(' | '));
    check('L2 视图被自动重建（tabbar_rebuilt ≥ 1，证明是治愈而非侥幸）',
      countKind(log, 'tabbar_rebuilt') >= 1, 'rebuilt=' + countKind(log, 'tabbar_rebuilt'));
    check('L2b 重建有上限、不失控（≤ 3 次）',
      countKind(log, 'tabbar_rebuilt') <= 3, 'rebuilt=' + countKind(log, 'tabbar_rebuilt'));
    check('L1b 这次失效没有误弹 error_banner（非致命故障不打扰用户）',
      countKind(log, 'error_banner') === 0, 'banner=' + countKind(log, 'error_banner'));

    // L3：进程仍然健康 —— WS 能握、server_info 能回、tabs 还在。
    let alive = false, info = null;
    try {
      info = unwrap(await b.call('ui.server_info', {}));
      alive = !!(info && info.pid === child.pid);
    } catch (e) { alive = false; }
    check('L3 自愈后进程仍健康（ui.server_info 可回，pid 一致 —— 没有二次崩溃打死）',
      alive, info ? 'pid=' + info.pid : 'no response');
    let tabsOk = false;
    try {
      const lt = unwrap(await b.call('ui.list_tabs', {}));
      tabsOk = !!(lt && Array.isArray(lt.tabs));
    } catch (_) {}
    check('L3b 标签列表仍可读（导航能力没被视图失效连累）', tabsOk);
  } finally {
    try { b.close(); } catch (_) {}
    guard.killChild(child);
    await sleep(300);
  }
}

async function runBannerAutoHide() {
  // 用 +50 而不是 +1：run_all.cjs 按 BASE_PORT+i 紧密递增分配端口，+1 可能正好
  // 落在下一个套件的端口上。串行跑虽然前一个已 kill，但留足间隔更保险。
  const port = BASE_PORT + 50;
  const userData = path.join(os.tmpdir(), `ai-browser-e2e-lifecycle-${port}`);
  fs.rmSync(userData, { recursive: true, force: true });
  if (!(await harness.waitPortFree(port, 15000))) {
    console.error('!! 端口 ' + port + ' 被占用'); process.exit(3);
  }
  // crash selftest：2s 后注入 uncaught exception → reportFatal → 挂横幅。
  // autohide 调到 1500ms（下限 500），这样 ~3.5s 就能验证横幅自动收起。
  const child = await spawnElectron(port, userData, {
    AI_BROWSER_SELFTEST: 'crash',
    AI_BROWSER_BANNER_AUTOHIDE_MS: '1500',
    AI_BROWSER_ERROR_BANNER: '1',
  });
  const b = new Browser(port);
  try {
    await b.ready();
    await harness.assertIdentity(b, child, 'lifecycle:banner');
    await sleep(5000);
    const log = readLog(userData);
    const banner = countKind(log, 'error_banner');
    const autohide = countKind(log, 'error_banner_autohide');
    const uncaughtErrs = (log || []).filter((e) => e.kind === 'uncaught_exception');
    console.log('\n[L4] crash 日志：error_banner=' + banner
      + ' error_banner_autohide=' + autohide
      + ' uncaught_exception=' + uncaughtErrs.length);
    check('L4 fatal 触发了横幅（前提：现象确实存在，否则后面的收敛断言无意义）',
      banner >= 1, 'banner=' + banner);
    check('L4b 横幅在静默后自动收起（error_banner_autohide ≥ 1）—— 不再挂几小时',
      autohide >= 1, 'autohide=' + autohide);
    // 横幅收起后进程仍健康（autohide 里的 hideErrorBanner 不能把进程搞崩）。
    let alive = false;
    try { const info = unwrap(await b.call('ui.server_info', {})); alive = !!(info && info.pid === child.pid); }
    catch (_) {}
    check('L4c 横幅自动收起后进程仍健康', alive);
  } finally {
    try { b.close(); } catch (_) {}
    guard.killChild(child);
    await sleep(300);
  }
}

async function main() {
  console.log('lifecycle: BrowserView 生命周期治理回归（隐藏模式，不抢窗口）');
  await runChromeGone();
  await runBannerAutoHide();
  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
  }
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

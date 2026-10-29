// e2e/icon_ws.cjs — 应用图标在两条渲染路径上必须是同一个尺寸
//
// 用户报（2026-10-29）："我看电脑里 icon 一会大一会小"。
//
// 根因不是坏文件，而是**两条路径的几何不一致**：
//
//   · 打包版：Info.plist → icon.icns → macOS 按图标网格缩放 → 内容占 ~86.7%
//   · 源码版：app.dock.setIcon(build/icon.png) → 裸 NSImage，不过网格 → 占 100%
//
// 从"应用程序"启动和从 `npm start` 启动，Dock 里就是两个尺寸。这类差异没有
// 任何报错，肉眼也只在两种启动方式之间来回切才发现 —— 所以必须能被数字判定。
//
// 这个套件验的是**运行时那一位**：源码启动时到底把哪张图设进去了、设进去的
// 那张图实测占多大。纯文件几何由 tests/test_icon_geometry.js 钉住；这里补的是
// "接线对不对"（比如有人把 applyAppIcon 改回 icon.png，单测看不出来）。
//
// 跑：AI_BROWSER_PORT=9333 node e2e/icon_ws.cjs

const harness = require('./_harness.cjs');
const { windowEnv } = require('./_window_mode.cjs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const { contentBox } = require(path.join(ROOT, 'scripts', 'icon_geometry.cjs'));
const { GRID_CONTENT, GRID_TOL } = require(path.join(ROOT, 'scripts', 'check_icon.cjs'));
const guard = require('./_spawn_guard.cjs');

const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 180000;

let PASS = 0, FAIL = 0;
function check(name, ok, detail) {
  if (ok) { PASS++; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}
function skip(name, why) { console.log(`  – ${name}  SKIPPED（${why}）`); }

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function once() {
      const s = net.connect(port, '127.0.0.1');
      let done = false;
      s.once('connect', () => { if (!done) { done = true; s.destroy(); resolve(); } });
      s.once('error', () => {
        if (done) return;
        done = true; s.destroy();
        if (Date.now() - t0 > timeoutMs) reject(new Error('port timeout'));
        else setTimeout(once, 200);
      });
    })();
  });
}

const ratioOf = (file) => contentBox(fs.readFileSync(file)).ratio;

async function main() {
  console.log('[A. 源码启动：Dock 图标用的是哪张图、多大]');
  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! port ' + WS_PORT + ' 一直被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const childEnv = { ...process.env, ...windowEnv('icon'), AI_BROWSER_PORT: String(WS_PORT) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.AI_BROWSER_USER_DATA = path.join(os.tmpdir(), `ai-browser-e2e-icon-${WS_PORT}`);
  const child = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: 'ignore', detached: true, env: childEnv });
  guard.track(child);

  let b = null;
  try {
    await waitForPort(WS_PORT, 40000);
    b = new Browser(WS_PORT);
    await b.ready();
    await harness.assertIdentity(b, child, 'icon');

    const info = (await b.call('ui.server_info', {})).result || {};
    const icon = info.icon || null;

    check('IC-01 server_info 报出图标来源', !!icon && !!icon.source,
      icon ? JSON.stringify(icon) : '没有 icon 字段');
    check('IC-02 源码启动走 dock.setIcon（不是 bundle）',
      !!icon && icon.source === 'dock.setIcon', icon && icon.source);

    // 这条是核心：设进去的必须是按网格缩过的那张
    check('IC-03 设进去的是 icon-dock.png（不是满出血的 icon.png）',
      !!icon && icon.file === 'icon-dock.png', icon && icon.file);

    const reported = icon && typeof icon.content_ratio === 'number' ? icon.content_ratio : null;
    check('IC-04 上报的内容占比落在 macOS 图标网格上',
      reported !== null && Math.abs(reported - GRID_CONTENT) <= GRID_TOL,
      `content_ratio=${reported}（期望 ${GRID_CONTENT}±${GRID_TOL}）`);

    // 上报值必须来自实测，不能是硬编码 —— 与磁盘上的同一张图对量
    const onDisk = ratioOf(path.join(ROOT, 'build', 'icon-dock.png'));
    check('IC-05 上报值是实测的（与磁盘同一张图相差 ≤0.01）',
      reported !== null && Math.abs(reported - onDisk) <= 0.01,
      `上报 ${reported} / 磁盘 ${onDisk.toFixed(3)}`);

    // 阴性对照：满出血那张必须被判为不合格，否则 IC-04 恒绿
    const full = ratioOf(path.join(ROOT, 'build', 'icon.png'));
    check('IC-06 阴性对照：满出血的 icon.png 会被同一条判据判为不合格',
      Math.abs(full - GRID_CONTENT) > GRID_TOL,
      `icon.png 内容占 ${(full * 100).toFixed(1)}%`);

    // =====================================================================
    console.log('\n[B. 打包产物：图标只能有一份，且就是源里那份]');
    const distRoot = path.join(ROOT, 'dist');
    const distDir = fs.existsSync(distRoot)
      ? fs.readdirSync(distRoot).find((n) => n.endsWith('-darwin-arm64'))
      : null;
    const appPath = distDir ? path.join(distRoot, distDir, 'AI Browser.app') : null;
    if (!appPath || !fs.existsSync(appPath)) {
      skip('IC-07..09 打包产物检查', 'dist/ 里没有 .app（先 npm run build）');
    } else {
      const res = path.join(appPath, 'Contents', 'Resources');
      const icns = fs.readdirSync(res).filter((n) => n.endsWith('.icns'));
      check('IC-07 Resources 里只有一份 icns', icns.length === 1, icns.join(', ') || '一份都没有');

      let iconFile = '';
      try {
        iconFile = require('node:child_process')
          .execFileSync('/usr/libexec/PlistBuddy',
            ['-c', 'Print :CFBundleIconFile', path.join(appPath, 'Contents', 'Info.plist')],
            { encoding: 'utf8' }).trim();
      } catch (_) { /* 下面会判 */ }
      check('IC-08 Info.plist 指向的 icns 真的存在',
        !!iconFile && fs.existsSync(path.join(res, iconFile)), iconFile || '读不到');

      const srcIcns = path.join(ROOT, 'build', 'icon.icns');
      const same = iconFile && fs.existsSync(path.join(res, iconFile)) && fs.existsSync(srcIcns)
        && fs.readFileSync(path.join(res, iconFile)).equals(fs.readFileSync(srcIcns));
      check('IC-09 装进去的 icns 就是 build/icon.icns（不是上一版的旧图）', !!same,
        same ? '一致' : '不一致');
    }

    console.log('\n==== icon PASS=' + PASS + ' FAIL=' + FAIL + ' ====');
    // 不要在这里 exit —— process.exit 不会跑 finally，Electron 子进程会变成孤儿
    // 占着端口和单实例锁（这个坑 _spawn_guard.cjs 的注释里记着）。
  } finally {
    try { if (b) b.close(); } catch (_) {}
    guard.killChild(child);
  }
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('icon error:', e && e.stack ? e.stack : e.message); process.exit(2); });
setTimeout(() => { console.error('icon TIMEOUT'); process.exit(2); }, GLOBAL_TIMEOUT_MS);

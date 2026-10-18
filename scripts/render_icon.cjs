#!/usr/bin/env node
// scripts/render_icon.cjs — 从 build/icon.svg 一键重建整条图标链：
//   SVG → 2048×2048 PNG（icon@2x.png）→ 1024 PNG（icon.png）
//       → icon.iconset/（10 个尺寸）→ icon.icns（packager 的输入）
//
// # 为什么不用 qlmanage / rsvg-convert / ImageMagick
//   qlmanage 在受限沙箱里直接 "sandbox initialization failed: Operation not permitted"；
//   rsvg-convert / convert / inkscape 本机都没装。为一个图标引入一串系统依赖不划算。
//   而本项目**本来就自带一个完整的 Chromium**（electron 依赖），拿它渲染 SVG 是天经地义的事，
//   零新增依赖，且渲染结果和图标最终运行的引擎完全一致。
//
// # 为什么 icns 要提交、中间 png 不提交
//   build_dmg.cjs 的 icon 选项只读 build/icon.icns；icon.svg 是母版；
//   其余 png/iconset 都是本脚本的再生产物，改了 SVG 重跑本脚本即可。
//
// # 用法（必须在 Electron 下运行，不是 node；本沙箱还要 --no-sandbox --disable-gpu）
//   env -u ELECTRON_RUN_AS_NODE \
//     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     --no-sandbox --disable-gpu scripts/render_icon.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'build', 'icon.svg');
const PNG_2X = path.join(ROOT, 'build', 'icon@2x.png'); // 2048×2048，母版位图
const PNG = path.join(ROOT, 'build', 'icon.png'); //    1024×1024，预览用
const ICONSET = path.join(ROOT, 'build', 'icon.iconset');
const ICNS = path.join(ROOT, 'build', 'icon.icns');

// icns 要求的全部尺寸（源图是 2048²，一律从它缩）
const SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

// 在普通 node 下 require('electron') 拿到的是二进制路径字符串，提前拦掉给出提示
let electron;
try {
  electron = require('electron');
} catch (_) {
  electron = null;
}
if (!electron || typeof electron.app === 'undefined') {
  console.error('[icon] 本脚本必须在 Electron 下运行（见文件头用法），node 直接跑不了。');
  process.exit(2);
}

const { app, BrowserWindow } = electron;

app.commandLine.appendSwitch('disable-gpu'); // 无头环境没有 GL，别让 GPU 进程拖后腿

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${r.status}`);
  }
}

app.whenReady().then(async () => {
  // 窗口 1024，capturePage 在 Retina 下返回 2x（2048×2048）——这就是母版位图
  const SIZE = 1024;
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  try {
    await win.loadFile(SVG);
    // 等一帧，确保 SVG 已经完成布局与绘制（loadFile 只保证 DOM ready）
    await new Promise((r) => setTimeout(r, 300));

    const img = await win.webContents.capturePage();
    if (img.isEmpty()) throw new Error('capturePage returned an empty image');

    const png = img.toPNG();
    fs.writeFileSync(PNG_2X, png);
    const w = img.getSize().width;
    const h = img.getSize().height;
    console.log(`[icon] ${path.relative(ROOT, SVG)} -> ${path.relative(ROOT, PNG_2X)} (${w}x${h}, ${png.length} bytes)`);

    // ---- 以下三步是 macOS 自带工具，不联网、不加依赖 ----
    // 1) 1024 预览图
    run('sips', ['-Z', '1024', PNG_2X, '-o', PNG]);
    // 2) 10 个 icns 尺寸
    fs.rmSync(ICONSET, { recursive: true, force: true });
    fs.mkdirSync(ICONSET, { recursive: true });
    for (const [size, name] of SIZES) {
      run('sips', ['-Z', String(size), PNG_2X, '-o', path.join(ICONSET, name)]);
    }
    // 3) 打 icns
    fs.rmSync(ICNS, { force: true });
    run('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS]);

    const icnsSize = fs.statSync(ICNS).size;
    console.log(`[icon] iconset: ${SIZES.length} sizes -> ${path.relative(ROOT, ICNS)} (${icnsSize} bytes)`);
    console.log('[icon] done. build_dmg.cjs 会读取 build/icon.icns');
    app.exit(0);
  } catch (e) {
    console.error(`[icon] FAILED: ${e.message}`);
    app.exit(1);
  }
});

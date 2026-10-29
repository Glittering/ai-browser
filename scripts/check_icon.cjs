#!/usr/bin/env node
// scripts/check_icon.cjs — 图标链路的一致性与"尺寸"闸门。
//
// # 这个脚本在防什么
//
// 用户 2026-10-29 报："我看电脑里 icon 一会大一会小。"
//
// 根因不是一个坏文件，而是**两条渲染路径的几何不一致**：
//
//   · 打包版：Info.plist → icon.icns → macOS 按统一图标网格缩放 → 内容占 ~86.7%
//   · 源码版：app.dock.setIcon(build/icon.png) → 裸 NSImage，不经过网格 → 占 100%
//
// 于是同一个应用，从"应用程序"启动和从 `npm start` 启动，Dock 里是两个尺寸。
// 这类缺陷靠肉眼比是判不出来的（旁边没有参照物、每次都只看一个），必须量。
//
// 检查项：
//   1. icon.png 满出血（=1.0）—— 它是 icns 与 Windows/Linux 窗口图标的源
//   2. icon-dock.png 内容占比 ≈ 系统图标网格（0.867 ± 0.015）
//   3. icon.icns 十档齐全，且每一档都满出血（小尺寸不能因为留白显得更小）
//   4. 给定 .app 时：Info.plist 指的 icns 真的在、Resources 里只有一份 icns
//
// 用法：
//   node scripts/check_icon.cjs                 # 只查 build/
//   node scripts/check_icon.cjs "/Applications/AI Browser.app"
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { contentBox } = require('./icon_geometry.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

// macOS 图标网格的内容占比。2026-10-29 在 macOS 27 上量的：
// 本应用 bundle 图标 86.7%、Safari 86.7%、Finder 86.7%（同一口径、256px 渲染）。
// 容差 1.5 个百分点 —— 足够吸收不同 macOS 版本的网格微调，但拦得住"满出血"
// 与"缩过头"这两类真实错误（分别是 100% 和 <75%）。
const GRID_CONTENT = 0.867;
const GRID_TOL = 0.015;

const ICNS_SLOTS = [
  'icon_16x16.png', 'icon_16x16@2x.png', 'icon_32x32.png', 'icon_32x32@2x.png',
  'icon_128x128.png', 'icon_128x128@2x.png', 'icon_256x256.png', 'icon_256x256@2x.png',
  'icon_512x512.png', 'icon_512x512@2x.png',
];

let failed = 0;
const rows = [];

function report(name, ok, detail) {
  rows.push({ name, ok, detail });
  if (!ok) failed++;
}

function ratioOf(file) {
  return contentBox(fs.readFileSync(file)).ratio;
}

function checkBuildFiles() {
  const png = path.join(BUILD, 'icon.png');
  const dock = path.join(BUILD, 'icon-dock.png');
  const icns = path.join(BUILD, 'icon.icns');

  for (const f of [png, dock, icns]) {
    if (!fs.existsSync(f)) {
      report(path.basename(f), false, '文件不存在（先跑 npm run icon）');
      return;
    }
  }

  const full = ratioOf(png);
  report('icon.png 满出血', full > 0.99, `内容占 ${(full * 100).toFixed(1)}%（期望 100%）`);

  const d = ratioOf(dock);
  const dOk = Math.abs(d - GRID_CONTENT) <= GRID_TOL;
  report(
    'icon-dock.png 对齐系统图标网格',
    dOk,
    `内容占 ${(d * 100).toFixed(1)}%（期望 ${(GRID_CONTENT * 100).toFixed(1)}% ±${GRID_TOL * 100}%）` +
      (dOk ? '' : d > GRID_CONTENT ? ' —— 偏大，Dock 里会比别的图标大一圈' : ' —— 偏小')
  );

  // icns 解回 iconset 逐档量。iconutil 只在 macOS 上有；其他平台跳过并明说，
  // 不静默通过。
  if (process.platform !== 'darwin') {
    report('icon.icns 十档', true, 'SKIPPED（非 macOS，iconutil 不可用）');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-icon-'));
  const out = path.join(tmp, 'x.iconset');
  const r = spawnSync('iconutil', ['-c', 'iconset', icns, '-o', out], { encoding: 'utf8' });
  if (r.status !== 0) {
    report('icon.icns 可解包', false, (r.stderr || '').trim() || `iconutil exit ${r.status}`);
    return;
  }
  const missing = ICNS_SLOTS.filter((n) => !fs.existsSync(path.join(out, n)));
  report('icon.icns 十档齐全', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : '10/10');

  const bad = [];
  for (const n of ICNS_SLOTS) {
    const p = path.join(out, n);
    if (!fs.existsSync(p)) continue;
    const ratio = ratioOf(p);
    if (ratio < 0.99) bad.push(`${n}=${(ratio * 100).toFixed(0)}%`);
  }
  report('icns 每一档都满出血', bad.length === 0, bad.length ? `留白：${bad.join(', ')}` : '10/10 满出血');
  fs.rmSync(tmp, { recursive: true, force: true });
}

function checkAppBundle(appPath) {
  if (!fs.existsSync(appPath)) {
    report('app bundle', false, `不存在：${appPath}`);
    return;
  }
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const pb = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plist], { encoding: 'utf8' });
  const iconFile = (pb.stdout || '').trim();
  const resources = path.join(appPath, 'Contents', 'Resources');
  const named = iconFile ? path.join(resources, iconFile) : null;
  report(
    'Info.plist 指向的图标存在',
    !!(named && fs.existsSync(named)),
    iconFile ? `${iconFile}` : '读不到 CFBundleIconFile'
  );

  let icnsFiles = [];
  try { icnsFiles = fs.readdirSync(resources).filter((n) => n.endsWith('.icns')); } catch (_) {}
  report(
    'Resources 里只有一份 icns',
    icnsFiles.length === 1,
    icnsFiles.length === 1 ? icnsFiles[0] : `发现 ${icnsFiles.length} 份：${icnsFiles.join(', ')}`
  );

  if (named && fs.existsSync(named)) {
    const src = path.join(BUILD, 'icon.icns');
    const same = fs.existsSync(src) && fs.readFileSync(named).equals(fs.readFileSync(src));
    report('装进去的 icns 就是 build/icon.icns', same, same ? '一致' : '不一致（装的是旧图标？）');
  }
}

function main() {
  const appArg = process.argv[2];
  checkBuildFiles();
  if (appArg) checkAppBundle(path.resolve(appArg));

  console.log('\n[icon] 检查结果');
  for (const r of rows) {
    console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name.padEnd(32)} ${r.detail}`);
  }
  if (failed) {
    console.log(`\n[icon] ${failed} 项不通过`);
    process.exit(1);
  }
  console.log('\n[icon] 全部通过');
}

if (require.main === module) main();

module.exports = { GRID_CONTENT, GRID_TOL, ICNS_SLOTS, ratioOf };

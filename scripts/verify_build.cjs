#!/usr/bin/env node
// scripts/verify_build.cjs — 校验"打包产物"和"源码"是同一份东西。
//
// # 为什么需要这个
//
// 2026-10-24 的事故：标签栏滚动 bug 修好了、测试过了、npm/GitHub/MCP 全发了
// v2.1.4，但用户桌面上的 App 还是 10-19 打的 v1.3.1 —— 因为**打包不在发版
// 流程里**。用户看到的现象是"你根本没修好"，而所有自动化渠道都是绿的。
//
// 这类漂移（source ≠ package）是所有桌面分发共同的问题，靠"记得重新打包"
// 解决不了，必须能机器判定。这里做三件事：
//   1. 版本一致：app bundle 的 Info.plist 版本 == package.json 版本
//   2. 内容一致：asar 里的 src/** 与磁盘上的 src/** 逐字节相同（少一个文件、
//      多一个文件、内容有 diff 都算失败）
//   3. 产物存在：当前版本的 .dmg 在 dist/
//
// # 用法
//   node scripts/verify_build.cjs           # 失败退出码 1
//   node scripts/verify_build.cjs --quiet    # 只输出结论
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const quiet = process.argv.includes('--quiet');
const pkg = require(path.join(ROOT, 'package.json'));

const c = (s) => `\x1b[${s}m`;
const ok = (m) => console.log(`${c(32)}✓${c(0)} ${m}`);
const fail = (m) => console.log(`${c(31)}✗${c(0)} ${m}`);
const problems = [];

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ---- 1. 找到 app bundle / dmg ---------------------------------------------
const distDir = path.join(ROOT, 'dist');
if (!fs.existsSync(distDir)) {
  fail('dist/ 不存在 —— 还没打过包（node scripts/build_dmg.cjs）');
  process.exit(1);
}
const appDirName = fs.readdirSync(distDir).find((n) => n.endsWith('-darwin-arm64'));
if (!appDirName) {
  fail('dist/ 里没有 *-darwin-arm64 目录');
  process.exit(1);
}
const appPath = path.join(distDir, appDirName, 'AI Browser.app');
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  fail(`asar 不存在：${asarPath}`);
  process.exit(1);
}

// ---- 2. 版本一致 -----------------------------------------------------------
const plistPath = path.join(appPath, 'Contents', 'Info.plist');
const plistVer = (() => {
  try {
    const out = require('node:child_process').execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', plistPath],
      { encoding: 'utf8' }
    ).trim();
    return out;
  } catch { return null; }
})();

if (plistVer === pkg.version) {
  ok(`app 版本 ${plistVer} 与 package.json 一致`);
} else {
  problems.push(`app 版本 ${plistVer || '?'} ≠ package.json ${pkg.version} —— 产物是旧版，需要重新打包`);
  fail(`app 版本 ${plistVer || '?'} ≠ package.json ${pkg.version}`);
}

// ---- 3. 内容一致：asar 里的 src/** vs 磁盘 src/** --------------------------
// @electron/asar 的 extractFile 只接受 asar 内的相对路径，且对不存在的路径抛错；
// 用它既能比对内容，也能发现"asar 里少了某个新文件"。
const asar = require('@electron/asar');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // node_modules 在 asar 里被 prune 过，且体量大，不参与比对
    if (e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

const srcFiles = walk(path.join(ROOT, 'src'));
let same = 0;
const drifted = [];
const missing = [];
for (const rel of srcFiles) {
  const diskBuf = fs.readFileSync(path.join(ROOT, 'src', rel));
  const relInAsar = path.join('src', rel);
  let packed = null;
  try { packed = asar.extractFile(asarPath, relInAsar); } catch { /* 不存在 */ }
  if (!packed) { missing.push(rel); continue; }
  if (Buffer.compare(diskBuf, packed) === 0) same++;
  else drifted.push(`${rel}  (disk ${sha(diskBuf)} / packed ${sha(packed)})`);
}

if (missing.length) {
  problems.push(`asar 缺 ${missing.length} 个源文件（产物比源码旧）：${missing.slice(0, 5).join(', ')}`);
  fail(`asar 缺 ${missing.length} 个源文件，例：${missing.slice(0, 3).join(', ')}`);
}
if (drifted.length) {
  problems.push(`asar 有 ${drifted.length} 个文件与源码内容不同：${drifted.slice(0, 5).join(' | ')}`);
  fail(`asar 内容与源码不同（${drifted.length} 个）：`);
  for (const d of drifted.slice(0, 8)) console.log(`    ${d}`);
}
if (!missing.length && !drifted.length) {
  ok(`asar 内 src/** 与源码逐字节一致（${same} 个文件）`);
}

// ---- 4. dmg 存在且版本正确 -------------------------------------------------
const dmgName = `AI-Browser-${pkg.version}-arm64.dmg`;
const dmgPath = path.join(distDir, dmgName);
if (fs.existsSync(dmgPath)) {
  const mb = (fs.statSync(dmgPath).size / 1024 / 1024).toFixed(1);
  ok(`dmg 就绪：${dmgName}（${mb} MB）`);
} else {
  problems.push(`dist/${dmgName} 不存在（dist 里是：${fs.readdirSync(distDir).filter((n) => n.endsWith('.dmg')).join(', ') || '无 dmg'}）`);
  fail(`缺 ${dmgName}`);
}

// ---- 结论 -----------------------------------------------------------------
if (problems.length) {
  console.log('');
  fail(`打包产物与源码不同步（${problems.length} 项）`);
  if (!quiet) {
    console.log('  用户装上的是旧代码，任何"已修复"的说法都不成立。');
    console.log('  修复：node scripts/build_dmg.cjs');
  }
  process.exit(1);
}
console.log('');
ok(`打包产物与源码完全同步（v${pkg.version}）`);

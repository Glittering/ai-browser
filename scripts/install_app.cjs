#!/usr/bin/env node
// scripts/install_app.cjs — 把 dist 里的 .app 装到 /Applications，替换旧版本。
//
// # 为什么需要这一步而不是"让用户自己拖"
//
// 本机验证链条是：改代码 → npm/GitHub/MCP 发布 → **桌面 App**。前三步都在
// 自动化里，最后一步靠人手拖拽，于是就有了 2026-10-24 那次事故——所有渠道
// 都是 v2.1.4，用户桌面上的 App 还是 10-19 打的 v1.3.1，看到的现象是"你根本
// 没修好"。只要"装应用"还是一次手工操作，这个漂移就会重复发生。
//
// # 安全约束
//
//   · 不删除任何东西：旧 .app 用 mv 移到临时目录（可回滚），不 rm。
//   · 不碰用户数据：~/.ai-browser（登录态、history）完全不动，所以换版本后
//     仍然是登录状态。
//   · 先退出旧进程再替换，否则 ditto 会写进正在运行的文件里。
//
// 用法：
//   node scripts/install_app.cjs            # 装当前 dist 产物
//   node scripts/install_app.cjs --dry      # 只打印会做什么
'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'AI Browser';
const TARGET = path.join('/Applications', `${APP_NAME}.app`);
const dry = process.argv.includes('--dry');
const pkg = require(path.join(ROOT, 'package.json'));

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exit(1); };

function plistVersion(appPath) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8' }).trim();
  } catch { return null; }
}

// ---- 找源 .app -------------------------------------------------------------
const distDir = path.join(ROOT, 'dist');
if (!fs.existsSync(distDir)) fail('dist/ 不存在，先 node scripts/build_dmg.cjs');
const rootDirName = fs.readdirSync(distDir).find((n) => n.endsWith('-darwin-arm64'));
if (!rootDirName) fail('dist/ 里没有 *-darwin-arm64 目录');
const srcApp = path.join(distDir, rootDirName, `${APP_NAME}.app`);
if (!fs.existsSync(srcApp)) fail(`找不到 ${srcApp}`);

const srcVer = plistVersion(srcApp);
if (srcVer !== pkg.version) {
  fail(`dist 里的 app 是 ${srcVer}，package.json 是 ${pkg.version} —— 先重新打包`);
}

// ---- 退出旧进程 -----------------------------------------------------------
// 用 osascript 优雅退出（会 flush profile）；不走 kill -9，避免 SQLite 里的
// 会话/cookie 写一半。
if (fs.existsSync(TARGET)) {
  const oldVer = plistVersion(TARGET);
  console.log(`当前已安装：${oldVer || '未知版本'} → 目标：${srcVer}`);
  if (oldVer === srcVer && !process.argv.includes('--force')) {
    ok(`已安装的就是 ${srcVer}，无需替换（--force 可强制）`);
    process.exit(0);
  }
  if (dry) { warn('--dry：将退出 App、移走旧包、装新包'); process.exit(0); }
  spawnSync('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { encoding: 'utf8' });
  // 给它 3 秒落盘；仍在跑就按端口找到的进程再等一轮
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  try {
    execFileSync('pkill', ['-f', `${TARGET}/Contents/MacOS`]);
  } catch { /* 已经退了 */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
}

// ---- 替换 ----------------------------------------------------------------
if (fs.existsSync(TARGET)) {
  // ⚠️ 备份必须以 .bak 结尾，不能留成 .app。
  //    .app 是一个 bundle，它的 Info.plist 里写着和 /Applications 那份**同一个
  //    bundle id**（com.glittering.ai-browser）。每装一次就往 /tmp 里多一份同 id
  //    的 bundle，LaunchServices 会把它们全登记下来；之后 Dock / Finder 解析这个
  //    id 时可能拿到备份那份 —— 它的图标是旧版的，于是"图标一会大一会小"。
  //    .bak 不是可执行 bundle，LS 不登记。回滚就是把它改回 .app 再拷回去。
  const backup = path.join(os.tmpdir(), `${APP_NAME}-${plistVersion(TARGET) || 'old'}-${Date.now()}.app.bak`);
  fs.renameSync(TARGET, backup);
  console.log(`旧包已移到 ${backup}（可回滚，未被删除；改回 .app 结尾即可）`);
}
const r = spawnSync('ditto', [srcApp, TARGET], { encoding: 'utf8' });
if (r.status !== 0) fail(`ditto 失败：${(r.stderr || '').trim()}`);
ok(`已安装 ${srcVer} → ${TARGET}`);

// 让 LaunchServices 认准新装这份 —— dist 里那份构建产物已由 build_dmg 注销，
// 这里显式登记 /Applications 的正式副本，避免同 id 解析到别处的旧图标。
spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', TARGET], { encoding: 'utf8' });

// ---- 启动 ----------------------------------------------------------------
if (!process.argv.includes('--no-open')) {
  spawnSync('open', [TARGET], { encoding: 'utf8' });
  ok('已启动');
}

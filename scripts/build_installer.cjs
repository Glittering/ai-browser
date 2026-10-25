'use strict';
// scripts/build_installer.cjs — 用 electron-winstaller（Squirrel.Windows）把
// 已打包好的便携目录 dist/AI Browser-win32-x64 打成**单文件安装器** Setup.exe。
//
// 前提：先 `npm run build:win` 产出 dist/AI Browser-win32-x64/。
// 产出：dist/installer/AI-Browser-<version>-win32-x64-Setup.exe
// 用法：node scripts/build_installer.cjs
//
// Squirrel 安装到 %LOCALAPPDATA%\<name>，并创建开始菜单/桌面快捷方式；不写 HKLM，
// 无需管理员权限。noMsi: true → 只出 Setup.exe，不额外出 .msi。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const APP_DIR = path.join(root, 'dist', 'AI Browser-win32-x64');
const OUT_DIR = path.join(root, 'dist', 'installer');
const EXE_NAME = 'AI Browser.exe';

function main() {
  if (!fs.existsSync(path.join(APP_DIR, EXE_NAME))) {
    console.error(`[installer] 找不到已打包目录：${APP_DIR}\\${EXE_NAME}\n  先运行: npm run build:win`);
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const icoPath = path.join(root, 'build', 'icon.ico');
  const setupExe = `AI-Browser-${pkg.version}-win32-x64-Setup.exe`;

  const { createWindowsInstaller } = require('electron-winstaller');

  console.log(`[installer] ${pkg.version} — Squirrel Setup.exe`);
  console.log(`[installer] appDirectory: ${APP_DIR}`);
  console.log(`[installer] outputDirectory: ${OUT_DIR}`);

  return createWindowsInstaller({
    appDirectory: APP_DIR,
    outputDirectory: OUT_DIR,
    authors: 'Glittering',
    exe: EXE_NAME,
    // name 用作 %LOCALAPPDATA%\ 下的安装目录与包标识，用无空格名更稳
    name: 'AIBrowser',
    title: 'AI Browser',
    description: 'AI-native browser — semantic-tree API for agents',
    version: pkg.version,
    setupExe,
    noMsi: true,
    // 有 build/icon.ico 就用作 Setup.exe 图标；没有则用默认
    setupIcon: fs.existsSync(icoPath) ? icoPath : undefined,
  }).then(() => {
    const out = path.join(OUT_DIR, setupExe);
    const ok = fs.existsSync(out);
    if (ok) {
      const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
      console.log(`[installer] 完成：${out}（${mb} MB）`);
    } else {
      // electron-winstaller 有时会把 setupExe 名字改成默认，扫一下产物
      const files = fs.readdirSync(OUT_DIR).filter((n) => /Setup\.exe$/i.test(n));
      console.log('[installer] 预期文件名未出现，目录内 Setup.exe：', files);
      if (!files.length) process.exit(1);
    }
    return out;
  });
}

main().catch((e) => { console.error('[installer] 失败：', (e && e.stack) || e); process.exit(1); });

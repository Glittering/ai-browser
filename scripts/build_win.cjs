'use strict';
// scripts/build_win.cjs — Windows 便携包（win32-x64）构建。
//
// 为什么单独一份而不是复用 build_dmg.cjs：后者整条链路都是 macOS 专属
// （ditto / sips / iconutil / PlistBuddy / *.app / *.dmg），在 Windows 上
// 没有可用的等价物。这里只复用它的**打包语义**（name / IGNORE 黑名单 /
// prune / asar），把平台换成 win32/x64，产物是带 AI Browser.exe 的便携目录。
//
// 产出：dist/AI Browser-win32-x64/AI Browser.exe
// 用法：node scripts/build_win.cjs
//
// 注意：Windows 版可执行文件的图标需要 .ico（项目只有 icon.icns / icon.svg），
// 未提供时会使用 Electron 默认图标；要换图标请先把 build/icon.svg 转出
// build/icon.ico，再在下面的 icon 选项里指向它。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const APP_NAME = 'AI Browser';
const OUT_DIR = path.join(root, 'dist');

// 与 build_dmg.cjs 完全一致的黑名单：测试/文档/构建产物/Electron 发行版/图标母版
// 都不进安装包（src 里 from 'electron' 由 Electron 内置模块解析，不经 node_modules）。
const IGNORE = new RegExp(
  '(^|\\/)(\\.git|outputs|docs|e2e|tests|dist|build|node_modules\\/\\.cache|node_modules\\/\\.bin|node_modules\\/electron|tools\\/_oneoff)(\\/|$)'
);

// 复用本地已下载好的 electron-v<version>-win32-x64.zip，避免每次联网从 GitHub 拉
// （README 与 build_dmg 都提到这条：见到本地 zip 就 electronZipDir 指过去，完全不联网）。
function findElectronZipDir(version, platform, arch) {
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  roots.push(path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'));
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
  for (const cacheRoot of roots) {
    let entries = [];
    try { entries = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(cacheRoot, e.name);
      if (fs.existsSync(path.join(dir, zipName))) return dir;
    }
  }
  return null;
}

function main() {
  // @electron/packager v20 是纯 ESM，必须动态 import；导出是命名 `packager`。
  import('@electron/packager')
    .then((mod) => build(mod.packager))
    .catch((e) => { console.error('[build:win] 失败：', (e && e.stack) || e); process.exit(1); });
}

function build(packager) {
  const electronVersion = require('electron/package.json').version;
  const zipDir = findElectronZipDir(electronVersion, 'win32', 'x64');

  console.log(`[build:win] ${APP_NAME} ${pkg.version} — win32/x64`);
  console.log(`[build:win] ignore: ${IGNORE}`);
  console.log(`[build:win] electron zip: ${zipDir ? '本地缓存 ' + zipDir : '本地无缓存，将从 GitHub 下载 v' + electronVersion}`);

  const icoPath = path.join(root, 'build', 'icon.ico');

  return packager({
    dir: root,
    name: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    out: OUT_DIR,
    overwrite: true,
    ignore: IGNORE,
    electronZipDir: zipDir || undefined,
    prune: true,
    asar: true,
    // 有 icon.ico 就用（会经 rcedit 写进 exe 资源）；没有则使用 Electron 默认图标。
    icon: fs.existsSync(icoPath) ? icoPath : undefined,
    win32metadata: {
      CompanyName: 'Glittering',
      FileDescription: APP_NAME,
      ProductName: APP_NAME,
    },
  }).then((paths) => {
    const out = paths[0];
    const exe = path.join(out, `${APP_NAME}.exe`);
    const ok = fs.existsSync(exe);
    console.log(`[build:win] 产物目录：${out}`);
    console.log(`[build:win] 可执行文件：${ok ? exe : '(未找到 ' + exe + ')'}`);
    if (!ok) process.exit(1);
    return paths;
  });
}

main();

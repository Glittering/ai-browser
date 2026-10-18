#!/usr/bin/env node
// scripts/build_dmg.cjs — 把 AI Browser 打成 macOS .app，再压成 .dmg。
//
// # 为什么用 @electron/packager + hdiutil，而不是 electron-builder
//
// electron-builder 有一条硬校验（app-builder-lib/out/util/packageMetadata.js）：
//     const deps = ["electron", "electron-prebuilt", "electron-rebuild"];
//     for (const name of deps) if (name in dependencies) errors.push(...)
// `electron` 出现在 dependencies 里就直接报错，**没有任何环境变量能绕过**
// （ALLOW_ELECTRON_BUILDER_AS_PRODUCTION_DEPENDENCY 只管 electron-builder 自己）。
//
// 这条校验的假设是"Electron 应用不该把 electron 当运行时依赖分发"。而本项目的
// npm 渠道恰恰是这么设计的：`npx -y @glittering0717/ai-browser mcp` 要把 electron
// 装进 node_modules 再拉起来。所以两个渠道对 package.json 的要求是冲突的。
//
// 眼前的产物只是一个**未签名、不自动更新**的 dmg，electron-builder 的核心卖点
// （签名/公证/自动更新/NSIS/Squirrel）一个都用不上，却要为此引入架构冲突和
// 一堆从 GitHub 下载的二进制。@electron/packager 只做"打包"这一件事，
// hdiutil 是 macOS 自带，不需要下载任何外部工具。
//
// 如果将来真要签名+公证+自动更新，正确的做法是改用 electron-builder 官方推荐的
// 双 package.json 布局（根目录放开发依赖，app/ 子目录放应用清单），而不是在这里
// 加 hack。
//
// # 用法
//   node scripts/build_dmg.cjs              # 打当前架构
//   node scripts/build_dmg.cjs --arch arm64 # 指定架构
//   node scripts/build_dmg.cjs --skip-dmg   # 只出 .app，不压 dmg
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const APP_NAME = 'AI Browser';
const OUT_DIR = path.join(root, 'dist');

function parseArgs(argv) {
  const args = { arch: process.arch, skipDmg: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arch') args.arch = argv[++i];
    else if (argv[i] === '--skip-dmg') args.skipDmg = true;
    else {
      console.error(`[build] unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

// 黑名单。用黑名单而不是白名单是因为 packager 只有 ignore 这一个过滤手段，
// 所以每一条都要写清"为什么它不该进安装包"——
//   outputs/        28MB 截图证据，纯本地产物
//   docs/           内部文档，含营销资料
//   e2e/ tests/     测试代码与夹具
//   tools/_oneoff/  一次性调试脚本（dep_closure / peek_* 等）
//   dist/           上一次的构建产物
//   .git/           版本库
//   node_modules/.cache|.bin  npm 缓存与可执行文件软链
//   node_modules/electron    243MB 的 Electron 发行版——打包后的可执行文件
//                   **就是** Electron，asar 里再放一份纯属浪费；src 里所有
//                   `from 'electron'` 都由 Electron 内置模块系统解析，不经过
//                   node_modules。（这一点和 electron-builder 的默认行为一致。）
//   build/           图标母版与中间产物。打包只需要 build/icon.icns 这一个
//                    文件（由下面的 icon 选项显式指定，从源目录读取），
//                    目录里的 svg/png/iconset 都不该随包分发；src 里也没有
//                    任何地方引用 build/。
const IGNORE = new RegExp(
  '(^|\\/)(\\.git|outputs|docs|e2e|tests|dist|build|node_modules\\/\\.cache|node_modules\\/\\.bin|node_modules\\/electron|tools\\/_oneoff)(\\/|$)'
);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
  return r;
}

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch (_) {} }
    }
  }
  return total;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// @electron/packager 默认走 downloadElectronZip 从 GitHub 拉 Electron zip。
// 本机到 GitHub 的连接不稳定（间歇性 502 / fetch failed），而
// ~/Library/Caches/electron/<hash>/ 下通常已经有下载好的 zip。
// 这里探测缓存：有对应版本的 zip 就用 electronZipDir 指过去（packager 的
// getElectronZipPath 见到这个选项就直接用本地文件，完全不联网），
// 没有才回落到在线下载。注意 electronZipDir 要求目录里躺着
// electron-v<version>-<platform>-<arch>.zip。
function findElectronZipDir(version, platform, arch) {
  const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'electron');
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  let entries = [];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(cacheRoot, e.name);
    if (fs.existsSync(path.join(dir, zipName))) return dir;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // @electron/packager v20 是纯 ESM（"type": "module" + exports 只指向 dist/index.js），
  // require() 拿到的是模块命名空间而不是函数，必须用动态 import。
  // 它的导出是命名导出 `packager`，没有 default —— 别写成 mod.default。
  import('@electron/packager')
    .then((mod) => build(mod.packager, args))
    .catch((e) => {
      console.error(`[build] FAILED: ${e.message}`);
      process.exit(1);
    });
}

function build(packager, args) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[build] ${APP_NAME} ${pkg.version} — darwin/${args.arch}`);
  console.log(`[build] ignore: ${IGNORE}`);

  // electron 的实际版本以 node_modules 里装的那份为准（package.json 里是 ^ 范围）
  const electronVersion = require('electron/package.json').version;
  const zipDir = findElectronZipDir(electronVersion, 'darwin', args.arch);
  if (zipDir) {
    console.log(`[build] electron zip: 使用本地缓存 ${zipDir}（不联网）`);
  } else {
    console.log(`[build] electron zip: 本地无缓存，将从 GitHub 下载 v${electronVersion}`);
  }

  packager({
    dir: root,
    name: APP_NAME,
    platform: 'darwin',
    arch: args.arch,
    out: OUT_DIR,
    overwrite: true,
    ignore: IGNORE,
    electronZipDir: zipDir || undefined,
    // 只打生产依赖：npm prune --production 会把 devDependencies（vitest、jsdom、
    // @electron/packager 自己）从安装包里剔掉。用户侧少一整套测试工具链。
    prune: true,
    asar: true,
    appBundleId: 'com.glittering.ai-browser',
    appCategoryType: 'public.app-categories.productivity',
    // 图标必须显式传 icon 选项。@electron/packager 的 mac.js copyIcon() 在
    // `!this.opts.icon` 时直接 return —— 它**不会**自动去 build/ 里找
    // icon.icns（老版 electron-packager 的行为，v20 已经没有了）。
    // normalizeIconExtension 只在源目录路径上 existsSync，与 IGNORE 无关，
    // 所以 build/ 可以同时留在 ignore 列表里，不进安装包。
    icon: path.join(root, 'build', 'icon.icns'),
    // 图标母版是 build/icon.svg，由 scripts/render_icon.cjs 用项目自带的
    // Chromium 栅格化，再经 sips + iconutil 打成 icns。改图标走这条链，
    // 不要直接改 png。
  })
    .then((paths) => {
      const appPath = paths[0];
      const size = dirSize(appPath);
      console.log(`[build] app bundle: ${appPath}`);
      console.log(`[build] app size:   ${mb(size)}`);

      if (args.skipDmg) {
        console.log('[build] --skip-dmg，不压 dmg');
        return;
      }

      const dmg = path.join(OUT_DIR, `AI-Browser-${pkg.version}-${args.arch}.dmg`);
      console.log(`[build] creating dmg: ${dmg}`);
      // hdiutil 是 macOS 自带的，不需要 electron-builder 那套从 GitHub 下载的
      // dmg-license 等二进制——在国内网络下那一步经常卡住。
      // UDZO = zlib 压缩，比 UDBZ(bzip2) 快得多，体积只大一点。
      run('hdiutil', [
        'create',
        '-volname', `${APP_NAME} ${pkg.version}`,
        '-srcfolder', appPath,
        '-ov',
        '-format', 'UDZO',
        dmg,
      ]);

      const dmgSize = fs.statSync(dmg).size;
      console.log('');
      console.log('[build] ===== 结果 =====');
      console.log(`[build] dmg:  ${dmg}`);
      console.log(`[build] size: ${mb(dmgSize)}`);
      console.log(`[build] app:  ${mb(size)}（解压后占用）`);
      console.log('[build] 未签名、未公证：用户需要"右键 → 打开"，见 docs/ 说明');
    })
    .catch((e) => {
      console.error(`[build] FAILED: ${e.message}`);
      process.exit(1);
    });
}

if (require.main === module) main();

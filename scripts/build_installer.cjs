'use strict';
// scripts/build_installer.cjs — 把已打包好的便携目录 dist/AI Browser-win32-x64
// 打成**单文件 Windows 安装器**（NSIS，electron-builder 的 win nsis target）。
//
// 前提：先 `npm run build:win` 产出 dist/AI Browser-win32-x64/。
// 产出：dist/installer/AI-Browser-<version>-win32-x64-Setup.exe
// 用法：node scripts/build_installer.cjs [--silent]
//
// 为什么是 NSIS 而不是 Squirrel（2026-11-06 换的）：
//   Squirrel 装完**不会自己建快捷方式** —— 它把新装的 app 用 `--squirrel-install`
//   拉起来，指望 app 自己调 `Update.exe --createShortcut`（官方 README 里写的就是
//   这段）。而且就算调了，Squirrel 会把开始菜单项塞进 `Programs\<CompanyName>\`
//   子文件夹（CompanyName 取自 exe 的 rcedit 元数据），用户在开始菜单顶层搜不到。
//   实测日志（%LOCALAPPDATA%\AIBrowser\Squirrel-Shortcut.log）：
//     Creating shortcut for AI Browser.exe =>
//       ...\Start Menu\Programs\Glittering\AI Browser.lnk
//   NSIS 是 Windows 上 Electron 应用的标准解（VS Code / Slack / Discord 都是），
//   安装即建开始菜单（顶层）+ 桌面快捷方式，卸载项进「应用和功能」，全程按用户
//   安装、不需要管理员权限。
//
// 装到哪：%LOCALAPPDATA%\Programs\ai-browser\（perMachine: false）
// 用户数据仍旧在 ~/.ai-browser —— 卸载不碰它（deleteAppDataOnUninstall: false）。

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
  if (!fs.existsSync(icoPath)) {
    // 以前这里会静默退回 Electron 默认图标；装给别人用的包不该有默认图标。
    console.error(`[installer] 缺少 ${icoPath}\n  先生成: node_modules/electron/dist/electron.exe scripts/make_win_icon.cjs`);
    process.exit(2);
  }

  const setupExe = `AI-Browser-${pkg.version}-win32-x64-Setup.exe`;

  // electron-builder 是 CJS 包，但加载会拉起 app-builder 二进制，放在函数里 require
  // 才能让「参数检查失败」先于「依赖缺失」报出来。
  const { build, Platform, Arch } = require('electron-builder');

  // electron-builder 有一条硬校验：electron 只能出现在 devDependencies。
  // 而本项目必须把 electron 放在 dependencies —— npm 包靠它才能真正启动浏览器。
  // 所以在 dist/ 下开一个临时「构建项目」，只给它一份满足校验的最小 package.json，
  // 把产物目录用 prepackaged 指过去。真实 package.json 一个字节都不动。
  const staging = path.join(root, 'dist', '.nsis-project');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
    name: 'ai-browser',
    version: pkg.version,
    description: pkg.description,
    author: 'Glittering',
    license: pkg.license,
    devDependencies: { electron: require('electron/package.json').version },
  }, null, 2));

  console.log(`[installer] ${pkg.version} — NSIS Setup.exe`);
  console.log(`[installer] appDirectory: ${APP_DIR}`);
  console.log(`[installer] outputDirectory: ${OUT_DIR}`);

  const config = {
    appId: 'com.glittering.aibrowser',
    productName: 'AI Browser',
    copyright: `Copyright © ${new Date().getFullYear()} Glittering`,
    // 只出安装器，不去猜发布通道（仓库里有 repository 字段，不写 null 会去探 GitHub）
    publish: null,
    directories: {
      output: OUT_DIR,
      buildResources: path.join(root, 'build'),
    },
    // 安装器不重新打包：直接吃 build:win 的产物，asar / 图标 / 元数据都不动
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: icoPath,
      executableName: 'AI Browser',
      artifactName: setupExe,
    },
    nsis: {
      // 向导式（不是一键装），让用户能选盘符 / 看到装到哪
      oneClick: false,
      // 按当前用户安装，不弹 UAC
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      // 这两条就是这次要的：装完自动有开始菜单 + 桌面快捷方式
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'AI Browser',
      // 开始菜单放在顶层，不套「Glittering」子文件夹（Squirrel 的老毛病）
      menuCategory: false,
      // 装完直接启动，第一次用的人不用去找图标
      runAfterFinish: true,
      // 卸载保留 ~/.ai-browser：里面的 profile / 登录态是用户的东西
      deleteAppDataOnUninstall: false,
      uninstallDisplayName: `AI Browser ${pkg.version}`,
      installerIcon: icoPath,
      uninstallerIcon: icoPath,
      installerHeaderIcon: icoPath,
      // 中文用户在中文系统上看到中文向导
      multiLanguageInstaller: true,
      installerLanguages: ['zh_CN', 'en_US'],
      // 差分包只对自动更新有意义，单文件分发用不上
      differentialPackage: false,
    },
  };

  return build({
    // 在临时构建项目里跑，只为了绕开上面那条 electron 依赖校验
    projectDir: staging,
    prepackaged: APP_DIR,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config,
  }).then(() => {
    const out = path.join(OUT_DIR, setupExe);
    if (!fs.existsSync(out)) {
      const files = fs.readdirSync(OUT_DIR).filter((n) => /Setup\.exe$/i.test(n));
      console.error('[installer] 预期文件名未出现，目录内 Setup.exe：', files);
      process.exit(1);
    }
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`[installer] 完成：${out}（${mb} MB）`);
    return out;
  });
}

main().catch((e) => { console.error('[installer] 失败：', (e && e.stack) || e); process.exit(1); });

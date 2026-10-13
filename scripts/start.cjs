#!/usr/bin/env node
// scripts/start.cjs — 启动 Electron，并清掉会让它退化成 Node 的环境变量。
//
// # 为什么需要这个文件（2026-10-12 实测）
// 本机（以及某些 agent 运行环境）带着 `ELECTRON_RUN_AS_NODE=1`。这个变量会让
// Electron 的可执行文件**当作普通 Node 运行**，于是 `electron .` 变成"用 Node 去
// 加载 ESM 入口"，直接崩：
//
//     node:internal/modules/esm/translators:379
//     TypeError: Cannot read properties of undefined (reading 'exports')
//         at cjsPreparseModuleExports (node:internal/modules/esm/translators:379:81)
//
// 端口永不监听，应用等于没起来。而**报错完全不提 Electron** —— 看到这栈的人会去
// 查 Node 的 ESM 加载器，方向整个错掉。本机 shell 就带着这个变量，`npm start`
// 100% 复现。
//
// 之前 e2e 脚本全都 `delete childEnv.ELECTRON_RUN_AS_NODE`，但 `npm start` 本身
// 和 MCP 的自动拉起漏了。放在 launcher 里一次解决，且跨平台（不依赖 shell 的
// `env -u`，Windows 上没有）。
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/**
 * Launch the Electron app in the foreground (stdio inherited).
 *
 * Works both from a git checkout and from an installed npm package: it resolves
 * the electron binary through Node's own resolution and points it at the app
 * root explicitly instead of relying on `electron .` + cwd conventions.
 *
 * Returns the child process. Callers may attach their own exit handling; when
 * run as a script the exit code is forwarded so npm/npx sees real failures.
 */
function launchElectron() {
  const { resolveElectronBinary } = require('./electron_resolve.cjs');
  const electron = resolveElectronBinary();

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return spawn(electron, [root], { cwd: root, stdio: 'inherit', env });
}

module.exports = { launchElectron, appRoot: root };

if (require.main === module) {
  const child = launchElectron();

  child.on('exit', (code, signal) => {
    // 子进程被信号杀死时 code 是 null，用 1 退出，避免 npm 认为成功。
    process.exit(code === null && signal ? 1 : (code ?? 0));
  });
  child.on('error', (e) => {
    console.error('[start] failed to launch Electron:', e.message);
    process.exit(1);
  });
}

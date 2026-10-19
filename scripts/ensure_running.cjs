#!/usr/bin/env node
// scripts/ensure_running.cjs — 幂等地把浏览器弄起来，CLI 与 MCP **共用这一份**。
//
// # 为什么抽出来（2026-10-20）
//
// 原来这段只活在 mcp_server.js 里（ensureElectronRunning）。后果是：
//   • 走 MCP 的 agent：浏览器没开也能用（服务端自动拉起）；
//   • 走 CLI 的 agent：连不上只会看到 "先 ai-browser start" —— 得学两步。
// 而「装完就能用」要求的是**一条命令**。所以把拉起逻辑挪到共享模块，
// 两个壳调用同一份实现（与项目一贯的"一套实现、多个薄壳"对齐）。
//
// # 三个坑（都是实测踩出来的，别删）
//
// ① `ELECTRON_RUN_AS_NODE` 必须删掉。本机 shell 就带着它，此时 electron 二进制
//    会当普通 Node 跑，拿 Node 加载 ESM 入口直接崩，端口永不监听，而报错是一串
//    Node 的 ESM 栈 —— 完全不提 Electron。
// ② 必须 `detached` + `unref()`。否则调用方（CLI 进程）一退出，浏览器被一起带走。
// ③ 失败必须**带原因**。之前 return false 被上层 catch 吞掉，agent 先重试 120 秒，
//    最后只拿到 "connection refused"，没有任何线索说明浏览器根本没起来。
//
// # macOS 的沙箱兜底（第四个坑）
//
// 在受限运行环境里（agent 的沙箱 shell）直接 spawn Chromium，会以
// "sandbox initialization failed: Operation not permitted" 挂掉 —— 沙箱能力
// 随父进程继承，`--no-sandbox` 也救不了。此时改走 LaunchServices：
//   open -n -a <Electron.app> --args <appRoot>
// 新进程由 launchd 拉起，不继承父进程的沙箱限制。这条兜底不是 hack，是 macOS
// 上启动 GUI 应用的**正规方式**（Finder 双击走的就是它）。
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 9223;
const DEFAULT_TIMEOUT = 30000;

/** 端口上有没有人在听。超时 500ms —— 只探本地回环，不该慢。 */
function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.setTimeout(500);
  });
}

/** 轮询等到端口起来，或超时。`abort()` 说"别等了"时立刻放弃（子进程已经没了）。 */
async function waitForPort(port, timeoutMs, stepMs = 400, abort = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true;
    if (abort && abort()) return false;   // 子进程已经报错退出，再等只是浪费
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/**
 * 从 electron 二进制路径反推 macOS 的 .app 包路径。
 * `/x/Electron.app/Contents/MacOS/Electron` → `/x/Electron.app`
 * 非 mac / 路径不含 .app 时返回 null。
 */
function appBundleFromBinary(bin) {
  if (!bin) return null;
  const i = bin.indexOf('.app' + path.sep);
  if (i < 0) return null;
  return bin.slice(0, i + 4);
}

/** 用 LaunchServices 启动（macOS）。返回是否成功把进程扔出去（不代表端口会开）。 */
function launchViaOpen(bundle, root, log) {
  try {
    const child = spawn('open', ['-n', '-a', bundle, '--args', root], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch (e) {
    log(`[ensure] open -a ${bundle} failed: ${e.message}`);
    return false;
  }
}

/**
 * 确保浏览器在跑。幂等：已经在跑就立刻返回。
 *
 * @param {object} [opts]
 * @param {number} [opts.port=9223]
 * @param {number} [opts.timeoutMs=30000]  首轮等待上限
 * @param {(msg: string) => void} [opts.log]  进度输出（走 stderr，别污染 stdout 的 result）
 * @param {boolean} [opts.allowLaunchServices=true]  macOS 沙箱失败时是否兜底走 open
 * @returns {Promise<{running:boolean, started:boolean, via:string|null, port:number}>}
 * @throws 端口始终没起来时抛错，message 里带**可执行的下一步**
 */
async function ensureRunning(opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT;
  const log = opts.log || ((m) => console.error(m));
  const allowLS = opts.allowLaunchServices !== false;

  if (await checkPort(port)) return { running: true, started: false, via: 'already', port };

  // AI_BROWSER_ELECTRON_BIN：显式指定二进制（打包版、自定义构建、e2e 用假路径）。
  // 没设就交给共享解析器（它会在二进制缺失时自己跑一遍 electron 的安装脚本）。
  let bin;
  const override = process.env.AI_BROWSER_ELECTRON_BIN;
  if (override) {
    bin = override;
  } else {
    const { resolveElectronBinary } = require('./electron_resolve.cjs');
    try {
      bin = resolveElectronBinary({ log });
    } catch (e) {
      throw new Error(
        `could not locate the Electron binary: ${e.message}\n`
        + '  fix: run `npm install` once inside the ai-browser package (this also downloads Chromium).'
      );
    }
  }

  log(`[ensure] port ${port} not listening — starting ai-browser`);

  // —— 第一轮：直接 spawn（Linux/Windows 的正常路径，macOS 也先试这个）——
  const env = { ...process.env, AI_BROWSER_LAUNCHED_BY_AGENT: '1' };
  delete env.ELECTRON_RUN_AS_NODE;   // 坑 ①
  let earlyExit = null;
  let child = null;
  try {
    child = spawn(bin, [ROOT], { cwd: ROOT, detached: true, stdio: 'ignore', env });  // 坑 ②
    child.unref();
    child.on('exit', (code, signal) => { earlyExit = { code, signal }; });
    child.on('error', (e) => { earlyExit = { error: e.message }; });
  } catch (e) {
    log(`[ensure] spawn failed: ${e.message}`);
    earlyExit = { error: e.message };
  }

  // 子进程自报错（ENOENT 之类）就别等满超时了 —— 那只会把真实原因埋掉。
  let ok = await waitForPort(port, timeoutMs, 400, () => !!(earlyExit && earlyExit.error));
  if (ok) return { running: true, started: true, via: 'spawn', port };

  // —— 第二轮：macOS 沙箱兜底，走 LaunchServices ——
  let lsTried = false;
  if (allowLS && process.platform === 'darwin') {
    const bundle = appBundleFromBinary(bin);
    if (bundle) {
      lsTried = true;
      log(`[ensure] direct spawn did not come up (${describeExit(earlyExit)}) — retrying via LaunchServices`);
      if (launchViaOpen(bundle, ROOT, log)) {
        ok = await waitForPort(port, 20000);
        if (ok) return { running: true, started: true, via: 'launchservices', port };
      }
    }
  }

  throw new Error(buildFailureMessage({ port, earlyExit, lsTried }));
}

/** 把子进程退出状态说人话。 */
function describeExit(earlyExit) {
  if (!earlyExit) return 'no exit event, port still closed';
  if (earlyExit.error) return `spawn error: ${earlyExit.error}`;
  return `exited early (code=${earlyExit.code}, signal=${earlyExit.signal})`;
}

/** 失败原因 + 用户/agent 照着能做的下一步。 */
function buildFailureMessage({ port, earlyExit, lsTried }) {
  const lines = [`could not start the browser: nothing is listening on 127.0.0.1:${port}`];
  lines.push(`  cause: ${describeExit(earlyExit)}`);
  if (lsTried) lines.push('  a LaunchServices launch (open -n -a Electron.app) was also tried and did not come up');
  lines.push(
    '  common causes:',
    '    • ELECTRON_RUN_AS_NODE is set in the environment (unset it)',
    '    • Chromium sandbox is blocked inside a container/sandbox — launch once from a normal terminal: `ai-browser start`',
    '    • Chromium binary missing or partially extracted — `npm install` in the ai-browser package',
    '    • a stale lock: another instance owns this userData dir (quit it, or use --port for a separate profile)'
  );
  return lines.join('\n');
}

module.exports = {
  ensureRunning,
  checkPort,
  waitForPort,
  appBundleFromBinary,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
  APP_ROOT: ROOT,
};

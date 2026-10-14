'use strict';
// e2e/_harness.cjs — e2e 启动阶段的公共保障。
//
// 存在理由（2026-10-15 实测，e2e/_repro_identity.cjs）：
// 套件**无法确认自己连上的是自己拉起的那个进程**。决定性实验：在"端口忙"预检
// （600ms）之后让一个冒牌 WS server 抢占端口，value 套件照常发出 ui.new_tab /
// ui.evaluate / ui.get_tree 四个调用，全程跟冒牌说话却毫无察觉。后果是——测的
// 可能是别人的实例，结论毫无意义，而且**不会报错**，只给出一堆莫名其妙的失败
// 或崩溃，让人去查一个根本不存在的产品缺陷。
//
// 两条保障：
//   1. waitPortFree —— 真等到端口空闲，而不是"探一次没通就认为空闲"
//   2. assertIdentity —— 连上之后核对服务端 pid 是不是自己 spawn 的那个
//
// 两者都不做的话，"测的是不是我以为的东西"就只能靠运气。

const net = require('node:net');

const WS_HOST = '127.0.0.1';

function tryConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, WS_HOST);
    const done = (open) => { try { s.destroy(); } catch {} resolve(open); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * 等到端口**真的**连不上为止。
 *
 * 原先每个套件用的是"探一次、600ms 内连得上就算忙"：如果上一个 Electron 还在
 * 退出途中，探测时机就是抽签。改成主动等空闲，串行跑套件时不再靠运气。
 *
 * @returns {Promise<boolean>} true = 端口已空闲；false = 超时后依然被占
 */
async function waitPortFree(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await tryConnect(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await tryConnect(port));
}

/** 等到端口可连（原 waitForPort 的公共版）。 */
async function waitPortOpen(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await tryConnect(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout waiting for port ' + port);
}

/**
 * 核对"我连上的服务端是不是我 spawn 的那个进程"。
 *
 * 不匹配时**直接退出进程**（非零码），绝不继续往下测 —— 继续测等于在一个身份
 * 不明的实例上产生一堆假失败，比当场停下来难查得多。
 *
 * @param {object} browser  tools/browser.cjs 的实例（已 ready）
 * @param {object} child    spawn 出来的子进程（要有 pid）
 * @param {string} suite    套件名，只用于报错信息
 */
async function assertIdentity(browser, child, suite = 'e2e') {
  const expectPid = child && child.pid;
  if (!expectPid) throw new Error(suite + ': assertIdentity 拿不到子进程 pid，无法核对身份');
  const res = await browser.call('ui.server_info', {});
  const info = (res && res.result) || null;
  if (!info || info.pid !== expectPid) {
    console.error('');
    console.error('!! ' + suite + ': 连上的服务端不是本次拉起的进程 —— 测的会是别人的实例，结果毫无意义。');
    console.error('   期望 pid=' + expectPid + '，实际 ' + JSON.stringify(info));
    console.error('   常见原因：端口被上一个没退干净的实例（或别的东西）占着。');
    console.error('   处理：换一个 AI_BROWSER_PORT，或先杀掉占用该端口的进程。');
    console.error('');
    process.exit(4);
  }
  return info;
}

module.exports = { WS_HOST, tryConnect, waitPortFree, waitPortOpen, assertIdentity };

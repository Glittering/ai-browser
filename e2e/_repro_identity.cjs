'use strict';
// 决定性实验：e2e 能不能发现自己连上的不是自己起的那个进程？
//
// 做法（确定性，不靠 sleep 猜时机）：spawn 套件并读它的 stdout，一旦看到
// "spawn electron" —— 说明端口预检**已经过了** —— 立刻让一个冒牌 WS server
// 抢占端口。真 Electron 随后因 EADDRINUSE 起不来。
//
//   修复前：套件照常发 ui.new_tab / ui.evaluate / ui.get_tree，全程跟冒牌说话
//           却毫无察觉 —— 测的是别人的实例，结果毫无意义，且不报错。
//   修复后：harness.assertIdentity 核对 ui.server_info.pid，当场 exit 4。
//
// 跑：REPRO_PORT=9799 node e2e/_repro_identity.cjs
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.REPRO_PORT) || 9799;

function startImpostor() {
  const seen = [];
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: PORT });
    wss.on('connection', (sock) => {
      sock.on('message', (d) => {
        let m = null;
        try { m = JSON.parse(d.toString()); } catch { return; }
        // 冒牌对 ui.server_info 也撒谎（编一个 pid），其它一律回空 result
        const result = m.method === 'ui.server_info' ? { pid: 1, started_at: 1 } : {};
        if (m.method) { seen.push(m.method); sock.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); }
      });
    });
    wss.on('listening', () => resolve({ wss, seen }));
  });
}

async function main() {
  const t0 = Date.now();
  const kid = spawn(process.execPath, [path.join(ROOT, 'e2e', 'value_ws.cjs')], {
    cwd: ROOT, env: { ...process.env, AI_BROWSER_PORT: String(PORT) },
  });
  let out = '';
  kid.stdout.on('data', (d) => { out += d.toString(); });
  kid.stderr.on('data', (d) => { out += d.toString(); });

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (/spawn electron/.test(out)) { clearInterval(tick); resolve(); }
    }, 20);
    kid.on('exit', () => { clearInterval(tick); resolve(); });
  });
  const impostor = await startImpostor();
  console.log('冒牌已抢占 ' + PORT + '（此时套件的端口预检早已通过）');

  const code = await new Promise((r) => kid.on('exit', r));
  const verdict = (out.match(/PASS=\d+ FAIL=\d+/g) || ['(无摘要)']).pop();
  console.log(`\nvalue 套件: exit=${code}  ${verdict}   (${Date.now() - t0}ms)`);
  console.log('  触发端口占用防护: ' + /is busy|一直被占用/.test(out));
  console.log('  身份核对拦截:    ' + /不是本次拉起的进程/.test(out));
  console.log('  冒牌收到的 RPC 方法数: ' + impostor.seen.length
    + (impostor.seen.length ? '  例: ' + impostor.seen.slice(0, 6).join(', ') : ''));

  const caught = /不是本次拉起的进程/.test(out);
  console.log(caught
    ? '\n>>> 已修复：身份核对当场拦下（exit 4），没有继续在冒牌上跑。'
    : '\n>>> 未修复：套件在冒牌上跑了 ' + impostor.seen.length + ' 个调用却毫无察觉。');
  impostor.wss.close();
  process.exit(caught ? 0 : 1);
}
main();

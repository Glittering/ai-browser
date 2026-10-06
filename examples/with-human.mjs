/**
 * with-human.mjs — 需要人介入时怎么办（登录 / 扫码 / 滑块验证码）。
 *
 * 怎么跑：
 *   1) 起浏览器： cd 到 ai-browser 项目根目录 && npm start
 *   2) 跑脚本：   node examples/with-human.mjs [URL]
 *                 默认 URL：https://www.zhihu.com/creator（通常需要登录）
 *                 换成你自己的目标：node examples/with-human.mjs https://mail.example.com
 *                 端口不同： AI_BROWSER_PORT=<port> node examples/with-human.mjs
 *   3) 脚本会打印一句提示并等你敲回车。这时去那个真实可见的浏览器窗口里手动完成登录，
 *      回来敲回车，脚本重新读树确认。
 *
 * ★ 这个例子想说明的核心：
 *   整个人机交接**完全发生在调用方（脚本 / agent 的对话）里**。
 *   浏览器侧没有任何"请求人工接管"的接口，也不需要——窗口本来就真实可见，人随时能上手操作，
 *   调用方只要"停下来等"，等完重新读一次语义树即可。
 *   对应的 agent 版本，就是把下面的 readline 换成一句人话：
 *     "请在浏览器窗口里扫码登录，完成后回复我'好了'"
 *   然后等用户回复，收到后 browse_get_tree 确认继续。仅此而已。
 */
import WebSocket from 'ws';
import readline from 'node:readline';

// 端口跟浏览器侧保持一致（src/shared/config.js 读的是 AI_BROWSER_PORT），
// 这样 `AI_BROWSER_PORT=9224 npm start` 之后直接跑本脚本就能连上。
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const WS_URL = `ws://localhost:${WS_PORT}`;
const URL_TO_OPEN = process.argv[2] || 'https://www.zhihu.com/creator';
const MAX_ROUNDS = 3; // 最多请人帮忙几轮，避免死循环

// 页面上出现这些字样的按钮/链接，说明还停在登录门口
const LOGIN_HINT_RE = /(登录|登陆|注册|扫码|立即登录|Sign\s*in|Log\s*in|Login|Sign\s*up)/i;

function connect(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`连接 ${WS_URL} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

let nextId = 1;
function call(ws, method, params = {}, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket 已断开'));
      return;
    }
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method} → ${msg.error.message || JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function notRunning(err) {
  console.error(`\n✗ 连不上 AI Browser（${WS_URL}）：${err.message}`);
  console.error('\n  先启动浏览器，再跑本脚本：');
  console.error('    cd <ai-browser 项目根目录> && npm start\n');
  console.error('  （如果你走 MCP，不需要手动启动：第一次调用 browse_* 会自动拉起 Electron。）\n');
}

/** 摊平语义树，只保留有 role 的节点用于判断页面状态。 */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const n of Array.isArray(node) ? node : [node]) {
    if (!n) continue;
    if (n.role) out.push(n);
    if (Array.isArray(n.children)) flatten(n.children, out);
  }
  return out;
}

/** 判断是不是还需要人动手。有登录态信号就信信号，没有就看有没有登录入口。 */
function assess(result) {
  const ctx = result?.context;
  const nodes = flatten(result?.tree);
  const loginEntry = nodes.find((n) => LOGIN_HINT_RE.test(String(n.label || '')));
  const loggedIn = ctx?.session?.logged_in;

  if (loggedIn === true) {
    return { needHuman: false, why: 'context.session.logged_in === true' };
  }
  if (loggedIn === false) {
    return { needHuman: true, why: 'context.session.logged_in === false', loginEntry };
  }
  if (loginEntry) {
    return { needHuman: true, why: `页面上还有 [${loginEntry.role}] "${loginEntry.label}"`, loginEntry };
  }
  return { needHuman: false, why: '没有登录态信号，也没看到登录入口' };
}

async function main() {
  let ws;
  try {
    ws = await connect();
  } catch (err) {
    notRunning(err);
    process.exitCode = 1;
    return;
  }

  if (!process.stdin.isTTY) {
    console.error('提示：当前 stdin 不是交互式终端，脚本可能没法等你敲回车（在真实终端里跑最稳）。');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // stdin 被关掉（非交互式终端 / CI）时 question 不会有回调，甚至会直接抛错，
  // 所以两种失败都要接住，免得脚本卡死在一句不知所云的报错上。
  const waitForEnter = (question) => new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error('STDIN_CLOSED')); } };
    try {
      rl.question(question, (answer) => { if (!settled) { settled = true; resolve(answer); } });
    } catch (e) {
      fail();
      return;
    }
    rl.once('close', fail);
  });

  try {
    await call(ws, 'ui.navigate', { url: URL_TO_OPEN });
    console.log(`\n已打开：${URL_TO_OPEN}`);

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await call(ws, 'ui.get_tree', {});
      const verdict = assess(result);

      if (!verdict.needHuman) {
        console.log(`\n✓ 无需人工介入（${verdict.why}），继续自动化流程即可。`);
        console.log(`  当前页面可交互线索：${flatten(result?.tree).length} 个有 role 的节点。`);
        break;
      }

      console.log(`\n—— 第 ${round}/${MAX_ROUNDS} 轮 ——`);
      console.log(`⚠ 需要人动手：${verdict.why}`);
      console.log('  浏览器窗口是真实可见的，请用鼠标键盘在里面完成登录 / 扫码 / 过滑块。');
      console.log('  脚本（换成 agent 的话，就是一句"请扫码登录，好了告诉我"）在这里停下来等你。');
      await waitForEnter('  完成后按回车继续… ');

      if (round === MAX_ROUNDS) {
        const again = await call(ws, 'ui.get_tree', {});
        const stillNeeds = assess(again);
        console.log(stillNeeds.needHuman
          ? `\n✗ ${MAX_ROUNDS} 轮之后仍未通过（${stillNeeds.why}）。确认一下账号/网络，或换个页面重试。`
          : '\n✓ 登录成功，可以继续了。');
        if (stillNeeds.needHuman) process.exitCode = 1;
      }
    }

    // 注意：这里故意不调 ui.quit —— 登录态存在 persist: 分区里，窗口留着下次还能接着用。
    console.log('\n窗口保持打开。要释放资源就调 ui.quit（MCP 里是 browse_quit），会关掉整个窗口和进程。');
  } catch (err) {
    if (err.message === 'STDIN_CLOSED') {
      console.error('\n✗ 读不到键盘输入（stdin 已关闭 / 非交互式终端）。');
      console.error('  这个脚本要在真实终端里跑，才能等你敲回车。');
      console.error('  在 CI 或管道里跑没有意义——换成 agent 的话，等待本来就不靠 stdin：');
      console.error('  agent 在对话里说一句"请扫码登录，好了告诉我"，然后等用户回复即可。\n');
    } else {
      console.error(`\n✗ ${err.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
    ws.close();
  }
}

main();

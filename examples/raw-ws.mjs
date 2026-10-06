/**
 * raw-ws.mjs — 不用 MCP，直接用 WebSocket 驱动 AI Browser 的最小示例。
 *
 * 怎么跑：
 *   1) 起浏览器： cd 到 ai-browser 项目根目录 && npm start    （WS 服务监听 :9223）
 *   2) 跑脚本：   node examples/raw-ws.mjs [URL]
 *                 例：node examples/raw-ws.mjs https://example.com
 *                 默认 URL：https://example.com
 *   3) 端口不是默认的，用环境变量覆盖： AI_BROWSER_PORT=9224 node examples/raw-ws.mjs
 *
 * 协议就一层：发 { jsonrpc:'2.0', id, method, params }，收 { id, result } 或 { id, error }。
 * 方法名是 ui.* ：navigate / get_tree / act / evaluate / wait / scroll / peek /
 * network_body / new_tab / close_tab / list_tabs / set_active_tab / subscribe / quit。
 */
import WebSocket from 'ws';

// 端口跟浏览器侧保持一致（src/shared/config.js 读的是 AI_BROWSER_PORT），
// 这样 `AI_BROWSER_PORT=9224 npm start` 之后直接跑本脚本就能连上。
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const WS_URL = `ws://localhost:${WS_PORT}`;
const URL_TO_OPEN = process.argv[2] || 'https://example.com';

/** 连接 WS；失败时交给调用方给出可行动的提示。 */
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

/**
 * 发一个 JSON-RPC 请求，等对应 id 的响应。
 * 服务端可能同时推订阅事件（没有 id），所以这里按 id 过滤而不是盲取第一条。
 */
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
      if (!msg || msg.id !== id) return; // 订阅事件 / 别人的响应，跳过
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
  console.error('  （如果你走 MCP，不需要手动启动：第一次调用 browse_* 会自动拉起 Electron。）');
  console.error('  （端口不对？用 AI_BROWSER_PORT=<port> 覆盖，启动浏览器时也用同一个。）\n');
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

  try {
    // 1) 打开页面
    const nav = await call(ws, 'ui.navigate', { url: URL_TO_OPEN });
    console.log(`→ ui.navigate ${URL_TO_OPEN}  ok=${JSON.stringify(nav)}`);

    // 2) 读语义树。返回形如 { tree: <根节点>, context: { modals, required_hints, messages, session, stats } }
    const { tree, context } = await call(ws, 'ui.get_tree', {});

    // 3) 打印（截断，免得刷屏；完整数据直接 JSON.stringify 即可）
    const json = JSON.stringify(tree, null, 2);
    console.log(`\n→ ui.get_tree（共 ${json.length} 字符，这里只打印前 1500）：\n`);
    console.log(json.slice(0, 1500) + (json.length > 1500 ? '\n…（已截断）' : ''));

    if (context) {
      console.log('\n→ context：');
      console.log(JSON.stringify(context, null, 2).slice(0, 800));
    }

    // 想继续玩，照着这个模式加就行：
    //   await call(ws, 'ui.act',      { action: 'click', target: '<data-ai-id>' });
    //   await call(ws, 'ui.act',      { action: 'type',  target: '<data-ai-id>', params: { text: 'hi' } });
    //   await call(ws, 'ui.evaluate', { js: 'document.title' });
    //   await call(ws, 'ui.wait',     { condition: 'text_contains', text: 'Example', timeout_ms: 10000 });
    //   await call(ws, 'ui.scroll',   { direction: 'down', amount: 500 });
    //   await call(ws, 'ui.list_tabs', {});
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    // 注意：这里不要调 ui.quit —— 那会关掉整个浏览器窗口和进程。
    ws.close();
  }
}

main();

/**
 * read-page.mjs — 打开一个 URL，读语义树，把可交互节点打印成易读列表。
 *
 * 怎么跑：
 *   1) 起浏览器： cd 到 ai-browser 项目根目录 && npm start
 *   2) 跑脚本：   node examples/read-page.mjs [URL]
 *                 例：node examples/read-page.mjs https://www.baidu.com
 *                 默认 URL：https://example.com
 *                 端口不同： AI_BROWSER_WS=ws://localhost:<port> node examples/read-page.mjs
 *
 * 输出每行一个可交互元素：索引 / role / label / data-ai-id（= 节点的 id，喂给 ui.act 的 target）。
 * 想直接喂给 agent，把打印换成 JSON.stringify(rows) 即可。
 */
import WebSocket from 'ws';

const WS_URL = process.env.AI_BROWSER_WS || 'ws://localhost:9223';
const URL_TO_OPEN = process.argv[2] || 'https://example.com';

// 这些 role 才算"能操作的东西"；其余（div/section 之类）只用来做层级上下文。
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'textarea', 'searchbox', 'checkbox', 'radio',
  'combobox', 'select', 'listbox', 'option', 'menuitem', 'tab', 'switch',
  'slider', 'file_input', 'submit', 'input',
]);

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

/** 深度优先摊平语义树，收集可交互节点。 */
function collectInteractive(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    if (!n) continue;
    const role = String(n.role || '').toLowerCase();
    const actions = Array.isArray(n.actions) ? n.actions : [];
    if (INTERACTIVE_ROLES.has(role) || actions.length > 0) {
      out.push({
        id: n.id,
        role: n.role || '?',
        label: n.label || '',
        value: n.value || '',
        states: n.states || [],
        actions,
      });
    }
    if (Array.isArray(n.children)) {
      for (const child of n.children) collectInteractive(child, out);
    }
  }
  return out;
}

function formatRow(i, n) {
  const head = `#${String(i).padStart(3)}  [${n.role}]  ${n.label ? `"${n.label}"` : '(无 label)'}`;
  const lines = [head];
  const bits = [];
  if (n.id) bits.push(`id=${n.id}`);
  if (n.actions.length) bits.push(`actions=${n.actions.join(',')}`);
  if (n.states.length) bits.push(`states=${n.states.join(',')}`);
  if (bits.length) lines.push(`        ${bits.join('  ')}`);
  if (n.value) lines.push(`        value="${String(n.value).slice(0, 80)}"`);
  return lines.join('\n');
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
    await call(ws, 'ui.navigate', { url: URL_TO_OPEN });
    console.log(`\n已打开：${URL_TO_OPEN}\n`);

    const result = await call(ws, 'ui.get_tree', {});
    const rows = collectInteractive(result?.tree);

    if (!rows.length) {
      console.log('没找到可交互节点（页面可能还在加载，或内容在跨域 iframe 里）。');
    } else {
      console.log(`可交互节点 ${rows.length} 个：\n`);
      rows.forEach((n, i) => console.log(formatRow(i + 1, n)));
    }

    const ctx = result?.context;
    if (ctx) {
      const stats = ctx.stats ? `  统计：${JSON.stringify(ctx.stats)}` : '';
      console.log(`\n页面上下文：${stats}`);
      if (ctx.modals?.length) console.log(`  弹窗：${ctx.modals.map((m) => m.header || '(无标题)').join(' / ')}`);
      if (ctx.messages?.length) console.log(`  提示消息：${ctx.messages.map((m) => m.text).join(' / ')}`);
      if (ctx.required_hints?.length) console.log(`  必填提示：${ctx.required_hints.join(' / ')}`);
    }

    console.log('\n下一步：把上面任意一行的 id 作为 target 传给 ui.act，例如');
    console.log(`  await call(ws, 'ui.act', { action: 'click', target: ${rows[0]?.id ? `'${rows[0].id}'` : "'<id>'"} });`);
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
}

main();

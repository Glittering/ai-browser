/**
 * demo.mjs — 完整交互演示：打开 Bing → 搜索 → 连续滚动浏览 → 翻到第 2 页 →
 *            回第 1 页 → 点开项目网站（自动跟随新标签）→ 在 GitHub 页内继续滚动。
 *
 * 全程只用语义 API：目标元素全部按 role/label 在当次 get_tree 里现找，
 * 不写死坐标、不靠截图。所有“等页面”都轮询语义树，网络慢也不会演砸。
 *
 * 跑法：
 *   1) 终端 A：npm start（建议用干净的单标签窗口录屏）
 *   2) 终端 B：node examples/demo.mjs
 */
import WebSocket from 'ws';

const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const START_URL = 'https://cn.bing.com';
const SEARCH_BOX = 'sb_form_q';
const QUERY = 'Glittering ai-browser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(title) {
  console.log('\n' + '─'.repeat(64));
  console.log('  ' + title);
  console.log('─'.repeat(64));
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    let nextId = 1;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    ws.on('open', () => {
      ws.call = (method, params = {}) =>
        new Promise((resolveCall, rejectCall) => {
          const id = nextId++;
          pending.set(id, (m) => (m.error ? rejectCall(new Error(m.error.message)) : resolveCall(m.result)));
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/** 在语义树里按谓词找节点（每次现找，不跨读取复用 id）。 */
function findAll(tree, pred) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (pred(n)) out.push(n);
    (n.children || []).forEach(walk);
  })(tree);
  return out;
}

/** 轮询语义树直到找到节点（而不是瞎 sleep）。页面加载中 get_tree 可能超时，忽略后继续轮询。 */
async function waitForNode(ws, pred, { timeoutMs = 15000, gapMs = 500, tab } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const t = await ws.call('ui.get_tree', { subset: 'interactive', ...(tab ? { tab } : {}) });
      const hit = findAll(t.tree, pred)[0];
      if (hit) return hit;
    } catch (e) {
      lastErr = e; // 页面还在加载 / 主线程忙 —— 继续等
    }
    await sleep(gapMs);
  }
  throw new Error('等待节点超时' + (lastErr ? `（末次错误：${lastErr.message}）` : ''));
}

/** 小步连续滚动，视觉上接近真人滑动屏幕。 */
async function smoothScroll(ws, { px = 1500, step = 150, gapMs = 120, tab } = {}) {
  let done = 0;
  while (done < px) {
    await ws.call('ui.scroll', { direction: 'down', amount: step, ...(tab ? { tab } : {}) });
    done += step;
    await sleep(gapMs);
  }
}

const ws = await connect();

banner('① 打开 Bing');
await ws.call('ui.navigate', { url: START_URL });
await waitForNode(ws, (n) => n.id === SEARCH_BOX);
await sleep(800); // 录屏节奏：让首页风景图停留片刻

banner('② 受信键盘逐字输入（注意 Bing 的实时联想）');
await ws.call('ui.act', { action: 'setContent', target: SEARCH_BOX, params: { text: QUERY } });
await sleep(1600);

banner('③ 回车提交，等结果页出现项目链接');
await ws.call('ui.act', { action: 'press', target: SEARCH_BOX, params: { key: 'Enter' } });
await ws.call('ui.wait', { condition: 'url_contains', text: '/search', timeout_ms: 10000 });
await waitForNode(ws, (n) => /^GitHub - Glittering\/ai-browser/.test(n.label || ''));
await sleep(1200);

banner('④ 逐屏滚动浏览第 1 页结果');
await smoothScroll(ws, { px: 1500 });

banner('⑤ 点“下一页”翻到第 2 页');
let tree = await ws.call('ui.get_tree', { subset: 'interactive' });
const nextPage = findAll(tree.tree, (n) =>
  String(n.role).toLowerCase() === 'link' && (n.label || '').trim() === '下一页')[0];
if (!nextPage) throw new Error('没找到“下一页”');
await ws.call('ui.act', { action: 'click', target: nextPage.id });
await waitForNode(ws, (n) => /第 1 页/.test(n.label || ''));
await sleep(1200);

banner('⑥ 第 2 页继续滚动浏览');
await smoothScroll(ws, { px: 1100 });

banner('⑦ 点“第 1 页”回到第 1 页');
tree = await ws.call('ui.get_tree', { subset: 'interactive' });
const pageOne = findAll(tree.tree, (n) =>
  String(n.role).toLowerCase() === 'link' && /第 1 页/.test(n.label || ''))[0];
if (!pageOne) throw new Error('没找到回第 1 页的锚点');
await ws.call('ui.act', { action: 'click', target: pageOne.id });
await waitForNode(ws, (n) => /^GitHub - Glittering\/ai-browser/.test(n.label || ''));
await sleep(1000);

banner('⑧ 点开项目网站（结果在新标签打开，自动切过去）');
tree = await ws.call('ui.get_tree', { subset: 'interactive' });
const ghLink = findAll(tree.tree, (n) =>
  String(n.role).toLowerCase() === 'link' && /^GitHub - Glittering\/ai-browser/.test(n.label || ''))[0];
if (!ghLink) throw new Error('第 1 页没找到 GitHub 项目结果');
const clicked = await ws.call('ui.act', { action: 'click', target: ghLink.id });
console.log('   opened_tab:', JSON.stringify(clicked.opened_tab));
const newTab = clicked.opened_tab?.id;

// Bing 的外链点击先走重定向中间页，偶尔会挂在新标签里；标签迟迟不加载时，
// 用它给出的最终 URL 显式导航兜底（不伪造结果，只是把同一条跳转走完）。
await sleep(2500);
let tabState = (await ws.call('ui.list_tabs', {})).tabs.find((t) => t.id === newTab);
if (clicked.opened_tab?.url && (!tabState?.title || !tabState?.url?.includes('github.com'))) {
  console.log('   重定向未完成，显式导航到', clicked.opened_tab.url);
  await ws.call('ui.navigate', { url: clicked.opened_tab.url, tab: newTab });
}

banner('⑨ 等 GitHub 页面渲染出来，再在网站里滚动浏览');
await waitForNode(ws, (n) =>
  String(n.role).toLowerCase() === 'link' && /Glittering\/ai-browser|^Glittering$|^ai-browser$/.test(n.label || ''),
  { timeoutMs: 30000, gapMs: 700, tab: newTab });
const tabs = await ws.call('ui.list_tabs', {});
const active = tabs.tabs.find((t) => t.active) || tabs.tabs[tabs.tabs.length - 1];
console.log('   当前标签:', active.title.slice(0, 80));
await smoothScroll(ws, { px: 1700, tab: active.id });

banner('⑩ 回读网站语义树（仍然不是截图）');
const repoTree = await ws.call('ui.get_tree', { subset: 'interactive', tab: active.id });
const repoLinks = findAll(repoTree.tree, (n) =>
  String(n.role).toLowerCase() === 'link' && /README|MIT license|Releases|Pull requests|Issues|Glittering\/ai-browser/.test(n.label || ''))
  .slice(0, 6);
repoLinks.forEach((n, i) => console.log(`   ${i + 1}. ${n.label.slice(0, 60)}`));

console.log('\n演示完成：打开 → 搜索 → 浏览 → 翻页 → 回页 → 打开网站 → 页内浏览，全程语义驱动。');
ws.close();

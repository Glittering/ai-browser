/**
 * human-takeover.mjs — 人机共驾：agent 开车，中途人接管，然后 agent 接着干。
 *
 * 没有"交接模式"，也没有锁。交接只是：调用方停下来 → 人直接操作真实浏览器窗口
 * → 调用方继续。本示例里 agent 全程只轮询 ui.list_tabs 观察，直到发现你点开了
 * 一篇文章（URL 出现 /post/）——然后在你选定的页面上重新读树、滚动。
 *
 * 怎么跑：
 *   1) npm start
 *   2) node examples/human-takeover.mjs
 *   3) 看到 “▶ YOUR TURN” 后，用鼠标在浏览器窗口里点任意一篇文章标题
 *      （24 秒内；开新标签页也能被发现）
 */
import WebSocket from 'ws';

const WS_URL = `ws://localhost:${Number(process.env.AI_BROWSER_PORT) || 9223}`;
const FEED_URL = 'https://juejin.cn/frontend';
const ARTICLE_RE = /juejin\.cn\/post\//;
const WAIT_MS = 24000;

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  req: s => `\x1b[1;36m${s}\x1b[0m`,
  ok: s => `\x1b[1;32m${s}\x1b[0m`,
  mag: s => `\x1b[1;35m${s}\x1b[0m`,
  yel: s => `\x1b[1;33m${s}\x1b[0m`,
  red: s => `\x1b[1;31m${s}\x1b[0m`,
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const vw = s => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const clip = (s, w) => {
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of s) { if (vw(out + ch) > w) return out + '…'; out += ch; }
  return s;
};
const isNum = s => /^(\d+(\.\d+)?k?)$/.test((s || '').trim());

let nextId = 1;
function call(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = raw => {
      const x = JSON.parse(raw.toString());
      if (x.id !== id) return;
      ws.off('message', onMsg);
      x.error ? reject(new Error(x.error.message)) : resolve(x.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}
const countNodes = n => 1 + (n.children || []).reduce((a, c) => a + countNodes(c), 0);

function extractCards(tree) {
  const parent = new Map();
  (function link(n, p) { if (p) parent.set(n, p); for (const c of n.children || []) link(c, n); })(tree, null);
  const cards = [];
  (function walk(n) {
    if (n.role === 'generic' && (n.actions || []).includes('click') && n.children) {
      const nums = [];
      let author = null;
      (function sub(x) {
        if (x.role === 'generic' && !(x.children || []).length && isNum(x.label)) nums.push(x.label.trim());
        for (const c of x.children || []) {
          if (c.role === 'link' && !author && (c.label || '').length <= 12) author = (c.label || '').trim();
          sub(c);
        }
      })(n);
      if (author && nums.length >= 2) {
        const box = parent.get(n) || n;
        const links = [];
        (function cc(x) { if (x.role === 'link') links.push(x); for (const c of x.children || []) cc(c); })(box);
        const title = links.filter(l => vw(l.label || '') > 18)[0];
        if (title) cards.push({ title: clip(title.label, 36), author: clip(author, 10), id: title.id });
      }
    }
    for (const c of n.children || []) walk(c);
  })(tree);
  const seen = new Set();
  return cards.filter(c => seen.has(c.id) ? false : (seen.add(c.id), true));
}

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', () => rej(new Error(`连不上 ${WS_URL}，先 npm start`)));
  });

  console.log(C.mag(`${WS_URL}  — human + agent, same browser, same socket`));

  // 阶段 1：agent 自己开车
  console.log('\n' + C.mag('$ agent: ui.navigate + ui.get_tree  (I am driving)'));
  await call(ws, 'ui.navigate', { url: FEED_URL });
  console.log(C.ok('navigated'));
  await sleep(2500);
  const r = await call(ws, 'ui.get_tree', { subset: 'interactive' });
  console.log(C.ok(`tree: ${countNodes(r.tree)} nodes — feed:`));
  extractCards(r.tree).slice(0, 3).forEach((x, i) =>
    console.log(`  ${C.mag('#' + (i + 1))} ${C.req(x.title)} ${C.dim('— ' + x.author)}`));
  await sleep(1000);

  // 阶段 2：交接——没有交接 API，agent 只是停下来观察标签页
  console.log('\n' + C.yel('▶ YOUR TURN — click any article title in the browser window'));
  console.log(C.dim('  agent is just watching the tabs (no prompt, no permission)…'));
  const deadline = Date.now() + WAIT_MS;
  let picked = null;
  while (Date.now() < deadline) {
    const { tabs } = await call(ws, 'ui.list_tabs');
    const art = tabs.find(t => ARTICLE_RE.test(t.url || ''));
    if (art) { picked = art; break; }
    await sleep(600);
  }
  if (!picked) {
    console.log(C.red('✗ 超时：没有检测到文章页，重跑即可。'));
    ws.close(); process.exit(1);
  }
  if (!picked.active) await call(ws, 'ui.set_active_tab', { tab: picked.id });

  // 阶段 3：agent 发现你的选择，在你的页面上接着干
  console.log(C.ok('✓ detected it — YOU opened a new page. Re-reading the tree:'));
  console.log(C.dim('  ' + picked.url));
  await sleep(2000);
  const r2 = await call(ws, 'ui.get_tree', { subset: 'interactive' });
  const flat = [];
  (function w(n) { flat.push(n); for (const c of n.children || []) w(c); })(r2.tree);
  const h1Idx = flat.findIndex(n => /^e:h1-/.test(n.id || '') && vw(n.label || '') > 10);
  if (h1Idx >= 0) console.log(C.yel('page you chose: ') + C.req(clip(flat[h1Idx].label, 58)));
  await sleep(800);

  console.log('\n' + C.mag('$ agent resumes on YOUR page: ui.scroll down 700'));
  await call(ws, 'ui.scroll', { direction: 'down', amount: 700 });
  console.log(C.ok('scrolled — driven by the agent again'));

  console.log('\n' + C.ok('✓ No lock, no handoff API. The window stayed real — one socket, both hands.\n'));
  ws.close();
}

main().catch(err => { console.error('ERR', err.message); process.exit(1); });

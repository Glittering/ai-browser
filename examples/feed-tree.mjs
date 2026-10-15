/**
 * feed-tree.mjs — 复杂信息页 → 规整结构：原始 WebSocket JSON-RPC 完整示例。
 *
 * 演示 docs/marketing/demo.gif 里的完整流程（无 SDK，协议就一层）：
 *   1) ui.navigate            打开一个真实的、信息密集的页面（默认：掘金前端频道）
 *   2) ui.get_tree            整页一次返回成语义树（几百个 role/label/action 节点）
 *   3) 纯函数从树里提取结构    导航分类、文章卡（标题/作者/阅读/评论/标签）
 *   4) ui.act + 再取一次树     点“最新”切换信息流，证明树始终是页面当下的真实映射
 *
 * 怎么跑：
 *   1) npm start
 *   2) node examples/feed-tree.mjs                 # 默认掘金前端频道
 *      node examples/feed-tree.mjs <url>           # 换任何 URL（提取规则按页面调整）
 *      AI_BROWSER_PORT=9224 node examples/feed-tree.mjs
 *
 * 注意：卡片提取是按掘金当前的 a11y 结构写的，换站点要换选择规则——
 * 但“get_tree 拿树 → 按 role/父子关系纯函数提取 → act 操作元素 id”这条链路是通用的。
 */
import WebSocket from 'ws';

const WS_URL = `ws://localhost:${Number(process.env.AI_BROWSER_PORT) || 9223}`;
const TARGET_URL = process.argv[2] || 'https://juejin.cn/frontend';

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  req: s => `\x1b[1;36m${s}\x1b[0m`,
  ok: s => `\x1b[1;32m${s}\x1b[0m`,
  mag: s => `\x1b[1;35m${s}\x1b[0m`,
  yel: s => `\x1b[1;33m${s}\x1b[0m`,
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
const findFirst = (n, pred) => pred(n) ? n : (n.children || []).reduce((a, c) => a || findFirst(c, pred), null);

/**
 * 从掘金语义树提取文章卡。
 * 卡片 meta 在 a11y 树里是一个可点击 generic：内含 1 个作者 link + 阅读数/评论数两个数字叶子；
 * 标题是其父容器下最长的 link；标签是父容器下的短 link。
 * 任何站点都能照这个“找锚点节点 → 父子邻域取字段”的模式重写。
 */
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
        const tags = (box.children || []).filter(c => c.role === 'link' && vw(c.label || '') <= 12).map(c => (c.label || '').trim());
        if (title) {
          cards.push({ title: clip(title.label, 44), author: clip(author, 10), reads: nums[0], replies: nums[1], tags: tags.slice(0, 3), id: title.id });
        }
      }
    }
    for (const c of n.children || []) walk(c);
  })(tree);
  const seen = new Set();
  return cards.filter(c => seen.has(c.id) ? false : (seen.add(c.id), true));
}

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', () => rej(new Error(`连不上 ${WS_URL}，先 npm start`))); });

  console.log(C.mag(`${WS_URL}  — raw WebSocket JSON-RPC`));

  // 1) navigate
  console.log('\n' + C.mag('$ ui.navigate  → a noisy real-world page'));
  console.log(C.dim('→ ') + C.req(JSON.stringify({ method: 'ui.navigate', params: { url: TARGET_URL } })));
  await call(ws, 'ui.navigate', { url: TARGET_URL });
  console.log(C.dim('← ') + C.ok('{"ok":true}'));
  await sleep(2500);

  // 2) get_tree
  console.log('\n' + C.mag('$ ui.get_tree  → the whole page returns as one tree'));
  console.log(C.dim('→ ') + C.req(JSON.stringify({ method: 'ui.get_tree', params: { subset: 'interactive' } })));
  const r = await call(ws, 'ui.get_tree', { subset: 'interactive' });
  let count = 0; (function c(n) { count++; for (const x of n.children || []) c(x); })(r.tree);
  console.log(C.dim('← ') + C.ok(`tree: ${count} nodes`));

  // 3) 纯函数提取：排行榜导航 + 文章卡
  const NAV = ['综合', '后端', '前端', 'Android', 'iOS', '人工智能', '开发工具'];
  const navSeen = new Set();
  const nav = [];
  (function w(n) {
    const t = n.role === 'link' ? (n.label || '').trim() : '';
    if (t && NAV.includes(t) && !navSeen.has(t)) { navSeen.add(t); nav.push(t); }
    for (const c of n.children || []) w(c);
  })(r.tree);
  nav.sort((a, b) => NAV.indexOf(a) - NAV.indexOf(b));
  console.log('\n' + C.yel('rankings: ') + nav.map(x => C.ok(x)).join(C.dim(' · ')));
  console.log('\n' + C.yel('feed:'));
  extractCards(r.tree).slice(0, 6).forEach((x, i) => {
    console.log(`  ${C.mag('#' + (i + 1))} ${C.req(x.title)}`);
    console.log(`      ${x.author} ${C.dim('·')} ${C.ok(x.reads + ' reads')} ${C.dim('·')} ${C.ok(x.replies + ' replies')} ${C.dim('·')} ${x.tags.map(t => C.yel(t)).join(C.dim(' '))}`);
  });
  await sleep(800);

  // 4) act：点“最新”，再取树——结构随页面即时变化
  console.log('\n' + C.mag('$ ui.act  → switch the feed to "latest", then read the tree again'));
  const latest = findFirst(r.tree, n => n.role === 'link' && (n.label || '').trim() === '最新');
  if (latest) {
    console.log(C.dim('→ ') + C.req(JSON.stringify({ method: 'ui.act', params: { action: 'click', target: latest.id } })));
    await call(ws, 'ui.act', { action: 'click', target: latest.id }).catch(e => ({ error: e.message }));
    console.log(C.dim('← ') + C.ok('{"success":true}'));
    await sleep(2000);
    const r2 = await call(ws, 'ui.get_tree', { subset: 'interactive' });
    console.log('\n' + C.yel('latest feed:'));
    extractCards(r2.tree).slice(0, 3).forEach((x, i) =>
      console.log(`  ${C.mag('#' + (i + 1))} ${C.req(x.title)} ${C.dim('— ' + x.author)}`));
  } else {
    console.log(C.dim('（本页没找到“最新”入口，跳过 act 演示）'));
  }

  console.log('\n' + C.ok(`✓ ${count} noisy nodes in, typed structure out — no SDK, just JSON over a socket.\n`));
  ws.close();
}

main().catch(err => { console.error('ERR', err.message); process.exit(1); });

// e2e/realsites/runner.cjs — 真实站通用"三件套" runner（表驱动执行）
// 对每个站点执行：navigate 不抛错 → get_tree 非空(≥minNodes) → 上层信息可读。
// loginWall 站点用"探测到登录墙即 PASS"（不再做深度断言）。
// 用法：被 e2e_realsites.cjs 调用；也支持直接 `node e2e/realsites/runner.cjs [--runs N] [--only 名称]`
const path = require('node:path');
const { Browser } = require(path.join(__dirname, '..', '..', 'tools/browser.cjs'));
const SITES = require('./sites.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 深度遍历语义树，统计节点数
function countNodes(tree) {
  let n = 0;
  (function walk(x) {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    n += 1;
    if (x.children) x.children.forEach(walk);
    if (x.nodes) x.nodes.forEach(walk);
  })(tree);
  return n;
}

// 登录墙探测：context.session 未登录，或页面存在登录类元素
const LOGIN_HINT_JS = `
(function(){
  var t=(document.body?document.body.innerText:'').slice(0,2000);
  var kw=['\\u767b\\u5f55','\\u8bf7\\u767b\\u5f55','\\u767b\\u5165','login','sign in','\\u4ece\\u672a\\u767b\\u5f55'];
  var hit=kw.filter(function(k){return t.indexOf(k)>=0;}).slice(0,3);
  var el=document.querySelector('input[type=password],[placeholder*=\\u8bf7\\u8f93\\u5165\\u624b\\u673a],[class*=login],[class*=sign-in]');
  return JSON.stringify({hit:hit,hasLoginEl:!!el,bodyLen:(document.body?document.body.innerText:'').length,title:document.title,url:location.href});
})()
`;

async function analyzeSite(b, site) {
  const out = {
    name: site.name,
    ok: false,
    kind: 'node', // node | login_wall | error | node_missing
    nodes: 0,
    title: '',
    url: '',
    note: '',
  };
  try {
    const nav = await b.navigate(site.url);
    if (nav && nav.error) throw new Error('navigate: ' + (nav.error.message || JSON.stringify(nav.error)));
    await sleep(3500); // 给真实站动态加载留时间

    const raw = await b.getTree();
    const result = raw && (raw.result || raw);
    const tree = result && (result.tree || result.root || result);
    const context = result && result.context;
    out.nodes = countNodes(tree);
    out.title = (tree && (tree.title || (tree.label))) || (context && context.page_title) || '';
    out.url = site.url;

    // 仅显式标记 loginWall:true 的站才走"登录墙容忍"（探测到登录即 PASS，不做深度断言）。
    // 其他站 fall through 到下方 node 数校验，避免普通公共站点被误放行。
    if (site.loginWall === true) {
      const probe = await b.evaluate(LOGIN_HINT_JS);
      let probeObj = {};
      try { probeObj = JSON.parse((probe && probe.result && probe.result.value) || '{}'); } catch {}
      const hitLogin = (probeObj.hasLoginEl) || (Array.isArray(probeObj.hit) && probeObj.hit.length > 0);
      if (hitLogin) {
        out.ok = true;
        out.kind = 'login_wall';
        out.note = '登录墙(容忍)' + (Array.isArray(probeObj.hit) && probeObj.hit.length ? ' 命中:' + probeObj.hit.join('/') : '');
        return out;
      }
      // 未探到登录 → 落入下方 node 校验
    }

    if (out.nodes >= site.minNodes) {
      out.ok = true;
      out.kind = 'node';
    } else {
      out.kind = 'node_missing';
      out.note = 'nodes=' + out.nodes + ' < minNodes=' + site.minNodes;
    }
  } catch (e) {
    out.kind = 'error';
    out.note = e.message;
  }
  return out;
}

async function runContract(sites = SITES, opts = {}) {
  const runs = opts.runs || 1;
  const only = opts.only || null;
  const b = new Browser();
  let PASS = 0, FAIL = 0;
  try {
    await b.ready();
    for (const site of sites) {
      if (only && site.name !== only) continue;
      let final = null;
      // 双跑规则：质量门开 runs=2，任一 run 成功即判通过；全部失败判 flaky/失败
      for (let i = 0; i < runs; i++) {
        final = await analyzeSite(b, site);
        if (final.ok) break;
        if (i < runs - 1) await sleep(1000);
      }
      if (final.ok) PASS++;
      else FAIL++;
      const tag = final.ok ? 'PASS' : 'FAIL';
      console.log(`  ${tag} | ${site.name} [${site.bucket}] — ${final.kind}${final.title ? (' title=' + String(final.title).slice(0, 40)) : ''}${final.note ? ' ' + final.note : ''}`);
    }
  } finally {
    try { b.close(); } catch {}
  }
  return { PASS, FAIL };
}

module.exports = { runContract, analyzeSite, countNodes, SITES };

// 支持直接运行：node e2e/realsites/runner.cjs [--runs 2] [--only 名称]
if (require.main === module) {
  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith('--runs='));
  const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const runs = runsArg ? Number(runsArg.split('=')[1]) : 1;
  runContract(SITES, { runs, only: onlyArg }).then(({ PASS, FAIL }) => {
    console.log(`\n==== realsites runner PASS=${PASS} FAIL=${FAIL} ====`);
    process.exit(FAIL ? 1 : 0);
  }).catch((e) => { console.error('runner error:', e.message); process.exit(2); });
}
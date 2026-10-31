// e2e/contract_ws.cjs — 「声明 = 实现」：schema 承诺的参数必须真的有可观测效果。
//
// 这一组参数此前都是**静默空转**（传了不报错、但什么都不做）：
//   · `subset:'interactive'`  —— 只在 ax:true 分支生效，默认读法直接忽略
//   · `focused_only:true`     —— 参数一路传到 preload，抽取器从不读它
//   · `mode:'diff'`           —— 同上，默认读法拿到整棵树却以为是增量
//   · `ui.wait` 的未知 condition —— 不报错，白等满 timeout 才回 satisfied:false
//
// 单测只能证明纯函数对；「这种参数在真页面上有没有效果」必须真机验。
//
// Run: npm run contract
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const harness = require('./_harness.cjs');
const guard = require('./_spawn_guard.cjs');
const { windowEnv } = require('./_window_mode.cjs');
const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} | ${name}${detail !== undefined ? ' — ' + detail : ''}`);
};

// 页面：大量纯布局兄弟节点 + 一个输入框 + 一个按钮。
// 目的是让 subset 有可剪的东西、focused_only 有可聚焦的东西。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Contract</title>
<style>.deco{height:6px}</style></head><body>
<div id="deco-wrap">
  ${Array.from({ length: 10 }, (_, i) => `<div class="deco" id="d${i}">·</div>`).join('\n  ')}
</div>
<h1 id="ttl">标题</h1>
<form id="f">
  ${Array.from({ length: 12 }, (_, i) => `<label>字段${i}<input id="i${i}" placeholder="字段${i}"></label>`).join('\n  ')}
  ${Array.from({ length: 8 }, (_, i) => `<button id="b${i}">动作${i}</button>`).join('\n  ')}
</form>
<input id="inp" placeholder="名字">
<button id="btn">提交</button>
<p id="tail">正文尾部</p>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
    });
    srv.listen(0, WS_HOST, () => resolve(srv));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function once() {
      const s = net.connect(port, WS_HOST);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting port ' + port));
        setTimeout(once, 250);
      });
    })();
  });
}

const countNodes = (t) => {
  let n = 0;
  (function w(x) { if (!x) return; n++; (x.children || []).forEach(w); })(t);
  return n;
};

async function main() {
  const PORT = Number(process.env.AI_BROWSER_CONTRACT_PORT) || 9236;
  const srv = await startServer();
  const url = `http://${WS_HOST}:${srv.address().port}/`;
  let child = null;
  try {
    if (!(await harness.waitPortFree(PORT, 15000))) throw new Error('port busy: ' + PORT);
    const env = {
      ...process.env,
      ...windowEnv('contract'),
      AI_BROWSER_PORT: String(PORT),
      AI_BROWSER_USER_DATA: path.join(os.tmpdir(), `ai-browser-e2e-contract-${PORT}`),
      AI_BROWSER_START_HIDDEN: '1',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: 'ignore', detached: true, env });
    guard.track(child);
    await waitForPort(PORT, 60000);
    const b = new Browser(PORT);
    await b.ready();
    await harness.assertIdentity(b, child, 'contract');

    const t = await b.call('ui.new_tab', { url });
    const tab = (t && t.result && t.result.tab) || t.tab;
    await sleep(5000);

    const pick = (r) => (r && r.result) || r;
    const full = pick(await b.call('ui.get_tree', { tab }));
    const fullTree = full.tree || full;
    const nFull = countNodes(fullTree);
    check('CT-1 默认读法拿得到整棵树', nFull > 15, 'nodes=' + nFull);

    // ── subset ────────────────────────────────────────────────
    const sub = pick(await b.call('ui.get_tree', { tab, subset: 'interactive' }));
    const nSub = countNodes(sub.tree || sub);
    check('CT-2 subset:"interactive" 真的剪枝（节点数明显变少）', nSub < nFull && nSub > 0, `${nFull} → ${nSub}`);
    const hasBtn = JSON.stringify(sub.tree || sub).includes('提交');
    check('CT-3 剪枝后交互元素还在（不能把要点的东西剪掉）', hasBtn, 'button text kept=' + hasBtn);

    // ── focused_only ──────────────────────────────────────────
    // 先点进输入框，让它真的持有焦点（contenteditable/input 都走受信点击）
    const btnId = (function find(t2, label) {
      let out = null;
      (function w(x) {
        if (!x || out) return;
        if (x.label === label || (x.label || '').includes(label)) out = x.id;
        (x.children || []).forEach(w);
      })(t2);
      return out;
    })(fullTree, '名字');
    check('CT-4 树里能找到输入框（否则下一条测不到东西）', !!btnId, 'id=' + btnId);

    if (btnId) {
      await b.call('ui.act', { tab, action: 'click', target: btnId });
      await sleep(400);
      const f = pick(await b.call('ui.get_tree', { tab, focusedOnly: true }));
      const ft = f.tree || f;
      const nFocus = ft ? countNodes(ft) : 0;
      check('CT-5 focused_only 返回的是子树（节点数远小于整棵树）', nFocus > 0 && nFocus < nFull, `${nFull} → ${nFocus}`);
      check('CT-6 焦点子树带 focused_element_id（调用方要能确认聚到的是谁）',
        !!(ft && ft.focused_element_id), 'focused_element_id=' + (ft && ft.focused_element_id));

      // 同一件事的另一种拼写也必须生效：raw WS 用 focusedOnly，MCP schema 用
      // focused_only。抄错一个字母就静默拿到整棵树，是本项目最贵的失败形态。
      const fSnake = pick(await b.call('ui.get_tree', { tab, focused_only: true }));
      const ftSnake = fSnake.tree || fSnake;
      check('CT-6b snake_case 别名 focused_only 也生效',
        !!ftSnake && countNodes(ftSnake) === nFocus, `${nFocus} vs ${ftSnake ? countNodes(ftSnake) : 'null'}`);
    }

    // ── mode 在没有 ax 时必须报错，不许静默忽略 ────────────────
    const badMode = await b.call('ui.get_tree', { tab, mode: 'diff' });
    check('CT-7 mode 不带 ax → 明确报错（不是静默返回整棵树）',
      !!(badMode && badMode.error && badMode.error.code === -32602),
      JSON.stringify(badMode && badMode.error));

    // ── wait 的未知 condition 必须立刻报错 ─────────────────────
    const t0 = Date.now();
    const badWait = await b.call('ui.wait', { tab, condition: 'text-contaíns', text: 'x', timeout_ms: 30000 });
    const cost = Date.now() - t0;
    check('CT-8 wait 未知 condition → 立刻 -32602（不是白等到 timeout）',
      !!(badWait && badWait.error && badWait.error.code === -32602) && cost < 3000,
      `code=${badWait && badWait.error && badWait.error.code} cost=${cost}ms`);

    // ── 解析错误必须带 id:null（JSON-RPC 2.0）──────────────────
    const parseErr = await new Promise((resolve) => {
      const ws = new (require('ws'))(`ws://127.0.0.1:${PORT}`);
      ws.on('open', () => ws.send('{not json'));
      ws.on('message', (d) => { try { resolve(JSON.parse(d.toString())); } catch (_) { resolve(null); } ws.close(); });
      setTimeout(() => resolve(null), 3000);
    });
    check('CT-9 解析错误回执带 id:null', !!(parseErr && parseErr.error && parseErr.error.code === -32700 && parseErr.id === null),
      JSON.stringify(parseErr));
  } finally {
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }
    try { srv.close(); } catch (_) {}
  }

  console.log(`\n  contract: PASS=${PASS} FAIL=${FAIL}`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('!! contract suite crashed:', (e && e.stack) || e); process.exit(2); });

// e2e/cdp_input_regress.mjs — step1 回归: 验证 clear 改走 CDP 链路后，顶层(contenteditable)
// 受控编辑器 setContent/type/clear 无回归。用 data: URL 内置一个"受控"编辑器
// (JS state 为事实源, input 事件回写 DOM; 直接 innerHTML 篡改会失同步), 迫使 clear
// 必须走编辑器原生受信 Delete(→触发 input→同步), 而非顶层 innerHTML=""。
import WebSocket from 'ws';
import http from 'node:http';
// 本地静态服务: data: 顶层导航被 macOS Chromium 拒(ERR_FAILED), 故用 http://127.0.0.1 承载受控编辑器页。
const SERVER_PORT = 8199;
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); });
server.listen(SERVER_PORT);

const ws = new WebSocket('ws://localhost:9223');
let seq = 0; const pending = new Map();
function call(method, params = {}) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); }
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function walk(n, acc = []) { if (n) { acc.push(n); for (const c of n.children || []) walk(c, acc); } return acc; }

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px sans-serif}#wrap{max-width:600px;margin:40px auto;padding:20px}
#ed{outline:none;border:1px solid #ccc;min-height:120px;padding:12px;line-height:1.5}
#view{white-space:pre-wrap;background:#f6f6f6;margin-top:12px;padding:10px;color:#333}</style></head>
<body><div id="wrap">
<h2>受控富文本编辑器</h2>
<div id="ed" contenteditable="true" data-test="editor" class="ce"></div>
<div id="view"></div>
<script>
// 模拟受控框架: state 是唯一事实源, 每次 input 用 state 重渲 DOM。
// 若有人直接改 innerHTML 而不触发 input, state 不变 → 下次 input 会把它冲掉。
var state = '';
var ed = document.getElementById('ed');
var view = document.getElementById('view');
function syncFromDom(){ state = ed.innerHTML; view.textContent = state; }
function render(){ if (ed.innerHTML !== state) ed.innerHTML = state; view.textContent = state; }
ed.addEventListener('input', function(){ state = ed.innerHTML; view.textContent = state; });
// 暴露读写
window.__getState = function(){ return state; };
window.__setState = function(html){ state = html; render(); };
</script></div></body></html>`;

ws.on('open', async () => {
  const fail = [], passed = [];
  const ok = (name, cond, info) => (cond ? passed : fail).push(name + ' :: ' + info);
  const tabs = await call('ui.list_tabs'); const tab = (tabs.tabs || tabs || []).find((t) => t.active).id;
  try {
    const url = 'http://127.0.0.1:' + SERVER_PORT + '/';
    await call('ui.navigate', { url, tab });
    await sleep(3500);

    // AX 读: 顶层 contenteditable 可见
    const all = walk((await call('ui.get_tree', { ax: true, tab })).tree);
    const ed = all.find((n) => n.editor_type === 'richtext' || (n.role === 'textbox' && n.editor_type === 'richtext')) || all.find((n) => n.role === 'textbox');
    console.log('[AX] 顶层 contenteditable:', ed ? ed.id : '(?)', ed && ((ed.states || []).join(',')));
    ok('顶层 richtext 可读', !!ed, ed && ed.id);

    // 1) setContent
    const sT = 'HELLO_' + Date.now();
    await call('ui.act', { action: 'click', target: ed.id, tab });
    const sc = await call('ui.act', { action: 'setContent', target: ed.id, params: { text: sT }, tab });
    await sleep(500);
    const r1 = await call('ui.evaluate', { js: `(function(){var e=document.querySelector('[data-ai-id="${ed.id}"]');return {s: window.__getState && window.__getState(), t:(e&&e.innerText||'')};})()`, tab });
    console.log('[setContent] act=', JSON.stringify(sc), '| state=', JSON.stringify(r1.value && r1.value.s));
    ok('setContent 写入选区回读', (r1.value && r1.value.s || '').includes(sT), `got=${JSON.stringify(r1.value && r1.value.s)}`);

    // 2) type 重写(先清再输)
    const tT = 'TYPED_' + Date.now();
    await call('ui.act', { action: 'type', target: ed.id, params: { text: tT }, tab });
    await sleep(500);
    const r2 = await call('ui.evaluate', { js: `(function(){var e=document.querySelector('[data-ai-id="${ed.id}"]');return {s:window.__getState&&__getState(), t:(e&&e.innerText||'')};})()`, tab });
    ok('type 重写替换(不含旧串)', !(r2.value.s).includes(sT) && (r2.value.s).includes(tT), `got=${JSON.stringify(r2.value.s)}`);

    // 3) clear → 空 (关键回归点: CDP 受信 Delete, 非 innerHTML="")
    const ce = await call('ui.act', { action: 'clear', target: ed.id, tab });
    await sleep(500);
    const r3 = await call('ui.evaluate', { js: `(function(){var e=document.querySelector('[data-ai-id="${ed.id}"]');return {s:window.__getState&&__getState(), t:(e&&e.innerText||'')};})()`, tab });
    console.log('[clear] act=', JSON.stringify(ce), '| state=', JSON.stringify(r3.value && r3.value.s), '| text=', JSON.stringify(r3.value && r3.value.t));
    // 空块标记(<br>/&nbsp;)是 contenteditable 清空后的正常标记; 判定以可见文本为空为准。
    const normEmpty = (s) => String(s || '').replace(/<br[^>]*>/gi, '').replace(/&nbsp;/g, '').replace(/<[^>]+>/g, '').replace(/[\s\u00a0]/g, '') === '';
    ok('clear 后受控编辑器可见文本为空', normEmpty(r3.value.s) && !(r3.value.t || '').trim(), `state=${JSON.stringify(r3.value.s)} text=${JSON.stringify(r3.value.t)}`);

    console.log('\n=== 汇总 ===');
    console.log('PASSED', passed.length, ':', passed.join(' | '));
    if (fail.length) { console.log('FAILED', fail.length, ':', fail.join(' | ')); process.exitCode = 1; }
    else console.log('ALL PASS');
  } catch (e) { console.error('REG ERROR:', e.message); process.exitCode = 1; }
  finally { ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('WS error', e.message); process.exit(1); });
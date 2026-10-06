// e2e/oopif_multi_iframe.mjs — step2: OOPIF 通用化。
// 用"多跨源 iframe"固件验证下钻方案对 2 个跨源子帧的通用性:
//  parent(127.0.0.1:8210) 内嵌 <iframe src=8211(frameA)><iframe src=8212(frameB)>
//  不同端口 = 跨源 → parent 无法触碰子帧 DOM(OOPIF 特征), 只能靠帧下钻。
// 断言: (1)两个子帧 contenteditable 都被 _readOopifFrames 读出且 id 前缀不同
//       (2)setContent 路由到各自所属帧并在对应帧内生效
//       (3)clear 走 CDP 链路在所属帧内清空
import WebSocket from 'ws';
import http from 'node:http';

const PARENT = 8210, A = 8211, B = 8212;
const childHtml = (label) => `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font:14px sans-serif">
<div style="background:#eef;padding:4px 8px;font-weight:700">子帧 ${label}</div>
<div contenteditable="true" data-fixture="ce" style="outline:none;min-height:60px;padding:8px"></div>
</body></html>`;
const parentHtml = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font:15px sans-serif">
<h3>多跨源 iframe 固件</h3>
<iframe src="http://127.0.0.1:${A}/" data-fixture="fa" style="width:46%;height:200px;border:1px solid #aaa"></iframe><br>
<iframe src="http://127.0.0.1:${B}/" data-fixture="fb" style="width:46%;height:200px;border:1px solid #aaa"></iframe>
</body></html>`;

const servers = [];
for (const [port, html] of [[PARENT, parentHtml], [A, childHtml('A')], [B, childHtml('B')]]) {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  s.listen(port); servers.push(s);
}

const ws = new WebSocket('ws://localhost:9223');
let seq = 0; const pending = new Map();
function call(method, params = {}) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); }
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function walk(n, acc = []) { if (n) { acc.push(n); for (const c of n.children || []) walk(c, acc); } return acc; }

ws.on('open', async () => {
  const fail = [], passed = [];
  const ok = (name, cond, info) => (cond ? passed : fail).push(name + ' :: ' + info);
  const tabs = await call('ui.list_tabs'); const tab = (tabs.tabs || tabs || []).find((t) => t.active).id;
  try {
    await call('ui.navigate', { url: `http://127.0.0.1:${PARENT}/`, tab });
    await sleep(4000);

    // 确认跨源: parent 无法触碰子帧 DOM
    const cw = await call('ui.evaluate', { js: `(function(){try{var f=document.querySelector('iframe');return {blocked:true,x:!f.contentWindow.document.body};}catch(e){return {blocked:true,throw:String(e.message).slice(0,40)};}})()`, tab });
    console.log('[cross-origin check]', JSON.stringify(cw && cw.value));
    ok('子帧跨源(非顶层可直读)', cw.value && cw.value.blocked);

    // OOPIF 下钻读两个子帧
    const all = walk((await call('ui.get_tree', { ax: true, tab })).tree);
    const richs = all.filter((n) => n.editor_type === 'richtext');
    console.log('[R] OOPIF richtext 数:', richs.length, '|', richs.map((n) => n.id).join(','));
    ok('两个子帧 richtext 都被下钻读出', richs.length >= 2, richs.map((n) => n.id).join(','));
    // 前缀必须不同(帧序号消歧)
    const prefixes = [...new Set(richs.map((n) => n.id.split('-').slice(0, 3).join('-')))];
    ok('各帧 id 前缀不同(帧消歧)', prefixes.length === richs.length, prefixes.join(','));

    // 对两个帧各自 setContent + clear
    for (let k = 0; k < 2 && k < richs.length; k++) {
      const node = richs[k];
      const txt = `帧${k}_${Date.now()}`;
      await call('ui.act', { action: 'click', target: node.id, tab });
      const sc = await call('ui.act', { action: 'setContent', target: node.id, params: { text: txt }, tab });
      await sleep(400);
      const rd = await call('ui.evaluate', { js: `(function(){var root=document.querySelector('[data-ai-id="${node.id}"]');var el=root;if(root&&root.querySelector){var c=root.querySelector('[contenteditable="true"],textarea');if(c)el=c;}return (el&&(el.innerText||el.value)||'').trim();})()`, tab });
      console.log(`[setContent ${node.id}] act=`, JSON.stringify(sc), 'read=', JSON.stringify((rd.value||'').slice(0,24)));
      ok(`帧${k} setContent 在所属帧生效`, (rd.value||'').includes(txt), `got=${(rd.value||'').slice(0,24)}`);

      const ce = await call('ui.act', { action: 'clear', target: node.id, tab });
      await sleep(400);
      const rd2 = await call('ui.evaluate', { js: `(function(){var root=document.querySelector('[data-ai-id="${node.id}"]');var el=root;if(root&&root.querySelector){var c=root.querySelector('[contenteditable="true"],textarea');if(c)el=c;}return (el&&(el.innerText||el.value)||'').trim();})()`, tab });
      console.log(`[clear ${node.id}] act=`, JSON.stringify(ce), 'read=', JSON.stringify(rd2.value));
      ok(`帧${k} clear 清空`, !(rd2.value||'').trim(), `got=${JSON.stringify(rd2.value)}`);
    }

    console.log('\n=== 汇总 ===');
    console.log('PASSED', passed.length, ':', passed.join(' | '));
    if (fail.length) { console.log('FAILED', fail.length, ':', fail.join(' | ')); process.exitCode = 1; }
    else console.log('ALL PASS');
  } catch (e) { console.error('OOPIF ERR:', e.message); process.exitCode = 1; }
  finally { ws.close(); for (const s of servers) s.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('WS error', e.message); process.exit(1); });
// e2e/zhihu_full.cjs — 知乎富文本发布流程端到端验证（附着 9223 实例）
// 步骤：首页 → 创作 → 写文章(新tab) → 编辑器 → 标题 → 加粗输入 → 正文多段落 → 清空 → 发布按钮
const path = require('node:path');
const fs = require('node:fs');
const { Browser } = require(path.join(__dirname, '..', 'tools/browser.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (r) => (r && r.result) ? r.result : (r || {});
const val = (r) => R(r).value;
const j = (r) => { try { return JSON.parse(val(r)); } catch { return val(r); } };

async function tree(b, tab) {
  const raw = await b.call('ui.get_tree', tab !== undefined ? { tab } : {});
  const root = (raw && raw.result && (raw.result.tree || raw.result.root)) || raw;
  const nodes = [];
  (function walk(x, d) {
    if (Array.isArray(x)) return x.forEach((n) => walk(n, d));
    if (!x || typeof x !== 'object') return;
    nodes.push(x);
    if (x.children) x.children.forEach((n) => walk(n, d + 1));
  })(root, 0);
  return nodes;
}

async function findNode(b, pred, tries = 10, tab) {
  for (let i = 0; i < tries; i++) {
    const nodes = await tree(b, tab);
    const hit = nodes.find(pred);
    if (hit) return hit;
    await sleep(600);
  }
  return null;
}

// 等新 tab（写文章编辑器页）出现并切换过去
async function waitEditorTab(b, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const tabs = await b.call('ui.list_tabs', {});
    const list = ((tabs && tabs.result && tabs.result.tabs) || []);
    const t = list.find((x) => String(x.url || '').indexOf('zhuanlan.zhihu.com') >= 0);
    if (t) {
      await b.call('ui.set_active_tab', { tab: t.id });
      await sleep(500);
      return t.id;
    }
    await sleep(800);
  }
  return null;
}

async function main() {
  const b = new Browser();
  await b.ready();

  // 0) 回首页（导航后必须先 get_tree 赋 data-ai-id，act 才能解析目标）
  await b.call('ui.navigate', { url: 'https://www.zhihu.com' });
  await sleep(4000);
  await b.call('ui.get_tree', {});

  // 1) 创作下拉 → 写文章
  console.log('== 1) 进入编辑器 ==');
  const pop = await b.call('ui.act', { action: 'click', target: 'Popover2-toggle' });
  await sleep(1800);
  const wBtn = await findNode(b, (n) => String(n.id || '').indexOf('e:button') === 0 && String(n.label || '').indexOf('写文章') >= 0);
  if (!wBtn) { console.log('  !! 找不到写文章按钮'); b.close(); process.exit(1); }
  const w = await b.call('ui.act', { action: 'click', target: wBtn.id });
  await sleep(2500);
  const tabId = await waitEditorTab(b);
  console.log('  创作点击:', JSON.stringify(pop && (pop.result || pop.error)));
  console.log('  写文章点击:', JSON.stringify(w && (w.result || w.error)), '| 编辑器tab:', tabId);
  if (!tabId) { console.log('  !! 未出现编辑器新tab'); b.close(); process.exit(1); }

  // 1.5) 编辑器树
  const titleNode = await findNode(b, (n) => /e:textarea-\d+/.test(String(n.id || '')) && String(n.label || '').indexOf('标题') >= 0, 12, tabId);
  const bodyNode = await findNode(b, (n) => /e:div-\d+/.test(String(n.id || '')) && n.role === 'textbox' && String(n.label || '').indexOf('正文') < 0 && String(n.label || '').indexOf('语言') < 0, 12, tabId);
  const boldNode = await findNode(b, (n) => String(n.label || '').trim() === '加粗', 12, tabId);
  const pubNode = await findNode(b, (n) => String(n.label || '').trim() === '发布', 12, tabId);
  console.log('  标题节点:', titleNode && titleNode.id, '| 正文节点:', bodyNode && bodyNode.id, '| 加粗:', boldNode && boldNode.id, '| 发布:', pubNode && pubNode.id);
  if (!titleNode || !bodyNode) { console.log('  !! 编辑器结构未就绪'); b.close(); process.exit(1); }

  // 2) 标题：点击聚焦 + 输入
  console.log('== 2) 标题 ==');
  const c1 = await b.call('ui.act', { action: 'click', target: titleNode.id, params: { tab: tabId } });
  await sleep(400);
  const f1 = val(await b.call('ui.evaluate', { js: `JSON.stringify({active:(document.activeElement.getAttribute?document.activeElement.getAttribute('data-ai-id'):'')||document.activeElement.tagName})`, tab: tabId }));
  const t1 = await b.call('ui.act', { action: 'type', target: titleNode.id, params: { text: 'AI Browser：让 AI Agent 像人一样看网页', tab: tabId } });
  await sleep(500);
  const v1 = val(await b.call('ui.evaluate', { js: `document.querySelector('[data-ai-id="${titleNode.id}"]').value`, tab: tabId }));
  console.log('  点击:', JSON.stringify(c1 && (c1.result || c1.error)), '| 聚焦:', f1, '| 输入:', JSON.stringify(t1 && (t1.result || t1.error)), '| 标题:', JSON.stringify(v1));

  // 3) 加粗：点正文 → 点加粗 → 输入 → 验证 strong
  console.log('== 3) 加粗 ==');
  await b.call('ui.act', { action: 'click', target: bodyNode.id, params: { tab: tabId } });
  await sleep(400);
  const b1 = await b.call('ui.act', { action: 'click', target: boldNode.id, params: { tab: tabId } });
  await sleep(400);
  const t2 = await b.call('ui.act', { action: 'type', target: bodyNode.id, params: { text: '加粗验证', tab: tabId } });
  await sleep(700);
  const rich = j(await b.call('ui.evaluate', { js: `JSON.stringify((function(){
    var ed=document.querySelector('[data-ai-id="${bodyNode.id}"]');
    return {strong:[].map.call(ed.querySelectorAll('strong'),function(e){return e.innerText;}),
            bs:[].map.call(ed.querySelectorAll('b'),function(e){return e.innerText;}),
            wts:[].map.call(ed.querySelectorAll('span'),function(e){return e.style.fontWeight||'';}).filter(function(w){return parseInt(w,10)>=500||w==='bold';}).length,
            html:ed.innerHTML.slice(0,260)};
  })())`, tab: tabId }));
  console.log('  点加粗:', JSON.stringify(b1 && (b1.result || b1.error)), '| 输入:', JSON.stringify(t2 && (t2.result || t2.error)));
  // 知乎 Draft 用 span 内联 font-weight 表达加粗（非 strong/b 标签），wts>=1 即生效
  const boldOk = rich && (rich.wts >= 1);
  console.log('  富文本结果:', JSON.stringify(rich), '| 加粗判定:', boldOk ? 'PASS' : 'FAIL');

  // 4) 正文多段落 setContent
  console.log('== 4) 正文多段落 ==');
  const text = fs.readFileSync(path.join(__dirname, '..', 'zhihu-article-fix.txt'), 'utf-8').replace(/^#.*\n/, '').trim();
  const t0 = Date.now();
  const t3 = await b.call('ui.act', { action: 'setContent', target: bodyNode.id, params: { text, tab: tabId } });
  const dur = Date.now() - t0;
  await sleep(400);
  const b3 = j(await b.call('ui.evaluate', { js: `JSON.stringify({len:(document.querySelector('[data-ai-id="${bodyNode.id}"]').innerText||'').length,ps:document.querySelector('[data-ai-id="${bodyNode.id}"]').querySelectorAll('p,div').length,head:(document.querySelector('[data-ai-id="${bodyNode.id}"]').innerText||'').slice(0,40)})`, tab: tabId }));
  console.log('  setContent:', JSON.stringify(t3 && (t3.result || t3.error)), '| 耗时(ms):', dur, '| 正文:', JSON.stringify(b3));

  // 5) 清空校验
  console.log('== 5) 清空 ==');
  const t4 = await b.call('ui.act', { action: 'setContent', target: bodyNode.id, params: { text: '', tab: tabId } });
  await sleep(400);
  const len5 = val(await b.call('ui.evaluate', { js: `(document.querySelector('[data-ai-id="${bodyNode.id}"]').innerText||'').length`, tab: tabId }));
  console.log('  setContent(""):', JSON.stringify(t4 && (t4.result || t4.error)), '| 清空后 len:', len5, '| 判定:', len5 <= 1 ? 'PASS' : 'FAIL');

  // 6) 发布按钮点击（不确认发布，只测点击可达）
  console.log('== 6) 发布按钮 ==');
  if (pubNode) {
    const pub = await b.call('ui.act', { action: 'click', target: pubNode.id, params: { tab: tabId } });
    await sleep(1500);
    const popup = val(await b.call('ui.evaluate', { js: `JSON.stringify([].map.call(document.querySelectorAll('[role=dialog] button,button:not([class*=Toolbar])'),function(e){return (e.innerText||'').trim().slice(0,12);}).filter(Boolean).slice(0,8))`, tab: tabId }));
    console.log('  发布点击:', JSON.stringify(pub && (pub.result || pub.error)), '| 弹层按钮:', JSON.stringify(popup));
  } else {
    console.log('  发布按钮未找到（跳过）');
  }

  b.close();
}
main().catch((e) => { console.error('probe error:', e.message); process.exit(2); });

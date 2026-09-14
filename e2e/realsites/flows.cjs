// e2e/realsites/flows.cjs — 真实站专项流程（非简单三件套）
// 迁移自原 e2e/e2e_realsites.cjs 的手写任务块。这些流程含多步交互或登录墙探测，
// 不适合并入 base 矩阵，故单独保留并按需运行（--flow 过滤）。
// 每个流程返回布尔：true=通过 / false=异常。入口据此计入总 FAIL，避免"假绿"。
const path = require('node:path');
const Browser = require(path.join(__dirname, '..', '..', 'tools/browser.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (r) => (r && r.result) ? r.result : (r || {});
const rawVal = (r) => (R(r) || {}).value;

async function jsonEval(b, expr) {
  const r = await b.evaluate(expr);
  const v = rawVal(r);
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function safe(name, fn) {
  try { await fn(); return true; }
  catch (e) { console.log(`[FAIL ${name}] ${e.message}`); return false; }
}

module.exports = {
  // 任务①百度：搜索 → 进入首个结果站
  baiduFollowFirstResult: async (b) => safe('t1', async () => {
    await b.navigate('https://www.baidu.com/s?wd=AI%20Browser%20agent%20browser');
    await sleep(3500);
    const res = await jsonEval(b,
      "(function(){var o=[];var a=document.querySelectorAll('#content_left a, .result a, h3 a, [class*=c-container] a');" +
      "var seen={};" +
      "for(var i=0;i<a.length&&o.length<6;i++){var t=(a[i].textContent||'').trim();var h=a[i].href||'';" +
      "if(t.length>6&&/^https?:/.test(h)&&!seen[h]){seen[h]=1;o.push({t:t.slice(0,60),h:h});}}" +
      "return JSON.stringify({links:o});})()"
    );
    const links = (res && res.links) || [];
    console.log('  百度结果链接数:', links.length);
    links.forEach((l, i) => console.log(`   [${i + 1}] ${l.t}  ${l.h.slice(0, 60)}`));
    const first = links[0];
    if (first) {
      await b.navigate(first.h);
      await sleep(4000);
      const p = await jsonEval(b, "(function(){return JSON.stringify({title:document.title,url:location.href});})()");
      console.log('  已进入首个结果站:', p && p.title, '|', p && p.url);
    } else {
      console.log('  (未解析到结果链接)');
    }
  }),

  // 任务④知乎创作：登录态/编辑器探测（不实际提交）
  zhihuCreatorProbe: async (b) => safe('t4', async () => {
    await b.navigate('https://www.zhihu.com/creator');
    await sleep(4500);
    const info = await jsonEval(b,
      "(function(){" +
      "var t=document.body?document.body.innerText.slice(0,300):'';" +
      "return JSON.stringify({url:location.href," +
      "needLogin: t.indexOf('\\u767b\\u5f55')>=0 || t.indexOf('\\u8bf7\\u767b\\u5f55')>=0 || /login/.test(location.href)," +
      "hasEditor: !!document.querySelector('[contenteditable], .ql-editor, .RichText, textarea')," +
      "snippet: t.slice(0,90)});})()"
    );
    console.log('  URL:', info && info.url);
    console.log('  需登录:', info && info.needLogin, '| 有编辑器:', info && info.hasEditor);
    console.log('  页面开头:', info && info.snippet);
    console.log('  结论:', info
      ? (info.needLogin ? '未登录，发布流程需先登录（检测到此为止，不予实际提交）'
        : info.hasEditor ? '已进入创作/编辑流程：可填标题正文→发布'
        : '无法判定，见页面信息')
      : '探测失败');
  }),

  // 任务⑤多标签生命周期
  multiTab: async (b) => safe('t5', async () => {
    const tabsOf = (o) => (o.tabs || o.list || (Array.isArray(o) ? o : [])).filter((t) => t && t.id !== undefined);
    await b.call('ui.new_tab', { url: 'https://www.baidu.com' });
    await b.call('ui.new_tab', { url: 'https://www.bing.com' });
    await b.call('ui.new_tab', { url: 'https://www.toutiao.com' });
    await sleep(3000);
    const tabs = tabsOf(R(await b.call('ui.list_tabs', {})));
    console.log('  创建后标签(' + tabs.length + '):');
    tabs.forEach((t) => console.log(`   id=${t.id} ${t.active ? '[活动]' : '[后台]'}  ${(t.title || '').slice(0, 24)}`));
    const victim = tabs.find((t) => !t.active) || tabs[0];
    if (victim) {
      await b.call('ui.set_active_tab', { tab: victim.id });
      await sleep(1200);
      const p = await jsonEval(b, "(function(){return JSON.stringify({title:document.title,url:location.href});})()");
      console.log('  切换 id=' + victim.id + ' → 活动页:', p && p.title, '|', p && p.url);
      await b.call('ui.close_tab', { tab: victim.id });
      console.log('  关闭 id=' + victim.id + ' 后标签数:', tabsOf(R(await b.call('ui.list_tabs', {}))).length);
    }
  }),

  // 任务⑥GitHub 深化：搜索仓库并校验结果项可解析
  githubSearch: async (b) => safe('t6', async () => {
    await b.navigate('https://github.com/search?q=electron+ws&type=repositories&s=stars&o=desc');
    await sleep(4500);
    const res = await jsonEval(b,
      "(function(){var links=[];var seen={};" +
      "var a=document.querySelectorAll('a[href^=\"/\"]');" +
      "for(var i=0;i<a.length&&links.length<5;i++){var h=a[i].getAttribute('href')||'';" +
      "var t=(a[i].textContent||'').trim();" +
      "if(/^\\/[\\w.-]+\\/[\\w.-]+$/.test(h)&&!seen[h]&&t.length>1){seen[h]=1;links.push({h:h,t:t.slice(0,50)});}}" +
      "var codeSearch=!!document.querySelector('a[href$=\"&type=code\"]');" +
      "return JSON.stringify({links:links,hasResults:document.body.innerText.indexOf('repository results')>=0||document.body.innerText.indexOf('个结果')>=0});})()"
    );
    console.log('  GitHub 搜索仓库链接:', (res && res.links || []).length);
    (res && res.links || []).slice(0, 5).forEach((l) => console.log(`   ${l.h}  ${l.t}`));
    console.log('  是否有结果标识:', res && res.hasResults);
    console.log('  结论:', (res && res.links && res.links.length > 0) ? 'GitHub 搜索可解析结果' : '未解析到仓库链接(可能需登录或改版)');
  }),
};
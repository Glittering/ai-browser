// e2e/e2e_realsites.cjs — 真实驱动 AI Browser 的 5 组 Web 任务
// 用 WS 原语（ui.*）逐项验证。所有 evaluate 表达式用 IIFE：(function(){...})()
const { Browser } = require("../tools/browser.cjs");

const b = new Browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function R(r) { return (r && r.result) ? r.result : (r ? r : {}); }
function rawVal(r) { const o = R(r); return o && o.value; }

async function jsonEval(expr) {
  const r = await b.evaluate(expr);
  const v = rawVal(r);
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}
async function pageInfo() {
  return jsonEval("(function(){return JSON.stringify({title:document.title,url:location.href});})()");
}
async function section(t) { console.log("\n" + "=".repeat(60) + "\n" + t + "\n" + "=".repeat(60)); }
async function safe(name, fn) { try { await fn(); } catch (e) { console.log(`[FAIL ${name}] ${e.message}`); } }

b.ready().then(async () => {
  // ==== 任务 1：百度搜索 + 进入结果站 ====
  await section("任务1 · 百度：搜索 → 进入首个结果站（稳定走 s?wd=）");
  await safe("t1", async () => {
    const p0 = await jsonEval("(function(){return JSON.stringify({title:document.title,url:location.href});})()");
    console.log("  当前页:", p0 && p0.title, "|", p0 && p0.url);

    await b.navigate("https://www.baidu.com/s?wd=AI%20Browser%20agent%20browser");
    await sleep(3500);
    const res = await jsonEval(
      "(function(){var o=[];var a=document.querySelectorAll('#content_left a, .result a, h3 a, [class*=c-container] a');" +
      "var seen={};" +
      "for(var i=0;i<a.length&&o.length<6;i++){var t=(a[i].textContent||'').trim();var h=a[i].href||'';" +
      "if(t.length>6&&/^https?:/.test(h)&&!seen[h]){seen[h]=1;o.push({t:t.slice(0,60),h:h});}}" +
      "return JSON.stringify({url:location.href,links:o});})()"
    );
    console.log("  百度结果 URL:", res && res.url);
    (res && res.links || []).forEach((l, i) => console.log(`   [${i+1}] ${l.t}  ${l.h.slice(0,60)}`));
    const first = res && res.links[0];
    if (first) {
      await b.navigate(first.h);
      await sleep(4000);
      const p2 = await pageInfo();
      console.log("  已进入首个结果站:", p2 && p2.title, "|", p2 && p2.url);
    } else {
      console.log("  (未解析到结果链接)");
    }
  });

  // ==== 任务 2：Bing 搜索 ====
  await section("任务2 · Bing：搜索");
  await safe("t2", async () => {
    await b.navigate("https://www.bing.com/search?q=Electron+MCP+AI+browser");
    await sleep(3500);
    const res = await jsonEval(
      "(function(){var o=[];var a=document.querySelectorAll('#b_results h2 a, li.b_algo h2 a');" +
      "for(var i=0;i<Math.min(a.length,6);i++)o.push({t:(a[i].textContent||'').trim().slice(0,60),h:a[i].href});" +
      "return JSON.stringify({url:location.href,title:document.title,links:o});})()"
    );
    console.log("  Bing:", res && res.title, "|", res && res.url);
    (res && res.links || []).forEach((l, i) => console.log(`   [${i+1}] ${l.t}  ${(l.h||'').slice(0,50)}`));
  });

  // ==== 任务 3：财经资讯三站 ====
  await section("任务3 · 东方财富 / 同花顺 / 今日头条");
  for (const { name, url } of [
    { name: "东方财富", url: "https://www.eastmoney.com" },
    { name: "同花顺",   url: "https://www.10jqka.com.cn" },
    { name: "今日头条", url: "https://www.toutiao.com" }
  ]) {
    await safe("t3-" + name, async () => {
      await b.navigate(url);
      await sleep(3500);
      const p = await pageInfo();
      console.log(`  ${name}: ${p && p.title} | ${p && p.url}`);
    });
  }

  // ==== 任务 4：知乎发布流程探测（不真实提交） ====
  await section("任务4 · 知乎：进入创作页，检测登录态与编辑器");
  await safe("t4", async () => {
    await b.navigate("https://www.zhihu.com/creator");
    await sleep(4500);
    const info = await jsonEval(
      "(function(){" +
      "var t=document.body?document.body.innerText.slice(0,300):'';" +
      "return JSON.stringify({url:location.href," +
      "needLogin: t.indexOf('\\u767b\\u5f55')>=0 || t.indexOf('\\u8bf7\\u767b\\u5f55')>=0 || /login/.test(location.href)," +
      "hasEditor: !!document.querySelector('[contenteditable], .ql-editor, .RichText, textarea')," +
      "snippet: t.slice(0,90)});})()"
    );
    console.log("  URL:", info && info.url);
    console.log("  需登录:", info && info.needLogin, "| 有编辑器:", info && info.hasEditor);
    console.log("  页面开头:", info && info.snippet);
    const verdict = info ? (info.needLogin ? "未登录，发布流程需先登录（登录态检测到此为止，不予实际提交）"
      : info.hasEditor ? "已进入创作/编辑流程：可填标题正文→发布"
      : "无法判定，见页面信息") : "探测失败";
    console.log("  结论:", verdict);
  });

  // ==== 任务 5：多标签 ====
  await section("任务5 · 多标签：创建 / 切换 / 关闭");
  await safe("t5", async () => {
    const tabsOf = (o) => (o.tabs || o.list || (Array.isArray(o) ? o : [])).filter((t) => t && t.id !== undefined);
    await b.call("ui.new_tab", { url: "https://www.baidu.com" });
    await b.call("ui.new_tab", { url: "https://www.bing.com" });
    await b.call("ui.new_tab", { url: "https://www.toutiao.com" });
    await sleep(3000);
    const o1 = R(await b.call("ui.list_tabs", {}));
    const tabs = tabsOf(o1);
    console.log("  创建后标签(" + tabs.length + "):");
    tabs.forEach((t) => console.log(`   id=${t.id} ${t.active ? "[活动]" : "[后台]"}  ${(t.title||"").slice(0,24)}`));

    const victim = tabs.find((t) => !t.active) || tabs[0];
    if (victim) {
      await b.call("ui.set_active_tab", { tab: victim.id });
      await sleep(1200);
      const p = await pageInfo();
      console.log("  切换 id=" + victim.id + " → 活动页:", p && p.title, "|", p && p.url);
      await b.call("ui.close_tab", { tab: victim.id });
      const o2 = R(await b.call("ui.list_tabs", {}));
      console.log("  关闭 id=" + victim.id + " 后标签数:", tabsOf(o2).length);
    }
  });

  console.log("\n== E2E 完成 ==");
  b.close();
  process.exit(0);
}).catch((e) => { console.error("连接错误:", e.message); process.exit(1); });

setTimeout(() => { console.log("E2E TIMEOUT"); process.exit(1); }, 120000);
#!/usr/bin/env node
// tools/coverage_probe.cjs — 「页面上一半能点的东西，语义树里看不见」的量化探针。
//
// 为什么需要它（2026-10-17 实测）：
//   在真实站点上量「用户看着能点」的元素有多少真的进了语义树，结果是
//   百度 43%、B站 33%、CSDN 60%。也就是说**一半左右的可点目标 agent 拿不到 ref**，
//   于是每次任务都退化成一个站点专用脚本去 querySelector 狙击 —— 26 个临时脚本里
//   142 个是站点特化、731 处硬编码选择器，就是这么来的。
//
//   这个数字此前没人量过。没有它，"通用能力够不够"只能靠感觉争论；有了它，
//   改进就能被验证：改完抽取层再跑一遍，覆盖率应该上去，而不是"感觉好点了"。
//
// 判据为什么用 cursor:pointer：
//   它是**浏览器自己算出来的可点性** —— 人手看到手型光标就知道这儿能点，浏览器
//   也是这么画的。用它当分母，比"猜哪些 div 挂了监听器"更接近"人看到的东西"。
//
// 用法：
//   node tools/coverage_probe.cjs https://www.bilibili.com/
//   node tools/coverage_probe.cjs https://www.csdn.net/ 12000 --json
//
// 需要 ai-browser 正在运行（默认 9223，AI_BROWSER_PORT 可改）。

'use strict';

const { WebSocket } = require('ws');

const URL_ARG = process.argv[2];
const WAIT = Number(process.argv[3]) || 9000;
const AS_JSON = process.argv.indexOf('--json') >= 0;
const PORT = Number(process.env.AI_BROWSER_PORT) || 9223;

if (!URL_ARG) {
  console.error('usage: node tools/coverage_probe.cjs <url> [waitMs] [--json]');
  process.exit(2);
}

function makeClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const call = (method, params = {}, timeout = 120000) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); }
    }, timeout);
  });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { ws, call, ready, close: () => { try { ws.close(); } catch {} } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在页面里数：手型元素总数 / 其中带 data-ai-id 的（= 真的进了树）
//
// ⚠️ 分母必须先修正，否则整件事都是错的。
//   cursor 是**可继承**的 CSS 属性：给一张卡片设了 cursor:pointer，卡片里所有
//   div/span/svg/path 计算出来全是 pointer。按"元素"数分母，CSDN 的
//   .layout-menu-item / _info / _icon / _name 会被算成 4 个目标，而人看着只有 1 个
//   可点区块（点哪个位置效果都一样）。B站 nav 的 svg+path 同理。
//   所以"能点的东西"的计量单位是**手型边界** = 自己的 cursor 是 pointer、
//   而父元素的 cursor **不是** pointer 的那个最外层元素。
//
// 两个口径都输出：element 口径（和此前数据可比）+ boundary 口径（人的视角）。
//
// 分类（两个口径各自算一遍）：
//   inTree      自己带 id  → 直接可操作（真覆盖）
//   byDesc      自己被单个交互后代盖满，而那个后代在树里
//               （<div class=x><a>首页</a></div> 这种壳子，点里面的 a 就是点它）
//   ancOnly     最近带 id 的祖先下只有它这一个手型后代 → 点祖先等价于点它
//   ambiguous   同一祖先下有多个手型后代 → 点祖先指不到唯一目标
//   noIdChain   自己和整条祖先链都没有 id → **真缺口**
// 真缺口 = ambiguous + noIdChain。
const COUNT_JS = `(function(){
  // a[href] 换成 a：无 href 的锚点（onclick 驱动）也是可点目标。超星泛雅的章节
  // 条目就是 <a onclick>，href 为 null —— 只认 a[href] 会把它们从**分母**里删掉，
  // 于是覆盖率虚高。帧读取器（shared/frame_read_source.js）早先踩过同一个坑。
  var INTER = 'a,button,input,select,textarea,summary,details,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=true]';
  function coveredByDesc(el, r){
    var hits;
    try { hits = el.querySelectorAll(INTER); } catch(e) { return false; }
    if (!hits || hits.length === 0) return false;
    // 只算**可见的、最内层的**可交互元素：
    //  - 不可见的（隐藏 input、0×0 的埋点控件）不是人能看到的目标；
    //  - 最内层的（不再包含别的可交互元素）才是真正的动作目标，外面那层是包装。
    // 不这么筛，"这一行里到底有几个可点的东西"永远数不清 —— 实测超星章节行
    // 里同时有 2 个隐藏 input + 行容器 div[role=link] + 标题 a，共 4 个命中，
    // 于是"唯一可交互后代"这个前提永远不成立，6 个章节被永久误报成真缺口。
    var live = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var hr = h.getBoundingClientRect();
      if (!(hr.width > 0) || !(hr.height > 0)) continue;
      live.push(h);
    }
    var leaves = [];
    for (var k = 0; k < live.length; k++) {
      var nest = false;
      for (var m = 0; m < live.length; m++) {
        if (m === k || live[m] === live[k]) continue;
        if (live[k].contains(live[m])) { nest = true; break; }
      }
      if (!nest) leaves.push(live[k]);
    }
    if (leaves.length !== 1) return false;
    var inner = leaves[0];
    if (!inner.hasAttribute('data-ai-id')) return false;
    var b = inner.getBoundingClientRect();
    if (!(b.width > 0) || !(b.height > 0)) return false;
    var w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
    var h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
    if (!(w > 0) || !(h > 0)) return false;
    var inter = w * h;
    // 判据一（几何）：内层要「盖满」外层，两个方向都 >= 90%。与
    // src/preload/extractor.cjs 的 wrapsSingleInteractive 同一口径。
    // 只看交集/内层面积会把"大卡片里放个小链接"误判成壳子（点卡片 ≠ 点那个链接）。
    if (inter / (b.width * b.height) >= 0.9 && inter / (r.width * r.height) >= 0.9) return true;
    // 判据二（文本）：外层的文字**就是**这一个链接的文字（可能多个角标）。
    // 2026-10-19 实测（超星泛雅章节行）：外层是整行
    //   <div class="chapter_item" role="link">1.1 标题 <b>1</b></div>
    // 内层是 <a>1.1 标题</a>，宽 996 / 行宽 1100 —— 几何上差 5% 不过线，于是
    // 6 个章节被报成"真缺口"。但点内层 a 会冒泡到整行，实测
    // act{axf-1-4} → clicked_via:"oopif-click", effect_state:"committed"。
    // 这里比抽取层**故意松一点**，因为两边错的方向不同：抽取层判错会**丢掉**
    // 一个目标（不可逆），这里判松只是让百分比略微乐观（可复查）。
    // 松的条件是有界的：唯一可交互后代 + 外层文字以内层文字开头 + 长度接近。
    // "大卡片里放个小链接"过不了这三条（文字开头就不是它）。
    try {
      var ot = (el.innerText || '').replace(/\s+/g, ' ').trim();
      var it = (inner.innerText || '').replace(/\s+/g, ' ').trim();
      if (ot && it && ot.indexOf(it) === 0 && it.length >= ot.length * 0.5) return true;
    } catch (e2) { /* 拿不到文字就按几何判据走 */ }
    return false;
  }
  function scan(onlyBoundary){
    var s = {pointer: 0, inTree: 0, byDesc: 0, ancOnly: 0, ambiguous: 0, noIdChain: 0, missing: []};
    var all = document.querySelectorAll('*');
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;          // 不可见/装饰性小块
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      if (cs.cursor !== 'pointer') continue;
      if (onlyBoundary) {
        var p = el.parentElement;
        // 父元素也是 pointer → 它是继承来的，不是独立的可点目标
        if (p && getComputedStyle(p).cursor === 'pointer') continue;
      }
      s.pointer++;
      if (el.hasAttribute('data-ai-id')) { s.inTree++; continue; }
      if (coveredByDesc(el, r)) { s.byDesc++; continue; }
      var anc = el.parentElement, anchor = null;
      while (anc && anc !== document.body) {
        if (anc.hasAttribute('data-ai-id')) { anchor = anc; break; }
        anc = anc.parentElement;
      }
      list.push({ el: el, anchor: anchor });
    }
    var perAnchor = new Map();
    for (var j = 0; j < list.length; j++) {
      if (!list[j].anchor) continue;
      perAnchor.set(list[j].anchor, (perAnchor.get(list[j].anchor) || 0) + 1);
    }
    for (var k = 0; k < list.length; k++) {
      var it = list[k], el = it.el, kind;
      if (!it.anchor) { s.noIdChain++; kind = 'noIdChain'; }
      else if (perAnchor.get(it.anchor) === 1) { s.ancOnly++; kind = 'ancOnly'; }
      else { s.ambiguous++; kind = 'ambiguous'; }
      if (s.missing.length < 40 && kind !== 'ancOnly') {
        s.missing.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 44),
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 28),
          // onclick 属性 vs addEventListener：后者是 Vue/React 的默认写法，
          // 而抽取层只看得到前者
          reg: el.onclick === null ? 'listener' : 'attr',
          kind: kind,
        });
      }
    }
    return s;
  }
  var byEl = scan(false);
  var byBound = scan(true);
  return JSON.stringify({ el: byEl, boundary: byBound });
})()`;

(async () => {
  const c = makeClient(PORT);
  await c.ready;

  const nt = await c.call('ui.new_tab', { url: URL_ARG });
  const TAB = nt && nt.tab;
  await sleep(WAIT);

  const info = await c.call('ui.evaluate', {
    tab: TAB,
    js: 'JSON.stringify({url:location.href,title:document.title})',
  }).then((r) => JSON.parse(String(r.value))).catch(() => ({ url: URL_ARG, title: '' }));

  // 先读树：抽取过程才会给命中的元素打上 data-ai-id
  const raw = await c.call('ui.get_tree', { tab: TAB });
  const root = raw.tree || raw.root || raw;
  let nodes = 0;
  (function walk(n) {
    if (!n) return;
    nodes++;
    (n.children || []).forEach(walk);
  })(root);

  const r = await c.call('ui.evaluate', { tab: TAB, js: COUNT_JS }, 60000);
  const raw2 = JSON.parse(String(r.value));

  // ---- 跨进程帧：分母必须包含它们，否则这个数字会骗人 ----
  // 2026-10-19 实测（超星泛雅学习页）：本工具报「可点目标 4，可用率 100%、
  // 真缺口 0」，而**整门课程的章节列表一个都没进树** —— 因为那 6 个条目住在
  // 跨进程 iframe 里，而 COUNT_JS 只在顶层 document 里数。
  // 100% 覆盖了 4 个按钮，同时 100% 看不见正文。
  // 现在的口径：每个 `frame-N` 门节点都单独数一遍再合并，数不到的明确报出来，
  // 不许静默排除 —— 分母把"我没测的地方"藏起来，比测错更危险。
  const gates = [];
  (function walkGates(n) {
    if (!n) return;
    if (n.role === 'Iframe' && /^frame-\d+$/.test(String(n.id || ''))) gates.push(n.id);
    (n.children || []).forEach(walkGates);
  })(root);
  const perFrame = [];
  for (const g of gates) {
    try {
      const fr = await c.call('ui.evaluate', { tab: TAB, js: COUNT_JS, frame_ref: g }, 60000);
      const pj = JSON.parse(String(fr.value));
      perFrame.push({ ref: g, boundary: pj.boundary });
    } catch (err) {
      perFrame.push({ ref: g, error: String((err && err.message) || err) });
    }
  }
  const emptyScan = () => ({ pointer: 0, inTree: 0, byDesc: 0, ancOnly: 0, ambiguous: 0, noIdChain: 0, missing: [] });
  const num = (o, k) => (o && Number.isFinite(Number(o[k])) ? Number(o[k]) : 0);
  function addInto(acc, one, where) {
    for (const k of ['pointer', 'inTree', 'byDesc', 'ancOnly', 'ambiguous', 'noIdChain']) acc[k] += num(one, k);
    for (const m of (one && one.missing) || []) acc.missing.push(where ? { ...m, frame: where } : m);
  }
  // 顶层 + 每个可读帧 = 完整分母（人的视角 / 元素视角各算一份）
  const d = emptyScan();
  const e = emptyScan();
  addInto(d, raw2.boundary, null);
  addInto(e, raw2.el, null);
  for (const pf of perFrame) {
    if (pf.error || !pf.boundary) continue;
    addInto(d, pf.boundary, pf.ref);
    // 帧内没有单独的"元素口径"（继承放大在帧内影响很小），与主口径同源
    addInto(e, pf.boundary, pf.ref);
  }
  const framesRead = perFrame.filter((x) => !x.error).length;
  const framesFailed = perFrame.filter((x) => x.error);
  const opaque = Number((raw.context && raw.context.cross_process_frames && raw.context.cross_process_frames.visible_count) || 0);
  const unmeasured = Math.max(0, opaque - gates.length);
  const pct = (n, tot) => (tot ? Math.round((n / tot) * 100) : null);

  const report = {
    url: info.url,
    title: info.title,
    tree_nodes: nodes,
    // 主要口径：手型边界
    click_targets: d.pointer,
    in_tree: d.inTree,
    covered_by_descendant: d.byDesc,
    covered_by_ancestor_only: d.ancOnly,
    ambiguous_ancestor: d.ambiguous,
    no_id_chain: d.noIdChain,
    coverage_pct: pct(d.inTree, d.pointer),
    usable_pct: pct(d.inTree + d.byDesc + d.ancOnly, d.pointer),
    blind: d.ambiguous + d.noIdChain,
    // 跨进程帧的计量状态：读了几个、失败几个、还有几个根本没被读到。
    // unmeasured > 0 时，上面的百分比只覆盖了顶层文档 + 已读的帧。
    frames: {
      measured: framesRead,
      failed: framesFailed,
      unmeasured,
      details: perFrame.map((x) => (x.error ? { ref: x.ref, error: x.error } : { ref: x.ref, pointer: num(x.boundary, 'pointer') })),
    },
    // 次要口径：所有 cursor:pointer 元素（含继承），仅供与历史数据对比
    legacy: {
      pointer_elements: e.pointer,
      in_tree: e.inTree,
      coverage_pct: pct(e.inTree, e.pointer),
    },
    missing: d.missing,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('页面:', report.url);
    console.log('树节点数:', nodes);
    console.log('可点目标（手型边界）:', d.pointer);
    console.log('  ├ 自己带 data-ai-id（直接可操作）:', d.inTree, '→ ' + (report.coverage_pct ?? 'n/a') + '%');
    console.log('  ├ 被单个交互后代盖满且它在树里（壳子，点内层等价）:', d.byDesc);
    console.log('  ├ 仅祖先可定位（点祖先等价于它，且祖先下只有它一个）:', d.ancOnly);
    console.log('  ├ 祖先歧义（同一祖先下多个手型后代，点祖先指不准）:', d.ambiguous);
    console.log('  └ 整条祖先链无 id（真看不见）:', d.noIdChain);
    console.log('可用率（in_tree + by_desc + anc_only）:', report.usable_pct ?? 'n/a', '%', '| 真缺口:', report.blind);
    console.log('跨进程帧（已计入分母）:', framesRead, '个'
      + (framesFailed.length ? '，读取失败 ' + framesFailed.length + ' 个' : '')
      + (unmeasured ? '，**未测量 ' + unmeasured + ' 个**' : ''));
    if (framesFailed.length) {
      for (const f of framesFailed) console.log('  ! ' + f.ref + ' 读不到: ' + f.error);
    }
    if (unmeasured) {
      console.log('  ! 上面这批百分比不含未测量的帧 —— 分母把没测的地方藏起来，比测错更危险');
    }
    console.log('（历史口径 cursor:pointer 元素数 ' + e.pointer + '，覆盖 ' + (report.legacy.coverage_pct ?? 'n/a') + '%）');
    if (d.missing.length) {
      console.log('\n没进树的可点目标（ancOnly 已排除，前 40 个）:');
      console.log('  ' + 'tag'.padEnd(7) + 'class'.padEnd(46) + 'text'.padEnd(30) + 'kind');
      for (const m of d.missing) {
        console.log('  ' + m.tag.padEnd(7)
          + ('[' + m.cls + ']').padEnd(46)
          + JSON.stringify(m.text).padEnd(30)
          + m.kind + (m.reg === 'attr' ? ' attr' : ''));
      }
    }
  }

  c.close();
  process.exit(report.usable_pct !== null && report.usable_pct < 80 ? 1 : 0);
})().catch((e) => {
  console.error('coverage_probe error:', e && e.message);
  process.exit(2);
});

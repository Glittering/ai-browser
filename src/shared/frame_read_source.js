// src/shared/frame_read_source.js — 跨进程子帧（OOPIF）内容读取器
//
// 这段代码**在子帧自己的 JS 上下文里执行**（frame.executeJavaScript），所以它
// 不能引用模块作用域的任何东西；也因此本文件用「真实函数 + toString」的形式
// 产出源码，而不是拼字符串 —— 拼字符串时正则里的 \s 会被模板串吃掉一层，
// 这类错误只有在页面里跑起来才暴露。
//
// ================== 为什么要有这个文件 ==================
// 原来 _readOopifFrames 里内联的选择器是：
//   [contenteditable],[role=textbox],[role=combobox],textarea,
//   input[type=text],input[type=title],input[type=search],button,
//   [role=button],a[href]
// 它是一份**表单控件读取器**，为「B站图文编辑器住在 OOPIF 里」那一次事故写的。
// 于是：
//   1. `a[href]` 漏掉一切 JS 驱动的链接。超星泛雅的章节条目就是
//      `<a onclick=...>` 且 href 为 null —— 实测该帧里 a 有 8 个、a[href] 只有 2 个，
//      章节列表整整 6 条一个都进不了树。
//   2. 纯文本/列表/表格结构完全没有采集通路。就算把锚点补齐，一个「没有可点
//      元素」的 frame（正文、成绩表）依然是空树 —— 而 frame_hints 还会说
//      "merged"，因为合并确实发生了（合并进去一个搜索框）。
//
// 现在改成一次合并查询、按文档序产出两类节点：
//   - 可交互（链接/按钮/输入/富文本/ARIA 控件）→ 带 actions，可被 ui.act
//   - 内容块（标题/列表项/段落/表格单元）→ 只读，用来让 agent **读懂**内容
// 并额外回报覆盖率（帧里可见文本多少字、其中多少字进了树），让"读到了"
// 变成可测量的结论而不是一句自我声明。

/**
 * 子帧内容读取器（页面内执行）。
 * @param {string} prefix 本帧的 ref 前缀，形如 "axf-2-"
 * @returns {{url:string,title:string,nodes:Array,stats:object}|null}
 */
function frameRead(prefix) {
  if (typeof document === 'undefined' || !document || !document.body) return null;

  // 上限是**给调用方省 token**，不是给采集省事：一帧正文能匹配上千个元素，
  // 全塞进树里既贵又没用。覆盖率字段会如实告诉调用方"剩下的没进来"。
  var MAX_SCAN = 1200;   // 参与判定的候选元素上限（文档序）
  var MAX_NODES = 200;   // 最终产出节点上限
  var LABEL_CAP = 120;   // 单个 label 字符上限

  var SEL = [
    // 可编辑 / 表单
    '[contenteditable]', 'textarea', 'select', 'input:not([type=hidden])',
    '[role=textbox]', '[role=combobox]', '[role=listbox]',
    // 可点
    'button', 'a', '[role=button]', '[role=link]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=treeitem]',
    '[role=checkbox]', '[role=switch]',
    // 内容块
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role=heading]',
    'li', '[role=listitem]', 'p', 'dt', 'dd', 'blockquote', 'pre',
    'td', 'th', '[role=cell]', '[role=article]'
  ].join(',');

  function norm(s) {
    return String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim();
  }
  function ownText(el) {
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c && c.nodeType === 3) s += c.nodeValue;
    }
    return norm(s);
  }
  function clip(s) {
    return s.length > LABEL_CAP ? s.slice(0, LABEL_CAP - 1) + '\u2026' : s;
  }

  var els;
  try { els = Array.prototype.slice.call(document.querySelectorAll(SEL)); }
  catch (e) { return null; }
  if (els.length > MAX_SCAN) els = els.slice(0, MAX_SCAN);

  // 这一帧**看得见的文字**总量（覆盖率的分母）。提前算，因为"一个候选都没有
  // 但正文有字"这种帧要单独对待：它往往意味着内容在更深一层的 iframe 里。
  var bodyText = norm(document.body.innerText || '');
  // 完全空白的帧返回 null（上层据此跳过，不往树里塞空壳）。
  if (!els.length && !bodyText) return null;

  // 第一趟：分类 + 过滤不可见。
  var picked = [];
  for (var k = 0; k < els.length; k++) {
    var e = els[k];
    var tag = String(e.tagName || '').toUpperCase();
    var aria = (e.getAttribute && e.getAttribute('role')) || '';
    var r;
    try { r = e.getBoundingClientRect(); } catch (e2) { continue; }
    // 不可见（display:none / 折叠 / 零尺寸）不进树 —— 这是唯一一条"存在但不算"的规则。
    if (!r || r.width < 4 || r.height < 4) continue;

    var editable = e.isContentEditable === true || tag === 'TEXTAREA' || tag === 'INPUT'
      || tag === 'SELECT' || aria === 'textbox' || aria === 'combobox' || aria === 'listbox';
    var clickable = tag === 'BUTTON' || tag === 'A'
      || aria === 'button' || aria === 'link' || aria === 'tab' || aria === 'menuitem'
      || aria === 'option' || aria === 'treeitem' || aria === 'checkbox' || aria === 'switch';

    if (editable || clickable) {
      var label = norm(e.getAttribute && (
        e.getAttribute('aria-label') || e.getAttribute('placeholder') ||
        e.getAttribute('title') || e.getAttribute('data-placeholder')));
      if (!label && (tag === 'BUTTON' || tag === 'A' || clickable)) {
        label = norm(e.innerText || e.textContent || '');
      }
      if (!label && tag === 'INPUT') label = norm(e.value || '');
      var role;
      if (tag === 'A' || aria === 'link') role = 'link';
      else if (tag === 'BUTTON' || aria === 'button') role = 'button';
      else if (tag === 'SELECT' || aria === 'combobox' || aria === 'listbox') role = 'select';
      else if (aria === 'checkbox' || aria === 'switch') role = 'checkbox';
      else if (aria === 'tab' || aria === 'menuitem' || aria === 'option' || aria === 'treeitem') role = 'button';
      else role = 'textbox';
      var editor_type = null;
      if (e.isContentEditable) editor_type = 'richtext';
      else if (tag === 'TEXTAREA') editor_type = 'textarea';
      else if (tag === 'INPUT') editor_type = 'textbox';
      var url = '';
      if (tag === 'A' && e.href) url = String(e.href);
      picked.push({
        el: e, interactive: true, role: role, label: clip(label), editor_type: editor_type, url: url,
        bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      });
      continue;
    }

    // 内容块：**先取自己的直接文本**。祖先（li 里套 p、td 里套 span）如果自己
    // 没有直接文本，它的文字一定来自后代 —— 交给后代去说，避免同一句话在树里
    // 出现两三次。没有直接文本时才回落到 innerText（很多站点的标题是
    // <h2><span>...</span></h2>，span 不在选择器里，回落才不会漏）。
    var t = ownText(e) || norm(e.innerText || '');
    if (!t) continue;
    var crole = 'text';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' || aria === 'heading') crole = 'heading';
    else if (tag === 'LI' || aria === 'listitem') crole = 'listitem';
    else if (tag === 'TD' || tag === 'TH' || aria === 'cell') crole = 'cell';
    picked.push({
      el: e, interactive: false, role: crole, label: clip(t),
      bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    });
  }

  // 第二趟：内容块让位给后代。一个 li 包着 a，留下 a；一个 td 包着 p，留下 p。
  // 只对内容块做这个判断 —— 可交互节点是动作目标，不能因为包着别人就消失。
  var kept = [];
  for (var i = 0; i < picked.length; i++) {
    var it = picked[i];
    var shadowed = false;
    if (!it.interactive) {
      for (var j = 0; j < picked.length; j++) {
        if (j === i) continue;
        var o = picked[j];
        if (o.el === it.el) continue;
        try { if (it.el.contains(o.el)) { shadowed = true; break; } } catch (e3) { /* 跨文档不会发生 */ }
      }
    }
    if (!shadowed) kept.push(it);
  }

  // 第三趟：产出节点。**两类都写 data-ai-id**：树里出现的 ref 必须能用
  // ui.act / ui.evaluate 路由回这个帧（见 page_manager._owningFrame）。
  // 出现"树里有、点了说找不到"的 ref，比不出现更伤人。
  var out = [];
  for (var m = 0; m < kept.length && out.length < MAX_NODES; m++) {
    var node = kept[m];
    var idx = out.length;
    var id = prefix + idx;
    try { node.el.setAttribute('data-ai-id', id); } catch (e4) { continue; }
    var rec = {
      id: id,
      role: node.role,
      label: node.label || '',
      bounds: node.bounds
    };
    if (node.url) rec.url = node.url;
    if (node.editor_type) {
      rec.editor_type = node.editor_type;
      rec.states = ['editable=' + node.editor_type, 'focusable'];
    } else if (node.interactive) {
      rec.states = ['focusable'];
    } else {
      // 只读内容：显式标出来，调用方不会去点一个标题再奇怪为什么没反应。
      rec.states = ['readonly'];
    }
    out.push(rec);
  }

  var keptChars = 0;
  var texts = 0;
  for (var n = 0; n < out.length; n++) {
    // 可编辑节点的 label 是占位符（"请输入标题"），不是页面正文 —— 不计入
    // 覆盖率分子，否则一个带 placeholder 的搜索框就能把覆盖率虚抬上去。
    if (out[n].editor_type) continue;
    keptChars += out[n].label.length;
    if ((out[n].states || [])[0] === 'readonly') texts += 1;
  }

  return {
    url: (typeof location !== 'undefined' && location.href) || '',
    title: (typeof document.title === 'string') ? document.title : '',
    nodes: out,
    stats: {
      candidates: els.length,
      interactive: out.length - texts,
      text_blocks: texts,
      text_chars: bodyText.length,
      kept_chars: keptChars,
      // 覆盖率：这一帧**看得见的文字**里，有多少进了树。1 = 全进；
      // 0.01 = 树里只有一个搜索框，正文一个字都没读到（泛雅事故现场）。
      coverage: bodyText.length
        ? Math.round(Math.min(1, keptChars / bodyText.length) * 100) / 100
        : (out.length ? 1 : 0),
    }
  };
}

/**
 * 产出可直接喂给 `frame.executeJavaScript()` 的源码。
 * 用 toString() 而不是拼字符串：正则、模板、引号全部保持原样，不会在拼装层
 * 被转义吃掉一层（拼字符串的版本踩过 `\s` 变成 `s`）。
 */
export function buildFrameReadSource(prefix) {
  return '(' + frameRead.toString() + ')(' + JSON.stringify(String(prefix || '')) + ')';
}

export { frameRead };
export default { buildFrameReadSource, frameRead };

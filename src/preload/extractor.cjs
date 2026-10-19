// preload/extractor.cjs — Semantic extraction (CommonJS)
// Split out of bridge.js v6.9. Pure DOM functions, no Electron dependency,
// so it can be unit-tested under jsdom.
// Exports: extractTree(), extractPageContext()
var valueContract = require("../shared/value_contract.cjs");
var truncateNodeValue = valueContract.truncateNodeValue;
var sensitiveInputKind = valueContract.sensitiveInputKind;
var authWallLib = require("../shared/auth_wall.cjs");
// 跨进程子帧（OOPIF）探测的纯函数部分。extractor 负责收集（要 DOM），
// 这里负责汇总与"该不该自动切 AX"的判定（要可单测）。
var frameProbe = require("../shared/frame_probe.cjs");

// ============================================================
// 1. EXTRACT TREE — DOM → semantic tree with bounds + states
// ============================================================

// 自动编号的序号。**故意放在模块级**：每次抽取都归零会让"新旧元素拿到同一个 id"
// （旧元素沿用自身 data-ai-id，新元素却可能生成出同名的号），所以它只增不减。
var AI_ID_SEQ = 0;

// document.cookie 在 **opaque origin** 上会**抛 SecurityError**，不是返回空串。
// 哪些页面是 opaque origin：about:blank、sandbox 属性的 iframe、data: 文档、
// 导航失败后 Chromium 留下的空白页。
//
// 2026-10-19 实测事故：`ui.new_tab` 给一个打不开的域名，标签页停在 about:blank，
// 于是 extractPageContext 在这里抛 SecurityError，**整个抽取器崩掉**，
// bridge 的兜底把异常文本塞进一个节点当树返回 —— 调用方看到的是"页面只有
// 一个节点"，而不是"读数失败"。一个可选字段（cookie 只用于登录态启发式）
// 炸掉了整条读路径，这是纯粹的自伤。
function readCookieSafely() {
  try {
    return document.cookie || "";
  } catch (e) {
    // 拿不到就当没有：登录态判定本来就把"没有 cookie 证据"当作未登录倾向，
    // 这个降级方向是安全的（宁可说"需要确认登录"，不可谎报已登录）。
    return "";
  }
}

// ---- 必填 / 已判错（P2-2）----------------------------------------------
// 这两条判定同时服务两处输出：语义树的 node.states 与 context.fields[].required。
// 两个地方必须给同一个答案 —— 树里说"可选"而 context 说"必填"，比只给一处更糟。
//
// required 只认承诺级别的信号：原生 required 属性、aria-required="true"。
// 不用红星/文案猜（那是 context.required_hints 的启发式，语义不同）。
function isRequiredField(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  if (el.required === true) return true;
  return el.getAttribute("aria-required") === "true";
}

// invalid 同样只认"页面自己说了算"的信号：
//   1) aria-invalid（true / grammar / spelling；只有字面 "false" 才算有效）
//   2) 控件自身或近祖先的常见错误态 class（bootstrap 的 has-error、antd 的
//      ant-form-item-has-error、is-invalid 等）
// 刻意**不**用 el.matches(":invalid")：必填项一旦为空，浏览器在用户还没动手之前
// 就把它算作 :invalid —— 那样每个空必填框都会顶着 invalid，信号变成噪声。
function isInvalidField(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  var ai = el.getAttribute("aria-invalid");
  if (ai && ai !== "false") return true;
  var ERROR_STATE_RE = /(^|[\s_-])(is-invalid|invalid|has-error|error-state|field-error)($|[\s_-])/i;
  var n = el;
  for (var d = 0; n && d < 3; d++) {
    var cls = n.className;
    if (typeof cls === "string" && ERROR_STATE_RE.test(cls)) return true;
    n = n.parentElement;
  }
  return false;
}

function extractTree() {
  var seen = new WeakSet();
  var counter = 0;
  var VERSION_TAG = "v6.9";
  // 本次抽取中遇到的、内容读不到的 iframe（跨进程子帧）。汇总后由
  // extractPageContext 写进 context.cross_process_frames。
  var opaqueFrames = [];
  // process() 与文末 fallback 显式扫描会各遇到一次同一个 OOPIF，用这个集合
  // 去重（不依赖 DOM 顺序，也不往页面里写任何标记）。
  var seenOpaque = new WeakSet();

  // 元素自己所在的 window。跨文档时必须用它：
  // `el instanceof HTMLElement` 里 HTMLElement 是**顶层 window**的构造函数，
  // 而同源 iframe 里的元素属于 iframe 自己的 window —— instanceof 恒为 false，
  // 于是 iframe 里每个元素都被当成"不是 HTML 元素"丢掉。
  // 实测：ComfyUI 编辑器装在同源 iframe 里（2024 个元素 / 106 个按钮 / 42 个输入框），
  // 修复前语义树里一个都看不见。
  function winOf(el) {
    try {
      var d = el && el.ownerDocument;
      var w = d && d.defaultView;
      return w || window;
    } catch (e) { return window; }
  }
  function isHtmlElement(el) {
    if (!el || typeof el !== "object") return false;
    var w = winOf(el);
    try { return el instanceof w.HTMLElement; } catch (e) {
      return !!(el.tagName && typeof el.getAttribute === "function");
    }
  }

  // 真正的焦点元素 —— 穿透 shadow root 取最里层。
  //
  // `document.activeElement` 在 Web Component 里只到**宿主**为止：焦点实际在
  // 宿主 shadow root 里那个 contenteditable 上，但顶层读到的是宿主本身。于是
  // 树里没有任何节点能被标成 "focused"（宿主 !== 里层输入框），agent 看不到
  // "光标现在在哪"，而这是判断"接下来 type 会落到哪"的唯一依据。
  // 一次抽取内只算一次（缓存），因为每个节点都要问。
  var _deepActive,
    _deepActiveDone = false;
  function deepActive() {
    if (_deepActiveDone) return _deepActive;
    _deepActiveDone = true;
    var e = null;
    try { e = document.activeElement; } catch (x) { return null; }
    // 防御页面构造的循环引用；shadow 嵌套深度实际远小于 10。
    var g = 0;
    while (e && e.shadowRoot && e.shadowRoot.activeElement && g++ < 10) {
      e = e.shadowRoot.activeElement;
    }
    _deepActive = e;
    return e;
  }

  function isHidden(el) {    if (!isHtmlElement(el)) return true;
    var tag = el.tagName.toLowerCase();
    if (tag === "dialog") return false;
    var style = winOf(el).getComputedStyle(el);
    if (style.display === "none") return true;
    if (style.visibility === "hidden") return true;
    if (el.hasAttribute("aria-hidden") && el.getAttribute("aria-hidden") === "true") return true;
    if (el.hidden === true) return true;
    var p = el.parentElement;
    while (p && p !== document.body) {
      if (p.hidden === true) return true;
      if (p.hasAttribute("aria-hidden") && p.getAttribute("aria-hidden") === "true") return true;
      var ps = winOf(p).getComputedStyle(p);
      if (ps.display === "none") return true;
      p = p.parentElement;
    }
    return false;
  }

  function isPureLayout(el) {
    if (!isHtmlElement(el)) return false;
    var tag = el.tagName.toLowerCase();
    if (tag !== "div" && tag !== "span") return false;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return false;
    var cls = (el.className || "").toLowerCase();
    if (cls.indexOf("codemirror") >= 0 || cls.indexOf("prosemirror") >= 0 || cls.indexOf("monaco") >= 0) return false;
    if (el.hasAttribute("role")) return false;
    if (typeof el.onclick === "function") return false;
    var hasAria = false;
    try { var attrs = el.attributes; for (var ai = 0; ai < attrs.length; ai++) { if (attrs[ai].name.indexOf("aria-") === 0) { hasAria = true; break; } } } catch(e) {}
    if (hasAria) return false;
    // Check if any child is semantic — if so, keep as container
    var children = el.children;
    for (var ci = 0; ci < children.length; ci++) {
      if (children[ci].tagName && INTERACTIVE_TAGS.indexOf(children[ci].tagName.toLowerCase()) >= 0) return false;
      if (children[ci].hasAttribute && children[ci].hasAttribute("role")) return false;
    }
    return true;
  }

  var INTERACTIVE_TAGS = [
    "a","button","input","select","textarea","option","details","dialog",
    "summary","video","audio","canvas","svg","img",
    "table","ul","ol","li","h1","h2","h3","h4","h5","h6","p","label","form",
    "nav","main","header","footer","section","article","aside","iframe"
  ];

  // ───────────────────────────────────────────────────────────────────────
  // 「人看着能点」—— 用渲染结果判定可点性，而不是猜类名、也不是看 onclick 属性。
  //
  // 为什么不能用 el.onclick：Vue / React 一律走 addEventListener，元素上的
  // onclick **属性**恒为 null。实测 CSDN 首页顶部 10 个 .layout-menu-item
  // （首页/博客/下载/学习/…）全是裸 div + addEventListener，用属性判据一个都看不见，
  // 而它们是页面上最常被点的东西。老校验里 `typeof el.onclick === "function"`
  // 这条在框架站上等于永远为假。
  //
  // 为什么用 cursor:pointer：它是**浏览器自己算出来的**可点性 —— 人手看到手型光标
  // 就知道这儿能点，浏览器也是照这个画的。读它等于读"浏览器怎么理解这个元素"，
  // 比猜 `.btn` / `[class*=item]` 这类各框架私有类名通用得多。
  //
  // 为什么必须限定「自己是手型边界」：cursor 是**可继承**的 CSS 属性。一张卡片设了
  // cursor:pointer，卡片里每个 div/span/svg/path 计算出来全是 pointer。若逐个收下，
  // CSDN 首页这一条会从 254 个可点目标涨到 840 个节点，而它们点起来效果完全相同
  // （都落在卡片上）—— 语义树白白膨胀 3 倍，agent 还得从一堆同义节点里挑。
  // 只收"父元素不是 pointer"的最外层那个，数量才等于**人看到几个可点区块**。
  // 实测（tools/coverage_probe.cjs，2026-10-17）：CSDN 254 个可点目标 / 840 个
  // pointer 元素；B站 88 / 400；百度 38 / 88。
  //
  // 还要能读出名字：只判"可点"不够，agent 拿到一个无名节点照样没法选。aria-label /
  // title / 自身文本 / 内含图标，四者任一即可 —— 图标按钮靠标签和图标，文字按钮靠文本。
  // 全都没有就不收（这类通常真的是装饰性占位），宁可少报。
  var CLICK_MIN_BOX = 8;
  // 「一个可点目标」的候选交互后代。只作判重用途，不用来产出节点。
  var INTERACTIVE_DESC = "a[href],button,input,select,textarea,summary,details," +
    "[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=true]";
  function ownCursor(el) {
    try { return String(winOf(el).getComputedStyle(el).cursor || "").toLowerCase(); } catch (e) { return ""; }
  }
  // 外层只是**单个**交互元素的外壳时，不要再收一个节点。
  //
  // 实测（CSDN 首页）：每个导航项都是
  //   <div class="layout-menu-item"><a class="layout-menu-item_inner">首页</a></div>
  // div 是手型边界、<a> 本来就在树里，两者指向同一个目标。不加这条，agent 会在
  // 树里看到两个同名「首页」，还得自己猜哪个是对的 —— 这不是能力，是噪声。
  //
  // 判据是"内层几乎盖满外层"（>=90%），而不是"外层只有一个交互后代"：
  // 一张大的可点卡片里只放了一个小链接时，两者是不同的目标（点卡片 ≠ 点那个链接），
  // 那条外层通路要保留。
  function wrapsSingleInteractive(el) {
    var hits;
    try { hits = el.querySelectorAll(INTERACTIVE_DESC); } catch (e) { return false; }
    if (!hits || hits.length !== 1) return false;
    var inner = hits[0], a, b;
    try { a = el.getBoundingClientRect(); b = inner.getBoundingClientRect(); } catch (e) { return false; }
    if (!a || !b || !(b.width > 0) || !(b.height > 0)) return false;
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (!(w > 0) || !(h > 0)) return false;
    var inter = w * h;
    // 两个方向都要「盖满」：
    //   内层全在外层里 ≠ 内层盖满外层。大卡片里放一个 80×20 的链接，
    //   交集/内层面积 = 100%，但交集/外层面积只有 1% —— 点卡片空白处根本
    //   不等于点那个链接，两条通路必须都留。
    // 实测踩过：只看前者，CB-5 的大卡片会被误判成壳子删掉。
    return inter / (b.width * b.height) >= 0.9 && inter / (a.width * a.height) >= 0.9;
  }
  // ── 浮层（下拉菜单 / 弹出面板）────────────────────────────────────────────
  //
  // 脱流浮层里的每一项都是**独立目标**，但 cursor:pointer 是从触发按钮一路继承
  // 下来的，于是"父元素 pointer 就抑制"的边界规则会把整张菜单并成触发按钮的
  // 一个节点。实测（2026-10-17，B站 动态卡片的「更多」菜单）：
  //
  //   div.bili-dyn-more      cursor:auto    24×24   ← 真正的边界在这里
  //     div.tp               absolute      24×24   ← 菜单被并到这个节点上
  //       div.bili-cascader  absolute     139×106  ← 浮层根（溢出了父块）
  //         div.item         pointer      140×40   ← 「置顶」/「删除」是纯 div
  //           …两层包装…
  //             div.item-label "删除"     26×18
  //
  // 合并后的节点 label 是 "取消置顶  删除"，看着像一个节点，实际**点不了**，
  // 而且"删除"两个字就在里面，agent 会以为它拿到了删除入口。
  //
  // 判据两半：
  //   ① 浮层根 = 位置脱流（absolute/fixed）且盒子**溢出**了父块 —— 弹出层正是
  //      "画在自己触发区外面的一块板"。用"溢出"而不是"脱流"本身，是为了不把
  //      "整页都是绝对定位"的布局当成浮层（那种页面上这条规则会让节点数失控）。
  //      position:fixed 例外：它按定义锚在视口上，直接算浮层根。
  //   ② 浮层内只收**最内层**的可点元素（自身没有"带名字的可点后代"）——
  //      一个菜单项通常套着 item → custom → label 三层，只留能读到名字的那层，
  //      既拿到正确 label，又不会一项收成三层。
  var FLOAT_OVERFLOW_TOL = 8;
  // 盒子是否溢出了父块。用「溢出」而不是「脱流」本身：整页绝对定位的布局也脱流，
  // 但它没有溢出父块（body），不该被当成弹出层。
  function overflowsParent(el) {
    var p = el.parentElement;
    if (!p) return false;
    var a, b;
    try { a = p.getBoundingClientRect(); b = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!(b.width > 0) || !(b.height > 0)) return false;
    return b.left < a.left - FLOAT_OVERFLOW_TOL ||
      b.top < a.top - FLOAT_OVERFLOW_TOL ||
      b.right > a.right + FLOAT_OVERFLOW_TOL ||
      b.bottom > a.bottom + FLOAT_OVERFLOW_TOL;
  }
  // el 是否位于某个浮层里；返回那个浮层根（不在浮层里返回 null）。
  // 只沿 pointer 链上溯：一旦离开手型块（祖先不是 pointer），就不属于同一张菜单。
  // 每层只读一次 computed style（这个函数对每个可点元素都要跑一遍，别重复读）。
  function floatingLayerOf(el) {
    var p = el.parentElement, g = 0;
    while (p && p !== document.documentElement && g++ < 12) {
      var cs;
      try { cs = winOf(p).getComputedStyle(p); } catch (e) { return null; }
      if (String(cs.cursor || "").toLowerCase() !== "pointer") return null;
      if (cs.position === "fixed") return p; // 视口锚定，按定义就是浮层
      if (cs.position === "absolute" && overflowsParent(p)) return p;
      p = p.parentElement;
    }
    return null;
  }

  // 元素的可读文字名（aria-label / alt / title / 自身文本）。
  function elementName(el) {
    var name = "";
    try {
      name = String(el.getAttribute("aria-label") || el.getAttribute("title") || "");
    } catch (e) {}
    // alt 与标签读法同源（见 extractLabel）：图标 img、表情图都靠它取名。
    if (!name.trim()) {
      try {
        var a = el.getAttribute("alt");
        if (a && String(a).trim()) name = String(a).trim();
      } catch (e) {}
    }
    if (!name.trim()) {
      var t = el.innerText || el.textContent || "";
      if (t && t.trim()) name = t.trim().slice(0, 120);
    }
    return name;
  }
  // 没有文字但有图标 —— 也算"人看得出这是什么"，否则右侧一排图标按钮会全部消失。
  // 这条不能混进 elementName 的返回值：那样调用方就分不清"名字是空字符串"和
  // "压根没有名字"，而判重逻辑要的正是后者。
  function hasIconInside(el) {
    try { return !!(el.querySelector && el.querySelector("svg,img,i[class],[class*=icon]")); } catch (e) { return false; }
  }
  function isNamed(el) {
    return !!elementName(el).trim() || hasIconInside(el);
  }

  // 浮层内是否还有"更内层的可点元素"——有的话当前这层只是包装，不该单独收。
  // 只用于压掉 item → custom → label 这种多层包裹，不做通用遍历优化：
  // 浮层本身很小（菜单/面板），后代数量有界。
  function hasClickableNamedDescendant(el) {
    var all;
    try { all = el.querySelectorAll("*"); } catch (e) { return false; }
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var r;
      try { r = c.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width < CLICK_MIN_BOX || r.height < CLICK_MIN_BOX) continue;
      if (ownCursor(c) !== "pointer") continue;
      if (isNamed(c)) return true;
    }
    return false;
  }

  function isHumanClickable(el) {
    // 顺序按代价排：几何 → 自身 cursor → 父 cursor → 命名 → 判重
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < CLICK_MIN_BOX || r.height < CLICK_MIN_BOX) return false;
    if (ownCursor(el) !== "pointer") return false;
    // 浮层内：只收最内层，且不参与"父元素 pointer 就抑制"的合并（理由见上面
    // FLOAT 那段注释）。
    if (floatingLayerOf(el)) {
      if (hasClickableNamedDescendant(el)) return false;
      return isNamed(el);
    }
    var p = el.parentElement;
    if (p && p !== document.documentElement && ownCursor(p) === "pointer") return false;
    if (!isNamed(el)) return false;
    // 命名检查在前、判重在后：判重要遍历后代并量两个盒子，比读文本贵
    if (wrapsSingleInteractive(el)) return false;
    return true;
  }

  // 一个元素的"子节点" = 普通子元素 + 影子根里的元素。
  //
  // 为什么必须下探 shadowRoot：Web Component 的内容**不在 el.children 里**。
  // 实测（2026-10-17，B站 opus 详情页）：整块评论区（输入框、发送按钮、评论列表）
  // 全部装在 <bili-comments> 的 shadow root 里 —— DOM 通路读出来只有 45 个节点、
  // 评论面板是个空 tabpanel，而 AX 通路能读到 190 个节点。这不是 B站 特有的写法：
  // YouTube 的 <ytd-*>、各种设计系统的 <ui-*> 都一样。
  //
  // closed shadow root 按设计拿不到（el.shadowRoot 为 null），这里不做任何绕过 ——
  // 能拿到的是 open 的那部分，拿不到的由 AX 通路兜底。
  function childrenOf(el) {
    var out = [];
    var kids = el.children;
    if (kids) for (var i = 0; i < kids.length; i++) out.push(kids[i]);
    try {
      var sr = el.shadowRoot;
      if (sr && sr.children) {
        for (var j = 0; j < sr.children.length; j++) {
          // slot 分配进 shadow 的 light DOM 元素已在 el.children 里出现过，
          // seen 集合会去重，不会重复产出。
          out.push(sr.children[j]);
        }
      }
    } catch (e) { /* 拿不到就算了 */ }
    return out;
  }

  function isSemantic(el) {
    if (!isHtmlElement(el)) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (isHidden(el)) return false;
    var tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.indexOf(tag) >= 0) return true;
    if (el.hasAttribute("role")) return true;
    if (typeof el.onclick === "function") return true;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return true;
    // 必须排在 isPureLayout **之前**：isPureLayout 对裸 div/span 一律返回 true，
    // 放在它后面就永远轮不到。而真正被它误杀的恰好就是这类元素（CSDN 导航项、
    // 百度"设置/下载/辅助"）。role/onclick/contenteditable/aria 这些显式特征
    // 在上面已经各自 return true 了，所以把"手型边界"插在这里不会削弱原有判定，
    // 只是补上 framework 站上唯一还剩的那条通路。
    if (isHumanClickable(el)) return true;
    if (isPureLayout(el)) return false;
    if (tag === "div" || tag === "span") return false;
    // Non-interactive/non-visible tags — never semantic
    var EXCLUDED_TAGS = ["script", "link", "style", "meta", "noscript", "br", "wbr", "param", "source", "track"];
    if (EXCLUDED_TAGS.indexOf(tag) >= 0) return false;
    return true;
  }

  function inferRole(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range" || type === "number") return "slider";
      // file 输入框必须单独一个 role。此前落进 textbox，于是 actions 报
      // [type,setContent,clear,focus] —— agent 会去 type 一个文件选择器，
      // 而真正的动作是 upload（ui.act action=upload file=...）。
      // 实测（tools/_oneoff/role_gap_probe.cjs）：input[type=file] 报的是
      // role=textbox actions=["type","setContent","clear","focus"]。
      // 这是"不崩不报错、只是把 agent 引向错误动作"的典型，所以必须有回归钉住。
      if (type === "file") return "fileinput";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "select";
    if (tag === "a" && (el.hasAttribute("href") || typeof el.onclick === "function")) return "link";
    if (tag === "details" || tag === "summary") return "button";
    if (tag === "dialog") return "dialog";
    if (tag === "option") return "option";
    if (tag === "img") return "image";
    if (tag === "canvas") return "canvas";
    var ariaRole = (el.getAttribute("role") || "").toLowerCase();
    if (ariaRole) return ariaRole;
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return "textbox";
    if (typeof el.onclick === "function") return "button";
    return "generic";
  }

  // ARIA 控件角色 → 自述动作。
  //
  // 为什么需要这张表：这些 role 是 W3C 定义的，**可点击是角色语义的一部分**，
  // 不需要任何启发式推断。而此前它们全部落到 default 分支的 inferContainerActions，
  // 只有当元素自己带 cursor:pointer / onclick / data-ai-clickable 时才报 click ——
  // 一个老老实实写 <div role="combobox" tabindex="0"> 的自定义下拉，
  // 在语义树里就是 role=combobox actions=["focus"]，listbox/option/menu/menuitem
  // 更是 actions=[]。实测（tools/_oneoff/role_gap_probe.cjs）正是如此。
  //
  // 后果：agent 从树里看不出这些控件可点，只能猜或者放弃。这与下面
  // inferContainerActions 补的是同一类问题（可交互面不可见），只不过那里靠行为信号，
  // 这里靠角色定义 —— 角色是权威来源，优先用它。
  var ARIA_WIDGET_ACTIONS = {
    combobox: ["click", "focus"],
    listbox: ["click", "focus"],
    option: ["click", "focus"],
    menu: ["click", "focus"],
    menubar: ["click", "focus"],
    menuitem: ["click", "focus"],
    menuitemcheckbox: ["click", "focus"],
    menuitemradio: ["click", "focus"],
    tab: ["click", "focus"],
    tablist: ["click", "focus"],
    treeitem: ["click", "focus"],
    gridcell: ["click", "focus"],
    row: ["click", "focus"],
    switch: ["click", "focus"],
    spinbutton: ["type", "focus"],
    searchbox: ["type", "setContent", "clear", "focus"],
  };

  function extractActions(el, role) {
    switch (role) {
      case "button": case "link": return ["click", "focus", "hover"];
      case "textbox": return ["type", "setContent", "clear", "focus"];
      // 文件输入框：真正的动作是 upload，不是 type。给 focus 是因为
      // 有些站点的自定义上传按钮要先 focus 才渲染。
      case "fileinput": return ["upload", "focus"];
      case "select": return ["select", "focus"];
      case "slider": return ["scroll_to", "focus"];
      case "checkbox": case "radio": return ["click", "focus"];
      // dialog 曾经广告 ["open","close"] —— 但 page_manager.performAction 与
      // preload actions.cjs 都没有这两个 case，调用只会拿到
      // {success:false,error:"Unknown action: open"}。语义树自述了做不到的动作，
      // agent 照着做必然失败（e2e/audit_ws.cjs AU-A3/A4 抓到的）。
      // "打开/关闭一个对话框"也没有通用实现：真正的 <dialog> 有 showModal/close，
      // 而 <div role=dialog> 只能靠点它里面的确定/取消按钮 —— 那是猜。
      // 弹窗里真正能点的按钮本身就带 ["click","focus"]，所以这里给空数组不损失能力。
      // 与 inferContainerActions 同一条原则：宁可少报，绝不猜一个假动作。
      case "dialog": return [];
      default:
        if (Object.prototype.hasOwnProperty.call(ARIA_WIDGET_ACTIONS, role)) {
          return ARIA_WIDGET_ACTIONS[role];
        }
        return inferContainerActions(el);
    }
  }

  // 容器类节点（group / generic / image …）原先一律返回空动作。但**很多真实可交互
  // 元素恰恰落在这里**：画布节点的 <div>、自定义下拉、可拖卡片。只按 role 判定，
  // agent 就完全看不出它们可点/可拖 —— 实测在 React Flow 工作流编辑器上，66 个
  // 画布节点全是 `role:group, actions:[]`，"选中一个节点"这个最基本的操作因此无从
  // 下手（只能靠试）。
  //
  // 这里改用**行为信号**推断，而不是猜类名（类名是各框架私有的，猜不通用）：
  //   cursor 拽取态 / draggable 属性 → 可拖（并且按下松开即可点选，故同时给 click）
  //   cursor:pointer / 真实 onclick    → 可点
  //   显式 tabindex>=0                → 可 focus
  // 只补充**已有节点**的动作清单，不新增节点，所以不会撑大语义树体积。
  //
  // 刻意**不给推断节点加 hover**：hover 只有在"悬停会揭示东西"时才有意义，而这一点
  // 从行为信号看不出来，加了就是猜。实测加上后 177 个节点里 172 个都报 hover，
  // 纯噪声、白花 token，却什么都没告诉 agent。
  function inferContainerActions(el) {
    var acts = [];
    try {
      var cursor = "";
      try { cursor = (window.getComputedStyle(el).cursor || "").toLowerCase(); } catch (e) {}
      var draggable =
        (el.getAttribute && el.getAttribute("draggable") === "true") ||
        /^(grab|grabbing|move|col-resize|row-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|crosshair)$/.test(cursor);
      var clickable =
        draggable ||
        cursor === "pointer" ||
        (typeof el.onclick === "function") ||
        (el.hasAttribute && el.hasAttribute("data-ai-clickable"));
      var ti = el.getAttribute ? el.getAttribute("tabindex") : null;
      var focusable = ti !== null && ti !== undefined && Number(ti) >= 0;
      if (clickable) acts.push("click");
      if (draggable) acts.push("drag");
      if (focusable) acts.push("focus");
    } catch (e) { /* 推断失败就不给动作 —— 宁可少报，绝不猜一个假动作 */ }
    return acts;
  }

  function detectEditorType(el) {
    if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") return "contenteditable";
    var cls = (el.className || "").toLowerCase();
    if (cls.indexOf("codemirror") >= 0) return "codemirror";
    if (cls.indexOf("prosemirror") >= 0 || (el.querySelector && el.querySelector("[class*=ProseMirror]"))) return "prosemirror";
    if (cls.indexOf("monaco") >= 0) return "monaco";
    if (cls.indexOf("ql-editor") >= 0) return "quill";
    if (cls.indexOf("draft") >= 0 || (el.querySelector && el.querySelector(".public-DraftEditor-content"))) return "draft";
    // Also check parent for Draft.js (DraftEditor-content is nested)
    if (el.querySelector && el.querySelector("[class*=DraftEditor]")) return "draft";
    if (el.tagName.toLowerCase() === "textarea") return "textarea";
    return null;
  }

  // label 的来源。**只有 kind === "text" 的字才在页面的 innerText 里**，
  // 其余（aria-label / alt / title / placeholder）都是可访问名，不是渲染出来的文字。
  //
  // 为什么必须区分：coverage 的分母是 innerText，分子是树里 label 的字数。
  // 把可访问名算进分子，等于拿两把尺子量 —— 实测 /basic.html：
  // `<input placeholder="随便填">` 让分子 46 大于分母 43，明明只读到 43 字却报 100%。
  // 这类节点在真实站点上极其常见（每个图标按钮都挂 aria-label），
  // 所以这不是零点几个百分比的噪声，而是系统性虚高。
  // 节点上只在"不是渲染文字"时才写 label_kind，正常节点不加字段（省 token）。
  function extractLabel(el, meta) {
    var setKind = function (kind, value) {
      if (meta) meta.kind = kind;
      return value;
    };
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return setKind("aria", ariaLabel);
    // 图片的可访问名是 alt（HTML-AAM 规定），此前完全没读。
    //
    // 实测（B站动态正文）：插入的表情是 `<img alt="[doge_金箍]">`，正文里看得见、
    // 树里 role=image 但 label 是空串 —— "刚才插进去的是哪个表情"读不出来。
    // 同理，带 alt 的图标按钮（img 包在 <button> 里）也变成了无名节点。
    // 空 alt（alt="" 表示装饰性图片）继续往下走，不制造假名字。
    var alt = el.getAttribute("alt");
    if (alt && String(alt).trim()) return setKind("alt", String(alt).trim());
    // input[type=submit|button|reset] 的可访问名是 value（同理，标准规定）。
    // 没有这条，提交按钮在树里是"无名可点节点"，只能靠坐标点。
    var tagName = String(el.tagName || "").toUpperCase();
    if (tagName === "INPUT") {
      var itype = String(el.getAttribute("type") || "").toLowerCase();
      if (itype === "submit" || itype === "button" || itype === "reset") {
        var iv = el.getAttribute("value");
        if (iv && String(iv).trim()) return setKind("value", String(iv).trim());
      }
    }
    var title = el.getAttribute("title");
    if (title) return setKind("title", title);
    var text = renderedText(el).trim();
    // 截断必须**留痕**。原来这里是裸 `text.slice(0, 60)`：一段 500 字的正文在树里
    // 变成 60 字，而且看不出被砍过 —— agent 会把它当成"这一段就这么点字"。
    // 实测 /long.html：60 段全在树里，覆盖率只有 70%，原因就是每段被裁到 60；
    // 而回执上没有任何一处说"我裁过"。抄 frame_read_source 的 clip() 口径，补一个省略号。
    if (text.length > 60) text = text.slice(0, 59) + "\u2026";
    if (text) return setKind("text", text);
    var placeholder = el.getAttribute("placeholder");
    if (placeholder) return setKind("placeholder", placeholder);
    return setKind("none", "");
  }

  // 元素上**看得见**的文字。
  //
  // 为什么不用裸 textContent：它把**不渲染的东西**也算进去，而 label 是
  // 直接给 agent 当"这个元素写着什么"读的。2026-10-19 用受控页面实测了两类泄漏：
  //   1. `<div style="display:none">…说明文字…</div>` 整段进了父节点的 label，
  //      agent 会把一段用户根本看不见的说明当成页面正文；
  //   2. `<canvas>` 页面的容器 label 里装的是 `<script>` 的 JS 源码
  //      （"绘图工具 const c = document.getElementById('cv')…"）。
  // 更根本的是**口径**问题：文字覆盖率的分母（stats.text_chars）用的是
  // innerText，分子来自 label；label 用 textContent 就等于"分子分母两把尺子"，
  // 那这个比例算出来没有意义。
  //
  // innerText 是浏览器算出来的"渲染后可见文字"：display:none / visibility:hidden /
  // <script> / <style> 天然排除，换行也按渲染结果归一。
  //
  // 但要留 textContent 兜底：`<option>`、`<title>` 这类元素 innerText 可能为空，
  // 而它们的文字是有效的可访问名。宁可多读，不可让按钮变无声。
  function renderedText(el) {
    var t = "";
    try { t = el.innerText; } catch (e) { t = ""; }
    if (t && t.trim()) return t;
    try { return el.textContent || ""; } catch (e) { return ""; }
  }

  function extractBounds(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    } catch(e) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  // 富文本块级读取：对任何 contenteditable / 富文本输出段落边界，而非把全文
  // 揉成一段（否则换行被吞、段落结构丢失）。纯结构化，不识别任何编辑器框架：
  // 先定位真正的可编辑元素（contenteditable=true，若自身不是则向下找），
  // 再取其顶层块级子元素；无块时按换行拆分。
  function extractEditorBlocks(editor) {
    try {
      if (!editor) return null;
      var isEditable = editor.contentEditable === 'true' ||
        (editor.getAttribute && editor.getAttribute('contenteditable') === 'true');
      var editable = isEditable
        ? editor
        : (editor.querySelector ? editor.querySelector('[contenteditable=true]') : null) || editor;
      var one = function(b, i) {
        var t = (b.innerText || (b.textContent ? b.textContent : '') || b.value || '').trim();
        if (!t) return null;
        return { i: i, role: 'paragraph', text: t.slice(0, 500) };
      };
      // 通用：取可编辑元素顶层块级子元素（Draft 的 [data-block] 即 DIV，天然覆盖）
      var kids = Array.prototype.slice.call(editable.children || [])
        .filter(function(c) { return /^(P|H1|H2|H3|H4|H5|H6|LI|PRE|BLOCKQUOTE|DIV)$/.test(c.tagName); });
      var items = kids.map(function(c, i) {
        var t = (c.innerText || (c.textContent ? c.textContent : '') || '').trim();
        if (!t) return null;
        return { i: i, role: c.tagName.toLowerCase(), text: t.slice(0, 500) };
      }).filter(Boolean);
      if (items.length === 0) {
        // 无显式块时按换行拆分（textarea 语义）
        var itx = editable.innerText || (editable.textContent ? editable.textContent : '');
        var tx = itx.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
        return tx.map(function(s, i) { return { i: i, role: 'paragraph', text: s.slice(0, 500) }; });
      }
      return items;
    } catch(e) { return null; }
  }

  function extractAttributes(el) {
    var attrs = {};
    try {
      for (var ai = 0; ai < el.attributes.length; ai++) {
        var a = el.attributes[ai];
        if (a.name === "data-ai-id") continue;
        if (a.name.indexOf("data-") === 0 || a.name.indexOf("aria-") === 0 || a.name === "name" || a.name === "id" || a.name === "class") {
          attrs[a.name] = a.value;
        }
      }
    } catch(e) {}
    return attrs;
  }

  function process(el) {
    if (seen.has(el)) return null;
    seen.add(el);
    if (!el.isConnected) return null;
    var tag = el.tagName.toLowerCase();
    // 同源 iframe 必须**在 isSemantic 判定之前**处理：iframe 自己不带语义（无 role/无 label），
    // 若放在后面，会被下面"非语义元素只递归子节点"的分支吞掉，iframe 里的内容一个都进不了树。
    // 实测：ComfyUI 编辑器装在同源 iframe 里，里面有 2024 个元素（106 个按钮 / 42 个输入框），
    // 修复前语义树只有 17 个元素、可操作面 6 个 click，agent 根本看不见编辑器。
    if (tag === "iframe") {
      try {
        var ifrDoc = el.contentDocument || (el.contentWindow && el.contentWindow.document);
        if (ifrDoc && ifrDoc.body) {
          var sub = process(ifrDoc.body);
          var subKids = Array.isArray(sub) ? sub : (sub ? [sub] : []);
          return {
            id: "iframe-" + (el.id || counter++),
            role: "iframe_body",
            label: el.title || el.name || "iframe content",
            children: subKids
          };
        }
      } catch (e) { /* cross-origin：读不到就算了，交给后面的兜底 */ }
      // 走到这里 = 同源 DOM 通路读不到内容的 iframe。绝大多数是跨进程子帧
      // （OOPIF）：Chromium 把它放在独立渲染进程，contentDocument 恒为 null，
      // 同源递归对它完全无效。**此前这里静默丢弃** —— B站图文编辑器的正文
      // 编辑器就是这么从默认语义树里整体消失的（事故复盘见
      // docs/AGENT_OPERABILITY_FEEDBACK.md）。现在至少留下带 opaque 标记的
      // 占位节点 + 汇总进 context.cross_process_frames 的线索，调用方才知道
      // "这里有一块内容，且默认通路读不到，该切 AX"。
      try {
        if (!seenOpaque.has(el)) {
        seenOpaque.add(el);
        var ifrRect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        opaqueFrames.push({
          id: el.id || null,
          // 绝对地址（el.src 会被解析成绝对 URL）。相对地址对调用方没用：
          // 树里写着 /mooc2-ans/xxx，agent 拿它去 navigate 只会失败。
          src: (el.src || '').trim() || el.getAttribute("src") || null,
          width: Math.round(ifrRect.width || 0),
          height: Math.round(ifrRect.height || 0)
        });
        }
      } catch (e2) { /* 拿不到尺寸也至少留下存在性线索 */ }
      return {
        id: "iframe-" + (el.id || counter++),
        role: "iframe_body",
        label: el.title || el.name || "iframe content (cross-process, not readable from here)",
        // opaque: 内容在另一个渲染进程。同源读取（getBoundingClientRect 之外
        // 的任何 DOM 访问）都到不了；读取要走 CDP Accessibility（ax:true）。
        opaque: true,
        // 绝对地址：树里出现的 iframe 必须能被直接打开（ui.new_tab）。
        src: (el.src || '').trim() || el.getAttribute("src") || null
      };
    }
    if (!isSemantic(el)) {
      var elChildren = childrenOf(el);
      if (elChildren && elChildren.length > 0) {
        var results = [];
        for (var ci = 0; ci < elChildren.length; ci++) {
          var childNode = process(elChildren[ci]);
          if (childNode) {
            if (Array.isArray(childNode)) results.push.apply(results, childNode);
            else results.push(childNode);
          }
        }
        return results.length ? results : null;
      }
      return null;
    }

    var labelMeta = {};
    var label = extractLabel(el, labelMeta);
    var role = inferRole(el);
    var actions = extractActions(el, role);
    var bounds = extractBounds(el);
    var attributes = extractAttributes(el);
    var nativeId = el.id || "";
    // editor_type 仅作"解读"元数据提示（agent 可读懂这是什么编辑器），
    // 操作路径已不依赖它——CDP 受信输入对任何框架通用。
    var editorType = detectEditorType(el);
    var editorBlocks = editorType ? extractEditorBlocks(el) : null;

    // Assign ref ID — use native id, fallback to generated.
    //
    // ai-id 必须跨"读树 → 操作"稳定。agent 的典型用法是先 get_tree 拿 id、再按 id
    // 操作，而页面在这中间自更新（画布增删节点、列表插入一行）是常态。
    // 旧实现用**每次抽取都归零**的 counter 按遍历顺序编号：在最前面插入 1 个元素，
    // 后面**所有**元素都被重新编号，旧 id 就指向了另一个元素 —— 操作照常返回
    // success，却打在了别的东西上（静默错打；实测插入 1 个元素后 4/4 元素 id 全变）。
    // 修法两条：① 元素已有 data-ai-id 就沿用，id 不再随遍历顺序变化；
    //          ② 新元素用模块级只增不减的序号，保证生成出来的 id 不重号。
    var existingAiId = el.getAttribute("data-ai-id");
    var aiId = nativeId || existingAiId || "e:" + el.tagName.toLowerCase() + "-" + (AI_ID_SEQ++);
    // ③ 只在值**真的变了**时才写。
    //
    // 实测（tools/_oneoff/mutation_microtest.cjs，真实 Chromium）：setAttribute 把属性
    // 设成**完全相同的值**，MutationObserver 照样收到记录（{"name":"data-ai-id",
    // "value":"a","old":"a"}）。所以无条件写 = **每一次**读取都向页面自己的 observer
    // 灌 N 条属性变更 —— 4000 个语义元素的页面上实测每次 4001 条。
    // 页面里任何监听属性的脚本（埋点、框架插件、站点自己的 observer）都会被惊动，
    // 而我们只是想"读"一下。加个值比较，热读就归零；冷读仍要写，那是 id 稳定性的
    // 代价，不能省。
    if (existingAiId !== aiId) el.setAttribute("data-ai-id", aiId);

    var states = [];
    if (el.disabled === true) states.push("disabled");
    if (el.readOnly === true) states.push("readonly");
    if (el.checked === true) states.push("checked");
    // 选中态的第二来源：自绘单选/复选。
    //
    // 实测（CSDN 发布页的「可见范围」）：视觉上是四个单选，DOM 是
    // `<label><input type=radio style="opacity:0"></label>`，可点的是 label。
    // label 自己没有 checked，于是树里四个选项**长得一模一样**，只有 visible ——
    // 「我到底选中了哪个」读不出来，只能靠截图。这是 HTML 标准里写清楚的：
    // label 的选中态来自它关联的控件（label.control / label[for]），
    // WAI-ARIA 的 role=radio/checkbox 则用 aria-checked。两条都读，不猜。
    // 顺序：真控件 → 关联控件 → aria 属性。
    if (states.indexOf("checked") < 0) {
      var ctrl = null;
      try {
        if (el.control) ctrl = el.control;
        else if (el.htmlFor && el.ownerDocument) ctrl = el.ownerDocument.getElementById(el.htmlFor);
      } catch (e) { ctrl = null; }
      if (ctrl && ctrl.checked === true) states.push("checked");
      else if (el.getAttribute && el.getAttribute("aria-checked") === "true") states.push("checked");
    }
    if (el.getAttribute && el.getAttribute("aria-selected") === "true") states.push("selected");
    // 必填 / 已判错（P2-2）。此前只有 disabled/readonly/checked/focused/visible，
    // 掘金的红*必填、aria-required、字段已判错在树里**完全不可见**：agent 只能
    // 从"提交后页面没反应"倒推，而必填缺失正是提交失败最常见的原因。
    // required 用与 context.fields[].required 同一判定（原生 + aria-required），
    // 两条读层对同一件事只能有一个答案。
    if (isRequiredField(el)) states.push("required");
    if (isInvalidField(el)) states.push("invalid");
    if (el === deepActive()) states.push("focused");
    if (!isHidden(el)) states.push("visible");

    var node = {
      id: aiId,
      role: role,
      label: label,
      states: states.length ? states : undefined,
      actions: actions,
      bounds: bounds
    };
    // 只有当 label **不是**页面上渲染出来的文字时才写这一位。coverage 分子靠它
    // 把 aria-label / alt / title / placeholder 排除掉（它们不在 innerText 里）。
    // 正常节点不写，省 token。
    if (labelMeta.kind && labelMeta.kind !== "text") node.label_kind = labelMeta.kind;
    // Attach current value for input/textarea/contenteditable.
    // 截断走共享契约（src/shared/value_contract.cjs）：按 Unicode code point
    // 计数，截断时带 value_truncated / value_full_length / value_fetch_ref，
    // 未截断只给 value（不给普通节点加字段）。敏感控件不泄露值。
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var sensitive = sensitiveInputKind(el);
      if (sensitive) {
        node.value_sensitive = true;
        node.value_sensitive_reason = sensitive;
      } else {
        var v = el.value;
        if (v !== undefined && v !== "" && v !== null) {
          var cut = truncateNodeValue(v, aiId, 200);
          node.value = cut.value;
          if (cut.value_truncated) {
            node.value_truncated = true;
            node.value_full_length = cut.value_full_length;
            node.value_length_unit = cut.value_length_unit;
            node.value_fetch_ref = cut.value_fetch_ref;
          }
        }
      }
    } else if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") {
      var innerText = el.innerText;
      if (innerText && innerText.trim()) {
        var cutCe = truncateNodeValue(innerText, aiId, 200);
        node.value = cutCe.value;
        if (cutCe.value_truncated) {
          node.value_truncated = true;
          node.value_full_length = cutCe.value_full_length;
          node.value_length_unit = cutCe.value_length_unit;
          node.value_fetch_ref = cutCe.value_fetch_ref;
        }
      }
    }
    if (Object.keys(attributes).length) node.attributes = attributes;
    if (editorType) node.editor_type = editorType;
    if (editorBlocks) node.editor_blocks = editorBlocks;

    // Children — 普通子元素 + 影子根（Web Component），见 childrenOf 的注释
    var elChildren = childrenOf(el);
    var childNodes = [];

    // 同源 iframe 的递归已在 process() 开头完成（必须在 isSemantic 之前），此处不再重复。

    if (elChildren && elChildren.length) {
      for (var ci = 0; ci < elChildren.length; ci++) {
        var childNode = process(elChildren[ci]);
        if (childNode) {
          if (Array.isArray(childNode)) childNodes.push.apply(childNodes, childNode);
          else childNodes.push(childNode);
        }
      }
    }

    if (childNodes.length) node.children = childNodes;

    return node;
  }

  var root = process(document.body);
  // Fallback: explicitly scan for iframes missed by process() traversal
  var allIframes = document.querySelectorAll("iframe");
  var extraIframes = [];
  for (var ii = 0; ii < allIframes.length; ii++) {
    var ifr = allIframes[ii];
    var iframeBody = null;
    var iframeText = "";
    try {
      var ifrDoc = ifr.contentDocument || ifr.contentWindow.document;
      // 已由 process() 处理过的同源 iframe 直接跳过。否则会再发一个 iframe-text-N /
      // iframe-empty-N 空壳节点，看起来像"这里有个 iframe 但里面是空的"，反而误导调用方。
      if (ifrDoc && ifrDoc.body && seen.has(ifrDoc.body)) continue;
      if (ifrDoc && ifrDoc.body) {
        iframeText = (ifrDoc.body.innerText || "").slice(0, 200);
        // Use a fresh sub-process for iframe body
        var cb = function(el) {
          if (!el || seen.has(el)) return null;
          seen.add(el);
          if (!el.isConnected) return null;
          var tg = el.tagName.toLowerCase();
          var lbl = el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").slice(0, 40) || el.getAttribute("placeholder") || "";
          var rl = tg;
          if (tg === "button") rl = "button";
          else if (tg === "input") { var ty = (el.getAttribute("type") || "").toLowerCase(); rl = (ty === "checkbox") ? "checkbox" : (ty === "radio") ? "radio" : "textbox"; }
          else if (tg === "textarea") rl = "textbox";
          else if (tg === "a") rl = "link";
          else if (tg === "img") rl = "image";
          else if (tg === "iframe") rl = "iframe";
          else if (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true") rl = "textbox";
          var ariaRole = (el.getAttribute("role") || "").toLowerCase();
          if (ariaRole) rl = ariaRole;
          // Skip pure layout divs/spans inside iframe too
          if (tg === "div" || tg === "span") {
            if (!el.hasAttribute("role") && !(el.contentEditable === "true" || el.getAttribute("contenteditable") === "true")) {
              // recurse into children but don't create a node
              var ch = el.children;
              if (ch && ch.length) {
                var results = [];
                for (var ci = 0; ci < ch.length; ci++) { var cn = cb(ch[ci]); if (cn) { if (Array.isArray(cn)) results.push.apply(results, cn); else results.push(cn); } }
                return results.length ? results : null;
              }
              return null;
            }
          }
          var nd = { id: "iframe-el-" + counter++, role: rl, label: lbl };
          var ch2 = el.children;
          if (ch2 && ch2.length) {
            var cc = [];
            for (var ci2 = 0; ci2 < ch2.length; ci2++) { var cn2 = cb(ch2[ci2]); if (cn2) { if (Array.isArray(cn2)) cc.push.apply(cc, cn2); else cc.push(cn2); } }
            if (cc.length) nd.children = cc;
          }
          return nd;
        };
        iframeBody = cb(ifrDoc.body);
      }
    } catch(e) {}
    if (iframeBody) {
      extraIframes.push({ id: "iframe-" + counter++, role: "iframe_body", label: (ifr.title || ifr.name || "iframe content"), children: iframeBody.children || (Array.isArray(iframeBody) ? iframeBody : [iframeBody]), text: iframeText });
    } else if (iframeText) {
      extraIframes.push({ id: "iframe-text-" + counter++, role: "iframe_body", label: ifr.title || ifr.name || "iframe content", text: iframeText });
    } else {
      // 同源通路读不到内容。绝大多数是跨进程子帧（OOPIF）—— Chromium 把它
      // 放在独立渲染进程，contentDocument 恒 null。**此前这里只产出一个不带
      // 任何标记的空壳节点**，看起来像"这里有个 iframe 且里面是空的"，
      // 而真相是"这里有一整块内容，默认通路完全读不到"。标 opaque + 收集。
      if (!seenOpaque.has(ifr)) {
        seenOpaque.add(ifr);
        try {
          var oRect = ifr.getBoundingClientRect ? ifr.getBoundingClientRect() : { width: 0, height: 0 };
          opaqueFrames.push({
            id: ifr.id || null,
            src: (ifr.src || '').trim() || ifr.getAttribute("src") || null,
            width: Math.round(oRect.width || 0),
            height: Math.round(oRect.height || 0)
          });
        } catch (e3) { /* 尺寸拿不到也留下存在性线索 */ }
      }
      extraIframes.push({ id: "iframe-empty-" + counter++, role: "iframe", label: ifr.title || ifr.name || "iframe", opaque: true, src: (ifr.src || '').trim() || ifr.getAttribute("src") || null });
    }
  }
  if (extraIframes.length && root) {
    if (!root.children) root.children = [];
    root.children.push.apply(root.children, extraIframes);
  }
  if (!root) {
    return { id: "root", role: "generic", label: "", states: ["visible"], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }
  // 当前焦点元素的 data-ai-id，挂根上。ui.get_focused 一直在读这个字段，而
  // extractor 从不产出它 —— 于是那个方法恒返回 null（e2e/audit_ws.cjs AU-B2 抓到）。
  // 焦点信息本来就在每个节点的 states:[...,"focused"] 里，但那是 O(n) 扫树；
  // 挂根上 O(1)，且与节点状态同源（都是「真正的焦点元素」，见 deepActive）。
  //
  // 三种情况给 null，不猜：焦点在 body/documentElement（没有对应语义节点）、
  // 焦点在iframe 里（activeElement 是 iframe 元素本身，不是里面那个输入框）、
  // 焦点元素不是语义节点（没有 data-ai-id，比如被 isPureLayout 剪掉的容器）。
  var focusedEl = null;
  try { focusedEl = deepActive(); } catch (e) {}
  var focusedId = null;
  if (focusedEl && focusedEl !== document.body && focusedEl !== document.documentElement &&
      typeof focusedEl.getAttribute === "function") {
    focusedId = focusedEl.getAttribute("data-ai-id") || null;
  }
  root.focused_element_id = focusedId;
  root._debug = { iframe_count: extraIframes.length, version: VERSION_TAG };
  // 内容读不到的跨进程子帧：挂根上供调用方一眼看到"这里有 N 块默认通路
  // 读不到的内容"。extractPageContext 会汇总成更结构化的
  // context.cross_process_frames（带建议通路）。
  root.cross_process_iframes = opaqueFrames;
  return root;
}

// ============================================================
// 2. EXTRACT PAGE CONTEXT — modals, forms, iframes, session
// ============================================================

// 收集当前页面里"内容读不到"的 iframe（跨进程子帧 OOPIF）。
// 为什么 extractPageContext 自己扫而不是复用 extractTree 闭包里的数组：
// bridge 的 ai:context 只调 extractPageContext（ui.auth_state 走的就是这
// 条），那条路径上 extractTree 从未运行，闭包数组是空的 —— 登录态自查
// 也必须能报告"这个页面有 OOPIF"。
function collectOpaqueFrames() {
  var out = [];
  var ifrs = document.querySelectorAll("iframe");
  for (var i = 0; i < ifrs.length; i++) {
    var f = ifrs[i];
    var readable = false;
    try {
      var d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
      readable = !!(d && d.body);
    } catch (e) { readable = false; }
    if (readable) continue;
    var r = { width: 0, height: 0 };
    try { r = f.getBoundingClientRect() || r; } catch (e2) { /* 尺寸缺失不影响存在性 */ }
    out.push({
      id: f.id || null,
      src: f.getAttribute("src") || null,
      width: Math.round(r.width || 0),
      height: Math.round(r.height || 0)
    });
  }
  return out;
}

function extractPageContext() {
  // MODALS — unified search across ALL patterns.
  // Visibility rule: do NOT use `el.offsetParent === null` to skip hidden nodes —
  // position:fixed overlays (masks/dialogs/popups) always have offsetParent===null
  // even when fully visible, so that check silently drops every modal. Use a
  // layout-rect + computed-style test that tolerates fixed positioning instead.
  function isShown(el) {
    try {
      if (el.getClientRects().length === 0) return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    } catch (e) { return false; }
    return true;
  }
  var modalSelectors = [
    "[class*=modal]", "[class*=dialog]", "[class*=popup]", "[class*=drawer]", "[class*=overlay]", "[class*=mask]",
    "[role=dialog]", "[role=alertdialog]"
  ];
  // 字段级报错选择器。提到函数开头：describeField 在 modal 循环里就要用它，
  // 而顶层扫描在后面 —— var 提升会让它在那时还是 undefined。
  var ERROR_SEL = [
    "[class*=error]", "[class*=err]", "[class*=invalid]", "[class*=fail]",
    "[class*=warning]", "[class*=warn]", "[class*=toast]", "[class*=snackbar]",
    "[role=alert]"
  ];

  // 字段描述的唯一实现。modals[].fields[] 与 forms[].fields[] 曾经各写一份，
  // 结果弹窗字段少了 id —— 弹窗里有多个同类输入框时，agent 无法把读到的
  // error/required 对应到具体元素，只能靠 placeholder 猜。两份实现必然漂移，
  // 所以收成一处，两边形状完全一致。
  //
  // 字段级错误只认两条路，都没有就宁可空着也不猜（猜出来的对应关系比没有更糟）：
  //   1) ARIA 承诺：aria-describedby / aria-errormessage 指向。属性值可以是
  //      空格分隔的多个 id，逐个看，而不是整串塞进 getElementById（那样永远
  //      查不到）。
  //   2) 同一父容器内恰好一个输入控件 —— 结构上只可能对应它。
  // 老实现没有第 2 条的数量约束：容器里有 3 个字段、3 条错误时，它取容器内
  // 第一条错误，于是**每个字段都报同一条错误**。这是错报对应关系，比不报更糟。
  function fieldErrorOf(inp) {
    var ids = (inp.getAttribute("aria-describedby") || "") + " " +
              (inp.getAttribute("aria-errormessage") || "");
    var list = ids.split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      var el = document.getElementById(list[i]);
      if (el && isShown(el)) {
        var t = (el.textContent || "").trim();
        if (t && t.length < 100) return t;
      }
    }
    var p = inp.parentElement;
    if (!p) return null;
    if (p.querySelectorAll("input:not([type=hidden]),textarea,select").length !== 1) return null;
    var errs = p.querySelectorAll(ERROR_SEL.join(","));
    for (var j = 0; j < errs.length; j++) {
      var et = (errs[j].textContent || "").trim();
      if (et && et.length > 0 && et.length < 100) return et;
    }
    return null;
  }

  function describeField(inp) {
    var entry = {
      id: inp.id || inp.name || "",
      type: inp.type || inp.tagName.toLowerCase(),
      placeholder: (inp.placeholder || "").slice(0, 40),
      // 只读原生 required 会把只用 aria-required 标必填的站点（不少组件库如此）
      // 整片当成选填 —— agent 于是跳过必填项、提交必失败。ARIA 的 "true"/"false"
      // 都按字面认，其它值（含缺失）不认。
      required: isRequired(inp)
    };
    var err = fieldErrorOf(inp);
    if (err) entry.error = err;
    return entry;
  }

  var modals = [];
  for (var si = 0; si < modalSelectors.length; si++) {
    var els = document.querySelectorAll(modalSelectors[si]);
    for (var ei = 0; ei < els.length; ei++) {
      var m = els[ei];
      if (!isShown(m)) continue;
      // Buttons may be real <button> or ARIA/JS-styled fakes (div/span[role=button]).
      var btns = m.querySelectorAll("button,[role=button],input[type=submit],input[type=button]");
      var inps = m.querySelectorAll("input:not([type=hidden]),textarea,select");
      if (btns.length === 0 && inps.length === 0) continue;

      var btnList = [];
      for (var bi = 0; bi < btns.length; bi++) {
        var t = (btns[bi].textContent || btns[bi].value || "").trim();
        if (!t) continue;
        btnList.push({ text: t.slice(0, 30), disabled: btns[bi].disabled || false });
      }

      var fieldList = [];
      for (var fi = 0; fi < inps.length; fi++) fieldList.push(describeField(inps[fi]));

      // Errors — 14 selectors + key phrase scan
      var errSel = ["[class*=error]","[class*=err]","[class*=invalid]","[class*=toast]","[class*=message]",
        "[class*=notification]","[class*=alert]","[class*=warning]","[class*=fail]","[class*=tip]",
        "[role=alert]","[role=status]","[class*=notice]","[class*=snackbar]"];
      var errors = [];
      for (var esi = 0; esi < errSel.length; esi++) {
        var errEls = m.querySelectorAll(errSel[esi]);
        for (var eei = 0; eei < errEls.length; eei++) {
          var et = (errEls[eei].textContent || "").trim();
          if (et && et.length < 200 && errors.indexOf(et) < 0) errors.push(et);
        }
      }
      // Key phrase scan
      var mText = m.innerText || "";
      var phrases = ["不存在","失败","错误","不能为空","请选择","请填写","not found","failed","error","required","cannot be empty","博主","验证","字数"];
      for (var pi = 0; pi < phrases.length; pi++) {
        var idx = mText.indexOf(phrases[pi]);
        if (idx >= 0) {
          var snippet = mText.slice(Math.max(0, idx - 10), idx + phrases[pi].length + 40);
          if (errors.indexOf(snippet) < 0) errors.push(snippet);
        }
      }

      // 必填提示不在这里扫。这些扫描原先全写在 modal 循环里，于是"红星能否被
      // 读到"取决于它所在容器的 class 里有没有 modal/dialog/popup/drawer/
      // overlay/mask 关键词 —— 普通页面表单里的红星，context.modals[].required_hints
      // 读不到，顶层压根没有这个字段，forms[].fields 里也没有。报错扫描早已改成
      // 整文档 + 顶层，必填扫描只是漏迁；现在统一扫整份文档、落顶层
      // context.required_hints（见本函数下方的 scanRequiredHints）。
      modals.push({
        buttons: btnList,
        fields: fieldList,
        errors: errors.length ? errors : null
      });
    }
  }

  // FORMS
  var forms = document.querySelectorAll("form");
  var formList = [];
  for (var fi = 0; fi < forms.length; fi++) {
    var f = forms[fi];
    if (!isShown(f)) continue;
    var inps = f.querySelectorAll("input:not([type=hidden]),textarea,select");
    var fields = [];
    for (var ii = 0; ii < inps.length; ii++) fields.push(describeField(inps[ii]));
    if (fields.length) formList.push({ fields: fields });
  }

  // 必填判定：原生 required 或 aria-required="true"。站点/组件库常只用 ARIA 标必填
  // （原生 required 会触发浏览器自带的气泡校验，很多站点刻意绕开它）。
  function isRequired(el) {
    // 单一实现：与 node.states 里的 "required" 同源，避免同一件事两个答案。
    return isRequiredField(el);
  }

  // ---- 顶层错误 / 提示扫描（P0-2 / P1-6）----
  // context.modals[] 的 errSel 扫描只在 class 含 modal/dialog/popup/drawer/
  // overlay/mask 的容器内部生效，而"页面即表单"的站点根本没有这类容器 ——
  // 字段级小红字（无 role 的 <span class="field-error">）、表单级汇总、toast、
  // 服务端报错统统读不到：agent 提交了表单却看不到哪里错了。这里把同类扫描
  // 扩到整个 document，并落到**顶层** context。
  //
  // 刻意**不**把这些元素提升为语义树节点：站点用裸 span/div 承载提示文案是常态，
  // isPureLayout 剪掉它们正是为了压住语义树的 token 体积（真实页面上量极大）。
  // 只读文本、只进 context —— 主树一个节点都不加（实测节点数与改动前完全一致）。
  // ERROR_SEL 已在本函数开头声明（字段描述要用它，见 fieldErrorOf）。
  var HINT_SEL = [
    "[class*=tip]", "[class*=hint]", "[class*=notice]", "[class*=help]",
    "[class*=counter]", "[class*=remaining]", "[role=status]", "[aria-live]"
  ];
  // 字数/计数类文案（"0/256"）常被塞进连 class 都没有的裸 span —— 无 class 可依，
  // 只能认文本形态。限定"叶子元素 + 文本很短"来降噪，避免整页文本被收进来。
  var LIMIT_RE = /^[^\d]{0,10}\d+\s*\/\s*\d+[^\d]{0,10}$/;

  function textOf(el) {
    if (!isShown(el)) return "";
    var t = (el.textContent || "").trim();
    if (!t || t.length > 120) return "";
    return t;
  }
  // 报错对应到具体字段。两条可靠路径，都没有就宁可空着也不猜：
  //  1) 标准 ARIA 关联：哪个输入用 aria-describedby / aria-errormessage 指到这个
  //     报错元素（mTitle[aria-describedby=mErr] → mErr 的 field 就是 mTitle）。
  //  2) 同一容器内恰好一个输入控件（#tagWrap 里的 tagDup → tagInput）。
  // 刻意不做"找最近的 input"这类位置猜测：报错常集中渲染在表单底部/顶部，
  // 离它最近的 input 往往不是它对应的那个字段，猜出来的对应关系比没有更糟。
  function fieldOf(el) {
    var eid = el.id;
    if (eid) {
      try {
        var ref = document.querySelector(
          '[aria-errormessage~="' + eid + '"],[aria-describedby~="' + eid + '"]');
        if (ref) return ref.id || ref.name || "";
      } catch (e) {}
    }
    var p = el.parentElement;
    if (!p) return "";
    // 富文本/标签类字段常常不是 input/textarea，而是 contenteditable 容器
    // （掘金的标签输入区就是）。只数 input/textarea/select 时，这类字段的错误
    // 永远关联不上——"至少添加一个标签"因此彻底读不到（P2-2 的原始症状）。
    var inps = p.querySelectorAll(
      'input:not([type=hidden]),textarea,select,[contenteditable="true"],[contenteditable=""]');
    if (inps.length !== 1) return "";
    return inps[0].id || inps[0].name || "";
  }
  function scanSelectors(sels) {
    var out = [];
    for (var si = 0; si < sels.length; si++) {
      var els;
      try { els = document.querySelectorAll(sels[si]); } catch (e) { continue; }
      for (var ei = 0; ei < els.length && out.length < 40; ei++) {
        var t = textOf(els[ei]);
        if (t && out.indexOf(t) < 0) out.push(t);
      }
    }
    return out;
  }

  var topErrors = scanSelectors(ERROR_SEL);
  var fieldErrors = [];
  var seenFieldErr = {};
  for (var fes = 0; fes < ERROR_SEL.length && fieldErrors.length < 40; fes++) {
    var feEls;
    try { feEls = document.querySelectorAll(ERROR_SEL[fes]); } catch (e) { continue; }
    for (var fei = 0; fei < feEls.length && fieldErrors.length < 40; fei++) {
      var fet = textOf(feEls[fei]);
      if (!fet) continue;
      var fid = fieldOf(feEls[fei]);
      if (!fid) continue;
      var fkey = fid + "\u0000" + fet;
      if (seenFieldErr[fkey]) continue;
      seenFieldErr[fkey] = 1;
      fieldErrors.push({ field: fid, text: fet });
    }
  }
  var topHints = scanSelectors(HINT_SEL);
  try {
    var cand = document.querySelectorAll("span,div,p,small,em,i,label,li,strong,b");
    for (var ci2 = 0; ci2 < cand.length && topHints.length < 40; ci2++) {
      if (cand[ci2].children && cand[ci2].children.length) continue; // 只认叶子，避免整页文本
      var ht = textOf(cand[ci2]);
      if (!ht || !LIMIT_RE.test(ht)) continue;
      if (topHints.indexOf(ht) < 0) topHints.push(ht);
    }
  } catch (e) {}
  // 上面两条都要求"有 class 提示"或"文本形状是 N/M"。但站点普遍用裸 span/div 放
  // 这一组的说明文案（格式要求、隐私承诺、快捷提示……），既没有 class 可依，形状也
  // 未必是计数 —— 于是语义树里完全看不见：isPureLayout 剪掉裸 div/span 是为了压
  // token 体积，那个取舍本身没错，但代价是 agent 只能靠 ui.evaluate 兜底才能读到。
  //
  // 收窄条件：只收"和表单控件待在同一个紧凑容器里"的短叶子文本。同一个父容器是
  // **结构关系**，不是"离得近"这种位置猜测（项目对位置猜测有明确禁令）；再要求
  // 容器元素数很少，避免顺着 body 把整页文本灌进来。字段自己的 label 文案跳过 ——
  // 那部分语义树已经有了，重复会挤占名额。仍然只进 context，主树一个节点都不加。
  try {
    var ctrls = document.querySelectorAll("input:not([type=hidden]),textarea,select");
    for (var ci3 = 0; ci3 < ctrls.length && topHints.length < 60; ci3++) {
      var fbox = ctrls[ci3].parentElement;
      if (!fbox || fbox === document.body || fbox === document.documentElement) continue;
      if (fbox.querySelectorAll("*").length > 24) continue;   // 只认紧凑的字段组
      var labs = fbox.querySelectorAll("label");
      var labTexts = [];
      for (var la = 0; la < labs.length; la++) labTexts.push((labs[la].textContent || "").trim());
      var fleaves = fbox.querySelectorAll("span,div,small,em,i,b,strong,p,li");
      for (var fli = 0; fli < fleaves.length && topHints.length < 60; fli++) {
        if (fleaves[fli].children && fleaves[fli].children.length) continue;
        var fht = textOf(fleaves[fli]);
        if (!fht || fht.length < 2 || fht.length > 60) continue;
        if (!/[一-龥A-Za-z0-9]/.test(fht)) continue;          // 纯符号（*、：、—）没有信息量
        if (labTexts.indexOf(fht) >= 0) continue;             // 字段自己的文案，树里已经有了
        if (topHints.indexOf(fht) < 0) topHints.push(fht);
      }
    }
  } catch (e) {}

  // ---- 必填提示（整文档，落顶层）----
  // 这些扫描原先全部写在 modal 循环里，于是"红星能否被读到"取决于它所在容器的 class
  // 里有没有 modal/dialog/popup/drawer/overlay/mask 关键词。报错扫描早已改成整文档 +
  // 顶层，必填扫描只是漏迁；这里应用同一范式，弹窗里那份删掉（它是前者的子集，留着
  // 就是两份会漂移的实现）。
  //
  // 这是**启发式补充**，不是权威判定：字段到底必填不必填看 fields[].required（原生
  // required / aria-required，那是承诺）。这里抓的是"只用红星标注、什么都不写"的站点。
  //
  // 刻意不收字数上限 N/M 和「字数」提示：那不是必填标记，而且 hints 已经收过了
  // （形状扫描 + 紧凑容器扫描两条路）。老代码在 modal 容器里顺带收了它们，搬到整文档
  // 之后这个顺手就变成了噪声 —— 实测编辑器页（一个表单控件都没有）会报出
  // ["字数统计测试","字数 6/256","6/256"]，agent 会以为这页有必填项。按字段名办事。
  function scanRequiredHints() {
    var out = [];
    var push = function (t) {
      t = (t || "").trim();
      // 纯符号（*、＊、：）没有信息量：红星本身不说明"哪个字段必填"，说明它的是
      // 它所在的那行文案（由下面的信号 4 收）。老代码把 .req-star 的 textContent
      // 原样推进来，于是数组里永远躺一个孤零零的 "*"。
      if (!/[一-龥A-Za-z0-9]/.test(t)) return;
      if (t.length < 50 && out.indexOf(t) < 0 && out.length < 40) out.push(t);
    };
    // 1) CSS 必填标记
    var reqEls = document.querySelectorAll("[class*=required],[class*=req],[class*=mandatory],[class*=asterisk]");
    for (var rq = 0; rq < reqEls.length; rq++) push(reqEls[rq].textContent);
    // 2) 中文提示（"请填写""请选择"——这是真的在要求 agent 填东西）
    var rhm = (document.body ? (document.body.innerText || "") : "").match(/请\s*[选择填写输入].{0,20}/g);
    if (rhm) for (var rh = 0; rh < rhm.length; rh++) push(rhm[rh]);
    // 3) 红星字符（含全角）→ 收它所在那一行的文案，红星本身没有信息量
    var rstars = document.querySelectorAll("span,em,i,label,sup");
    for (var rs = 0; rs < rstars.length; rs++) {
      var rst = (rstars[rs].textContent || "").trim();
      if (rst === "*" || rst === "＊" || rst === "✱") {
        var rsp = rstars[rs].parentElement;
        if (rsp) push((rsp.textContent || "").slice(0, 30).replace(/\*/g, ""));
      }
    }
    // 5) ::before 伪元素红星。getComputedStyle 不便宜，所以：候选集按标签收窄
    //    （红星伪元素只可能落在这些标签上），宿主必须带短文本，且按**实际发起的
    //    样式查询次数**设上限。老代码按"找到了几个"计数，等于没有上限。
    var rcand = document.querySelectorAll("label,span,div,p,em,i,sup,b,strong,small,td,th");
    var rchecked = 0;
    for (var ra = 0; ra < rcand.length && rchecked < 200 && out.length < 40; ra++) {
      var rel = rcand[ra];
      var rown = (rel.textContent || "").trim();
      if (!rown || rown.length > 30) continue;
      rchecked++;
      try {
        var rbefore = window.getComputedStyle(rel, "::before");
        var rcontent = rbefore.getPropertyValue("content");
        if (!rcontent || rcontent === "none" || rcontent === "normal" ||
            rcontent === '""' || rcontent === "''") continue;
        var rcolor = rbefore.getPropertyValue("color");
        if (rcolor && (rcolor.indexOf("rgb(255") >= 0 || rcolor.indexOf("red") >= 0 ||
            rcolor.indexOf("#f") >= 0 || rcolor.indexOf("#F") >= 0 || rcolor.indexOf("#e") >= 0)) {
          push(rown);
        }
      } catch (e) {}
    }
    // 6) 占位符直接写着"请输入/请填写/必填"的字段。站点既没有 required 属性、
    //    也没有红星时，这是唯一读得到的"这里要填东西"的信号（B站图文的标题框
    //    就是这样：placeholder="请输入标题（建议30字以内）"，无 required、无红星，
    //    于是 agent 只能从"发布没反应"倒推）。
    //    仍然只进 required_hints（启发式桶），不进 nodes.states —— 它不构成承诺。
    try {
      var phEls = document.querySelectorAll("input[placeholder],textarea[placeholder],[contenteditable][data-placeholder]");
      for (var ph = 0; ph < phEls.length && out.length < 40; ph++) {
        var pht = phEls[ph].getAttribute("placeholder") || phEls[ph].getAttribute("data-placeholder");
        if (pht && /请\s*(输入|填写|选择)|必填|必选|不能为空/.test(pht)) push(pht);
      }
    } catch (e) {}
    return out;
  }
  var requiredHints = scanRequiredHints();

  // ---- validation_errors（P2-2）------------------------------------------
  // "哪个字段被页面判错了、错在哪儿" 之前只能是两片碎片：context.errors 是
  // 一堆不知道归属的文案，context.field_errors 要求错误元素能被 fieldOf 关联上。
  // 掘金的行内错误"至少添加一个标签"既不在 modals 里、也没有 aria-invalid，
  // 于是 agent 提交了、页面拒绝了、而回执里什么都没有 —— 这正是 1.2 次事故的
  // 全部条件。这里给出结构化的一条：[{ text, near }]，near 是字段的定位串。
  //
  // near 的取值顺序与 context.fields[].id 一致，方便两边对照；关联不上字段时
  // near 为空串，而不是猜一个"最近的输入框"（位置猜测一直是本项目明令禁止的）。
  function locatorOf(el) {
    if (!el) return "";
    return el.id || el.name || el.getAttribute("aria-label") || el.placeholder ||
      (el.tagName || "").toLowerCase();
  }
  var validationErrors = [];
  var seenVE = {};
  function pushVE(text, near) {
    var t2 = (text || "").trim();
    if (!t2) return;
    if (t2.length > 120) t2 = t2.slice(0, 120);
    var key = (near || "") + "\u0000" + t2;
    if (seenVE[key]) return;
    if (validationErrors.length >= 30) return;
    seenVE[key] = 1;
    validationErrors.push({ text: t2, near: near || "" });
  }
  // 1) 页面明说"这个控件无效"（aria-invalid=true/grammar/spelling）—— 最强信号。
  //    即使拿不到错误文案，字段本身也已经通过 node.states 的 invalid 暴露了。
  try {
    var invEls = document.querySelectorAll(
      '[aria-invalid="true"],[aria-invalid=grammar],[aria-invalid=spelling]');
    for (var ivi = 0; ivi < invEls.length && ivi < 40; ivi++) {
      pushVE(fieldErrorOf(invEls[ivi]) || "", locatorOf(invEls[ivi]));
    }
  } catch (e) {}
  // 2) 已经能对上字段的错误文案（fieldErrors 是同一批 DOM 的结论，换形状给调用方）
  for (var vei = 0; vei < fieldErrors.length; vei++) {
    pushVE(fieldErrors[vei].text, fieldErrors[vei].field);
  }

  // SESSION / AUTH WALL — 见 src/shared/auth_wall.cjs 顶部的事故注释。
  // 旧实现在这里犯过两个错，都已修正：
  //   1. document.cookie.indexOf("token") >= 0 —— CSDN 未登录时 cookie 里有
  //      csrfToken，子串命中，于是 logged_in 被判成 true（主动谎报）；
  //   2. bodyText.length > 1000 也算登录证据 —— CSDN 登录页正文远超 1000 字。
  // 现在 cookie 按名字判（csrf 类显式排除），并且新增顶层 auth_wall 硬信号。
  // 密码框必须**可见才算**。旧实现是裸 querySelector：CSDN 文章页常驻一个
  // display:none 的登录表单（视觉隐藏但 DOM 在），于是每篇文章页都被误报成
  // "登录墙"—— 一个把已登录工作页说成登录墙的信号，比没有信号更糟：它会
  // 让调用方在正确页面上停下"重新登录"，或干脆不信任这个字段。
  // 判定与 ui.screenshot 的密码框探测同一口径：有尺寸 + 不在隐藏祖先链上。
  var hasPwdInput = false;
  try {
    var pwdEls = document.querySelectorAll("input[type=password]");
    for (var pi = 0; pi < pwdEls.length; pi++) {
      var pe = pwdEls[pi];
      var pr = pe.getBoundingClientRect ? pe.getBoundingClientRect() : { width: 0, height: 0 };
      if (!(pr.width > 0 && pr.height > 0)) continue;
      var pHidden = false;
      var pp = pe.parentElement;
      while (pp && pp !== document.body) {
        var pst = window.getComputedStyle(pp);
        if (pst && (pst.display === "none" || pst.visibility === "hidden")) { pHidden = true; break; }
        if (pp.hidden === true || pp.getAttribute("aria-hidden") === "true") { pHidden = true; break; }
        pp = pp.parentElement;
      }
      if (!pHidden) { hasPwdInput = true; break; }
    }
  } catch (ePwd) { /* 探测失败按"没有密码框"处理：宁可漏报也不要误报登录墙 */ }
  var hasAvatar = !!document.querySelector("[class*=avatar],img[class*=avatar],img[class*=user]");
  var authWall = authWallLib.detectAuthWall({
    url: document.URL,
    hasPasswordInput: hasPwdInput,
  });
  var login = authWallLib.looksLoggedIn({
    url: document.URL,
    hasPasswordInput: hasPwdInput,
    hasAvatar: hasAvatar,
    cookieString: readCookieSafely(),
  });

  return {
    title: document.title,
    url: document.URL,
    // 登录墙硬信号。detected=true 时，任何"操作怎么没生效"的排查都该先停下：
    // 当前 tab 大概率不在目标站点的工作页，而在它的登录页。
    // reason: 'auth_host' | 'login_path' | 'password_field'；matched 是命中的那一段。
    auth_wall: authWall.detected
      ? { detected: true, reason: authWall.reason, matched: authWall.matched, url: document.URL }
      : null,
    forms: formList.length ? formList : null,
    modals: modals.length ? modals : null,
    // 顶层报错/提示/必填：都不依赖容器 class 是否含 modal 关键词，普通页面也能读到。
    // errors —— 全文档扫描到的可见错误文案；field_errors —— 能对应到具体输入
    // 框的那些（{field, text}）；hints —— 字数/提示/轻通知类辅助文案；
    // required_hints —— 必填标记（红星/CSS 标记/「请填写」类文案），启发式补充，
    // 权威判定看 fields[].required。
    errors: topErrors.length ? topErrors : null,
    field_errors: fieldErrors.length ? fieldErrors : null,
    // validation_errors —— [{text, near}]：字段级校验结论，near 是该字段的定位串
    // （id/name/aria-label/placeholder）。与 field_errors 的区别：这里包含
    // aria-invalid 标记但文案缺失的控件（text 为空串时只在 states 里体现，不占条目）。
    validation_errors: validationErrors.length ? validationErrors : null,
    hints: topHints.length ? topHints : null,
    required_hints: requiredHints.length ? requiredHints : null,
    session: { logged_in: login.logged_in, evidence: login.evidence },
    // 跨进程子帧（OOPIF）汇总。count>0 意味着"页面有一块内容，默认 DOM
    // 通路读不到"——调用方该切 AX 读法（ax:true）。suggestion 里带通路名。
    // 事故背景：B站图文编辑器正文在 OOPIF 里，此前树里连占位都没有，
    // agent 得出"编辑器没加载"的错误结论。
    cross_process_frames: frameProbe.summarizeOpaqueFrames(collectOpaqueFrames()),
    stats: {
      inputs: document.querySelectorAll("input:not([type=hidden])").length,
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a[href]").length,
      // 没有 href 的锚点（onclick / JS 驱动）。它们仍然是可点目标，而 a[href]
      // 数不到 —— 超星泛雅的章节条目就是这一类。只报 links 会让人以为这页
      // 一个链接都没有（实测该页 links=2、links_without_href=6）。
      links_without_href: (function() {
        try { return document.querySelectorAll("a:not([href])").length; } catch(e) { return 0; }
      })(),
      iframes: document.querySelectorAll("iframe").length,
      // 页面**看得见的文字**总量 —— 文字覆盖率的分母（见 shared/doc_coverage.js）。
      // 用 innerText 而不是 textContent：前者是浏览器算出来的"渲染后可见文字"，
      // display:none / 折叠 / visibility:hidden 都不算。
      // 只数**非空白字符**：innerText 会把结构分隔符也吐出来（表格里的 \t、
      // 段落间的 \n），而分子（label）没有这些。实测一张 8×4 表格因此虚低到 68%，
      // 实际每个单元格都在。两边同一把尺子，这个数字才有意义。
      text_chars: (function() {
        try {
          var t = document.body && document.body.innerText;
          if (!t) return 0;
          var m = String(t).match(/[^\s\u00a0]/g);
          return m ? m.length : 0;
        } catch(e) { return 0; }
      })(),
      // 同源子帧里的可见文字。**必须单独算、并进分母**：抽取器会走进同源
      // iframe（见 winOf 的注释），所以树里有它们的文字，但
      // `document.body.innerText` 不会下钻到 iframe（iframe 是替换元素）。
      // 2026-10-19 实测：主文档 21 字 + 同源子帧 330 字，分子 83、分母 20，
      // 比例 4.15 被钳到 100% —— 一个 24% 的页面被报成"全读到了"。
      // 比例大于 1 从来不是"读得特别好"，是**分母漏了一块**。
      same_origin_chars: (function() {
        var total = 0;
        try {
          var frames = document.querySelectorAll("iframe");
          for (var i = 0; i < frames.length; i++) {
            var doc = null;
            try { doc = frames[i].contentDocument; } catch(e) { doc = null; }
            if (!doc || !doc.body) continue;   // 跨进程帧拿不到 contentDocument
            try {
              var t = doc.body.innerText;
              // 与 text_chars 同一把尺子：只数非空白字符
              if (t) { var m = String(t).match(/[^\s\u00a0]/g); total += m ? m.length : 0; }
            } catch(e) {}
          }
        } catch(e) {}
        return total;
      })(),
      // canvas 数量。innerText 永远看不见画在画布上的字，所以这类页面的
      // 文字覆盖率**不可度量** —— 报 100% 是彻头彻尾的谎报（实测：一个只画
      // 了 12 行字的 canvas 页，分母 4 字、报 100%）。有它才能说"量不了"。
      canvases: (function() {
        try { return document.querySelectorAll("canvas").length; } catch(e) { return 0; }
      })(),
      // open shadow root 里的文字。
      //
      // 为什么必须算：抽取器会下探 shadowRoot（见 childrenOf 的注释），所以
      // **树里有 shadow 内容**；但 `body.innerText` 不穿过 shadow 边界 ——
      // 分母里没有。实测一个 shadow 页：树里 35 字、分母只有 8 字 → 比例 4.4
      // → over_measured，看起来像"分子在重复计数"，实际是分母漏了一个表面。
      //
      // 这里用 textContent 而不是 innerText，原因很实在：拿不到某个 shadow root
      // 的"渲染后文本"（host.innerText 不含 shadow 内容，逐个元素算 innerText
      // 要遍历整棵影子树并触发布局）。所以这是**已知偏保守**的一侧：shadow 里
      // 被 display:none 藏掉的文字也会被算进分母，让覆盖率略微偏低。
      // 偏低的方向是安全的 —— 它只会让"读不全"更容易被发现，不会掩盖。
      shadow_chars: (function() {
        var total = 0;
        try {
          var all = document.querySelectorAll("*");
          for (var i = 0; i < all.length; i++) {
            var sr = all[i].shadowRoot;
            if (!sr) continue;
            try {
              var t = sr.textContent;
              if (t) total += String(t).replace(/[\s\u00a0]+/g, "").length;
            } catch(e) {}
          }
        } catch(e) {}
        return total;
      })()
    }
  };
}

module.exports = { extractTree, extractPageContext };
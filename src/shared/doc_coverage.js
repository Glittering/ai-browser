// src/shared/doc_coverage.js — 「这棵树读到了多少页面文字」的度量
//
// ============ 为什么要有它 ============
// 2026-10-19 的泛雅事故里，默认语义树 27 个节点、13 个可操作，而整门课的章节
// 列表一个字都不在树里。当时没有任何一个数字能表达这件事：调用方看到的是
// "merged / frames_read:1"，以及 capabilities 的一句"the UI is largely
// canvas-rendered"。**"读到了"从来不是一个可测量的结论。**
//
// 同一个仓库里已经有这个纪律，只是只覆盖了一半：tools/coverage_probe.cjs 数
// "人看着能点的东西有多少进了树"。但它数的是**可点目标**，而且原先只数默认
// 文档。文字呢？没人数。
//
// 这个模块补的就是那个数字：**树里的文字 / 页面上看得见的文字**。
// 分母 = 主文档 innerText 长度 + 每个跨进程帧里可见文字长度（帧那边由
// frame_read_source.stats.text_chars 给，已经算过，不重复付钱）。
//
// ============ 为什么用 innerText ============
// 它是**浏览器自己算出来的"看得见的文字"**：display:none、折叠的、被
// visibility:hidden 藏掉的都不算，换行/空白也按渲染结果归一。用它当分母，
// 比"数 DOM 里的 textContent"更接近人眼看到的东西 —— 也就更接近
// "agent 应该能读到多少"。
//
// 它是纯函数模块（不碰 DOM、不碰 Electron），所以能单测；
// 取 innerText 的那一侧在 preload/extractor.cjs 的 stats.text_chars。

/**
 * 这些角色的 label 是**元数据**，不是页面上渲染出来的文字。
 *
 * 为什么必须排除：分母用 `innerText` 量（浏览器自己算的"看得见的字"），
 * 分子就得用同一把尺子。实测泛雅页面上：
 *   - `<img alt="Logo">` 的 alt 不在 innerText 里；
 *   - `<iframe name="frame_content-zj">` 的 name 更不在 —— 而树的合并逻辑
 *     会给同一个 iframe 建三个描述节点（iframe_body / iframe / Iframe 闸门），
 *     `frame_content-zj` 这 16 个字被数了三遍，凭空多出 32 字。
 * 不排除它们，比例就会溢出到 100% 以上，这个数字就废了（实测 547/185）。
 *
 * 用 role 名单而不是"看有没有 children"：children 数量是树形状的偶然结果，
 * role 才是语义。
 */
const META_ROLES = new Set(['image', 'img', 'iframe', 'iframe_body', 'canvas', 'separator']);

/** 树里所有**正文** label 的字符数。图标的空 label、可编辑框的占位符不算。 */
export function sumLabelChars(tree) {
  let labels = 0;
  let nodes = 0;
  let chars = 0;

  // 累加规则：**先算后代，后代有字就以后代为准**。
  //
  // 为什么不是"把所有 label 加起来"：DOM 抽取器会给容器节点也写 label，而且
  // 那 label 就是它里面的全部文字（`<div>课程门户 链接</div>`）。全加一遍等于
  // 同一句话数了三次 —— 实测泛雅页 tree_chars 547 vs 页面 185，覆盖率直接
  // 溢出到 100%，这个数字就废了。
  //
  // 为什么不是"只数叶子"：图标链接 `<a>课程门户<i/></a>` 有子节点（空的 i），
  // 按叶子算会把它的文字丢掉 —— 那正是"少算"，同样会让数字失真。
  //
  // 所以：有字的后代优先；后代一个字都没有时，才认这个节点自己的 label。
  function measure(n) {
    if (!n) return 0;
    nodes += 1;
    let kidsChars = 0;
    for (const c of n.children || []) kidsChars += measure(c);
    // 可编辑节点的 label 是 placeholder / value，不是页面正文：
    // innerText 里没有它们，算进分子会让覆盖率虚高（一个带 placeholder 的
    // 搜索框就能把 0% 抬到 20%）。
    const role = typeof n.role === 'string' ? n.role.toLowerCase() : '';
    const own = (n.editor_type || META_ROLES.has(role))
      ? 0
      : (typeof n.label === 'string' ? n.label.length : 0);
    if (kidsChars > 0) return kidsChars;   // 后代有字：以它们为准，容器不再加一遍
    if (own) labels += 1;                  // 这个节点是这段文字的唯一来源
    return own;
  }

  chars = measure(tree);
  return { chars, labels, nodes };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * 页面级文字覆盖率。
 *
 * @param {{treeChars:number, mainChars:number, frameChars:number}} input
 * @returns {{tree_chars:number, page_chars:number, main_chars:number, frame_chars:number,
 *            ratio:number|null, percent:number|null, hint:string|null}}
 */
export function pageCoverage(input) {
  const o = input && typeof input === 'object' ? input : {};
  const tree = Math.max(0, Number(o.treeChars) || 0);
  const main = Math.max(0, Number(o.mainChars) || 0);
  const frame = Math.max(0, Number(o.frameChars) || 0);
  const page = main + frame;
  const base = {
    tree_chars: tree,
    page_chars: page,
    main_chars: main,
    frame_chars: frame,
    ratio: null,
    percent: null,
    hint: null,
  };
  // 页面一个字都没有（空标签页、纯 canvas、还没渲染）→ 不报覆盖率。
  // 报 0 会被读成"我们没读到"，而事实是"没有可读的文字"。两种情况必须分开。
  if (page <= 0) return base;
  const ratio = clamp01(tree / page);
  base.ratio = Math.round(ratio * 1000) / 1000;
  base.percent = Math.round(ratio * 100);
  base.hint = coverageHint(base);
  return base;
}

/**
 * 低于这个比例才给提示。0.5 不是"合格线"，是"再低就不像读过了"：
 * 正常页面上树会覆盖大部分可见文字（按钮/链接/段落都在），掉到一半以下
 * 基本意味着有一整块内容走的是我们看不见的通路。
 */
export const LOW_COVERAGE = 0.5;

/**
 * 至少漏掉这么多**字**才值得提示。
 *
 * 为什么闸门设在"漏了多少"而不是"页面多大"：
 * 最初这里写的是 `page_chars < 200 → 不提示`，理由是"一句话的页面也能 100%"。
 * 但用泛雅页一验就发现这是错的 —— 那张页面 `innerText` 只有 185 字，
 * 而它最有价值的内容（6 个章节标题）正好是其中 160 字。修前的树只读到 25 字，
 * 覆盖率 13.5%，却因为 185 < 200 被这条闸门**静音**了。
 * 也就是说：这个指标是为了泛雅那类"看起来内容不多、但其实全都在一句里"的
 * 页面建的，而闸门恰好把这类页面全排除了。
 *
 * 改成看绝对值就对了：漏 160 字是事实，跟页面总共多少字无关。
 * 而"一句话的页面报 100%"这个担心由 missing≈0 自然消掉，不需要页面大小来兜。
 */
export const MIN_MISSING_CHARS = 20;

function coverageHint(c) {
  if (c.ratio === null || c.ratio >= LOW_COVERAGE) return null;
  const missing = Math.max(0, c.page_chars - c.tree_chars);
  if (missing < MIN_MISSING_CHARS) return null;
  // 归因要挂在数字上，不能靠猜。帧里有多少字是**实测**的（frame_read_source），
  // 所以这里能分辨"文字在跨进程帧里"和"文字在主文档里但没进树"。
  if (c.frame_chars > 0 && c.frame_chars >= missing * 0.6) {
    return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars); ${c.frame_chars} of the missing ${missing} chars are inside cross-process frame(s) — read context.frame_hints.frames[].src, or get_tree {ax:true}`;
  }
  if (c.main_chars > 0 && c.main_chars >= missing * 0.6) {
    return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars) and most of the gap is in the main document — a long body of plain text is the usual cause (the DOM tree keeps structure, the AX tree keeps text). Try get_tree {ax:true} before concluding the content is invisible; if AX is also low, the page may still be rendering, or the content sits in shadow DOM / a virtualized list`;
  }
  return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars) — the gap is split between the main document and cross-process frames; check context.frame_hints first`;
}

export default { sumLabelChars, pageCoverage, LOW_COVERAGE, MIN_MISSING_CHARS };

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

/**
 * 这些 label **不是页面上渲染出来的文字**，而是可访问名：aria-label / alt /
 * title / placeholder / input 的 value。抽取器给它们标了 label_kind。
 *
 * 为什么必须排除：分母是 innerText，里面根本没有这些字。实测 /basic.html ——
 * `<input placeholder="随便填">` 让分子 46 大于分母 43，页面明明只有 43 字却报 100%。
 * 真实站点上每个图标按钮都挂 aria-label，虚高是系统性的，不是零点几个百分点。
 * （节点本身照旧带 label —— agent 需要它来认识"这个按钮是干什么的"，只是不算进覆盖率。）
 */
const isNonRenderedLabel = (n) => !!(n.label_kind && n.label_kind !== 'text');

/**
 * 只数**非空白字符**。
 *
 * 为什么：分母来自 `innerText`，它会把结构分隔符也吐出来 —— 一个 32 格表格的
 * innerText 里夹着 30 多个 `\t` / `\n`，而分子（label）没有这些。
 * 实测一张 8×4 的表格：page 80 字、tree 54 字 → 覆盖率 68%，看起来"少读了三分之一"，
 * 实际每个单元格的文字都在，少的是**空格**。
 * 中文页面几乎不吃这个亏，英文页面按词空格能虚低 15%，表格页面能虚低 40%。
 * 同一把尺子量两边，这类结构性误差才会消失。
 */
const countChars = (s) => {
  if (!s) return 0;
  const m = String(s).match(/[^\s\u00a0]/g);
  return m ? m.length : 0;
};

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
    const own = (n.editor_type || isNonRenderedLabel(n) || META_ROLES.has(role)) ? 0 : countChars(n.label);
    if (kidsChars > 0) return kidsChars;   // 后代有字：以它们为准，容器不再加一遍
    if (own) labels += 1;                  // 这个节点是这段文字的唯一来源
    return own;
  }

  chars = measure(tree);
  return { chars, labels, nodes };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * 分子超过分母这么多，就不是"读得好"，是**分母漏了一块**。
 *
 * 为什么要留这个判据：这个指标的第一版就在这里撒过谎。泛雅页分子 547、分母 185，
 * 我当时的处理是钳到 1、当没事发生。可"分子大于分母"本身就是一个**测量结论**：
 * 树里数出来的字比页面上能看见的还多，只可能是分母少统计了一个承载文字的
 * 表面（同源子帧 / shadow DOM / canvas），或者是分子在重复计数。
 * 钳掉之后，100% 这个数字看起来最健康，恰好把问题藏得最深。
 */
export const OVER_MEASURED = 1.2;

/**
 * 页面级文字覆盖率。
 *
 * @param {{treeChars:number, mainChars:number, sameOriginChars?:number,
 *          frameChars:number, canvases?:number, ax?:boolean}} input
 *        ax:true 表示这是 AX 树（label 是可访问名，不是渲染文字），
 *        超过 100% 不算异常，见下面 over 分支。
 * @returns {{tree_chars:number, page_chars:number, main_chars:number, frame_chars:number,
 *            same_origin_chars:number, ratio:number|null, percent:number|null,
 *            hint:string|null, unmeasurable?:string, over_measured?:boolean,
 *            names_exceed_text?:boolean}}
 */
export function pageCoverage(input) {
  const o = input && typeof input === 'object' ? input : {};
  const tree = Math.max(0, Number(o.treeChars) || 0);
  const main = Math.max(0, Number(o.mainChars) || 0);
  const sameOrigin = Math.max(0, Number(o.sameOriginChars) || 0);
  const shadow = Math.max(0, Number(o.shadowChars) || 0);
  const frame = Math.max(0, Number(o.frameChars) || 0);
  const canvases = Math.max(0, Number(o.canvases) || 0);
  // 分母 = 分子会走到的每一个表面：主文档 + 同源子帧 + open shadow root + 跨进程帧。
  // 少算任何一块，比例就虚高 —— 而同源子帧和 shadow DOM 是最容易漏的两块：
  // `body.innerText` 既不下钻 iframe，也不穿过 shadow 边界，抽取器却两头都会走。
  // 实测 shadow 页：树里 35 字、分母只有 8 字 → over_measured。
  const page = main + sameOrigin + shadow + frame;
  const base = {
    tree_chars: tree,
    page_chars: page,
    main_chars: main,
    frame_chars: frame,
    same_origin_chars: sameOrigin,
    shadow_chars: shadow,
    ratio: null,
    percent: null,
    hint: null,
  };
  // 页面一个字都没有（空标签页、还没渲染）→ 不报覆盖率。
  // 报 0 会被读成"我们没读到"，而事实是"没有可读的文字"。两种情况必须分开。
  if (page <= 0) {
    if (canvases > 0) {
      return { ...base, unmeasurable: 'canvas', hint: CANVAS_HINT };
    }
    return base;
  }
  // canvas 画的字永远不在 innerText 里，所以这类页面的"文字覆盖率"没有分母。
  // 与其拿页面上那 4 个字的 HUD 文案算出一个 100%，不如直接说量不了。
  if (canvases > 0 && page < 200) {
    return { ...base, unmeasurable: 'canvas', hint: CANVAS_HINT };
  }

  const raw = tree / page;
  const over = raw > OVER_MEASURED;
  const ratio = clamp01(raw);
  base.ratio = Math.round(ratio * 1000) / 1000;
  base.percent = Math.round(ratio * 100);
  if (over) {
    // AX 树的 label 是**可访问名**，天生包含 aria-label / alt / title 这些
    // 不属于 innerText 的字。所以 AX 读数超过 100% 是设计使然，不是"分母漏了表面"。
    // 实测 知乎首页：DOM 346/443、AX 542/443 —— 那 99 个字是 18 个图标按钮的
    // aria-label，一个字都没漏。这种情况不能报 over_measured（那是给 DOM 树用的
    // 报警器，报了就是每张真实页面都报警，警报就废了），但也不许装作没发生：
    // 记一个 names_exceed_text 让调用方知道"这个 100% 是钳出来的"。
    if (o.ax) {
      base.names_exceed_text = true;
      return base;
    }
    base.over_measured = true;
    base.hint = `the tree carries ${tree} chars but this page only has ${page} measurable visible chars `
      + `(${main} main + ${sameOrigin} same-origin iframe + ${shadow} shadow DOM + ${frame} cross-process frame) — `
      + 'the numerator is larger than the denominator, so the denominator is missing a surface '
      + '(text inside shadow DOM, or a frame we could not measure). Treat this page\'s coverage as unknown, '
      + 'not as 100%: read with get_tree {ax:true} and judge by the content';
    return base;
  }
  base.hint = coverageHint(base);
  return base;
}

const CANVAS_HINT = 'this page draws on a <canvas>, so its text is invisible to innerText and text coverage '
  + 'cannot be measured — a percentage here would be meaningless. Use ui.screenshot to see it, '
  + 'ui.canvas_read to get the pixels, or context.route in ui.capabilities to pick a read layer';

/**
 * 低于这个比例才给提示。
 *
 * 0.5 是错的，实测被抓了三次（e2e/readcov_ws.cjs 第一次跑就三条一起红）：
 *   · /long.html     70% —— 60 段正文全在树里，但每段 label 被裁到 60 字
 *   · /xorigin-frame 59% —— 帧合并了，帧里的段落同样被裁
 *   · /sr-only       27% —— 移出视口的 span 没有独立节点
 * 这三张页面**都在静默地少读**（27% 是最刺眼的那种：页面 22 字，agent 只看到 6 字），
 * 而闸门 0.5 让前两张一声不响。也就是说这个闸门对"读了一半"这种最常见、
 * 也最容易误导人的状态恰好是聋的。
 *
 * 判据只能是**不变量本身**：读不到 90% 就该说一句。提示是一句话，多给一次的
 * 成本远低于"agent 以为读完了"的成本。
 */
export const LOW_COVERAGE = 0.9;

/**
 * 绝对缺口的下限（字）。只负责"别为一两个字打扰调用方"，不负责判断严重程度 ——
 * 严重程度由比例闸门说。
 *
 * 这个数字的历史：最初是 `page_chars < 200 → 不提示`（把泛雅 185 字自己排除了），
 * 后来是 20（把 /sr-only.html 的 73% 缺口静音了），现在 5。详见 missingEnough。
 */
export const MIN_MISSING_CHARS = 5;

/**
 * 这个页面"漏够了没有"。
 *
 * 这里换过三版判据，每一版都是被实测推翻的：
 *   1. `page_chars < 200 → 静音`：把泛雅（185 字）自己排除了。
 *   2. `缺 ≥ 20 字`：把 /sr-only.html（22 字页面漏 16 字，漏 73%）静音了。
 *   3. 现在：比例闸门已经抬到 0.9，缺口天然是成比例的；绝对值只留一个
 *      "别为一两个字打扰调用方"的下限。
 *
 * 0.9 这条闸门意味着"漏 10% 以上就要说话"，所以 20 这个绝对门槛是重复保险，
 * 而它在小页面上反而成了静音器。留着 5：一个词以下的缺口，说什么都没用。
 */
function missingEnough(missing) {
  return missing >= MIN_MISSING_CHARS;
}

function coverageHint(c) {
  if (c.ratio === null || c.ratio >= LOW_COVERAGE) return null;
  const missing = Math.max(0, c.page_chars - c.tree_chars);
  if (!missingEnough(missing)) return null;
  // 归因要挂在数字上，不能靠猜。帧里有多少字是**实测**的（frame_read_source），
  // 所以这里能分辨"文字在跨进程帧里"和"文字在主文档里但没进树"。
  //
  // 帧这一支**不许**推荐 ax:true：AX 树对子帧的内容同样走 frame_read_source
  // 的合并通路（实测 /same-frame AX 也只能到 55%），指过去等于把人指进死胡同。
  // 帧里文字的可靠读法是 frame_ref / 帧地址。
  if (c.frame_chars > 0 && c.frame_chars >= missing * 0.6) {
    return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars); `
      + `${c.frame_chars} of the missing ${missing} chars are inside cross-process frame(s). `
      + 'Frame bodies are merged as a preview (each block clipped), so read them directly: '
      + 'ui.evaluate {frame_ref:"frame-1", expr:"document.body.innerText"} — the frame refs and absolute '
      + 'src are in context.frame_hints.frames';
  }
  if (c.main_chars > 0 && c.main_chars >= missing * 0.6) {
    return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars) and most of the gap is in the main document — the DOM tree keeps structure and clips each block's text, the AX tree keeps the full text. Try get_tree {ax:true} before concluding the content is invisible; if AX is also low, the page may still be rendering, or the content sits in shadow DOM / a virtualized list`;
  }
  return `the tree carries ${c.percent}% of this page's visible text (${c.tree_chars}/${c.page_chars} chars) — the gap is split between the main document and cross-process frames; check context.frame_hints first, and use frame_ref for the frames`;
}

export default { sumLabelChars, pageCoverage, LOW_COVERAGE, MIN_MISSING_CHARS, OVER_MEASURED };

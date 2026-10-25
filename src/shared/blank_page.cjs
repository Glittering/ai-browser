// shared/blank_page.cjs — "这一页到底画出来没有"的判定口径（纯函数）。
//
// 事故（2026-10-25，用户报"打开了百度有时候是纯白屏"）：
//   页面加载事件全都到了（did-finish-load / readyState=complete）、DOM 里有内容、
//   agent 通过 ui.evaluate 也能读到文字，但**用户看到的那块区域是纯白的**。
//   这类白屏此前没有任何检测手段：
//     - did-fail-load 只覆盖"网络失败"，不覆盖"画布是空的"；
//     - chrome-error:// 的错误页覆盖"连接失败"，也不覆盖这个；
//     - capturePage / CDP 截图**不测**它 —— 它们走 view 自己的 surface，
//       视图内部画得好好的，白的是窗口那一层。
//   结果就是"用户说白屏，工具说一切正常"，双方都拿不出证据。
//
// 这份模块只做一件事：给一张**位图**和一份**DOM 事实**，回答
//   "它是不是白的？白是因为这页本来就空，还是因为它该有内容却没画出来？"
// 判定与"怎么修"分开：修有副作用（reload 会丢掉页面里的临时状态），
// 所以由 decidePaintAction 单独决定，且**有上限**（见下）。
//
// 为什么白度 + 唯一色两个指标都要：
//   - 只用白度：百度首页本身 90%+ 是白的，会天天误报；
//   - 只用唯一色：深色加载页只有 400 多种颜色，也会误报成"空白"。
//   两个一起看才分得清"内容页（白底但有正文/图标 → 唯一色几千）"和
//   "真的什么都没画（纯白 → 唯一色个位数）"。

'use strict';

// 位图格式：Electron 的 nativeImage.toBitmap() 给的是 BGRA（4 字节/像素，
// 从上到下、无 padding）。这里不假设调用方用什么解码，只要求同一约定。
const BPP = 4;

// 阈值定了两个数，都有实测依据（2026-10-25，1280x800 窗口、2x 屏）：
//   - 真实页面：百度首页 90–93% 白 / 3.9k–6.1k 唯一色；
//     纯白故障帧：99–100% 白 / 3–25 唯一色（抗锯齿边缘也会贡献几个色阶）；
//   - 深色页面（我们的 loading.html）：0% 白 / 400+ 唯一色。
// 取 white ≥ 99% 且 unique ≤ 32：两侧都留了余量，既不会把"白底文章页"算进来
// （它的唯一色必然上千），也不会因为一个圆角边框的四个渐变色就漏掉真白屏。
const WHITE_MIN_RATIO = 0.99;
const WHITE_PIXEL = 250;   // 单通道 ≥ 250 算"白"（250 而不是 255：留点压缩/缩放余量）
const UNIQUE_MAX = 32;

/**
 * 统计位图的白度与唯一色数。
 * @param {Buffer|Uint8Array} bitmap BGRA 位图
 * @returns {{total:number, white:number, white_ratio:number, unique:number}}
 */
function statsFromBitmap(bitmap) {
  if (!bitmap || !bitmap.length) {
    return { total: 0, white: 0, white_ratio: 0, unique: 0 };
  }
  const total = Math.floor(bitmap.length / BPP);
  let white = 0;
  // 唯一色用 Set 存打包后的 24 位整数。纯白图只有 1–3 个元素，正常页面几千个。
  // 数过 UNIQUE_MAX 就不再往 Set 里塞（内存有界），但白色像素要继续数到最后一个 ——
  // 提前 break 会让 white_ratio 变成"扫过的部分"的比例，回执里的数字就成了假话。
  const seen = new Set();
  let overflow = false;
  for (let i = 0; i + 3 < bitmap.length; i += BPP) {
    const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
    if (r >= WHITE_PIXEL && g >= WHITE_PIXEL && b >= WHITE_PIXEL) white++;
    if (!overflow) {
      seen.add((r << 16) | (g << 8) | b);
      if (seen.size > UNIQUE_MAX) overflow = true;
    }
  }
  return {
    total,
    white,
    white_ratio: total ? white / total : 0,
    // pinned = "颜色数已超过上限，这里只是下限"。回执里要如实标注，
    // 否则一个信息丰富的页面会被显示成"33 种颜色"。
    unique: seen.size,
    unique_pinned: overflow,
  };
}

/**
 * 判定一帧画面。
 *
 * @param {object} p
 * @param {{total:number,white:number,white_ratio:number,unique:number}} p.stats
 * @param {{text_len:number, nodes:number, ready_state:string}} p.dom 页面自述的事实
 * @param {{width:number,height:number}} [p.bounds] 视图当前尺寸
 * @returns {{verdict:string, blank:boolean, reason:string}}
 *
 * verdict：
 *   ok               有内容（正常）
 *   empty-legit      这页本来就是空的（about:blank / 空文档），白是正确结果
 *   not-ready        页面还没到 interactive/complete，白是暂时的，等它
 *   collapsed        视图本身被压成 0 高/0 宽 —— 不是没画，是没地方画
 *   blank-with-text  DOM 里有文字，但屏幕上纯白 —— **真白屏**
 *   blank-with-dom   DOM 有几十个节点却纯白 —— **真白屏**（内容层失败）
 *   scale-mismatch   页面按 A 宽排版、视图只有 B 宽（合成器画了一张陈旧尺寸的
 *                    surface）—— 表现为"内容缩在左上角，其余全白"
 *   no-frame         拿不到位图（视图不可见/被销毁），无法判定
 */
function classifyPaint({ stats, dom, bounds } = {}) {
  const d = dom || {};
  const textLen = Number(d.text_len) || 0;
  const nodes = Number(d.nodes) || 0;
  const ready = String(d.ready_state || '');

  if (bounds && (Number(bounds.width) <= 0 || Number(bounds.height) <= 0)) {
    return { verdict: 'collapsed', blank: true, reason: `view is ${bounds.width}x${bounds.height} — nothing to paint into` };
  }
  if (!stats || !stats.total) {
    return { verdict: 'no-frame', blank: false, reason: 'no bitmap (view not visible or destroyed)' };
  }
  const isWhite = stats.white_ratio >= WHITE_MIN_RATIO && stats.unique <= UNIQUE_MAX;
  const colourDesc = `${stats.unique}${stats.unique_pinned ? '+' : ''} colours`;
  if (ready && ready !== 'interactive' && ready !== 'complete') {
    // 还没就绪时"白"是暂时的，不是缺陷 —— blank 字段仍要如实反映画面。
    return { verdict: 'not-ready', blank: isWhite, reason: `document.readyState = ${ready}` };
  }
  if (!isWhite) {
    return { verdict: 'ok', blank: false, reason: `${Math.round(stats.white_ratio * 100)}% white, ${colourDesc}` };
  }
  // 到这里：屏幕上确实是纯白。白得对不对，只能问 DOM。
  if (textLen === 0 && nodes <= 2) {
    return { verdict: 'empty-legit', blank: false, reason: 'empty document — white is the correct result' };
  }
  if (textLen > 0) {
    return { verdict: 'blank-with-text', blank: true, reason: `${textLen} chars of text in the DOM but the screen is white` };
  }
  return { verdict: 'blank-with-dom', blank: true, reason: `${nodes} DOM nodes but the screen is white` };
}

/**
 * 白屏了该怎么救 —— 阶梯，且有上限。
 *
 * 为什么要有上限：救不动的时候（比如页面 CSS 自己把文字刷成白色），reload 一百次
 * 也还是白。无上限重试会变成一个看不见的循环：CPU 烧着、页面反复重载、
 * 用户看到的仍是白屏，而且没有任何地方说过"我试过了、没用"。
 *
 * @param {{verdict:string, steps:number}} p steps = 已执行过的补救次数
 * @returns {'none'|'repaint'|'reload'|'give-up'}
 */
function decidePaintAction({ verdict, steps = 0 } = {}) {
  // ok / empty-legit / not-ready / no-frame 都不该动。not-ready 尤其重要：
  // 首屏那一刻本来就可能是白的，这时候 reload 等于把正在下载的页面打断。
  if (verdict === 'ok' || verdict === 'empty-legit' || verdict === 'not-ready' || verdict === 'no-frame') {
    return 'none';
  }
  // scale-mismatch 和 blank-* 走同一个阶梯：先重画，再重载，最后如实上报。
  if (steps <= 0) return 'repaint';   // 第一步：remove+add 逼合成器重画（代价最小、不丢状态）
  if (steps === 1) return 'reload';   // 第二步：重载（会丢页面临时状态，所以排在重画之后）
  return 'give-up';                   // 第三步：如实上报，不再折腾
}

/** 位图统计的阈值（供测试与回执引用，避免两处写死）。 */
const THRESHOLDS = { WHITE_MIN_RATIO, WHITE_PIXEL, UNIQUE_MAX };

module.exports = { statsFromBitmap, classifyPaint, decidePaintAction, THRESHOLDS };

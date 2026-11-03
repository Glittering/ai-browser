// src/shared/screenshot_opts.cjs — ui.screenshot / browse_screenshot 参数规范化
//
// 为什么值得单独一个模块：截图是"把页面原样交给调用方"的动作，参数错了
// （quality 传了字符串、clip 越界、fullPage 与 clip 同传）要么静默出坏图，
// 要么让 CDP 报一句看不懂的错。这里在入口一次性把参数收敛成合法形状，
// 坏参数当场给出可读错误，而不是拖到 CDP 那一层。

'use strict';

const FORMATS = ['png', 'jpeg', 'webp'];
const DEFAULT_FORMAT = 'png';
// 512KB base64 ≈ 684KB 原始字节。单次回执再大，WS 帧和模型上下文都吃不消。
const MAX_DATA_URL_CHARS = 512 * 1024;

// 取帧档位（2026-11-02）：
//   surface —— webContents.capturePage()：只把视图自己那一帧合成面拷一份，
//              **不进渲染进程主线程**。
//   cdp     —— CDP Page.captureScreenshot(fromSurface:true)：像素同样是 surface，
//              但这条命令本身要渲染进程主线程接单排队。
//   auto    —— 按「屏幕上现在是不是这一帧」排两档顺序，另一档兜底（默认，见 pickShotTiers）。
// 事故现场：百度、dumate 的 tab 上 `ui.screenshot` 各报
// `captureScreenshot timeout after 20000ms —— the page main thread is likely blocked`，
// 而屏幕上明明是一张正常画面：合成器攥着帧，只有"命令排队"这一步被脚本占死了。
// 见 SPEC「取帧两条铁律」第 2 条 —— 自检早就是 surface 优先，截图这条路当时没跟上。
const SHOT_SOURCES = ['auto', 'surface', 'cdp'];
const DEFAULT_SOURCE = 'auto';

/**
 * 规范化截图参数。
 * @param {object} opts 调用方传入（可能缺项/错型）
 * @returns {{ok: true, opts: object} | {ok: false, error: string}}
 */
function normalizeScreenshotOpts(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const out = {};

  // --- format ---
  let format = DEFAULT_FORMAT;
  if (src.format !== undefined && src.format !== null) {
    if (typeof src.format !== 'string' || !FORMATS.includes(src.format)) {
      return { ok: false, error: `format must be one of ${FORMATS.join('/')} (got ${JSON.stringify(src.format)})` };
    }
    format = src.format;
  }
  out.format = format;

  // --- quality（仅 jpeg/webp 有意义；png 无损，传了忽略而不是报错）---
  if (src.quality !== undefined && src.quality !== null) {
    const q = Number(src.quality);
    if (!Number.isFinite(q) || q < 0 || q > 100) {
      return { ok: false, error: 'quality must be a number in 0..100' };
    }
    out.quality = Math.round(q);
  } else if (format === 'jpeg') {
    out.quality = 85; // 文字页面 85 肉眼无损，体积约为 png 的 1/5
  }

  // --- fullPage（captureBeyondViewport）---
  // null 与 undefined 同样视为"未提供"：JSON 里显式传 null 表示"用默认值"，
  // 不该和传错类型（'yes'/1）一样报错。
  if (src.fullPage != null && typeof src.fullPage !== 'boolean') {
    return { ok: false, error: 'fullPage must be a boolean' };
  }
  out.fullPage = src.fullPage === true;

  // --- path（可选：把图直接落盘，省得调用方自己解 base64）---
  // 此前传 path 会被**静默忽略**：调用方拿到 ok:true 以为文件写好了。
  // 这是本项目反复踩的同一类坑（参数被吞 → 结论错），所以在规范层直接支持。
  if (src.path !== undefined && src.path !== null && src.path !== '') {
    if (typeof src.path !== 'string' || !src.path.trim()) {
      return { ok: false, error: 'path must be a non-empty absolute file path' };
    }
    out.path = src.path;
  }

  // --- clip（设备像素坐标；不传则整视口）---
  if (src.clip !== undefined && src.clip !== null) {
    const c = src.clip;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const clip = {
      x: num(c.x),
      y: num(c.y),
      width: num(c.width),
      height: num(c.height),
      scale: c.scale === undefined ? 1 : num(c.scale),
    };
    if (['x', 'y', 'width', 'height'].some((k) => Number.isNaN(clip[k]))) {
      return { ok: false, error: 'clip.x/y/width/height must all be numbers' };
    }
    if (!Number.isFinite(clip.scale) || clip.scale <= 0 || clip.scale > 4) {
      return { ok: false, error: 'clip.scale must be a number in (0, 4]' };
    }
    if (clip.width <= 0 || clip.height <= 0) {
      return { ok: false, error: 'clip.width/height must be positive' };
    }
    if (clip.x < 0 || clip.y < 0) {
      return { ok: false, error: 'clip.x/y must be >= 0' };
    }
    // clip 与 captureBeyondViewport 同时传时，Chromium 的语义是"从 clip 顶部
    // 开始一路拍到页面底部"——调用方九成不是这个意思，且极易拍出几十 MB 的图。
    // 当场拦下，让调用方明确二选一。
    if (out.fullPage) {
      return { ok: false, error: 'fullPage and clip are mutually exclusive (captureBeyondViewport+clip means "clip top through page bottom" — pick one)' };
    }
    out.clip = clip;
  }

  // --- source（取帧档位；显式传是为了复现旧路径 / 强制只要其中一档）---
  if (src.source != null) {
    if (typeof src.source !== 'string' || !SHOT_SOURCES.includes(src.source)) {
      return { ok: false, error: `source must be one of ${SHOT_SOURCES.join('/')} (got ${JSON.stringify(src.source)})` };
    }
    out.source = src.source;
  } else {
    out.source = DEFAULT_SOURCE;
  }

  return { ok: true, opts: out };
}

/**
 * 这一发请求能不能用 surface 档（capturePage）拿帧。
 *
 * 判据不是"想不想快"，是**只有整视图的那一帧才是等价的**：
 *   · fullPage —— captureBeyondViewport 要渲染进程给出视口外的布局，位图里没有；
 *   · clip —— CDP 的 clip 是文档坐标，capturePage 给的是"当前视口那一帧"，
 *     本地裁剪会把两个坐标系混成一个（宁可慢，不要静默给错区域）；
 *   · webp —— nativeImage 只有 toPNG/toJPEG，没有 toWebP。
 * 这三种继续走 CDP，也就继续受"主线程被占住会超时"约束 —— 它们本来就要渲染进程配合。
 */
function canUseSurface(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (o.fullPage === true) return false;
  if (o.clip) return false;
  if (o.format === 'webp') return false;
  return true;
}

/**
 * auto 档的顺序由"屏幕上现在是不是这一帧"决定，不是由"有没有兄弟压在它上面"决定。
 *
 * 分水岭换过一次（2026-11-03 探针实测）：旧判据在**窗口不在屏幕上**时（hide /
 * minimize）算出"没被盖住"，于是让后台页先去排 CDP 那条 20s 的队。而那一格实测
 * surface 档 57–107ms 就能给出视图自己的合成帧，CDP 只有**正在重绘**的页面才答
 * （1.1–2.1s），静态页一直等到 deadline。也就是说旧判据在最该快的那一格里选了慢的。
 *
 * 只有**确定**屏幕上显示的就是这一页时，CDP 才优先：那一帧正在被合成，它是"用户
 * 此刻看到的画面"的最准来源，还给得出 clip/fullPage 的坐标语义。
 * 可见性问不到（null）也按 surface 先 —— 这里和布尔判据不同，不是"猜哪边更快"：
 * surface 档要么几十毫秒给帧、要么两三毫秒如实说没帧，两种都比先排 20s 的队便宜，
 * 而 CDP 作为后一档一直都在，没丢掉任何一条路。
 *
 * @param {{source?:string, windowOnScreen?:boolean|null, isActive?:boolean}} st
 * @returns {string[]} 'surface' / 'cdp' 的顺序
 */
function pickShotTiers(st) {
  const s = st && typeof st === 'object' ? st : {};
  // 显式 source 就是点名单一档，不兜底：调用方要"只有 surface"或"只有 CDP"时，
  // 替他换档等于给一张他没要的图。
  if (s.source === 'surface') return ['surface'];
  if (s.source === 'cdp') return ['cdp'];
  return s.windowOnScreen === true && s.isActive === true ? ['cdp', 'surface'] : ['surface', 'cdp'];
}

/**
 * 把每一档的失败原因拼成一句回执。
 *
 * 修的是"只有最后一档的原因能活下来"：旧实现每档都往同一个 `lastError` 里写，
 * 于是隐藏窗口里那一发（surface 2ms 没帧 + CDP 20s 超时）只回一句"这一页从来没画过"，
 * 真凶那句 `captureScreenshot timeout after 20000ms` 被覆盖掉，调用方既看不到白等的
 * 20 秒，也分不清"根本没帧"和"有帧但取不到"。
 *
 * 每一档都带 `[tier]` 前缀：单档时前缀只是把话说明白，多档时它区分得开谁说的。
 *
 * @param {Array<{tier:string, reason:string}>} failures
 * @returns {string}
 */
function joinShotFailures(failures) {
  const list = [];
  for (const f of Array.isArray(failures) ? failures : []) {
    if (!f || typeof f !== 'object') continue;
    const msg = String(f.reason || '').trim();
    if (msg) list.push(`[${f.tier || 'tier'}] ${msg}`);
  }
  if (!list.length) return 'screenshot failed — no tier produced a frame';
  return list.join(' | ');
}

/**
 * surface 档的尺寸回执：capturePage 给的是**设备像素**，而调用方按 CSS 像素
 * 传坐标、也按 CSS 像素读回执（CDP 档的 meta 就是 CSS 像素）。视图的 bounds
 * 恰等于这一页的视口（BrowserView 的边界就是它的可视区），所以：
 *   CSS 尺寸 = 视图 bounds，dpr = 位图宽 / bounds 宽。
 * 这样主线程被占死、连 devicePixelRatio 都 evaluate 不出来的页面，
 * 回执仍然带得齐 width/height/device_pixel_ratio —— 不必为了这两个数再去排队。
 */
function surfaceMeta(px, bounds) {
  const p = px && typeof px === 'object' ? px : {};
  const b = bounds && typeof bounds === 'object' ? bounds : {};
  const cssW = Number(b.width);
  const cssH = Number(b.height);
  if (!Number.isFinite(cssW) || cssW <= 0 || !Number.isFinite(cssH) || cssH <= 0) return {};
  const out = { width: Math.round(cssW), height: Math.round(cssH) };
  const pxW = Number(p.width);
  if (Number.isFinite(pxW) && pxW > 0) out.devicePixelRatio = Math.round((pxW / cssW) * 1000) / 1000;
  return out;
}

/**
 * 回执摘要：调用方拿到图之后最想知道的几件事，省得它再发一轮查询。
 * 敏感字段（密码框在场）单独标，因为 captureScreenshot 不会模糊它。
 */
function describeShot(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const out = {
    format: m.format || 'png',
    mime: m.mime || 'image/png',
    bytes: typeof m.bytes === 'number' ? m.bytes : null,
    width: typeof m.width === 'number' ? m.width : null,
    height: typeof m.height === 'number' ? m.height : null,
    truncated: false,
  };
  if (typeof m.url === 'string') out.url = m.url;
  if (typeof m.title === 'string') out.title = m.title;
  // CDP 的 clip/视口坐标是 CSS 像素，输出图是设备像素。带上 DPR，调用方才能
  // 把图上的像素坐标换算回页面坐标（Retina 上差 2 倍）。
  if (typeof m.devicePixelRatio === 'number' && m.devicePixelRatio > 0) {
    out.device_pixel_ratio = m.devicePixelRatio;
  }
  if (m.hasVisiblePasswordInput === true) {
    out.warning = 'page has a visible password input — the screenshot may contain typed secrets';
  } else if (m.passwordProbe === 'skipped') {
    // surface 档不等渲染进程，密码框探测（一次 evaluate）就探不了。图照样给，
    // 但"这张图里有没有密码"这件事必须如实说成未知，不能默默当成"没有"。
    out.password_probe = 'skipped';
    out.warning = 'password-input probe skipped (page main thread busy) — this frame may contain typed secrets';
  }
  // 位图是哪一档取的：surface = 视图自己的合成帧（不进主线程），cdp = 渲染进程
  // 配合截的。调用方据此判断"这张图和屏幕上看到的那一帧是不是同一个东西"。
  if (typeof m.source === 'string') out.source = m.source;
  return out;
}

module.exports = {
  FORMATS,
  SHOT_SOURCES,
  DEFAULT_SOURCE,
  MAX_DATA_URL_CHARS,
  normalizeScreenshotOpts,
  canUseSurface,
  pickShotTiers,
  joinShotFailures,
  surfaceMeta,
  describeShot,
};

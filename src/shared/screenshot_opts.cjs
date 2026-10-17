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

  return { ok: true, opts: out };
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
  }
  return out;
}

module.exports = {
  FORMATS,
  MAX_DATA_URL_CHARS,
  normalizeScreenshotOpts,
  describeShot,
};

// shared/popup_geometry.cjs — window.open 的窗口特性 → 我们的视图几何（纯函数）
//
// # 为什么需要这一层（2026-11-02）
//
// 站点写 `window.open(url, name, 'width=420,height=520,left=120,top=80')` 时，它请求的是
// **一个 420×520 的浮层**：登录框、支付二维码、选择器都这么写。本项目的模型里没有独立
// 窗口（setWindowOpenHandler 一律 deny，弹窗落成标签页），而以前这条请求里的几何信息
// **被整份丢掉**（handler 只解构了 url；页面侧垫片把 _features 参数接了却没用）。
// 于是弹窗长成整号的独立标签页 —— 表现就是用户看到的"弹窗页面是一片白/整屏换了一页"，
// 而它本该只盖住父页面右下角那一块。
//
// 丢掉的不只是观感：弹窗页自己会读 `window.innerWidth`（登录框按它排版）、站点也会读
// `w.innerWidth` 来决定往下问多少字段 —— 给它整屏宽度，等于让它按不属于它的尺寸排版。
//
// # 判据照 Chrome，不自创
//   · 只有**显式请求了尺寸**（width/height）或 `popup=yes|1` 才算弹窗；
//     `noopener` / `noreferrer` / `_blank` 这些不是尺寸，Chrome 也照样开新标签页 ——
//     把它们当弹窗会让所有普通外链弹成小窗，那是另一种错。
//   · 尺寸下限 100（Chrome 不允许弹窗小于此），上限就是我们能给的内容区。
//   · left/top 缺省居中（Chrome 用级联偏移；我们只有一个窗口，居中更稳定也可复现）。
//
// 坐标约定：这里算出来的是 **BrowserView 的 content 坐标**（y 已经含标签栏高度），
// 调用方给 box = 内容区矩形，返回值可以直接交给 view.setBounds()。
// 夹取是幂等的：窗口缩放时对旧矩形再夹一次，只可能挪位置/缩尺寸，不会漂。

'use strict';

// Chrome 的弹窗最小尺寸；低于此按此处理（站点写 width=50 多半是笔误，照给会看不见）。
const MIN_WIDTH = 100;
const MIN_HEIGHT = 100;
// 站点只给一个维度时的缺省。取"登录框"这个量级，而不是整屏 —— 整屏就等于没修。
const DEFAULT_WIDTH = 500;
const DEFAULT_HEIGHT = 600;

const TRUTHY = ['1', 'yes', 'true', 'y'];
const FALSY = ['0', 'no', 'false', 'n', ''];

/** 'width=420,height=520' | {width:'420',popup:true} → { width:'420', height:'520' }（键小写）。 */
function parseFeatures(input) {
  const out = {};
  if (!input) return out;
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null) continue;
      out[String(k).trim().toLowerCase()] = v;
    }
    return out;
  }
  // 站点写的是特性串；分隔符 Chrome 允许 ',' 或 ';'，两种都收。
  if (typeof input !== 'string') return out;   // 数字等杂类型不是特性，不许当成"裸开关名"
  for (const pair of String(input).split(/[;,]/)) {
    const s = pair.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) { out[s.toLowerCase()] = true; continue; }
    out[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim();
  }
  return out;
}

/** '420' | 420 | 'abc' → 数字或 null（NaN 不许当成 0，那会把弹窗塞到左上角）。 */
function num(v) {
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 特性串里的开关值：'no'/0/undefined → false，'yes'/1/true → true。 */
function flag(v) {
  if (v === true) return true;
  if (v === undefined || v === null) return false;
  return TRUTHY.includes(String(v).trim().toLowerCase());
}

/**
 * 这一发是不是"请求一个弹窗"。
 * 只看尺寸类特性 —— width/height 存在（且解得出数字）或 popup 为真。
 */
function wantsPopup(input) {
  const f = typeof input === 'string' || (input && typeof input === 'object') ? input : '';
  const o = parseFeatures(f);
  if (flag(o.popup)) return true;
  return num(o.width) !== null || num(o.height) !== null;
}

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/**
 * 把请求的几何折成内容区里的一个矩形。
 * @param {object|string} input 特性串或特性对象
 * @param {{x:number,y:number,width:number,height:number}} box 可用内容区（视图坐标系）
 * @returns {{x:number,y:number,width:number,height:number}|null} null = 不该按弹窗处理
 */
function popupRect(input, box) {
  const b = box && typeof box === 'object' ? box : {};
  const bw = num(b.width); const bh = num(b.height);
  if (bw === null || bh === null || bw <= 0 || bh <= 0) return null;
  if (!wantsPopup(input)) return null;
  const ox = num(b.x) === null ? 0 : num(b.x);
  const oy = num(b.y) === null ? 0 : num(b.y);

  const f = parseFeatures(input);
  // 上限就是内容区：请求比窗口还大的弹窗没有意义（真实浏览器也这么夹），
  // 而且这里夹不住就会让弹窗自己带滚动条还盖住标签栏。
  const w = clamp(num(f.width) === null ? DEFAULT_WIDTH : num(f.width), Math.min(MIN_WIDTH, bw), bw);
  const h = clamp(num(f.height) === null ? DEFAULT_HEIGHT : num(f.height), Math.min(MIN_HEIGHT, bh), bh);
  const left = num(f.left); const top = num(f.top);
  // left/top 是"相对可用区左上角"的偏移（我们没有屏幕坐标这个概念，而弹窗压在父页面
  // 上正是它在本模型里的正确形态）。负值不当成 0 悄悄吞掉，而是夹回可用区内。
  const x = left === null ? ox + Math.round((bw - w) / 2) : clamp(ox + left, ox, ox + bw - w);
  const y = top === null ? oy + Math.round((bh - h) / 2) : clamp(oy + top, oy, oy + bh - h);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/**
 * 夹回新的可用区（窗口缩放 / 底部横幅出现时用）。不读特性，只吃已存的矩形。
 * 幂等：同一对 (rect, box) 再夹一次结果不变；box 变大时**不**把弹窗放大回去
 * —— 它请求的就是那个尺寸。
 */
function clampRect(rect, box) {
  const r = rect && typeof rect === 'object' ? rect : {};
  const b = box && typeof box === 'object' ? box : {};
  const bw = num(b.width); const bh = num(b.height);
  if (bw === null || bh === null || bw <= 0 || bh <= 0) return null;
  const ox = num(b.x) === null ? 0 : num(b.x);
  const oy = num(b.y) === null ? 0 : num(b.y);
  const w = clamp(num(r.width) === null ? bw : num(r.width), Math.min(MIN_WIDTH, bw), bw);
  const h = clamp(num(r.height) === null ? bh : num(r.height), Math.min(MIN_HEIGHT, bh), bh);
  const x = clamp(num(r.x) === null ? ox : num(r.x), ox, ox + bw - w);
  const y = clamp(num(r.y) === null ? oy : num(r.y), oy, oy + bh - h);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

module.exports = {
  MIN_WIDTH, MIN_HEIGHT, DEFAULT_WIDTH, DEFAULT_HEIGHT,
  parseFeatures, wantsPopup, popupRect, clampRect,
};

// src/shared/frame_probe.cjs — 跨进程子帧（OOPIF）探测的纯函数部分
//
// 背景（B站图文编辑器隐形两小时的事故）：站点把富文本编辑器放进跨进程
// iframe。同源 DOM 通路（preload extractor 的 contentDocument 递归）对
// OOPIF 恒返回 null，于是那部分内容在默认语义树里**完全不存在** —— 不是
// "读出来是空的"，是连占位都没有。能救场的只有 AX 路径（getFullAXTree
// 走 CDP，天生跨帧），但调用方无从知道该切过去。
//
// 本模块只放纯函数：探测本身在 extractor 里（要 DOM），判定与摘要放这里
// （要可单测，且 page_manager 的自动路由要用同一把尺）。

'use strict';

/**
 * 汇总 extractor 收集到的不可读子帧。
 * @param {Array<{id:string,src:string,width:number,height:number}>} frames
 * @returns {{count:number, visible_count:number, suggestion:string|null}}
 */
function summarizeOpaqueFrames(frames) {
  const list = Array.isArray(frames) ? frames.filter((f) => f && typeof f === 'object') : [];
  const visible = list.filter((f) => (f.width || 0) > 0 && (f.height || 0) > 0);
  if (!list.length) {
    return { count: 0, visible_count: 0, suggestion: null };
  }
  return {
    count: list.length,
    visible_count: visible.length,
    // 建议文案里必须出现 ax:true —— 那是唯一的补救通路，且此前无任何地方
    // 告诉调用方它存在。
    suggestion: 'page has cross-process iframe(s) whose content is invisible to the default DOM read path — retry with get_tree {ax:true} (CDP Accessibility reads across frames)',
  };
}

/**
 * 是否值得为这批帧自动补一次 AX 读取。
 * 判定故意保守：只有"确有可见的不可读帧"才自动路由。不可见的帧（width/height
 * 为 0，通常是埋点/广告帧）不值得让每次 get_tree 都多付一次 CDP 往返。
 */
function shouldAutoAx(summary) {
  return !!(summary && typeof summary.visible_count === 'number' && summary.visible_count > 0);
}

/**
 * 自动 AX 读取的结果如何写进 context.frame_hints。
 * 三种结局分开说：合并成功 / 合并没有新内容 / AX 本身失败。调用方需要能
 * 区分"已经尽力了"和"还有一条没走过的路"。
 */
function describeAutoAx(outcome) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  if (o.merged) {
    return { auto_ax: 'merged', frames_read: Number(o.framesRead) || 0 };
  }
  if (o.error) {
    return { auto_ax: 'failed', reason: String(o.error) };
  }
  return { auto_ax: 'no-new-content' };
}

module.exports = {
  summarizeOpaqueFrames,
  shouldAutoAx,
  describeAutoAx,
};

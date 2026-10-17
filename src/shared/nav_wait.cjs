// src/shared/nav_wait.cjs — ui.navigate 的完成信号（纯函数）
//
// 事故：SPA（尤其带 markdown 高亮的编辑器）永远不 fire `load`，而 navigate 走的是
// `webContents.loadURL()` —— 它在 did-finish-load 才 resolve。于是导航"成功"的页面
// 被当成超时：30s 空等，期间 tab 被拖到无响应，之后所有 act/evaluate 连锁超时，
// agent 据此得出"编辑器坏了"的结论。
//
// load 不是可用的完成信号。这里把"等到哪一步"显式化：
//   commit          主帧导航已提交（最快；内容可能还没渲染）
//   domcontentloaded DOM 就绪（默认；SPA 在这一步就能返回）
//   load            连子资源一起等（老行为，只在确实需要时用）

'use strict';

const LEVELS = ['commit', 'domcontentloaded', 'load'];
const DEFAULT_LEVEL = 'domcontentloaded';

// 同义词归一。刻意不接受 networkidle：它需要网络空闲探测，本实现里没有对应
// 机制 —— 承诺一个做不到的档位，比只给三个真实档位更糟。
const ALIASES = {
  commit: 'commit',
  dom: 'domcontentloaded',
  domready: 'domcontentloaded',
  domcontentloaded: 'domcontentloaded',
  interactive: 'domcontentloaded',
  load: 'load',
  full: 'load',
};

/**
 * 归一 wait_until。返回 { value } 或 { error }（error 可直接给调用方看）。
 */
function normalizeWaitUntil(v) {
  if (v === undefined || v === null || v === '') return { value: DEFAULT_LEVEL };
  const key = String(v).toLowerCase().replace(/[\s_-]/g, '');
  const hit = ALIASES[key];
  if (!hit) {
    return {
      error: 'unknown wait_until: ' + JSON.stringify(String(v))
        + ' — valid values are ' + LEVELS.join(' | ')
        + '. Default is domcontentloaded; use load only when you really need subresources.',
    };
  }
  return { value: hit };
}

module.exports = { normalizeWaitUntil, LEVELS, DEFAULT_LEVEL };

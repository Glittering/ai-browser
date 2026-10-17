'use strict';
// src/shared/key_dispatch.cjs —— 「这一次按键该发什么 CDP 事件」的纯决策。
//
// 抽成纯函数只为一件事：这是"按了等于没按"那类缺陷的唯一入口，必须能单测。
// 藏在 PageManager 里就只能靠真起一个 Electron 才能验证。
//
// 核心事实：CDP 的 `rawKeyDown` **刻意不带 text**，浏览器只派发 keydown、
// 不产生 keypress。而 Enter 激活聚焦元素（<button> 的 click、<a> 的跳转、
// 表单的隐式提交）走的正是默认动作 —— 也就是 keypress。
// 实测（tools/_oneoff/probe_press_enter.cjs，file:// 页面）：focus 一个 button
// 后 ui.act press Enter，页面收到 keydown（e.key==='Enter'、isTrusted=true），
// 但 onclick **一次都没触发**；同元素 click 正常。
// Puppeteer 的 keyboard.press('Enter') 有效，是因为它的键表给 Enter 配了
// text='\r'，走的是**带 text 的 keyDown**。
//
// 两种语义必须分开，不能全局替换：
//   activate=true  → 带 text 的 keyDown（产生默认动作）
//   activate 缺省  → rawKeyDown（+ 可选 char），type 的段间换行依赖它
// 理由见 page_manager._cdpKey 的注释：type 里"先发不带 text 的 Enter，看编辑器
// 有没有自己分段，没分才补 char"这个策略不能被改坏。
function keyDispatchPlan(p, opts) {
  const spec = p || {};
  const activating = !!(opts && opts.activate);
  // 只有 Enter 需要"补"一个默认文本：它的默认动作在 keypress 上。
  // 其它键（Tab/Delete/方向键）的默认动作在 keydown 上，rawKeyDown 已经够。
  let text = '';
  if (activating) {
    if (spec.text === undefined) text = spec.key === 'Enter' ? '\r' : '';
    else text = spec.text || '';
  }
  if (activating && text) {
    return { type: 'keyDown', text, charText: '' };
  }
  return { type: 'rawKeyDown', text: '', charText: spec.text || '' };
}

module.exports = { keyDispatchPlan };

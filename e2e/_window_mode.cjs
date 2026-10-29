'use strict';
// e2e 子进程的窗口策略 —— 所有套件都必须从这里取，不要自己拼。
//
// # 为什么需要这个文件
//
// 2026-10-28 用户反馈："你测试项目的时候，好像还是会抢电脑的控制权，抢前台显示。"
// 查下去是事实：27 处 spawn 里没有一处设窗口策略，于是每个套件起来时
// showInitialWindow() 里 byAgent=false → shouldActivate=true → mainWindow.show()
// —— 主动显示并抢焦点。跑一次全量 e2e（22 个套件）就等于 22 次把窗口拍在用户脸上。
//
// # 两档
//
//   hidden（默认）  AI_BROWSER_START_HIDDEN=1 —— 进程起来但**不出窗口**。
//                   读树 / 点击 / 输入 / 滚动 / 上传 / 对话框 / 抓包 / 截图 /
//                   白屏自检 / 导航全部照常（npm run background 的 37 条断言钉住）。
//   visible         AI_BROWSER_LAUNCHED_BY_AGENT=1 —— 窗口出现，但走 showInactive：
//                   不夺键盘焦点、不把用户当前的 app 顶下去。
//
// 只有"必须看见真实窗口"的套件才进 VISIBLE，逐个都有理由：
//   focus    测的就是前台/焦点，隐藏了就无从测起；
//   flicker  屏幕录制，窗口必须真的在屏幕上；
//   layout   几何等式要真实内容区（隐藏窗口的 content bounds 语义不同）；
//   paint    窗口不可见时白屏判定是**故意跳过**的（见 page_manager._schedulePaintAudit），
//            隐藏跑必然红，但那是设计，不是缺陷。
//   nav      NV-A2/A3b 验证的就是 `ui.window_shown`（窗口显示的时机与当时页面状态，
//            白屏诊断的观测口）—— 隐藏模式下没有"窗口显示"这件事，断言无从谈起。
//
// 临时想让某个套件显示窗口：AI_BROWSER_E2E_VISIBLE=1 npm run <suite>。
const VISIBLE = new Set(['focus', 'flicker', 'layout', 'paint', 'nav']);

const FORCE_VISIBLE = /^(1|true|yes|on)$/i.test(String(process.env.AI_BROWSER_E2E_VISIBLE || ''));
// 反过来也留一个逃生口：想确认"隐藏下到底还差什么"时，强制全部隐藏。
const FORCE_HIDDEN = /^(1|true|yes|on)$/i.test(String(process.env.AI_BROWSER_E2E_HIDDEN || ''));

/**
 * @param {string} suite 套件名（文件名去掉 _ws.cjs），用于查白名单
 * @returns {object} 要展开进 spawn env 的字段
 */
function windowEnv(suite) {
  const name = String(suite || '').replace(/_ws\.cjs$/, '');
  const visible = !FORCE_HIDDEN && (FORCE_VISIBLE || VISIBLE.has(name));
  if (visible) {
    // 可见但**不抢**：showInactive。断言"窗口可见"的套件也只用 lsappinfo 看，
    // 不需要它成为前台 app。
    return { AI_BROWSER_LAUNCHED_BY_AGENT: '1', AI_BROWSER_START_HIDDEN: '0' };
  }
  return { AI_BROWSER_START_HIDDEN: '1', AI_BROWSER_LAUNCHED_BY_AGENT: '1' };
}

module.exports = { windowEnv, VISIBLE };

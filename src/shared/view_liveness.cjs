// shared/view_liveness.cjs — "这个 BrowserView 现在还能不能碰"的唯一判定口径。
//
// 事故（2026-10-30，用户报"又白屏了"，截图：标题栏正常、内容全白、底部一条深红横幅、
// 左侧露一小块橙棕）：主进程在 22 次 uncaught_exception 里反复抛
//     Cannot read properties of undefined (reading 'isDestroyed')
//     at pushNavState (index.js) ← setInterval(pushNavState, 1500)
//
// 根因是 Electron 的一个反直觉行为（用真 Electron 探针实测，见 git 提交说明）：
//   - webContents.close() / destroy() 之后，BrowserView 对象**还在**，但
//     view.webContents 变成 undefined —— 此时 `view.webContents.isDestroyed()`
//     直接抛 TypeError。
//   - 渲染进程崩溃（render-process-gone）之后，view.webContents**还在**，
//     isDestroyed() 也返回 false，但内容不再渲染（视图区域空白），reload() 能救回。
//
// 也就是说"视图可能失效"有两种形态，任何一处裸写 `view.webContents.isDestroyed()`
// 都会在第一种形态下击穿主进程。而这个 HK 项目的地址栏/标题由 setInterval 每 1.5s
// 无条件重推一次 —— 一旦 tabBarView 悬空，就变成每 1.5s 崩一次的死亡螺旋：
// 崩溃 → uncaughtException → reportFatal → showErrorBanner → layoutWithBanner
// → 又碰到悬空视图 → 二次崩溃 → 进程半死（端口还在 listen 但 WS 握手完不成）。
//
// 这份模块只做一件事：给一个"可能是 BrowserView"的对象，回答
//   "它现在有没有一个活着、可安全调用的 webContents？"
// 判定与"怎么救"分开 —— 救（重建/reload/收横幅）有副作用，属于调用方职责，
// 且必须有上限，不能在纯函数里做。
//
// 为什么必须是纯函数：node:electron 在 vitest 里 import 会炸，index.js 整份没法单测。
// 把这条判定抽出来，才能用假对象把"undefined / 抛异常 / isDestroyed=true"三种形态
// 一次性钉死 —— 否则这类 bug 永远只能靠真机偶发复现。

'use strict';

/**
 * 视图是否"活着且可安全使用"。
 *
 * 覆盖三种失效形态（都用真 Electron 或等价假对象实测）：
 *   1. view 本身是 null/undefined            → false
 *   2. view.webContents 是 undefined/null     → false（close/destroy 后，正是事故形态）
 *   3. webContents.isDestroyed() === true    → false
 *   4. 读取 webContents / 调 isDestroyed 抛异常 → false（宁可判死，绝不让异常冒出去）
 *
 * @param {object} view 可能是 BrowserView 的东西
 * @returns {boolean}
 */
function isAlive(view) {
  if (!view) return false;
  try {
    const wc = view.webContents;
    if (!wc) return false;
    if (typeof wc.isDestroyed !== 'function') return false;
    return !wc.isDestroyed();
  } catch (_) {
    return false;
  }
}

/**
 * 失效的"原因"，供日志/回执区分"悬空"与"已销毁"，避免把两种形态混为一谈
 * （它们的救法不同：悬空必须重建 BrowserView，已销毁可考虑 reload）。
 *
 * @param {object} view
 * @returns {'ok'|'no-view'|'no-webcontents'|'destroyed'|'unknown'}
 */
function liveness(view) {
  if (!view) return 'no-view';
  let wc;
  try { wc = view.webContents; } catch (_) { return 'unknown'; }
  if (!wc) return 'no-webcontents';
  try {
    if (typeof wc.isDestroyed !== 'function') return 'unknown';
    return wc.isDestroyed() ? 'destroyed' : 'ok';
  } catch (_) { return 'unknown'; }
}

module.exports = { isAlive, liveness };

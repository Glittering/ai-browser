// shared/nav_follow.cjs — 「地址栏跟随」的挂载状态机。
//
// 要解决的问题：地址栏必须反映**激活 tab 的真实导航状态**，所以每次切 tab 都要
// 把 5 个导航事件转到 pushNavState 上。这段逻辑原来直接写在 index.js 的闭包里，
// 结果两个坑同时存在、而且只有真浏览器才看得见：
//
//   1. **重复挂载**：守卫是 `if (navStateWc === wc) return`，只挡住"连续两次切到
//      同一个 tab"。A→B→A 切回来时旧对象没销毁，于是又挂一遍 —— 实测切 5 次后
//      A 上 `did-navigate` 的监听数是 3（应为 1），每次导航 pushNavState 被调 3 次；
//      翻过 10 个还会触发 Node 的 MaxListenersExceededWarning。
//   2. **判据证伪不了它**：写在闭包里没法单测，回归只能 grep 源码
//      （"出现 removeListener 就算对"），而上面那个真实的重复挂载在 grep 下全绿。
//
// 所以把状态机搬出来，用 WeakSet 记账（webContents 被回收时记账自动失效，
// 不需要额外清理），并对销毁时机做显式处理：webContents 一旦 destroyed，
// 监听器随对象消亡，但**我们持有的引用**必须清掉，否则下次切 tab 前它一直悬空。

/** 地址栏需要跟随的 5 个事件。顺序无关，但必须与 pushNavState 的语义一致。 */
const NAV_EVENTS = [
  'did-start-loading',
  'did-stop-loading',
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
];

/**
 * @param {object} opts
 * @param {string[]} [opts.events] 要跟随的事件名
 * @param {() => void} opts.push    事件触发时调用的推送函数（必须是无参、幂等的）
 * @returns {{wire: (wc:any)=>any, current: ()=>any, wired: (wc:any)=>boolean}}
 */
function createNavFollower({ events = NAV_EVENTS, push } = {}) {
  if (typeof push !== 'function') throw new TypeError('createNavFollower: push 必须是函数');

  let current = null;          // 当前跟随的 webContents（只用来报告/清理，不参与判重）
  const seen = new WeakSet();  // 已经挂过监听的 webContents

  /**
   * 把 wc 设为跟随目标。**幂等**：同一个 wc 无论调多少次，每个事件只会有一个监听。
   * 传 null/undefined 是合法调用（没有激活 tab），直接返回 null。
   */
  function wire(wc) {
    if (!wc) return null;
    current = wc;
    if (seen.has(wc)) return wc;   // 已经挂过 —— 只更新跟随目标，不再挂第二遍
    seen.add(wc);
    for (const ev of events) {
      try {
        wc.on(ev, push);
      } catch (_) {
        // 对象刚好在这几毫秒内销毁：跳过，下一次 wire 会重新挂。
      }
    }
    // 销毁后清掉引用。监听器本身随对象一起消亡，不需要（也无法）手动摘。
    try {
      wc.once('destroyed', () => { if (current === wc) current = null; });
    } catch (_) { /* 不支持 once 的假对象（单测）忽略 */ }
    return wc;
  }

  return {
    wire,
    current: () => current,
    wired: (wc) => !!wc && seen.has(wc),
  };
}

module.exports = { createNavFollower, NAV_EVENTS };

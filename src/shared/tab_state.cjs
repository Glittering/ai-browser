// shared/tab_state.cjs — "关掉一个 tab 时，哪些 per-tab 状态必须跟着消失"的唯一清单。
//
// 为什么要有这份表（而不是继续在 _cleanupTabResources 里逐行写 delete）：
//   PageManager 现在有 26 个 `new Map()/Set()` 字段，其中 20 多个以 tabId 为键。
//   tabId **会被复用**，所以任何一处漏清都会变成"新 tab 带着上一任的状态活着"——
//   它不报错，只让新 tab 的第一次白屏自检直接被判成 give-up、让旧 URL 一直挂在
//   _openedTabs 里。历史上已经发生过两轮：
//     · Bug 5（2026-10-30）：漏了 _refTrackers / _axDiffCache / _failureGuard /
//       canvasMonitor —— 当时只补了被点名的 4 个；
//     · 本次评估（AUDIT-2026-10-30 P1-2）：又查出 _openedTabs / _canvasBindings /
//       _paintAuditInflight 三项漏网。
//   根因不是"谁忘了写"，而是**机制**：新增一个 per-tab 容器时，没有任何东西会
//   提醒你去清理它。所以把清单变成数据，再用"构造函数里的每个 Map/Set 必须登记
//   在表里或白名单里"的单测当闸门 —— 忘记登记 = 构建失败，而不是半年后一次泄漏。
//
// 判定与执行分开（同 view_liveness.cjs 的理由）：这里是纯函数，node:electron 不参与，
// 于是可以用假 owner 把"哪类容器怎么清"逐类钉死。
//
// 三类容器，三种清法（表里用标记区分）：
//   · 默认          —— Map<K, V> / Set<T>，**键/成员就是 tabId**：delete(tabId)
//   · byValue: true —— Map<K, tabId>，**值是 tabId**（bindingName → tabId 这种）：
//                      只删值相等的条目，键是别的东西
//   · timers: true  —— Map<tabId, Timeout>：先 clearTimeout 再 delete，
//                      否则关掉的 tab 还会在 5s 后来敲一次已经不存在的视图

'use strict';

/**
 * 以 tabId 为键（或值为 tabId）的容器。**新增这类字段必须在这里登记**，
 * 否则 tests/test_tab_state_reset.js 的完整性闸门会红。
 */
const PER_TAB = [
  // ---- 标签页归属 / LRU ----
  { field: '_tabGroup' },
  { field: '_tabUsedAt' },
  // ---- window.open 垫片记账 ----
  { field: '_openedTabs' },          // 键 = 发起 window.open 的那个 tab
  { field: '_windowOpenShimTabs' },
  { field: '_windowOpenShimReady' },
  // ---- 导航状态机 ----
  { field: '_tabNavState' },
  // ---- 浏览器级对话框 ----
  { field: '_lastDialog' },
  { field: '_openDialogs' },
  { field: '_dialogWatched' },
  // ---- 增量 diff / ref 纪元 ----
  { field: '_axDiffCache' },
  { field: '_refTrackers' },
  { field: '_failureGuard' },
  // ---- 重绘 / 白屏自检 / 崩溃自救 ----
  { field: '_repaintTimers', timers: true },
  { field: '_paintState' },
  { field: '_paintSteps' },
  { field: '_paintTimers', timers: true },
  { field: '_paintAuditInflight' },
  { field: '_paintSelfReload' },
  { field: '_crashReloadAt' },
  // ---- canvas hook 回传路由 ----
  // 键是 `__aiCanvasReport_<tabId>_<rand>`，值是 tabId —— 每次重装 hook 都生成
  // 一个新名字，所以这里只能按**值**清，否则每次 configure 都留一条永不释放。
  { field: '_canvasBindings', byValue: true },
];

/**
 * 看起来像 per-tab、但**不该由这里清**的容器。每条都必须写清理由，
 * 否则闸门测试只是被我们用手写白名单骗过去而已。
 */
const NOT_PER_TAB = {
  _pendingRequests: '键是自增 requestId，promise settle 时自己删；与 tab 生死无关',
  _wsClients: '键是 sessionId，由 unregisterClient 清（连接生命周期）',
  _sessionTab: '键是 sessionId，由 unregisterClient 清（连接生命周期）',
  _groups: '键是 groupId，组空时由 _forgetTab 删；删 tab 不等于删组',
  _windowOpenTokens: '值是 {tabId}，closeTab 里手写遍历清（结构不是直接 tabId）',
  _snapshots: '值是 {tab, ...}，_cleanupTabResources 里手写遍历清（结构不是直接 tabId）',
  _networkRequestMap: '值是 {tabId, ...}，_cleanupTabResources 里手写遍历清',
  _cdpTabs: '值是 {wc}，清理前必须 debugger.detach()（有副作用，不能放进纯函数）',
};

/**
 * 清掉一个 tab 的全部状态。
 * @param {object} owner  PageManager 实例（或任何带同名字段的假对象）
 * @param {number|string} tabId
 * @param {Array} table     默认用 PER_TAB；测试可传自定义表
 * @returns {string[]} 真正执行过清理的字段名（供调用方/测试观测）
 */
function clearPerTab(owner, tabId, table = PER_TAB) {
  const cleared = [];
  if (!owner || tabId === undefined || tabId === null) return cleared;

  for (const row of table) {
    const c = owner[row.field];
    // 懒初始化的字段此刻可能还不存在；类型不对的字段（有人手改成数组）也别抛。
    if (!c || typeof c.delete !== 'function') continue;

    if (row.byValue) {
      // Map<K, tabId>：只能遍历值。Set 没有 entries()，故要求是 Map。
      if (typeof c.entries !== 'function') continue;
      for (const [k, v] of c.entries()) {
        if (v === tabId) c.delete(k);
      }
    } else {
      if (row.timers && typeof c.get === 'function') {
        const t = c.get(tabId);
        if (t) {
          try { clearTimeout(t); } catch (_) { /* 已触发的 timer 清不掉，正常 */ }
        }
      }
      c.delete(tabId);
    }
    cleared.push(row.field);
  }
  return cleared;
}

module.exports = { PER_TAB, NOT_PER_TAB, clearPerTab };

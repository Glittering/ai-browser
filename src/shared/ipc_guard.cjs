// shared/ipc_guard.cjs — 「这条 IPC 回执能认领哪个 pending」的唯一判据。
//
// 为什么单独抽出来（2026-10-31 复核）：
// `ai:tree` / `ai:action_result` / `ai:evaluate_result` 三个通道此前只按 `payload.id`
// 取 pending，不校验 sender。requestId 是 `++` 自增（可枚举），于是任何能发 IPC 的
// 上下文都能"撞号"认领别人的请求 —— 页面脚本通过 `window.__ai_browser__.sendTree`
// 循环 id=1..N 就能把一棵假树喂给 agent（把"确认支付"换成"取消"这类）。
//
// 判据必须同时满足三条：
//   1. sender 归属明确（能反查到 tabId，反查不到 = 不是本应用的页面）；
//   2. pending 存在（撞空不算认领）；
//   3. kind 与通道一致（action 的回执不能冒充 tree）—— 通道没有 kind 时跳过。
//
// 放在 .cjs 里是为了能被 PageManager（ESM）与单测直接默认导入。

/**
 * @param {object} o
 * @param {number|null|undefined} o.senderTab  发起者归属的 tabId（反查结果）
 * @param {object|null|undefined} o.pending    待回执的请求
 * @param {string} [o.expectedKind]             该通道期望的 kind
 * @returns {boolean}
 */
function acceptResult(o) {
  const opts = o || {};
  const senderTab = opts.senderTab;
  // 用 == null 而不是 !senderTab：tabId 可能是 0。
  if (senderTab === null || senderTab === undefined) return false;
  const pending = opts.pending;
  if (!pending) return false;
  if (pending.tabId !== senderTab) return false;
  if (opts.expectedKind && pending.kind !== opts.expectedKind) return false;
  return true;
}

/**
 * watcher 事件必须带得出发起 tab：不知道来自哪的事件不许广播
 * （否则页面可以伪造 dom_change 把 agent 引到别的页面上）。
 * @returns {number|null}
 */
function eventFromTab(o) {
  const t = (o || {}).senderTab;
  return (t === null || t === undefined) ? null : t;
}

module.exports = { acceptResult, eventFromTab };

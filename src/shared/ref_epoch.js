// shared/ref_epoch.js — 给「目标找不到」补上一个关键区分：**ref 过期了，还是从来没对过**。
//
// 问题（真实排查记录）：agent 从 get_tree 拿到 `e:button-12`，点下去回
// `target_not_found`。它面对两种完全不同的处境，却收到同一句话：
//   a) 页面在这两次调用之间变了（SPA 重渲染、弹窗重开、列表翻页）→ 老 ref 作废，
//      正确做法是**重新 get_tree 拿新 ref**；
//   b) ref 从头就没对过（传了可见文字、抄错、来自另一个标签页）→ 重新 get_tree
//      也没用，要改的是传参方式。
// 分不清这两者时，agent 的典型反应是"重试同一个 ref"（因为错误信息里没说要换），
// 把一次本来 1 步的恢复拖成 3~5 步。
//
// 做法：每次 get_tree 成功就推进一个 per-tab 的 epoch，并记下这一版树里出现过的所有
// ref 属于哪一版。之后 ref 找不到时：
//   · ref 在某版树里出现过，且那版 < 当前版 → **stale**（过期），让它重读树；
//   · ref 一次都没出现过 → **never_seen**（形状/来源错），让它改传参；
//   · ref 就在当前版里，DOM 却查不到 → **present_in_tree**（树里有、点不到），
//     通常是在 iframe / shadow root 里，或节点已脱离文档 —— 换读法，不是换 ref。
//
// 边界诚实说明：这个追踪只知道**本进程内 get_tree 见过什么**。如果 agent 从别处
// 拿到 ref（自己拼的、上一次会话的），这里只会判成 never_seen —— 那也正是我们想让
// 它知道的事实。

/** 一个 tracker 管一个标签页。 */
export function newTracker() {
  return { epoch: 0, seen: new Map() }; // ref -> 见过它的最后一次 epoch
}

/**
 * 从语义树里收集所有 ref。节点的 id 就是 data-ai-id。
 * 只收字符串型 id；缺 id 的容器节点跳过。
 */
export function collectRefs(tree) {
  const refs = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (typeof n.id === 'string' && n.id) refs.push(n.id);
    const kids = n.children;
    if (Array.isArray(kids)) for (const k of kids) walk(k);
  })(tree);
  return refs;
}

/**
 * 推进 epoch 并登记这一版树里出现过的 ref。
 * @returns {number} 新的 epoch（从 1 开始，0 表示"还没有任何一版树"）
 */
export function bumpEpoch(tracker, refs) {
  tracker.epoch += 1;
  for (const r of refs) if (typeof r === 'string' && r) tracker.seen.set(r, tracker.epoch);
  return tracker.epoch;
}

/** 便捷入口：直接吃一棵树。 */
export function noteTree(tracker, tree) {
  return bumpEpoch(tracker, collectRefs(tree));
}

export const REF_STALE = 'stale';
export const REF_NEVER_SEEN = 'never_seen';
export const REF_PRESENT_IN_TREE = 'present_in_tree';

const HINTS = {
  [REF_STALE]: (o) =>
    `stale_ref: this ref was in semantic-tree v${o.ref_epoch}, the page has since been re-read (now v${o.tree_epoch}). ` +
    'Re-run get_tree and use a fresh ref — retrying the same one will keep failing.',
  [REF_NEVER_SEEN]: (o) =>
    `ref_never_seen: this ref is not in any of the ${o.tree_epoch} semantic tree(s) read so far. ` +
    'Most likely you passed visible text instead of a data-ai-id, mistyped it, or took it from another tab. ' +
    'Reading the tree again will not help by itself — fix the ref.',
  [REF_PRESENT_IN_TREE]: (o) =>
    `ref_present_in_tree: the ref is in the current tree (v${o.tree_epoch}) but the DOM query found nothing. ` +
    'It is probably inside an iframe / shadow root, or has been detached. Try the frame-aware read, or pick a nearby stable element.',
};

/**
 * 诊断一个找不到的 ref。
 *
 * @param {string} ref
 * @param {{epoch:number, seen:Map<string,number>}} tracker
 * @returns {{stale_ref:boolean, ref_epoch:number|null, tree_epoch:number, reason:string, hint:string}}
 */
export function diagnoseMissingRef(ref, tracker) {
  const treeEpoch = (tracker && tracker.epoch) || 0;
  const seenEpoch = tracker && tracker.seen ? tracker.seen.get(String(ref)) : undefined;

  let reason;
  if (seenEpoch === undefined || treeEpoch === 0) reason = REF_NEVER_SEEN;
  else if (seenEpoch < treeEpoch) reason = REF_STALE;
  else reason = REF_PRESENT_IN_TREE;

  const info = { ref_epoch: seenEpoch === undefined ? null : seenEpoch, tree_epoch: treeEpoch };
  return {
    stale_ref: reason === REF_STALE,
    ref_epoch: info.ref_epoch,
    tree_epoch: info.tree_epoch,
    reason,
    hint: HINTS[reason](info),
  };
}

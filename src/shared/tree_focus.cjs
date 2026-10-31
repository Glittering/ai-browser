// shared/tree_focus.cjs — `get_tree {focused_only:true}` 的唯一实现。
//
// 为什么要有它：`focused_only` 在 schema 里承诺了「只返回焦点子树」，参数也一路
// 传到了 preload（`ai:extract {focusedOnly}`），但抽取器**从来不读它** ——
// 调用方传了等于没传，而且拿到的还是整棵树（没有报错）。这是「声明 ≠ 实现」
// 里最贵的一类：agent 以为自己只拿到焦点附近，于是按那里的 id 去操作。
//
// 做法：在主进程里对**已经合并完帧**的树做聚焦裁剪。纯函数，可单测。
//
// 语义（写清楚，不然实施和调用方会各自想象）：
//   · 保留从根到焦点的**祖先链**（每层只留通向焦点的那一个孩子）；
//   · 保留焦点节点自己的**整棵子树**（它里面的候选列表、下拉项都还在）；
//   · 根节点上带 `focused_element_id`，与 `getFocused()` 的既有约定一致；
//   · 树里没有 `states:['focused']` 时返回 null —— 调用方必须能分辨
//     「焦点不在页面上」和「我读回来的是空的」。

/**
 * @param {object|null} tree
 * @returns {{tree: object|null, focus_id: string|null}}
 */
function focusOnly(tree) {
  if (!tree || typeof tree !== 'object') return { tree: null, focus_id: null };

  const path = [];
  let found = false;
  const walk = (node, stack) => {
    if (!node || found) return;
    const states = Array.isArray(node.states) ? node.states : [];
    if (states.indexOf('focused') >= 0) {
      found = true;
      path.push(...stack, node);
      return;
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) {
      walk(c, stack.concat([node]));
      if (found) return;
    }
  };
  walk(tree, []);

  if (!found || !path.length) return { tree: null, focus_id: null };

  // 焦点节点的 id 必须在重建**之前**取 —— 重建之后最外层是根，id 会变成根。
  const focusId = path[path.length - 1].id || null;

  // 从焦点往上重建：每层父节点只保留通向焦点的那一个孩子。
  let rebuilt = path[path.length - 1];
  for (let i = path.length - 2; i >= 0; i--) {
    rebuilt = { ...path[i], children: [rebuilt] };
  }
  return {
    tree: { ...rebuilt, focused_element_id: focusId, focused_only: true },
    focus_id: focusId,
  };
}

module.exports = { focusOnly };

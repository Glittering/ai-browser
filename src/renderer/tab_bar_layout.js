// renderer/tab_bar_layout.js — 标签栏的分组布局（纯函数，无 DOM）。
//
// 为什么单独一个文件：把"哪些标签页属于哪个组、哪个组展开着、展开后长什么样"
// 从 DOM 里抽出来，才能在 vitest 里钉住行为（tests/test_tab_bar_layout.js）。
// 靠人肉把鼠标移上去验证一个折叠交互，等于没验证 —— 它挂了也只会在某个没人
// 注意的下午被发现。
//
// 两种加载方式：<script src> 挂到 window.TabBarLayout（标签栏），
// require() 拿到同一份对象（单测）。逻辑只有一处。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TabBarLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HUMAN = 'human';

  /** 初始状态。用数组而不是 Set：状态要能比较、能打印、能断言。 */
  function empty() {
    return { expanded: [], pinned: [] };
  }

  function norm(s) {
    s = s || {};
    return { expanded: new Set(s.expanded || []), pinned: new Set(s.pinned || []) };
  }

  function dump(s) {
    return { expanded: Array.from(s.expanded).sort(), pinned: Array.from(s.pinned).sort() };
  }

  /** 鼠标悬停到某个组：展开它。人的组没有可展开的东西。 */
  function hover(state, group) {
    const s = norm(state);
    if (group && group !== HUMAN) s.expanded.add(group);
    return dump(s);
  }

  /** 点击 pill：钉住（鼠标移开也不收起） / 取消钉住。 */
  function toggle(state, group) {
    const s = norm(state);
    if (!group || group === HUMAN) return dump(s);
    if (s.pinned.has(group)) {
      s.pinned.delete(group);
      s.expanded.delete(group);
    } else {
      s.pinned.add(group);
      s.expanded.add(group);
    }
    return dump(s);
  }

  /**
   * 鼠标离开标签条：收起没被钉住的组 —— 但**正在看的那一组不收起**。
   * 否则人切到某个 agent 的页面后，鼠标一移开那一页就从标签条上消失了，
   * 只能对着地址栏猜"这是谁的页面"。
   */
  function leave(state, activeGroup) {
    const s = norm(state);
    for (const g of Array.from(s.expanded)) {
      if (s.pinned.has(g) || g === activeGroup) continue;
      s.expanded.delete(g);
    }
    return dump(s);
  }

  /**
   * 渲染清单：把标签页数组摊平成"先人的页、再每个组一个 pill（展开时后面跟它的页）"。
   *
   * 返回 { items, state, activeGroup }：
   *   items: {type:'tab'|'group', ...} 顺序即标签条上的顺序
   *   state: 归一化后的展开/钉住状态（"正在看的那一组"会被强制展开）
   */
  function build(tabs, state) {
    const s = norm(state);
    const list0 = Array.isArray(tabs) ? tabs : [];
    const active = list0.find((t) => t.active);
    const activeGroup = active ? (active.group || HUMAN) : null;
    // 正在看的那一页所在的组必须展开，理由见 leave()。
    if (activeGroup && activeGroup !== HUMAN) s.expanded.add(activeGroup);

    // 按组归拢，组的顺序 = 每组第一页出现的顺序（人的页在它自己的位置上）。
    const order = [];
    const byGroup = new Map();
    for (const t of list0) {
      const g = t.group || HUMAN;
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g).push(t);
    }

    const items = [];
    for (const g of order) {
      const list = byGroup.get(g);
      if (g === HUMAN) {
        for (const tab of list) items.push({ type: 'tab', tab: tab });
        continue;
      }
      const head = list[0];
      const open = s.expanded.has(g);
      items.push({
        type: 'group',
        id: g,
        label: head.group_label || g,
        count: list.length,
        limit: head.group_limit || null,
        color: head.group_color || null,
        open: open,
      });
      if (open) {
        for (const tab of list) {
          items.push({ type: 'tab', tab: tab, inGroup: true, color: head.group_color || null });
        }
      }
    }
    return { items: items, state: dump(s), activeGroup: activeGroup };
  }

  /** 结构签名：只有它变了才重建 DOM（每 1.5s 重画会把滚动位置冲掉）。 */
  function signature(tabs, state) {
    const list = Array.isArray(tabs) ? tabs : [];
    const exp = state && state.expanded ? Array.from(state.expanded).slice().sort().join(',') : '';
    return list.map((t) => t.id + ':' + (t.group || HUMAN)).join(',') + '#' + exp;
  }

  return {
    HUMAN: HUMAN,
    empty: empty,
    hover: hover,
    toggle: toggle,
    leave: leave,
    build: build,
    signature: signature,
  };
});

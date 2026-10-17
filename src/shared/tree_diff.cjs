// 悬停前后两棵语义树的差异（ui.peek 的核心）。
//
// 数据源从 AX 换成 DOM 语义树，是实测逼出来的两个理由：
//
// 1. 自绘菜单在 AX 里是「无名的 generic」。实测（tools/_oneoff/peek 对照页）：
//    一个 hover 后展开的纯 div 菜单，AX 报 7 个新节点，但两个菜单项都长这样 ——
//      generic ""            ← 名字是空的，文字跑到子节点 StaticText 去了
//      StaticText "普通选项一"
//    而 AX 侧的"可交互"判据是 role 名单 / editable / focusable，generic 一条都不占
//    → 被过滤掉 → peek 对这类菜单一律报空。DOM 读层有 isHumanClickable +
//    floatingLayerOf + elementName，正好能认出它们（同一次实测：DOM 侧报出 2 项，
//    都带 actions=["click"] 和坐标）。
//
// 2. 更致命：AX 的 id 形如 ax-{backendNodeId}，动作层解析不了（实测
//    "Target not found for ref: ax-291"）。就算 AX 探到了，报出去的 id 也点不了。
//    DOM 的 e:div-N 是 ui.act 直接可用的。
//
// 代价：DOM 抽取会写 data-ai-id 属性（get_tree 本来就在做，peek 此前也调
// ensureHandles 打过标记），不再是"纯读"。换取的是报出来的东西真能点。

// 拍平。保留根节点（它是 body 的映射，diff 时两边一致，会被自然抵消）。
function flattenTree(root) {
  var out = [];
  (function walk(n) {
    if (!n) return;
    out.push(n);
    var kids = n.children || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  })(root);
  return out;
}

// 输出给调用方的精简节点。带 actions 与 bounds，是为了让"探到了"直接等于"能点"。
function toLite(n) {
  var o = { id: n.id, role: n.role || 'generic', label: n.label == null ? '' : n.label };
  if (n.actions && n.actions.length) o.actions = n.actions.slice();
  if (n.bounds) o.bounds = n.bounds;
  return o;
}

// 位置对得上就算同一个（菜单重开时会有 1~2px 的抖动）。
function sameBounds(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4
    && Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4;
}

// 菜单收起再展开时，DOM 节点是新造的，id 跟着变 —— 上一张快照报出去的 id 就点不动了
// （实测 B站 头部「收藏」：revertMs=0 把鼠标移回目标后，原先报出的三个 id
// e:div-208 / e:div-209 / e:a-229 全部消失）。想让"探到就能点"成立，必须把 id
// 重新绑到新节点上。
//
// 认亲用 (role, label, bounds) 三元组：同一个菜单项重开后文本和位置不会变，
// 而 id 会。三者全中才认，宁可对不上也不乱指 —— 对不上时保留原 id，调用方会拿到
// target_not_found，这比悄悄点到别的东西上安全得多。
function remapIds(liteNodes, nowNodes) {
  var now = nowNodes || [];
  return (liteNodes || []).map(function (n) {
    var i;
    for (i = 0; i < now.length; i++) if (now[i].id === n.id) return n; // 还在就别动
    for (i = 0; i < now.length; i++) {
      var c = now[i];
      if (c.role === n.role && (c.label || '') === (n.label || '') && sameBounds(c.bounds, n.bounds)) {
        // 只换 id，其余（actions / bounds）沿用原来那份 —— 重绑是为了让 id 活过来，
        // 不是为了重算一次，顺手把已经报给调用方的信息弄丢反而更糟。
        var o = {};
        for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) o[k] = n[k];
        o.id = c.id;
        return o;
      }
    }
    return n;
  });
}

// 可点的排前面：悬停探出来的东西里，菜单项永远比包裹它的容器有用。
function actionableFirst(a, b) {
  var ac = (a.actions && a.actions.length) ? 1 : 0;
  var bc = (b.actions && b.actions.length) ? 1 : 0;
  if (ac !== bc) return bc - ac;
  return 0;
}

function diffTree(beforeNodes, afterNodes) {
  var before = beforeNodes || [];
  var after = afterNodes || [];
  var bi = {}, ai = {}, i;
  for (i = 0; i < before.length; i++) if (before[i] && before[i].id != null) bi[before[i].id] = before[i];
  for (i = 0; i < after.length; i++) if (after[i] && after[i].id != null) ai[after[i].id] = after[i];
  var revealed = [], hidden = [];
  for (i = 0; i < after.length; i++) {
    var n = after[i];
    if (!n || n.id == null) continue;
    if (!Object.prototype.hasOwnProperty.call(bi, n.id)) revealed.push(toLite(n));
  }
  for (i = 0; i < before.length; i++) {
    var m = before[i];
    if (!m || m.id == null) continue;
    if (!Object.prototype.hasOwnProperty.call(ai, m.id)) hidden.push(toLite(m));
  }
  revealed.sort(actionableFirst);
  return { revealed: revealed, hidden: hidden };
}

module.exports = { flattenTree, diffTree, toLite, remapIds, sameBounds };

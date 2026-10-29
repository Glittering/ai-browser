// main/axExtractor.js — AX-tree read layer (P0 probe foundation)
//
// P0 goal (see .trae/documents/replan-ax-tree-bottom-up.md): replace reading the
// page from hand-written DOM heuristics (preload/extractor.cjs) with the browser's
// own semantic layer (CDP Accessibility.getFullAXTree). The OPERATION layer stays
// CDP and is unchanged; AX and CDP are fused by `data-ai-id`.
//
//  - normalizeAxTree(rawNodes): PURE. Raw CDP AXNode[] -> contract TreeNode.
//     No Electron/DOM dependency, so it is unit-testable under plain Node. No
//     frame/class/script heuristics.
//  - extractFromDebugger(dbg): RUNTIME. Wires Electron's webContents.debugger:
//     Accessibility.enable + getFullAXTree -> normalize -> stamp data-ai-id onto
//     the real DOM via DOM.describeNode(backendNodeId) then DOM.setAttributeValue.
//
// This module is ADDITIVE: nothing here is called by the default getTree path yet.

// node.value 的截断契约（legacy 读层 src/preload/extractor.cjs 用同一个 helper，
// 两条读层不得各自实现 slice）。
import valueContract from '../shared/value_contract.cjs';
const { truncateNodeValue } = valueContract;

// --- Pure: raw AXNode[] -> contract TreeNode -----------------------------
// Raw AXNode (CDP Accessibility.AXNode):
//   { nodeId, ignored, role:{value}, name:{value}, value:{value},
//     properties:[{name, value:{type, value}}], backendDOMNodeId,
//     bounds:{x,y,width,height}, childIds:[] }

const VERSION_TAG = 'ax-0.1';

function prop(nodes, nodeId, name) {
  const n = nodes.get(nodeId);
  if (!n) return null;
  const p = (n.properties || []).find((q) => q.name === name);
  return p ? p.value : null;
}

function valueOf(pv) {
  return pv && typeof pv.value !== 'undefined' ? pv.value : null;
}

// AX gives div[contenteditable] the role `generic` plus `editable=richtext`.
// The only "rule" we keep (plan §5): fold that into a semantic `textbox`.
function editorTypeFrom(role, editable) {
  if (editable === 'richtext' || editable === 'contenteditable') return 'richtext';
  // searchbox 与 textbox 同为可输入面，只是语义上被标成搜索框。此前只认
  // textbox，导致 role=searchbox 的输入框**完全不出现在树的可编辑索引里** ——
  // 于是"两个 editable"的场景里少算了一个，primary 反而可能指错。
  if (role === 'textbox' || role === 'searchbox') {
    if (editable === 'multiline') return 'textarea';
    if (editable === 'plaintext') return 'textbox';
  }
  return null;
}

function actionsFor(role) {
  switch (role) {
    case 'button': case 'link': return ['click', 'focus', 'hover'];
    case 'textbox': return ['type', 'setContent', 'clear', 'focus'];
    case 'select': return ['select', 'focus'];
    case 'slider': return ['scroll_to', 'focus'];
    case 'checkbox': case 'radio': return ['click', 'focus'];
    // dialog/alertdialog 曾经也广告 ['open','close']，与 extractor.cjs 是同一个错：
    // page_manager.performAction 与 preload actions.cjs 都没有这两个 case，调用只会
    // 拿到 "Unknown action"。语义树（AX 路径）自述了做不到的动作，agent 照着做必然
    // 失败。弹窗里真正能点的按钮本身就带 ['click','focus']，给空数组不损失能力。
    case 'dialog': case 'alertdialog': return [];
    default: return [];
  }
}

function statesFor(node) {
  const states = [];
  for (const p of node.properties || []) {
    const v = p.value;
    if (!v || v.type !== 'boolean' || v.value !== true) continue;
    if (p.name === 'read-only') { states.push('readonly'); continue; }
    if (p.name === 'hidden') continue;
    // required 在下面单独处理（要给出与 DOM 路径同一份语义）。这里跳过，
    // 否则 states 里会出现两个 "required"。
    if (p.name === 'required') continue;
    if (p.name === 'invalid') continue; // 字符串属性，下面单独处理
    states.push(p.name); // focusable/disabled/focused/checked/selected/settable/multiline/visible...
  }
  // 必填 / 无效（P2-2）。AX 把 aria-required 和原生 required 都折成 `required`，
  // 把 aria-invalid 折成 `invalid`（字符串：false | true | grammar | spelling）。
  // 这两个信号此前完全不在 states 里，于是"掘金红*必填"和"字段已判错"都只能靠
  // 截图猜 —— 而红色星号在无样式/色盲场景下本来就不是可靠信号。
  const req = prop(nodeStore, node.nodeId, 'required');
  if (req && req.value === true) states.push('required');
  const invalid = prop(nodeStore, node.nodeId, 'invalid');
  if (invalid && typeof invalid.value === 'string' && invalid.value !== 'false') {
    states.push('invalid');
    if (invalid.value !== 'true') states.push('invalid=' + invalid.value); // grammar / spelling
  }
  // raw `editable` stays available to callers that need the primitive signal
  const editable = nodeStore ? valueOf(prop(nodeStore, node.nodeId, 'editable')) : null;
  if (editable) states.push('editable=' + editable);
  return states;
}

let nodeStore = null; // current normalize pass's node map (see normalizeAxTree)
// Nodes already emitted in this pass. Needed because we walk *through* ignored
// wrappers (§buildThroughIgnored); an AX node that a wrapper re-parents must not
// be emitted twice.
let seenNodes = null;
// 本次 pass 收集到的"可编辑节点"清单，pass 结束时汇总成 tree.editors（见
// summarizeEditors）。为什么要在树根上放索引：一个页面上有多个 editable 时，
// 树的结构本身**不告诉你哪个是正文**。2026-10-19 知乎实机：顶部搜索框和
// 正文编辑器都带 editable，按 editable 过滤先抓到搜索框（DOM 顺序在前），
// 第一次粘贴直接糊进搜索框，靠字数校验才拦住没提交。
// 面积是这里唯一可靠的区分信号（搜索框 300×36 vs 正文 720×600，差 30 倍），
// 而它已经在每个节点的 bounds 里 —— 不需要额外读 DOM。
let editables = null;

// Descendants of an AX node that is `ignored: true`. AX marks presentational
// wrappers (a `span` in a flex row, `<b>` inside a paragraph) as ignored, but
// the text under them is real content — dropping the wrapper must not drop the
// subtree. This is the P2-1 cause: a list row's title lives in such a span, so
// the row came back as `[button] 编辑` and nothing else.
function buildThroughIgnored(node, idFor) {
  const out = [];
  for (const cid of node.childIds || []) {
    const c = nodeStore.get(cid);
    if (!c || seenNodes.has(c.nodeId)) continue;
    if (c.ignored) { out.push(...buildThroughIgnored(c, idFor)); continue; }
    seenNodes.add(c.nodeId);
    out.push(build(c, idFor));
  }
  return out;
}

function build(node, idFor) {
  const rawRole = (node.role && node.role.value) || 'generic';
  const editable = valueOf(prop(nodeStore, node.nodeId, 'editable'));
  const editorType = editorTypeFrom(rawRole, editable);
  const role = (rawRole === 'generic' && editorType === 'richtext') ? 'textbox' : rawRole;

  const tn = {
    id: idFor(node),
    role,
    label: (node.name && node.name.value) || '',
    states: statesFor(node),
    actions: actionsFor(role),
    bounds: {
      x: Math.round((node.bounds && node.bounds.x) || 0),
      y: Math.round((node.bounds && node.bounds.y) || 0),
      width: Math.round((node.bounds && node.bounds.width) || 0),
      height: Math.round((node.bounds && node.bounds.height) || 0),
    },
  };
  if (node.backendDOMNodeId != null) tn.backendDOMNodeId = node.backendDOMNodeId;
  if (editorType) {
    tn.editor_type = editorType;
    noteEditable(tn, editorType, node);
  }

  if (role === 'textbox' || role === 'combobox' || role === 'listbox' || role === 'searchbox') {
    let v = valueOf(node.value);
    if ((v == null || v === '') && readValue) v = readValue(node);
    // 密码框：AX 用 protected 属性标记。不返回值、长度或取全量提示。
    const isProtected = valueOf(prop(nodeStore, node.nodeId, 'protected')) === true;
    if (isProtected) {
      tn.value_sensitive = true;
      tn.value_sensitive_reason = 'password';
    } else if (v != null && v !== '') {
      // 与 legacy 读层共用同一截断契约（src/shared/value_contract.cjs）：
      // code point 计数，截断时带 value_truncated / value_full_length /
      // value_fetch_ref，未截断只给 value。
      const cut = truncateNodeValue(String(v), tn.id, 200);
      tn.value = cut.value;
      if (cut.value_truncated) {
        tn.value_truncated = true;
        tn.value_full_length = cut.value_full_length;
        tn.value_length_unit = cut.value_length_unit;
        tn.value_fetch_ref = cut.value_fetch_ref;
      }
    }
  }

  const kids = [];
  for (const cid of node.childIds || []) {
    const c = nodeStore.get(cid);
    if (!c || seenNodes.has(c.nodeId)) continue;
    // 被 AX 标为 ignored 的只是包裹层（见 buildThroughIgnored）；它的子节点
    // 才是内容，必须被提升上来而不是连同子树一起丢掉。
    if (c.ignored) { kids.push(...buildThroughIgnored(c, idFor)); continue; }
    if (isRedundantInlineBox(c, tn.label)) {
      // 也要登记 seen：剪掉的节点如果还能从别的路径（被提升上来的 ignored
      // 包裹层）走一遍，就会重新出现在树里，剪枝变成随机的。
      seenNodes.add(c.nodeId);
      continue;
    }
    seenNodes.add(c.nodeId);
    kids.push(build(c, idFor));
  }
  if (kids.length) tn.children = kids;
  return tn;
}

// 「这个输入框是不是搜索框」的判据。role=searchbox 是最强信号；其次是
// placeholder/label 里的词。两者都没有时就靠面积（搜索框永远比正文小得多）。
// 只用来**标注**，不用来排除 —— 排除错一个真编辑器，代价是 agent 找不到
// 能写的地方。
const SEARCH_LIKE = /搜索|查找|检索|search|find/i;

// 面积下限：AX 里存在 1px 的表单元素（隐藏 input、脚手架占位），它们的
// bounds 是 0 或 1，算进清单里只会制造噪音。
const EDITABLE_MIN_AREA = 800;
// 「像个正文编辑器」的下限。200×100 是保守值：真实正文区都在 400×200 以上，
// 而搜索框在 300×36 量级。达不到就不给 primary —— 宁可让调用方自己看图，
// 也不要指错。
const PRIMARY_MIN_AREA = 20000;

function noteEditable(tn, editorType, node) {
  if (!editables) return;
  const b = tn.bounds || {};
  const w = Number(b.width) || 0;
  const h = Number(b.height) || 0;
  const area = w * h;
  if (area < EDITABLE_MIN_AREA) return;
  const ph = String(valueOf(prop(nodeStore, node.nodeId, 'placeholder')) || '');
  const label = String(tn.label || '');
  const searchlike = tn.role === 'searchbox'
    || SEARCH_LIKE.test(ph)
    || SEARCH_LIKE.test(label);
  editables.push({
    ref: tn.id,
    role: tn.role,
    editor_type: editorType,
    label: label.slice(0, 40),
    ...(ph ? { placeholder: ph.slice(0, 40) } : {}),
    w,
    h,
    area,
    readonly: (tn.states || []).indexOf('readonly') >= 0,
    ...(searchlike ? { searchlike: true } : {}),
  });
}

/**
 * 把本 pass 收集到的可编辑节点汇总成树根上的 `editors` 索引。
 *
 * 存在的唯一理由：**树的结构不告诉你哪个 editable 是正文**。按 DOM 顺序
 * 过滤 `editable` 拿到的是页面上第一个可输入的东西 —— 在知乎是顶部搜索框，
 * 在掘金是登录框。agent 没法从 `[textbox] editable=richtext` 这一行判断
 * "这是不是我要写的那个"，于是它要么猜，要么一个个试，要么把自己的正文
 * 糊进搜索框（2026-10-19 真实发生，靠字数校验才拦住）。
 *
 * 输出按面积降序，`primary: true` 标给最大的那个非搜索非只读编辑区。
 * 只有 1 个可编辑节点时**不输出**：没有歧义就不该多花 token。
 *
 * @returns {Array|undefined} 0/1 个节点返回 undefined
 */
export function summarizeEditors(list) {
  if (!Array.isArray(list) || list.length < 2) return undefined;
  const sorted = list.slice().sort((a, b) => b.area - a.area).slice(0, 8);
  let primary = null;
  for (const e of sorted) {
    if (e.readonly || e.searchlike) continue;
    if (e.area < PRIMARY_MIN_AREA) break; // 最大的可用编辑区都不像正文
    primary = e.ref;
    break;
  }
  // area 不外露：w/h 已经够了，重复字段只多花 token。
  return sorted.map(({ area, ...rest }) => (rest.ref === primary ? { ...rest, primary: true } : rest));
}

/**
 * `InlineTextBox` 是 CDP 把一个 `StaticText` 按**换行和样式**切出来的文字碎片：
 * 一段两行的正文会变成两个 inline box，一个加粗的词再切一个。
 *
 * 它们不是结构，是排版产物。实测 CSDN 长文（2026-10-19）：
 * AX 树 493 个节点里 163 个是 InlineTextBox，剪掉后
 * **体积 84 420 → 64 054 bytes（-24%）、正文字数 5182 一字不差**。
 * 这条读法现在被 page_coverage 推荐给"要读正文"的调用方，它贵 24% 就是
 * 每次读文章都多花 24% 的 token。
 *
 * 判据是**内容已被父节点包含**，不是"角色叫 InlineTextBox 就删"：
 * 万一某个 StaticText 的 name 是空的、文字只在 inline box 上，
 * 删掉就是丢字 —— 那比省 24% 严重得多。所以这里只删"父节点 label 里
 * 已经写着这段文字"的那一种；拿不准的一律保留，宁可多一个节点。
 *
 * 只在叶子时剪：有子节点的 inline box 意味着还有别的东西挂在下面。
 */
function isRedundantInlineBox(rawChild, parentLabel) {
  const role = (rawChild.role && rawChild.role.value) || '';
  if (role !== 'InlineTextBox') return false;
  if (rawChild.childIds && rawChild.childIds.length) return false;
  const text = (rawChild.name && rawChild.name.value) || '';
  // 空 label 的节点没有任何信息，一起剪掉；父节点为空的场景上面已经排除了
  // （parentLabel 为空时 indexOf 必为 -1，不会命中）。
  if (!text) return !!parentLabel;
  return !!parentLabel && parentLabel.indexOf(text) >= 0;
}

let readValue = null; // opts.readValue — per-node DOM read hook for textbox values

// 容器角色：这些角色的 AX name 在 Chromium 里是**从子树内容算出来的**（name from
// contents），所以一个 listitem / generic 的 label 可能是一整段预览文字的拼接。
// 2026-10-25 知乎私信：`<div class="ChatUserListItem">` 的 label 就是
// "创作者小助手 10-21 ☄️最新一期「创作打卡挑战赛」活动来喽！…"，于是按文字找链接
// 会命中这个行容器（点它只选中会话，不跳转），而真正的 `<a>创作打卡挑战赛第五十四期</a>`
// 在会话面板里。用户看到的现象就是"树里有、点不动"。
//
// 判据（纯结构、不看站点）：角色是容器 + 有子孙节点 + 某个子孙的 label（≥4 字）是
// 自己 label 的**真子串且更短** —— 说明这段文字不是它自己的，是从下面拼上来的。
// 命中就打 `agg: 1`。读树的人（和 agent）看到 agg 就知道"这是容器，文字归子节点"。
const AGG_CONTAINER_ROLES = {
  generic: 1, group: 1, list: 1, listitem: 1, row: 1, cell: 1, gridcell: 1,
  section: 1, main: 1, article: 1, navigation: 1, complementary: 1, form: 1,
  table: 1, rowgroup: 1, toolbar: 1, tablist: 1, menu: 1, tabpanel: 1, document: 1,
};

export function markAggregatedLabels(tree) {
  const visit = (n) => {
    if (!n) return { labels: [] };
    const kids = (n.children || []).map(visit);
    const descendantLabels = [];
    for (const k of kids) {
      if (k.self) descendantLabels.push(k.self);
      for (const l of k.labels) descendantLabels.push(l);
    }
    const label = String(n.label || '');
    if (AGG_CONTAINER_ROLES[n.role] && label.length >= 8 && descendantLabels.length) {
      const aggregated = descendantLabels.some((l) => l.length >= 4 && l.length < label.length && label.indexOf(l) >= 0);
      if (aggregated) n.agg = 1;
    }
    return { self: label.length >= 4 ? label : '', labels: descendantLabels };
  };
  visit(tree);
  return tree;
}

// Public pure API.
// opts: { idFor: (node)=>string, readValue: (node)=>string }
export function normalizeAxTree(rawNodes, opts = {}) {
  // nodeStore keeps ignored nodes too: we never *emit* them, but we must walk
  // through them (see buildThroughIgnored). Indexing only the live ones was the
  // second half of the P2-1 bug — the wrapper was in the map lookup's blind spot
  // and its children became unreachable.
  const all = (rawNodes || []).filter(Boolean);
  const live = all.filter((n) => !n.ignored);
  nodeStore = new Map(all.map((n) => [n.nodeId, n]));
  seenNodes = new Set();
  readValue = opts.readValue || null;
  editables = [];
  const idFor = opts.idFor || ((n) => 'ax-' + n.nodeId);

  // Parent map over ALL nodes, so "is this a root?" accounts for ignored
  // ancestors: a live node under an ignored wrapper is not a root.
  const parentOf = new Map();
  for (const n of all) for (const c of n.childIds || []) if (c != null && !parentOf.has(c)) parentOf.set(c, n.nodeId);
  const hasLiveAncestor = (n) => {
    let p = parentOf.get(n.nodeId); let guard = 0;
    while (p != null && guard++ < 64) {
      const pn = nodeStore.get(p);
      if (!pn) return false;
      if (!pn.ignored) return true;
      p = parentOf.get(p);
    }
    return false;
  };
  const roots = live.filter((n) => !hasLiveAncestor(n));

  for (const r of roots) seenNodes.add(r.nodeId);
  const built = roots.map((n) => build(n, idFor));
  const tree = built.length === 1
    ? built[0]
    : { id: 'root', role: 'generic', label: '', states: ['visible'], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, children: built };
  markAggregatedLabels(tree);
  tree._debug = { layer: 'ax', version: VERSION_TAG };
  // 有歧义时才给索引（见 summarizeEditors）。挂在树根而不是散在各节点上：
  // 调用方读一次根就能挑好目标，不用把整棵树扫一遍再自己比面积。
  const editors = summarizeEditors(editables);
  if (editors) tree.editors = editors;
  editables = null;
  nodeStore = null;
  seenNodes = null;
  readValue = null;
  return tree;
}

// C: PURE MERGE. Splices out-of-process sub-frame trees into the main AX tree.
// Input `mainTree` is the top-frame normalized tree; each `frame` is
// { key, label, tree } where `tree` is that child frame's normalized tree
// (ids already prefixed by the caller's idFor so they cannot collide with the
// main frame's `ax-{backendDOMNodeId}`). Sub-frame editable/interactive nodes
// are lifted under a single role=Iframe gate so the caller's tree walker sees
// them without needing to know about frame topology. Pure — no predicate on
// mainTree.shape; a single-root main tree is wrapped into a container.
export function mergeFrameTrees(mainTree, frames = []) {
  if (!mainTree) return mainTree;
  const usable = (frames || []).filter((f) => f && f.tree);
  if (!usable.length) return mainTree;

  // Lift interactive/editable subtrees AND text blocks out of each frame tree
  // (frame roots are usually generic wrappers; keep their leaves, drop pure layout).
  //
  // 为什么内容块也要留：这个函数原来只留 `actions.length > 0` 的节点，也就是
  // 只有"能点的东西"算数。于是跨进程 frame 里的标题/列表/表格单元——也就是
  // agent 真正要**读懂**的东西——即使被读出来也会在这里被丢第二次（第一次是
  // 采集端的选择器）。超星泛雅的章节列表就是这么整片消失的。
  const CONTENT_ROLES = new Set(['text', 'heading', 'listitem', 'cell', 'paragraph', 'term', 'note']);
  const lift = (tv) => {
    const out = [];
    (function w(t, depth) {
      if (!t) return;
      // Keep any actionable/editable node or text block (skip generic layout
      // wrappers), regardless of depth — so a single-leaf root is kept.
      const keep = t.role !== 'generic'
        && ((t.actions || []).length > 0 || CONTENT_ROLES.has(t.role));
      if (keep) { out.push(t); return; }
      for (const c of t.children || []) w(c, depth + 1);
    })(tv, 0);
    return out;
  };
  const gates = usable.map((f) => ({
    id: f.key,
    role: 'Iframe',
    label: f.label || '子框架',
    states: ['visible'],
    actions: [],
    // 绝对地址：树里出现的 iframe 应该能直接喂给 ui.new_tab / ui.navigate。
    // 相对 src 做不到这一点，等于让调用方自己去拼 base。
    ...(f.src ? { src: f.src } : {}),
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    children: lift(f.tree),
  }));

  if (mainTree.children && mainTree.children.length) {
    return { ...mainTree, children: [...mainTree.children, ...gates] };
  }
  // mainTree is a leaf root → promote to a container so gates can attach.
  return {
    id: 'root',
    role: 'generic',
    label: '',
    states: ['visible'],
    actions: [],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    children: [mainTree, ...gates],
  };
}

// AX role=dialog|alertdialog that is visible, plus its descendant buttons — the
// AX-native replacement for the class-keyword modal table (extractor's modalSelectors).
export function modalsFromAx(rawNodes) {
  const all = (rawNodes || []).filter(Boolean);
  const live = all.filter((n) => !n.ignored);
  // 与 normalizeAxTree 同一条规则：ignored 只是包裹层，遍历要穿过去（否则
  // ignored span 里的按钮永远数不到）。
  nodeStore = new Map(all.map((n) => [n.nodeId, n]));
  const dialogs = live.filter((n) => {
    const r = n.role && n.role.value;
    if (r !== 'dialog' && r !== 'alertdialog') return false;
    const b = n.bounds || {};
    return (b.width && b.height) || valueOf(prop(nodeStore, n.nodeId, 'visible'));
  });
  const out = [];
  for (const d of dialogs) {
    const buttons = [];
    const walk = (id) => {
      const n = nodeStore.get(id);
      if (!n) return;
      if (n.ignored) { for (const cid of n.childIds || []) walk(cid); return; }
      const r = n.role && n.role.value;
      if (r === 'button') {
        const btn = {
          text: ((n.name && n.name.value) || '').slice(0, 30),
          disabled: valueOf(prop(nodeStore, n.nodeId, 'disabled')) === true,
        };
        if (btn.text) buttons.push(btn);
      }
      for (const cid of n.childIds || []) walk(cid);
    };
    walk(d.nodeId);
    if (buttons.length) out.push({ buttons });
  }
  nodeStore = null;
  return out;
}

// --- Runtime: drive Electron webContents.debugger ------------------------
// dbg = view.webContents.debugger (already attached by page_manager._ensureCdp).
//
// C (plan §9.5): READING and STAMPING are now separate. `axRead` builds the
// semantic tree from AX alone and NEVER touches the DOM (no side effects, no
// per-read data-ai-id rewrite). `ensureHandles` materializes data-ai-id onto
// the real interactive elements, but only at the act/peek boundary and
// idempotently — existing data-ai-id (e.g. the default extractor's `e:...`)
// is preserved. ids are derived from backendDOMNodeId so they are stable
// across AX passes (vs AX nodeId which can resequence).

const interactiveRoles = { button: 1, link: 1, textbox: 1, combobox: 1, checkbox: 1, radio: 1, select: 1, option: 1, slider: 1, dialog: 1, alertdialog: 1, menuitem: 1, tab: 1 };

// Stable public id: backendDOMNodeId stays with its DOM element for the element's
// lifetime; fall back to AX nodeId for role-only nodes with no backing element.
function axId(n) { return n.backendDOMNodeId != null ? 'ax-' + n.backendDOMNodeId : 'ax-' + n.nodeId; }

function isInteractiveNode(n, byId) {
  const r = n.role && n.role.value;
  const editable = valueOf(prop(byId, n.nodeId, 'editable'));
  return !!interactiveRoles[r] || !!editable || valueOf(prop(byId, n.nodeId, 'focusable')) === true;
}

// Enabled AX + returns raw AXNode[] (also loads DOM doc so backendNodeId is usable).
async function axRaw(dbg) {
  await dbg.sendCommand('Accessibility.enable');
  const res = await dbg.sendCommand('Accessibility.getFullAXTree', {});
  const raw = (res && res.nodes) || [];
  if (!raw.length) return raw;
  await dbg.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
  return raw;
}

// C: PURE READ. Same {tree, context} shape as the default getTree, but derived
// from AX alone. No DOM mutation, ids = ax-{backendDOMNodeId} (stable).
export async function axRead(dbg) {
  const raw = await axRaw(dbg);
  if (!raw.length) return { tree: null, context: { modals: [] } };
  const tree = normalizeAxTree(raw, { idFor: axId, readValue: () => '' });
  const context = { modals: modalsFromAx(raw), session: {}, stats: { layer: 'ax' } };
  return { tree, context };
}

// Backward-compat alias: axRead is the current read path (previously stamping).
export async function extractFromDebugger(dbg) { return axRead(dbg); }

// C: IDEMPOTENT materialize. Adds data-ai-id to interactive backing elements.
// Never overwrites an existing handle (keeps default extractor's `e:...` ids
// intact). Net effect: read stays side-effect-free; act/peek get handles on demand.
export async function ensureHandles(dbg) {
  const raw = await axRaw(dbg);
  const byId = new Map(raw.filter((n) => !n.ignored).map((n) => [n.nodeId, n]));
  const stampOne = (objId, ai) => dbg.sendCommand('Runtime.callFunctionOn', {
    objectId: objId,
    functionDeclaration: `function(v){ var e=this,t=e&&e.nodeType||0; if(t!==1) return 'nonel'; var c=e.getAttribute('data-ai-id'); if(c) return c===v?'same':'keep'; e.setAttribute('data-ai-id',v); return 'set'; }`,
    arguments: [{ value: ai }],
    returnByValue: true,
  }).then((r) => r && r.result && r.result.value);
  const out = { set: 0, same: 0, kept: 0, skipped: 0 };
  for (const n of raw) {
    if (n.ignored || n.backendDOMNodeId == null) continue;
    if (!isInteractiveNode(n, byId)) continue;
    const ai = axId(n);
    let rd;
    try { rd = await dbg.sendCommand('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }); }
    catch (e) { out.skipped++; continue; } // cross-origin/OOPIF node — not reachable here
    const objId = rd && rd.object && rd.object.objectId;
    if (!objId) { out.skipped++; continue; }
    const s = await stampOne(objId, ai);
    if (s === 'set') out.set++;
    else if (s === 'same') out.same++;
    else out.kept++; // 'keep' or 'nonel'
  }
  out.handled = out.set + out.same;
  return out;
}

// 注意：这里原本有基于 AX 的 diffAx（ui.peek 用的差异比较）。它已删除，原因是
// 自绘菜单在 AX 里是"无名的 generic"、进不了 isInteractiveNode 的判据，peek 因此
// 对这类菜单一律报空；且它返回的 ax-* id 动作层解析不了，探到了也点不了。
// ui.peek 现在改用 DOM 语义树做差异，实现在 src/shared/tree_diff.cjs。

// C: read-only href resolution for actionable nodes. The AX read layer only knows
// "this is clickable", not "where it goes" (AX has no href). We lazily decorate
// link/button nodes with their absolute target `url` via DOM.resolveNode +
// Runtime.callFunctionOn (a read, no DOM mutation). Generic across sites — gives
// agents "where does clicking this take me" instead of guessing from the label.
const HREF_FN = `function(){var e=this,h=null;if(e.href&&typeof e.href==='string')h=e.href;if(!h&&e.closest){var a=e.closest('a[href]');if(a)h=a.href;}if(!h&&typeof e.getAttribute==='function'){var r=e.getAttribute('href');if(r)try{h=new URL(r, location.href).href;}catch(_){}}return h||null;}`;
const MAX_HREFS = 500;
export async function attachHrefs(dbg, tree) {
  if (!tree || !dbg) return tree;
  const targets = [];
  (function w(t) {
    if (!t) return;
    if ((t.role === 'link' || t.role === 'button') && t.backendDOMNodeId != null && !t.url) {
      if (targets.length < MAX_HREFS) targets.push(t);
    }
    for (const c of t.children || []) w(c);
  })(tree);
  if (!targets.length) return tree;
  const resolved = await Promise.all(targets.map(async (n) => {
    try {
      const rd = await dbg.sendCommand('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
      const objId = rd && rd.object && rd.object.objectId;
      if (!objId) return null;
      const c = await dbg.sendCommand('Runtime.callFunctionOn', { objectId: objId, functionDeclaration: HREF_FN, returnByValue: true });
      const v = c && c.result && c.result.value;
      return typeof v === 'string' && v ? v : null;
    } catch (e) { return null; } // cross-origin/OOPIF node — leave url unset
  }));
  for (let i = 0; i < targets.length; i++) if (resolved[i]) targets[i].url = resolved[i];
  return tree;
}

// Prune to the interactive/editable subtree. Keeps the root container as a
// wrapper plus every node that is actionable/editable (or has actionable
// descendants); drops layout-only branches. Pure and generic (role/actions
// based, no site heuristics) — the read-lowering mode for long feeds.
function isInteractive(tree) { return !!tree.editor_type || (tree.actions && tree.actions.length > 0) || !!tree.url; }

// 行容器（列表项 / 表格行 / 树项）在 prune 后常常只剩一个操作按钮：
// 标题是被剪掉的纯文本，而**纯文本正是"这是哪一行"的唯一线索**。B站稿件
// 管理列表因此每行只剩 `[button] 编辑`，无法定位目标条目（P2-1）。
// 对这类角色，若剪完 label 为空，就把首个文本后代的文字提升成行 label。
const ROW_ROLES = { listitem: 1, row: 1, treeitem: 1, cell: 1, gridcell: 1, article: 1 };
const MAX_ROW_LABEL = 120;
function firstTextOf(node) {
  if (!node) return '';
  const role = node.role || '';
  if (role === 'StaticText' || role === 'InlineTextBox') return String(node.label || '').trim();
  for (const c of node.children || []) {
    const t = firstTextOf(c);
    if (t) return t;
  }
  return '';
}

export function filterInteractive(tree) {
  if (!tree) return tree;
  const keep = (t) => {
    if (!t) return null;
    const kids = (t.children || []).map(keep).filter(Boolean);
    if (kids.length || isInteractive(t)) {
      if (!kids.length) return t;
      const node = { ...t, children: kids };
      if (ROW_ROLES[t.role] && !node.label) {
        const txt = firstTextOf(t);
        if (txt) node.label = txt.slice(0, MAX_ROW_LABEL);
      }
      return node;
    }
    return null;
  };
  const out = { ...tree, children: (tree.children || []).map(keep).filter(Boolean) };
  if (!out.children.length && !isInteractive(out)) return null;
  return out;
}

// Small memory-safe snapshot of interactive nodes (backendDOMNodeId -> lite),
// for incremental get_tree {ax:true, mode:'diff'} across reads without caching
// the full raw AX payload per tab. Pure.
export function liteSnapshot(rawNodes) {
  const valid = (rawNodes || []).filter((n) => n && !n.ignored);
  const byNodeId = new Map(valid.map((n) => [n.nodeId, n]));
  const out = new Map();
  for (const n of valid) {
    if (n.backendDOMNodeId == null) continue;
    if (!isInteractiveNode(n, byNodeId)) continue;
    out.set(n.backendDOMNodeId, {
      id: axId(n),
      role: (n.role && n.role.value) || 'generic',
      label: (n.name && n.name.value) || '',
    });
  }
  return out;
}

// Diff two lite snaccapshots by backendDOMNodeId -> { revealed, hidden }. Pure.
export function diffLite(prevLite, newLite) {
  const revealed = [], hidden = [];
  for (const [bid, n] of (newLite || new Map()).entries()) {
    if (!prevLite || !prevLite.has(bid)) revealed.push(n);
  }
  for (const [bid, n] of (prevLite || new Map()).entries()) {
    if (!newLite || !newLite.has(bid)) hidden.push(n);
  }
  return { revealed, hidden };
}

export default { normalizeAxTree, markAggregatedLabels, mergeFrameTrees, modalsFromAx, extractFromDebugger, axRead, axRaw, ensureHandles, attachHrefs, filterInteractive, liteSnapshot, diffLite, VERSION_TAG, summarizeEditors };
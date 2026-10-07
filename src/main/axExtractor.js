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
  if (role === 'textbox') {
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
    case 'dialog': case 'alertdialog': return ['open', 'close'];
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
    states.push(p.name); // focusable/disabled/focused/checked/selected/settable/multiline/visible...
  }
  // raw `editable` stays available to callers that need the primitive signal
  const editable = nodeStore ? valueOf(prop(nodeStore, node.nodeId, 'editable')) : null;
  if (editable) states.push('editable=' + editable);
  return states;
}

let nodeStore = null; // current normalize pass's node map (see normalizeAxTree)

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
  if (editorType) tn.editor_type = editorType;

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
    if (c && !c.ignored) kids.push(build(c, idFor));
  }
  if (kids.length) tn.children = kids;
  return tn;
}

let readValue = null; // opts.readValue — per-node DOM read hook for textbox values

// Public pure API.
// opts: { idFor: (node)=>string, readValue: (node)=>string }
export function normalizeAxTree(rawNodes, opts = {}) {
  const live = (rawNodes || []).filter((n) => n && !n.ignored);
  nodeStore = new Map(live.map((n) => [n.nodeId, n]));
  readValue = opts.readValue || null;
  const idFor = opts.idFor || ((n) => 'ax-' + n.nodeId);

  const childIds = new Set();
  for (const n of live) for (const c of n.childIds || []) if (c != null) childIds.add(c);
  const roots = live.filter((n) => !childIds.has(n.nodeId));

  const built = roots.map((n) => build(n, idFor));
  const tree = built.length === 1
    ? built[0]
    : { id: 'root', role: 'generic', label: '', states: ['visible'], actions: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, children: built };
  tree._debug = { layer: 'ax', version: VERSION_TAG };
  nodeStore = null;
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

  // Lift interactive/editable subtrees out of each frame tree (frame roots are
  // usually generic wrappers; keep their actionable leaves, drop pure layout).
  const lift = (tv) => {
    const out = [];
    (function w(t, depth) {
      if (!t) return;
      // Lift any actionable/editable node (skip generic layout wrappers),
      // regardless of depth — so a single-leaf interactive root is kept.
      const actionable = t.role !== 'generic' && (t.actions || []).length > 0;
      if (actionable) { out.push(t); return; }
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
  const live = (rawNodes || []).filter((n) => n && !n.ignored);
  nodeStore = new Map(live.map((n) => [n.nodeId, n]));
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
      if (!n || n.ignored) return;
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

export function interactiveIdSet(raw) {
  const byId = new Map(raw.filter((n) => !n.ignored).map((n) => [n.nodeId, n]));
  const s = new Set();
  for (const n of raw) if (!n.ignored && isInteractiveNode(n, byId)) s.add(n.nodeId);
  return s;
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

// A: PURE diff of two AX snapshots (pre/post a reveal) by nodeId. Returns only
// interactive nodes that newly appeared (revealed) or disappeared (hidden).
export function diffAx(beforeRaw, afterRaw) {
  const bm = new Map((beforeRaw || []).map((n) => [n.nodeId, n]));
  const am = new Map((afterRaw || []).map((n) => [n.nodeId, n]));
  const bi = interactiveIdSet(beforeRaw || []);
  const ai = interactiveIdSet(afterRaw || []);
  const toLite = (n) => ({
    id: axId(n),
    role: (n.role && n.role.value) || 'generic',
    label: (n.name && n.name.value) || '',
    backendDOMNodeId: n.backendDOMNodeId != null ? n.backendDOMNodeId : undefined,
  });
  const revealed = [], hidden = [];
  for (const id of ai) if (!bi.has(id)) { const n = am.get(id); if (n && !n.ignored) revealed.push(toLite(n)); }
  for (const id of bi) if (!ai.has(id)) { const n = bm.get(id); if (n && !n.ignored) hidden.push(toLite(n)); }
  return { revealed, hidden };
}

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
export function filterInteractive(tree) {
  if (!tree) return tree;
  const keep = (t) => {
    if (!t) return null;
    const kids = (t.children || []).map(keep).filter(Boolean);
    if (kids.length || isInteractive(t)) {
      if (!kids.length) return t;
      return { ...t, children: kids };
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

export default { normalizeAxTree, mergeFrameTrees, modalsFromAx, extractFromDebugger, axRead, axRaw, ensureHandles, diffAx, interactiveIdSet, attachHrefs, filterInteractive, liteSnapshot, diffLite, VERSION_TAG };
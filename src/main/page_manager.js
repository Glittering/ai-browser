// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView } from 'electron';
import { config } from '../shared/config.js';
import axExtractor from './axExtractor.js';
import { NetworkMonitor, MAX_POST_DATA_SIZE } from './network_monitor.js';
import { CanvasMonitor, isCanvasHookEnabled } from './canvas_monitor.js';
import { buildCanvasHookSource } from './canvas_hook_source.js';
import { diffValues, previewOf, safeByteLength, DEFAULT_SNAPSHOT_JS, DIFF_MAX_ENTRIES } from './snapshot_diff.js';
import { probeCapabilities } from './capability_probe.js';
import valueContract from '../shared/value_contract.cjs';

const { expandValueFetchTree } = valueContract;

// canvas 绘制调用记录：默认开。关闭开关 AI_BROWSER_CANVAS_HOOK=0。
const CANVAS_BRIDGE_KEY = '__aiCanvasBridge';

// 网络抓包默认开：只在有订阅时才启用会导致首屏/导航阶段的请求全丢（POST body、
// 请求头都拿不到）。关闭开关：AI_BROWSER_NETWORK_CAPTURE=0。
const NETWORK_CAPTURE_DEFAULT = !(process.env.AI_BROWSER_NETWORK_CAPTURE === '0' || process.env.AI_BROWSER_NETWORK_CAPTURE === 'false');

// 具名按键 → CDP Input.dispatchKeyEvent 参数。agent 用自然名字（'Delete'、
// 'Escape'、'ArrowRight'、'a'）而不是让人去查 Windows 虚拟键码。
// vk 用 Windows 虚拟键码（Chromium 在 macOS 上也按它解释）。
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Minus: { key: '-', code: 'Minus', vk: 189 },
  Equal: { key: '=', code: 'Equal', vk: 187 },
  '0': { key: '0', code: 'Digit0', vk: 48 },
  '1': { key: '1', code: 'Digit1', vk: 49 },
  '2': { key: '2', code: 'Digit2', vk: 50 },
  '3': { key: '3', code: 'Digit3', vk: 51 },
  '4': { key: '4', code: 'Digit4', vk: 52 },
  '5': { key: '5', code: 'Digit5', vk: 53 },
};

// 修饰键 → CDP modifiers 位掩码（Alt=1, Ctrl=2, Meta=4, Shift=8）。
function modifierMask(modifiers) {
  let m = 0;
  for (const k of modifiers || []) {
    const s = String(k).toLowerCase();
    if (s === 'alt' || s === 'option') m |= 1;
    else if (s === 'control' || s === 'ctrl') m |= 2;
    else if (s === 'meta' || s === 'cmd' || s === 'command') m |= 4;
    else if (s === 'shift') m |= 8;
  }
  return m;
}

/**
 * 解析一个按键名到 _cdpKey 需要的参数。支持具名键、单字符（字母/数字/符号）、
 * 以及 'Shift+Delete' / 'Meta+a' / 'Control+ArrowRight' 这类组合写法。
 * 返回 null 表示无法识别 —— 调用方报错，不静默发一个错误按键。
 */
function keySpec(name, extraModifiers) {
  const raw = String(name == null ? '' : name);
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const baseName = parts.length ? parts[parts.length - 1] : raw;
  const combos = parts.slice(0, -1);
  let mod = modifierMask([...(extraModifiers || []), ...combos]);

  let spec = NAMED_KEYS[baseName] || null;
  if (!spec && /^[a-zA-Z]$/.test(baseName)) {
    const up = baseName.toUpperCase();
    // key 用调用方给的大小写（'a' → 'a'），code 永远指物理键（'KeyA'）。
    // 曾经写成 `key: baseName !== up ? up : baseName` —— 对任何小写字母
    // baseName 都 !== 其大写，于是 'a' 被发成 'A'，页面 keydown 里读到的全是大写。
    spec = { key: baseName, code: 'Key' + up, vk: up.charCodeAt(0) };
    if (baseName === up) mod |= 8; // 大写字母本身意味着 Shift 按下
  }
  if (!spec && baseName.length === 1) {
    spec = { key: baseName, code: '', vk: baseName.toUpperCase().charCodeAt(0), text: baseName };
  }
  if (!spec) return null;
  // 真实浏览器在 Shift 按下时，字母键报的是大写 key。对齐它，否则页面里的
  // 快捷键判断（e.key === 'A'）会失灵。
  let key = spec.key;
  if ((mod & 8) && /^[a-z]$/.test(key)) key = key.toUpperCase();
  return { ...spec, key, mod };
}

class PageManager {
  constructor(browserWindow) {
    this.window = browserWindow;
    this.tabs = new Map();       // tabId -> BrowserView
    this.activeTab = null;
    this.tabCounter = 0;
    this.subscriptions = new Map();
    this._pendingRequests = new Map();
    this._requestId = 0;
    this._wsClients = new Map();
    this._openedTabs = new Map();   // sourceTabId -> { id, url } (new tab opened by window.open)
    this._axDiffCache = new Map();  // tabId -> lite interactive snapshot (get_tree {mode:'diff'})
    this._revertTimers = new Map(); // tabId -> 挂起的 ui.peek 自动回撤定时器（新 peek 会取消它）
    this._repaintTimers = new Map();// tabId -> 正在排队/已调度的重绘（合并同一批导航事件）
    this._snapshots = new Map();    // snapshotId -> { tabId, js, value, at }（ui.snapshot 存基线）
    this._snapshotSeq = 0;
    this.networkMonitor = new NetworkMonitor({}, { captureEnabled: NETWORK_CAPTURE_DEFAULT });
    this.canvasMonitor = new CanvasMonitor();
    this._canvasBindings = new Map(); // bindingName -> tabId（hook 回传时据此归 tab）
    this._setupIPC();
  }

  static _instance = null;
  static getInstance(browserWindow) {
    if (!PageManager._instance) PageManager._instance = new PageManager(browserWindow);
    return PageManager._instance;
  }

  _setupIPC() {
    const self = this;
    // Match by request id — robust under concurrent requests / multi-tab.
    // FIFO broke when getTree/executeAction/evaluate raced: the first response
    // resolved whichever pending promise happened to be first in the map,
    // not the one that actually triggered it.
    ipcMain.on('ai:tree', (_event, payload) => {
      const id = payload && payload.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        pending.resolve(payload);
      }
    });

    ipcMain.on('ai:action_result', (_event, result) => {
      const id = result && result.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        // Strip routing id from the payload before resolving.
        const { id: _drop, ...clean } = result;
        pending.resolve(clean);
      }
    });

    ipcMain.on('ai:evaluate_result', (_event, result) => {
      const id = result && result.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        if (result.error) pending.reject(new Error(result.error));
        else pending.resolve(result.value);
      }
    });

    ipcMain.on('ai:diff', (_event, changes) => {
      this._broadcast('dom_change', { changes });
    });

    ipcMain.on('ai:event', (_event, payload) => {
      // Tag events with active tab
      this._broadcast(payload.event, payload.data || {});
    });
  }

  _broadcast(eventType, data) {
    for (const [sessionId, eventTypes] of this.subscriptions) {
      if (eventTypes.has(eventType) || eventTypes.has('*')) {
        const ws = this._wsClients.get(sessionId);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: eventType, params: data }));
        }
      }
    }
  }

  registerClient(sessionId, ws) {
    this._wsClients.set(sessionId, ws);
  }

  unregisterClient(sessionId) {
    this._wsClients.delete(sessionId);
    this.subscriptions.delete(sessionId);
  }

  _layoutAllViews(bounds) {
    for (const [id, view] of this.tabs) {
      view.setBounds({ x: 0, y: 36, width: bounds.width, height: bounds.height - 36 });
    }
  }

  // === Tab management ===

  _getView(tabId) {
    return this.tabs.get(tabId);
  }

  // ==================================================================
  // Snapshot / Diff — make "act → read back → compare" a one-liner
  // ==================================================================
  //
  // Why this exists: the project's hard rule is that a write is only proven by
  // reading state back and comparing. Doing that by hand meant rewriting bespoke
  // comparison JS on every site (node counts, widget values, positions, edge
  // lists…), which is exactly where mistakes creep in — this session I twice
  // measured the wrong thing (serialized byte length, viewport deltas) and got
  // a confident false reading.
  //
  // Contract, deliberately narrow:
  //   ui.snapshot {js?, label?} → evaluate js (default: a site-agnostic
  //                                structural DOM summary), store, return id.
  //   ui.diff {snapshot, js?}   → re-evaluate and return a STRUCTURED diff:
  //                                added / removed / changed, each with a JSON
  //                                path and both values, so "it changed" is
  //                                provable rather than asserted.

  /**
   * Collect a snapshot value. `js` must be a JSON-serializable expression.
   * When omitted we use a structural DOM summary (role/label/value per element
   * at a stable path) — the most broadly useful default, needing no per-site
   * knowledge, which is the whole point of having a default.
   */
  async _collectSnapshot(js, tabId) {
    const tid = tabId !== undefined && tabId !== null ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { error: 'no-such-tab', tab: tid };
    const expr = js && String(js).trim() ? String(js) : DEFAULT_SNAPSHOT_JS;
    let value;
    try {
      value = await this.evaluate(expr, tid);
    } catch (e) {
      return { error: 'evaluate-failed: ' + (e && e.message ? e.message : String(e)), tab: tid };
    }
    if (value && typeof value === 'object' && value.__error) {
      return { error: 'snapshot-expression-threw: ' + value.__error, tab: tid };
    }
    return { tab: tid, value };
  }

  async snapshot(params = {}) {
    const tid = params.tab !== undefined && params.tab !== null ? params.tab : this.activeTab;
    const r = await this._collectSnapshot(params.js, tid);
    if (r.error) return { ok: false, error: r.error, tab: r.tab };
    const id = 'snap-' + (++this._snapshotSeq);
    const entry = { tab: tid, js: params.js || null, value: r.value, at: new Date().toISOString() };
    this._snapshots.set(id, entry);
    return {
      ok: true,
      snapshot: id,
      tab: tid,
      at: entry.at,
      label: params.label || null,
      bytes: safeByteLength(r.value),
      // Short preview so the caller can confirm it snapshotted what they meant,
      // without a second round-trip.
      preview: previewOf(r.value),
    };
  }

  async diff(params = {}) {
    const id = params.snapshot;
    if (!id) return { ok: false, error: 'missing-snapshot', hint: 'call ui.snapshot first, pass its id here' };
    const base = this._snapshots.get(id);
    if (!base) return { ok: false, error: 'unknown-snapshot', snapshot: id };
    // A snapshot is bound to the tab it came from: diffing across tabs would
    // compare unrelated pages and report a wall of spurious changes.
    const tid = params.tab !== undefined && params.tab !== null ? params.tab : base.tab;
    if (tid !== base.tab) {
      return { ok: false, error: 'tab-mismatch', snapshot: id, snapshot_tab: base.tab, requested_tab: tid };
    }
    const now = await this._collectSnapshot(params.js || base.js, tid);
    if (now.error) return { ok: false, error: now.error, tab: tid };

    const d = diffValues(base.value, now.value);
    const result = {
      ok: true,
      snapshot: id,
      tab: tid,
      changed: d.hasChanges,
      // An explicit verdict so callers never have to infer "nothing happened"
      // from an array they might have built wrong.
      verdict: d.hasChanges ? 'changed' : 'unchanged',
      counts: { added: d.added.length, removed: d.removed.length, changed: d.changed.length },
      added: d.added,
      removed: d.removed,
      changed_paths: d.changed,
      truncation: d.dropped ? { limit: DIFF_MAX_ENTRIES, dropped: d.dropped } : null,
    };
    // Chaining: re-arm the baseline so a caller can loop "assert no change"
    // over many steps without re-snapshotting each time.
    if (params.rearm) {
      this._snapshots.set(id, { ...base, value: now.value, at: new Date().toISOString() });
      result.rearmed = true;
    }
    if (params.forget) { this._snapshots.delete(id); result.forgotten = true; }
    return result;
  }

  /**
   * Probe what this page affords, and which route an agent should take.
   * Thin wrapper so the WS/MCP layers don't need to know the implementation.
   */
  async capabilities(opts = {}) {
    return probeCapabilities(this, opts);
  }

  _sendToView(tabId, channel, payload) {
    const view = this._getView(tabId);
    if (!view) return false;
    view.webContents.send(channel, payload);
    return true;
  }

  async navigate(url, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return false;
    this._axDiffCache.delete(tid); // fresh page → drop stale incremental snapshot
    // loadURL resolves at did-finish-load, which is exactly when the old
    // pixels may still be on screen — repaint here as well as from the event
    // hooks, so a programmatic navigate never depends on hook timing.
    await view.webContents.loadURL(url);
    this.repaint(tid);
    return true;
  }

  async getTree(focusedOnly = false, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { tree: null, context: null };

    const res = await new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:extract', { focusedOnly, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('getTree timeout'));
        }
      }, 5000);
    });
    // 截断的 node.value 带内部字段 value_fetch_ref —— 展开成含实际 tab 的
    // value_fetch（mcp/ws 两种可直接执行的调用提示），再删掉内部字段。
    if (res && res.tree) expandValueFetchTree(res.tree, tid);
    return res;
  }

  // AX probe read layer (P0). Additive — the default getTree path is untouched.
  // Reuses the per-tab shared debugger: enables the Accessibility + DOM domains
  // into the same reference-counted _cdpTabs entry as Network/Runtime, so teardown
  // and multi-client reference counting are unchanged.
  async getTreeViaAx(tabId, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { tree: null, context: null };
    try {
      this._ensureCdp(tid, view, 'Accessibility');
      this._ensureCdp(tid, view, 'DOM');
    } catch (e) {
      return { tree: null, context: null, error: 'cdp-unavailable' };
    }
    const main = await axExtractor.extractFromDebugger(view.webContents.debugger);
    // #1: decorate link/button nodes with their absolute target URL (read-only).
    // Generic — agent sees "where clicking takes me" instead of guessing labels.
    if (main && main.tree && view.webContents.debugger) {
      main.tree = await axExtractor.attachHrefs(view.webContents.debugger, main.tree);
    }
    // P0 down-drill: splice OOPIF sub-frame editors into the main AX tree so
    // editors rendered in cross-process iframes (B站 write-article: york/read-draft)
    // become visible to `ui.get_tree {ax:true}`. Each sub-frame is read by
    // executeJavaScript in its own context (top-frame AX + querySelector can't
    // reach OOPIF content), then merged purely by mergeFrameTrees.
    const frames = await this._readOopifFrames(view, tid);
    if (frames.length && main && main.tree) {
      main.tree = axExtractor.mergeFrameTrees(main.tree, frames);
    }
    // #4: incremental diff — return only newly appeared / hidden interactive
    // nodes since the last ax read on this tab (feeds: small payload per scroll).
    if (opts.mode === 'diff') {
      const lite = this._liteFromTree(main.tree);
      const prev = this._axDiffCache.get(tid) || null;
      if (prev && prev.size) {
        this._axDiffCache.set(tid, lite);
        return { tree: null, context: null, diff: axExtractor.diffLite(prev, lite) };
      }
      this._axDiffCache.set(tid, lite);
    }
    // #4: interactive subset — prune layout-only branches to cut token cost.
    if (opts.subset === 'interactive' && main.tree) {
      main.tree = axExtractor.filterInteractive(main.tree);
    }
    // 同 getTree：把 value_fetch_ref 展开成带实际 tab 的 value_fetch。
    if (main && main.tree) expandValueFetchTree(main.tree, tid);
    return main;
  }

  // Lite interactive snapshot derived from an already-built tree (no second CDP
  // read). Keyed by backendDOMNodeId for cheap diff across reads.
  _liteFromTree(tree) {
    const out = new Map();
    (function w(t) {
      if (!t) return;
      if (t.backendDOMNodeId != null && ((t.actions || []).length > 0 || t.editor_type)) {
        out.set(t.backendDOMNodeId, { id: t.id, role: t.role, label: t.label || '' });
      }
      for (const c of t.children || []) w(c);
    })(tree);
    return out;
  }

  // Read editable/interactive fields out of each out-of-process sub-frame via
  // Frame.executeJavaScript (runs in that frame's own context). Returns
  // [{ key, label, tree }] — pure mergeFrameTrees input. Stamps idempotent
  // data-ai-id = `axf-{frameSeq}-{idx}` inside each frame so the act layer can
  // (a) find the owning frame by testing which frame has `[data-ai-id=...]`, and
  // (b) run its JS in that frame's own context (top querySelector can't reach OOPIF).
  async _readOopifFrames(view, tabId) {
    try {
      const root = view.webContents.mainFrame;
      if (!root || !root.framesInSubtree) return [];
      const out = [];
      let frameSeq = 0;
      for (const frame of root.framesInSubtree) {
        if (frame === root) continue; // main frame handled by AX path
        frameSeq += 1;
        const key = 'frame-' + frameSeq;
        const prefix = 'axf-' + frameSeq + '-';
        try {
          const dto = await frame.executeJavaScript(`(function(prefix){
            if(!document||!document.body) return null;
            var sel='[contenteditable],[role="textbox"],[role="combobox"],textarea,input[type="text"],input[type="title"],input[type="search"],button,[role="button"],a[href]';
            var els=Array.prototype.slice.call(document.querySelectorAll(sel));
            var out=[]; var idx=0;
            for(var k=0;k<els.length;k++){
              var e=els[k];
              if(e.isContentEditable){ // skip editable boxes nested inside a contenteditable root
                var inside=false;for(var p=e.parentElement;p;p=p.parentElement){if(p.isContentEditable&&p!==e){inside=true;break;}}
              }
              var r=e.getBoundingClientRect();
              if(r.width<4||r.height<4)continue; // hidden
              if(e.tagName==='BUTTON'||(e.getAttribute&&e.getAttribute('role')==='button')){} // buttons not relevant for read-editor; keep anyway
              var ai=prefix+idx;
              e.setAttribute('data-ai-id',ai);
              var isEditable=e.isContentEditable||e.tagName==='TEXTAREA'||((e.tagName==='INPUT'));
              var role;
              if(e.isContentEditable)role='textbox';
              else if(e.tagName==='TEXTAREA')role='textbox';
              else if(e.tagName==='INPUT')role='textbox';
              else if(e.tagName==='BUTTON'||e.getAttribute&&e.getAttribute('role')==='button')role='button';
              else if(e.tagName==='SELECT'||e.getAttribute&&e.getAttribute('role')==='combobox')role='select';
              else if(e.tagName==='A')role='link';
              else role='textbox';
              var label=e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('title')||'';
              if(!label&&e.getAttribute&&e.getAttribute('data-placeholder'))label=e.getAttribute('data-placeholder');
              if(!label&&(e.tagName==='BUTTON'||(e.getAttribute&&e.getAttribute('role')==='button'))){label=(e.innerText||e.textContent||'').trim();}
              if(!label&&e.tagName==='A'){label=(e.innerText||e.textContent||'').trim();}
              var url=(e.tagName==='A'&&e.href)||(e.closest&&e.closest('a[href]')?e.closest('a[href]').href:'');
              var editor_type=null;
              if(e.isContentEditable)editor_type='richtext';
              else if(e.tagName==='TEXTAREA')editor_type='textarea';
              else if(e.tagName==='INPUT')editor_type='textbox';
              out.push({id:ai,role:role,label:label,editor_type:editor_type,url:url,bounds:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});
              idx++;
            }
            return out.length?out:null;
          })(${JSON.stringify(prefix)})`);
          if (!dto || !dto.length) continue;
          const tree = {
            id: key,
            role: 'generic',
            label: frame.name || ('frame-' + frameSeq),
            states: [],
            actions: [],
            bounds: { x: 0, y: 0, width: 0, height: 0 },
            children: dto.map((n) => ({
              id: n.id,
              role: n.role,
              label: n.label || '',
              ...(n.url ? { url: n.url } : {}),
              states: n.editor_type ? ['editable=' + n.editor_type, 'focusable'] : ['focusable'],
              ...(n.editor_type ? { editor_type: n.editor_type } : {}), // first-class, mirrors main AX path
              actions: n.role === 'button' ? ['click', 'focus'] : ['click', 'focus', 'type', 'setContent', 'clear'],
              bounds: n.bounds,
            })),
          };
          out.push({ key, label: frame.name || ('frame-' + frameSeq), tree });
        } catch (e) { /* skip unreachable frame */ }
      }
      return out;
    } catch (e) { return []; }
  }

  // C (plan §9.5): materialize data-ai-id for interactive elements at the act/peek
  // boundary only. Reading (getTreeViaAx/axRead) never touches the DOM. Idempotent:
  // existing handles (default extractor's `e:...`) are preserved, never overwritten.
  async _ensureAxHandles(view, tabId) {
    if (!view || !view.webContents || !view.webContents.debugger) return;
    try {
      this._ensureCdp(tabId, view, 'Accessibility');
      this._ensureCdp(tabId, view, 'DOM');
      await axExtractor.ensureHandles(view.webContents.debugger);
    } catch (e) { /* no CDP: fall through to the preload path */ }
  }

  // A (plan §9.5): `ui.peek` — safely explore the "next step". Hover-reveal is
  // non-committing (mouseMoved without press), so it never double-clicks or
  // mis-triggers; we return the AX diff (newly revealed / hidden interactive
  // nodes) so the agent can discover folded entries (e.g. B站 写文章) without
  // guessing URLs. Revert moves the pointer away to close the submenu.
  async peek(tabId, target, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { revealed: [], hidden: [], mode: 'hover', error: 'Tab not found' };
    if (!target) return { revealed: [], hidden: [], mode: 'hover', error: 'No target' };
    // 取消上一次 peek 挂起的自动回撤。回撤是"把鼠标挪走"的延迟动作，若前一次的
    // 定时器还在，它会在本次 peek 已经把鼠标放到新目标上之后才触发，把刚刚探出来的
    // 菜单又关掉 —— 表现为 revertMs=0（语义：别回撤）依然失效。谁后动手谁说了算。
    const staleRevert = this._revertTimers.get(tid);
    if (staleRevert) { clearTimeout(staleRevert); this._revertTimers.delete(tid); }
    const out = { revealed: [], hidden: [], mode: 'hover' };
    try {
      this._ensureCdp(tid, view, 'Accessibility');
      this._ensureCdp(tid, view, 'DOM');
    } catch (e) { return { ...out, error: 'cdp-unavailable' }; }
    const dbg = view.webContents.debugger;
    try {
      const beforeRaw = await axExtractor.axRaw(dbg);
      if (!beforeRaw.length) return out;
      await axExtractor.ensureHandles(dbg); // give the target a stable append id
      const center = await this.evaluate(
        `(function(){var el=document.querySelector('[data-ai-id="${target}"]');if(!el)return null;` +
        `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
        `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
        tid);
      // 定位不到 target 必须如实报错。此前直接返回未带 error 的空 out，与"hover 了
      // 但这里确实没有可展开项"完全无法区分 —— agent 会误判成"菜单没有更深的入口"
      // 而放弃探索，实际只是 target 拼错/句柄失效。
      if (!center) {
        return { ...out, error: 'target_not_found: no element with data-ai-id=' + String(target) };
      }
      try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
      } catch (e) {}
      const send = (method, params) => dbg.sendCommand(method, params);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
      // 区分"没传"与"显式传 0"：0 是合法语义（hoverMs=0 不等、revertMs=0 不回撤）。
      // 原来的 `Number(x) || 450` 把 0 当 falsy 顶成默认值，revertMs=0 永远失效。
      const msOr = (v, dflt) => (v === undefined || v === null || v === '') ? dflt : Math.max(0, Number(v) || 0);
      const hoverMs = msOr(opts.hoverMs, 450);
      await new Promise((r) => setTimeout(r, hoverMs));
      const afterRaw = await axExtractor.axRaw(dbg);
      const diff = axExtractor.diffAx(beforeRaw, afterRaw);
      out.revealed = diff.revealed;
      out.hidden = diff.hidden;
      // revertMs=0 表示"别回撤，我要接着点" —— 只有显式传 0 才不该回撤，
      // 未传则沿用 1500ms 默认（同上，0 不再是 falsy）。
      const revertMs = msOr(opts.revertMs, 1500);
      if (revertMs > 0) {
        const h = setTimeout(() => {
          this._revertTimers.delete(tid);
          try { send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); } catch (e) {}
        }, revertMs);
        this._revertTimers.set(tid, h);
      }
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 200);
    }
    return out;
  }

  async executeAction(action, target, params = {}, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { success: false, error: 'Tab not found' };
    // press 是唯一不要求目标的动作：快捷键通常挂在 document/window 上（删除节点、
    // 撤销重做、取消选中），发给"当前焦点"就是正确语义。
    // drag 给了显式起点坐标（params.from）时同样不要求目标 —— "从空白处起拖"正是
    // 平移画布、框选这类操作的表达，而空白画布上根本没有可寻址的元素。
    // wheel 也不要求目标：不指定就落在视口中心（缩放画布正是这样用的）。
    const hasExplicitDragFrom = action === 'drag' && params.from && Number.isFinite(Number(params.from.x));
    const targetOptional = action === 'press' || action === 'wheel' || hasExplicitDragFrom;
    if (!target && !targetOptional) return { success: false, error: 'No target' };
    target = target || '';

    // 只读分支：取 node.value 的完整内容（树里只给前 200 code point）。
    // 不聚焦、不触发 input/change、不改页面，也不走输入动作的 fallback。
    if (action === 'get_value') return await this._getValue(view, target, params, tid);

    // CDP 受信输入优先（像人操作：受信点击/键盘/文本，对任何框架通用），
    // 无 debugger 时回退 preload 合成事件。
    if (action === 'click' || action === 'hover') {
      // #2: 按目标 URL 点击（复合卡片的通用解法）——agent 想看"点了会去哪个 URL"
      // 就指定 params.url，不靠猜 label 命中卡片里的多个 <a>。先走 URL→链接定位；
      // 未给 url 才退回元素指针点击（原路径，不回归）。
      if (params.url && action === 'click') {
        try {
          await this._ensureAxHandles(view, tid);
          const res = await this._resolveClickByUrl(view, target, params.url, tid);
          if (!res || !res.success) return { ...(res || {}), success: false, opened_tab: null };
          // #3: 若此点击触发了 window.open → 新 tab，记录并默认接管焦点。
          res.opened_tab = this._consumeOpenedTab(tid, params.keep_tab === true);
          return res;
        } catch (e) {
          return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
        }
      }
      try {
        await this._ensureAxHandles(view, tid);
        const via = await this._cdpPointerTarget(view, action, target, tid);
        if (via) return { success: true, clicked_via: via, target, opened_tab: this._consumeOpenedTab(tid, params.keep_tab === true) };
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'type' || action === 'setContent' || action === 'clear') {
      try {
        await this._ensureAxHandles(view, tid);
        // clear 也走 CDP 受信输入链路（空文本即清空+校验）。顶层预加载 clear 用
        // innerHTML="" 只对顶层元素生效；OOPIF 子帧元素 querySelector 命中不到，
        // clear 会静默落空。路由到这里后 OOPIF 走 _clearInFrame(execCommand
        // selectAll+delete)，顶层走 _selectAllFallback+受信 Delete，均带校验。
        // 语义分工（此前 type 与 setContent 完全等价，都是整篇替换 —— 插入话题
        // 标签后再输入正文会把标签清掉，无法续写）：
        //   type       = 在光标处追加（默认末尾），不碰已有内容
        //   setContent = 整篇替换（全选 → 删除 → 输入）
        //   clear      = 全选删除
        // 想重填一个输入框请显式 setContent（或先 clear 再 type）。
        const r = await this._inputViaCdp(
          view,
          target,
          action === 'clear' ? '' : (params.text || ''),
          tid,
          { replace: action !== 'type', at: params.at || 'end' }
        );
        if (r) return r;
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'upload') {
      try {
        await this._ensureAxHandles(view, tid);
        const r = await this._uploadViaCdp(view, target, params.file || '', tid);
        if (r) return r;
      } catch (e) { /* fall through to preload */ }
      // 无 CDP 时 preload 无法真正赋值文件（受安全限制），返回失败让 agent 感知。
      return { success: false, error: 'Upload requires CDP (input file set) — no file input found' };
    } else if (action === 'drag') {
      try {
        const r = await this._cdpDrag(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      // 拖拽没有 preload 等价物：合成 PointerEvent 不被采用 Pointer Capture 的
      // 应用信任（实测 React Flow 上 moved 恒为 0），因此明确报错而不是假装成功。
      return { success: false, error: 'Drag requires CDP — the debugger is not attached to this tab' };
    } else if (action === 'wheel') {
      try {
        const r = await this._cdpWheel(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      return { success: false, error: 'wheel requires CDP — the debugger is not attached to this tab' };
    } else if (action === 'press') {
      try {
        const r = await this._cdpPress(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      return { success: false, error: 'press requires CDP — the debugger is not attached to this tab' };
    }

    const preloadRes = await this._executeViaPreload(action, target, params, tid);
    // preload 合成点击也可能触发 window.open → 新 tab，同样回报 opened_tab。
    if (action === 'click' && preloadRes && preloadRes.success) {
      preloadRes.opened_tab = this._consumeOpenedTab(tid, params.keep_tab === true);
      // 路径可区分：CDP 受信点击报 clicked_via='cdp-click'，回退路径报
      // 'preload-click'。两种都只报 success 的话，agent（和人）无从判断这一下
      // 到底是真实输入还是合成事件 —— 双发 bug 正是靠这个字段才暴露出来的。
      preloadRes.clicked_via = 'preload-click';
    }
    return preloadRes;
  }

  // === 只读取全量 node.value（ui.act {action:'get_value'}）===
  // 语义树里 node.value 只给前 200 Unicode code point；超长的节点带
  // value_fetch 提示，调用方用它取全量（支持 offset/limit 分页）。
  // 严格只读：不聚焦、不派发 input/change、不改 DOM，也不走输入动作 fallback。
  async _getValue(view, target, params, tabId) {
    const p = params || {};
    const offset = Math.max(0, Number(p.offset) || 0);
    const limit = (p.limit === undefined || p.limit === null) ? undefined : Number(p.limit);
    // target 经 JSON.stringify 变成双引号 JS 字面量，拼进单引号选择器里 —— 无法
    // 通过 target 内容跳出字符串。
    const js =
      "(function(){"
      + "var el=document.querySelector('[data-ai-id=' + " + JSON.stringify(String(target)) + " + ']');"
      + "if(!el)return {__miss:true};"
      + "var tag=(el.tagName||'').toUpperCase();"
      + "if(tag==='INPUT'){var ty=String(el.type||'').toLowerCase();"
      + "if(ty==='password')return {__sensitive:'password'};"
      + "if(ty==='file')return {__sensitive:'file'};"
      + "return {text:el.value==null?'':String(el.value)};}"
      + "if(tag==='TEXTAREA')return {text:el.value==null?'':String(el.value)};"
      + "if(tag==='SELECT'){var o=el.selectedOptions&&el.selectedOptions.length?el.selectedOptions[0]:null;"
      + "return {text:o?String(o.value||o.textContent||''):String(el.value||'')};}"
      + "if(el.isContentEditable===true||(el.getAttribute&&el.getAttribute('contenteditable')==='true'))"
      + "return {text:String(el.innerText||el.textContent||'')};"
      + "if(typeof el.value==='string')return {text:el.value};"
      + "return {text:String(el.innerText||el.textContent||'')};"
      + "})()";

    const run = async () => {
      // OOPIF：在所属子帧上下文里执行（顶层 querySelector 看不到跨进程 iframe）。
      if (/^axf-/.test(target)) {
        const frame = await this._owningFrame(view, target);
        if (frame) {
          try { return await frame.executeJavaScript(js); } catch (e) { /* fall through */ }
        }
      }
      try { return await this.evaluate(js, tabId); } catch (e) { return null; }
    };

    let raw = await run();
    if (!raw || raw.__miss) {
      // AX 读层的 handle 是按需 stamp 的（ensureHandles）—— 从未 act 过的节点
      // DOM 上可能还没有 data-ai-id。补一次再读，仍没有才报 not found。
      await this._ensureAxHandles(view, tabId);
      raw = await run();
    }
    if (!raw || raw.__miss) return { success: false, error: 'target_not_found: no element with data-ai-id=' + String(target) };
    if (raw.__sensitive) return { success: false, error: 'sensitive_value_not_readable: input[type=' + raw.__sensitive + '] is never exposed' };
    if (typeof raw.text !== 'string') return { success: false, error: 'target_has_no_value' };
    const sliced = valueContract.getValueResult(raw.text, offset, limit);
    return { success: true, target, ...sliced };
  }

  // #3 helper: read & clear the "new tab opened by this source tab" entry.
  // Returns { id, url } or null. Unless keep===true, auto-activates the new tab.
  _consumeOpenedTab(tid, keep) {
    const entry = this._openedTabs.get(tid);
    this._openedTabs.delete(tid);
    if (!entry) return null;
    if (keep !== true) this.setActive(entry.id);
    return { id: entry.id, url: entry.url };
  }

  // #2: 按目标 URL 定位并点击链接 —— 通用替代"猜卡片里的 <a>"。顶层在
  // Runtime.evaluate 里找 a[href] 精确匹配 url（或 host/path 子串），命中即
  // scrollIntoView+focus+click（link 原生 click 可靠）；OOPIF(target 为 axf-…)
  // 在所属帧内用同一逻辑。无 url 传参/找不到返回 clean error。
  async _resolveClickByUrl(view, target, url, tabId) {
    if (!view || !url) return { success: false, error: 'no url provided' };
    const owning = await this._owningFrameFor(view, target, tabId);
    const expr = `(function(url){
        var best=null,bestScore=-1;
        var als=document.querySelectorAll('a[href]');
        for(var i=0;i<als.length;i++){
          var a=als[i], h=a.href||'';
          if(!h)continue;
          // 精确匹配优先，其次 host+path 子串（容忍站点改写查询串/协议）。
          var s = (h===url) ? 3 : (h.indexOf(url)>0 ? 2 : (url.indexOf(h)>0 ? 1 : 0));
          // 子串还要继续看 path 是否一致，避免 /video 与 /video/xxx 互误伤
          if(s===2&&(h.split('#')[0].split('?')[0]!==url.split('#')[0].split('?')[0]))s=1;
          if(s>bestScore){bestScore=s;best=a;}
        }
        if(!best||bestScore<=0)return {ok:false};
        best.scrollIntoView({block:'center',behavior:'instant'});
        best.focus();best.click();
        return {ok:true,matched:best.href||url};
      })(${JSON.stringify(url)})`;
    // OOPIF / 顶层统一：resolve 结果空串归一为 null；跨帧走 executeJavaScript。
    const result = owning
      ? await owning.executeJavaScript(expr)
      : await this._evaluateViaCdp(view, expr);
    if (!result || !result.ok) return { success: false, error: 'no link matches url: ' + url };
    return { success: true, clicked_via: 'urllink', matched: result.matched || url };
  }

  async _executeViaPreload(action, target, params, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { success: false, error: 'Tab not found' };

    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:action', { action, target, params, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          resolve({ success: false, error: 'Action timeout' });
        }
      }, 5000);
    });
  }

  async getFocused(tabId) {
    const result = await this.getTree(true, tabId);
    return result?.tree?.focused_element_id || null;
  }

  async evaluate(js, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) throw new Error('Tab not found');

    // OOPIF routing: if the JS targets a sub-frame `data-ai-id` (`axf-...`), run
    // it inside that frame's own context via Frame.executeJavaScript — the
    // top-frame CDP Runtime.evaluate cannot see OOPIF (cross-process iframe)
    // DOM, so probes/`ui.evaluate` would otherwise read `null` back.
    const m = /data-ai-id="(axf-\d+-\d+)"/.exec(js);
    if (m) {
      const frame = await this._owningFrame(view, m[1]);
      if (frame) {
        try { return await frame.executeJavaScript(js.startsWith('(') ? js : `(function(){return ${js};})()`); }
        catch (e) { /* fall through to top-frame path */ }
      }
    }
    // Preferred path: CDP Runtime.evaluate. It runs on the DevTools protocol
    // channel and is NOT subject to the page's CSP code-generation (eval)
    // restrictions, so it works on strict sites (Bing, Gmail, ...) where the
    // in-page `eval()` used by the preload bridge is blocked. It runs in the
    // page's main world, identical privilege to the page's own JS (no Node:
    // nodeIntegration:false + contextIsolation:true are unchanged).
    try {
      return await this._evaluateViaCdp(view, js);
    } catch (e) {
      // Fallback: the original preload (ai:evaluate) path, for views without a
      // usable CDP debugger (and for the vitest unit tests that mock IPC).
      return await this._evaluateViaPreload(view, js);
    }
  }

  // Execute JS via chromedebugger + Runtime.evaluate on a per-tab webContents.
  async _evaluateViaCdp(view, js) {
    const wc = view.webContents;
    const dbg = wc && wc.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function') throw new Error('no-cdp');
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (e) {
      // Already attached (e.g. by the network monitor); reuse the same session.
    }
    const cmd = dbg.sendCommand('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
      awaitPromise: false,
    });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('cdp evaluate timeout')), 5000));
    const res = await Promise.race([cmd, timeout]);
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      const msg = (ex && (ex.description || ex.value)) || res.exceptionDetails.text || 'evaluate error';
      throw new Error(String(msg).slice(0, 300));
    }
    const r = res && res.result;
    if (r && r.subtype === 'error') throw new Error(String(r.description || 'evaluate error').slice(0, 300));
    return r ? r.value : undefined;
  }

  _evaluateViaPreload(view, js) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:evaluate', { js, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('evaluate timeout'));
        }
      }, 5000);
    });
  }

  // === CDP 受信输入（通用化，无框架特判）===
  // 任何网页/富文本/编辑器（Draft、ProseMirror、Quill、antd、shadcn…）都无需
  // 专项适配：点击/键盘/文本全部走 Chromium 真实输入管线（受信事件），等价于
  // 真实用户操作。识别层面只判断"是不是可编辑区"（contenteditable / input /
  // textarea），不嗅探任何框架类名；失败只返回错误让 agent 重新读取重试。

  _canCdp(view) {
    try {
      const d = view.webContents.debugger;
      return !!(d && typeof d.isAttached === 'function');
    } catch(e) { return false; }
  }

  async _cdpKey(inputCmd, p) {
    const base = {
      windowsVirtualKeyCode: p.vk,
      nativeVirtualKeyCode: p.vk,
      code: p.code,
      key: p.key,
      text: p.text || '',
      modifiers: p.mod || 0,
    };
    await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    // CDP 的 rawKeyDown 会忽略 text —— 带字符的键（换行）必须再发一个带
    // text 的 char 事件才会真的把字符插进去，否则 Enter 在 textarea /
    // 原生 contenteditable 里不产生任何换行（"a\nb\nc" 静默变成 "abc"）。
    if (base.text) await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'char' });
    await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // 解析某个 data-ai-id 属于哪个帧。**不能只认 axf- 前缀**：
  // DOM 抽取器会给同源 iframe 里的元素也写上普通的 data-ai-id（写在 iframe 自己的
  // document 上），这些 id 在顶层 document 里查不到 —— 实测 ComfyUI 的工具栏按钮
  // （节点库 / Zoom In / Fit View）就是这样，ui.act 一直报 "Target not found"。
  // 所以这里先看顶层，找不到再逐个帧找。返回 null 表示就在主帧里。
  async _owningFrameFor(view, aiId, tabId) {
    if (!aiId) return null;
    if (/^axf-/.test(aiId)) return await this._owningFrame(view, aiId);
    try {
      const inTop = await this.evaluate(
        `!!document.querySelector('[data-ai-id="${aiId}"]')`,
        tabId
      );
      if (inTop) return null;
    } catch (e) { /* 顶层查询失败就继续找帧 */ }
    return await this._owningFrame(view, aiId);
  }

  // Locate the frame that owns a sub-frame handle (`axf-{frameSeq}-{idx}`).
  // Returns the WebFrameMain, or null when the handle lives in the main frame
  // (or is unlocatable) — callers fall back to the top-frame path.
  async _owningFrame(view, aiId) {
    const root = view.webContents.mainFrame;
    const frames = root && root.framesInSubtree ? root.framesInSubtree : [];
    for (const frame of frames) {
      if (frame === root) continue;
      try {
        const has = await frame.executeJavaScript(
          `!!document.querySelector('[data-ai-id="${aiId}"]')`
        );
        if (has) return frame;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  // OOPIF coordinate translation: sub-frame getBoundingClientRect is relative to
  // the iframe's own layout viewport; add the hosting <iframe> element's top-left
  // (top document) to get browser-viewport coordinates for Input.dispatchMouseEvent.
  // 找到承载某个子帧的 <iframe> 元素，顺便判断它是否**同源**（同源通常意味着进程内，
  // 坐标 + CDP 真实鼠标事件可用；跨进程 OOPIF 则只能用帧内原生 .click()）。
  async _hostIframe(view, frame, tabId) {
    try {
      const path = await frame.executeJavaScript('(location.pathname||"")');
      const info = await this.evaluate(
        `(function(path){
           var best=null;
           Array.prototype.forEach.call(document.querySelectorAll('iframe'),function(f){
             var r=f.getBoundingClientRect();
             if(r.width<4||r.height<4)return;
             var s=f.src||'';
             var match = (f.name&&f.name.length) ? (path.indexOf((f.name||''))===0) : (s.indexOf(path)>=0);
             if(!match) return;
             var sameOrigin=false;
             try { sameOrigin = !!(f.contentDocument && f.contentDocument.body); } catch(e) { sameOrigin=false; }
             best={x:Math.round(r.left),y:Math.round(r.top),sameOrigin:sameOrigin};
           });
           return best;
         })(${JSON.stringify(path)})`,
        tabId);
      return info;
    } catch (e) { return null; }
  }

  async _frameOffset(view, frame, tabId) {
    const info = await this._hostIframe(view, frame, tabId);
    return info ? { x: info.x, y: info.y } : null;
  }

  // 受信鼠标事件：先把元素滚入视口（屏外元素直接 dispatchMouseEvent 时坐标落在
  // 视口外，事件命中 body/空白处——探针证实点击不聚焦却误报成功），再按滚动后的
  // 中心点发 mousemove → mousePressed/mouseReleased（click）或仅 move（hover）。
  // OOPIF 目标：定位在所属 frame 内执行，坐标 + frame 偏移换算到顶层视口。
  async _cdpPointerTarget(view, action, aiId, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const inFrame = !!owning;
    // 帧内 click 的两种走法，必须分开：
    //   · **同源（进程内）子帧** → 走下面的坐标 + CDP 真实鼠标事件。
    //     实测 ComfyUI 工具栏的 Zoom In 只监听 mousedown/pointerdown，帧内原生
    //     el.click() 完全不生效（而 Fit View 只监听 click，el.click() 才生效）——
    //     合成事件覆盖不了全部按钮，真实鼠标事件才能。
    //   · **跨进程 OOPIF** → 沿用帧内原生 .click()：CDP 坐标对跨进程子帧的命中/路由
    //     不稳（实测报告成功却未触发），原生 .click() 贴合编辑器 React click 语义。
    if (inFrame && action === 'click') {
      try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
      } catch (e) {}
      let host = null;
      try { host = await this._hostIframe(view, owning, tabId); } catch (e) { host = null; }
      if (host && host.sameOrigin) {
        // 落到这里，走与 hover 相同的坐标路径（真实 mousemove/press/release）
      } else {
        try {
          const ok = await owning.executeJavaScript(
            `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
            `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
            `el.focus();el.click();return true;})()`);
          return ok ? 'oopif-click' : null;
        } catch (e) { return null; }
      }
    }
    // 定位 → 滚入视口居中 → 返回滚动后的中心点（frame 内局部坐标）。
    const center = inFrame
      ? await owning.executeJavaScript(
          `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return null;` +
          `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
          `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`)
      : await this.evaluate(
          `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return null;` +
          `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
          `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
          tabId);
    if (!center) return null;
    // frame 局部 → 顶层视口坐标
    let vp = center;
    if (inFrame) {
      const off = await this._frameOffset(view, owning, tabId);
      if (off) vp = { x: center.x + Math.round(off.x), y: center.y + Math.round(off.y) };
    }
    try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
    } catch(e) {}
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    // 命中校验必须在派发【之前】做，且派发成功就不再回退 —— 否则一次 act 会点两次。
    // 事后校验的致命漏洞：mousePressed/mouseReleased 一发出，点击就已生效；而"点了
    // 之后自身消失/收起"的目标（话题候选收起列表、提交后置灰、菜单项、@提及、点赞）
    // 此刻已经被自己点没了，elementFromPoint 必然命中不到 → 返回 null → executeAction
    // 回退 preload 再点一次 → DOM 上出现两份插入/两次提交。派发前的坐标命中才是
    // "这一下会不会落在目标上"的唯一可信判断；校验失败（被遮挡/屏外/已隐藏）才回退。
    if (action === 'click') {
      const hit = inFrame
        ? await owning.executeJavaScript(
            `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
            `var h=document.elementFromPoint(${center.x},${center.y});return !!(h&&(h===el||el.contains(h)));})()`)
        : await this.evaluate(
            `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
            `var h=document.elementFromPoint(${center.x},${center.y});return !!(h&&(h===el||el.contains(h)));})()`,
            tabId);
      if (!hit) return null; // 坐标落不到目标上 —— 交给 preload 的 focus()+click 兜底
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
    if (action === 'click') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x, y: vp.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    // 走到这里说明受信点击已经真实派发成功 —— 绝不回退 preload 再点第二次。
    return action === 'hover' ? 'cdp-hover' : 'cdp-click';
  }

  // 受信滚轮（ui.act {action:'wheel'}）。
  //
  // 为什么需要：`ui.scroll` 只是 `window.scrollBy`，对**画布类应用完全无效** ——
  // 无限画布/地图/图表靠 wheel 事件缩放与平移，而不是文档滚动。实测在 rhtv 画布上
  // ui.scroll 一点用都没有，agent 因此既看不见全图、也缩不进去。
  //   params.dy < 0 → 向上滚 / 缩小；> 0 → 向下滚 / 放大（配合 hold:['Control']）
  //   params.dx     横向滚动
  //   params.at     显式落点坐标；否则落在 target 元素中心（先滚入视口），再否则视口中心
  //   params.keys   修饰键（画布缩放通常要 Control）
  async _cdpWheel(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}

    const dims = await run('return {w:window.innerWidth,h:window.innerHeight};');
    let at = null;
    if (params.at && Number.isFinite(Number(params.at.x))) {
      at = { x: Math.round(Number(params.at.x)), y: Math.round(Number(params.at.y)) };
    } else if (aiId) {
      const c = await run(
        `var el=document.querySelector(${JSON.stringify(`[data-ai-id="${aiId}"]`)});if(!el)return null;` +
        `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
        `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};`
      );
      if (c) at = c;
    }
    if (!at) at = { x: Math.round(dims.w / 2), y: Math.round(dims.h / 2) };
    if (at.x < 0 || at.y < 0 || at.x > dims.w || at.y > dims.h) {
      return { success: false, error: `wheel: point (${at.x},${at.y}) is outside the viewport (${dims.w}x${dims.h})`, at };
    }

    const dx = Number(params.dx) || 0;
    const dy = Number(params.dy) || 0;
    if (!dx && !dy) {
      return { success: false, error: 'wheel: need dx or dy (e.g. dy:-600 zooms/pans up; add hold:["Control"] for canvas zoom)' };
    }
    const mod = modifierMask(params.hold || params.keys);
    const steps = Math.min(20, Math.max(1, Number(params.steps) || 1));
    const dbg = view.webContents.debugger;
    for (let i = 0; i < steps; i++) {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: at.x,
        y: at.y,
        deltaX: Math.round(dx / steps),
        deltaY: Math.round(dy / steps),
        modifiers: mod,
      });
      if (steps > 1) await new Promise((r) => setTimeout(r, 30));
    }
    return { success: true, wheeled_via: 'cdp-wheel', at, delta: { x: dx, y: dy }, modifiers: mod, steps };
  }

  // 受信拖拽（ui.act {action:'drag'}）—— 画布/看板/滑块/排序/框选这类交互的
  // 唯一通路。实测：合成 PointerEvent 拖不动采用 Pointer Capture 的应用
  // （React Flow 的画布节点，moved 恒为 0,0），因为 setPointerCapture 要求
  // 真实指针；合成 KeyboardEvent/MouseEvent 同理不被信任。所以拖拽**必须**
  // 走 CDP 的 Input.dispatchMouseEvent 序列，不是"有更好"。
  //
  // 端点解析：
  //   target                    起点元素（data-ai-id）
  //   params.from / params.to   {x,y} 视口绝对坐标（给了就优先，用于空白处起拖/落点）
  //   params.to_target          终点元素（data-ai-id）
  //   params.dx / params.dy     相对起点的位移（移动节点最常用）
  //   params.from_anchor/to_anchor  'center'(默认)|'left'|'right'|'top'|'bottom'
  //     方位锚点会优先落在元素内部的**连接点**（类名含 handle/port/anchor/
  //     connector 的小元素）上 —— 这正是"从 A 的右侧连到 B 的左侧"的自然表达，
  //     不需要 agent 知道连接点的 DOM 类名或 data-ai-id（它们通常没有）。
  //   params.steps / params.duration_ms  中间 mouseMoved 步数与总时长
  //   params.keys               拖拽期间按住的修饰键（如 ['Shift'] 轴向锁定）
  async _cdpDrag(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}

    const anchorOf = (a) => {
      const s = String(a || 'center').toLowerCase();
      return ['center', 'left', 'right', 'top', 'bottom'].indexOf(s) >= 0 ? s : 'center';
    };
    // 元素内的锚点解析（页内执行）。
    //   center  → 元素的几何中心，**不吸附**任何内部元素。这是"移动/平移"的语义，
    //             若吸附到连接点，在 React Flow 这类库里会变成"从连接点拉线"，
    //             与调用方的意图相反。
    //   四周    → 优先该方位的**连接点**（handle/port/connector 类的小元素），
    //             没有则退化为该边的中点。这是"连线"的语义。
    // 连接点识别用 classList 逐 token 词边界匹配 —— 上一版用
    // `[class*="anchor"]` 会把 `is-node-anchored` 这类无关类名当成连接点
    // （实测抢到了"标签"按钮），拖拽起点完全错位。
    const pointFor = async (sel, anchor, offset) => {
      const body =
        `var el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;` +
        `var r=el.getBoundingClientRect();var side=${JSON.stringify(anchor)};` +
        `var cx=r.x+r.width/2,cy=r.y+r.height/2;` +
        `function isHandle(h){var cl=h.classList;for(var i=0;i<cl.length;i++){var t=cl[i];` +
        `if(/(^|[-_])handle([-_]|$)/.test(t)||/(^|[-_])port([-_]|$)/.test(t)||` +
        `/(^|[-_])connector([-_]|$)/.test(t)||/(^|[-_])anchor([-_]|$)/.test(t))return true;}return false;}` +
        `if(side==='center')return {x:cx,y:cy,via:'center'};` +
        `var M=12;` + // 连接点通常骑在边框上（一半在内一半在外），给一点容差
        `var hs=el.querySelectorAll('[data-handlepos],[class]');` +
        `var best=null,bestScore=-1e9;` +
        `for(var i=0;i<hs.length;i++){var h=hs[i];` +
        `if(!h.hasAttribute('data-handlepos')&&!isHandle(h))continue;` +
        `var hr=h.getBoundingClientRect();if(hr.width<=0&&hr.height<=0)continue;` +
        `var hx=hr.x+hr.width/2,hy=hr.y+hr.height/2;` +
        // 连接点必须附着在元素**自身**范围内。不加这条，元素内部某个用绝对定位
        // 甩到很远的子孙会被当成"最右侧的连接点"（实测解析出的点离节点 300px，
        // 于是连线整条落空、还报 success）。
        `if(hx<r.left-M||hx>r.right+M||hy<r.top-M||hy>r.bottom+M)continue;` +
        `var sc;` +
        `if(side==='right')sc=(hx-cx);else if(side==='left')sc=(cx-hx);` +
        `else if(side==='bottom')sc=(hy-cy);else if(side==='top')sc=(cy-hy);` +
        `if(sc>bestScore){bestScore=sc;best={x:hx,y:hy,via:'handle',el:h};}}` +
        // 自证可命中：选中的"连接点"必须真的是指针落在那个坐标时会命中的元素。
        // 很多站点把连接点画成 `pointer-events:none` + `opacity:0` 的**装饰**
        // （实测 rhtv 的画布：handle 全是 pe:none / op:0），此时按下去命中的其实是
        // 节点本体 —— 却仍报 via:'handle'，把"按错了地方"伪装成"按在连接点上"。
        //
        // 判定必须是"命中即是连接点，或连接点的子孙"。**不能**接受
        // `hit.contains(handle)`：节点本体当然包含自己的连接点，那样会把这个
        // 失败情形原样放行（第一版就是这么写的，实测仍然报 handle）。
        `if(best){var hit=document.elementFromPoint(best.x,best.y);` +
        `if(!(hit&&(hit===best.el||best.el.contains(hit))))best=null;}` +
        `if(best){delete best.el;return best;}` +
        `if(side==='right')return {x:r.right,y:r.y+r.height/2,via:'edge'};` +
        `if(side==='left')return {x:r.left,y:r.y+r.height/2,via:'edge'};` +
        `if(side==='bottom')return {x:r.x+r.width/2,y:r.bottom,via:'edge'};` +
        `return {x:r.x+r.width/2,y:r.y,via:'edge'};`;
      const p = await run(body);
      if (!p) return null;
      const ox = offset && Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0;
      const oy = offset && Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0;
      return { x: Math.round(p.x + ox), y: Math.round(p.y + oy), via: p.via };
    };

    // 起点/落点上"实际是哪个元素"——拖拽最容易悄悄打偏（坐标落到了浮层、
    // 遮挡层或相邻的另一个节点上），不报出来就又是一次"报成功但没做对"。
    // 同时向上找最近的 data-ai-id：如果它**不是**本次目标，说明抓错了节点
    // （实测踩过：两个节点视觉重叠时，拖 A 实际按在叠在上面的 B 的浮层上，
    // 事件照常派发、success 照常返回，但什么都没动）。
    const atPointJs = (p, selfId) =>
      `var e=document.elementFromPoint(${p.x},${p.y});if(!e)return null;` +
      `var anc=e.closest?e.closest('[data-ai-id]'):null;` +
      `var id=anc?anc.getAttribute('data-ai-id'):null;` +
      `return {el:(e.tagName||'')+' '+(typeof e.className==='string'?e.className:'').slice(0,60),` +
      `id:id,is_target:(id===null||id===${JSON.stringify(String(selfId))})};`;

    // 起点
    let from = null;
    if (params.from && Number.isFinite(Number(params.from.x))) {
      from = { x: Math.round(Number(params.from.x)), y: Math.round(Number(params.from.y)), via: 'explicit' };
    } else if (aiId) {
      from = await pointFor(`[data-ai-id="${aiId}"]`, anchorOf(params.from_anchor), params.from_offset);
    }
    if (!from) return { success: false, error: 'drag: start element not found: ' + aiId };

    // 终点：显式坐标 > to_target 元素 > dx/dy 相对位移
    // 绝对坐标同时接受 {to:{x,y}} 与扁平的 to_x/to_y —— MCP 的 schema 用扁平写法
    // （更好填），raw WS 习惯嵌套写法。两种都在**这里**归一，避免"某一层认识、
    // 另一层不认识"的隐性不一致（实测踩过：raw WS 传 to_x 被当成没给落点）。
    let to = null;
    const explicitTo =
      params.to && Number.isFinite(Number(params.to.x))
        ? params.to
        : (Number.isFinite(Number(params.to_x)) || Number.isFinite(Number(params.to_y)))
          ? { x: params.to_x, y: params.to_y }
          : null;
    if (explicitTo && Number.isFinite(Number(explicitTo.x)) && Number.isFinite(Number(explicitTo.y))) {
      to = { x: Math.round(Number(explicitTo.x)), y: Math.round(Number(explicitTo.y)), via: 'explicit' };
    } else if (params.to_target) {
      to = await pointFor(`[data-ai-id="${params.to_target}"]`, anchorOf(params.to_anchor), params.to_offset);
      if (!to) return { success: false, error: 'drag: to_target not found: ' + params.to_target };
    } else if (Number.isFinite(Number(params.dx)) || Number.isFinite(Number(params.dy))) {
      to = { x: Math.round(from.x + Number(params.dx || 0)), y: Math.round(from.y + Number(params.dy || 0)), via: 'delta' };
    }
    if (!to) return { success: false, error: 'drag: need one of params.to / to_target / dx,dy' };

    // 视口校验：视口外的点直接派发会落到别的元素上，必须明确报错而不是静默误报成功。
    const dims = await run('return {w:window.innerWidth,h:window.innerHeight};');
    const inVp = (p) => p && p.x >= 0 && p.y >= 0 && p.x <= dims.w && p.y <= dims.h;
    if (!inVp(from)) {
      return { success: false, error: `drag: start point (${from.x},${from.y}) is outside the viewport (${dims.w}x${dims.h})`, drag_from: from };
    }
    if (!inVp(to)) {
      return { success: false, error: `drag: end point (${to.x},${to.y}) is outside the viewport (${dims.w}x${dims.h})`, drag_from: from, drag_to: to };
    }

    // 修饰键 → CDP modifiers 位掩码
    const mod = modifierMask(params.hold || params.keys);

    const dbg = view.webContents.debugger;
    const send = (m, p) => dbg.sendCommand(m, p);
    // 按键：画布类应用常把平移绑在中键/右键拖上（左键留给框选），所以要能选按键。
    const btnParam = String(params.button || 'left').toLowerCase();
    const btn = btnParam === 'middle' ? 'middle' : btnParam === 'right' ? 'right' : 'left';
    const downButtons = btn === 'middle' ? 4 : btn === 'right' ? 2 : 1;
    const steps = Math.min(60, Math.max(2, Number(params.steps) || 14));
    const total = Math.min(5000, Math.max(60, Number(params.duration_ms) || 420));
    const per = Math.max(4, Math.round(total / steps));

    // 记录起点/落点上到底是哪个元素：命中遮挡层或**另一个节点**时，调用方能立刻
    // 看出这一拖是不是打偏了，而不是拿到一个笼统的 success 去猜。
    const fromAt = await run(atPointJs(from, aiId)).catch(() => null);
    const toAt = await run(atPointJs(to, aiId)).catch(() => null);
    // 起点抓到了别的节点 = 视觉重叠下的抓错目标。事件会照常派发、页面却纹丝不动，
    // 必须显式告诉调用方，否则调用方只会以为"拖拽不生效"。
    const startOffTarget = !!(fromAt && fromAt.id && fromAt.id !== aiId);

    // 同坐标先 move 一次：让页面进入 hover 态（部分实现只在 hover 后才可拖）。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers: mod });
    await new Promise((r) => setTimeout(r, 30));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: btn, buttons: downButtons, clickCount: 1, modifiers: mod });
    // 按下后必须在**同一点**再补一次 mouseMoved：拖拽实现普遍以"按下后的第一个
    // mousemove"为位移基准点，若直接进位移循环，这一步的偏移会被吃掉 —— 实测
    // 请求 (-180,150) 只走到 (-167,139)，恰好是 13/14，稳定复现。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(20, per)));
    // 中间位移是拖拽的本质：没有它，mousePressed/mouseReleased 同坐标就只是"点击"。
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: btn, buttons: downButtons, modifiers: mod });
      await new Promise((r) => setTimeout(r, per));
    }
    // 收尾再补一次终点位置并等一拍再释放：实测「最后一步 mouseMoved 会被紧跟着的
    // mouseReleased 吃掉」，位移会稳定少 1/steps（14 步时实测 -180,150 只走了
    // -167,139 = 13/14）。多补一次终点让落点精确。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(30, per)));
    // 终点"停稳"：再补几个亚像素级的微动。高缩放的画布上连接点只有 1–3 像素，
    // 一次到点未必被框架的命中判定捕捉到（实测 8.3% 缩放的 React Flow 画布上
    // 连线时好时坏）；人手在目标上也会有这种细微停顿/抖动。
    const settle = Number(params.settle_moves) >= 0 ? Number(params.settle_moves) : 3;
    for (let k = 0; k < settle; k++) {
      const jx = to.x + (k % 2 === 0 ? 1 : -1);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: jx, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
      await new Promise((r) => setTimeout(r, Math.max(12, Math.round(per / 3))));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(20, Math.round(per / 2))));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: btn, buttons: 0, clickCount: 1, modifiers: mod });
    return {
      success: true,
      dragged_via: 'cdp-drag',
      button: btn,
      target: aiId,
      drag_from: from,
      drag_to: to,
      from_at: fromAt && fromAt.el,
      from_at_id: fromAt && fromAt.id,
      to_at: toAt && toAt.el,
      to_at_id: toAt && toAt.id,
      start_hit_target: !startOffTarget,
      steps,
      // 抓在了别的元素上：这一拖很可能什么也没动。明确警告而不是让调用方
      // 从"什么都没发生"里自己猜原因。
      warning: startOffTarget
        ? `drag started on a different element (${fromAt.id}) than the target (${aiId}) — often caused by visual overlap; pass from_offset to aim at another point of the element`
        : undefined,
    };
  }

  // 受信按键（ui.act {action:'press'}）——删除节点/撤销重做/取消选中/方向键微调
  // 这类应用快捷键的唯一通路。target 可选：给了就先在页内聚焦它，否则按键发给
  // 当前焦点（多数画布应用的快捷键挂在 document/window 上，先点一下画布即可）。
  async _cdpPress(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}
    if (aiId) {
      await run(`var el=document.querySelector(${JSON.stringify('[data-ai-id="' + String(aiId) + '"]')});if(el&&el.focus)el.focus();return true;`);
    }
    const list = Array.isArray(params.keys) && params.keys.length
      ? params.keys
      : [params.key !== undefined ? params.key : 'Enter'];
    const dbg = view.webContents.debugger;
    const send = (m, p) => dbg.sendCommand(m, p);
    const done = [];
    for (const name of list) {
      const spec = keySpec(name, params.modifiers);
      if (!spec) return { success: false, error: 'press: unsupported key: ' + String(name), pressed: done };
      await this._cdpKey(send, spec);
      done.push(spec.key);
      await new Promise((r) => setTimeout(r, Math.max(20, Number(params.interval_ms) || 60)));
    }
    return { success: true, pressed_via: 'cdp-key', pressed: done };
  }

  // 文件上传（封面/附件等，跨框架通用）：HTMLInputElement[type=file] 只能由
  // DevTools 的 DOM.setFileInputFiles 写入真实文件路径（网页脚本无法伪造
  // FileList，preload 同样受限），对任何站点/上传组件一视同仁。找到目标 input
  // 的 objectId 后直接注入文件路径，等价于用户在系统文件选择器里选中。
  async _uploadViaCdp(view, aiId, filePath, tabId) {
    if (!this._canCdp(view)) return null;
    if (!filePath) throw new Error('upload requires a file path');
    const dbg = view.webContents.debugger;
    // 用 Runtime.evaluate 拿 objectId，不依赖 DOM nodeId 映射。不额外 click：
    // DOM.setFileInputFiles 会直接在目标 input 上写入文件并触发 change（等价于
    // 用户在系统选择器选中）；若再对它 click 会重新唤起系统文件框并清空 files，
    // 导致刚写入的状态被覆盖。由调用方负责先让上传组件就绪。
    const idRes = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');return el&&el.__proto__&&el.matches?el.matches('input[type=file],input')?el:null:null;})()`,
      returnByValue: false,
    });
    const objId = idRes && idRes.result && idRes.result.objectId;
    if (!objId) return null;
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], objectId: objId });
    // 兜底校验：确认 files 已写入
    const ver = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(function(){var f=document.querySelector('[data-ai-id="${aiId}"]').files;return f&&f.length>0?{name:f[0].name,size:f[0].size}:null;})()`,
      returnByValue: true,
    });
    const v = ver && ver.result && ver.result.value;
    if (!v) return { success: false, error: 'Upload not written to input' };
    return { success: true, uploaded: v.name, size: v.size };
  }

  // 通用文本输入（type/setContent 共用）：先让窗口/视图拿到焦点，再在页面里
  // DOM 原生聚焦（一次 evaluate 同步完成）→ CDP 受信 Cmd+A 全选 + Delete 清空
  // → 逐字符受信键入 + Enter。清空必须走编辑器自身的受信按键链路：Draft 等
  // 编辑器是受控组件，DOM 直接改（execCommand/clearContent）不会同步内部
  // EditorState，后续输入会被忽略（知乎正文 execCommand 清空后输入丢失证实）。
  // Cmd+A 触发编辑器自身 selectAll，Delete 触发 removeRange——但 Draft 的选区
  // 更新是异步的（React 渲染提交），Delete 必须在全选提交后发出，否则落在旧
  // 选区上。逐字符走 Input.dispatchKeyEvent（rawKeyDown/char/keyUp，仅 char
  // 携带 text），等价真实键盘输入，编辑器会应用当前行内样式（加粗/斜体）；
  // Input.insertText 是 IME 插入路径，会丢失行内样式。
  // 不识别编辑器框架；失败返回错误，由 agent 重读重试。
  async _inputViaCdp(view, aiId, text, tabId, opts = {}) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const inFrame = !!owning;
    // Run a JS snippet either in the owning frame (OOPIF) or the top frame.
    const run = async (jsBody) => {
      const fn = `(function(){${jsBody}})()`;
      return inFrame ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    // 先激活窗口/视图，再在页面内聚焦（顺序保证渲染进程处于激活态）。
    // 被遮挡时窗口 visibilityState=hidden，键盘事件同样会被渲染器丢弃。
    try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
    } catch(e) {}
    // 定位可编辑区并原生聚焦（不做 DOM 全选——交给 Cmd+A 受信按键）
    const prep = await run(
      `var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return {ok:false,err:'no-ref'};` +
      `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
      `var editable=(ed.contentEditable==='true')||(ed.tagName==='TEXTAREA')||(ed.tagName==='INPUT');` +
      `if(!editable)return {ok:false,err:'not-editable'};` +
      `ed.focus();` +
      `return {ok:true};`
    );
    if (!prep || !prep.ok) return null;
    // 清空收尾：拆掉残留的空块外壳。selectAll + 受信 Delete 只删文本不删外层块
    // 标签，浏览器会保留至少一个空块承载光标 —— 清一个 H2 段落得到的是
    // `<h2><br></h2>` 而不是空。残留外壳会让随后的排版一层层嵌进旧外壳（实测出现
    // h2>blockquote>pre>ul>li 的套娃），editor_blocks 的 role 也随之失真。
    // 只在"确实已经没有文本内容"时拆，有内容的块一个都不动。
    const stripEmptyShells = () => run(
      `var el=document.querySelector(${JSON.stringify('[data-ai-id="' + String(aiId) + '"]')});if(!el)return false;` +
      `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
      `if(ed.tagName==='INPUT'||ed.tagName==='TEXTAREA')return false;` +
      `if(ed.contentEditable!=='true')return false;` +
      `if((ed.innerText||'').trim()!=='')return false;` +
      `var BLOCK=/^(H1|H2|H3|H4|H5|H6|P|BLOCKQUOTE|PRE|UL|OL|LI|DIV|SECTION|ARTICLE)$/;` +
      `for(var g=0;g<12;g++){` +
      `if(ed.children.length!==1)break;` +
      `var k=ed.children[0];` +
      `if(!BLOCK.test(k.tagName))break;` +
      `if((k.innerText||'').trim()!=='')break;` +
      `while(k.firstChild)ed.insertBefore(k.firstChild,k);` +
      `ed.removeChild(k);}` +
      `return true;`
    );
    // clear 时先拆一遍：编辑器可能已经是"空但带外壳"的状态，不拆的话下面的
    // 幂等短路会把它当成"已经是空的"直接返回，外壳就永远留在那儿。
    if (!text) await stripEmptyShells();
    // 校验用的归一化。\r\n 统一成 \n，再压掉"排版空白"（空格/tab），但换行
    // 本身必须参与比对：把 \s 全剥掉会让 "a\nb\nc" 与 "abc" 等价，段落结构
    // 丢失就被判成成功 —— 那是对调用方的谎报，出了问题无从察觉。
    const norm = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, '');
    // 幂等短路：若可编辑区当前内容已恰好等于目标文本，直接返回而不做清空+重打。
    // 每次全量重写都会把草稿标脏，重新触发编辑器自身的"草稿备份"/版本气泡——对
    // 相同文本的重复调用（重试/校正）不应让它反复闪烁。
    const curText = await run(
      `var e=document.activeElement;return (e&&(e.innerText||e.value||''))||'';`
    );
    if (norm(curText) === norm(text)) {
      // "目标就是当前内容" 与 "目标本来就是空的" 必须区分开。
      // 后者几乎总是调用方的错误：ui.act 的 WS 契约把动作参数放在 params.params
      // 里（params.params.text），照着 MCP 的扁平形状写成 params.text 就会静默
      // 变成空文本 —— 而空字段恰好命中下面的短路，于是**什么都没打却报
      // success / method=cdp-input-unchanged**。这正是本项目最忌讳的谎报。
      // 实测就是这样被发现的：调用回执"成功"，输入框却仍是空的。
      if (!text) {
        return {
          success: false,
          error: 'type called with empty text — nothing was typed. '
            + 'Over WS the action params go in params.params (e.g. {action:"type", target:"<id>", params:{text:"..."}}), '
            + 'not at the top level. Use action:"clear" to empty a field.',
          method: 'cdp-input-empty-text',
          chars: 0,
        };
      }
      return { success: true, method: 'cdp-input-unchanged', changes: 0, chars: 0 };
    }
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    // 全选 + 整段删除。刻意不发送受信 Cmd+A：在本应用里注入受信 Cmd+A 会触发
    // macOS 的应用 About 面板（原生 NSAlert，"版本"弹窗），每次输入都弹。故全选
    // 一律走页内程序化选择。顶层文本流(contenteditable/input/textarea)用 Range/
    // setSelectionRange(_selectAllFallback) + 受信 Delete;OOPIF 子帧编辑器不做受信
    // 删除(受信 Delete 前是 DOM-Range 选区,部分富文本编辑器不把这些选区同步进自身
    // EditorState,Delete 落空→clear 无效),改为在所属帧内 execCommand selectAll+delete,
    // 走编辑器原生选区/删除链路,B站 read-editor 验证可被清到空。顶层路径行为不变。
    // 追加模式（type）：不清空，只把光标放到指定位置 —— 这样"插入话题标签后
    // 继续写正文"才成立。at: 'end' | 'start' | 'cursor'（cursor 表示不干预）。
    const replace = opts.replace !== false;
    if (!replace) {
      const at = opts.at === 'start' || opts.at === 'cursor' ? opts.at : 'end';
      if (at !== 'cursor') {
        await run(
          `var el=document.querySelector(${JSON.stringify('[data-ai-id="' + String(aiId) + '"]')});if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
          `if(ed.tagName==='INPUT'||ed.tagName==='TEXTAREA'){var L=(ed.value||'').length;` +
          `var p=(${JSON.stringify(at)}==='start')?0:L;try{ed.setSelectionRange(p,p);}catch(e){}return true;}` +
          `if(ed.contentEditable!=='true')return false;` +
          `try{var r=document.createRange();r.selectNodeContents(ed);` +
          `r.collapse(${JSON.stringify(at)}==='start');` +
          `var s=window.getSelection();s.removeAllRanges();s.addRange(r);return true;}catch(e){return false;}`
        );
        await new Promise((r) => setTimeout(r, 80)); // 等光标位置同步进编辑器状态
      }
    } else {
      const cleared = inFrame
        ? await this._clearInFrame(owning, aiId)
        : await (async () => {
            await this._selectAllFallback(view, aiId, tabId, null);
            await new Promise((r) => setTimeout(r, 120)); // 等选区同步进框架状态
            await this._cdpKey(send, { key: 'Delete', code: 'Delete', vk: 46, mod: 0 });
            await new Promise((r) => setTimeout(r, 80)); // 等删除后的空状态提交
            return true;
          })();
      if (!cleared && text) {
        // 清空失败但目标非空：先不空转，仍尝试继续键入（若编辑器未清空，键入会拼接而非替换）。
        await this._cdpKey(send, { key: 'Delete', code: 'Delete', vk: 46, mod: 0 });
      }
      if (!text) {
        // selectAll + 受信 Delete 对**多块内容**可能清不干净。此前每段都被
        // type 整篇替换掉所以没暴露；type 改为追加语义后编辑器会累积多段，
        // 实测残留 "第一段<div>第二段</div><h2>第三段</h2>"。因此清完校验一次，
        // 仍有文本就换编辑器原生 selectAll+delete 再清一遍。
        const left = await run(
          `var el=document.querySelector(${JSON.stringify('[data-ai-id="' + String(aiId) + '"]')});if(!el)return 0;` +
          `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
          `return String((ed.innerText!=null?ed.innerText:ed.value)||'').trim().length;`
        );
        if (left > 0) {
          await run(
            `var el=document.querySelector(${JSON.stringify('[data-ai-id="' + String(aiId) + '"]')});if(!el)return false;` +
            `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
            `try{ed.focus();document.execCommand('selectAll');document.execCommand('delete');}catch(e){}return true;`
          );
          await new Promise((r) => setTimeout(r, 150)); // 等编辑器状态提交
        }
        await stripEmptyShells();
      }
    }
    const paras = String(text == null ? '' : text).split('\n');
    // 段落内容快照：用来判断"这一下 Enter 到底有没有生效"。
    const snap = () => run(
      `var e=document.activeElement;var t=String((e&&(e.innerText||e.value))||'');` +
      `var b=(e&&e.querySelectorAll)?e.querySelectorAll('p,div,br').length:0;` +
      `return {len:t.length,nl:(t.match(/\\n/g)||[]).length,blocks:b};`
    );
    for (let i = 0; i < paras.length; i++) {
      if (paras[i]) await this._typeChars(send, paras[i]);
      if (i < paras.length - 1) {
        // 段间换行。富文本编辑器（ProseMirror/Draft…）自己接 keydown 处理
        // Enter 并已分好段；原生 textarea / 原生 contenteditable 没人接管，
        // 而 rawKeyDown 不带 text 时默认编辑动作不触发 —— 换行会静默丢失。
        // 故：先发受信 Enter，若内容毫无变化（说明没人处理它），再补一个带
        // text 的 char 事件把换行真正插进去。给已分段的编辑器补发会多插空行，
        // 所以这一步必须"看效果再决定"，不能无脑补。
        const before = await snap();
        await this._cdpKey(send, { key: 'Enter', code: 'Enter', vk: 13, mod: 0 });
        const after = await snap();
        const moved =
          Number(after && after.len) > Number(before && before.len) ||
          Number(after && after.nl) > Number(before && before.nl) ||
          Number(after && after.blocks) > Number(before && before.blocks);
        if (!moved) await this._cdpKey(send, { key: '\r', code: 'Enter', vk: 13, mod: 0, text: '\r' });
      }
    }
    // 通用校验：非空文本要求内容包含目标文本；空文本要求已清空（只允许空块残留）。
    // 任一框架均可，无占位符/块数特判。
    const after = await run(
      `var e=document.activeElement;return {text:(e.innerText||e.value||'')};`
    );
    const want = norm(text);
    const got = norm(after && after.text);
    const ok = want
      ? got.includes(want)
      : got === '';
    return ok
      ? { success: true, method: 'cdp-input', chars: (after && after.text) ? after.text.length : 0 }
      : { success: false, error: 'Input not verified — please re-read the tree and retry', method: 'cdp-input-failed' };
  }

  // OOPIF 内整段清空：在所属子帧上下文里聚焦 contenteditable，用 execCommand
  // selectAll + delete 走编辑器原生选区/删除链路（受信 Delete 前置 DOM-Range 选区对
  // 部分富文本编辑器无效）。返回是否已清到空。
  async _clearInFrame(frame, aiId) {
    try {
      const r = await frame.executeJavaScript(`(function(){
        var ref=document.querySelector('[data-ai-id="${aiId}"]');if(!ref)return {ok:false,reason:'no-ref'};
        var e=ref;if(ref.querySelector){var inner=ref.querySelector('[contenteditable="true"],textarea,input[type="text"],input[type="search"],input[type="title"],input:not([type])');if(inner)e=inner;}
        var isInput=(e.tagName==='INPUT'||e.tagName==='TEXTAREA');
        var isCE=e.contentEditable==='true';
        if(!(isInput||isCE))return {ok:false,reason:'not-editable'};
        e.focus();
        var ae=document.activeElement&&(document.activeElement===e?'same':'other:'+(document.activeElement.tagName||''));
        var sa=false;
        if(isCE){ sa=document.execCommand('selectAll'); }
        else if(isInput){ var len=(e.value||'').length; if(len){ try{e.setSelectionRange(0,len);}catch(_){ if(e.select)e.select(); } } }
        var del=document.execCommand('delete');
        var txt=isInput?(e.value||''):(e.innerText||e.textContent||'');
        return {ok:txt.trim()==='',sa:!!sa,del:!!del,left:(txt||'').trim().length,ae:ae};
      })()`);
      if (!(r && r.ok)) console.error('[clearInFrame] FAIL', JSON.stringify(r));
      return !!(r && r.ok);
    } catch (e) { console.error('[clearInFrame] THROW', e.message); return false; }
  }

  // 全选回退：Cmd+A 后选区仍为空时，用浏览器原生选区 API 选中可编辑区全部文本。
  // 返回 true 表示已有非空选区（Cmd+A 已生效或回退成功）；框架通过
  // selectionchange 同步内部状态，随后的受信 Delete 即可整段删除。
  async _selectAllFallback(view, aiId, tabId, frame) {
    const r = frame
      ? await frame.executeJavaScript(
          `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
          `var s=window.getSelection();` +
          `if(s&&!s.isCollapsed&&s.toString().length>0)return true;` +
          `if(ed.tagName==='TEXTAREA'||ed.tagName==='INPUT'){var v=ed.value||'';if(v){ed.focus();ed.setSelectionRange(0,v.length);}return v.length>0;}` +
          `var walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);` +
          `var first=null,last=null,t;` +
          `while(t=walker.nextNode()){if(t.nodeValue&&t.nodeValue.length){if(!first)first=t;last=t;}}` +
          `if(!first)return false;` +
          `var rng=document.createRange();rng.setStart(first,0);rng.setEnd(last,last.nodeValue.length);` +
          `s.removeAllRanges();s.addRange(rng);` +
          `return rng.toString().length>0;})()`)
      : await this.evaluate(
          `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
          `var s=window.getSelection();` +
          `if(s&&!s.isCollapsed&&s.toString().length>0)return true;` +
          `if(ed.tagName==='TEXTAREA'||ed.tagName==='INPUT'){var v=ed.value||'';if(v){ed.focus();ed.setSelectionRange(0,v.length);}return v.length>0;}` +
          `var walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);` +
          `var first=null,last=null,t;` +
          `while(t=walker.nextNode()){if(t.nodeValue&&t.nodeValue.length){if(!first)first=t;last=t;}}` +
          `if(!first)return false;` +
          `var rng=document.createRange();rng.setStart(first,0);rng.setEnd(last,last.nodeValue.length);` +
          `s.removeAllRanges();s.addRange(rng);` +
          `return rng.toString().length>0;})()`,
          tabId);
    return !!r;
  }

  // 逐字符受信键入：rawKeyDown→char→keyUp，等价真实键盘输入。
  // 注意：text 字段对 keyDown 和 char 事件都会插入文本，若 keyDown 也带 text 会
  // 造成每个字符插入两遍（知乎标题曾出现"测测试试标标题题"）；rawKeyDown 会忽略
  // text，按下事件不携带文本，仅 char 事件携带，与 Puppeteer keyboard.type 一致。
  // 编辑器（Draft/ProseMirror/Quill…）会按当前光标处的行内样式应用格式。
  async _typeChars(send, text) {
    for (const ch of Array.from(text)) {
      const base = { key: ch, code: '', windowsVirtualKeyCode: 0, modifiers: 0 };
      await send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      await send('Input.dispatchKeyEvent', { ...base, type: 'char', text: ch, unmodifiedText: ch });
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
  }

  // === Tab lifecycle ===

  newTab(url = null) {
    const tabId = ++this.tabCounter;
    const self = this;
    const view = new BrowserView({
      webPreferences: {
        preload: this._preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Required for the CommonJS preload (bridge.cjs) to `require()` local
        // modules (./extractor.cjs, ./actions.cjs, ./watcher.cjs). A sandboxed
        // preload can only require Electron's whitelist. Security is unchanged:
        // nodeIntegration stays false + contextIsolation true, so page code
        // has no Node access regardless of the OS-level renderer sandbox.
        sandbox: false,
        partition: 'persist:ai-browser',
        persistStorage: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.tabs.set(tabId, view);

    // Tabs created after a subscribe should inherit the CDP domains already
    // active, so network_response / js_error keep flowing without re-subscribing.
    // _ensureCdp attach + enable is idempotent (attach guarded by _cdpTabs).
    if (this._runtimeSubscribers.size > 0) this._ensureCdp(tabId, view, 'Runtime');
    // Network：默认在首个真实导航前就启用（不再等订阅），否则初始 HTML/API 与
    // 导航阶段发出的 POST 全部丢失 —— agent 永远拿不到它们的请求体。
    // 关闭开关：AI_BROWSER_NETWORK_CAPTURE=0 或 ui.network_configure{enabled:false}。
    this._ensureNetworkCapture(tabId, view);

    // Mask automation fingerprint: remove Electron from UA
    view.webContents.setUserAgent(config.userAgent);

    // Intercept window.open / new-window → create new tab instead
    view.webContents.setWindowOpenHandler(({ url: urlToOpen }) => {
      const childId = self.newTab(urlToOpen);
      // Track which source tab opened a new tab so `executeAction` can report the
      // resulting tab and auto-follow it. Generic (any target=_blank / window.open).
      self._openedTabs.set(tabId, { id: childId, url: urlToOpen });
      return { action: 'deny' };
    });

    // setActive handles addBrowserView + layout — don't add twice
    this.setActive(tabId);

    // canvas 绘制记录必须在**首个真实导航之前**装好，否则页面早画完了什么都录不到。
    // 但它又必须在 setActive 之后：BrowserView 还没被加进窗口时，debugger 通道
    // 不响应（实测 Runtime.enable 直接挂死）。
    // newTab 仍同步返回 tabId（调用方依赖），导航推迟到 hook 装完；安装失败或超时
    // 也照常导航 —— 绝不能因为要录 canvas 就把 tab 卡死。
    // hook 关闭时（当前默认）走原来的同步导航：把导航推迟成异步会引入时序抖动
    // （实测 richtext 偶发 110/111），这个代价不值得为一个未验证通过的功能付。
    if (isCanvasHookEnabled(process.env.AI_BROWSER_CANVAS_HOOK)) {
      // CDP 的 await 命令在页面加载**之后**才可用（刚创建的 tab 上会挂死），
      // 所以装 hook 的时机放在首次加载完成。代价是首屏已经画完的内容拿不回来
      // （configure({reload:true}) 可以补齐）。
      const install = () => { this._ensureCanvasHook(tabId, view).catch(() => false); };
      view.webContents.once('did-finish-load', install);
      if (url) {
        view.webContents.loadURL(url);
      }
    } else if (url) {
      view.webContents.loadURL(url);
    }

    // Force repaint after load — BrowserView content can be loaded but not
    // painted by the compositor. Remove + re-add forces a full repaint.
    //
    // Hook every navigation signal, not just the two load events. Reported
    // symptom: page HAS navigated to the new view (agent reads the new DOM /
    // canvas through the tree and evaluate) but the window keeps showing the
    // previous one until you click tabs back and forth — clicking a tab is
    // exactly what calls removeBrowserView + addBrowserView + setBounds, i.e.
    // it is the only thing that forces the compositor to repaint.
    //
    //   did-navigate-in-page — SPA route changes (history.pushState / hash).
    //     Fires on every router push, which is how canvas-style apps swap views.
    //   did-frame-finish-load — a sub-frame finished loading. ComfyUI-style
    //     editors boot inside an iframe long after the top document finished,
    //     so did-finish-load has already fired and repainted an empty shell.
    //   did-navigate — any cross-document navigation, including programmatic
    //     location.href assignment the app does on its own.
    if (url) {
      const repaint = () => { self._scheduleRepaint(tabId); };
      view.webContents.on('dom-ready', repaint);
      view.webContents.on('did-finish-load', repaint);
      view.webContents.on('did-navigate', repaint);
      view.webContents.on('did-navigate-in-page', repaint);
      view.webContents.on('did-frame-finish-load', repaint);
    } else {
      // No URL at construction time (new_tab with no url, then navigate):
      // register the same hooks now, or the later navigate() would never
      // repaint — which was one of the paths that showed a stale view.
      this._attachRepaintHooks(tabId, view);
    }
    return tabId;
  }

  /**
   * Attach compositor-repaint hooks to a tab's webContents.
   * Idempotent per tab: re-registering would schedule redundant remove/add
   * cycles, so a WeakSet of hooked views guards it.
   */
  _attachRepaintHooks(tabId, view) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    if (!this._repaintHooked) this._repaintHooked = new WeakSet();
    if (this._repaintHooked.has(view)) return;
    this._repaintHooked.add(view);
    const repaint = () => { this._scheduleRepaint(tabId); };
    view.webContents.on('dom-ready', repaint);
    view.webContents.on('did-finish-load', repaint);
    view.webContents.on('did-navigate', repaint);
    view.webContents.on('did-navigate-in-page', repaint);
    view.webContents.on('did-frame-finish-load', repaint);
  }

  /**
   * Coalesce repaint requests. A single page load fires dom-ready +
   * did-navigate + did-navigate-in-page + did-frame-finish-load within a few
   * hundred ms; a load like ComfyUI's fires dozens of did-frame-finish-load.
   * Without coalescing that is dozens of remove/add cycles — visible flicker
   * and wasted compositing work. Debounce ~120ms: late enough to collapse the
   * burst, early enough that the user sees the new view essentially at once.
   */
  _scheduleRepaint(tabId, delay = 120) {
    const prev = this._repaintTimers.get(tabId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._repaintTimers.delete(tabId);
      const view = this._getView(tabId);
      if (view) this._forceRepaint(view);
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    this._repaintTimers.set(tabId, t);
  }

  /**
   * Remove + re-add the BrowserView to force the compositor to paint it.
   * Safe for a non-active tab too: the view is re-added in the same position
   * (only the active view is normally attached, so re-adding an inactive one
   * would show it — guard by re-asserting the active view afterwards).
   */
  _forceRepaint(view) {
    const tabId = this._tabIdOfView(view);
    const wasActive = tabId === this.activeTab;
    try {
      this.window.removeBrowserView(view);
      this.window.addBrowserView(view);
      this._layoutView(view);
    } catch(e) { return false; }
    // Cumulative counter, reported by ui.repaint. Not just a debug aid: it is
    // the only externally observable proof that a repaint actually happened.
    // "The window looks stale" has no other symptom to check, and a caller
    // cannot poll for it — polling calls repaint itself, which *consumes* the
    // queued debounce timer and destroys the very evidence being looked for.
    this._repaintCount = (this._repaintCount || 0) + 1;
    // If we just re-added an inactive view it is now on top of the stack —
    // put the real active view back so the user sees the tab they selected.
    if (!wasActive) {
      const active = this._getView(this.activeTab);
      if (active) {
        try {
          this.window.removeBrowserView(view);
          this.window.addBrowserView(active);
          this._layoutView(active);
        } catch(e) {}
      }
    }
    return true;
  }

  _tabIdOfView(view) {
    for (const [id, v] of this.tabs) if (v === view) return id;
    return null;
  }

  /**
   * Repaint on demand (ui.repaint). The "page shows stale content" case has
   * no observable state to detect it from — the DOM and evaluate already report
   * the NEW page while the compositor shows the OLD one — so the agent needs an
   * explicit "I know this window looks wrong, redraw it" call rather than a
   * heuristic.
   */
  repaint(tabId) {
    const tid = tabId !== undefined && tabId !== null ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };
    // Cancel any queued repaint so this one is the last word.
    const pending = this._repaintTimers.get(tid);
    // `was_pending` is how a caller tells whether the navigation hooks are
    // alive: right after a navigation there is normally a queued repaint; once
    // it has drained, there is none. It also tells the agent "you did not need
    // to ask, the browser already scheduled one" — i.e. the window was stale
    // for ~120ms and has since caught up on its own.
    if (pending) { clearTimeout(pending); this._repaintTimers.delete(tid); }
    const ok = this._forceRepaint(view);
    return { ok, tab: tid, was_active: tid === this.activeTab, was_pending: !!pending, repaint_count: this._repaintCount || 0 };
  }

  closeTab(tabId) {
    const view = this._getView(tabId);
    if (!view) return false;
    this.window.removeBrowserView(view);
    if (view.webContents && !view.webContents.isDestroyed()) {
      try { view.webContents.debugger.detach(); } catch(e) {}
      view.webContents.close();
    }
    this.tabs.delete(tabId);
    // Release per-tab network resources so a closed tab can never leak its
    // debugger attachment or cached request entries / stale monitors.
    this._cleanupTabResources(tabId);
    if (this.activeTab === tabId || this.activeTab === null) {
      // switch to first remaining tab — must re-addBrowserView
      const first = this.tabs.keys().next();
      this.activeTab = first.done ? null : first.value;
      if (!first.done) {
        const nextView = this._getView(this.activeTab);
        this.window.addBrowserView(nextView);
        this._layoutView(nextView);
        // Force repaint
        nextView.webContents.setBackgroundThrottling(false);
      }
    }
    return true;
  }

  // Tear down a closed tab's network-monitoring bookkeeping:
  //  - detach that tab's shared per-tab debugger (other tabs/subscribers are
  //    unaffected — each tab owns its own webContents debugger)
  //  - drop cached request entries made on that tab
  _cleanupTabResources(tabId) {
    const entry = this._cdpTabs.get(tabId);
    if (entry) {
      try { entry.wc.debugger.detach(); } catch(e) {}
      this._cdpTabs.delete(tabId);
    }
    for (const [requestId, r] of this._networkRequestMap) {
      if (r.tabId === tabId) this._networkRequestMap.delete(requestId);
    }
    // 释放该 tab 的抓包日志与 body 内存，避免关掉的 tab 继续占着配额。
    this.networkMonitor.clearBodyFetcher(tabId);
    this.networkMonitor.clear(tabId);
  }

  listTabs() {
    const list = [];
    for (const [id, view] of this.tabs) {
      list.push({
        id,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        active: id === this.activeTab,
      });
    }
    return list;
  }

  setActive(tabId) {
    if (!this.tabs.has(tabId)) return false;
    // Remove all browser views from window, then re-add only the active one
    for (const [id, view] of this.tabs) {
      try { this.window.removeBrowserView(view); } catch(e) {}
    }
    this.activeTab = tabId;
    const view = this._getView(tabId);
    if (view) {
      this.window.addBrowserView(view);
      this._layoutView(view);
      this._focusWebContents(view);
      view.webContents.setBackgroundThrottling(false);
    }
    return true;
  }

  /**
   * 让**页面**处于活动状态，但**不**把窗口拽到前台。
   *
   * 这是实测出来的（e2e/focus_ws.cjs）：ui.new_tab / ui.set_active_tab 每次都调
   * webContents.focus()，而它会把整个窗口激活 —— agent 每开一个标签页就把人正在
   * 做的事打断一次。其它所有操作（act / get_tree / evaluate / peek / scroll /
   * canvas / network）经逐项测量都不抢焦点，只有这两个不是。
   *
   * AI_BROWSER_FOCUS=auto（默认）：不碰真实窗口焦点，改用 CDP
   *   Emulation.setFocusEmulationEnabled 让页面内的 document.hasFocus() 等状态
   *   保持正常（依赖它的懒加载 / 动画 / 富文本聚焦态不会僵住），但键盘焦点留在
   *   用户那边 —— 这正是我们要的。
   *   always：旧行为，直接把焦点交给 web contents（个别站点确需时用）。
   *   never：两者都不做。
   */
  _focusWebContents(view) {
    const policy = String(process.env.AI_BROWSER_FOCUS || 'auto').toLowerCase();
    try {
      if (!view || !view.webContents || view.webContents.isDestroyed()) return;
      if (policy === 'never') return;
      if (policy === 'always') {
        // 必须与 _focusWindow 的 always 分支做同样的事：只调 webContents.focus()
        // **不会**把窗口带到前台（实测 focus 套件的 G2 对照组里 new_tab /
        // set_active_tab 因此不抢，而 act type/click 抢 —— 同一个 always 策略
        // 两套行为）。always 的契约就是"每次操作都把窗口带到前台"，这里补齐。
        try {
          if (this.window.show) this.window.show();
          if (this.window.moveTop) this.window.moveTop();
          if (this.window.focus) this.window.focus();
        } catch (e) { /* 窗口已销毁 */ }
        view.webContents.focus();
        return;
      }
      // auto：只"伪造"页面内的焦点状态。CDP 尚未 attach（首次导航前的短暂窗口期）
      // 会 reject，静默忽略 —— 绝不因此影响标签页创建或导航。
      const p = view.webContents.debugger.sendCommand(
        'Emulation.setFocusEmulationEnabled', { enabled: true }
      );
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* debugger 未 attach / 页面已销毁 —— 忽略 */ }
  }

  _layoutView(view) {
    const bounds = this.window.getContentBounds();
    const TAB_BAR_HEIGHT = 36;
    view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: bounds.width, height: bounds.height - TAB_BAR_HEIGHT });
  }

  addSubscription(sessionId, events) {
    const existing = this.subscriptions.get(sessionId) || new Set();
    events.forEach(e => existing.add(e));
    this.subscriptions.set(sessionId, existing);
    if (events.includes('network') || events.includes('network_response')) this._startNetworkMonitor(sessionId);
    if (events.includes('js_error') || events.includes('unhandledrejection')) this._startRuntimeMonitor(sessionId);
  }

  _networkRequestMap = new Map(); // requestId -> {url, tabId, finished}

  // DEPRECATED：被 ui.network_list / ui.network_get 取代（下一主版本删除）。
  // 兼容行为：按 url_pattern 选【最近完成】的匹配项（旧实现按 Map 正向遍历，
  // 同 URL 多次请求时拿到的是最旧那条），响应仍保持旧形状 {body:string|null}。
  async getNetworkBody(urlPattern, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    const dbg = view && view.webContents && view.webContents.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;

    const rec = this.networkMonitor.findLatestFinished(tid, urlPattern || '');
    if (rec) {
      try {
        const detail = await this.networkMonitor.get(rec.network_id, {
          include_response_body: true,
          body_limit: 5000,
        });
        const body = detail && detail.response && detail.response.body && detail.response.body.raw
          ? detail.response.body.raw.data : null;
        return body == null ? null : body;
      } catch (e) {
        // body 被淘汰/不可用：旧契约只能表达 null，但至少不谎报成空响应。
        return null;
      }
    }

    // 抓包关闭时退回旧索引路径（Network 域可能由订阅启用但未记日志）。
    for (const [requestId, entry] of this._networkRequestMap) {
      if (entry.tabId === tid && entry.finished && entry.url.indexOf(urlPattern) >= 0) {
        try {
          const result = await dbg.sendCommand('Network.getResponseBody', { requestId });
          return result.body ? result.body.slice(0, 5000) : null;
        } catch(e) { return null; }
      }
    }
    return null;
  }

  removeSubscription(sessionId, events) {
    const existing = this.subscriptions.get(sessionId);
    if (!existing) return;
    events.forEach(e => existing.delete(e));
    if (existing.size === 0) {
      this.subscriptions.delete(sessionId);
      this._stopNetworkMonitor(sessionId);
      this._stopRuntimeMonitor(sessionId);
    }
  }

  // Per-tab shared CDP debugger. A webContents can only be debugger-attached
  // once, so attach + a single message listener happen exactly once per tab; the
  // Network and Runtime domains are enabled lazily per demand, and subscribers
  // are reference-counted so the shared debugger is detached only when the last
  // network AND runtime subscriber both leave.
  _cdpTabs = new Map();            // tabId -> { wc, domains:Set<'Network'|'Runtime'> }
  _networkSubscribers = new Set(); // sessionIds currently using network events
  _runtimeSubscribers = new Set(); // sessionIds currently using js_error events

  // Attach the shared per-tab debugger if needed and enable a CDP domain.
  // ---- canvas 绘制调用记录 ----
  //
  // 必须在首个真实导航**之前**注入：canvas 是有状态的立即模式 API，页面加载时
  // 就把内容画完了，之后再注入什么都录不到。
  //
  // 两个关键点：
  // 1. Page.addScriptToEvaluateOnNewDocument **不传 worldName** 才进页面 main world。
  //    contextIsolation:true 下 preload 活在 isolated world，改自己 world 的原型
  //    截不到页面代码的调用。
  // 2. 用 Runtime.addBinding 安装上报通道（binding 名每 tab 随机，避免跨 tab 串台），
  //    回传在 CDP 的 Runtime.bindingCalled 里收取。
  async _ensureCanvasHook(tabId, view) {
    if (!isCanvasHookEnabled(process.env.AI_BROWSER_CANVAS_HOOK)) {
      this.canvasMonitor.markHook(tabId, false, ['canvas hook disabled via AI_BROWSER_CANVAS_HOOK']);
      return false;
    }
    const DEBUG = process.env.AI_BROWSER_CANVAS_DEBUG === '1';
    const log = (...a) => { if (DEBUG) console.error('[canvas-hook]', ...a); };
    try {
      this._ensureCdp(tabId, view, 'Page');
      const dbg = view && view.webContents && view.webContents.debugger;
      if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) {
        this.canvasMonitor.markHook(tabId, false, ['cdp debugger not attached']);
        return false;
      }
      const bindingName = `__aiCanvasReport_${tabId}_${Math.random().toString(36).slice(2, 8)}`;
      const source = buildCanvasHookSource({
        bindingName,
        bridgeKey: CANVAS_BRIDGE_KEY,
        mode: 'semantic',
      });

      // ⚠️ 实测结论：在**刚创建的 BrowserView** 上，await dbg.sendCommand('Runtime.enable')
      // 永远不返回（试过 20 秒、8 次重试，全部挂死），而同样"发了不等"的
      // Network.enable 却是生效的。也就是说：命令能送达，但响应在这个阶段回不来。
      // 因此这里一律 **fire-and-forget**，改用 Runtime.evaluate 去**验证**是否真的装上。
      // await 的 CDP 命令在**页面加载之后**是可用的（network 的 getResponseBody
      // 就是证据），但在刚创建的 tab 上会挂死。因此本方法只在加载完成后被调用，
      // 这里一律 await，并把每一步的失败原因打出来便于定位。
      const step = async (label, method, params, ms = 4000) => {
        let timer = null;
        const t = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(label + ' timeout ' + ms + 'ms')), ms);
        });
        try {
          return await Promise.race([dbg.sendCommand(method, params), t]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const tryStep = async (label, method, params, ms) => {
        try {
          await step(label, method, params, ms);
          log(label, 'ok');
          return true;
        } catch (e) {
          log(label, 'FAIL', (e && e.message) || e);
          return false;
        }
      };

      await tryStep('Runtime.enable', 'Runtime.enable', {}, 4000);
      await tryStep('Page.enable', 'Page.enable', {}, 4000);
      await tryStep('Runtime.addBinding', 'Runtime.addBinding', { name: bindingName }, 4000);
      // 对**后续**导航生效（这才是拿到完整绘制历史的正路）
      await tryStep('Page.addScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument', { source }, 4000);

      // 对**已经加载过**的当前页面直接注入，并抓运行时异常（脚本是否真跑起来）
      try {
        const r = await step('Runtime.evaluate', 'Runtime.evaluate',
          { expression: source, returnByValue: true, awaitPromise: false }, 6000);
        const ed = r && r.exceptionDetails;
        if (ed) log('hook 脚本运行时异常:', JSON.stringify(ed).slice(0, 800));
        else log('Runtime.evaluate(注入当前页) ok');
      } catch (e) {
        log('Runtime.evaluate FAIL', (e && e.message) || e);
      }

      this._canvasBindings.set(bindingName, tabId);

      let ok = false;
      try {
        const r = await step('probe', 'Runtime.evaluate', {
          expression: `typeof window[${JSON.stringify(CANVAS_BRIDGE_KEY)}]`,
          returnByValue: true,
        }, 4000);
        const v = r && r.result && r.result.value;
        log('probe typeof bridge =', v);
        ok = v === 'object';
      } catch (e) {
        log('probe FAIL', (e && e.message) || e);
      }
      this.canvasMonitor.markHook(
        tabId,
        ok,
        ok ? [] : ['hook 命令已执行但页面内未生效（见 AI_BROWSER_CANVAS_DEBUG=1 日志）']
      );
      return ok;
    } catch (e) {
      this.canvasMonitor.markHook(tabId, false, [`canvas hook install failed: ${(e && e.message) || e}`]);
      return false;
    }
  }

  /**
   * 窗口焦点策略 —— 这是个真实的可用性问题：agent 每次点击/输入都把窗口
   * 拽到最前，等于人完全没法用电脑。
   *
   * AI_BROWSER_FOCUS:
   *   auto   (默认) 只在窗口被最小化/隐藏时恢复可见，**不** moveTop、**不** focus。
   *                 CDP 受信输入（Input.dispatchKeyEvent / dispatchMouseEvent）在窗口
   *                 非前台时依然生效，加上已有的 disable-backgrounding-occluded-windows /
   *                 disable-renderer-backgrounding / disable-background-timer-throttling，
   *                 后台窗口不会被降频或丢事件。
   *   always        旧行为：每次都 show + moveTop + focus（需要抢焦点时用）。
   *   never         完全不碰窗口状态。
   */
  _focusWindow(view) {
    const policy = String(process.env.AI_BROWSER_FOCUS || 'auto').toLowerCase();
    if (policy === 'never') return;
    try {
      if (policy === 'always') {
        if (this.window.show) this.window.show();
        if (this.window.moveTop) this.window.moveTop();
        if (this.window.focus) this.window.focus();
        if (view && view.webContents && view.webContents.focus) view.webContents.focus();
        return;
      }
      // auto：产品承诺"窗口真实可见、人可随时介入"，所以被最小化/隐藏时要恢复可见；
      // 但不主动抢到最前 —— 人可以继续用别的窗口，需要时自己点过来。
      // 用 showInactive()，语义才前后一致：auto 分支**从不**夺走键盘焦点。
      const hidden = (this.window.isVisible && !this.window.isVisible()) ||
                     (this.window.isMinimized && this.window.isMinimized());
      if (hidden) {
        if (this.window.isMinimized && this.window.isMinimized() && this.window.restore) {
          try { this.window.restore(); } catch (e) { /* 已销毁 */ }
        }
        if (typeof this.window.showInactive === 'function') this.window.showInactive();
        else if (this.window.show) this.window.show();
      }
    } catch (e) { /* 窗口已销毁等情况，忽略 */ }
  }

  _canvasTab(tabId) {
    return tabId !== undefined ? tabId : this.activeTab;
  }

  canvasList(tabId) {
    return this.canvasMonitor.list(this._canvasTab(tabId));
  }

  canvasRead(tabId, opts = {}) {
    return this.canvasMonitor.read(this._canvasTab(tabId), opts || {});
  }

  async canvasConfigure(tabId, opts = {}) {
    const tid = this._canvasTab(tabId);
    const mode = this.canvasMonitor.setMode(tid, opts.mode);
    if (opts.clear) this.canvasMonitor.clear(tid);
    const view = this._getView(tid);
    if (view) {
      await this._ensureCanvasHook(tid, view);
      // 只有调用方显式要求才重载：hook 对"安装之前已经画完"的内容无能为力，
      // 重载是唯一能拿到完整绘制历史的办法 —— 但它会丢掉用户当前状态，
      // 所以绝不默认做。
      if (opts.reload === true) {
        try { view.webContents.reload(); } catch (e) {}
      }
    }
    const st = this.canvasMonitor.list(tid);
    return {
      mode,
      hook_installed: st.hook_installed,
      // hook 只对安装之后的绘制生效；安装前已经画完的内容拿不回来。
      effective: 'immediate_future_calls',
      past_content_recovered: false,
      reload_required_for_complete_history: !st.hook_installed,
      retention: st.retention,
      warnings: st.warnings,
    };
  }

  // 截图兜底：只在语义层读不懂（WebGL/纯像素）时由调用方显式触发。
  // 默认关闭语义由调用方控制；这里只提供能力并明确警告它会消耗视觉 token。
  async canvasCapture(tabId, canvasId) {
    const tid = this._canvasTab(tabId);
    const view = this._getView(tid);
    if (!view) return null;
    const dbg = view.webContents && view.webContents.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;
    const rect = await this.evaluate(
      `(function(id){var els=document.querySelectorAll('canvas');` +
      `for(var i=0;i<els.length;i++){var e=els[i];` +
      `if(e.__aiCanvasId===id||e.id===id){var r=e.getBoundingClientRect();` +
      `return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};}}` +
      `return null;})(${JSON.stringify(String(canvasId || ''))})`,
      tid
    );
    if (!rect || !rect.width || !rect.height) return null;
    try {
      const res = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      return {
        mime_type: 'image/png',
        data_base64: (res && res.data) || null,
        width: rect.width,
        height: rect.height,
        warning: 'visual fallback; consumes caller visual tokens',
      };
    } catch (e) {
      return null;
    }
  }

  _ensureCdp(tabId, view, domain) {
    try {
      const wc = view.webContents;
      if (!this._cdpTabs.has(tabId)) {
        wc.debugger.attach('1.3');
        const entry = { wc, domains: new Set() };
        this._cdpTabs.set(tabId, entry);
        // Single shared listener per tab -> no duplicate broadcasts even when
        // many sessions subscribe to network/runtime events on the same tab.
        wc.debugger.on('message', (_event, method, params) => this._onCdpMessage(tabId, method, params));
      }
      const entry = this._cdpTabs.get(tabId);
      if (!entry.domains.has(domain)) {
        wc.debugger.sendCommand(domain + '.enable');
        entry.domains.add(domain);
      }
    } catch (e) { /* mid-navigation / already-attached elsewhere; skip this tab */ }
  }

  // 抓包用的 Network 域：默认在 tab 创建后、首个导航前启用。
  // Network.enable 必须显式带 maxPostDataSize，否则 Chromium 可能不内联
  // request.postData（POST 请求体就拿不到，只能靠 getRequestPostData 补）。
  // 实验参数（durable messages / buffer size）在部分 Chromium 上不支持，
  // 逐个降级，最后一档是裸 Network.enable。
  _ensureNetworkCapture(tabId, view) {
    const cfg = this.networkMonitor.tabConfig(tabId);
    if (!cfg.enabled) return;
    try {
      const wc = view.webContents;
      if (!this._cdpTabs.has(tabId)) {
        wc.debugger.attach('1.3');
        const entry = { wc, domains: new Set() };
        this._cdpTabs.set(tabId, entry);
        wc.debugger.on('message', (_event, method, params) => this._onCdpMessage(tabId, method, params));
      }
      const entry = this._cdpTabs.get(tabId);
      if (entry.domains.has('Network')) return;
      const attempts = [
        {
          maxPostDataSize: MAX_POST_DATA_SIZE,
          maxTotalBufferSize: 32 * 1024 * 1024,
          maxResourceBufferSize: 8 * 1024 * 1024,
          enableDurableMessages: true,
        },
        { maxPostDataSize: MAX_POST_DATA_SIZE },
        {},
      ];
      this.networkMonitor.setBodyFetcher(tabId, async (requestId, kind) => {
        if (!wc.debugger || typeof wc.debugger.isAttached !== 'function' || !wc.debugger.isAttached()) return null;
        if (kind === 'request') {
          const r = await wc.debugger.sendCommand('Network.getRequestPostData', { requestId });
          if (!r || r.postData == null) return null;
          // multipart 的文件字节 CDP 不保证给出 —— 如实标 incomplete。
          return { data: r.postData, complete: true };
        }
        const r = await wc.debugger.sendCommand('Network.getResponseBody', { requestId });
        if (!r) return null;
        return { data: r.body || '', base64Encoded: !!r.base64Encoded, complete: true };
      });
      const tryEnable = (i) => {
        if (i >= attempts.length) return;
        Promise.resolve(wc.debugger.sendCommand('Network.enable', attempts[i]))
          .then(() => { entry.domains.add('Network'); })
          .catch(() => tryEnable(i + 1));
      };
      tryEnable(0);
    } catch (e) { /* mid-navigation / already attached; skip */ }
  }

  _teardownCdpIfIdle() {
    // 抓包默认开启时 debugger 是常驻资源，不能因为最后一个订阅者离开就 detach，
    // 否则后续 ui.network_list 拿不到任何东西。
    if (NETWORK_CAPTURE_DEFAULT) return;
    if (this._networkSubscribers.size > 0 || this._runtimeSubscribers.size > 0) return;
    for (const entry of this._cdpTabs.values()) {
      try { entry.wc.debugger.detach(); } catch(e) {}
    }
    this._cdpTabs.clear();
  }

  async _startNetworkMonitor(sessionId) {
    if (this._networkSubscribers.has(sessionId)) return;
    this._networkSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureNetworkCapture(tabId, view);
  }

  async _startRuntimeMonitor(sessionId) {
    if (this._runtimeSubscribers.has(sessionId)) return;
    this._runtimeSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureCdp(tabId, view, 'Runtime');
  }

  _onCdpMessage(tabId, method, params) {
    // 抓包：请求侧（method / headers / POST body / initiator）与响应侧都落进
    // network_monitor；旧的网络事件推送行为保持不变。
    if (typeof method === 'string' && method.indexOf('Network.') === 0) {
      this._onNetworkCdpMessage(tabId, method, params);
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      // canvas hook 的上报通道。binding 名每 tab 随机，据此把载荷归到正确的 tab。
      const owner = this._canvasBindings.get(params && params.name);
      if (owner !== undefined && params && typeof params.payload === 'string') {
        try {
          this.canvasMonitor.ingest(owner, JSON.parse(params.payload));
        } catch (e) { /* 坏载荷不该影响页面，也不该冒到上层 */ }
      }
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      // CDP captures page main-world exceptions that preload window.onerror
      // (an isolated world) can never see under contextIsolation.
      const d = params.exceptionDetails || {};
      const ex = d.exception || {};
      this._broadcast('js_error', {
        text: d.text || '',
        message: (ex.description || ex.value) || d.text || '',
        url: d.url || '',
        lineNumber: d.lineNumber,
        columnNumber: d.columnNumber,
        tabId,
      });
    }
  }

  _onNetworkCdpMessage(tabId, method, params) {
    const m = this.networkMonitor;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const rec = m.onRequestWillBeSent(tabId, params);
        // 旧 getNetworkBody 的索引（结构保持 {url, tabId, finished}）。
        this._networkRequestMap.set(params.requestId, {
          url: rec ? rec.url : (params.request && params.request.url) || '',
          tabId,
          finished: false,
        });
        return;
      }
      case 'Network.requestWillBeSentExtraInfo':
        m.onRequestWillBeSentExtraInfo(tabId, params);
        return;
      case 'Network.responseReceivedExtraInfo':
        m.onResponseReceivedExtraInfo(tabId, params);
        return;
      case 'Network.dataReceived':
        m.onDataReceived(tabId, params);
        return;
      case 'Network.responseReceived': {
        m.onResponseReceived(tabId, params);
        const r = params.response || {};
        const entry = this._networkRequestMap.get(params.requestId);
        if (entry) entry.url = r.url;
        else this._networkRequestMap.set(params.requestId, { url: r.url, tabId, finished: false });
        this._broadcast('network_response', { url: r.url, status: r.status, statusText: r.statusText, mimeType: r.mimeType, tabId });
        return;
      }
      case 'Network.loadingFinished': {
        m.onLoadingFinished(tabId, params);
        const entry = this._networkRequestMap.get(params.requestId);
        if (entry) entry.finished = true;
        return;
      }
      case 'Network.loadingFailed': {
        m.onLoadingFailed(tabId, params);
        const requestId = params.requestId || '';
        const entry = this._networkRequestMap.get(requestId);
        const url = entry ? entry.url : requestId;
        this._broadcast('network_response', { url, status: 0, statusText: 'Failed', errorText: params.errorText || '', tabId });
        return;
      }
      default:
        return;
    }
  }

  // ==== 网络抓包查询（ui.network_list / get / clear / configure）====

  networkList(filter = {}) {
    return this.networkMonitor.list(filter);
  }

  async networkGet(networkId, opts = {}) {
    return await this.networkMonitor.get(networkId, opts);
  }

  networkClear(tabId) {
    const cleared = this.networkMonitor.clear(tabId);
    // 只清内存日志。浏览器 cache / cookie / storage 一概不动 —— 命名与响应都
    // 要避免被调用方误以为清了会话。
    return {
      ok: true,
      ...cleared,
      cleared_browser_cache: false,
      cleared_cookies: false,
      cleared_storage: false,
      scope: 'in_memory_request_log_only',
      warning: 'only the in-memory request log was cleared; browser cache, cookies and storage are untouched',
    };
  }

  networkConfigure(tabId, opts = {}) {
    // 上限只能由受控 env/config 改，调用方不能通过 WS 设成无限。
    const cfg = this.networkMonitor.configure(tabId, opts);
    if (cfg.enabled) {
      const view = this._getView(tabId);
      if (view) this._ensureNetworkCapture(tabId, view);
    }
    return {
      enabled: cfg.enabled,
      capture_bodies: cfg.capture_bodies,
      effective: cfg.enabled ? 'future_requests' : 'disabled',
      reload_required_for_initial_navigation: true,
      capabilities: {
        request_headers: true,
        request_body: true,
        durable_response_bodies: false,
        sensitive_headers_optin: this.networkMonitor.sensitiveAllowed,
      },
      limits: this.networkMonitor.captureInfo(tabId).limits,
      note: 'retention limits are controlled by AI_BROWSER_NETWORK_* env only, never by this call',
    };
  }

  async _stopNetworkMonitor(sessionId) {
    if (!this._networkSubscribers.has(sessionId)) return;
    this._networkSubscribers.delete(sessionId);
    this._teardownCdpIfIdle();
  }

  async _stopRuntimeMonitor(sessionId) {
    if (!this._runtimeSubscribers.has(sessionId)) return;
    this._runtimeSubscribers.delete(sessionId);
    this._teardownCdpIfIdle();
  }

  close() {
    // Detach every shared per-tab CDP debugger once, then drop all state.
    for (const entry of this._cdpTabs.values()) {
      try { entry.wc.debugger.detach(); } catch(e) {}
    }
    this._cdpTabs.clear();
    this._networkSubscribers.clear();
    this._runtimeSubscribers.clear();
    this.networkMonitor.clear();
    // Reject any in-flight requests so callers don't hang on close.
    for (const [id, pending] of this._pendingRequests) {
      try { pending.reject(new Error('PageManager closing')); } catch (e) {}
    }
    this._pendingRequests.clear();
    for (const [id, view] of this.tabs) {
      if (view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    this.tabs.clear();
    ipcMain.removeAllListeners('ai:tree');
    ipcMain.removeAllListeners('ai:action_result');
    ipcMain.removeAllListeners('ai:evaluate_result');
    ipcMain.removeAllListeners('ai:diff');
    ipcMain.removeAllListeners('ai:event');
  }
}

export { PageManager };
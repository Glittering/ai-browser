// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView } from 'electron';
import { config } from '../shared/config.js';
import axExtractor from './axExtractor.js';

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
    await view.webContents.loadURL(url);
    return true;
  }

  async getTree(focusedOnly = false, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { tree: null, context: null };

    return new Promise((resolve, reject) => {
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
      if (!center) return out;
      try {
        if (this.window.show) this.window.show();
        if (this.window.moveTop) this.window.moveTop();
        if (this.window.focus) this.window.focus();
        view.webContents.focus();
      } catch (e) {}
      const send = (method, params) => dbg.sendCommand(method, params);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
      const hoverMs = Math.max(0, Number(opts.hoverMs) || 450);
      await new Promise((r) => setTimeout(r, hoverMs));
      const afterRaw = await axExtractor.axRaw(dbg);
      const diff = axExtractor.diffAx(beforeRaw, afterRaw);
      out.revealed = diff.revealed;
      out.hidden = diff.hidden;
      const revertMs = Math.max(0, Number(opts.revertMs) || 1500);
      if (revertMs > 0) {
        setTimeout(() => { try { send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); } catch (e) {} }, revertMs);
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
    if (!target) return { success: false, error: 'No target' };

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
        const r = await this._inputViaCdp(view, target, action === 'clear' ? '' : (params.text || ''), tid);
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
    }

    const preloadRes = await this._executeViaPreload(action, target, params, tid);
    // preload 合成点击也可能触发 window.open → 新 tab，同样回报 opened_tab。
    if (action === 'click' && preloadRes && preloadRes.success) {
      preloadRes.opened_tab = this._consumeOpenedTab(tid, params.keep_tab === true);
    }
    return preloadRes;
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
    const owning = /^axf-/.test(target) ? await this._owningFrame(view, target) : null;
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
    await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
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
  async _frameOffset(view, frame, tabId) {
    try {
      const path = await frame.executeJavaScript('(location.pathname||"")');
      const base = await this.evaluate(
        `(function(path){
           var best=null;
           Array.prototype.forEach.call(document.querySelectorAll('iframe'),function(f){
             var r=f.getBoundingClientRect();
             if(r.width<4||r.height<4)return;
             var s=f.src||'';
             var match = (f.name&&f.name.length) ? (path.indexOf((f.name||''))===0) : (s.indexOf(path)>0);
             if(match){ best={x:r.left,y:r.top}; }
           });
           return best;
         })(${JSON.stringify(path)})`,
        tabId);
      return base;
    } catch (e) { return null; }
  }

  // 受信鼠标事件：先把元素滚入视口（屏外元素直接 dispatchMouseEvent 时坐标落在
  // 视口外，事件命中 body/空白处——探针证实点击不聚焦却误报成功），再按滚动后的
  // 中心点发 mousemove → mousePressed/mouseReleased（click）或仅 move（hover）。
  // OOPIF 目标：定位在所属 frame 内执行，坐标 + frame 偏移换算到顶层视口。
  async _cdpPointerTarget(view, action, aiId, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = /^axf-/.test(aiId) ? await this._owningFrame(view, aiId) : null;
    const inFrame = !!owning;
    // OOPIF click 走所属帧原生 click：CDP 坐标鼠标(帧局部中心+iframe 偏移)对跨进程
    // 子帧的命中/路由不稳（实测报告成功却未触发），原生 .click() 贴合编辑器 React
    // click 语义，已验证可装载正文编辑器。hover 仍走 CDP mousemove(视口坐标)。
    if (inFrame && action === 'click') {
      try {
        if (this.window.show) this.window.show();
        if (this.window.moveTop) this.window.moveTop();
        if (this.window.focus) this.window.focus();
        view.webContents.focus();
      } catch (e) {}
      try {
        const ok = await owning.executeJavaScript(
          `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
          `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
          `el.focus();el.click();return true;})()`);
        return ok ? 'oopif-click' : null;
      } catch (e) { return null; }
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
      if (this.window.show) this.window.show();
      if (this.window.moveTop) this.window.moveTop();
      if (this.window.focus) this.window.focus();
      view.webContents.focus();
    } catch(e) {}
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
    if (action === 'click') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x, y: vp.y, button: 'left', buttons: 0, clickCount: 1 });
      // 命中校验：坐标必须真的落在目标上（否则点击不聚焦却报成功，误导 agent）。
      // 校验失败返回 null，回退 preload（el.focus()+click，focus 会自带滚入视口）。
      const hit = inFrame
        ? await owning.executeJavaScript(
            `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
            `var h=document.elementFromPoint(${center.x},${center.y});return !!(h&&(h===el||el.contains(h)));})()`)
        : await this.evaluate(
            `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
            `var h=document.elementFromPoint(${center.x},${center.y});return !!(h&&(h===el||el.contains(h)));})()`,
            tabId);
      if (!hit) return null;
    }
    return action === 'hover' ? 'cdp-hover' : 'cdp-click';
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
  async _inputViaCdp(view, aiId, text, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = /^axf-/.test(aiId) ? await this._owningFrame(view, aiId) : null;
    const inFrame = !!owning;
    // Run a JS snippet either in the owning frame (OOPIF) or the top frame.
    const run = async (jsBody) => {
      const fn = `(function(){${jsBody}})()`;
      return inFrame ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    // 先激活窗口/视图，再在页面内聚焦（顺序保证渲染进程处于激活态）。
    // 被遮挡时窗口 visibilityState=hidden，键盘事件同样会被渲染器丢弃。
    try {
      if (this.window.show) this.window.show();
      if (this.window.moveTop) this.window.moveTop();
      if (this.window.focus) this.window.focus();
      view.webContents.focus();
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
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    // 幂等短路：若可编辑区当前内容已恰好等于目标文本，直接返回而不做清空+重打。
    // 每次全量重写都会把草稿标脏，重新触发编辑器自身的"草稿备份"/版本气泡——对
    // 相同文本的重复调用（重试/校正）不应让它反复闪烁。
    const curText = await run(
      `var e=document.activeElement;return (e&&(e.innerText||e.value||''))||'';`
    );
    if (norm(curText) === norm(text)) {
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
    const paras = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < paras.length; i++) {
      if (paras[i]) await this._typeChars(send, paras[i]);
      if (i < paras.length - 1) await this._cdpKey(send, { key: 'Enter', code: 'Enter', vk: 13, mod: 0 });
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
    if (this._networkSubscribers.size > 0) this._ensureCdp(tabId, view, 'Network');

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

    if (url) {
      view.webContents.loadURL(url);
    }
    // setActive handles addBrowserView + layout — don't add twice
    this.setActive(tabId);

    // Force repaint after load — BrowserView content can be loaded but not
    // painted by the compositor. Remove + re-add forces a full repaint.
    if (url) {
      view.webContents.on('dom-ready', () => {
        self._forceRepaint(view);
      });
      view.webContents.on('did-finish-load', () => {
        self._forceRepaint(view);
      });
    }
    return tabId;
  }

  _forceRepaint(view) {
    // Remove and re-add the BrowserView to force the compositor to paint it.
    try {
      this.window.removeBrowserView(view);
      this.window.addBrowserView(view);
      this._layoutView(view);
    } catch(e) {}
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
      view.webContents.focus();
      view.webContents.setBackgroundThrottling(false);
    }
    return true;
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

  async getNetworkBody(urlPattern, tabId) {
    // Find matching finished request and get body via CDP.
    // The debugger is attached per-webContents (a tab attaches once, regardless
    // of how many client sessions subscribe), so reach the tab's debugger
    // directly instead of guessing which session map recorded it. Picking
    // "the last session" ([...keys()].pop()) leaked across clients and was
    // wrong whenever the target tab was owned by a different session.
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    const dbg = view && view.webContents && view.webContents.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;
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

  _teardownCdpIfIdle() {
    if (this._networkSubscribers.size > 0 || this._runtimeSubscribers.size > 0) return;
    for (const entry of this._cdpTabs.values()) {
      try { entry.wc.debugger.detach(); } catch(e) {}
    }
    this._cdpTabs.clear();
  }

  async _startNetworkMonitor(sessionId) {
    if (this._networkSubscribers.has(sessionId)) return;
    this._networkSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureCdp(tabId, view, 'Network');
  }

  async _startRuntimeMonitor(sessionId) {
    if (this._runtimeSubscribers.has(sessionId)) return;
    this._runtimeSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureCdp(tabId, view, 'Runtime');
  }

  _onCdpMessage(tabId, method, params) {
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
    } else if (method === 'Network.responseReceived') {
      const r = params.response;
      this._networkRequestMap.set(params.requestId, { url: r.url, tabId });
      this._broadcast('network_response', { url: r.url, status: r.status, statusText: r.statusText, mimeType: r.mimeType, tabId });
    } else if (method === 'Network.loadingFinished') {
      const entry = this._networkRequestMap.get(params.requestId);
      if (entry) entry.finished = true;
    } else if (method === 'Network.loadingFailed') {
      const requestId = params.requestId || '';
      const entry = this._networkRequestMap.get(requestId);
      const url = entry ? entry.url : requestId;
      this._broadcast('network_response', { url, status: 0, statusText: 'Failed', errorText: params.errorText || '', tabId });
    }
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
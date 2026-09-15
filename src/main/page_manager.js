// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView } from 'electron';
import { config } from '../shared/config.js';

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

  async executeAction(action, target, params = {}, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { success: false, error: 'Tab not found' };
    if (!target) return { success: false, error: 'No target' };

    // CDP 受信输入优先（像人操作：受信点击/键盘/文本，对任何框架通用），
    // 无 debugger 时回退 preload 合成事件。
    if (action === 'click' || action === 'hover') {
      try {
        const via = await this._cdpPointerTarget(view, action, target, tid);
        if (via) return { success: true, clicked_via: via, target };
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'type' || action === 'setContent') {
      try {
        const r = await this._inputViaCdp(view, target, params.text || '', tid);
        if (r) return r;
      } catch (e) { /* fall through to preload */ }
    }

    return this._executeViaPreload(action, target, params, tid);
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

  // 受信鼠标事件：先把元素滚入视口（屏外元素直接 dispatchMouseEvent 时坐标落在
  // 视口外，事件命中 body/空白处——探针证实点击不聚焦却误报成功），再按滚动后的
  // 中心点发 mousemove → mousePressed/mouseReleased（click）或仅 move（hover）。
  async _cdpPointerTarget(view, action, aiId, tabId) {
    if (!this._canCdp(view)) return null;
    // 定位 → 滚入视口居中 → 返回滚动后的中心点。同一 evaluate 内同步完成；
    // behavior:'instant' 跳过平滑滚动，避免 scroll-behavior:smooth 页面的异步
    // 滚动造成坐标漂移。fixed 元素 scrollIntoView 是无害的 no-op。
    const center = await this.evaluate(
      `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return null;` +
      `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
      `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
      tabId
    );
    if (!center) return null;
    // 窗口可见性：被完全遮挡（如 IDE 全屏覆盖）时 Chromium 把页面置为
    // visibilityState=hidden，渲染器会丢弃注入的鼠标事件——事件序列为空、
    // 点击不聚焦却报成功（知乎标题探针证实）。像人一样：先置顶显示窗口
    // 再操作。show() 对已显示窗口是 no-op，moveTop() 确保不被遮挡。
    try {
      if (this.window.show) this.window.show();
      if (this.window.moveTop) this.window.moveTop();
      if (this.window.focus) this.window.focus();
      view.webContents.focus();
    } catch(e) {}
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
    if (action === 'click') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', buttons: 0, clickCount: 1 });
      // 命中校验：坐标必须真的落在目标上（否则点击不聚焦却报成功，误导 agent）。
      // 校验失败返回 null，回退 preload（el.focus()+click，focus 会自带滚入视口）。
      const hit = await this.evaluate(
        `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return false;` +
        `var h=document.elementFromPoint(${center.x},${center.y});return !!(h&&(h===el||el.contains(h)));})()`,
        tabId
      );
      if (!hit) return null;
    }
    return action === 'hover' ? 'cdp-hover' : 'cdp-click';
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
    // 先激活窗口/视图，再在页面内聚焦（顺序保证渲染进程处于激活态）。
    // 被遮挡时窗口 visibilityState=hidden，键盘事件同样会被渲染器丢弃。
    try {
      if (this.window.show) this.window.show();
      if (this.window.moveTop) this.window.moveTop();
      if (this.window.focus) this.window.focus();
      view.webContents.focus();
    } catch(e) {}
    // 定位可编辑区并原生聚焦（不做 DOM 全选——交给 Cmd+A 受信按键）
    const prep = await this.evaluate(
      `(function(){var el=document.querySelector('[data-ai-id="${aiId}"]');if(!el)return {ok:false,err:'no-ref'};` +
      `var ed=el;if(ed.querySelector){var inner=ed.querySelector('[contenteditable=true],input,textarea');if(inner)ed=inner;}` +
      `var editable=(ed.contentEditable==='true')||(ed.tagName==='TEXTAREA')||(ed.tagName==='INPUT');` +
      `if(!editable)return {ok:false,err:'not-editable'};` +
      `ed.focus();` +
      `return {ok:true};})()`,
      tabId
    );
    if (!prep || !prep.ok) return null;
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    // 受信 Cmd+A 全选（macOS Command=modifiers 4；编辑器自身处理）→ 等选区提交。
    // 若选区仍为空（部分网站移除全选快捷键——知乎 keyBindingFn 对 Cmd+A 返回
    // null，浏览器原生全选也不触发），回退程序化全选：contenteditable 用 Range
    // 选中全部文本、input/textarea 用 setSelectionRange。框架（Draft 等）通过
    // selectionchange 把 DOM 选区同步进内部 EditorState，随后受信 Delete 走
    // 框架自身删除链路。全程只操作"当前可编辑区"，无框架嗅探。
    await this._cdpKey(send, { key: 'a', code: 'KeyA', vk: 65, mod: 4 });
    await new Promise((r) => setTimeout(r, 120)); // Draft 异步提交全选状态
    await this._selectAllFallback(aiId, tabId);
    await new Promise((r) => setTimeout(r, 80)); // 等选区同步进框架状态
    await this._cdpKey(send, { key: 'Delete', code: 'Delete', vk: 46, mod: 0 });
    await new Promise((r) => setTimeout(r, 80)); // 等删除后的空状态提交
    const paras = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < paras.length; i++) {
      if (paras[i]) await this._typeChars(send, paras[i]);
      if (i < paras.length - 1) await this._cdpKey(send, { key: 'Enter', code: 'Enter', vk: 13, mod: 0 });
    }
    // 通用校验：非空文本要求内容包含目标文本；空文本要求已清空（只允许空块残留）。
    // 任一框架均可，无占位符/块数特判。
    const after = await this.evaluate(
      `(function(){var e=document.activeElement;return {text:(e.innerText||e.value||'')};})()`,
      tabId
    );
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const want = norm(text);
    const got = norm(after && after.text);
    const ok = want
      ? got.includes(want)
      : got === '';
    return ok
      ? { success: true, method: 'cdp-input', chars: (after && after.text) ? after.text.length : 0 }
      : { success: false, error: 'Input not verified — please re-read the tree and retry', method: 'cdp-input-failed' };
  }

  // 全选回退：Cmd+A 后选区仍为空时，用浏览器原生选区 API 选中可编辑区全部文本。
  // 返回 true 表示已有非空选区（Cmd+A 已生效或回退成功）；框架通过
  // selectionchange 同步内部状态，随后的受信 Delete 即可整段删除。
  async _selectAllFallback(aiId, tabId) {
    const r = await this.evaluate(
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
      tabId
    );
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
      self.newTab(urlToOpen);
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
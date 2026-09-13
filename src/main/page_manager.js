// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView } from 'electron';

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

    // Mask automation fingerprint: remove Electron from UA
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );

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
  //  - drop that tab from every session's monitor map and detach its debugger
  //  - drop cached request entries made on that tab
  _cleanupTabResources(tabId) {
    for (const [sessionId, monitors] of this._networkMonitors) {
      const wc = monitors.get(tabId);
      if (wc) {
        try { wc.debugger.detach(); } catch(e) {}
        monitors.delete(tabId);
      }
      if (monitors.size === 0) this._networkMonitors.delete(sessionId);
    }
    for (const [requestId, entry] of this._networkRequestMap) {
      if (entry.tabId === tabId) this._networkRequestMap.delete(requestId);
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
    }
  }

  _networkMonitors = new Map();
  async _startNetworkMonitor(sessionId) {
    if (this._networkMonitors.has(sessionId)) return;
    const monitors = new Map();
    this._networkMonitors.set(sessionId, monitors);
    for (const [tabId, view] of this.tabs) {
      try {
        const wc = view.webContents;
        wc.debugger.attach('1.3');
        monitors.set(tabId, wc);
        wc.debugger.sendCommand('Network.enable');
        wc.debugger.on('message', (_event, method, params) => {
          if (method === 'Network.responseReceived') {
            const r = params.response;
            const requestId = params.requestId;
            this._networkRequestMap.set(requestId, { url: r.url, tabId });
            this._broadcast('network_response', { url: r.url, status: r.status, statusText: r.statusText, mimeType: r.mimeType, tabId });
          }
          if (method === 'Network.loadingFinished') {
            const requestId = params.requestId;
            const entry = this._networkRequestMap.get(requestId);
            if (entry) entry.finished = true;
          }
          if (method === 'Network.loadingFailed') {
            const requestId = params.requestId || '';
            const entry = this._networkRequestMap.get(requestId);
            const url = entry ? entry.url : requestId;
            this._broadcast('network_response', { url: url, status: 0, statusText: 'Failed', errorText: params.errorText || '', tabId });
          }
        });
      } catch(e) {}
    }
  }
  async _stopNetworkMonitor(sessionId) {
    const monitors = this._networkMonitors.get(sessionId);
    if (!monitors) return;
    for (const [, wc] of monitors) { try { wc.debugger.detach(); } catch(e) {} }
    this._networkMonitors.delete(sessionId);
  }

  close() {
    for (const sessionId of this._networkMonitors.keys()) {
      this._stopNetworkMonitor(sessionId);
    }
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
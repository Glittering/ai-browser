// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView } from 'electron';

class PageManager {
  constructor(browserWindow) {
    this.window = browserWindow;
    this.tabs = new Map();       // tabId -> BrowserView
    this.activeTab = 0;
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
    // Tree from renderer — now includes tabId
    ipcMain.on('ai:tree', (_event, payload) => {
      // payload is {tree, context} from bridge v3
      for (const [id, pending] of this._pendingRequests) {
        pending.resolve(payload);
        this._pendingRequests.delete(id);
        break;
      }
    });

    ipcMain.on('ai:action_result', (_event, result) => {
      for (const [id, pending] of this._pendingRequests) {
        pending.resolve(result);
        this._pendingRequests.delete(id);
        break;
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
      view.webContents.send('ai:extract', { focusedOnly });
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
      view.webContents.send('ai:action', { action, target, params });
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

  evaluate(js, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return Promise.reject(new Error('Tab not found'));
    return view.webContents.executeJavaScript(js);
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
      },
    });
    this.tabs.set(tabId, view);
    this.window.addBrowserView(view);
    this._layoutView(view);

    // Intercept window.open / new-window → create new tab instead
    view.webContents.on('new-window', (event, urlToOpen) => {
      event.preventDefault();
      self.newTab(urlToOpen);
    });
    view.webContents.setWindowOpenHandler(({ url: urlToOpen }) => {
      self.newTab(urlToOpen);
      return { action: 'deny' };
    });

    if (url) {
      view.webContents.loadURL(url);
    }
    this.setActive(tabId);
    return tabId;
  }

  closeTab(tabId) {
    const view = this._getView(tabId);
    if (!view) return false;
    this.window.removeBrowserView(view);
    (view.webContents).destroy();
    this.tabs.delete(tabId);
    if (this.activeTab === tabId) {
      // switch to first remaining tab
      const first = this.tabs.keys().next();
      this.activeTab = first.done ? 0 : first.value;
      if (!first.done) this._layoutView(this._getView(this.activeTab));
    }
    return true;
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
    // Hide all views
    for (const [id, view] of this.tabs) {
      if (id !== tabId) {
        view.setBackgroundColor('#000000');
      }
    }
    this.activeTab = tabId;
    const view = this._getView(tabId);
    if (view) this._layoutView(view);
    return true;
  }

  _layoutView(view) {
    const bounds = this.window.getContentBounds();
    const TAB_BAR_HEIGHT = 36;
    view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: bounds.width, height: bounds.height - TAB_BAR_HEIGHT });
  }

  close() {
    for (const [id, view] of this.tabs) {
      (view.webContents).destroy();
    }
    this.tabs.clear();
    ipcMain.removeAllListeners('ai:tree');
    ipcMain.removeAllListeners('ai:action_result');
    ipcMain.removeAllListeners('ai:diff');
    ipcMain.removeAllListeners('ai:event');
  }
}

export { PageManager };
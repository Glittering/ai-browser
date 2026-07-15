// main/page_manager.js — BrowserWindow page lifecycle manager
import { ipcMain } from 'electron';

class PageManager {
  constructor(browserWindow) {
    this.window = browserWindow;
    this.subscriptions = new Map(); // sessionId -> Set<eventTypes>
    this._pendingRequests = new Map(); // requestId -> {resolve, reject}
    this._requestId = 0;
    this._wsClients = new Map(); // sessionId -> ws connection
    this._setupIPC();
  }

  static _instance = null;
  static getInstance(browserWindow) {
    if (!PageManager._instance) PageManager._instance = new PageManager(browserWindow);
    return PageManager._instance;
  }

  _setupIPC() {
    // Receive tree from renderer (response to ai:extract)
    ipcMain.on('ai:tree', (_event, tree) => {
      // Resolve the most recent pending getTree request
      for (const [id, pending] of this._pendingRequests) {
        pending.resolve(tree);
        this._pendingRequests.delete(id);
        break; // resolve only one
      }
    });

    // Receive action result from renderer
    ipcMain.on('ai:action_result', (_event, result) => {
      for (const [id, pending] of this._pendingRequests) {
        pending.resolve(result);
        this._pendingRequests.delete(id);
        break;
      }
    });

    // Receive diff/events from preload state_tracker
    ipcMain.on('ai:diff', (_event, changes) => {
      this._broadcast('dom_change', { changes });
    });
    ipcMain.on('ai:event', (_event, payload) => {
      this._broadcast(payload.event, payload.data || {});
    });
  }

  _broadcast(eventType, data) {
    for (const [sessionId, eventTypes] of this.subscriptions) {
      if (eventTypes.has(eventType) || eventTypes.has('*')) {
        const ws = this._wsClients.get(sessionId);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: eventType,
            params: data,
          }));
        }
      }
    }
  }

  // Register a WS client for event subscription delivery
  registerClient(sessionId, ws) {
    this._wsClients.set(sessionId, ws);
  }

  unregisterClient(sessionId) {
    this._wsClients.delete(sessionId);
    this.subscriptions.delete(sessionId);
  }

  navigate(url) {
    return this.window.loadURL(url);
  }

  async getTree(focusedOnly = false) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      this.window.webContents.send('ai:extract', { focusedOnly });
      // Timeout after 5s
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('getTree timeout'));
        }
      }, 5000);
    });
  }

  async executeAction(action, target, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      this.window.webContents.send('ai:action', { action, target, params });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          resolve({ success: false, error: 'Action timeout' });
        }
      }, 5000);
    });
  }

  async getFocused() {
    const tree = await this.getTree(true);
    return tree?.focused_element_id || null;
  }

  evaluate(js) {
    return this.window.webContents.executeJavaScript(js);
  }

  addSubscription(sessionId, events) {
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, new Set());
    }
    for (const e of events) this.subscriptions.get(sessionId).add(e);
  }

  removeSubscription(sessionId, events) {
    const set = this.subscriptions.get(sessionId);
    if (!set) return;
    for (const e of events) set.delete(e);
    if (set.size === 0) this.subscriptions.delete(sessionId);
  }

  close() {
    ipcMain.removeAllListeners('ai:tree');
    ipcMain.removeAllListeners('ai:action_result');
    ipcMain.removeAllListeners('ai:diff');
    ipcMain.removeAllListeners('ai:event');
  }
}

export { PageManager };
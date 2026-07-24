// main/index.js — Electron entry v5 (multi-tab, real UI)
// One process, one WS server, multiple tabs with real tab bar.
import { app, BrowserWindow, BrowserView, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CRITICAL: set userData BEFORE app.whenReady — session/cookie storage
// is initialized during ready, so setting it after loses persistence.
app.setPath('userData', path.join(app.getPath('home'), '.ai-browser'));

// Disable GPU compositing — this app is a headless-style browser for API
// access, not a visual browser. Avoids a whole class of GPU driver crashes
// (exit_code=6) that take down the whole app on some systems.
app.disableHardwareAcceleration();

// Disable Chromium sandbox — required when launched from restricted
// environments (e.g. TRAE IDE shell) where the sandbox helper cannot
// acquire the privileges it needs, causing "sandbox initialization failed:
// Operation not permitted" and immediate app exit. Safe here because we
// already run with contextIsolation:true + nodeIntegration:false, so
// renderer code has no Node access regardless of OS-level sandbox.
app.commandLine.appendSwitch('no-sandbox');

const PORT = 9223;
const TAB_BAR_HEIGHT = 36;

let mainWindow = null;
let wsServer = null;
let tabBarView = null;
let pageManager = null;
let tabRefreshInterval = null;
let isQuitting = false;

// === Single instance lock — second launch just focuses the existing window ===
// Non-fatal: if the lock can't be acquired (EPERM on some sandboxed setups),
// continue anyway rather than quitting.
const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Tab bar — needs nodeIntegration for ipcRenderer
  tabBarView = new BrowserView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  mainWindow.addBrowserView(tabBarView);
  tabBarView.setBounds({ x: 0, y: 0, width: 1280, height: TAB_BAR_HEIGHT });
  tabBarView.webContents.loadFile(path.join(__dirname, '../renderer/tab_bar.html'));

  // Init PageManager
  pageManager = PageManager.getInstance(mainWindow);
  pageManager._preloadPath = path.join(__dirname, '../preload/bridge.js');

  // Create first tab
  pageManager.newTab('https://www.baidu.com');

  // Start WS server — pass cleanupAndQuit so ui.quit can shut down the app
  wsServer = startWSServer(pageManager, PORT, cleanupAndQuit);

  // === Tab bar IPC ===
  ipcMain.on('tab:new', () => {
    pageManager.newTab('https://www.baidu.com');
    refreshTabBar();
  });
  ipcMain.on('tab:close', (_e, tabId) => {
    pageManager.closeTab(tabId);
    refreshTabBar();
  });
  ipcMain.on('tab:activate', (_e, tabId) => {
    pageManager.setActive(tabId);
    refreshTabBar();
  });
  ipcMain.handle('tab:list', () => pageManager.listTabs());

  // Intercept new-window / window.open → new tab instead of new window
  ipcMain.on('tab:new-url', (_e, url) => {
    pageManager.newTab(url);
    refreshTabBar();
  });

  // Resize handler
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getContentBounds();
    if (tabBarView && !tabBarView.webContents.isDestroyed()) {
      tabBarView.setBounds({ x: 0, y: 0, width: bounds.width, height: TAB_BAR_HEIGHT });
    }
    pageManager._layoutAllViews(bounds);
  });

  // === Renderer crash handling — log only, don't kill the app ===
  // The main BrowserWindow has no real content (it hosts BrowserViews), so a
  // renderer-gone event here is usually a transient GPU/sandbox hiccup.
  // Quitting on it makes the whole app flash-exit on startup. Just log.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[index] mainWindow render-process-gone:', details.reason);
  });
  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('render-process-gone', (_e, details) => {
      console.error('[index] tab render-process-gone:', details.reason);
    });
  });

  // Ensure the app actually exits when the main window is closed.
  mainWindow.on('close', cleanupAndQuit);

  // Refresh tab bar periodically
  tabRefreshInterval = setInterval(refreshTabBar, 2000);
}

function refreshTabBar() {
  if (tabBarView && !tabBarView.webContents.isDestroyed()) {
    tabBarView.webContents.executeJavaScript('renderTabs && renderTabs()').catch(() => {});
  }
}

app.whenReady().then(() => {
  createWindow();
});

function cleanupAndQuit() {
  if (isQuitting) return;
  isQuitting = true;
  if (tabRefreshInterval) {
    clearInterval(tabRefreshInterval);
    tabRefreshInterval = null;
  }
  // Close PageManager first — it rejects pending IPC requests and tears down
  // BrowserViews cleanly. Otherwise pending requests hang the WS server close.
  if (pageManager) {
    try { pageManager.close(); } catch (e) { console.error('[index] pageManager.close error:', e.message); }
    pageManager = null;
  }
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }
  app.quit();
}

app.on('window-all-closed', cleanupAndQuit);
app.on('before-quit', cleanupAndQuit);
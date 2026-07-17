// main/index.js — Electron entry v5 (multi-tab, real UI)
// One process, one WS server, multiple tabs with real tab bar.
import { app, BrowserWindow, BrowserView, ipcMain, shell, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CRITICAL: set userData BEFORE app.whenReady — session/cookie storage
// is initialized during ready, so setting it after loses persistence.
app.setPath('userData', path.join(app.getPath('home'), '.ai-browser'));

const PORT = 9223;
const TAB_BAR_HEIGHT = 36;

let mainWindow = null;
let wsServer = null;
let tabBarView = null;

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
  const manager = PageManager.getInstance(mainWindow);
  manager._preloadPath = path.join(__dirname, '../preload/bridge.js');

  // Create first tab
  manager.newTab('https://www.baidu.com');

  // Start WS server
  wsServer = startWSServer(manager, PORT);

  // === Tab bar IPC ===
  ipcMain.on('tab:new', () => {
    manager.newTab('https://www.baidu.com');
    refreshTabBar();
  });
  ipcMain.on('tab:close', (_e, tabId) => {
    manager.closeTab(tabId);
    refreshTabBar();
  });
  ipcMain.on('tab:activate', (_e, tabId) => {
    manager.setActive(tabId);
    refreshTabBar();
  });
  ipcMain.handle('tab:list', () => manager.listTabs());

  // Intercept new-window / window.open → new tab instead of new window
  ipcMain.on('tab:new-url', (_e, url) => {
    manager.newTab(url);
    refreshTabBar();
  });

  // Resize handler
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getContentBounds();
    tabBarView.setBounds({ x: 0, y: 0, width: bounds.width, height: TAB_BAR_HEIGHT });
    manager._layoutAllViews(bounds);
  });

  // Refresh tab bar periodically
  setInterval(refreshTabBar, 2000);
}

function refreshTabBar() {
  if (tabBarView && !tabBarView.webContents.isDestroyed()) {
    tabBarView.webContents.executeJavaScript('renderTabs && renderTabs()').catch(() => {});
  }
}

app.whenReady().then(() => {
  session.fromPartition('persist:ai-browser').clearCache().then(() => {
    createWindow();
  }).catch(() => {
    createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wsServer) wsServer.close();
  app.quit();
});
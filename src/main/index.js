// main/index.js — Electron entry v4 (multi-tab)
// One process, one WS server, multiple tabs.
import { app, BrowserWindow, BrowserView, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 9223;

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

  // Tab bar — a thin BrowserView at the top
  tabBarView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: true,
    },
  });
  mainWindow.addBrowserView(tabBarView);
  tabBarView.setBounds({ x: 0, y: 0, width: 1280, height: 36 });
  tabBarView.webContents.loadFile(path.join(__dirname, '../renderer/tab_bar.html'));

  // Init PageManager and set preload path
  const manager = PageManager.getInstance(mainWindow);
  manager._preloadPath = path.join(__dirname, '../preload/bridge.js');

  // Create first tab with default test page
  manager.newTab(path.join(__dirname, '../../tests/test_pages/basic_controls.html'));

  // Start WS server
  wsServer = startWSServer(manager, PORT);

  // Handle tab bar IPC
  ipcMain.on('tab:new', () => manager.newTab(null));
  ipcMain.on('tab:close', (_e, tabId) => manager.closeTab(tabId));
  ipcMain.on('tab:activate', (_e, tabId) => manager.setActive(tabId));
  ipcMain.on('tab:list', (e) => {
    e.returnValue = manager.listTabs();
  });

  // Resize handler
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getContentBounds();
    tabBarView.setBounds({ x: 0, y: 0, width: bounds.width, height: 36 });
    manager._layoutAllViews?.(bounds);
    // Re-layout active tab
    const activeView = manager._getView(manager.activeTab);
    if (activeView) activeView.setBounds({ x: 0, y: 36, width: bounds.width, height: bounds.height - 36 });
  });
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (wsServer) wsServer.close();
  app.quit();
});
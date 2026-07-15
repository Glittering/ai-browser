// main/index.js — Electron entry
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let wsServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // default page for test
  mainWindow.loadFile(path.join(__dirname, '../../tests/test_pages/basic_controls.html'));

  // Start WS server after window created (PageManager needs webContents)
  const manager = PageManager.getInstance(mainWindow);
  wsServer = startWSServer(manager);
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (wsServer) wsServer.close();
  app.quit();
});
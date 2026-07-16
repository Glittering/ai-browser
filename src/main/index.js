// main/index.js — Electron entry
// Usage: npx electron . --port=9224  (different port → multiple instances)
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// parse --port=N from command line
const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 9223;

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

  // default test page
  mainWindow.loadFile(path.join(__dirname, '../../tests/test_pages/basic_controls.html'));

  // Start WS server after window created
  const manager = PageManager.getInstance(mainWindow);
  wsServer = startWSServer(manager, PORT);
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (wsServer) wsServer.close();
  app.quit();
});
// main/index.js — Electron entry v3
// Usage: npx electron . --port=9224  (different port → multiple instances)
// Session: uses persistent userDataDir ~/.hermes/electron-userdata so cookies survive restarts
// Multiple instances can share session via --share-session flag
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// parse --port=N and --share-session from command line
const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 9223;
const shareSession = process.argv.includes('--share-session');

let mainWindow = null;
let wsServer = null;

function createWindow() {
  // Persistent userDataDir — cookies, localStorage, sessions survive restart
  const userDataDir = shareSession
    ? path.join(app.getPath('home'), '.hermes', 'electron-userdata', 'shared')
    : path.join(app.getPath('home'), '.hermes', 'electron-userdata', 'p' + PORT);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Use persistent partition so cookies persist
      partition: 'persist:' + (shareSession ? 'shared-session' : 'session-p' + PORT),
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
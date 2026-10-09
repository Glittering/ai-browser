// main/index.js — Electron entry v5 (multi-tab, real UI)
// One process, one WS server, multiple tabs with real tab bar.
import { app, BrowserWindow, BrowserView, ipcMain, net } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';
import { config } from '../shared/config.js';
import { parseWatchdogTargets, isWatchdogEnabled } from '../shared/watchdog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CRITICAL: set userData BEFORE app.whenReady — session/cookie storage
// is initialized during ready, so setting it after loses persistence.
app.setPath('userData', config.userDataDir);

// Disable GPU compositing to avoid a whole class of GPU driver crashes
// (exit_code=6) that take down the whole app on some systems. This only turns
// off hardware acceleration — the window itself stays a real, visible window
// and a human can drive it with mouse/keyboard at any time (login, QR scan,
// captcha, correcting the agent).
app.disableHardwareAcceleration();

// Disable Chromium sandbox — required when launched from restricted
// environments (e.g. TRAE IDE shell) where the sandbox helper cannot
// acquire the privileges it needs, causing "sandbox initialization failed:
// Operation not permitted" and immediate app exit. Safe here because we
// already run with contextIsolation:true + nodeIntegration:false, so
// renderer code has no Node access regardless of OS-level sandbox.
app.commandLine.appendSwitch('no-sandbox');

// Keep renderers fully active even when the window is occluded (e.g. an IDE
// fullscreen window sits on top of the browser). By default Chromium
// backgroundses occluded windows: the page goes visibilityState=hidden and
// the renderer drops CDP-injected mouse/keyboard events — clicks report
// success (elementFromPoint check passes) yet never reach the page, and
// typing inserts nothing. These switches stop that backgrounding so the
// agent's input pipeline works regardless of window stacking.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const PORT = config.wsPort;
const TAB_BAR_HEIGHT = config.tabBarHeight;

// Network watchdog tuning (#5). We only need the NetworkService to round-trip,
// not any specific host — so we probe MULTIPLE hosts concurrently and treat the
// network as alive if ANY answers. A single hardcoded host (example.com) is
// unreliable from mainland China and caused false "wedged" verdicts → reboot
// loops. Override with AI_BROWSER_WATCHDOG_URLS (comma-separated, no spaces
// required) or turn the whole watchdog off with AI_BROWSER_WATCHDOG=0.
const WATCHDOG_TARGETS = parseWatchdogTargets(process.env.AI_BROWSER_WATCHDOG_URLS);
const WATCHDOG_INTERVAL = 30000; // probe cadence
const WATCHDOG_TIMEOUT = 5000;   // per-target per-probe deadline
const WATCHDOG_FAIL_LIMIT = 5;   // relaunch after this many consecutive failures

let mainWindow = null;
let wsServer = null;
let tabBarView = null;
let pageManager = null;
let tabRefreshInterval = null;
let networkWatchdog = null;
let isQuitting = false;

// === Single instance lock — second launch just focuses the existing window ===
const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
} else if (!(process.platform === 'darwin' && app.isPackaged)) {
  // A real second instance would fight the first one over the :9223 WS port.
  // Still tolerant of weird environments (EPERM on sandboxed setups, and
  // macOS packaged builds where the lock can report false and quitting would
  // make the app unlaunchable) — everywhere else, the duplicate exits and
  // lets the existing window handle the request.
  console.error('[index] another AI Browser instance is already running — quitting');
  app.quit();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 先不显示：如何显示由 showInitialWindow() 按焦点策略决定 —— 窗口必须真实可见
    // （产品承诺人可随时介入），但被 agent 拉起时不该把用户正在做的事打断。
    show: false,
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
  pageManager._preloadPath = path.join(__dirname, '../preload/bridge.cjs');

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

  // === #5: NetworkService self-heal watchdog ===
  // The Electron NetworkService can wedge as a whole (port stays listening but
  // every ui.navigate fails ERR_FAILED while curl works fine). A clean relaunch
  // restores it. Probe via the MAIN process net.request (shares the same
  // NetworkService as all renderers) every ~30s; after ≥5 consecutive failures,
  // broadcast the event then relaunch — the MCP WS client auto-reconnects.
  // Relaunch is skipped while a human appears to be actively using the window.
  StartNetworkWatchdog();

  showInitialWindow();
}

/**
 * 首次显示窗口。
 *
 * 窗口必须在屏幕上真实可见 —— 这是产品承诺（人可以随时手动介入，例如扫码登录）。
 * 但"可见"不等于"抢焦点"：如果是 agent 通过 MCP 拉起的（mcp_server 会传
 * AI_BROWSER_LAUNCHED_BY_AGENT=1），用 showInactive() 让窗口出现但**不**夺走键盘
 * 焦点，人可以继续在原来的窗口里做事；人手动 `npm start` 时窗口照常显示在前台。
 *
 * AI_BROWSER_FOCUS=always / never 可整体覆盖（见 page_manager._focusWindow）。
 */
function showInitialWindow() {
  if (!mainWindow) return;
  const policy = String(process.env.AI_BROWSER_FOCUS || 'auto').toLowerCase();
  const byAgent = process.env.AI_BROWSER_LAUNCHED_BY_AGENT === '1';
  // 窗口**一定**要显示出来 —— 这是产品不变量（人可随时手动介入：登录、扫码、过验证码、
  // 纠正 agent 的操作），任何策略值都不允许把窗口变成看不见的黑盒。
  // 策略只决定**显示时抢不抢焦点**：只有人手动启动、或显式 always，才显示并激活；
  // agent 拉起（或 never）走 showInactive —— 窗口出现，但键盘焦点留在用户那边。
  const shouldActivate = policy === 'always' || (policy !== 'never' && !byAgent);
  try {
    if (shouldActivate) mainWindow.show();
    else mainWindow.showInactive();
  } catch (e) {
    try { mainWindow.show(); } catch (e2) { /* 窗口已销毁 */ }
  }
}

// Probe one target through the NetworkService from the main process. Reuses
// Electron's own stack, so a wedged service here means wedged for every tab.
// Resolves true on any HTTP response (even 4xx — network is alive), false on
// error/timeout.
function probeTarget(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = net.request({ url, method: 'HEAD' });
    } catch (e) {
      resolve(false); // malformed url in AI_BROWSER_WATCHDOG_URLS
      return;
    }
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    // Electron 的 net.ClientRequest 没有 setTimeout()（调用会抛
    // "req.setTimeout is not a function"），所以超时只能用外部定时器兜。
    // 之前正是这里每次探测都抛异常，导致看门狗从未真正工作过。
    timer = setTimeout(() => {
      try { req.abort(); } catch (e) {}
      finish(false);
    }, WATCHDOG_TIMEOUT);
    req.on('response', () => finish(true));
    req.on('error', () => finish(false));
    req.on('abort', () => finish(false));
    try {
      req.end();
    } catch (e) {
      finish(false);
    }
  });
}

// Probe every configured target concurrently. Any single success means the
// NetworkService is alive — only a full sweep of failures counts as one failure.
// This is what stops a flaky/geo-blocked host from looking like a dead stack.
async function probeNetwork() {
  const results = await Promise.all(WATCHDOG_TARGETS.map((url) => probeTarget(url)));
  return results.some(Boolean);
}

function StartNetworkWatchdog() {
  if (!isWatchdogEnabled(process.env.AI_BROWSER_WATCHDOG)) {
    console.error('[index] watchdog disabled via AI_BROWSER_WATCHDOG');
    return;
  }
  if (networkWatchdog) clearInterval(networkWatchdog);
  let failStreak = 0;
  const spin = async () => {
    if (isQuitting) return;
    let ok;
    try {
      ok = await probeNetwork();
    } catch (e) {
      // 探测本身抛异常不该变成 unhandled rejection，也不该计入 failStreak
      // （那是"探测坏了"，不是"网络坏了"）。
      console.error('[index] watchdog probe error:', (e && e.message) || e);
      return;
    }
    if (ok) { failStreak = 0; return; }
    failStreak += 1;
    if (failStreak >= WATCHDOG_FAIL_LIMIT) {
      console.error('[index] NetworkService wedged — relaunching AI Browser');
      failStreak = 0; // prevent double-relaunch in flight
      if (pageManager) { try { pageManager._broadcast('network_wedged', { reason: 'network service unreachable' }); } catch (e) {} }
      app.relaunch();
      app.exit(0);
    }
  };
  spin();
  networkWatchdog = setInterval(spin, WATCHDOG_INTERVAL);
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
  if (networkWatchdog) {
    clearInterval(networkWatchdog);
    networkWatchdog = null;
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
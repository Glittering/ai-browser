// main/index.js — Electron entry v5 (multi-tab, real UI)
// One process, one WS server, multiple tabs with real tab bar.
import { app, BrowserWindow, BrowserView, ipcMain, net, session } from 'electron';
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
let navStateInterval = null;
let navStateWc = null;
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

  // Create first tab.
  //
  // 默认页用 baidu.com：国内可达、无登录墙、重定向链短。但注意它**不是**必须的 ——
  // 用户报"打开 ai-browser 白屏"时，我们实测过两种独立成因（见 showInitialWindow
  // 的注释），跟默认页选谁无关；换成 about:blank 只会把"加载失败的白屏"变成
  // "空白页的白屏"，问题更大（连错误提示都没有）。
  //
  // 可由 AI_BROWSER_START_URL 覆盖；设为空字符串则开空白页。
  const START_URL = process.env.AI_BROWSER_START_URL !== undefined
    ? (process.env.AI_BROWSER_START_URL || null)
    : 'https://www.baidu.com';
  pageManager.newTab(START_URL);

  // Start WS server — pass cleanupAndQuit so ui.quit can shut down the app
  wsServer = startWSServer(pageManager, PORT, cleanupAndQuit);

  // === Tab bar IPC ===
  ipcMain.on('tab:new', () => {
    pageManager.newTab(START_URL);
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

  // === 地址栏 / 导航按钮 ===
  ipcMain.handle('nav:state', () => {
    const wc = activeWebContents();
    if (!wc) return { tab: null, url: '', canBack: false, canForward: false, loading: false, status: '' };
    return {
      tab: pageManager.activeTab,
      url: wc.getURL(),
      canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
      canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      loading: wc.isLoading(),
      status: wc.isLoading() ? '加载中…' : '',
    };
  });
  ipcMain.on('nav:go', (_e, input) => {
    const wc = activeWebContents();
    const url = normalizeUrlInput(input);
    if (!wc || !url) return;
    try { wc.loadURL(url); } catch (e) { console.error('[index] nav:go failed:', e.message); }
  });
  ipcMain.on('nav:back', () => { const wc = activeWebContents(); if (wc && wc.navigationHistory) wc.navigationHistory.goBack(); });
  ipcMain.on('nav:forward', () => { const wc = activeWebContents(); if (wc && wc.navigationHistory) wc.navigationHistory.goForward(); });
  ipcMain.on('nav:reload', () => { const wc = activeWebContents(); if (wc) wc.reload(); });
  ipcMain.on('nav:stop', () => { const wc = activeWebContents(); if (wc) wc.stop(); });
  // 错误页里的重试 / 返回（错误页是我们自己的 renderer，同样走 ipc）
  ipcMain.on('error-page:navigate', (_e, input) => {
    const wc = activeWebContents();
    const url = normalizeUrlInput(input);
    if (!wc || !url) return;
    try { wc.loadURL(url); } catch (e) { console.error('[index] error-page navigate failed:', e.message); }
  });
  ipcMain.on('error-page:back', () => {
    const wc = activeWebContents();
    if (wc && wc.navigationHistory) wc.navigationHistory.goBack();
  });

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

  // === Window becoming visible again → force a compositor repaint ===
  //
  // The switches above keep renderers *running* while occluded, but they do
  // not guarantee the *compositor* produces a fresh frame when the window comes
  // back: macOS/Chromium can keep showing the last composited surface. The
  // switches also only apply from process start, so they cannot fix a window
  // that was hidden/occluded by other means.
  //
  // Why this matters here specifically: the product invariant is "never steal
  // focus", so this window routinely sits behind the user's editor for minutes
  // while the agent works. When the user finally looks at it, they may be
  // looking at a stale frame. Repainting on show/restore/focus means the view
  // catches up the moment it becomes visible — no clicking tabs required.
  const repaintActive = () => { try { pageManager.repaint(pageManager.activeTab); } catch (e) {} };
  mainWindow.on('show', repaintActive);
  mainWindow.on('restore', repaintActive);
  mainWindow.on('focus', repaintActive);
  mainWindow.on('app-command-added', (_e, cmd) => {
    // macOS window-management commands (zoom / minimize / fullscreen).
    if (cmd === 'togglefullscreen' || cmd === 'zoom' || cmd === 'minimize') repaintActive();
  });
  mainWindow.on('browser-window-focus', repaintActive);

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

  // === 地址栏状态跟随 ===
  // 导航可能来自三方：人在地址栏输入、agent 调 ui.navigate、页面自己跳转。
  // 地址栏必须反映**真实**状态，所以这里订阅激活 tab 的 webContents 事件主动推，
  // 而不是靠定时轮询（轮询有最多 2s 的滞后，人会以为按钮坏了）。
  const wireNavState = (tabId) => {
    const wc = activeWebContents();
    if (!wc) return;
    if (navStateWc === wc) return;         // 同一个 tab 重复 setActive，不重复挂
    navStateWc = wc;
    const push = () => pushNavState();
    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('did-navigate', push);
    wc.on('did-navigate-in-page', push);
    wc.on('page-title-updated', push);
  };
  const origSetActive = pageManager.setActive.bind(pageManager);
  pageManager.setActive = function (tabId) {
    origSetActive(tabId);
    wireNavState(tabId);
    pushNavState();
  };
  wireNavState(pageManager.activeTab);
  // 兜底轮询：只覆盖上面事件没抓到的情况（低频，成本可忽略）
  navStateInterval = setInterval(pushNavState, 1500);

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
 *
 * 另外：**等首屏 DOM 就绪再 show**。2026-10-14 实测偶发（12 次启动里 1 次）
 * 窗口已显示但 document.body 还是 null、页面整个是白的 —— 用户报的"打开
 * ai-browser 白屏"其中一类就是这个：不是连接错（网络是通的，DNS 也解析了），
 * 是窗口在渲染器还没画出第一帧时就显示了。等到 dom-ready（或最多 3s 兜底）
 * 再显示，窗口一出现就是有内容的。
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

  const doShow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (shouldActivate) mainWindow.show();
      else mainWindow.showInactive();
    } catch (e) {
      try { mainWindow.show(); } catch (e2) { /* 窗口已销毁 */ }
    }
  };

  // 等首屏内容就绪。上限 3s：网络再慢也不该让窗口迟迟不出现（人看不到窗口
  // 比看到白屏更糟），超时就先显示，剩下的交给 did-fail-load 错误页兜底。
  const firstView = pageManager && pageManager.tabs.get(pageManager.activeTab);
  const wc = firstView && firstView.webContents;
  if (!wc || wc.isDestroyed()) { doShow(); return; }
  let shown = false;
  // reason: 为什么在这个时刻显示。必须如实记录 —— 之前 waited_for_dom 恒为
  // true（3s 兜底显示时也报 true），于是"到底等到了 dom-ready 没有"看不出来，
  // 白屏缺陷和"我们主动选择先显示"被混成同一种结果。
  const showOnce = (reason) => {
    if (shown) return;
    shown = true;
    // 同步先落一条记录：哪怕 renderer 还没就绪（executeJavaScript 会 reject），
    // "窗口在这一刻显示了、而页面是空的"这个事实本身也必须留下 —— 那正是要抓的
    // 白屏形态。若等 Promise 成功才记，renderer 起不来时记录永远是 null，
    // 观测口在最需要它的时候失灵。
    const rec = {
      tab: pageManager.activeTab,
      body_len: null,
      ready_state: null,
      // 'dom-ready' | 'fail-load' | 'renderer-ready' | 'timeout'
      show_reason: reason || 'unknown',
      // 真话：只有 3s 兜底（renderer 迟迟没到）才是 false。
      waited_for_dom: reason !== 'timeout',
      renderer_ready: false,
    };
    pageManager.windowShownAt = rec;
    // 再把"窗口在这一刻显示、且此刻页面是什么状态"广播出去。
    // 为什么值得多这一个事件：白屏类缺陷的根因是"窗口显示了但渲染器还没画出
    // 第一帧"，而这只能从窗口侧观测 —— WS 端口就绪不等于窗口已显示（端口在
    // createWindow 里就开了，比 showInitialWindow 早），所以从 agent 侧 polling
    // 永远测不到这个时序。有了这个事件，e2e 才能断言"显示的瞬间页面已有内容"。
    // 读数走 pageManager.evaluate（CDP Runtime.evaluate），不用
    // webContents.executeJavaScript：高层 API 在 renderer 尚未完全就绪时会 reject
    // （实测禁硬件加速 + 首次创建 GL context 失败时，dom-ready 已到但
    // executeJavaScript 仍失败，而页面随后照常加载、CDP 读数正常）。
    // 观测口必须能在最需要它的时候读数，否则等于没有。
    const readReady = () => pageManager.evaluate(
      '(function(){var b=document.body;return JSON.stringify({body:b?b.innerHTML.length:-1,ready:document.readyState});})()',
      pageManager.activeTab
    );
    Promise.resolve()
      .then(() => readReady())
      .then((v) => {
        rec.renderer_ready = true;
        try {
          const p = JSON.parse(v);
          rec.body_len = p.body;
          rec.ready_state = p.ready;
        } catch (e) { /* 非预期返回，留 null */ }
        try { pageManager._broadcast('window_shown', rec); } catch (e) { /* 无订阅者 */ }
      })
      .catch(() => {
        // 真的读不到（renderer 始终没起来）—— 这本身就是要抓的白屏形态，
        // 记录里 renderer_ready 保持 false，让 e2e 看得见。
      });
    doShow();
  };
  wc.once('dom-ready', () => showOnce('dom-ready'));
  wc.once('did-fail-load', () => showOnce('fail-load'));   // 失败也要显示（错误页会接手）
  setTimeout(() => showOnce('timeout'), 3000);
  // dom-ready 可能在上面注册**之前**就已经触发过（缓存命中时 baidu 首屏
  // 一到就 ready，而 showInitialWindow 是 createWindow 的最后一步）——
  // once() 收不到已经过去的事件，那就只能干等 3s 兜底。先主动查一次
  // readyState（走 CDP，见 showOnce 里的说明），已经就绪就立刻显示。
  pageManager.evaluate('(function(){return document.readyState;})()', pageManager.activeTab)
    .then((rs) => { if (rs && rs !== 'loading') showOnce('renderer-ready'); })
    .catch(() => { /* renderer 未就绪，等事件 */ });
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

// === 地址栏 / 前进 / 后退 / 刷新 / 停止 ===
//
// 为什么必须有：窗口是真实可见的普通窗口，产品承诺人可以随时手动介入
// （登录、扫码、过滑块、纠正 agent 的操作）。但原先窗口里只有 tab 条，
// 没有地址栏也没有任何导航按钮 —— 人要介入时连"打开某个页面"都做不到，
// 只能干等 agent。用户原话："现在有时候需要我操作一下，比如登录验证码等，
// 页面都打不开，非常难受。"
//
// 这里的每一行都只操作 activeTab 的 webContents，不碰页面内容，也不引入
// 任何人机协作状态机 —— 就是普通浏览器的地址栏。

/** 当前激活 tab 的 webContents，没有则 null。 */
function activeWebContents() {
  if (!pageManager) return null;
  const view = pageManager.tabs.get(pageManager.activeTab);
  if (!view || view.webContents.isDestroyed()) return null;
  return view.webContents;
}

/** 把地址栏需要的一切状态推给 tab bar renderer。 */
function pushNavState() {
  if (!tabBarView || tabBarView.webContents.isDestroyed()) return;
  const wc = activeWebContents();
  const state = wc ? {
    tab: pageManager.activeTab,
    url: wc.getURL(),
    canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    loading: wc.isLoading(),
    status: wc.isLoading() ? '加载中…' : '',
  } : { tab: null, url: '', canBack: false, canForward: false, loading: false, status: '' };
  tabBarView.webContents.executeJavaScript(
    'window.__onNavState && window.__onNavState(' + JSON.stringify(state) + ')'
  ).catch(() => {});
}

/**
 * 把用户输入解析成可加载的 URL。
 * 只做最小处理：带协议的直接用；否则按 https 猜；纯查询词不进这里
 * （地址栏输入什么就打开什么，不做搜索跳转 —— 那会替用户做决定）。
 */
function normalizeUrlInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;          // http:// https:// file:// …
  if (/^(about|file|data):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  return 'https://' + s;
}

app.whenReady().then(() => {
  createWindow();
  // 下载与权限的 session 级钩子。必须装在 will-download 上，否则 Electron 默认
  // **取消**下载：agent 点"导出"只看到 success，然后什么都没有，连错误都没有
  // （2026-10-12 审计发现 src/ 里原先没有任何下载处理）。
  // 权限同理：不装 setPermissionRequestHandler 时每个请求被静默拒绝，站点要
  // pointerLock / clipboard 写入才能继续时，agent 完全看不出是被权限挡住。
  //
  // ⚠️ 必须是 tab 的 BrowserView 实际所在的那个 session。它们用的是
  // `partition: config.viewPartition`，不是 defaultSession —— 第一版传了
  // defaultSession，钩子装到了另一个 session 上，表现是"页面确实发出了下载请求
  // （服务端收到了 GET），但 will-download 从不触发、文件不落盘"。
  try {
    pageManager.installSessionHooks(session.fromPartition(config.viewPartition));
  } catch (e) {
    console.error('[index] failed to install session hooks:', e && e.message);
  }
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
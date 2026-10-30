// main/index.js — Electron entry v5 (multi-tab, real UI)
// One process, one WS server, multiple tabs with real tab bar.
import { app, BrowserWindow, BrowserView, ipcMain, net, session, dialog, screen, powerMonitor, shell, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startWSServer } from './ws_server.js';
import { PageManager } from './page_manager.js';
import { config } from '../shared/config.js';
import mediaDoc from '../shared/media_doc.cjs';
import { parseWatchdogTargets, isWatchdogEnabled } from '../shared/watchdog.js';
import { wrapSetActive } from '../shared/tab_hooks.js';
import { initErrorLog, recordError, markShutdown, getLogPath } from './error_log.js';
import errorBanner from '../shared/error_banner.cjs';
// .cjs 一律默认导入：ESM 从 .cjs 做具名导入依赖 cjs-module-lexer 静态识别，
// 而 tests/test_imports.js 只认 ESM `export` 语法，会误报"没有导出它"。全项目约定
// 用默认导入（见 blank_page.cjs / error_banner.cjs），这里保持一致。
import viewLiveness from '../shared/view_liveness.cjs';
const { isAlive, liveness } = viewLiveness;
import { classifyShowReason, describeShowUrl } from '../shared/window_show.js';
// 地址栏跟随的挂载状态机（幂等 wire）。抽成模块是因为它原来写在闭包里，
// 判据只能 grep 源码 —— 实测监听累到 3 个时测试照样全绿。
import navFollow from '../shared/nav_follow.cjs';
const { createNavFollower } = navFollow;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 窗口标题用的产品名。
// 不能靠 Electron 默认值：主窗口自己没有加载任何 document，Electron 会退回
// `app.getName()`，而它读的是 package.json 的 name —— 用户在标题栏、Mission
// Control、窗口切换器里看到的是 `@glittering0717/ai-browser`（npm 包名）。
// 产品名必须是我们自己声明的常量。
const APP_DISPLAY_NAME = 'AI Browser';

// CRITICAL: set userData BEFORE app.whenReady — session/cookie storage
// is initialized during ready, so setting it after loses persistence.
app.setPath('userData', config.userDataDir);

// === 错误日志：必须在 ready 之前就绪 ===
// 早期异常（模块初始化、窗口创建）恰恰是最常见的一类，等 ready 再初始化就等于
// 漏掉最关键的那一段。目录放在 userData 下（可写、可预期）：~/.ai-browser/logs/
const LOG_DIR = path.join(config.userDataDir, 'logs');
initErrorLog({ dir: LOG_DIR, meta: { port: config.wsPort, userData: config.userDataDir } });

// === 主进程兜底 ===
// 注册 uncaughtException 就等于接管 Electron 的默认行为 —— 而那个默认行为正是
// "弹一个只有栈的原生框，栈不进任何文件"。用户看到的是「弹了个框说 js 崩溃」，
// 点掉之后**没有任何地方能查到它崩在哪**（2026-10-17 实测）。
//
// 修法两步：① 先同步落盘（appendFileSync，崩之前一定写完）；
//          ② 提示改成**窗口底部的非阻塞红色横幅**，不再用原生模态框。
//
// 为什么不能用原生框（实测，不是推测）：dialog.showMessageBox 虽然返回 Promise，
// macOS 底层仍是 NSAlert 模态循环，**会阻塞主进程**。对照实验：不弹框时 WS 4ms
// 返回，弹框期间 8 秒无响应。一次"能自愈的异常"就这样被放大成"所有 RPC 超时"，
// agent 那边看到的是满屏 timed_out，与真实原因（一个无关的 JS 异常）完全对不上。
// 横幅是窗口里的一个 BrowserView：主进程照常跑，RPC 不受影响。
//
// 原生框仍作为调试开关保留（AI_BROWSER_ERROR_DIALOG=1），但只在需要"停下来盯着看"
// 时用；默认路径绝不允许阻塞。
const ERROR_BANNER_HEIGHT = 34;
// 连续异常时横幅不重开、只刷新内容；2 秒内的抖动直接合并（异常循环里每帧都发一次
// 会白烧 IPC，而人眼也看不出差别）。日志那条照旧一条不漏。
const BANNER_REFRESH_MS = 2000;

let errorBannerView = null;
let lastBannerAt = 0;
let bannerCount = 0;
// 启动阶段崩溃时窗口还不存在：先排队，等窗口建好再挂上去。
let pendingBanner = null;
let pendingBannerTimer = null;
// 连窗口都等不到（启动即死）时，多久后退回一次原生框 —— 这是唯一"什么都不显示"
// 的场景，否则用户会看到应用静默不动、也没有任何提示。
const BANNER_GIVE_UP_MS = 8000;
// 横幅自动收敛（2026-10-30）：以前横幅一旦挂上就只能靠人点 × 收起，异常明明已经
// 过去却会一直占着底部 34px —— 用户截图里那条深红横幅就是挂了 3 小时没消失。
// 现在：距最后一次 fatal 静默 BANNER_AUTO_HIDE_MS 后自动收起（日志里的 stack 永久保留，
// 收横幅不影响查证）。有新异常会重置计时器。
const BANNER_AUTO_HIDE_MS = (() => {
  const n = Number(process.env.AI_BROWSER_BANNER_AUTOHIDE_MS);
  return Number.isFinite(n) && n >= 500 ? n : 15000;   // 允许 e2e 调短；下限 500ms 防误配
})();
let bannerAutoHideTimer = null;

function scheduleBannerAutoHide() {
  if (bannerAutoHideTimer) { clearTimeout(bannerAutoHideTimer); bannerAutoHideTimer = null; }
  bannerAutoHideTimer = setTimeout(() => {
    bannerAutoHideTimer = null;
    // 只收起横幅视图，不动日志、不动计数；人仍可从 ui.errors 查到完整 stack。
    // 记一条：横幅自动收敛这件事必须可观测，否则"横幅是不是又挂死了"无从查证。
    if (errorBannerView) {
      try { recordError('error_banner_autohide', { after_ms: BANNER_AUTO_HIDE_MS }); } catch {}
      try { hideErrorBanner(); } catch (_) {}
    }
  }, BANNER_AUTO_HIDE_MS);
  if (bannerAutoHideTimer.unref) bannerAutoHideTimer.unref();
}

function bannerEnabled() {
  // e2e / 无人值守可以关掉（日志照记）：横幅虽不阻塞，但会改变窗口布局，
  // 截图对比类断言会因此漂移。
  return String(process.env.AI_BROWSER_ERROR_BANNER || '') !== '0';
}
function nativeDialogForced() {
  return String(process.env.AI_BROWSER_ERROR_DIALOG || '') === '1';
}

// 原生模态框：只走 AI_BROWSER_ERROR_DIALOG=1。保留它是因为排查启动阶段崩溃时
// "让窗口停在那儿"仍然有用，但它不能是默认路径。
function showNativeFatalDialog(detail) {
  const body = 'A JavaScript error occurred in the main process.\n\n'
    + detail
    + '\n\n已写入日志：\n' + (getLogPath() || '(日志未就绪)');
  if (!app.isReady()) {
    try { dialog.showErrorBox('AI Browser 主进程异常（启动阶段）', body); } catch {}
    return;
  }
  setTimeout(() => {
    recordError('error_dialog', {
      note: 'modal dialog opened — main-process event loop is blocked until dismissed',
      detail: String(detail || '').slice(0, 500),
    });
    try {
      const p = dialog.showMessageBox({
        type: 'error',
        title: 'AI Browser 主进程异常',
        message: 'AI Browser 主进程异常',
        detail: body,
        buttons: ['好'],
        noLink: true,
      });
      if (p && typeof p.then === 'function') p.then(() => {}).catch(() => {});
    } catch {
      /* 无 GUI / 弹框失败：日志已经在盘上，这不影响记录 */
    }
  }, 800);
}

// === 标签栏视图的生命周期治理（2026-10-30 白屏事故的根治）=================
//
// 事故形态：标题栏还在、页面区全白、底部一条深红横幅 —— 也就是 tabBarView 的
// webContents 失效（close/destroy 后变 undefined，或渲染进程被 GPU 崩溃连带走），
// 而 setInterval(pushNavState, 1500) 每 1.5s 无条件访问它 → 抛
// "Cannot read properties of undefined (reading 'isDestroyed')" → uncaughtException
// → reportFatal → showErrorBanner → layoutWithBanner 又碰悬空视图 → 二次崩溃 →
// 进程半死（端口 listen 但 WS 握不上手）。日志里这个异常反复出现 22 次。
//
// 治理三要点（底层通用，不是逐个补丁）：
//   1. 所有"这视图还活着吗"的判断走 shared/view_liveness.cjs 的 isAlive，绝不裸写
//      .webContents.isDestroyed()；
//   2. tabBarView 每次被 pushNavState 摸到时顺手体检一次，死了就重建 —— 把原来的
//      "崩溃点"变成"自愈点"；
//   3. 重建有节流与上限：GPU 连续崩溃时不能无限 new BrowserView（那就是另一种死循环）。
let tabBarRebuildAt = 0;
let tabBarRebuildCount = 0;
const TAB_BAR_REBUILD_MIN_GAP = 1500;   // 两次重建至少隔 1.5s
const TAB_BAR_REBUILD_MAX = 8;          // 单进程生命周期内最多重建 8 次

/** 造一个全新的标签栏 BrowserView 并挂进窗口。交互靠主进程全局 IPC，不用逐 view 重绑。 */
function createTabBarView() {
  const view = new BrowserView({
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  mainWindow.addBrowserView(view);
  try {
    const cb = mainWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: cb.width, height: TAB_BAR_HEIGHT });
  } catch {
    view.setBounds({ x: 0, y: 0, width: 1280, height: TAB_BAR_HEIGHT });
  }
  view.webContents.loadFile(path.join(__dirname, '../renderer/tab_bar.html'));

  // 渲染进程真的死了（killed/crashed）时主动报一声并触发自愈，而不是等 1.5s 轮询。
  // clean-exit 也要管：标签栏是常驻视图，"正常退出"对它就是不该发生的丢失。
  view.webContents.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown';
    try { recordError('tabbar_renderer_gone', { reason }); } catch {}
    // 让出当前回调栈再重建，避免在 Electron 的事件派发过程中拆自己的 view。
    setTimeout(() => {
      try { ensureTabBarAlive(true); } catch (e) {
        try { recordError('tabbar_rebuild_failed', { error: String(e && e.message || e) }); } catch {}
      }
    }, 120);
  });
  return view;
}

/**
 * 保证标签栏活着。死了就重建（带节流与上限），返回当前可用的 view 或 null。
 * @param {boolean} force 渲染进程刚死时为 true，跳过"最小间隔"节流（但仍受上限约束）。
 */
function ensureTabBarAlive(force = false) {
  if (isAlive(tabBarView)) return tabBarView;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const now = Date.now();
  if (!force && now - tabBarRebuildAt < TAB_BAR_REBUILD_MIN_GAP) return null;
  if (tabBarRebuildCount >= TAB_BAR_REBUILD_MAX) {
    // 到顶了就不再重建，避免 GPU 反复崩溃时的无限循环。日志留一次，让人能查到。
    if (tabBarRebuildCount === TAB_BAR_REBUILD_MAX) {
      tabBarRebuildCount++;   // 只记一次，之后静默
      try { recordError('tabbar_rebuild_exhausted', { max: TAB_BAR_REBUILD_MAX }); } catch {}
    }
    return null;
  }
  // 摘掉悬空的旧对象（try 包裹：它可能已经被 Electron 内部拆掉了）。
  if (tabBarView) {
    try { mainWindow.removeBrowserView(tabBarView); } catch {}
  }
  try {
    tabBarView = createTabBarView();
    tabBarRebuildAt = now;
    tabBarRebuildCount++;
    try { recordError('tabbar_rebuilt', { count: tabBarRebuildCount, prev: 'dead' }); } catch {}
    // 新视图的 renderer 会自己拉一次 nav:state；这里再手动补一帧布局，避免它暂时
    // 用了默认 1280 宽而窗口其实更宽/更窄。
    layoutWithBanner();
    return tabBarView;
  } catch (e) {
    tabBarView = null;
    try { recordError('tabbar_rebuild_failed', { error: String(e && e.message || e) }); } catch {}
    return null;
  }
}

// 布局集中在一处算：横幅要占掉底部 34px，页面视图必须相应让出来，
// 否则横幅会被页面盖住（或反过来压住页面最后一行）。
function layoutWithBanner() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let b;
  try { b = mainWindow.getContentBounds(); } catch { return; }
  // ⚠️ 不能裸写 tabBarView.webContents.isDestroyed()：webContents 在 close/destroy
  // 后会变成 undefined，那样会抛 "Cannot read properties of undefined" 击穿主进程
  // （2026-10-30 白屏事故的 22 次崩溃，全在这条链上）。统一走 isAlive。
  if (isAlive(tabBarView)) {
    tabBarView.setBounds({ x: 0, y: 0, width: b.width, height: TAB_BAR_HEIGHT });
  }
  const inset = errorBannerView ? ERROR_BANNER_HEIGHT : 0;
  if (pageManager) pageManager._bottomInset = inset;
  if (isAlive(errorBannerView)) {
    errorBannerView.setBounds({
      x: 0,
      y: Math.max(0, b.height - ERROR_BANNER_HEIGHT),
      width: b.width,
      height: ERROR_BANNER_HEIGHT,
    });
  }
  if (pageManager) pageManager._layoutAllViews(b);
}

function ensureErrorBanner() {
  if (isAlive(errorBannerView)) return errorBannerView;
  // 悬空的旧横幅：先从窗口摘掉，再重建。否则旧对象会一直占着 z 序位置。
  if (errorBannerView) {
    try { mainWindow.removeBrowserView(errorBannerView); } catch {}
    errorBannerView = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // 与标签栏同样的配置（nodeIntegration + 非隔离）：横幅是我们自己的本地页面，
  // 需要 ipcRenderer 才能把「×」传回主进程。页面里没有任何远程内容。
  errorBannerView = new BrowserView({
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  try { errorBannerView.setBackgroundColor('#7f1d1d'); } catch {}
  mainWindow.addBrowserView(errorBannerView);
  // 新开 tab 会往窗口里再加一个视图；显式置顶一次，避免"横幅被后来的页面盖住"
  // 这种只在特定时序下出现的 bug。
  try { mainWindow.setTopBrowserView(errorBannerView); } catch {}
  errorBannerView.webContents.loadFile(path.join(__dirname, '../renderer/error_banner.html'));
  return errorBannerView;
}

function showErrorBanner(payload) {
  const view = ensureErrorBanner();
  if (!view) return false;
  const deliver = () => {
    try { if (isAlive(view)) view.webContents.send('error-banner:show', payload); } catch { /* 帧已销毁就放弃，日志已有 */ }
  };
  // 首次创建时 listener 还没注册，直接 send 会静默丢失 —— 等 load 完再发。
  let loading = false;
  try { loading = isAlive(view) && view.webContents.isLoading(); } catch { loading = false; }
  if (loading) { try { view.webContents.once('did-finish-load', deliver); } catch { deliver(); } }
  else deliver();
  layoutWithBanner();
  return true;
}

function hideErrorBanner() {
  if (!errorBannerView) return;
  const view = errorBannerView;
  errorBannerView = null;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(view);
  } catch {}
  try { view.webContents.destroy(); } catch {}
  layoutWithBanner();
}

function flushPendingBanner() {
  if (!pendingBanner) return;
  const payload = pendingBanner;
  pendingBanner = null;
  if (pendingBannerTimer) { clearTimeout(pendingBannerTimer); pendingBannerTimer = null; }
  showErrorBanner(payload);
}

function reportFatal(detail) {
  // reportFatal 本身跑在 process.on('uncaughtException') 里 —— 它是兜底处理器，
  // 自己**绝不能**再抛异常（否则就是"处理器内部二次崩溃 → 进程半死"，2026-10-30
  // 白屏事故里端口还 listen 但 WS 握不上手，正是这么来的）。整段包死。
  try {
    reportFatalInner(detail);
  } catch (e) {
    try { console.error('[reportFatal] self-guarded:', e && e.message); } catch {}
  }
}

function reportFatalInner(detail) {
  const text = String(detail === undefined || detail === null ? '' : detail);
  if (nativeDialogForced()) { showNativeFatalDialog(text); return; }
  if (!bannerEnabled()) return;
  const logPath = getLogPath() || '';
  const now = Date.now();
  bannerCount = now - lastBannerAt < BANNER_REFRESH_MS ? bannerCount + 1 : 1;
  lastBannerAt = now;
  const payload = errorBanner.buildBannerPayload({ detail: text, logPath, count: bannerCount });
  recordError('error_banner', {
    detail: text.slice(0, 500),
    log_path: logPath,
    note: 'shown in-window (non-blocking); no modal dialog opened',
  });
  scheduleBannerAutoHide();
  if (app.isReady() && mainWindow && !mainWindow.isDestroyed()) {
    showErrorBanner(payload);
    return;
  }
  // 窗口还没建好：排队。等 createWindow 完成后 flushPendingBanner() 挂上去。
  pendingBanner = payload;
  if (pendingBannerTimer) clearTimeout(pendingBannerTimer);
  pendingBannerTimer = setTimeout(() => {
    pendingBannerTimer = null;
    if (!pendingBanner) return;
    const p = pendingBanner;
    pendingBanner = null;
    // 这里退回原生框是**有意的例外**：没有窗口 = 没有别的地方能显示任何东西，
    // 静默死掉比阻塞更糟。日志里记一笔，避免以后把它当成"又弹框了"的回归。
    recordError('error_dialog_fallback', {
      note: 'no window to host the banner — native box used once so the failure is visible',
      detail: p.detail,
    });
    try {
      dialog.showErrorBox(
        'AI Browser 主进程异常（启动阶段）',
        p.detail + '\n\n已写入日志：\n' + (p.log_path || '(日志未就绪)')
      );
    } catch {}
  }, BANNER_GIVE_UP_MS);
}

process.on('uncaughtException', (err, origin) => {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    recordError('uncaught_exception', {
      origin: origin || null,
      message: e.message,
      stack: String(e.stack || '').slice(0, 8000),
    });
  } catch (_) {}
  try { console.error('[fatal] uncaughtException:', (e && e.stack) || e); } catch (_) {}

  // 纵深自愈：如果这次异常本身就是"某个视图失效"引起的（例如别的路径仍存在的
  // 裸访问，或第三方代码碰了我们的 view），立刻体检并重建标签栏，别把白屏留给
  // 用户。识别信号用错误文本 —— 这类崩溃的典型文案就是 reading 'isDestroyed'。
  // 这一步只重建 chrome 视图，不 reload 用户页面，代价可控。
  try {
    if (/isDestroyed|webContents|Object has been destroyed/i.test(String(e.message || ''))) {
      ensureTabBarAlive(true);
    }
  } catch (_) {}

  try { reportFatal((e && e.message) || String(e)); } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  recordError('unhandled_rejection', {
    message: e.message,
    stack: String(e.stack || '').slice(0, 8000),
  });
  // 这里**不弹框**：没接住 Promise 属于实现疏漏，噪音大但多数不影响用户当下的
  // 操作。弹框只会把真正需要人介入的致命异常淹掉 —— 记下来就够。
  console.error('[warn] unhandledRejection:', (e && e.stack) || e);
});

// 网页渲染进程崩溃（"Aw, Snap!"）与 Chromium 子进程崩溃（网络服务/GPU）。
// 2026-10-17 实测见过 `Network service crashed, restarting service`：网络服务
// 挂了之后所有页面都打不开，但主进程还活着 —— 没有这层记录就完全无从判断。
app.on('render-process-gone', (_event, webContents, details) => {
  let url = null;
  try { url = webContents && webContents.getURL(); } catch {}
  recordError('render_process_gone', {
    reason: details && details.reason,
    exit_code: details && details.exitCode,
    url,
  });
});

app.on('child-process-gone', (_event, details) => {
  recordError('child_process_gone', {
    type: details && details.type,
    reason: details && details.reason,
    exit_code: details && details.exitCode,
    service: details && details.serviceName,
  });
  // GPU 崩溃自动降级（见下面 disableHardwareAcceleration 的说明）。
  // 只在"开着硬件加速"时计数；已经降级过就不再折腾。
  const type = details && details.type;
  const reason = details && details.reason;
  if (!gpuDisabled && type === 'GPU' && reason && reason !== 'clean-exit') {
    const now = Date.now();
    gpuCrashes = gpuCrashes.filter((t) => now - t < 120000).concat(now);
    if (gpuCrashes.length >= 2) {
      try { fs.writeFileSync(gpuOffMarker, new Date().toISOString() + ' gpu crash fallback\n'); } catch (e) {}
      recordError('gpu_fallback', { crashes: gpuCrashes.length, reason });
      try { app.relaunch(); } catch (e) {}
      try { app.exit(0); } catch (e) {}
    }
  }
});
let gpuCrashes = [];

// === 硬件加速：默认开，GPU 连续崩溃自动退回软件合成 ===
//
// 历史：2026-10 为了让某些机器上的 GPU 崩溃（exit_code=6）别把整个 app 拖死，
// 这里无条件 disableHardwareAcceleration()。代价是**所有页面都走软件合成**，
// 而"整窗内容被缩放一帧""刷新时先缩成一小块再恢复""内容缩在左上角"这类绘制异常
// 几乎都长在软件合成上 —— 合成器手里的 surface 尺寸和图层几何脱节时，软件路径会
// 把那张图**缩放**着贴出来，GPU 路径则按图层几何重新栅格化。
//
// 现在的策略：
//   - 默认开硬件加速（Apple Silicon 上更快，也不出这类缩放异常）
//   - 连续两次 GPU 进程崩溃（2 分钟内）→ 写标记 + 自动重启到软件合成，
//     之后一直用软的（删掉 ~/.ai-browser/.gpu-off 可恢复）。绝不因为一次偶发崩溃
//     就把所有人降级到软件渲染。
//   - AI_BROWSER_GPU=on|off 可强制；off 等价于旧行为。
const gpuOffMarker = path.join(config.userDataDir, '.gpu-off');
const gpuPref = String(process.env.AI_BROWSER_GPU || 'auto').toLowerCase();
let gpuDisabled = gpuPref === 'off';
if (!gpuDisabled && gpuPref !== 'on') {
  try { gpuDisabled = fs.existsSync(gpuOffMarker); } catch (e) { gpuDisabled = false; }
}
if (gpuDisabled) app.disableHardwareAcceleration();

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
let networkWatchdog = null;
let isQuitting = false;
// 退出时固化会话 cookie 的一次性开关：cleanupAndQuit 分流用（见其注释），
// 固化期间的其他重入调用被忽略，固化完成后经 _finishCleanup 继续退出。
let cookiePersistDone = false;
// 退出流程总开关：第一条退出路径（ui.quit / 关窗 / before-quit）置位后，
// 其余路径全部忽略；固化完成回来时走 _finishCleanup 而不是再进这里。
let cleanupStarted = false;

// === Single instance lock — second launch just focuses the existing window ===
const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // Dock 图标被点击（macOS 上"再点一次已运行的应用"、或窗口被隐藏后想找回它）。
  //
  // 后台模式（AI_BROWSER_START_HIDDEN / ui.window{visible:false}）下窗口默认是隐藏的，
  // 这是人把它叫回来的**唯一**约定入口 —— 没有它，"随时可以点开使用"就成了空话，
  // 用户只能去活动监视器里杀进程。
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (pageManager && pageManager.setWindowVisible) {
        pageManager.setWindowVisible(true, { focus: true });
      } else {
        mainWindow.show();
      }
    } catch (_) { /* 窗口正在销毁 */ }
  });
} else {
  // A real second instance would fight the first one over the :9223 WS port
  // and share one Chromium profile / userDataDir with the first — the duplicate
  // must exit and let the existing window handle the request.
  // gotLock===false already means "another instance owns the lock", on EVERY
  // platform (including macOS packaged builds); the previous platform-conditional
  // exemption silently skipped this quit, which let two ai-browser instances run
  // side by side — closing one of them then crashed (Bug 6).
  // 落了盘才有"事后可查"：从 Finder/双击启动时 stderr 是黑洞，只 console.error
  // 等于什么都没留下（用户只会说"我点了没反应"）。
  recordError('second_instance_exit', {
    port: PORT,
    user_data: config.userDataDir,
    note: '另一个实例持有单实例锁，本进程退出（避免两个进程共享同一 Chromium profile 并抢同一端口）',
  });
  console.error('[index] another AI Browser instance is already running — quitting');
  app.quit();
}

// === 应用图标（2026-10-20）===
//
// macOS 上从源码启动时 Dock 图标是 Electron 的默认火箭 —— 因为进程本体就是
// node_modules/electron/dist/Electron.app，**Dock 跟的是可执行文件，不是我们的
// 代码**。打包版没有这个问题（Info.plist 里已经是自定义 icns），但 `npm start`
// / `npx` 启动占日常使用的大头；图标错了，用户的判断就是"这不是 AI Browser"。
// （2026-10-20 原话："我看现在系统里运行的 ai-browser 都是默认图标了"。）
//
// app.dock.setIcon 是 Electron 提供的运行时入口，不影响签名与打包。
// Windows/Linux 走 BrowserWindow 的 icon 选项（见 createWindow）。
//
// ⚠️ 这里必须用 build/icon-dock.png，不能用 build/icon.png。
//    macOS 26/27 给 bundle 里的 icns 套了一层统一图标网格（内容缩到约 86.7%），
//    而 dock.setIcon 的裸图**不套**这层网格 —— 直接塞满出血的 icon.png，Dock
//    里就会比旁边所有图标大一圈。而打包版走的是 Info.plist 的 icns，正好是
//    缩过的 86.7%。于是"从 /Applications 启动"和"npm start"画出来两个尺寸，
//    用户看到的就是图标一会大一会小。icon-dock.png 由 render_icon.cjs 预先按
//    86.7% 缩好，两条路径才落到同一个尺寸（契约见 tests/test_icon_geometry.js）。
function appIconPath(kind = 'window') {
  const base = path.join(__dirname, '..', '..', 'build');
  const pick = (f) => {
    const p = path.join(base, f);
    try { return fs.existsSync(p) ? p : null; } catch (_) { return null; }
  };
  if (kind === 'dock') {
    // 先要按网格缩过的；退而求其次用满出血那张（会偏大，但总比 Electron 火箭强），
    // 并把 fallback 记进 appIconState —— 让"为什么偏大"能一眼看出来。
    const dock = pick('icon-dock.png');
    if (dock) return { file: dock, fallback: false };
    const plain = pick('icon.png');
    return plain ? { file: plain, fallback: true } : null;
  }
  return { file: pick('icon.png'), fallback: false };
}

// 把"实际设进去的图有多大"量出来报给外部（ui.server_info.icon）。
// 只要这个数字偏离系统网格，"图标大小不对"就能被直接判定，而不是靠肉眼比。
function measureIcon(file) {
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    // 不缩放：缩放会让边缘抗锯齿多出一两像素，量出来的占比偏高（实测 256px 时
    // 86.7% → 87.5%）。这里要的是"这张图本身"的数字，1024² 全扫一遍也就几毫秒。
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();            // BGRA，alpha 在第 4 字节
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (bmp[(y * width + x) * 4 + 3] > 2) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { content_ratio: 0 };
    return {
      pixels: `${width}x${height}`,
      content_ratio: +((maxX - minX + 1) / width).toFixed(3),
    };
  } catch (e) {
    return { error: e.message };
  }
}

let appIconState = null;

function applyAppIcon() {
  // 打包版：Info.plist 里已经是自定义 icns，系统会按图标网格渲染 —— 不要再动它。
  // 反过来，源码启动时进程本体是 Electron.app，Dock 跟的是可执行文件，不设就是火箭。
  if (process.platform !== 'darwin') {
    appIconState = { source: 'none', reason: 'non-darwin' };
    return false;
  }
  if (app.isPackaged) {
    appIconState = { source: 'bundle', reason: 'packaged: Info.plist icns' };
    return false;
  }
  const icon = appIconPath('dock');
  if (!icon) {   // 装的是精简包（没带 build/）→ 静默跳过，不值得启动失败
    appIconState = { source: 'none', reason: 'build/icon-dock.png missing' };
    return false;
  }
  try {
    if (app.dock && typeof app.dock.setIcon === 'function') {
      app.dock.setIcon(icon.file);
      appIconState = {
        source: 'dock.setIcon',
        file: path.basename(icon.file),
        ...(icon.fallback ? { fallback: true, note: 'icon-dock.png 缺失，退回满出血图（会比系统图标大）' } : {}),
        ...(measureIcon(icon.file) || {}),
      };
      return true;
    }
  } catch (e) {
    console.error('[icon] dock.setIcon failed:', e && e.message);
    appIconState = { source: 'error', error: e.message };
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 见文件头 APP_DISPLAY_NAME：不显式给 title 会显示成 npm 包名。
    // 真实显示值由 updateWindowTitle() 按当前标签页覆盖。
    title: APP_DISPLAY_NAME,
    // Windows/Linux 的任务栏图标来自这里（macOS 走 app.dock.setIcon，
    // 见 applyAppIcon：Dock 跟的是进程可执行文件，不是窗口选项）。
    icon: (appIconPath('window') || {}).file || undefined,
    // 先不显示：如何显示由 showInitialWindow() 按焦点策略决定 —— 窗口必须真实可见
    // （产品承诺人可随时介入），但被 agent 拉起时不该把用户正在做的事打断。
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 窗口标题统一由 updateWindowTitle() 控制（当前标签页标题 + 产品名）。
  // 主窗口自己的 webContents 不加载页面，但 renderer 重启的瞬间可能出现空
  // document.title，Electron 会拿它把标题清成空字符串 —— 这里直接掐断。
  mainWindow.webContents.on('page-title-updated', (e) => { e.preventDefault(); });

  // Tab bar — needs nodeIntegration for ipcRenderer
  tabBarView = createTabBarView();

  // Init PageManager
  pageManager = PageManager.getInstance(mainWindow);
  // 渲染路径是"硬件合成"还是"软件合成"，直接决定绘制异常的面貌（见
  // disableHardwareAcceleration 一段）。让外部能查到这一位：ui.server_info 会带出来，
  // 否则"页面上这一帧的问题"和"这条路的问题"永远分不开。
  pageManager.renderPath = { gpu: !gpuDisabled, reason: gpuPref === 'off' ? 'env' : (gpuDisabled ? 'fallback' : 'default') };
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
  pageManager.startupTab = pageManager.newTab(START_URL);

  // 启动阶段崩溃排的队到这里兑现：窗口、标签栏、页面视图都已就绪，横幅才挂得上。
  flushPendingBanner();

  // Start WS server — pass cleanupAndQuit so ui.quit can shut down the app
  wsServer = startWSServer(pageManager, PORT, cleanupAndQuit);
  // 监听失败必须让人看见。此前 ws_server 把错误 `.catch(() => {})` 吞了，
  // 实测端口被占时窗口照常起来、却没有任何 WS，用户与 agent 都不知道为什么。
  wsServer.ready.catch(() => {
    const err = wsServer.listenError;
    const code = (err && err.code) || 'unknown';
    reportFatal(
      `WS 端口 ${PORT} 监听失败（${code}）。本实例收不到任何指令 —— `
      + (code === 'EADDRINUSE'
        ? '端口已被占用：先关掉另一个 ai-browser 实例，或用 AI_BROWSER_PORT 换一个端口。'
        : '详见 error.jsonl 的 ws_listen_error 条目。')
    );
  });

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

  // 错误横幅上的「×」：连关闭动作也走 IPC —— 横幅是独立的 BrowserView，
  // 它没有别的通道能告诉主进程"把我收起来"。
  // setImmediate：不要在渲染进程自己派发的事件里销毁它所属的 frame（先让这条
  // IPC 走完，再拆视图）。
  ipcMain.on('error-banner:close', () => { setImmediate(hideErrorBanner); });

  // === 地址栏 / 导航按钮 ===
  ipcMain.handle('nav:state', () => buildNavState());
  ipcMain.on('nav:go', (_e, input) => {
    const url = normalizeUrlInput(input);
    if (!url) return;
    // 走 pageManager.navigate 而不是裸 loadURL：裸的这条路上没有导航状态机
    // （list_tabs 会一直报 ready）、没有失败错误页、也没有导航完成后的重绘。
    // 地址栏是最常用的一条路，缺这三样的代价就是"有时白屏、说不清在干嘛"。
    pageManager.navigate(url, pageManager.activeTab).catch(() => {});
  });
  ipcMain.on('nav:back', () => { const wc = activeWebContents(); if (wc && wc.navigationHistory) wc.navigationHistory.goBack(); });
  ipcMain.on('nav:forward', () => { const wc = activeWebContents(); if (wc && wc.navigationHistory) wc.navigationHistory.goForward(); });
  ipcMain.on('nav:reload', () => { const wc = activeWebContents(); if (wc) wc.reload(); });
  ipcMain.on('nav:stop', () => { const wc = activeWebContents(); if (wc) wc.stop(); });
  // 工具条上的「下载」：当前页是一份被救回来的图片/视频/PDF 时，存进下载目录。
  // 为什么不在页面里放按钮：站点页面的 DOM 我们不该改（会被 CSS 打架、被 CSP 拦、
  // 也会让"页面内容"不再可信）；按钮挂在自家 chrome 上，任何站点都一致。
  ipcMain.on('nav:download', () => {
    if (!pageManager) return;
    pageManager.downloadCurrent(pageManager.activeTab);
  });

  // === 下载结果页（renderer/download.html）===
  //
  // ⚠️ `__ai_browser__.dl` 挂在每个标签页的 window 上（含站点页面），所以这里
  // 必须自己把门：只受理我们自己的界面页，并且路径必须在下载目录之内。
  // 少了这道门，任意站点都能让浏览器"打开/在 Finder 里高亮"用户下载过的文件。
  const isChromeSender = (event) => {
    try { return mediaDoc.isChromePageUrl(event.sender.getURL()); } catch (_) { return false; }
  };
  const insideDownloads = (p) => {
    try {
      const base = path.resolve(pageManager.downloadMonitor.baseDir);
      const abs = path.resolve(String(p || ''));
      return abs === base || abs.startsWith(base + path.sep);
    } catch (_) { return false; }
  };
  ipcMain.handle('dl:record', (event) => {
    if (!isChromeSender(event)) return { found: false };
    const tab = pageManager._tabIdOfWebContents(event.sender);
    if (tab === undefined) return { found: false };
    const list = pageManager.downloadMonitor.list(tab).downloads || [];
    const rec = list[list.length - 1];
    if (!rec) return { found: false };
    const out = {
      found: true,
      state: rec.state,
      received: rec.received_bytes,
      total: rec.total_bytes,
      path: rec.path,
      filename: rec.filename,
      mime: rec.mime,
    };
    if (rec.state === 'completed' && mediaDoc.kindOf(rec.mime) === 'image') {
      out.thumb = thumbDataUrl(rec.path);
    }
    return out;
  });
  ipcMain.on('dl:open', (event, p) => {
    if (!isChromeSender(event) || !insideDownloads(p)) return;
    try { if (fs.existsSync(p)) shell.openPath(p).catch(() => {}); } catch (_) { /* ignore */ }
  });
  ipcMain.on('dl:reveal', (event, p) => {
    if (!isChromeSender(event) || !insideDownloads(p)) return;
    try { shell.showItemInFolder(p); } catch (_) { /* ignore */ }
  });

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

  // Resize handler —— 走 layoutWithBanner：横幅在的时候页面视图要让出底部 34px，
  // 各算各的迟早会出现"横幅被页面盖住"或"页面最后一行被横幅压住"。
  mainWindow.on('resize', () => {
    layoutWithBanner();
  });
  // 注：resize 的重绘（repaintActiveSoon）在下面"几何变化"一段里统一绑定 ——
  // 那里能看到 repaintActive 的定义。

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
  // 拖动窗口边缘时会连发几十个 resize；逐个重绘会抖成幻灯片。150ms 去抖：松手就补一帧。
  let repaintTimer = null;
  const repaintActiveSoon = (ms = 150) => {
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(repaintActive, ms);
  };
  mainWindow.on('show', repaintActive);
  mainWindow.on('restore', repaintActive);
  mainWindow.on('focus', repaintActive);

  // === 几何变化 → 必须让 surface 重新栅格化 ===
  //
  // 只重排（setBounds）不够：如果 surface 还是旧尺寸，合成器会把那张大图缩进新的
  // bounds —— 用户看到"页面缩成左上角一小块、其余全白"，而 DOM、evaluate、截图
  // 全都正常（2026-10-25 用户截图就是这个形态）。所以要连 invalidate 一起做。
  //
  // 触发点选这几个：窗口缩放、进出全屏（macOS 全屏会换 display）、显示器参数变化
  // （分辨率/缩放/插拔外接屏）、系统从睡眠唤醒 —— 这四类都会让"窗口几何"和
  // "合成器手里的 surface 尺寸"脱节，是最常见的来源。
  // 几何变化后不能只重画：还要确认"渲染视口真的跟上了新尺寸"（见 afterGeometryChange
  // 的注释 —— 视图 800 而页面还按 1280 排版，就是用户看到的"大一下小一下"）。
  const afterGeometry = () => { try { pageManager.afterGeometryChange(); } catch (e) {} };
  let geomTimer = null;
  const afterGeometrySoon = (ms = 150) => {
    if (geomTimer) clearTimeout(geomTimer);
    geomTimer = setTimeout(afterGeometry, ms);
  };
  mainWindow.on('resize', () => afterGeometrySoon(150));
  mainWindow.on('enter-full-screen', () => { layoutWithBanner(); afterGeometrySoon(120); });
  mainWindow.on('leave-full-screen', () => { layoutWithBanner(); afterGeometrySoon(120); });
  const onDisplayChange = () => { try { layoutWithBanner(); } catch (e) {} afterGeometrySoon(80); };
  try {
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
  } catch (e) { /* 无 screen 模块（极老版本） */ }
  try {
    powerMonitor.on('resume', () => { onDisplayChange(); afterGeometrySoon(400); });
  } catch (e) { /* 无 powerMonitor */ }
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
  // 挂载规则收敛到 shared/nav_follow.cjs：同一个 webContents **幂等**
  // （WeakSet 记账），修掉"切回旧 tab 又挂一遍"的累加；webContents 被销毁时
  // 顺手清掉我们持有的引用。这段原来写在闭包里，判据只能 grep 源码 ——
  // 实测 A→B→A×5 后监听数是 3，而回归全绿（见 tests/test_nav_follow.js）。
  const navFollower = createNavFollower({ push: pushNavState });
  const wireNavState = () => navFollower.wire(activeWebContents());
  // 包一层只为了挂「地址栏跟随」这块副作用，返回值必须原样透传 ——
  // ws_server 的 ui.set_active_tab 靠它回 { ok }（2026-10-19 测到过包装吞掉
  // 返回值导致 agent 收到空回执的事故，见 shared/tab_hooks.js 注释）。
  wrapSetActive(pageManager, () => {
    wireNavState();
    pushNavState();
  });
  wireNavState();
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
  // 后台模式：进程起来但**不出窗口**。这是"跟无头浏览器一样无感知运行"的入口 ——
  // agent 无人值守跑任务时，不该在用户桌面上开一个窗口。
  // 与"人可随时介入"不矛盾：Dock 图标一点（app 'activate'）就显示出来，
  // 也可以 ui.window{visible:true} 显式打开。
  if (/^(1|true|yes|on)$/i.test(String(process.env.AI_BROWSER_START_HIDDEN || ''))) {
    console.log('[window] AI_BROWSER_START_HIDDEN=1 — 后台运行，窗口不显示（Dock 点击可打开）');
    pageManager.windowShownAt = null;
    return;
  }
  // 默认（非后台模式）：窗口**一定**要显示出来 —— 人可随时手动介入（登录、扫码、
  // 过验证码、纠正 agent 的操作）。策略只决定**显示时抢不抢焦点**：只有人手动启动、
  // 或显式 always，才显示并激活；agent 拉起走 showInactive —— 窗口出现，但键盘焦点
  // 留在用户那边。
  const shouldActivate = policy === 'always' || (policy !== 'never' && !byAgent);

  const doShow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (shouldActivate) mainWindow.show();
      else mainWindow.showInactive();
    } catch (e) {
      try { mainWindow.show(); } catch (e2) { /* 窗口已销毁 */ }
    }
    // Windows：show() 之后原生标题栏/边框才真正应用，content 高度会比"隐藏时"少
    // 几十像素（实测 800 外框：隐藏时 content≈761，显示后 735）。但外框尺寸没变 →
    // **不触发 resize** → 页面视图仍按显示前的 content 高度布局，底部溢出约 26px
    // （页面最后一截被窗口底边裁掉）。这里在显示后补一次重排，并再延迟兜底两次，
    // 确保边框真正应用后视图收敛到"视图几何 == 内容区"（layout 套件 G1 断言）。
    const relayoutAfterShow = () => { try { layoutWithBanner(); } catch (_) { /* 窗口已销毁 */ } };
    relayoutAfterShow();
    setTimeout(relayoutAfterShow, 150);
    setTimeout(relayoutAfterShow, 450);
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
    // 那一刻 webContents 上到底是哪一页 —— 这决定了 show_reason 能不能说实话。
    //
    // 2026-10-24 起新标签页先加载 loading.html 占位页（把白屏换成"正在打开 <url>"），
    // 而占位页**自己也会发 dom-ready**。于是"等到 dom-ready 才显示"这条承诺被它
    // 架空了：记录里写着 dom-ready + waited_for_dom:true，而此刻页面是我们的占位页，
    // 目标文档一个字节都没到（实测：外网不通时 body 恒为 578 字符）。
    // 口径交给 shared/window_show.js 折算，那里有完整的来由与反例。
    let curUrl = '';
    try { curUrl = (wc && !wc.isDestroyed() && wc.getURL) ? String(wc.getURL() || '') : ''; } catch (_e) { curUrl = ''; }
    const cls = classifyShowReason(reason, curUrl);
    const rec = {
      tab: pageManager.activeTab,
      body_len: null,
      ready_state: null,
      // 'dom-ready' | 'renderer-ready' | 'fail-load' | 'timeout' | 'placeholder'
      show_reason: cls.show_reason,
      // 真话：只有**目标文档**就绪才算等到了。占位页就绪不算（那是我们自己的页面）。
      waited_for_dom: cls.waited_for_dom,
      // 当时挂在 webContents 上的地址（占位页 URL 里带着目标地址，最有用的一半）。
      show_url: describeShowUrl(curUrl),
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
  if (isAlive(tabBarView)) {
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
  if (!isAlive(view)) return null;
  return view.webContents;
}

/**
 * 窗口标题 = "当前页标题 — AI Browser"，没有页标题时只显示产品名。
 *
 * 为什么要有：多窗口/多桌面环境下，标题栏是用户唯一能识别"这个窗口在哪个页面"
 * 的地方；原先它是 npm 包名，既不是产品名也不带任何页面信息。
 * 只做「变了才设」——pushNavState 由事件 + 1.5s 轮询双重驱动，无条件 setTitle
 * 会让系统在每次轮询时都收到一次标题变更通知。
 */
let lastWindowTitle = '';
function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = activeWebContents();
  let pageTitle = '';
  try { pageTitle = wc ? String(wc.getTitle() || '').trim() : ''; } catch (_) { pageTitle = ''; }
  const next = pageTitle && pageTitle !== APP_DISPLAY_NAME
    ? `${pageTitle} — ${APP_DISPLAY_NAME}`
    : APP_DISPLAY_NAME;
  if (next === lastWindowTitle) return;
  lastWindowTitle = next;
  try { mainWindow.setTitle(next); } catch (_) { /* 窗口在关闭竞态里 */ }
}

/**
 * 地址栏 + 工具条需要的一切状态。
 *
 * 单一实现：`nav:state`（初始化时自取）与 `pushNavState`（事件 + 1.5s 轮询）
 * 必须是同一份 —— 两处各写一遍的结果是"某些字段只在某条路上有"，表现为
 * 按钮有时出现有时不出现，而且极难复现。
 */
function buildNavState() {
  const wc = activeWebContents();
  if (!wc) {
    return { tab: null, url: '', canBack: false, canForward: false, loading: false, status: '', media_doc: null, download: null };
  }
  const tab = pageManager.activeTab;
  const url = wc.getURL();
  let media = null;
  try { media = pageManager.mediaDocOf(tab); } catch (_) { media = null; }
  return {
    tab,
    url,
    canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    loading: wc.isLoading(),
    status: wc.isLoading() ? '加载中…' : '',
    // 当前页是一份"本来会被下载、被救回来显示"的文档（图片/视频/音频/PDF）
    // → 工具条显示「下载」按钮。
    media_doc: media ? { url: media.url, mime: media.mime, kind: media.kind } : null,
    // 页面里发起的下载（导出 CSV、点附件…）完成后的回执。下载结果页本身就在
    // 展示文件，再弹一条是重复信息，所以那里不显示。
    download: recentDownloadOf(tab, url),
  };
}

/** 8 秒内的"刚下载完"回执；超时就不再提示（不留一个永远挂着的角标）。 */
const RECENT_DOWNLOAD_MS = 8000;
function recentDownloadOf(tab, currentUrl) {
  if (mediaDoc.isChromePageUrl(currentUrl)) return null;
  try {
    const list = pageManager.downloadMonitor.list(tab).downloads || [];
    const last = list[list.length - 1];
    if (!last || last.state !== 'completed' || !last.finished_at) return null;
    const at = Date.parse(last.finished_at);
    if (!isFinite(at) || Date.now() - at > RECENT_DOWNLOAD_MS) return null;
    return { name: last.filename, path: last.path, size: last.total_bytes };
  } catch (_) {
    return null;
  }
}

/**
 * 图片缩略图（只在"这张图已经下载完"时生成）。
 *
 * 走 nativeImage 而不是让页面写 `<img src="file://…">`：file:// 页面对 file://
 * 子资源的访问在 Chromium 里并不保证，做成 data URL 则哪里都能显示。
 * 按路径缓存 —— 结果页每 500ms 轮询一次，不缓存就会反复解码同一张图。
 */
const thumbCache = new Map();
function thumbDataUrl(p) {
  if (!p) return null;
  if (thumbCache.has(p)) return thumbCache.get(p);
  let url = null;
  try {
    const img = nativeImage.createFromPath(p);
    if (img && !img.isEmpty()) {
      const size = img.getSize();
      const small = size.width > 480 ? img.resize({ width: 480, quality: 'good' }) : img;
      const jpg = small.toJPEG(72);
      if (jpg && jpg.length) url = 'data:image/jpeg;base64,' + jpg.toString('base64');
    }
  } catch (_) { url = null; }
  if (thumbCache.size > 16) thumbCache.clear();
  thumbCache.set(p, url);
  return url;
}

/** 把地址栏需要的一切状态推给 tab bar renderer。 */
function pushNavState() {
  // 标题先更新：它不依赖 tabBarView 是否存活（横幅/崩溃场景下 tabBarView
  // 可能已被销毁，但窗口标题仍应反映真实页面）。
  updateWindowTitle();
  // ⚠️ 这里曾经裸写 `tabBarView.webContents.isDestroyed()`：tabBarView 悬空时
  // （webContents 变 undefined）就抛异常，而本函数被 setInterval 每 1.5s 无条件
  // 调用 —— 于是每 1.5s 崩一次，累计 22 次 uncaught_exception（2026-10-30 白屏事故）。
  // 现在改为：先体检，死了就自愈重建，绝不裸访问。这次推送可以跳过（1.5s 后再来），
  // 重建完成后下一次自然会推到新视图上。
  const view = ensureTabBarAlive(false);
  if (!view) return;
  // 刚重建的视图 renderer 还在加载 tab_bar.html，此刻 executeJavaScript 会失败
  // （"Object has been destroyed" 或空上下文）—— 会被 .catch 接住不致命，但会往
  // stderr 刷一条没意义的错误。它加载完成后会自己 invoke('nav:state') 拉一次，
  // 所以加载中直接跳过本次推送即可，1.5s 后下一轮再推。
  try { if (view.webContents.isLoading()) return; } catch (_) { return; }
  const state = buildNavState();
  try {
    view.webContents.executeJavaScript(
      'window.__onNavState && window.__onNavState(' + JSON.stringify(state) + ')'
    ).catch(() => {});
  } catch (_) { /* 视图在这几毫秒内又失效：交给下一轮自愈 */ }
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
  applyAppIcon();
  createWindow();
  // 图标这条链的"实际状态"挂到 pageManager 上，由 ui.server_info 报出去 ——
  // "图标大小不对"否则只能靠肉眼比；有了 content_ratio 就能判定（期望 ≈0.867）。
  if (pageManager) pageManager.appIcon = appIconState;

  // === 自检钩子：AI_BROWSER_SELFTEST=crash ===
  // 主动制造一次主进程未捕获异常，用来验证"崩溃时的日志与横幅"这条链路真的通。
  // 没有它，这条链路只能等真事故发生才能验证 —— 而真事故发生的时候，恰恰是
  // 最不适合（也最没心情）做实验的时候。2026-10-17 就是因为这个空缺，用户看到
  // 一个"js 崩溃"框、事后却无从查证。
  //   AI_BROWSER_SELFTEST=crash node scripts/start.cjs
  //   AI_BROWSER_SELFTEST=crash-close node scripts/start.cjs   # 5 秒后自动收起
  // 默认走窗口内红色横幅（非阻塞）；要在崩溃处停下来用原生模态框，加
  // AI_BROWSER_ERROR_DIALOG=1（它阻塞主进程，只用于人工盯着看）。
  //
  // `crash-close` 存在的原因：收起横幅那条路（销毁视图 + 把让出去的 34px 还回去）
  // 没法从外面点 —— 它是个独立的 BrowserView，没有 WS 入口，而 macOS 上模拟点击
  // 需要辅助功能权限（实测被拒，-10004）。不测就等于把"横幅关不掉 / 关了以后
  // 底部一直空一条"这类问题留给用户。
  const _selftest = String(process.env.AI_BROWSER_SELFTEST || '');
  if (_selftest === 'crash' || _selftest === 'crash-close') {
    setTimeout(() => { throw new Error('selftest: injected uncaught exception'); }, 2000);
    if (_selftest === 'crash-close') {
      setTimeout(() => {
        hideErrorBanner();
        console.log('[selftest] error banner hidden — bottom inset restored');
      }, 5000);
    }
  }
  // 诊断开关（默认关闭）：主动把 tabBarView 的 webContents 置为悬空，用来复现
  // "标签栏渲染进程丢失后，pushNavState 每 1.5s 抛 Cannot read ... isDestroyed" 这一类崩溃。
  // 修复后这个开关必须能证明：不再抛异常、标签栏自动重建、横幅不会挂死。
  if (_selftest === 'chrome-gone') {
    setTimeout(() => {
      try {
        if (tabBarView && tabBarView.webContents) {
          tabBarView.webContents.close();
          console.log('[selftest:chrome-gone] tabBarView.webContents closed (simulated renderer loss)');
        }
      } catch (e) { console.log('[selftest:chrome-gone] close threw:', e.message); }
    }, 2000);
    // 5.5s 后自报体检结果：修复后应当是 ok（已被 ensureTabBarAlive 重建），
    // 而不是崩溃/悬空。这条输出是 e2e/lifecycle_ws.cjs 的判据之一。
    setTimeout(() => {
      try {
        console.log('[selftest:chrome-gone] tabBar liveness after heal = ' + liveness(tabBarView)
          + ' | rebuildCount=' + tabBarRebuildCount);
      } catch (e) { console.log('[selftest:chrome-gone] verify threw:', e.message); }
    }, 5500);
  }
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

// Chromium 默认在退出时**清除会话 cookie**（无过期时间的那些）。扫码/账密
// 登录产生的 JWT、SESSION 基本都是会话 cookie —— 于是 ai-browser 每次
// ui.quit / 关窗重启都掉登录态，agent 侧表现为"重启后站点又让我登录"。
// 退出前把它们逐个 set 成带远期过期时间的持久 cookie（值不变，只获得
// 落盘资格；服务端本来就认的是 value，本地过期时间不影响校验）。
// before-quit / window-all-closed / ui.quit 三条退出路径都经 cleanupAndQuit，
// 在那里先等这一步做完再真正 app.quit()。
async function persistSessionCookies() {
  try {
    const ses = session.fromPartition(config.viewPartition);
    const all = await ses.cookies.get({});
    const nowSec = Math.floor(Date.now() / 1000);
    const horizon = nowSec + 400 * 24 * 3600; // ~13 个月，长于任何服务端会话
    const isDurable = (c) => !!(c.expirationDate && c.expirationDate > nowSec + 7 * 24 * 3600);
    const todo = all.filter((c) => !isDurable(c));
    let n = 0;
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i];
      const host = (c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const details = {
        url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'),
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: horizon,
      };
      // 域 cookie（.example.com）要显式带 domain；host-only 的绝不能带，
      // 带了会从"仅本主机"放宽成"子域共享"，是安全隐患。
      if (c.domain && c.domain.startsWith('.')) details.domain = c.domain;
      if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite;
      try {
        await ses.cookies.set(details);
        n++;
      } catch (e) {
        console.error('[index] persist cookie failed:', c.name, e && e.message);
      }
      // 分批让出：Chromium 的 cookie store 是 grouped commit（几十毫秒一批），
      // 一口气把全部 set 发完，提交永远追不上 —— app.quit() 一到，没提交的
      // 全丢（实测 86 个 set 全部"成功"但磁盘只剩 2 个，2026-10-19）。
      // 每 10 个停 100ms，让每一批都有机会落盘。
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 100));
    }
    // 最后一组的 grouped commit 也要时间，等 2 秒再让 cleanupAndQuit 继续。
    if (n > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      console.log(`[index] persisted ${n} session cookies before quit`);
    }
  } catch (e) {
    console.error('[index] persistSessionCookies failed:', e && e.message);
  }
}

function cleanupAndQuit() {
  // cleanupStarted 防的是"多条退出路径同时触发"（ui.quit + window close +
  // before-quit 可能叠着来），它必须在第一次进入时就置位；isQuitting 只被
  // watchdog 等查询用。
  if (cleanupStarted) return;
  cleanupStarted = true;
  isQuitting = true;
  // 先固化会话 cookie，再走原有收尾。异步等完成（通常几百毫秒到几秒）——
  // 直接 app.quit() 会把还没提交的 cookies.set 全部打断，等于没固化。
  // 注意：finally 回来的这次调用不能被 cleanupStarted 挡掉（第一版就是
  // 这么写成死锁的 —— app.quit() 永远执行不到，app 退不掉），所以分流：
  // 固化中的重入走 _finishCleanup，其他重入直接忽略。
  if (!cookiePersistDone) {
    cookiePersistDone = true;
    persistSessionCookies()
      .catch(() => {})
      .finally(() => { _finishCleanup(); });
    return;
  }
  _finishCleanup();
}

// 真正的收尾 + app.quit()。与 cleanupAndQuit 分开，避免防重入标志把
// "固化完成后回来继续退出"这条必经之路也挡掉。
function _finishCleanup() {
  // 收尾行：日志里**没有** shutdown 行，就说明上一次是硬退（崩溃 / 被 kill）——
  // 这是事后判断"到底有没有崩过"最直接的依据。
  try { markShutdown('cleanup'); } catch {}
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
// before-quit 里 preventDefault：固化会话 cookie 是异步的（要等 cookies.set
// 分批提交完），不拦住默认退出流程的话窗口/视图先被拆，固化就写一半。
// cleanupStarted 之后的第二次 before-quit（我们自己 app.quit() 触发的）
// 不再拦截，直接放行。
app.on('before-quit', (e) => {
  if (cleanupStarted) return;
  e.preventDefault();
  cleanupAndQuit();
});
// main/page_manager.js — Multi-tab page lifecycle manager v2
// One Electron process, one WS server, multiple tabs.
// Agent routes via tab ID. Tab 0 is default.
import { ipcMain, BrowserView, nativeImage, webContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../shared/config.js';
import axExtractor from './axExtractor.js';
import { NetworkMonitor, MAX_POST_DATA_SIZE } from './network_monitor.js';
import { CanvasMonitor, isCanvasHookEnabled } from './canvas_monitor.js';
import { buildCanvasHookSource } from './canvas_hook_source.js';
// window.open("") + location 赋值模式的兼容垫片（主 world 源码，见文件头注释）
import { WINDOW_OPEN_SHIM_SOURCE } from './window_open_shim_source.js';
import { pickOpenedTab, openedTabGraceMs } from '../shared/opened_tab.js';
// 动作回执自带的"页面到底动没动"三态，以及 ref 过期诊断（两个纯函数模块）。
import { withEffectState, isTargetMiss as isTargetMissError } from '../shared/effect_state.js';
// 前后快照探针：动作返回 success 只证明"命令发出去了"，不证明"页面接住了"。
// 后者必须由掌握渲染进程的一侧给出（见 shared/page_probe.js 顶部事故说明）。
import pageProbe from '../shared/page_probe.js';
// 浏览器级对话框（alert / confirm / prompt / beforeunload）的策略。它们是
// Electron 画的原生 sheet，不在 DOM、不在 AX 树，而且**打开期间渲染器被阻塞**，
// 所以必须由主进程通过 CDP Page.handleJavaScriptDialog 应答 —— 见该模块头部说明。
import dialogPolicy from '../shared/dialog_policy.cjs';
// "你点的是容器"诊断：容器节点的 label 是从子孙文字拼出来的，点它往往什么都不发生。
// 见 shared/wrapper_hint.js 顶部（2026-10-25 知乎私信活动链接事故）。
import { wrapperHintExpr, wrapperHintText } from '../shared/wrapper_hint.js';
// 默认读法（DOM extractor）的"哪个 editable 才是正文"索引。AX 路径在
// normalizeAxTree 里已经自带，这条补的是默认路径 —— 见文件内注释。
import editorsProbe from '../shared/editors_probe.js';
import { newTracker, noteTree, diagnoseMissingRef } from '../shared/ref_epoch.js';
// "这一页到底画出来没有"的判定口径（纯函数）。此前没有任何检测覆盖"加载成功但
// 屏幕纯白"这一类 —— 见 shared/blank_page.cjs 顶部（2026-10-25 用户报百度白屏）。
import blankPage from '../shared/blank_page.cjs';
import { diffValues, previewOf, safeByteLength, DEFAULT_SNAPSHOT_JS, DIFF_MAX_ENTRIES, evictOldest } from './snapshot_diff.js';
import { withDeadline, actionDeadlineMs } from '../shared/deadline.js';
import { DownloadMonitor } from './download_monitor.js';
// 「这条主框架响应该显示还是该下载」的判据与接线（见 shared/media_doc.cjs 顶部：
// 2026-10-27 用户报"点证书下载 → 卡在正在打开… + 一坨 png URL"）。
import mediaDoc from '../shared/media_doc.cjs';
import { MediaInline } from './media_inline.js';
// 默认目标标签页的判据（explicit > session > active > first）与"新标签页要不要
// 切到人眼前"的策略。见 shared/tab_route.cjs 顶部（多 agent 并用的三条事故）。
import tabRoute, { shouldShowChildTab } from '../shared/tab_route.cjs';
import tabGroup from '../shared/tab_group.cjs';
import placeholder from '../shared/placeholder.cjs';
import { probeCapabilities } from './capability_probe.js';
import { buildAppModelSource, summarize as summarizeAppModel } from './app_model_source.js';
import valueContract from '../shared/value_contract.cjs';
// 输入成功与否的判定口径（纯函数，独立模块便于单测）。详见文件内注释：
// 富文本编辑器会把一个语义换行渲染成一串 \n，逐字比对会把成功的输入误判成失败。
import { normalizeInputText, skeletalInputText } from '../shared/input_verify.js';
// 截图参数规范化（纯函数）：坏参数在入口就给可读错误，不拖到 CDP 层。
import screenshotOpts from '../shared/screenshot_opts.cjs';
// 跨进程子帧（OOPIF）判定与自动路由回执（纯函数）：默认读法检测到不可读
// 子帧时自己补一次 AX 读取，调用方无需知道 ax:true 的存在。
import frameProbe from '../shared/frame_probe.cjs';
// 子帧内容读取器（在帧内执行）。选择器/上限/覆盖率口径全在那个文件里，
// 这里只负责把它喂进去 —— 采集规则不该散落在 page_manager 的字符串里。
import { buildFrameReadSource } from '../shared/frame_read_source.js';
// 文字覆盖率（纯函数）：树里的正文字数 / 页面上看得见的字数。"读到了"必须
// 是能算出来的结论，见 shared/doc_coverage.js 顶部的事故说明。
import docCoverage from '../shared/doc_coverage.js';
// ui.act target 形状体检（纯函数）：传了可见文字而不是 data-ai-id 时，
// 入口就给可操作的错误，而不是等到选择器查空才说 "Target not found"。
import refGuard from '../shared/ref_guard.cjs';
// 错误日志：导航失败（界面会显示错误页）必须落盘 —— load_failed 只是内存里的
// 一次广播，进程一退出就再也查不到"哪个 tab、哪个网址、什么错误码"。
import { recordError } from './error_log.js';
// navigate 的完成信号（commit | domcontentloaded | load）：默认不再是 load ——
// SPA 永不 fire load，把它当完成信号等于把"页面可用"报成"超时"。
import navWait from '../shared/nav_wait.cjs';
// 穿透影子根的 ref 查找（纯字符串构造，见 shared/find_ref.cjs 顶部注释）
import findRefUtil from '../shared/find_ref.cjs';
// 真正的焦点元素（穿透 shadow root）。`document.activeElement` 在 Web Component
// 里只到宿主为止，用它做输入校验会读到空串，把"已打进去"报成"没打进去"。
import deepActiveUtil from '../shared/deep_active.cjs';
// 悬停前后语义树的差异（ui.peek）。数据源是 DOM 语义树而不是 AX 树，理由与两条
// 实测证据都写在 shared/tree_diff.cjs 顶部。
import treeDiff from '../shared/tree_diff.cjs';
// 按键派发计划（纯函数）：rawKeyDown 不产生 keypress，Enter 的默认动作会落空。
import keyDispatchUtil from '../shared/key_dispatch.cjs';
// 命中探测（穿透影子根）。`document.elementFromPoint` 不跨 shadow boundary，
// 对影子内部的元素恒返回宿主 —— 于是"点击前证明坐标会落在目标上"这道校验
// 恒为假，点击只能降级成非受信的 el.click()。详见 shared/hit_point.cjs 顶部。
import hitPointUtil from '../shared/hit_point.cjs';

const { expandValueFetchTree } = valueContract;
const deepActiveExpr = deepActiveUtil.deepActiveExpr;
const keyDispatchPlan = keyDispatchUtil.keyDispatchPlan;
const { hitTestExpr, hitInfoExpr, deepHitExpr } = hitPointUtil;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 穿透影子根的 ref 查找（返回自包含 JS 表达式，可原地替换 document.querySelector）。
// 实现与理由见 src/shared/find_ref.cjs —— 那里的注释解释了为什么查询必须穿 shadow
// boundary，以及为什么返回"表达式字符串"而不是"运行时函数"。
const findRefExpr = findRefUtil.findRefExpr;
const findDescExpr = findRefUtil.findDescExpr;


// canvas 绘制调用记录：默认开。关闭开关 AI_BROWSER_CANVAS_HOOK=0。
const CANVAS_BRIDGE_KEY = '__aiCanvasBridge';

// 网络抓包默认开：只在有订阅时才启用会导致首屏/导航阶段的请求全丢（POST body、
// 请求头都拿不到）。关闭开关：AI_BROWSER_NETWORK_CAPTURE=0。
const NETWORK_CAPTURE_DEFAULT = !(process.env.AI_BROWSER_NETWORK_CAPTURE === '0' || process.env.AI_BROWSER_NETWORK_CAPTURE === 'false');

// window.open("") 派生 tab 的"等垫片再导航"上限。超过就照常导航（退化成
// 该 tab 没有垫片），页面绝不能因为垫片安装慢而永久空白。
// 实测正常路径约 120–300ms（about:blank 的 did-finish-load + 两次 CDP 命令）。
const WINDOW_OPEN_NAV_WAIT_MS = 2000;

// 具名按键 → CDP Input.dispatchKeyEvent 参数。agent 用自然名字（'Delete'、
// 'Escape'、'ArrowRight'、'a'）而不是让人去查 Windows 虚拟键码。
// vk 用 Windows 虚拟键码（Chromium 在 macOS 上也按它解释）。
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Minus: { key: '-', code: 'Minus', vk: 189 },
  Equal: { key: '=', code: 'Equal', vk: 187 },
  '0': { key: '0', code: 'Digit0', vk: 48 },
  '1': { key: '1', code: 'Digit1', vk: 49 },
  '2': { key: '2', code: 'Digit2', vk: 50 },
  '3': { key: '3', code: 'Digit3', vk: 51 },
  '4': { key: '4', code: 'Digit4', vk: 52 },
  '5': { key: '5', code: 'Digit5', vk: 53 },
};

// 修饰键 → CDP modifiers 位掩码（Alt=1, Ctrl=2, Meta=4, Shift=8）。
function modifierMask(modifiers) {
  let m = 0;
  for (const k of modifiers || []) {
    const s = String(k).toLowerCase();
    if (s === 'alt' || s === 'option') m |= 1;
    else if (s === 'control' || s === 'ctrl') m |= 2;
    else if (s === 'meta' || s === 'cmd' || s === 'command') m |= 4;
    else if (s === 'shift') m |= 8;
  }
  return m;
}

/**
 * 解析一个按键名到 _cdpKey 需要的参数。支持具名键、单字符（字母/数字/符号）、
 * 以及 'Shift+Delete' / 'Meta+a' / 'Control+ArrowRight' 这类组合写法。
 * 返回 null 表示无法识别 —— 调用方报错，不静默发一个错误按键。
 */
function keySpec(name, extraModifiers) {
  const raw = String(name == null ? '' : name);
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const baseName = parts.length ? parts[parts.length - 1] : raw;
  const combos = parts.slice(0, -1);
  let mod = modifierMask([...(extraModifiers || []), ...combos]);

  let spec = NAMED_KEYS[baseName] || null;
  if (!spec && /^[a-zA-Z]$/.test(baseName)) {
    const up = baseName.toUpperCase();
    // key 用调用方给的大小写（'a' → 'a'），code 永远指物理键（'KeyA'）。
    // 曾经写成 `key: baseName !== up ? up : baseName` —— 对任何小写字母
    // baseName 都 !== 其大写，于是 'a' 被发成 'A'，页面 keydown 里读到的全是大写。
    spec = { key: baseName, code: 'Key' + up, vk: up.charCodeAt(0) };
    if (baseName === up) mod |= 8; // 大写字母本身意味着 Shift 按下
  }
  if (!spec && baseName.length === 1) {
    spec = { key: baseName, code: '', vk: baseName.toUpperCase().charCodeAt(0), text: baseName };
  }
  if (!spec) return null;
  // 真实浏览器在 Shift 按下时，字母键报的是大写 key。对齐它，否则页面里的
  // 快捷键判断（e.key === 'A'）会失灵。
  let key = spec.key;
  if ((mod & 8) && /^[a-z]$/.test(key)) key = key.toUpperCase();
  return { ...spec, key, mod };
}

class PageManager {
  constructor(browserWindow) {
    this.window = browserWindow;
    this.tabs = new Map();       // tabId -> BrowserView
    this.activeTab = null;
    // 启动时那一个标签页。它存在的唯一用途是判断"人眼前这一页是不是还没人动过"：
    // 是的话，agent 开的第一个标签页可以直接顶上去（否则用户会盯着百度首页，
    // 以为 agent 什么都没干）。见 shared/tab_route.cjs 的 shouldShowNewTab。
    this.startupTab = null;
    this.tabCounter = 0;
    // 窗口首次显示时的那一刻状态（tab / body_len / ready_state）。
    // 白屏类缺陷的根因是"窗口显示了但渲染器还没画出第一帧"，而这只能从窗口侧
    // 观测 —— WS 端口在 createWindow 中途就开了，比 showInitialWindow 早。
    // 由 index.js 的 showInitialWindow 填写，ui.window_shown 读取。
    this.windowShownAt = null;
    this.subscriptions = new Map();
    this._pendingRequests = new Map();
    this._requestId = 0;
    this._wsClients = new Map();
    // sessionId -> tabId：**这个连接自己的工作标签页**。
    //
    // 为什么必须有（2026-10-27 多 agent 并用）：默认目标以前是全局 activeTab，
    // 也就是"人眼看的那一页"。多个 agent 同时干活时它立刻崩掉 —— A 开一个标签页，
    // 所有人的默认目标都变成它；B 说"点提交"，点在 A 的页面上。判据与优先级见
    // shared/tab_route.cjs（explicit > session > active > first）。
    this._sessionTab = new Map();
    // ---- 标签页归属（人的一组，每个 agent 一组）----
    //
    // 为什么需要它：会话级目标解决了"动作落在哪一页"，但标签条上仍然是一锅粥 ——
    // 人看不出哪些页是自己的、哪些是哪个 agent 的；也没有任何东西**约束** agent
    // 开页面的数量，一个跑长任务的 agent 能悄悄开二十个，内存被无声吃掉。
    // 归属同时承担三件事：标签栏怎么归拢、上限算谁的、人点开 agent 的页只是"看"。
    this._tabGroup = new Map();     // tabId -> groupId
    this._groups = new Map();       // groupId -> { id, kind, label, color, limit, createdAt }
    this._tabUsedAt = new Map();    // tabId -> 最后一次被导航/动作的时间（LRU 淘汰用）
    this._groupSeq = 0;             // 组编号（Agent 1 / Agent 2 …）
    this.evictions = [];            // 被上限挤掉的标签页（最多 20 条，ui.list_tabs 回采后清空）
    this._openedTabs = new Map();   // sourceTabId -> { id, url } (new tab opened by window.open)
    this._windowOpenTokens = new Map(); // token -> { tabId, sourceTabId } (window.open shim, preload bridge.cjs)
    this._windowOpenShimTabs = new Set(); // 已注入 window.open 垫片的 tabId
    // tabId -> Promise<void>：该 tab 的垫片**注册完成**的信号（不是"注入成功"，
    // 失败也 resolve —— 调用方要的是"可以往下走了"，不是"一切顺利"）。
    // 存在的唯一理由：window.open("") 派生的 tab 里，ai:window_open_nav 必须等
    // 垫片登记完再导航，否则真实文档先到、垫片只对"下一次文档"生效，那个 tab
    // 就成了没有垫片的窗中窗（见 newTab 末尾长注释）。
    this._windowOpenShimReady = new Map();
    // tabId -> 'pending' | 'loading' | 'ready' | 'blank'：这个 tab 现在处于导航的
    // 哪一步。存在的理由：新 tab 在占位页（原先是纯白 about:blank）停留时，
    // 光看 URL 分不清"正在加载"和"卡住了/开错了"。listTabs 把它报出去，
    // agent 才知道该等而不是该重试。
    this._tabNavState = new Map();
    // tabId -> 最近一次被处理掉的 JS 对话框：{type, message, accept, promptText,
    // auto, at}。回执里带上它，agent 才知道"刚才那个动作中间弹了个确认框，
    // 我替你按了确定"—— 否则它会以为点击之后什么都没发生。
    this._lastDialog = new Map();
    // 已挂上"对话框监听"的 tab（每个 tab 一次；Page.enable 是幂等的）
    this._dialogWatched = new Set();
    // tabId -> 当前**仍然打开**的对话框（manual 策略下会长期存在）
    this._openDialogs = new Map();
    this._axDiffCache = new Map();  // tabId -> lite interactive snapshot (get_tree {mode:'diff'})
    this._repaintTimers = new Map();// tabId -> 正在排队/已调度的重绘（合并同一批导航事件）
    // 重绘计数：soft = 只 invalidate；hard = 额外 1px 微调（会重排两次，肉眼可见）。
    // 高频路径（导航完成/窗口焦点）只许走 soft —— 这条要被回归钉住。
    this._repaintCount = 0;
    this._hardRepaintCount = 0;
    // === 白屏自检（paint audit）===
    // tabId -> {verdict, blank, white_ratio, unique, action, at, url}：最近一次自检的结论。
    // 为什么必须有它：白屏是唯一一种"所有事件都成功、DOM 也正常、但用户看到的是空"的
    // 失败形态，没有观测就只能靠人截图喊"白的"。有了它，list_tabs / paint_check
    // 能把"这一页画出来了没有"当成一个可查询的事实。
    this._paintState = new Map();
    // tabId -> 本轮已经执行过几步补救（0=还没救过）。一有新的导航就清零，
    // 所以"救不动"不会变成跨页面的永久状态。
    this._paintSteps = new Map();
    this._paintTimers = new Map();  // tabId -> 排队中的自检（合并 dom-ready/finish-load 的连发）
    // tabId -> 正在跑的那一轮自检的 Promise。并发调用共享同一个 Promise，
    // 而不是"发现有人在跑就返回 null"（那会让调用方拿到一个空结论）。
    this._paintAuditInflight = new Map();
    // 白屏自检的总开关。默认开；关掉它的唯一场景是"我要精确测量导航时延"。
    this._paintAuditEnabled = process.env.AI_BROWSER_PAINT_AUDIT !== '0';
    // 自己发起的 reload（自救用）。用它区分"这次 did-finish-load 是我们的补救"
    // 还是"用户/页面自己导航了"—— 前者必须保留补救步数，否则会无限重载。
    this._paintSelfReload = new Set();
    // tabId -> 上次因渲染进程崩溃而重载的时刻（见 _attachCrashRecovery 的 15s 上限）
    this._crashReloadAt = new Map();
    this._snapshots = new Map();    // snapshotId -> { tabId, js, value, at }（ui.snapshot 存基线）
    this._snapshotSeq = 0;
    this.networkMonitor = new NetworkMonitor({}, { captureEnabled: NETWORK_CAPTURE_DEFAULT });
    this.canvasMonitor = new CanvasMonitor();
    this._canvasBindings = new Map(); // bindingName -> tabId（hook 回传时据此归 tab）
    // 下载：此前 src/ 里没有任何 will-download 处理器，Electron 默认**取消**下载 ——
    // agent 点"导出 CSV"拿到 success，然后什么都没有，连错误都没有。
    this.downloadMonitor = new DownloadMonitor(null, {
      broadcast: (type, data) => this._broadcast(type, data),
      // 下载一开始就要接手"为它而开的那个标签页"，等 done 再处理的话，
      // 用户会先盯着「正在打开…」看几秒（大文件是几分钟）—— 那正是要消灭的症状。
      onStart: (rec, tabId) => this._onDownloadStarted(rec, tabId),
    });
    this.downloadMonitor._resolveTab = (wc) => this._tabIdOfWebContents(wc);
    // 可渲染的主框架文档（图片/音视频/PDF）即使服务端挂了 attachment，也按内容
    // 类型显示，而不是丢进下载目录 —— 判据与理由见 shared/media_doc.cjs。
    this.mediaInline = new MediaInline({
      resolveTab: (wcId) => {
        try { return this._tabIdOfWebContents(webContents.fromId(wcId)); } catch (_) { return undefined; }
      },
      onMedia: (rec) => this._broadcast('media_doc', rec),
    });
    this._setupPermissions();
    this._setupIPC();
  }

  /**
   * 权限请求白名单。
   *
   * 不装这个处理器时，Electron 对每个请求都**静默拒绝**。后果与下载一样隐蔽：
   * 站点要 pointerLock / clipboard 写入才能继续，agent 完全看不出是被权限挡住。
   *
   * 默认只放行"不碰用户隐私、且 agent 确实需要"的几项：
   *   pointerLock            画布类应用常用，无隐私面
   *   clipboard-sanitized-write  "复制"按钮要它能用（写入是 sanititized 的，读不放）
   *   fullscreen             演示/看图常用，无隐私面
   *   localStorage/sessionStorage 等存储类（Chromium 已默认允许，列出来只为显式）
   * 摄像头/麦克风/定位**不放**：那是隐私面，应由人主动决定。
   * 覆盖：AI_BROWSER_PERMISSIONS="midi,geolocation"（追加）或 "*"（全放，慎用）。
   *
   * 拒绝也广播一条事件：否则 agent 无法区分"站点没这功能"和"被权限挡住"。
   */
  _setupPermissions() {
    const DEFAULT_ALLOW = ['pointerLock', 'clipboard-sanitized-write', 'fullscreen'];
    const raw = process.env.AI_BROWSER_PERMISSIONS;
    const allow = raw === '*' ? null : (raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOW);
    const allowed = (p) => (allow === null ? true : allow.indexOf(p) >= 0);
    this._permissionAllow = allow;
    this._onPermission = (webContents, permission, callback) => {
      if (allowed(permission)) return callback(true);
      const tid = this._tabIdOfWebContents(webContents);
      this._broadcast('permission_denied', {
        tab: tid,
        permission,
        hint: 'grant it with AI_BROWSER_PERMISSIONS="' + permission + '" or "*", or ask the user to allow it in the window',
      });
      callback(false);
    };
    this._installPermissionHandler();
  }

  _installPermissionHandler() {
    try {
      // 延迟到 app ready 之后由 index.js 调 installSessionHooks(session)；
      // 这里只存回调，避免在模块加载期碰 Electron session（vitest 起不来）。
      if (this._session) this._session.setPermissionRequestHandler(this._onPermission);
    } catch (_) { /* 无 session（单测/非 Electron 环境） */ }
  }

  installSessionHooks(session) {
    this._session = session;
    this.downloadMonitor.session = session;
    this.downloadMonitor.install();
    // 与 will-download / 权限钩子同一条 session（见 config.viewPartition 的注释：
    // 装错 session 的后果是"什么都没发生"）。
    // AI_BROWSER_MEDIA_INLINE=0 关掉它 → 回到"图片也被当文件下载"的旧行为，
    // 用于二分"某站点的显示问题是不是这条钩子造成的"。
    if (process.env.AI_BROWSER_MEDIA_INLINE !== '0') this.mediaInline.install(session);
    this._installPermissionHandler();
  }

  /** webContents → tabId。找不到返回 undefined（调用方各自决定怎么兜底）。 */
  _tabIdOfWebContents(webContents) {
    if (!webContents) return undefined;
    for (const [tid, view] of this.tabs) {
      if (view && view.webContents === webContents) return tid;
    }
    return undefined;
  }

  static _instance = null;
  static getInstance(browserWindow) {
    if (!PageManager._instance) PageManager._instance = new PageManager(browserWindow);
    return PageManager._instance;
  }

  _setupIPC() {
    const self = this;
    // Match by request id — robust under concurrent requests / multi-tab.
    // FIFO broke when getTree/executeAction/evaluate raced: the first response
    // resolved whichever pending promise happened to be first in the map,
    // not the one that actually triggered it.
    ipcMain.on('ai:tree', (_event, payload) => {
      const id = payload && payload.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        pending.resolve(payload);
      }
    });

    ipcMain.on('ai:action_result', (_event, result) => {
      const id = result && result.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        // Strip routing id from the payload before resolving.
        const { id: _drop, ...clean } = result;
        pending.resolve(clean);
      }
    });

    ipcMain.on('ai:evaluate_result', (_event, result) => {
      const id = result && result.id;
      const pending = (id !== undefined) ? self._pendingRequests.get(id) : null;
      if (pending) {
        self._pendingRequests.delete(id);
        if (result.error) pending.reject(new Error(result.error));
        else pending.resolve(result.value);
      }
    });

    ipcMain.on('ai:diff', (_event, changes) => {
      this._broadcast('dom_change', { changes });
    });

    ipcMain.on('ai:event', (_event, payload) => {
      // Tag events with active tab
      this._broadcast(payload.event, payload.data || {});
    });

    // === window.open 垫片的主进程侧（见 preload/bridge.cjs 的注释）===
    // 站点模式：window.open("", "_blank") 先开空窗口，再把 location 赋成
    // 真实地址。setWindowOpenHandler 那条路给不了页面可用的 window 引用
    // （deny 后 window.open 返回 null），所以页面侧改为走这两条 IPC：
    // ai:window_open 建真实 tab（空 url → about:blank 占位），
    // ai:window_open_nav 把 location 赋值翻译成对该 tab 的导航。
    // 同 sender 的 IPC 保序，nav 到达时 tab 必已建好。
    ipcMain.on('ai:window_open', (_event, payload) => {
      const p = payload || {};
      const token = p.token;
      if (!token) return;
      const sourceTabId = this._tabIdForContents(_event.sender);
      const url = typeof p.url === 'string' ? p.url : '';
      // Bug 1 修复：setWindowOpenHandler 那条路（v2.3.0 已补 group + show）之后，
      // window.open 的真正生效路径是这条 IPC（垫片主 world -> bridge -> IPC），
      // 这边此前漏掉 opts。现在两条路必须行为一致：
      //   - group：派生 tab 跟 opening 者走（agent 后台页弹窗仍进 agent 组，而不是人组）
      //   - show：opener 是后台页时不显示（登录/预览/下载弹窗不抢视野）
      const parentGroup = sourceTabId !== null ? this.groupOfTab(sourceTabId) : tabGroup.HUMAN_GROUP;
      const show = shouldShowChildTab({ openerIsVisible: sourceTabId !== null && sourceTabId === this.activeTab });
      // 弹窗把组撑满时不能拒绝（站点的脚本在等这个窗口），只能牺牲一页：
      // 最久没用、不在人眼前、没有挂着对话框的那一页。
      if (!this.canOpenInGroup(parentGroup).allowed) {
        const victim = this.pickEvictableInGroup(parentGroup, sourceTabId);
        if (victim !== null) {
          const deadUrl = (this._getView(victim) || {}).webContents
            ? this._getView(victim).webContents.getURL() : '';
          this.evictions.push({ tab: victim, url: deadUrl, at: Date.now(), reason: 'group-full' });
          if (this.evictions.length > 20) this.evictions.shift();
          this.closeTab(victim);
        }
      }
      const childId = this.newTab(url && url !== 'about:blank' ? url : null, { show, group: parentGroup });
      this._windowOpenTokens.set(token, { tabId: childId, sourceTabId });
      // 与 setWindowOpenHandler 路径共用 _openedTabs：executeAction 的
      // auto-follow（点击后 Agent 视角跟到新 tab）对两种打开方式一致。
      if (sourceTabId !== null) {
        this._openedTabs.set(sourceTabId, { id: childId, at: Date.now(), url: url || 'about:blank' });
      }
    });

    ipcMain.on('ai:window_open_nav', (_event, payload) => {
      const p = payload || {};
      const entry = this._windowOpenTokens.get(p.token);
      const url = typeof p.url === 'string' ? p.url : '';
      if (!entry || !url) return;
      const nav = () => {
        const view = this._getView(entry.tabId);
        if (!view) {
          // tab 已被用户/Agent 关掉：赋值静默丢弃（真实浏览器里关掉的
          // 窗口被赋 location 也是无人接收）。
          console.warn('[window_open] nav target tab gone:', entry.tabId, url);
          return;
        }
        // loadURL 的 rejection 由页面自身处理（站点可能会立刻再导航一次），
        // 这里只防 unhandled。
        view.webContents.loadURL(url).catch(() => {});
      };
      // ⚠️ **必须等垫片登记完再导航**（2026-10-20 修，超星"进入学习"第二层）。
      //
      // 原来这里直接 loadURL。看上去时序够用（站点 ajax 往返几十毫秒，
      // 而 about:blank 的 did-finish-load 通常更早），但那是**赌**：
      // 只要 nav 抢在 did-finish-load 之前到达，真实文档就先把 renderer 占住，
      // 随后 addScriptToEvaluateOnNewDocument 只对"下一次文档"生效 ——
      // 新 tab 里 window.open 是原生实现，站点再走一次
      // `window.open("") + w.location = url` 就得到 null，静默不跳转。
      // 实测（2026-10-20）：列表页的"进入学习"能开，新 tab 的 shim 是 false。
      const ready = this._windowOpenShimReady.get(entry.tabId);
      if (!ready) { nav(); return; }   // 老路径/测试桩：没有信号就直接走
      let timer = null;
      const cap = new Promise((resolve) => {
        timer = setTimeout(resolve, WINDOW_OPEN_NAV_WAIT_MS);
        if (timer.unref) timer.unref();
      });
      Promise.race([ready, cap]).then(() => {
        if (timer) clearTimeout(timer);
        nav();
      }, () => {
        if (timer) clearTimeout(timer);
        nav();
      });
    });

    ipcMain.on('ai:window_open_close', (_event, payload) => {
      const token = (payload || {}).token;
      const entry = this._windowOpenTokens.get(token);
      if (!entry) return;
      this._windowOpenTokens.delete(token);
      if (this._getView(entry.tabId)) this.closeTab(entry.tabId);
    });
  }

  // webContents -> tabId 反查。window.open 垫片需要知道是哪个 tab 发起的
  // （记 _openedTabs 供 auto-follow 用）；ipc-message 的 sender 就是发起
  // tab 的 webContents。
  _tabIdForContents(wc) {
    if (!wc) return null;
    for (const [tid, view] of this.tabs) {
      if (view && view.webContents === wc) return tid;
    }
    return null;
  }

  _broadcast(eventType, data) {
    for (const [sessionId, eventTypes] of this.subscriptions) {
      if (eventTypes.has(eventType) || eventTypes.has('*')) {
        const ws = this._wsClients.get(sessionId);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: eventType, params: data }));
        }
      }
    }
  }

  registerClient(sessionId, ws) {
    this._wsClients.set(sessionId, ws);
  }

  /**
   * 把这个连接"自己的工作标签页"记下来。
   * 断开连接时**不关页面**：agent 进程退出后，人可能正想看看它干到哪了。
   */
  // ---- 标签页归属 ----------------------------------------------------------
  //
  // 组 id 有两条来源：HUMAN_GROUP（人点「+」、启动页、人点链接派生出来的页）
  // 和 groupIdForSession(sessionId)（一个 agent 连接一组）。
  // 一个组没有标签页了就删掉 —— 否则标签栏会积一堆空的分组。

  /** 建（或取）一个 agent 的组。label 是给人看的（"Agent 2" / 客户端名）。 */
  ensureGroup(sessionId, label, opts) {
    const id = tabGroup.groupIdForSession(sessionId);
    let g = this._groups.get(id);
    if (!g) {
      this._groupSeq += 1;
      g = {
        id,
        kind: 'agent',
        label: String(label || '').trim().slice(0, 24) || ('Agent ' + this._groupSeq),
        // 颜色按组的诞生顺序取，不按 sessionId 哈希：人记的是"紫色的那个"，
        // 哈希出来每组都可能撞色。
        color: tabGroup.colorFor(this._groupSeq - 1),
        limit: tabGroup.limitFromEnv(process.env),
        // capped = 这个组受限额约束。只有**声明过自己是 agent** 的连接才有
        // （ui.hello）；裸 WS（e2e / 脚本 / 调试）拿到组只是为了让标签页有归属，
        // 不受限 —— 否则一次性开二十个标签的回归套件会突然报 group-full。
        capped: false,
        createdAt: Date.now(),
      };
      this._groups.set(id, g);
    } else if (label) {
      g.label = String(label).trim().slice(0, 24) || g.label;
    }
    if (opts && opts.capped === true) g.capped = true;
    return g;
  }

  groupOfTab(tabId) {
    return this._tabGroup.get(tabId) || tabGroup.HUMAN_GROUP;
  }

  groupMeta(groupId) {
    const id = groupId || tabGroup.HUMAN_GROUP;
    if (id === tabGroup.HUMAN_GROUP) {
      return { id, kind: 'human', label: '我的标签页', color: null, limit: null };
    }
    return this._groups.get(id) || { id, kind: 'agent', label: id, color: null, limit: null };
  }

  /** 组里还有哪些页（按 tabId 升序 = 创建顺序）。 */
  tabsInGroup(groupId) {
    const out = [];
    for (const [id] of this.tabs) {
      if (this.groupOfTab(id) === groupId) {
        out.push({
          id,
          url: this.tabs.get(id).webContents.getURL(),
          usedAt: this._tabUsedAt.get(id) || 0,
          dialog: this._openDialogs.has(id) ? true : undefined,
        });
      }
    }
    return out;
  }

  /** 这个组还能不能再开一页。 */
  canOpenInGroup(groupId) {
    const meta = this.groupMeta(groupId);
    // 没被标记 capped 的组（裸 WS / 脚本拿到的组）不限量：组只是个归属标签。
    if (meta.capped !== true) return { allowed: true, count: this.tabsInGroup(groupId).length, limit: null, remaining: null };
    return tabGroup.decideOpen({
      group: groupId,
      count: this.tabsInGroup(groupId).length,
      limit: meta.limit,
    });
  }

  /** 组满时的牺牲品：最久没用、不在看、没有等人点的对话框。没有就返回 null。 */
  pickEvictableInGroup(groupId, exceptTabId) {
    const meta = this.groupMeta(groupId);
    if (tabGroup.isHumanGroup(groupId)) return null;
    if (meta.capped !== true) return null;   // 不受限的组永远不需要牺牲谁
    if (meta.limit && this.tabsInGroup(groupId).length < meta.limit) return null;
    return tabGroup.pickEvictable({
      tabs: this.tabsInGroup(groupId),
      except: exceptTabId,
      activeTab: this.activeTab,
    });
  }

  /**
   * 记录"这一页刚被用过"，供 LRU 淘汰排序。
   * 只在导航/动作这类**作用于页面**的地方调：读一次树不算用过，
   * 否则 agent 循环读树会让真正在用的页被判定为"新"，反而淘汰掉该留的。
   */
  touchTab(tabId) {
    if (tabId === undefined || tabId === null) return;
    this._tabUsedAt.set(tabId, Date.now());
  }

  /** 标签栏/接口用的分组清单（空组已在上面的清理里去掉，这里再滤一遍保险）。 */
  listGroups() {
    const out = [];
    for (const [gid, meta] of this._groups) {
      const tabs = this.tabsInGroup(gid);
      if (!tabs.length) continue;
      out.push({ ...meta, count: tabs.length });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  _forgetTab(tabId) {
    const gid = this._tabGroup.get(tabId);
    this._tabGroup.delete(tabId);
    this._tabUsedAt.delete(tabId);
    if (!gid || gid === tabGroup.HUMAN_GROUP) return;
    // 组空了就删：留在 Map 里会让标签栏出现一个 0 页的分组，下次同名 agent
    // 重连还会复用那个组的编号/颜色，看起来像"上一轮的残留"。
    if (!this.tabsInGroup(gid).length) this._groups.delete(gid);
  }

  /** 把一页挪进某个组（人"接手" agent 的页 / 反向都走这条）。 */
  moveToGroup(tabId, groupId) {
    if (!this.tabs.has(tabId)) return false;
    this._tabGroup.set(tabId, groupId || tabGroup.HUMAN_GROUP);
    return true;
  }

  bindSessionTab(sessionId, tabId) {
    if (!sessionId) return;
    if (tabId === undefined || tabId === null) this._sessionTab.delete(sessionId);
    else this._sessionTab.set(sessionId, tabId);
  }

  sessionTabOf(sessionId) {
    if (!sessionId) return null;
    const t = this._sessionTab.get(sessionId);
    return t === undefined ? null : t;
  }

  /**
   * 这次调用操作哪个标签页。判据只有 shared/tab_route.cjs 一处，这里只把
   * "当前有哪些标签页"和"人眼看的是哪个"喂给它。
   * 返回 {tab, source, error?}：error 存在时调用方必须**报错**，不许就近挑一个。
   */
  resolveTargetTab({ explicit, sessionId } = {}) {
    return tabRoute.resolveTarget({
      explicit,
      session: this.sessionTabOf(sessionId),
      active: this.activeTab,
      tabs: Array.from(this.tabs.keys()),
    });
  }

  unregisterClient(sessionId) {
    this._wsClients.delete(sessionId);
    this.subscriptions.delete(sessionId);
    this._sessionTab.delete(sessionId);
  }

  _layoutAllViews(bounds) {
    // `_bottomInset`：窗口底部被别的东西占掉的高度（目前只有主进程异常横幅）。
    // 由 index.js 设置、这里统一扣减 —— 让每个"给视图定尺寸"的地方各自记住
    // 这 34px 必然会漏掉一处（新建 tab 走的是 _layoutView，不是这里）。
    const inset = this._bottomInset || 0;
    for (const [id, view] of this.tabs) {
      view.setBounds({
        x: 0,
        y: config.tabBarHeight,
        width: bounds.width,
        height: Math.max(0, bounds.height - config.tabBarHeight - inset),
      });
    }
  }

  // === Tab management ===

  _getView(tabId) {
    return this.tabs.get(tabId);
  }

  // ==================================================================
  // Snapshot / Diff — make "act → read back → compare" a one-liner
  // ==================================================================
  //
  // Why this exists: the project's hard rule is that a write is only proven by
  // reading state back and comparing. Doing that by hand meant rewriting bespoke
  // comparison JS on every site (node counts, widget values, positions, edge
  // lists…), which is exactly where mistakes creep in — this session I twice
  // measured the wrong thing (serialized byte length, viewport deltas) and got
  // a confident false reading.
  //
  // Contract, deliberately narrow:
  //   ui.snapshot {js?, label?} → evaluate js (default: a site-agnostic
  //                                structural DOM summary), store, return id.
  //   ui.diff {snapshot, js?}   → re-evaluate and return a STRUCTURED diff:
  //                                added / removed / changed, each with a JSON
  //                                path and both values, so "it changed" is
  //                                provable rather than asserted.

  /**
   * Collect a snapshot value. `js` must be a JSON-serializable expression.
   * When omitted we use a structural DOM summary (role/label/value per element
   * at a stable path) — the most broadly useful default, needing no per-site
   * knowledge, which is the whole point of having a default.
   */
  async _collectSnapshot(js, tabId) {
    const tid = tabId !== undefined && tabId !== null ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { error: 'no-such-tab', tab: tid };
    const expr = js && String(js).trim() ? String(js) : DEFAULT_SNAPSHOT_JS;
    let value;
    try {
      value = await this.evaluate(expr, tid);
    } catch (e) {
      return { error: 'evaluate-failed: ' + (e && e.message ? e.message : String(e)), tab: tid };
    }
    if (value && typeof value === 'object' && value.__error) {
      return { error: 'snapshot-expression-threw: ' + value.__error, tab: tid };
    }
    return { tab: tid, value };
  }

  async snapshot(params = {}) {
    const tid = params.tab !== undefined && params.tab !== null ? params.tab : this.activeTab;
    const r = await this._collectSnapshot(params.js, tid);
    if (r.error) return { ok: false, error: r.error, tab: r.tab };
    const id = 'snap-' + (++this._snapshotSeq);
    const entry = { tab: tid, js: params.js || null, value: r.value, at: new Date().toISOString() };
    this._snapshots.set(id, entry);
    this._evictSnapshots();
    return {
      ok: true,
      snapshot: id,
      tab: tid,
      at: entry.at,
      label: params.label || null,
      bytes: safeByteLength(r.value),
      // Short preview so the caller can confirm it snapshotted what they meant,
      // without a second round-trip.
      preview: previewOf(r.value),
    };
  }

  async diff(params = {}) {
    const id = params.snapshot;
    if (!id) return { ok: false, error: 'missing-snapshot', hint: 'call ui.snapshot first, pass its id here' };
    const base = this._snapshots.get(id);
    if (!base) return { ok: false, error: 'unknown-snapshot', snapshot: id };
    // A snapshot is bound to the tab it came from: diffing across tabs would
    // compare unrelated pages and report a wall of spurious changes.
    const tid = params.tab !== undefined && params.tab !== null ? params.tab : base.tab;
    if (tid !== base.tab) {
      return { ok: false, error: 'tab-mismatch', snapshot: id, snapshot_tab: base.tab, requested_tab: tid };
    }
    const now = await this._collectSnapshot(params.js || base.js, tid);
    if (now.error) return { ok: false, error: now.error, tab: tid };

    const d = diffValues(base.value, now.value);
    const result = {
      ok: true,
      snapshot: id,
      tab: tid,
      changed: d.hasChanges,
      // An explicit verdict so callers never have to infer "nothing happened"
      // from an array they might have built wrong.
      verdict: d.hasChanges ? 'changed' : 'unchanged',
      counts: { added: d.added.length, removed: d.removed.length, changed: d.changed.length },
      added: d.added,
      removed: d.removed,
      changed_paths: d.changed,
      truncation: d.dropped ? { limit: DIFF_MAX_ENTRIES, dropped: d.dropped } : null,
    };
    // Chaining: re-arm the baseline so a caller can loop "assert no change"
    // over many steps without re-snapshotting each time.
    if (params.rearm) {
      this._snapshots.set(id, { ...base, value: now.value, at: new Date().toISOString() });
      result.rearmed = true;
    }
    if (params.forget) { this._snapshots.delete(id); result.forgotten = true; }
    // Touch: Map iteration order is insertion order, so re-inserting a used
    // baseline moves it to the back and makes eviction least-recently-USED
    // rather than least-recently-created. A baseline an agent keeps diffing
    // must not be evicted while an untouched one taken later survives.
    if (!result.forgotten && this._snapshots.has(id)) {
      const cur = this._snapshots.get(id);
      this._snapshots.delete(id);
      this._snapshots.set(id, cur);
    }
    return result;
  }

  /**
   * Bound the snapshot store. Until this existed, nothing but an explicit
   * `forget` ever removed a baseline: a long agent session accumulated every
   * snapshot it had ever taken, each holding a full page snapshot (the default
   * one carries the whole page's text — hundreds of KB on a real page).
   * Eviction is least-recently-used, because diff() re-inserts a baseline it
   * touches.
   */
  _evictSnapshots() {
    return evictOldest(this._snapshots);
  }

  /**
   * Probe what this page affords, and which route an agent should take.
   * Thin wrapper so the WS/MCP layers don't need to know the implementation.
   */
  async capabilities(opts = {}) {
    return probeCapabilities(this, opts);
  }

  /**
   * ui.app_model —— 「这个画布应用的对象模型在哪、里面有什么」。
   *
   * capabilities 回答"走哪条路"，但它扫的是 **window 上的对象**。两次实测
   * （suxieban / yunser）证明这条路会给出**假阴性**：实例在闭包里，window 上
   * 只有库本身或构造器，于是探针报"no app object on window"，agent 据此降级
   * 成"只能帧指纹"，而站点其实有完整的 getObjects / toJSON / loadFromJSON。
   *
   * 这里补的是那一步：按库指纹认库 → 在原型上挂只记 this 的 tee → 派发一条
   * 合成 mousemove 让页面自己走一趟 → 拿到实例再读。读取只调 getter，写入不封装
   * （写法每库都不同，强行统一只会造出第二个"广告了却没有实现"的契约）。
   */
  async appModel(opts = {}) {
    const tid = opts.tab !== undefined && opts.tab !== null ? opts.tab : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };
    let raw;
    try {
      raw = await this.evaluate(buildAppModelSource({ maxItems: opts.max_items }), tid);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), tab: tid };
    }
    const out = summarizeAppModel(raw, { include_items: opts.include_items });
    return {
      ...out,
      tab: tid,
      url: view.webContents.getURL(),
      // 这一步是给调用方判断"要不要相信 read_expr"的：
      // 钩子和实例引用都活在当前文档里，导航之后照抄上一条 read_expr 只会拿到 null。
      read_expr_scope: 'current document only',
    };
  }

  /**
   * ui.downloads —— agent 问"我刚才点导出，文件在哪儿"。
   *
   * 为什么必须是独立查询而不是塞进 ui.act 的返回值：下载是异步的，click 返回时
   * 它往往还没开始（站点常先发一个 XHR 再触发下载）。塞进去会让 agent 在错的
   * 时间点看到一个空列表，然后以为没触发。
   */
  downloads(params = {}) {
    const tid = params.tab !== undefined && params.tab !== null ? params.tab : this.activeTab;
    const r = this.downloadMonitor.list(tid);
    return {
      ...r,
      tab: tid,
      // 只把 completed 的算作"可用"，并明确告诉 agent 其余的状态 ——
      // 一个 interrupted 的记录不代表文件存在。
      ready: (r.downloads || []).filter((d) => d.state === 'completed'),
      note: 'only state=completed entries have a file on disk; check .path',
    };
  }

  /**
   * 下载开始了 —— 如果"这个 tab 就是为它而开的"，当场把它换成结果页。
   *
   * 事故现场（2026-10-27，沧州教师继续教育网"证书下载"）：站点用新标签打开
   * `.../xxx.png`，服务端带 `Content-Disposition: attachment`，于是 Electron
   * 把它当下载 —— **导航永远不会提交**，那个标签页停在 loading.html 上：
   * 一句「正在打开…」+ 一坨 URL，永远不变。文件其实已经落盘，但界面上
   * 没有任何回执，人的判断只能是"卡住了"。
   *
   * 判据是"这个 tab 还停在占位页"：说明它没有真正的页面可丢，接管它没有任何
   * 代价。反过来，页面里点"导出 CSV"那种下载，tab 上是真实页面，绝不能动。
   */
  _onDownloadStarted(rec, tabId) {
    try {
      if (tabId === undefined || tabId === null || !rec) return;
      const view = this.tabs.get(tabId);
      if (!view || view.webContents.isDestroyed()) return;
      const cur = view.webContents.getURL() || '';
      if (!mediaDoc.isPlaceholderUrl(cur)) return;
      // 让这条 will-download 先走完，再切页面：避免和刚刚被取消的导航抢加载。
      setImmediate(() => {
        try {
          if (view.webContents.isDestroyed()) return;
          if (!mediaDoc.isPlaceholderUrl(view.webContents.getURL() || '')) return;
          this.showDownloadResult(tabId, rec);
        } catch (_) { /* 结果页只是"有回执"，失败不该影响下载本身 */ }
      });
    } catch (_) { /* 同上 */ }
  }

  /** 把一个 tab 换成"下载结果"页（文件名/大小/缩略图/打开/在 Finder 中显示）。 */
  showDownloadResult(tabId, rec) {
    const view = this.tabs.get(tabId);
    if (!view || view.webContents.isDestroyed()) return false;
    const pagePath = path.join(__dirname, '../renderer/download.html');
    // 一律走 shared/placeholder.cjs 的构造器：手拼 'file://' + path 在打包后
    // （/Applications/AI Browser.app 含空格）加载不出来。
    const target = placeholder.fileUrlWithQuery(pagePath, {
      id: rec.id || '',
      name: rec.filename || 'download',
      path: rec.path || '',
      mime: rec.mime || '',
      size: String(rec.total_bytes || 0),
      url: rec.url || '',
    });
    if (!target) return false;
    view.webContents.loadURL(target).catch(() => {});
    return true;
  }

  /**
   * 工具条上的「下载」按钮：把当前页（一份被救回来的图片/视频/PDF）存到下载目录。
   *
   * 走 `downloadURL` 而不是自己 fetch：用的是同一个 session，站点的 Cookie /
   * Referer / 临时签名全部照旧，也就不会出现"浏览器里能看、下载下来是 403 页面"。
   */
  downloadCurrent(tabId) {
    const id = tabId === undefined || tabId === null ? this.activeTab : tabId;
    const view = this.tabs.get(id);
    if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'no such tab' };
    const cur = view.webContents.getURL() || '';
    const rec = this.mediaInline.recordOf(id, cur);
    const url = rec ? rec.url : cur;
    if (!/^https?:/i.test(url)) return { ok: false, error: 'not an http(s) page: ' + url };
    try {
      view.webContents.downloadURL(url);
      return { ok: true, tab: id, url, note: 'check ui.downloads / the toolbar receipt for the path' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /** 当前页是不是一份"被救回来的"可显示文档（要显示下载按钮）。 */
  mediaDocOf(tabId) {
    const id = tabId === undefined || tabId === null ? this.activeTab : tabId;
    const view = this.tabs.get(id);
    if (!view || view.webContents.isDestroyed()) return null;
    try {
      return this.mediaInline.recordOf(id, view.webContents.getURL() || '');
    } catch (_) {
      return null;
    }
  }

  _sendToView(tabId, channel, payload) {
    const view = this._getView(tabId);
    if (!view) return false;
    view.webContents.send(channel, payload);
    return true;
  }

  /**
   * 导航。返回 `{ok:true}` 或 `{ok:false,error}` —— 成功时形状与旧的布尔透出一致
   * （外部调用方读 `.ok` 不受影响），失败时多带一个原因：否则 agent 只拿到
   * `ok:false`，没有任何线索判断该重试还是该换 URL。
   *
   * loadURL 挂在 did-finish-load 上，而"永不触发 did-finish-load 的页面"是存在的
   * （挂起的连接、不结束的加载）。这与 ui.act 是同一类故障：await 一个可能不返回的
   * 东西。所以同样套 deadline。
   */
  async navigate(url, tabId, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'Tab not found' };
    this.touchTab(tid);
    // 一旦有人在这一页上导航过，它就不再是"还没人动过的启动页"了 —— 新标签页
    // 也就不该再顶替它（否则 agent 每开一页都把上一页顶掉，等于一直抢视野）。
    this._spendStartupPrivilege();
    const w = navWait.normalizeWaitUntil(opts.waitUntil);
    if (w.error) return { ok: false, error: w.error, wait_until_valid: navWait.LEVELS };
    const waitUntil = w.value;
    this._axDiffCache.delete(tid); // fresh page → drop stale incremental snapshot
    const wc = view.webContents;
    // loadURL resolves at did-finish-load, which is exactly when the old
    // pixels may still be on screen — repaint here as well as from the event
    // hooks, so a programmatic navigate never depends on hook timing.
    //
    // 失败时的返回值要说清楚**发生了什么**，而不是笼统的 ok:false。因为
    // did-fail-load 现在会把页面换成我们自己的错误页（见
    // _attachLoadFailureHooks），那次 loadURL(error_page) 会以 ERR_ABORTED
    // 打断当前这次 loadURL 的 Promise —— 如果不区分，agent 收到的就是
    // {ok:false, error:"ERR_ABORTED (-3) loading 'file://.../error_page.html'"}，
    // 它会以为自己的导航请求坏了，而实际上错误页已经接管、信息全在那儿。
    const pending = wc.loadURL(url);
    // 导航状态机也在这里维护：此前只有 new_tab 的占位流程会写 _tabNavState，
    // 于是 ui.navigate 期间 list_tabs 一直报 'ready' —— agent 看到 ready 就去
    // 读树/截图，拿到的是旧页面或半张页面，然后开始"重试"。
    this._tabNavState.set(tid, 'loading');
    const markReady = () => {
      if (this._tabNavState.get(tid) === 'loading') this._tabNavState.set(tid, 'ready');
    };
    wc.once('did-finish-load', markReady);
    wc.once('did-fail-load', markReady);
    setTimeout(markReady, 20000).unref?.();
    // commit / domcontentloaded 会**提前**返回；之后这个 Promise 仍可能 reject
    // （错误页接管、用户中止）。不接住就是 unhandledRejection，会把整个进程
    // 的日志淹掉。错误本身在返回结果里另行汇报。
    pending.catch(() => {});

    try {
      if (waitUntil === 'load') {
        await withDeadline(pending, 30000, 'navigate');
      } else {
        // 事件驱动，不等 did-finish-load。与 loadURL 自身的结果赛跑：同文档
        // 导航（#hash、history.pushState）不会 fire did-navigate，但那类导航
        // 的 loadURL 会立刻 resolve —— 不赛跑就会白等一整个 deadline。
        await withDeadline(Promise.race([
          this._waitForNavStep(wc, waitUntil, url),
          pending.then(() => ({ at: 'resolved' }), () => ({ at: 'resolved' })),
        ]), waitUntil === 'commit' ? 15000 : 20000, 'navigate');
      }
    } catch (e) {
      return this._navigateFailure(e, view, tid, waitUntil);
    }
    // 这里**不做**重绘（2026-10-25 修）。以前每次 navigate 结束都调 repaint()，
    // 而 repaint() 走 webContents.invalidate() —— 在新页面刚出现的那一刻强制整页
    // 重栅格化，合成器会先把画面按初始尺寸画一遍再缩放，用户看到的就是
    // "先缩成一小块、闪一下、然后正常"。导航本身会正常出帧，不需要我们推。
    if (waitUntil === 'load') return { ok: true, waited_for: 'load' };
    // load 还没来是**正常**的（SPA 本来就不 fire load）。如实说明，并给出
    // 下一步：调用方需要等某个具体内容时该用 ui.wait，而不是等 load。
    const stillLoading = typeof wc.isLoading === 'function' ? !!wc.isLoading() : false;
    return {
      ok: true,
      waited_for: waitUntil,
      url: wc.getURL(),
      load_pending: stillLoading,
      hint: stillLoading
        ? 'returned at ' + waitUntil + ' — the load event has not fired (normal for SPAs); the page is usable now. Wait for specific content with ui.wait, not for load.'
        : null,
    };
  }

  // commit / domcontentloaded 的事件等待。只认主帧：子帧导航不改变"这个 tab 到了
  // 没有"。任一事件先到就 resolve；did-fail-load 立刻 reject（错误页逻辑在外层）。
  //
  // 两个必须忽略的迟到事件（都实测踩到过）：
  //   -3 ERR_ABORTED：上一次导航被这次导航打断，这是**正常**的取代，不是失败。
  //      不忽略的话，连续两次 navigate 的第二跳稳定被报成 "did-fail-load -3"。
  //   failedUrl ≠ 本次目标：上一轮导航的迟到事件。它描述的不是我们等的东西。
  _waitForNavStep(wc, step, expectedUrl) {
    const norm = (u) => String(u || '').split('#')[0];
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        wc.removeListener('did-navigate', onCommit);
        wc.removeListener('dom-ready', onDom);
        wc.removeListener('did-fail-load', onFail);
      };
      const onCommit = () => {
        if (step !== 'commit') return; // domcontentloaded 还要再等一步
        cleanup();
        resolve({ at: 'commit' });
      };
      const onDom = () => { cleanup(); resolve({ at: 'domcontentloaded' }); };
      const onFail = (_e, code, desc, failedUrl, isMainFrame) => {
        if (isMainFrame === false) return;
        if (code === -3) return; // 被新的导航取代（见上）
        if (expectedUrl && failedUrl && norm(failedUrl) !== norm(expectedUrl)) return;
        cleanup();
        reject(Object.assign(new Error('did-fail-load ' + code + ' ' + desc), { __navFail: true }));
      };
      wc.once('did-navigate', onCommit);
      wc.once('dom-ready', onDom);
      wc.once('did-fail-load', onFail);
    });
  }

  _navigateFailure(e, view, tid, waitUntil) {
    const msg = String((e && e.message) || e);
    // 错误页已接管：这不是调用方的错，是目标站点不可达。
    // 两个判据（都不可省）：_failureGuard 里还有这个 tab（错误页刚加载、
    // did-finish-load 还没来清标记），或者当前 URL 已经是我们的错误页。
    const onErrorPage = String(view.webContents.getURL() || '').indexOf('error_page.html') >= 0;
    if ((this._failureGuard && this._failureGuard.has(tid)) || onErrorPage) {
      return {
        ok: false,
        error: msg,
        error_page: true,
        hint: '目标站点加载失败，已显示错误页（可重试 / 改网址）。'
          + ' 失败详情在页面里，用 ui.get_tree 或 ui.evaluate 读取。',
      };
    }
    if (e && e.__deadline) {
      return {
        ok: false,
        error: `${e.message} — navigation did not reach "${waitUntil}" in time; the page may still be loading in the background`,
        waited_for: waitUntil,
        hint: 'If the page is a SPA that never fires load, use wait_until:"domcontentloaded" or "commit". '
          + 'If the tab is stuck altogether, rebuild it: ui.close_tab + ui.new_tab.',
      };
    }
    return { ok: false, error: msg.slice(0, 300), waited_for: waitUntil };
  }

  async getTree(focusedOnly = false, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { tree: null, context: null };

    const res = await new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:extract', { focusedOnly, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('getTree timeout'));
        }
      }, 5000);
    });
    // 截断的 node.value 带内部字段 value_fetch_ref —— 展开成含实际 tab 的
    // value_fetch（mcp/ws 两种可直接执行的调用提示），再删掉内部字段。
    if (res && res.tree) expandValueFetchTree(res.tree, tid);
    // P1-1：页面有可见的跨进程子帧时，自动把子帧内容合并进默认树。
    // 此前这条通路只在 ax:true 下存在，而**没有任何地方告诉调用方 ax:true
    // 的存在** —— B站图文编辑器（正文在 OOPIF 里）因此隐形了两小时，agent
    // 得出"编辑器没加载"的错误结论。现在默认读法自己补上这一步。
    const frames = focusedOnly ? [] : await this._autoMergeOpaqueFrames(res, tid);
    // 「这棵树读到了多少页面文字」—— 与 frame_hints 的 text_coverage（只看帧）
    // 互补：那个回答"帧读够了吗"，这个回答"整页读够了吗"。
    // 事故里 27 个节点、正文 0 字的页面，两个数字都会报警，而此前一个都没有。
    this._annotateCoverage(res, frames);
    // 记下"这一版树里有哪些 ref"。之后 act 报 target_not_found 时，靠它区分
    // 「ref 过期了」（页面变过，重读树即可）和「ref 从来没对过」（改传参）。
    // 见 shared/ref_epoch.js 顶部注释。
    this._noteTreeRefs(tid, res && res.tree);
    // 多编辑器的消歧索引（见 shared/editors_probe.js）。AX 路径的树根已经带
    // `editors`，这里只补默认路径；focused_only 的子树没有"整页有哪几个编辑区"
    // 这层语义，跳过。
    if (res && res.tree && !res.tree.editors && !focusedOnly) {
      const idx = await this._editorsIndex(tid, res.tree);
      if (idx) res.tree.editors = idx;
    }
    return res;
  }

  /**
   * 扫一遍页面上的可编辑区，按面积给出 primary。
   * 失败静默返回 null —— 消歧索引是**增强**，读不到不该让 get_tree 失败。
   */
  async _editorsIndex(tid, tree) {
    const view = this._getView(tid);
    if (!view) return null;
    let rows = null;
    try {
      const d = view.webContents.debugger;
      if (!d || typeof d.isAttached !== 'function' || !d.isAttached()) return null;
      const r = await d.sendCommand('Runtime.evaluate', {
        expression: editorsProbe.EDITORS_PROBE_JS,
        returnByValue: true,
      });
      rows = r && r.result && r.result.value;
    } catch (_e) {
      return null;
    }
    const known = new Set();
    const walk = (n) => {
      if (!n) return;
      if (n.id) known.add(n.id);
      for (const c of n.children || []) walk(c);
    };
    walk(tree);
    return editorsProbe.buildEditorsIndex(rows, known);
  }

  /** per-tab 的 ref 版本追踪器（懒建，避免动构造函数）。 */
  _refTracker(tid) {
    if (!this._refTrackers) this._refTrackers = new Map();
    let t = this._refTrackers.get(tid);
    if (!t) { t = newTracker(); this._refTrackers.set(tid, t); }
    return t;
  }

  _noteTreeRefs(tid, tree) {
    if (!tree) return;
    try { noteTree(this._refTracker(tid), tree); } catch (_) { /* 追踪失败绝不影响读树 */ }
  }

  // 把跨进程子帧的内容读出来、合并进默认（DOM）树。轻量：只读子帧，
  // 不重建主树，所以默认树的形状/id 全部保持原样。
  // 三种结局都写进 context.frame_hints（见 shared/frame_probe.describeAutoAx）：
  // merged / no-new-content / failed+reason。调用方必须能区分"已尽力"和
  // "还有一条没走过的路"。
  async _autoMergeOpaqueFrames(res, tid) {
    try {
      if (!res || !res.tree || !res.context) return [];
      if (res.tree.__oopif_merged) return []; // 幂等：合并过的树不重复做
      const summary = res.context.cross_process_frames;
      if (!frameProbe.shouldAutoAx(summary)) return [];
      const view = this._getView(tid);
      if (!view) return [];
      const frames = await withDeadline(this._readOopifFrames(view, tid), 15000, 'get_tree(auto-oopif)');
      if (frames && frames.length) {
        res.tree = axExtractor.mergeFrameTrees(res.tree, frames);
        res.tree.__oopif_merged = true;
        // 子帧里的必填提示 / 校验错误也一并合进 context（否则最该有这些字段的
        // 页面恰好是空的，见 frame_probe.mergeFrameContext 顶部注释）。
        const mergedCtx = frameProbe.mergeFrameContext(res.context, frames);
        if (mergedCtx) Object.assign(res.context, mergedCtx);
      }
      res.context.frame_hints = frameProbe.describeAutoAx({
        merged: !!(frames && frames.length),
        framesRead: (frames || []).length,
        // 测量值：光说 merged 等于只说"我试过了"。见 frame_probe.summarizeFrameRead。
        summary: frameProbe.summarizeFrameRead(frames),
      });
      // 返回帧记录：文字覆盖率要用它们的 text_chars 当分母的一部分。
      return frames || [];
    } catch (e) {
      // 自动合并失败绝不拖垮主读法：默认树照常返回，只在 hints 里说明原因。
      // 调用方看到 failed 可以手动切 ax:true 重试。
      if (res && res.context) {
        res.context.frame_hints = frameProbe.describeAutoAx({
          error: (e && e.__deadline ? e.message + ' — the page main thread is likely blocked' : e && e.message) || String(e),
        });
      }
      return [];
    }
  }

  /**
   * 「这棵树读到了多少页面文字」写进 context.page_coverage。
   *
   * 分子 = 树里所有正文 label 的字符数；分母 = 主文档 innerText 长度 +
   * 每个跨进程帧里可见文字的字符数（帧那边在 frame_read_source 里已经算过）。
   *
   * 为什么必须分成"主文档 + 帧"两半：innerText 不跨 iframe，把两者混在一个
   * 数里，任何一侧读漏都会被另一侧的平均值盖住 —— 泛雅那次就是这样，
   * 主文档读得很好（外壳 100%），正文一个字没有，而没有任何数字表达这件事。
   */
  _annotateCoverage(res, frames, opts) {
    if (!res || !res.tree || !res.context) return;
    // 读失败时不算覆盖率：这一版树是 bridge 的兜底占位（只有一个装着异常文本的
    // 节点），拿它当分子只会得出一个看似正常的小数字，把"没读成"包装成
    // "页面内容少"。宁可让 page_coverage 缺席，让 read_ok/read_error 说话。
    if (res.context.read_ok === false) return;
    try {
      const stats = res.context.stats || {};
      const frameChars = (frames || []).reduce(
        (s, f) => s + Number((f && f.stats && f.stats.text_chars) || 0), 0);
      const summed = docCoverage.sumLabelChars(res.tree);
      res.context.page_coverage = docCoverage.pageCoverage({
        treeChars: summed.chars,
        mainChars: Number(stats.text_chars) || 0,
        sameOriginChars: Number(stats.same_origin_chars) || 0,
        shadowChars: Number(stats.shadow_chars) || 0,
        frameChars,
        canvases: Number(stats.canvases) || 0,
        // AX 树算的是**可访问名**，天生比 innerText 多（aria-label / alt / title）。
        ax: !!(opts && opts.ax),
      });
    } catch (_) { /* 度量失败绝不影响读树 */ }
  }

  // 登录态 / 登录墙自查。长任务里每个关键步骤前都可以问一次，成本只是走一次
  // extractPageContext（不建树）。
  //
  // 为什么单独开一个原语而不是让调用方自己去 getTree().context 里翻：CSDN 那次
  // 事故里，登录态信息其实一直在 context 里，但它是个不显眼的小字段，且当时的
  // 判定还是错的（csrfToken 子串命中 "token" → 谎报已登录）。显式暴露成
  // "问一句就答一句"的原语，才能让"先验登录态"变成低成本的第一步。
  // 一次性 DOM 侧上下文（不建树）。authState 与 AX 读法共用：AX 自身的
  // context 只有 modals/session/stats，登录墙、校验错误、必填提示全都来自
  // 这条 DOM 扫描 —— 两条读法给出不一致的 context 只会让调用方怀疑读数。
  async _readContext(view) {
    const res = await new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:context', { id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('context read timeout'));
        }
      }, 5000);
    });
    return (res && res.context) || {};
  }

  async authState(tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };
    try {
      const ctx = (await this._readContext(view)) || {};
      const wall = ctx.auth_wall || null;
      return {
        ok: true,
        tab: tid,
        url: ctx.url || null,
        auth_wall: wall,
        // 兼容旧形状：session.logged_in 仍从 context 取，但语义已收紧（见
        // shared/auth_wall.cjs）。auth_wall.detected 是硬事实，优先级高于它。
        logged_in: ctx.session ? !!ctx.session.logged_in : null,
        evidence: (ctx.session && ctx.session.evidence) || [],
        // 一句话结论，方便直接读：调用方不必自己组合字段。
        verdict: wall && wall.detected
          ? 'AUTH_WALL — this tab is on a login page, not the site you meant to operate'
          : (ctx.session && ctx.session.logged_in
            ? 'looks-logged-in (heuristic)'
            : 'not-logged-in (heuristic) — verify before continuing'),
      };
    } catch (e) {
      return { ok: false, error: e.message, tab: tid };
    }
  }

  // 视口截图（P0-1）。此前 ai-browser 只有元素树这一只"眼睛"：树里没有的
  // 东西（浮层、canvas、图片、CSS 遮挡、渲染错位）就完全不可见，而这类情况
  // 恰恰是操作失败的主因。调用方失败时第一反应是"看截图"，工具面必须支持。
  //
  // 走 webContents.debugger 的 Page.captureScreenshot —— 与 AX/Network 域
  // 共用同一个 per-tab attach（_ensureCdp 幂等），不额外占用调试器。
  // 截图是同步渲染快照，主线程卡住时它不返回，所以带 deadline。
  async screenshot(tabId, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };

    const norm = screenshotOpts.normalizeScreenshotOpts(opts);
    if (!norm.ok) return { ok: false, error: norm.error, tab: tid };
    const o = norm.opts;

    let meta = {};
    try {
      this._ensureCdp(tid, view, 'Page');
    } catch (e) {
      return { ok: false, error: 'cdp-unavailable: ' + e.message, tab: tid };
    }
    const dbg = view.webContents.debugger;
    if (!dbg) return { ok: false, error: 'cdp-unavailable', tab: tid };

    try {
      // 视口尺寸：clip 缺省时用于回执，也让调用方知道拍的到底是哪块。
      // 失败不致命（老页面没布局完也会返回 0），降级为 null。
      try {
        const lm = await withDeadline(dbg.sendCommand('Page.getLayoutMetrics'), 10000, 'getLayoutMetrics');
        const vp = lm && lm.cssLayoutViewport ? lm.cssLayoutViewport : (lm && lm.layoutViewport) || null;
        if (vp) meta = { width: Math.round(vp.clientWidth || 0), height: Math.round(vp.clientHeight || 0) };
      } catch (_) { /* 布局指标拿不到就算了，截图本身才是主目标 */ }

      const params = {
        format: o.format,
        fromSurface: true,
        captureBeyondViewport: o.fullPage,
      };
      if (o.quality !== undefined) params.quality = o.quality;
      // clip.scale < 1（"给我一张缩略概览"）**绝不交给合成器**：带 clip.scale 的
      // 截图会让 Chromium 按该比例临时重建 surface，窗口恰好在合成时就会贴上那张
      // 缩小的图 1–3 帧（见 SPEC「取帧两条铁律」，2026-10-25 实锤）。
      // 现在按 scale=1 抓、用 nativeImage 在我们自己这边缩 —— 输出尺寸一致，
      // 但不再碰合成器。scale>1（放大取值）仍交给 Chromium：本地放大得不到像素。
      let localScale = 1;
      if (o.clip && typeof o.clip.scale === 'number' && o.clip.scale > 0 && o.clip.scale < 1) {
        localScale = o.clip.scale;
        params.clip = { ...o.clip, scale: 1 };
      } else if (o.clip) {
        params.clip = o.clip;
      }
      const shot = await withDeadline(
        dbg.sendCommand('Page.captureScreenshot', params),
        20000, 'captureScreenshot'
      );
      if (!shot || typeof shot.data !== 'string') {
        return { ok: false, error: 'empty screenshot result', tab: tid };
      }
      // 需要缩小就自己做（见上：不把缩放交给合成器）。
      let imgData = shot.data;
      if (localScale !== 1) {
        try {
          const img0 = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
          if (!img0.isEmpty()) {
            const sz = img0.getSize();
            const w = Math.max(1, Math.round(sz.width * localScale));
            const resized = img0.resize({ width: w });
            imgData = o.format === 'jpeg'
              ? resized.toJPEG(typeof o.quality === 'number' ? o.quality : 80).toString('base64')
              : resized.toPNG().toString('base64');
          }
        } catch (_) { /* 缩失败就用原图（宁可图大，不要空图） */ }
      }

      const mime = 'image/' + (o.format === 'jpeg' ? 'jpeg' : o.format);
      // 一次 evaluate 拿两样东西：可见密码框（截图不脱敏，泄密了得让调用方
      // 知道）和 devicePixelRatio —— 后者因为 CDP 的 clip 是 CSS 像素而输出
      // 是设备像素：调用方按 getBoundingClientRect 传 500 宽，Retina 上会
      // 拿到 1000 像素的图。没有这个比值，"zoom 拍元素"的调用方无法把图上的
      // 坐标换算回页面坐标。
      let hasPwd = false;
      let dpr = null;
      try {
        const p = await this.evaluate(
          `(function(){var els=document.querySelectorAll('input[type=password]');` +
          `var pwd=false;for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();` +
          `if(r.width>0&&r.height>0)pwd=true;}return JSON.stringify({pwd:pwd,dpr:window.devicePixelRatio||1});})()`, tid);
        let parsed = null;
        try { parsed = typeof p === 'string' ? JSON.parse(p) : p; } catch (_) { /* evaluate 可能返回 undefined */ }
        if (parsed) { hasPwd = parsed.pwd === true; dpr = Number(parsed.dpr) || null; }
      } catch (_) { /* 探测失败不影响截图交付 */ }

      const summary = screenshotOpts.describeShot({
        format: o.format,
        mime,
        bytes: Buffer.byteLength(imgData, 'base64'),
        width: meta.width,
        height: meta.height,
        url: (this._getView(tid) && this._getView(tid).webContents.getURL()) || undefined,
        hasVisiblePasswordInput: hasPwd,
        devicePixelRatio: dpr,
      });
      // path：直接把图写到磁盘。写失败要如实报错（不是"截图成功但没文件"）。
      let filePath = null;
      if (o.path) {
        try {
          fs.mkdirSync(path.dirname(o.path), { recursive: true });
          fs.writeFileSync(o.path, Buffer.from(imgData, 'base64'));
          filePath = o.path;
        } catch (e) {
          return { ok: false, tab: tid, error: 'screenshot captured but writing to ' + o.path + ' failed: ' + ((e && e.message) || e), ...summary };
        }
      }
      // 未知参数不再静默丢弃：调用方传了什么没被用上，回执里点名。
      const known = { format: 1, quality: 1, fullPage: 1, clip: 1, path: 1 };
      const ignored = Object.keys(opts || {}).filter((k) => !known[k]);
      return {
        ok: true,
        tab: tid,
        // data 是 base64 裸数据（不带 data: 前缀）—— 调用方按需自己拼。
        data: imgData,
        mime,
        ...(filePath ? { path: filePath } : {}),
        ...(ignored.length ? { ignored_params: ignored } : {}),
        ...summary,
      };
    } catch (e) {
      if (e && e.__deadline) {
        return { ok: false, error: e.message + ' — the page main thread is likely blocked', tab: tid };
      }
      return { ok: false, error: e.message, tab: tid };
    }
  }

  // AX probe read layer (P0). Additive — the default getTree path is untouched.
  // Reuses the per-tab shared debugger: enables the Accessibility + DOM domains
  // into the same reference-counted _cdpTabs entry as Network/Runtime, so teardown
  // and multi-client reference counting are unchanged.
  async getTreeViaAx(tabId, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { tree: null, context: null };
    try {
      this._ensureCdp(tid, view, 'Accessibility');
      this._ensureCdp(tid, view, 'DOM');
    } catch (e) {
      return { tree: null, context: null, error: 'cdp-unavailable' };
    }
    // 与 ui.act 同一类风险：这些全是 await CDP 命令（Accessibility.getFullAXTree /
    // DOM.getDocument / DOM.resolveNode），渲染进程主线程被占住时它们不返回。
    // getTree 的 preload 路径有 5s 超时，这条 AX 路径此前没有 —— 补上。
    try {
      const main = await withDeadline(
        axExtractor.extractFromDebugger(view.webContents.debugger),
        15000, 'get_tree(ax)'
      );
      // #1: decorate link/button nodes with their absolute target URL (read-only).
      // Generic — agent sees "where clicking takes me" instead of guessing labels.
      if (main && main.tree && view.webContents.debugger) {
        main.tree = await withDeadline(
          axExtractor.attachHrefs(view.webContents.debugger, main.tree),
          15000, 'get_tree(ax).attachHrefs'
        );
      }
      const out = await this._finishAxTree(main, view, tid, opts);
      // AX 树的 context 只有 modals/session/stats —— 登录墙、校验错误、必填提示
      // 都在 DOM 扫描里。此前 ax:true 的调用方拿到的是一份"更薄"的上下文：
      // 同一个页面，默认读法说"这是登录页"，ax 读法什么都不说。这里把 DOM 侧
      // 缺的字段补齐（不覆盖 AX 已有的），两条读法的 context 才可比。
      if (out && out.context) {
        try {
          const ctx = await this._readContext(view);
          for (const k of ['auth_wall', 'validation_errors', 'field_errors', 'required_hints', 'errors', 'hints', 'forms', 'cross_process_frames']) {
            if (out.context[k] == null && ctx[k] != null) out.context[k] = ctx[k];
          }
          if (!out.context.session || !Object.keys(out.context.session).length) out.context.session = ctx.session || {};
          if (out.context.stats && ctx.stats) Object.assign(out.context.stats, { inputs: ctx.stats.inputs, buttons: ctx.stats.buttons, links: ctx.stats.links, links_without_href: ctx.stats.links_without_href, iframes: ctx.stats.iframes, text_chars: ctx.stats.text_chars });
        } catch (e) { /* context 补全失败不影响树 */ }
      }
      // 分母（text_chars）补完了，这时候才算覆盖率。frames 由 _finishAxTree 带过来。
      if (out) {
        const framesForCoverage = out.__frames || [];
        delete out.__frames;
        this._annotateCoverage(out, framesForCoverage, { ax: true });
      }
      return out;
    } catch (e) {
      if (e && e.__deadline) {
        return { tree: null, context: null, error: e.message + ' — the page main thread is likely blocked' };
      }
      throw e;
    }
  }

  async _finishAxTree(main, view, tid, opts) {
    // P0 down-drill: splice OOPIF sub-frame editors into the main AX tree so
    // editors rendered in cross-process iframes (B站 write-article: york/read-draft)
    // become visible to `ui.get_tree {ax:true}`. Each sub-frame is read by
    // executeJavaScript in its own context (top-frame AX + querySelector can't
    // reach OOPIF content), then merged purely by mergeFrameTrees.
    const frames = await this._readOopifFrames(view, tid);
    if (frames.length && main && main.tree) {
      main.tree = axExtractor.mergeFrameTrees(main.tree, frames);
      if (main.context) {
        const mergedCtx = frameProbe.mergeFrameContext(main.context, frames);
        if (mergedCtx) Object.assign(main.context, mergedCtx);
        // 与默认读法同一份回执：走 AX 这条路的调用方也要能看到"并进去几个节点、
        // 帧里还有多少字没进树"。两条读法给不同口径的提示，等于让调用方猜。
        main.context.frame_hints = frameProbe.describeAutoAx({
          merged: true,
          framesRead: frames.length,
          summary: frameProbe.summarizeFrameRead(frames),
        });
      }
    }
    // 覆盖率在两条读法上是同一个口径（同一个函数），否则"ax:true 覆盖率 60%、
    // 默认读法 40%"只会让调用方怀疑读数本身。
    // 这里只把 frames 挂给调用方，**不能在这里算**：AX 的 context.stats 还要等
    // getTreeViaAx 补完 DOM 侧字段（含 text_chars）才有分母。
    if (main) main.__frames = frames || [];
    // #4: incremental diff — return only newly appeared / hidden interactive
    // nodes since the last ax read on this tab (feeds: small payload per scroll).
    if (opts.mode === 'diff') {
      const lite = this._liteFromTree(main.tree);
      const prev = this._axDiffCache.get(tid) || null;
      if (prev && prev.size) {
        this._axDiffCache.set(tid, lite);
        return { tree: null, context: null, diff: axExtractor.diffLite(prev, lite) };
      }
      this._axDiffCache.set(tid, lite);
    }
    // #4: interactive subset — prune layout-only branches to cut token cost.
    if (opts.subset === 'interactive' && main.tree) {
      main.tree = axExtractor.filterInteractive(main.tree);
    }
    // 同 getTree：把 value_fetch_ref 展开成带实际 tab 的 value_fetch。
    if (main && main.tree) expandValueFetchTree(main.tree, tid);
    return main;
  }

  // Lite interactive snapshot derived from an already-built tree (no second CDP
  // read). Keyed by backendDOMNodeId for cheap diff across reads.
  _liteFromTree(tree) {
    const out = new Map();
    (function w(t) {
      if (!t) return;
      if (t.backendDOMNodeId != null && ((t.actions || []).length > 0 || t.editor_type)) {
        out.set(t.backendDOMNodeId, { id: t.id, role: t.role, label: t.label || '' });
      }
      for (const c of t.children || []) w(c);
    })(tree);
    return out;
  }

  // 子帧侧的上下文探测（在子帧自己的 JS 上下文里执行）。只做两件读操作：
  // 收集"请输入/必填"类占位符，以及 aria-invalid 字段对应的错误文案。
  // 规则与顶层 extractor 的 scanRequiredHints / validation_errors 同源 ——
  // 两边给出不同口径的提示，等于让调用方自己判断信谁。
  _frameCtxJs() {
    return `(function(){
      var hints=[], ves=[];
      try{
        var els=document.querySelectorAll('input[placeholder],textarea[placeholder],[contenteditable][data-placeholder]');
        for(var i=0;i<els.length&&hints.length<10;i++){
          var p=els[i].getAttribute('placeholder')||els[i].getAttribute('data-placeholder');
          if(p&&/请\\s*(输入|填写|选择)|必填|必选|不能为空/.test(p)&&hints.indexOf(p)<0)hints.push(p.slice(0,50));
        }
      }catch(e){}
      try{
        var inv=document.querySelectorAll('[aria-invalid="true"]');
        for(var j=0;j<inv.length&&ves.length<10;j++){
          var el=inv[j],t='';
          var ids=(el.getAttribute('aria-describedby')||'').split(/\\s+/);
          for(var k=0;k<ids.length;k++){var d=ids[k]&&document.getElementById(ids[k]);if(d){t=(d.textContent||'').trim();if(t)break;}}
          if(!t){var par=el.parentElement;if(par){var e=par.querySelector('[class*=error],[class*=err],[role=alert]');if(e)t=(e.textContent||'').trim();}}
          ves.push({text:t.slice(0,120),near:el.id||el.name||el.getAttribute('aria-label')||el.getAttribute('placeholder')||''});
        }
      }catch(e){}
      return JSON.stringify({required_hints:hints,validation_errors:ves});
    })()`;
  }

  // Read the **content** of each out-of-process sub-frame via
  // Frame.executeJavaScript (runs in that frame's own context). Returns
  // [{ key, label, src, tree, context, stats }] — pure mergeFrameTrees input.
  // Stamps idempotent data-ai-id = `axf-{frameSeq}-{idx}` inside each frame so
  // the act layer can (a) find the owning frame by testing which frame has
  // `[data-ai-id=...]`, and (b) run its JS in that frame's own context (top
  // querySelector can't reach OOPIF).
  //
  // 采集规则在 shared/frame_read_source.js —— 这里原本内联了一份只认表单控件
  // 的选择器，于是「没有可点元素」的 frame（正文、目录、成绩表）读出来是空的，
  // 而回执还说 merged。事故与口径见那个文件顶部。
  //
  // frameSeq 在 try 之前自增：某个帧读不到时序号不能回填，否则树里的
  // `frame-N` 会指向另一个帧（agents 会照着 ref 去操作，指错比没有更坏）。
  async _readOopifFrames(view, tabId) {
    try {
      const root = view.webContents.mainFrame;
      if (!root || !root.framesInSubtree) return [];
      const out = [];
      let frameSeq = 0;
      for (const frame of root.framesInSubtree) {
        if (frame === root) continue; // main frame handled by AX path
        frameSeq += 1;
        const key = 'frame-' + frameSeq;
        const prefix = 'axf-' + frameSeq + '-';
        try {
          const dto = await frame.executeJavaScript(buildFrameReadSource(prefix));
          if (!dto) continue;
          const nodes = Array.isArray(dto.nodes) ? dto.nodes : [];
          const chars = (dto.stats && Number(dto.stats.text_chars)) || 0;
          // 一个节点都没有、也没有可见文字 = 这个帧确实是空的，跳过。
          // 有文字却一个节点都没读出来 = 内容在更深一层 iframe 里，或者结构完全
          // 超出采集规则 —— 必须留下门节点 + 绝对 src，让调用方知道"这里有一块
          // 内容没读到"；让它从树里彻底消失，就回到了这轮修的起点。
          if (!nodes.length && chars < 20) continue;
          // 子帧里的"该填什么 / 错在哪"。顶层 extractPageContext 只能看顶层文档，
          // 而 B站图文的标题框、掘金编辑器都住在 OOPIF 里 —— 上下文扫描不跟着
          // 走一遍子帧，required_hints / validation_errors 就会在**真正需要它们
          // 的地方**恰好是空的（实测：B站标题框 placeholder="请输入标题"，顶层扫描
          // 结果为空）。失败不影响建树。
          let frameCtx = null;
          try {
            const rawCtx = await frame.executeJavaScript(this._frameCtxJs());
            frameCtx = typeof rawCtx === 'string' ? JSON.parse(rawCtx) : rawCtx;
          } catch (e) { /* 子帧上下文探测失败：树照常返回 */ }
          const tree = {
            id: key,
            role: 'generic',
            label: frame.name || ('frame-' + frameSeq),
            states: [],
            actions: [],
            // 门节点带上**绝对** src：树里出现的东西，调用方就应该能直接用。
            // 相对地址（/mooc2-ans/...）没法喂给 ui.new_tab / ui.navigate，
            // 等于把"我知道内容在哪"变成一句废话。
            ...(dto.url ? { src: dto.url } : {}),
            bounds: { x: 0, y: 0, width: 0, height: 0 },
            children: nodes.map((n) => ({
              id: n.id,
              role: n.role,
              label: n.label || '',
              ...(n.url ? { url: n.url } : {}),
              states: n.states || (n.editor_type ? ['editable=' + n.editor_type, 'focusable'] : ['focusable']),
              ...(n.editor_type ? { editor_type: n.editor_type } : {}), // first-class, mirrors main AX path
              // 只读内容块没有动作。此前一律给 ['click','focus','type','setContent','clear']，
              // 于是每个段落都被报成"可以往里打字" —— agent 照着做，然后拿到一串
              // 莫名其妙的失败。
              actions: (n.states || []).indexOf('readonly') >= 0
                ? []
                : (n.role === 'button'
                  ? ['click', 'focus']
                  : ['click', 'focus', 'type', 'setContent', 'clear']),
              bounds: n.bounds,
            })),
          };
          out.push({
            key,
            label: frame.name || ('frame-' + frameSeq),
            // frame.url 是 WebFrameMain 的绝对地址；dto.url 是页内 location.href。
            // 两个都试，拿到的第一个能用的就写进 hints（走新标签打开时要用绝对地址）。
            src: dto.url || frame.url || null,
            tree,
            context: frameCtx,
            stats: dto.stats || null,
          });
        } catch (e) { /* skip unreachable frame */ }
      }
      return out;
    } catch (e) { return []; }
  }

  // C (plan §9.5): materialize data-ai-id for interactive elements at the act/peek
  // boundary only. Reading (getTreeViaAx/axRead) never touches the DOM. Idempotent:
  // existing handles (default extractor's `e:...`) are preserved, never overwritten.
  async _ensureAxHandles(view, tabId) {
    if (!view || !view.webContents || !view.webContents.debugger) return;
    try {
      this._ensureCdp(tabId, view, 'Accessibility');
      this._ensureCdp(tabId, view, 'DOM');
      await axExtractor.ensureHandles(view.webContents.debugger);
    } catch (e) { /* no CDP: fall through to the preload path */ }
  }

  // A (plan §9.5): `ui.peek` — safely explore the "next step". Hover-reveal is
  // non-committing (mouseMoved without press), so it never double-clicks or
  // mis-triggers; we return the AX diff (newly revealed / hidden interactive
  // nodes) so the agent can discover folded entries (e.g. B站 写文章) without
  // guessing URLs. Revert moves the pointer away to close the submenu.
  async peek(tabId, target, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { revealed: [], hidden: [], mode: 'hover', error: 'Tab not found' };
    if (!target) return { revealed: [], hidden: [], mode: 'hover', error: 'No target' };
    const out = { revealed: [], hidden: [], mode: 'hover' };
    try {
      this._ensureCdp(tid, view, 'Page'); // 只为挂上 debugger（Input 域没有 enable）
    } catch (e) { return { ...out, error: 'cdp-unavailable' }; }
    const dbg = view.webContents.debugger;
    try {
      const center = await this.evaluate(
        `(function(){var el=${findRefExpr(JSON.stringify(target))};if(!el)return null;` +
        `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
        `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
        tid);
      // 定位不到 target 必须如实报错。此前直接返回未带 error 的空 out，与"hover 了
      // 但这里确实没有可展开项"完全无法区分 —— agent 会误判成"菜单没有更深的入口"
      // 而放弃探索，实际只是 target 拼错/句柄失效。
      if (!center) {
        return { ...out, error: 'target_not_found: no element with data-ai-id=' + String(target) };
      }
      const send = (method, params) => dbg.sendCommand(method, params);
      // 区分"没传"与"显式传 0"：0 是合法语义（hoverMs=0 不等、revertMs=0 不回撤）。
      // 原来的 `Number(x) || 450` 把 0 当 falsy 顶成默认值，revertMs=0 永远失效。
      const msOr = (v, dflt) => (v === undefined || v === null || v === '') ? dflt : Math.max(0, Number(v) || 0);
      try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
      } catch (e) {}
      //
      // 顺序是「先悬停拍一张，再挪开拍一张」，不是反过来。
      //
      // 反过来（先挪开落基线、再悬停）要求基线是"干净的"，也就是鼠标必须真的已经
      // 离开目标、且菜单已经收完。这条做不到：菜单是带动画收起的，等多久取决于
      // 站点 —— 实测 B站 头部「收藏」的下拉，鼠标挪开后 3 轮分别要 522 / 496 /
      // 491ms 才从 DOM 里消失。写死等待时长不是 150ms 只有 2/4 命中，就是 550ms
      // 也照样会漏（都试过）。
      //
      // 更麻烦的是"判断鼠标是否还在目标上"这一步本身也不可靠（el.matches(':hover')
      // 在连续调用时给出的结果会跳），于是连"要不要等"都判断错。
      //
      // 换成先悬停再挪开，两张快照都是自己亲手造成的，与调用前的鼠标位置无关：
      //   A = 悬停着（菜单在）  B = 挪开后（菜单不在）
      //   revealed = A \ B  → "悬停带来的东西"，无论鼠标一开始在哪。
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
      const hoverMs = msOr(opts.hoverMs, 450);
      await new Promise((r) => setTimeout(r, hoverMs));
      const snapWith = await this.getTree(false, tid);
      // 取不到快照就必须报错，不能拿空数组当基线 —— 那样另一张里的每一个节点都会
      // 变成"新出现的"，一屏假结果比报错危险得多。
      if (!snapWith || !snapWith.tree) {
        return { ...out, error: 'snapshot_failed: 拿不到悬停时的语义树' };
      }
      const nodesWith = treeDiff.flattenTree(snapWith.tree);
      // 挪开鼠标后要等菜单真的收完，再拍第二张。
      //
      // 试过"轮询元素总数直到不再减少"来适配不同站点，行不通：页面自己一直在抖
      // （B站 首页有轮播与懒加载，元素总数常态波动），"稳定"永远达不到，每回都
      // 跑满 12 次轮询（1080ms）。所以回到固定时长 —— 但 600 这个数是实测出来的：
      // 轮询 B站 头部「收藏」下拉的收起耗时，3 轮分别是 491 / 496 / 522ms。
      // 想换更短的等待可以传 opts.settleMs。
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
      await new Promise((r) => setTimeout(r, msOr(opts.settleMs, 600)));
      const snapWithout = await this.getTree(false, tid);
      if (!snapWithout || !snapWithout.tree) {
        return { ...out, error: 'snapshot_failed: 拿不到挪开鼠标后的语义树' };
      }
      const nodesWithout = treeDiff.flattenTree(snapWithout.tree);
      const diff = treeDiff.diffTree(nodesWithout, nodesWith);
      out.revealed = diff.revealed;
      out.hidden = diff.hidden;
      // revertMs=0 表示"别回撤，我要接着点" —— 这时把鼠标放回目标上，让菜单重新
      // 展开，调用方下一步可以直接点 revealed 里的东西。其余情况鼠标已经挪开了，
      // 天然就是"回撤"，不需要延迟定时器（原先那套 per-tab 定时器也因此删掉了）。
      //
      // 移回之后必须重新拍一张并把 id 重绑：菜单重开时 DOM 是新造的节点，id 全变
      // 了，直接返回刚才那批 id 的话，调用方点下去只会拿到 target_not_found。
      const revertMs = msOr(opts.revertMs, 1500);
      if (revertMs === 0) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
        await new Promise((r) => setTimeout(r, msOr(opts.reopenMs, 350)));
        const snapBack = await this.getTree(false, tid);
        if (snapBack && snapBack.tree) {
          out.revealed = treeDiff.remapIds(out.revealed, treeDiff.flattenTree(snapBack.tree));
        }
      }
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 200);
    }
    return out;
  }

  /**
   * ui.act 的外壳：唯一职责是**保证它一定会在有限时间内返回**。
   *
   * 为什么必须有这一层：`ui.act` 内部会 await CDP 命令（Input.dispatchMouseEvent /
   * Accessibility.getFullAXTree / DOM.getDocument），而这些命令在渲染进程主线程被
   * 占住时**永不返回**—— 事件要等 ack，ack 等主线程空出来。实测一个跑 while 循环
   * 的页面能让 ui.act 45 秒无回包（其余路径各自有 5s 超时并正确报错，见
   * shared/deadline.js 顶部）。后果不是"慢"，是 agent 的工具调用永久悬挂、
   * 整个会话死掉，且没有任何错误可看。
   *
   * 放在这一层而不是各个子路径里，是因为挂住的位置不止一个（AX handles、指针目标
   * 解析、拖拽按键分发都可能），逐个补等于逐个漏。
   */
  /**
   * 动作前后各拍一次页面指纹（只读、不写属性、不触发事件）。
   *
   * 探针失效一律返回 null 并让调用方跳过 —— 观测能力不足不能反过来让动作失败。
   * 三种失效都真实发生过：debugger 没 attach、主线程被占住导致 CDP 不返回、
   * 页面返回了 __err。全部走静默降级，但**绝不用 null 冒充"没变化"**：
   * diffProbe 对 null 显式返回 changed:null，回执里就不会出现 page_changed。
   */
  async _pageProbe(tid, action) {
    if (!pageProbe.shouldProbe(action)) return null;
    const view = this._getView(tid);
    if (!view) return null;
    try {
      const d = view.webContents.debugger;
      if (!d || typeof d.isAttached !== 'function' || !d.isAttached()) return null;
      // 1.5s 硬上限：主线程卡住时 sendCommand 永不返回，等它等于把 ui.act
      // 又挂死一次（这一层存在的全部意义就是不许挂）。
      const call = d.sendCommand('Runtime.evaluate', {
        expression: pageProbe.PAGE_PROBE_JS,
        returnByValue: true,
      });
      const timer = new Promise((r) => setTimeout(() => r(null), 1500));
      const r = await Promise.race([call.catch(() => null), timer]);
      const v = r && r.result && r.result.value;
      return v && !v.__err ? v : null;
    } catch (_e) {
      return null;
    }
  }

  async executeAction(action, target, params = {}, tabId) {
    const ms = actionDeadlineMs(action, params);
    const tid = tabId !== undefined ? tabId : this.activeTab;
    this.touchTab(tid);
    // 见 navigate 里的同一句：动过手的页面不再是"启动页"。
    this._spendStartupPrivilege();
    // 本次动作的起始时刻：用来判断"有没有对话框是在这一次动作里被应答的"，
    // 并把结果写进回执（否则 agent 不知道点击中间弹过确认框）。
    const startedAt = Date.now();
    // 动作前先拍一张。为什么拍在 withDeadline 外面：deadline 只应该盖住动作
    // 本身，探针有它自己的 1.5s 上限，混进同一个预算会让"动作超时"和
    // "探针慢"两种完全不同的故障共用一个错误码。
    // canvas 页要先量一次"空闲时画布在不在动、动的时候内容一样不一样"。
    //
    // 采**三个**样本（仍在 IDLE_WINDOW_MS 附近，不是三倍等待），因为只看指纹差
    // 分不清两件事：页面在画**同一个**画面（稳定的动画循环），还是在画**不同**的
    // 画面（时钟指针、协作光标、直播）。前者用完整帧哈希照样能判"变了没有"，
    // 后者只能老实说"不可判"。判据在 page_probe.canvasVerdict 里，输入就是这三个样本。
    //
    // 代价只在有 canvas 指纹的页面上发生（普通页面一次都不多等）：这一层存在的
    // 意义是**不把"点了没反应"变成永远为真**——那是 page_probe 的原始动机。
    let idleSamples = [];
    if (pageProbe.shouldProbe(action)) {
      const first = await this._pageProbe(tid, action);
      if (first && typeof first.c === 'string') {
        idleSamples = [first];
        const gap = Math.max(20, Math.round(pageProbe.IDLE_WINDOW_MS / 3));
        for (let i = 0; i < 2; i++) {
          await new Promise((r) => setTimeout(r, gap));
          const one = await this._pageProbe(tid, action);
          if (one) idleSamples.push(one);
        }
      }
    }
    const probeBefore = await this._pageProbe(tid, action);
    try {
      const res = await withDeadline(
        this._executeActionInner(action, target, params, tabId),
        ms,
        `action:${action}`
      );
      let out = this._annotateActResult(res, action, target, tid);
      // 动作后拍第二张。settle 是必须的：paste/type 内部已经等过一轮，但 click
      // 触发的弹窗/路由要等框架提交 + 一帧渲染，立刻拍必然拿到旧指纹 ——
      // 那会把每一次成功的弹窗点击都误报成"页面没变"，比不报更糟。
      if (probeBefore) {
        await new Promise((r) => setTimeout(r, pageProbe.settleMs(action)));
        const probeAfter = await this._pageProbe(tid, action);
        // 动作之后再采一次。画面在动作结束后还在自己变 → 这一页会自漂，画布的
        // 变化不能归因给我的动作。为什么必须补这一刀：动作前的空闲窗口可能正好
        // 落在页面被后台节流冻住的时刻（Chromium 对不可见标签页把 rAF 降到 ~1fps），
        // 那时"空闲期没动"不代表"它不会动"，而动作本身会唤醒页面。
        // 只有画布页付这 150ms；其它页面的 probeAfter.c 是 null，直接跳过。
        let postBaseline = null;
        if (probeAfter && typeof probeAfter.c === 'string') {
          await new Promise((r) => setTimeout(r, pageProbe.IDLE_WINDOW_MS));
          postBaseline = await this._pageProbe(tid, action);
        }
        out = pageProbe.applyProbe(out, probeBefore, probeAfter, action, { idleSamples, postBaseline });
      }
      const dlg = this._dialogSince(tid, startedAt);
      if (dlg) out = { ...out, dialog: dlg };
      // 点"成功"了但页面没变，而目标自身不带文字（文字是从子节点拼出来的）——
      // 这是"树里有、点不动"最常见的一种：点在了包着一整段文字的容器上。
      // 只在这种组合下才去页面里找真正的归属节点：正常成功的点击不付这份代价。
      if (action === 'click' && out && out.success && out.page_changed === false && target) {
        const w = await this._wrapperHint(tid, target).catch(() => null);
        if (w) out = { ...out, wrapper: w, effect_hint: wrapperHintText(w) };
      }
      return out;
    } catch (e) {
      if (e && e.__deadline) {
        // 超时的第一种解释是"主线程忙"，但更常见也更致命的是**有对话框把渲染器
        // 冻住了**（alert/confirm 是原生 sheet，agent 看不见、也点不到）。
        // 这里先探测并按策略解开，再回报；不解开的话这条 tab 之后每条命令都会
        // 以同样的方式超时，agent 只会一路重试到放弃。
        const dlg = await this.recoverBlockedTab(tid).catch(() => null);
        // 明确告诉 agent 两件事：① 它该重试/换策略；② 这个动作**可能已经部分生效**
        // （超时时指针可能已经按下、字符可能已经输入了一半）—— 后者必须说，否则
        // agent 会以为页面没被动过而直接重试，造成双倍输入。
        return this._annotateActResult({
          success: false,
          error: dlg
            ? `blocked by a browser-level JS dialog (${dlg.type}) — it is a native sheet, not page DOM, and the page is frozen while it is open. It has been ${dlg.accept ? 'accepted' : 'dismissed'} automatically; re-read the tree before retrying.`
            : `${e.message} — the page's main thread is likely blocked; the action may have partially applied`,
          timed_out: true,
          deadline_ms: ms,
          action,
          ...(dlg ? { dialog: dlg, retry: 'verify_first' } : {}),
        }, action, target, tid);
      }
      throw e;
    }
  }

  /**
   * 动作回执的最终加工：补 effect_state / retry，以及 ref 过期诊断。
   *
   * 为什么集中在这一层而不是各分支里：_executeActionInner 有三十多处 return，
   * 逐个补等于逐个漏（这条教训在 ui.act 的超时兜底上已经吃过一次 —— 那里也是
   * 因为挂住的位置不止一个才上移到唯一出口）。唯一出口是唯一可靠的覆盖方式。
   */
  _annotateActResult(res, action, target, tid) {
    if (!res || typeof res !== 'object') return res;
    const extras = {};
    // 只有"目标找不到"这一种失败需要额外诊断 —— 其它错误跟 ref 无关。
    // 判定用 effect_state.js 导出的同一个函数，避免这里和分类器各写一套正则。
    const isTargetMiss = isTargetMissError(res.error);
    if (isTargetMiss && target) {
      try {
        const d = diagnoseMissingRef(target, this._refTracker(tid));
        extras.stale_ref = d.stale_ref;
        extras.ref_epoch = d.ref_epoch;
        extras.tree_epoch = d.tree_epoch;
        extras.ref_diagnosis = d.reason;
        // 具体的、可执行的下一步，直接给出来。诊断 hint 比通用错误文案更有用，
        // 所以这里覆盖 effect_hint 的位置由 withEffectState 之后合并。
        extras.ref_hint = d.hint;
        // 关键：ref 类失败一律不能算"照原样重试是安全的"。三种处境（过期 / 从没
        // 见过 / 树里有 DOM 里没有）都意味着**同一个调用再发一次一定还失败**，
        // 只是失败原因不同。effect_state 仍然是 none（确实没副作用），
        // 但 retry 必须改成 verify_first，否则等于告诉 agent"可以再来一遍"。
        extras.retry = 'verify_first';
      } catch (_) { /* 诊断失败不影响主回执 */ }
    }
    return withEffectState(res, extras);
  }

  /**
   * 「这个目标是不是个包着文字的容器」—— 是的话返回那段文字真正的归属节点。
   *
   * 为什么只在 click 且 page_changed=false 时才跑：这是"点不动"的信号，
   * 正常成功的点击没有理由再做一次页面扫描。诊断永远不能成为常开开销。
   * 任何异常/超时都吞掉（返回 null）：观测能力不足不能让动作本身失败。
   */
  async _wrapperHint(tid, target) {
    const js = wrapperHintExpr(target);
    const v = await withDeadline(this.evaluate(js, tid), 1500, 'wrapper_hint').catch(() => null);
    if (!v || !v.is_wrapper) return null;
    return v;
  }

  async _executeActionInner(action, target, params = {}, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { success: false, error: 'Tab not found' };
    // 本次动作的开始时刻。用来判断"这个新标签是不是**这次**动作打开的" ——
    // _openedTabs 里的条目可能来自更早的一次 window.open（例如 ui.evaluate 里
    // 调 el.click() 触发的那种：它没有经过 act，所以没人消费那条记录）。
    // 之前没有这个时间戳，陈旧条目会被下一次点击/悬停当成"我刚开了个标签"，
    // 导致 opened_tab 报一个与本次操作无关的 tab（实测：hover 报出上一次
    // 「进入学习」打开的 about:blank）。
    const actionStartedAt = Date.now();
    // press 是唯一不要求目标的动作：快捷键通常挂在 document/window 上（删除节点、
    // 撤销重做、取消选中），发给"当前焦点"就是正确语义。
    // drag 给了显式起点坐标（params.from）时同样不要求目标 —— "从空白处起拖"正是
    // 平移画布、框选这类操作的表达，而空白画布上根本没有可寻址的元素。
    // wheel 也不要求目标：不指定就落在视口中心（缩放画布正是这样用的）。
    const hasExplicitDragFrom = action === 'drag' && params.from && Number.isFinite(Number(params.from.x));
    const targetOptional = action === 'press' || action === 'wheel' || hasExplicitDragFrom;
    if (!target && !targetOptional) return { success: false, error: 'No target' };
    target = target || '';

    // target 形状体检：传了可见文字（"发布"）而不是 data-ai-id 时，这里就明说。
    // 否则要等到 `[data-ai-id="发布"]` 查空，回一句不带方向的
    // "Target not found"，调用方很难想到真正原因是形状错了。
    if (target) {
      // upload 额外接受 CSS 选择器：上传控件经常没有 data-ai-id（纯 div 的
      // 「本地上传」），只能靠选择器定位。其它动作仍只认 ref —— 放行一个
      // 它们解析不了的选择器，只会把失败推到更远、信息更少的地方。
      const shapeErr = refGuard.refShapeError(target, { allowSelector: action === 'upload' });
      if (shapeErr) return { success: false, error: shapeErr, method: 'bad-target-shape' };
    }

    // 只读分支：取 node.value 的完整内容（树里只给前 200 code point）。
    // 不聚焦、不触发 input/change、不改页面，也不走输入动作的 fallback。
    if (action === 'get_value') return await this._getValue(view, target, params, tid);

    // CDP 受信输入优先（像人操作：受信点击/键盘/文本，对任何框架通用），
    // 无 debugger 时回退 preload 合成事件。
    if (action === 'click' || action === 'hover') {
      // #2: 按目标 URL 点击（复合卡片的通用解法）——agent 想看"点了会去哪个 URL"
      // 就指定 params.url，不靠猜 label 命中卡片里的多个 <a>。先走 URL→链接定位；
      // 未给 url 才退回元素指针点击（原路径，不回归）。
      if (params.url && action === 'click') {
        try {
          await this._ensureAxHandles(view, tid);
          const res = await this._resolveClickByUrl(view, target, params.url, tid);
          if (!res || !res.success) return { ...(res || {}), success: false, opened_tab: null };
          // #3: 若此点击触发了 window.open → 新 tab，记录并默认接管焦点。
          res.opened_tab = await this._awaitOpenedTab(tid, params.keep_tab === true, actionStartedAt, params, target);
          return res;
        } catch (e) {
          return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
        }
      }
      try {
        await this._ensureAxHandles(view, tid);
        const via = await this._cdpPointerTarget(view, action, target, tid);
        if (via) {
          const opened = await this._awaitOpenedTab(tid, params.keep_tab === true, actionStartedAt, params, target);
          return { success: true, clicked_via: via, target, opened_tab: opened };
        }
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'type' || action === 'setContent' || action === 'clear') {
      try {
        await this._ensureAxHandles(view, tid);
        // clear 也走 CDP 受信输入链路（空文本即清空+校验）。顶层预加载 clear 用
        // innerHTML="" 只对顶层元素生效；OOPIF 子帧元素 querySelector 命中不到，
        // clear 会静默落空。路由到这里后 OOPIF 走 _clearInFrame(execCommand
        // selectAll+delete)，顶层走 _selectAllFallback+受信 Delete，均带校验。
        // 语义分工（此前 type 与 setContent 完全等价，都是整篇替换 —— 插入话题
        // 标签后再输入正文会把标签清掉，无法续写）：
        //   type       = 在光标处追加（默认末尾），不碰已有内容
        //   setContent = 整篇替换（全选 → 删除 → 输入）
        //   clear      = 全选删除
        // 想重填一个输入框请显式 setContent（或先 clear 再 type）。
        const r = await this._inputViaCdp(
          view,
          target,
          action === 'clear' ? '' : (params.text || ''),
          tid,
          { replace: action !== 'type', at: params.at || 'end' }
        );
        if (r) return r;
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'paste') {
      // 富文本粘贴：把 text/html 经合成 ClipboardEvent 送进编辑器，Draft.js /
      // ProseMirror / Quill 的粘贴处理器会完成格式转换（与真人粘贴等效）。
      // 支持 OOPIF 子帧（B站 read-editor 那种 ui.evaluate 到不了的上下文）。
      try {
        await this._ensureAxHandles(view, tid);
        const r = await this._pasteViaCdp(view, target, params, tid);
        if (r) return r;
      } catch (e) { /* fall through to preload */ }
    } else if (action === 'upload') {
      try {
        await this._ensureAxHandles(view, tid);
        const r = await this._uploadViaCdp(view, target, params.file || '', tid);
        if (r && r.success !== false) return r;
      } catch (e) { /* fall through */ }
      // CDP 的 DOM.setFileInputFiles 只能写顶层文档里的 input；跨进程 iframe 里的
      // 上传控件（B站封面、编辑器插图等都属于这一类）必须走帧内注入。
      try {
        const r = await this._uploadViaFrameJs(view, target, params.file || '', tid);
        if (r) return r;
      } catch (e) { /* fall through */ }
      // 无 CDP 时 preload 无法真正赋值文件（受安全限制），返回失败让 agent 感知。
      return { success: false, error: 'Upload requires CDP (input file set) — no file input found for target ' + JSON.stringify(String(target || '')) };
    } else if (action === 'drag') {
      try {
        const r = await this._cdpDrag(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      // 拖拽没有 preload 等价物：合成 PointerEvent 不被采用 Pointer Capture 的
      // 应用信任（实测 React Flow 上 moved 恒为 0），因此明确报错而不是假装成功。
      return { success: false, error: 'Drag requires CDP — the debugger is not attached to this tab' };
    } else if (action === 'wheel') {
      try {
        const r = await this._cdpWheel(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      return { success: false, error: 'wheel requires CDP — the debugger is not attached to this tab' };
    } else if (action === 'press') {
      try {
        const r = await this._cdpPress(view, target, params, tid);
        if (r) return { ...r, opened_tab: null };
      } catch (e) {
        return { success: false, error: String((e && e.message) || e).slice(0, 200), opened_tab: null };
      }
      return { success: false, error: 'press requires CDP — the debugger is not attached to this tab' };
    }

    const preloadRes = await this._executeViaPreload(action, target, params, tid);
    // preload 只在**顶层文档**里查 data-ai-id。目标住在跨进程帧里时，它必然
    // 报 Target not found —— 而树里明明有那个 ref（focus 就是这样：click/type
    // 各自有 OOPIF 分支，focus 没有）。这里补一次帧内原生动作，只在"找不到"
    // 时触发，不去抢其它失败原因的处理权。
    if (preloadRes && preloadRes.success === false && isTargetMissError(preloadRes.error)) {
      const inFrame = await this._actInOwningFrame(view, action, target, tid);
      if (inFrame) return inFrame;
    }
    // preload 合成点击也可能触发 window.open → 新 tab，同样回报 opened_tab。
    if (action === 'click' && preloadRes && preloadRes.success) {
      preloadRes.opened_tab = await this._awaitOpenedTab(tid, params.keep_tab === true, actionStartedAt, params, target);
      // 路径可区分：CDP 受信点击报 clicked_via='cdp-click'，回退路径报
      // 'preload-click'。两种都只报 success 的话，agent（和人）无从判断这一下
      // 到底是真实输入还是合成事件 —— 双发 bug 正是靠这个字段才暴露出来的。
      preloadRes.clicked_via = 'preload-click';
    }
    return preloadRes;
  }

  // === 帧内原生动作（跨进程子帧里那些"preload 够不到"的动作）===
  // 只处理少数几个有明确原生等价物的动作，并且**只在顶层报 target miss 后**
  // 调用。返回 null 表示"不是我该管的"，让原错误照常上报。
  // 为什么不在这里补 type/paste/upload：它们各自有 OOPIF 分支（受信输入、
  // 合成 ClipboardEvent、DOM.setFileInputFiles），抢过来只会绕开那些更可靠的实现。
  async _actInOwningFrame(view, action, target, tabId) {
    if (action !== 'focus' && action !== 'click') return null;
    let frame = null;
    try { frame = await this._owningFrameFor(view, target, tabId); } catch (_) { frame = null; }
    if (!frame) return null;
    const js = `(function(){
      var el=${findRefExpr(JSON.stringify(String(target)))};
      if(!el) return {__miss:true};
      if(${JSON.stringify(action)}==='focus'){
        try{ el.scrollIntoView({block:'nearest',behavior:'instant'}); }catch(e){}
        try{ el.focus(); }catch(e){}
        return {success:true, focused: document.activeElement===el};
      }
      try{ el.scrollIntoView({block:'center',behavior:'instant'}); }catch(e){}
      try{ el.click(); }catch(e){ return {success:false, error:String(e&&e.message||e).slice(0,200)}; }
      return {success:true};
    })()`;
    try {
      const r = await frame.executeJavaScript(js);
      if (!r || r.__miss) return null;
      if (r.success === false) return { success: false, error: r.error || 'frame action failed', method: 'frame-js' };
      const out = { success: true, target, method: 'frame-js' };
      if (action === 'click') out.clicked_via = 'frame-native';
      else out.focused = r.focused !== false;
      return out;
    } catch (e) {
      return null;
    }
  }

  // === 只读取全量 node.value（ui.act {action:'get_value'}）===
  // 语义树里 node.value 只给前 200 Unicode code point；超长的节点带
  // value_fetch 提示，调用方用它取全量（支持 offset/limit 分页）。
  // 严格只读：不聚焦、不派发 input/change、不改 DOM，也不走输入动作 fallback。
  async _getValue(view, target, params, tabId) {
    const p = params || {};
    const offset = Math.max(0, Number(p.offset) || 0);
    const limit = (p.limit === undefined || p.limit === null) ? undefined : Number(p.limit);
    // target 经 JSON.stringify 变成双引号 JS 字面量，拼进单引号选择器里 —— 无法
    // 通过 target 内容跳出字符串。
    const js =
      "(function(){"
      + "var el=" + findRefExpr(JSON.stringify(String(target))) + ";"
      + "if(!el)return {__miss:true};"
      + "var tag=(el.tagName||'').toUpperCase();"
      + "if(tag==='INPUT'){var ty=String(el.type||'').toLowerCase();"
      + "if(ty==='password')return {__sensitive:'password'};"
      + "if(ty==='file')return {__sensitive:'file'};"
      + "return {text:el.value==null?'':String(el.value)};}"
      + "if(tag==='TEXTAREA')return {text:el.value==null?'':String(el.value)};"
      + "if(tag==='SELECT'){var o=el.selectedOptions&&el.selectedOptions.length?el.selectedOptions[0]:null;"
      + "return {text:o?String(o.value||o.textContent||''):String(el.value||'')};}"
      + "if(el.isContentEditable===true||(el.getAttribute&&el.getAttribute('contenteditable')==='true'))"
      + "return {text:String(el.innerText||el.textContent||'')};"
      + "if(typeof el.value==='string')return {text:el.value};"
      + "return {text:String(el.innerText||el.textContent||'')};"
      + "})()";

    const run = async () => {
      // OOPIF：在所属子帧上下文里执行（顶层 querySelector 看不到跨进程 iframe）。
      if (/^axf-/.test(target)) {
        const frame = await this._owningFrame(view, target);
        if (frame) {
          try { return await frame.executeJavaScript(js); } catch (e) { /* fall through */ }
        }
      }
      try { return await this.evaluate(js, tabId); } catch (e) { return null; }
    };

    let raw = await run();
    if (!raw || raw.__miss) {
      // AX 读层的 handle 是按需 stamp 的（ensureHandles）—— 从未 act 过的节点
      // DOM 上可能还没有 data-ai-id。补一次再读，仍没有才报 not found。
      await this._ensureAxHandles(view, tabId);
      raw = await run();
    }
    if (!raw || raw.__miss) return { success: false, error: 'target_not_found: no element with data-ai-id=' + String(target) };
    if (raw.__sensitive) return { success: false, error: 'sensitive_value_not_readable: input[type=' + raw.__sensitive + '] is never exposed' };
    if (typeof raw.text !== 'string') return { success: false, error: 'target_has_no_value' };
    const sliced = valueContract.getValueResult(raw.text, offset, limit);
    return { success: true, target, ...sliced };
  }

  // #3 helper: read & clear the "new tab opened by this source tab" entry.
  // Returns { id, url } or null. Unless keep===true, auto-activates the new tab.
  //
  // startedAt（可选）：本次动作的开始时刻。只有**在这之后**记录的条目才算
  // "这次动作开的"。没有它时，任何没被 act 消费的记录（例如 ui.evaluate 里
  // el.click() 触发的 window.open）会一直挂在 map 里，被下一次点击/悬停
  // 误当成"刚开的标签"。陈旧条目在读取时顺带清掉，避免长期堆积。
  _consumeOpenedTab(tid, keep, startedAt) {
    const entry = this._openedTabs.get(tid);
    this._openedTabs.delete(tid);
    const mine = pickOpenedTab(entry, startedAt);
    if (!mine) return null;
    // 「自动跟随」是**目标**跟过去，不是**视野**跟过去：
    //   - 人在看这一页（opener 就是可见 tab）→ 照浏览器惯例把新标签切出来；
    //   - opener 是后台页 → 只把调用方的目标挪过去（ws 层据回执 opened_tab 绑定），
    //     人眼前的页面一动不动。
    // 这条以前是无条件 setActive，等于"agent 点任何 target=_blank 的链接，
    // 用户的视野就被拽走一次"。
    if (keep !== true && tid === this.activeTab) this.setActive(mine.id);
    // 记录里的 url 是**建标签那一刻**的值。window.open("") 这条路上它永远是
    // 'about:blank' —— 真实地址由随后的 ai:window_open_nav 才载入。直接回
    // 'about:blank' 会让 agent 以为"打开了个空白页"，这恰恰是当初那个 bug 的样子。
    // 所以这里读一次实时 URL：已经导航了就用真地址，还没导航就明说 pending。
    let url = mine.url;
    let pending = false;
    try {
      const view = this._getView(mine.id);
      const live = view && view.webContents.getURL();
      if (live && live !== 'about:blank') url = live;
      // 仍然没有真实地址（占位页还没被导航）→ 明说 pending，而不是回一个
      // 看起来像"空白页"的 about:blank。
      if (!url || url === 'about:blank') pending = true;
    } catch (_) { /* 读不到就维持记录里的值 */ }
    const out = { id: mine.id, url };
    if (pending) out.url_pending = true;
    return out;
  }

  /**
   * 点完**等一下**再收新标签记录（只给 click 用）。
   *
   * 为什么需要：实测（见 shared/opened_tab.js 顶部）点击派发后 105~119ms 才出现
   * 新标签，而 act 在 10~15ms 就返回了 —— 回执里的 `opened_tab: null` 是**错的**，
   * agent 会据此认为"点了没反应"，然后重试。
   *
   * 代价：不开标签的点击会等满宽限窗口（默认 150ms，可关）。所以这里是
   * 「先看一眼，有就立刻返回」，只有确实没有记录时才进入轮询。
   */
  async _awaitOpenedTab(tid, keep, startedAt, params, target) {
    const graceMs = openedTabGraceMs(params);
    // 快路径 1：已经有属于本次动作的记录，零等待。
    if (pickOpenedTab(this._openedTabs.get(tid), startedAt) || graceMs <= 0) {
      return this._consumeOpenedTab(tid, keep, startedAt);
    }
    const view = this._getView(tid);
    // 快路径 2：本 tab 已经开始原地导航 —— 站内跳转不会同时开新标签，别等。
    // 这一类（点链接跳走）是最高频的点击，跳过它等于让绝大多数点击零额外成本。
    if (view && view.webContents.isLoading()) {
      return this._consumeOpenedTab(tid, keep, startedAt);
    }
    // 快路径 3：目标不是链接 → 不等。
    // 实测代价：等待是加在**每一个**点击上的，点段落这种不导航的点击从 7ms 变成
    // 261ms。而"点开新标签"在实际站点上几乎都发生在 <a> 上（window.open 的按钮
    // 弹层也存在，但少），所以用 tagName 做闸门：探一次开销约几毫秒，换来把
    // 250ms 的税从绝大多数点击上摘掉。
    // 非链接的弹层场景由调用方显式传 opened_tab_wait_ms 打开等待。
    const explicitWait = params && params.opened_tab_wait_ms !== undefined && params.opened_tab_wait_ms !== null;
    if (!explicitWait && !(await this._targetIsLink(view, target, tid))) {
      return this._consumeOpenedTab(tid, keep, startedAt);
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (pickOpenedTab(this._openedTabs.get(tid), startedAt)) break;
      // 等待期间页面开始导航了，同样立刻收工。
      if (view && view.webContents.isLoading()) break;
    }
    return this._consumeOpenedTab(tid, keep, startedAt);
  }

  /**
   * 目标是不是 <a>。只用于决定"要不要为开新标签等一会儿"。
   *
   * 探不到（元素已被 SPA 重渲染掉、帧不可达）一律按"不是链接"处理：
   * 宁可少等一次（回到原来的漏报），也不要为一个不确定的目标付 250ms。
   */
  async _targetIsLink(view, target, tid) {
    if (!view || !target) return false;
    try {
      const owning = await this._owningFrameFor(view, target, tid);
      const expr = `(function(){var el=${findRefExpr(JSON.stringify(String(target)))};` +
        `return el?String(el.tagName||'').toUpperCase():null;})()`;
      // 用 this.evaluate（与 _owningFrameFor 同一口径：直接给值），不要用
      // _evaluateViaCdp —— 那里回的是 {result:{value}} 包裹，比一次就永远判成
      // "不是链接"，闸门形同虚设（第一版就踩了这个）。
      const tag = owning ? await owning.executeJavaScript(expr) : await this.evaluate(expr, tid);
      return tag === 'A';
    } catch (_) {
      return false;
    }
  }

  // #2: 按目标 URL 定位并点击链接 —— 通用替代"猜卡片里的 <a>"。顶层在
  // Runtime.evaluate 里找 a[href] 精确匹配 url（或 host/path 子串），命中即
  // scrollIntoView+focus+click（link 原生 click 可靠）；OOPIF(target 为 axf-…)
  // 在所属帧内用同一逻辑。无 url 传参/找不到返回 clean error。
  async _resolveClickByUrl(view, target, url, tabId) {
    if (!view || !url) return { success: false, error: 'no url provided' };
    const owning = await this._owningFrameFor(view, target, tabId);
    const expr = `(function(url){
        var best=null,bestScore=-1;
        var als=document.querySelectorAll('a[href]');
        for(var i=0;i<als.length;i++){
          var a=als[i], h=a.href||'';
          if(!h)continue;
          // 精确匹配优先，其次 host+path 子串（容忍站点改写查询串/协议）。
          var s = (h===url) ? 3 : (h.indexOf(url)>0 ? 2 : (url.indexOf(h)>0 ? 1 : 0));
          // 子串还要继续看 path 是否一致，避免 /video 与 /video/xxx 互误伤
          if(s===2&&(h.split('#')[0].split('?')[0]!==url.split('#')[0].split('?')[0]))s=1;
          if(s>bestScore){bestScore=s;best=a;}
        }
        if(!best||bestScore<=0)return {ok:false};
        best.scrollIntoView({block:'center',behavior:'instant'});
        best.focus();best.click();
        return {ok:true,matched:best.href||url};
      })(${JSON.stringify(url)})`;
    // OOPIF / 顶层统一：resolve 结果空串归一为 null；跨帧走 executeJavaScript。
    const result = owning
      ? await owning.executeJavaScript(expr)
      : await this._evaluateViaCdp(view, expr);
    if (!result || !result.ok) return { success: false, error: 'no link matches url: ' + url };
    return { success: true, clicked_via: 'urllink', matched: result.matched || url };
  }

  async _executeViaPreload(action, target, params, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { success: false, error: 'Tab not found' };

    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:action', { action, target, params, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          resolve({ success: false, error: 'Action timeout' });
        }
      }, 5000);
    });
  }

  async getFocused(tabId) {
    const result = await this.getTree(true, tabId);
    return result?.tree?.focused_element_id || null;
  }

  async evaluate(js, tabId, opts = {}) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) throw new Error('Tab not found');

    // OOPIF routing. Two ways in, explicit beats implicit:
    //   opts.frameRef  — caller passes the axf-... ref directly. Reliable:
    //     works no matter how the JS string was built.
    //   literal match  — the old behavior: /data-ai-id="(axf-...)/ inside the
    //     JS source. Kept for compatibility, but it is a trap: a caller that
    //     builds the selector by concatenation ('[data-ai-id="' + ref + '"]')
    //     produces no literal, routing silently does not happen, and the
    //     top-frame evaluate returns null for an element that exists.
    //     Hit for real during the P1-2 rollout.
    const frameRef = opts.frameRef || (/data-ai-id="(axf-\d+-\d+)"/.exec(js) || [])[1];
    if (frameRef) {
      const frame = await this._owningFrame(view, frameRef);
      if (frame) {
        try { return await frame.executeJavaScript(js.startsWith('(') ? js : `(function(){return ${js};})()`); }
        catch (e) {
          // 帧找到了、但脚本自己抛了异常。不能继续走下面的 frame_not_found ——
          // 那会把"脚本报错"误报成"引用失效"，把调用方引到"反复重读树"的死路上。
          // 实测踩过：上传脚本里一个 TypeError 被包装成 frame_not_found，白查了半天。
          if (opts.frameRef) {
            throw new Error('frame_eval_failed: ' + String((e && e.message) || e).slice(0, 300));
          }
          /* 自动推导出的 ref：允许回落到顶层路径 */
        }
      }
      // 显式给了 frameRef 却找不到帧：不能静默落到顶层 —— 调用方会拿到 null
      // 并以为"元素不存在"。明说是路由失败。
      if (opts.frameRef) {
        throw new Error('frame_not_found: no cross-process frame owns ' + String(opts.frameRef)
          + ' — the ref may be stale (page re-rendered). Re-read the tree and retry.');
      }
    }
    // Preferred path: CDP Runtime.evaluate. It runs on the DevTools protocol
    // channel and is NOT subject to the page's CSP code-generation (eval)
    // restrictions, so it works on strict sites (Bing, Gmail, ...) where the
    // in-page `eval()` used by the preload bridge is blocked. It runs in the
    // page's main world, identical privilege to the page's own JS (no Node:
    // nodeIntegration:false + contextIsolation:true are unchanged).
    try {
      return await this._evaluateViaCdp(view, js);
    } catch (e) {
      // Fallback: the original preload (ai:evaluate) path, for views without a
      // usable CDP debugger (and for the vitest unit tests that mock IPC).
      return await this._evaluateViaPreload(view, js);
    }
  }

  // Execute JS via chromedebugger + Runtime.evaluate on a per-tab webContents.
  async _evaluateViaCdp(view, js) {
    const wc = view.webContents;
    const dbg = wc && wc.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function') throw new Error('no-cdp');
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (e) {
      // Already attached (e.g. by the network monitor); reuse the same session.
    }
    const cmd = dbg.sendCommand('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
      // awaitPromise:true —— 调用方在页面里写 async/await 是常态（等一个请求、
      // 等一帧渲染、等编辑器提交），此前是 false，于是 async IIFE 原样返回
      // 一个 Promise 对象，序列化后调用方看到 **{}**，会以为"页面什么都没
      // 返回"。实测症状：往掘金标签框写"已选中"的探测脚本明明 await 了网络
      // 响应，回执却是空对象，据此得出"标签没选上"的错误结论。
      // 对非 thenable 表达式此参数无副作用（CDP 直接返回值本身）。
      awaitPromise: true,
    });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('cdp evaluate timeout')), 5000));
    const res = await Promise.race([cmd, timeout]);
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      const msg = (ex && (ex.description || ex.value)) || res.exceptionDetails.text || 'evaluate error';
      throw new Error(String(msg).slice(0, 300));
    }
    const r = res && res.result;
    if (r && r.subtype === 'error') throw new Error(String(r.description || 'evaluate error').slice(0, 300));
    return r ? r.value : undefined;
  }

  _evaluateViaPreload(view, js) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      view.webContents.send('ai:evaluate', { js, id });
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error('evaluate timeout'));
        }
      }, 5000);
    });
  }

  // === CDP 受信输入（通用化，无框架特判）===
  // 任何网页/富文本/编辑器（Draft、ProseMirror、Quill、antd、shadcn…）都无需
  // 专项适配：点击/键盘/文本全部走 Chromium 真实输入管线（受信事件），等价于
  // 真实用户操作。识别层面只判断"是不是可编辑区"（contenteditable / input /
  // textarea），不嗅探任何框架类名；失败只返回错误让 agent 重新读取重试。

  _canCdp(view) {
    try {
      const d = view.webContents.debugger;
      return !!(d && typeof d.isAttached === 'function');
    } catch(e) { return false; }
  }

  async _cdpKey(inputCmd, p, opts) {
    // 「按键的默认动作」要的是 keypress，不是 keydown。决策本身抽在
    // shared/key_dispatch.cjs（纯函数，可单测），这里只负责按计划派发。
    // 两种语义：
    //   opts.activate = true  （ui.act press 用）→ 带 text 的 keyDown，产生默认动作
    //   否则（type 里的段间换行/删除）→ 保持 rawKeyDown，行为不变
    const plan = keyDispatchPlan(p, opts);
    const base = {
      windowsVirtualKeyCode: p.vk,
      nativeVirtualKeyCode: p.vk,
      code: p.code,
      key: p.key,
      text: p.text || '',
      modifiers: p.mod || 0,
    };
    if (plan.type === 'keyDown') {
      // keyDown 带 text：一次派发同时产出 keydown 与 char，等价真实按键。
      await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: plan.text });
    } else {
      await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      // CDP 的 rawKeyDown 会忽略 text —— 带字符的键（换行）必须再发一个带
      // text 的 char 事件才会真的把字符插进去，否则 Enter 在 textarea /
      // 原生 contenteditable 里不产生任何换行（"a\nb\nc" 静默变成 "abc"）。
      if (plan.charText) await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'char' });
    }
    await inputCmd('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // 解析某个 data-ai-id 属于哪个帧。**不能只认 axf- 前缀**：
  // DOM 抽取器会给同源 iframe 里的元素也写上普通的 data-ai-id（写在 iframe 自己的
  // document 上），这些 id 在顶层 document 里查不到 —— 实测 ComfyUI 的工具栏按钮
  // （节点库 / Zoom In / Fit View）就是这样，ui.act 一直报 "Target not found"。
  // 所以这里先看顶层，找不到再逐个帧找。返回 null 表示就在主帧里。
  async _owningFrameFor(view, aiId, tabId) {
    if (!aiId) return null;
    // `frame-N` 是合并门节点，页面里没有对应元素，别浪费一次顶层查询。
    if (/^axf-/.test(aiId) || /^frame-\d+$/.test(aiId)) return await this._owningFrame(view, aiId);
    try {
      const inTop = await this.evaluate(
        `!!${findRefExpr(JSON.stringify(aiId))}`,
        tabId
      );
      if (inTop) return null;
    } catch (e) { /* 顶层查询失败就继续找帧 */ }
    return await this._owningFrame(view, aiId);
  }

  // Locate the frame that owns a sub-frame handle (`axf-{frameSeq}-{idx}`).
  // Returns the WebFrameMain, or null when the handle lives in the main frame
  // (or is unlocatable) — callers fall back to the top-frame path.
  async _owningFrame(view, aiId) {
    const root = view.webContents.mainFrame;
    const frames = root && root.framesInSubtree ? root.framesInSubtree : [];
    // 树里暴露的 `frame-N` 是合并出来的门节点（axExtractor.mergeFrameTrees 的
    // gate），它在页面里**没有对应元素**。此前这里只会按 [data-ai-id] 找，于是
    // `{frame_ref:"frame-1"}` 必然报 frame_not_found —— 树里写着 frame-1，用起来
    // 说不存在。序号口径与 _readOopifFrames 一致（见 shared/frame_probe.pickSubframe）。
    const subs = frames.filter((f) => f !== root);
    const gateFrame = frameProbe.pickSubframe(subs, aiId);
    if (gateFrame || frameProbe.gateFrameIndex(aiId) != null) return gateFrame;
    for (const frame of frames) {
      if (frame === root) continue;
      try {
        const has = await frame.executeJavaScript(
          `!!${findRefExpr(JSON.stringify(aiId))}`
        );
        if (has) return frame;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  // OOPIF coordinate translation: sub-frame getBoundingClientRect is relative to
  // the iframe's own layout viewport; add the hosting <iframe> element's top-left
  // (top document) to get browser-viewport coordinates for Input.dispatchMouseEvent.
  // 找到承载某个子帧的 <iframe> 元素，顺便判断它是否**同源**（同源通常意味着进程内，
  // 坐标 + CDP 真实鼠标事件可用；跨进程 OOPIF 则只能用帧内原生 .click()）。
  async _hostIframe(view, frame, tabId) {
    try {
      const path = await frame.executeJavaScript('(location.pathname||"")');
      const info = await this.evaluate(
        `(function(path){
           var best=null;
           Array.prototype.forEach.call(document.querySelectorAll('iframe'),function(f){
             var r=f.getBoundingClientRect();
             if(r.width<4||r.height<4)return;
             var s=f.src||'';
             var match = (f.name&&f.name.length) ? (path.indexOf((f.name||''))===0) : (s.indexOf(path)>=0);
             if(!match) return;
             var sameOrigin=false;
             try { sameOrigin = !!(f.contentDocument && f.contentDocument.body); } catch(e) { sameOrigin=false; }
             best={x:Math.round(r.left),y:Math.round(r.top),sameOrigin:sameOrigin};
           });
           return best;
         })(${JSON.stringify(path)})`,
        tabId);
      return info;
    } catch (e) { return null; }
  }

  async _frameOffset(view, frame, tabId) {
    const info = await this._hostIframe(view, frame, tabId);
    return info ? { x: info.x, y: info.y } : null;
  }

  // 受信鼠标事件：先把元素滚入视口（屏外元素直接 dispatchMouseEvent 时坐标落在
  // 视口外，事件命中 body/空白处——探针证实点击不聚焦却误报成功），再按滚动后的
  // 中心点发 mousemove → mousePressed/mouseReleased（click）或仅 move（hover）。
  // OOPIF 目标：定位在所属 frame 内执行，坐标 + frame 偏移换算到顶层视口。
  async _cdpPointerTarget(view, action, aiId, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const inFrame = !!owning;
    // 帧内 click 的两种走法，必须分开：
    //   · **同源（进程内）子帧** → 走下面的坐标 + CDP 真实鼠标事件。
    //     实测 ComfyUI 工具栏的 Zoom In 只监听 mousedown/pointerdown，帧内原生
    //     el.click() 完全不生效（而 Fit View 只监听 click，el.click() 才生效）——
    //     合成事件覆盖不了全部按钮，真实鼠标事件才能。
    //   · **跨进程 OOPIF** → 沿用帧内原生 .click()：CDP 坐标对跨进程子帧的命中/路由
    //     不稳（实测报告成功却未触发），原生 .click() 贴合编辑器 React click 语义。
    if (inFrame && action === 'click') {
      try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
      } catch (e) {}
      let host = null;
      try { host = await this._hostIframe(view, owning, tabId); } catch (e) { host = null; }
      if (host && host.sameOrigin) {
        // 落到这里，走与 hover 相同的坐标路径（真实 mousemove/press/release）
      } else {
        try {
          const ok = await owning.executeJavaScript(
            `(function(){var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return false;` +
            `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
            `el.focus();el.click();return true;})()`);
          return ok ? 'oopif-click' : null;
        } catch (e) { return null; }
      }
    }
    // 定位 → 滚入视口居中 → 返回滚动后的中心点（frame 内局部坐标）。
    const center = inFrame
      ? await owning.executeJavaScript(
          `(function(){var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return null;` +
          `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
          `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`)
      : await this.evaluate(
          `(function(){var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return null;` +
          `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
          `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
          tabId);
    if (!center) return null;
    // frame 局部 → 顶层视口坐标
    let vp = center;
    if (inFrame) {
      const off = await this._frameOffset(view, owning, tabId);
      if (off) vp = { x: center.x + Math.round(off.x), y: center.y + Math.round(off.y) };
    }
    try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
    } catch(e) {}
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    // 命中校验必须在派发【之前】做，且派发成功就不再回退 —— 否则一次 act 会点两次。
    // 事后校验的致命漏洞：mousePressed/mouseReleased 一发出，点击就已生效；而"点了
    // 之后自身消失/收起"的目标（话题候选收起列表、提交后置灰、菜单项、@提及、点赞）
    // 此刻已经被自己点没了，命中探测必然拿不到 → 返回 null → executeAction
    // 回退 preload 再点一次 → DOM 上出现两份插入/两次提交。派发前的坐标命中才是
    // "这一下会不会落在目标上"的唯一可信判断；校验失败（被遮挡/屏外/已隐藏）才回退。
    //
    // 命中探测必须穿透 shadow：不穿透的话，影子内部的元素（B站 整块评论区装在
    // <bili-comments> 里）永远返回宿主 → contains 判定 false → 每次点击都静默
    // 降级成非受信的 el.click()。降级本身不报错，所以表现为"能点但对某些编辑器
    // 没反应"。hitTestExpr 同时把 contains 换成含 shadow 的祖先判定。
    if (action === 'click') {
      const hitJs = hitTestExpr(JSON.stringify(aiId), String(center.x), String(center.y));
      const hit = inFrame
        ? await owning.executeJavaScript(hitJs)
        : await this.evaluate(hitJs, tabId);
      if (!hit) return null; // 坐标落不到目标上 —— 交给 preload 的 focus()+click 兜底
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
    if (action === 'click') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x, y: vp.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    // 走到这里说明受信点击已经真实派发成功 —— 绝不回退 preload 再点第二次。
    return action === 'hover' ? 'cdp-hover' : 'cdp-click';
  }

  // 受信滚轮（ui.act {action:'wheel'}）。
  //
  // 为什么需要：`ui.scroll` 只是 `window.scrollBy`，对**画布类应用完全无效** ——
  // 无限画布/地图/图表靠 wheel 事件缩放与平移，而不是文档滚动。实测在 rhtv 画布上
  // ui.scroll 一点用都没有，agent 因此既看不见全图、也缩不进去。
  //   params.dy < 0 → 向上滚 / 缩小；> 0 → 向下滚 / 放大（配合 hold:['Control']）
  //   params.dx     横向滚动
  //   params.at     显式落点坐标；否则落在 target 元素中心（先滚入视口），再否则视口中心
  //   params.keys   修饰键（画布缩放通常要 Control）
  async _cdpWheel(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}

    const dims = await run('return {w:window.innerWidth,h:window.innerHeight};');
    let at = null;
    if (params.at && Number.isFinite(Number(params.at.x))) {
      at = { x: Math.round(Number(params.at.x)), y: Math.round(Number(params.at.y)) };
    } else if (aiId) {
      // 穿透 shadow：目标在 Web Component 里时 document.querySelector 够不着，
      // 落点会静默退化成视口中心 —— 滚轮打到完全无关的地方，还报成功。
      const c = await run(
        `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return null;` +
        `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});` +
        `var r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};`
      );
      if (c) at = c;
    }
    if (!at) at = { x: Math.round(dims.w / 2), y: Math.round(dims.h / 2) };
    if (at.x < 0 || at.y < 0 || at.x > dims.w || at.y > dims.h) {
      return { success: false, error: `wheel: point (${at.x},${at.y}) is outside the viewport (${dims.w}x${dims.h})`, at };
    }

    const dx = Number(params.dx) || 0;
    const dy = Number(params.dy) || 0;
    if (!dx && !dy) {
      return { success: false, error: 'wheel: need dx or dy (e.g. dy:-600 zooms/pans up; add hold:["Control"] for canvas zoom)' };
    }
    const mod = modifierMask(params.hold || params.keys);
    const steps = Math.min(20, Math.max(1, Number(params.steps) || 1));
    const dbg = view.webContents.debugger;
    for (let i = 0; i < steps; i++) {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: at.x,
        y: at.y,
        deltaX: Math.round(dx / steps),
        deltaY: Math.round(dy / steps),
        modifiers: mod,
      });
      if (steps > 1) await new Promise((r) => setTimeout(r, 30));
    }
    return { success: true, wheeled_via: 'cdp-wheel', at, delta: { x: dx, y: dy }, modifiers: mod, steps };
  }

  // 受信拖拽（ui.act {action:'drag'}）—— 画布/看板/滑块/排序/框选这类交互的
  // 唯一通路。实测：合成 PointerEvent 拖不动采用 Pointer Capture 的应用
  // （React Flow 的画布节点，moved 恒为 0,0），因为 setPointerCapture 要求
  // 真实指针；合成 KeyboardEvent/MouseEvent 同理不被信任。所以拖拽**必须**
  // 走 CDP 的 Input.dispatchMouseEvent 序列，不是"有更好"。
  //
  // 端点解析：
  //   target                    起点元素（data-ai-id）
  //   params.from / params.to   {x,y} 视口绝对坐标（给了就优先，用于空白处起拖/落点）
  //   params.to_target          终点元素（data-ai-id）
  //   params.dx / params.dy     相对起点的位移（移动节点最常用）
  //   params.from_anchor/to_anchor  'center'(默认)|'left'|'right'|'top'|'bottom'
  //     方位锚点会优先落在元素内部的**连接点**（类名含 handle/port/anchor/
  //     connector 的小元素）上 —— 这正是"从 A 的右侧连到 B 的左侧"的自然表达，
  //     不需要 agent 知道连接点的 DOM 类名或 data-ai-id（它们通常没有）。
  //   params.steps / params.duration_ms  中间 mouseMoved 步数与总时长
  //   params.keys               拖拽期间按住的修饰键（如 ['Shift'] 轴向锁定）
  async _cdpDrag(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}

    const anchorOf = (a) => {
      const s = String(a || 'center').toLowerCase();
      return ['center', 'left', 'right', 'top', 'bottom'].indexOf(s) >= 0 ? s : 'center';
    };
    // 元素内的锚点解析（页内执行）。
    //   center  → 元素的几何中心，**不吸附**任何内部元素。这是"移动/平移"的语义，
    //             若吸附到连接点，在 React Flow 这类库里会变成"从连接点拉线"，
    //             与调用方的意图相反。
    //   四周    → 优先该方位的**连接点**（handle/port/connector 类的小元素），
    //             没有则退化为该边的中点。这是"连线"的语义。
    // 连接点识别用 classList 逐 token 词边界匹配 —— 上一版用
    // `[class*="anchor"]` 会把 `is-node-anchored` 这类无关类名当成连接点
    // （实测抢到了"标签"按钮），拖拽起点完全错位。
    // 传 aiId 而不是选择器：目标可能在 shadow 里，`document.querySelector` 够不着，
    // 报出来是 "drag: start element not found"，读起来像元素不存在。定位统一走
    // findRefExpr（穿透影子根），与点击路径口径一致。
    const pointFor = async (aiId, anchor, offset) => {
      const body =
        `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return null;` +
        `var r=el.getBoundingClientRect();var side=${JSON.stringify(anchor)};` +
        `var cx=r.x+r.width/2,cy=r.y+r.height/2;` +
        `function isHandle(h){var cl=h.classList;for(var i=0;i<cl.length;i++){var t=cl[i];` +
        `if(/(^|[-_])handle([-_]|$)/.test(t)||/(^|[-_])port([-_]|$)/.test(t)||` +
        `/(^|[-_])connector([-_]|$)/.test(t)||/(^|[-_])anchor([-_]|$)/.test(t))return true;}return false;}` +
        `if(side==='center')return {x:cx,y:cy,via:'center'};` +
        `var M=12;` + // 连接点通常骑在边框上（一半在内一半在外），给一点容差
        `var hs=el.querySelectorAll('[data-handlepos],[class]');` +
        `var best=null,bestScore=-1e9;` +
        `for(var i=0;i<hs.length;i++){var h=hs[i];` +
        `if(!h.hasAttribute('data-handlepos')&&!isHandle(h))continue;` +
        `var hr=h.getBoundingClientRect();if(hr.width<=0&&hr.height<=0)continue;` +
        `var hx=hr.x+hr.width/2,hy=hr.y+hr.height/2;` +
        // 连接点必须附着在元素**自身**范围内。不加这条，元素内部某个用绝对定位
        // 甩到很远的子孙会被当成"最右侧的连接点"（实测解析出的点离节点 300px，
        // 于是连线整条落空、还报 success）。
        `if(hx<r.left-M||hx>r.right+M||hy<r.top-M||hy>r.bottom+M)continue;` +
        `var sc;` +
        `if(side==='right')sc=(hx-cx);else if(side==='left')sc=(cx-hx);` +
        `else if(side==='bottom')sc=(hy-cy);else if(side==='top')sc=(cy-hy);` +
        `if(sc>bestScore){bestScore=sc;best={x:hx,y:hy,via:'handle',el:h};}}` +
        // 自证可命中：选中的"连接点"必须真的是指针落在那个坐标时会命中的元素。
        // 很多站点把连接点画成 `pointer-events:none` + `opacity:0` 的**装饰**
        // （实测 rhtv 的画布：handle 全是 pe:none / op:0），此时按下去命中的其实是
        // 节点本体 —— 却仍报 via:'handle'，把"按错了地方"伪装成"按在连接点上"。
        //
        // 判定必须是"命中即是连接点，或连接点的子孙"。**不能**接受
        // `hit.contains(handle)`：节点本体当然包含自己的连接点，那样会把这个
        // 失败情形原样放行（第一版就是这么写的，实测仍然报 handle）。
        // 命中探测同样要穿透 shadow（连接点在 Web Component 里时，不穿透就
        // 恒判"没命中"，于是永远回退到 via:'edge'，把"按在连接点上"降级成
        // "按在节点边沿"）。跨 shadow 后用含 shadow 的祖先判定。
        `if(best){var hit=${deepHitExpr('best.x', 'best.y')};` +
        `var ok=false,c=hit,g=0;` +
        `while(c&&g++<128){if(c===best.el){ok=true;break;}c=c.parentNode||c.host||null;}` +
        `if(!ok)best=null;}` +
        `if(best){delete best.el;return best;}` +
        `if(side==='right')return {x:r.right,y:r.y+r.height/2,via:'edge'};` +
        `if(side==='left')return {x:r.left,y:r.y+r.height/2,via:'edge'};` +
        `if(side==='bottom')return {x:r.x+r.width/2,y:r.bottom,via:'edge'};` +
        `return {x:r.x+r.width/2,y:r.y,via:'edge'};`;
      const p = await run(body);
      if (!p) return null;
      const ox = offset && Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0;
      const oy = offset && Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0;
      return { x: Math.round(p.x + ox), y: Math.round(p.y + oy), via: p.via };
    };

    // 起点/落点上"实际是哪个元素"——拖拽最容易悄悄打偏（坐标落到了浮层、
    // 遮挡层或相邻的另一个节点上），不报出来就又是一次"报成功但没做对"。
    // 同时向上找最近的 data-ai-id：如果它**不是**本次目标，说明抓错了节点
    // （实测踩过：两个节点视觉重叠时，拖 A 实际按在叠在上面的 B 的浮层上，
    // 事件照常派发、success 照常返回，但什么都没动）。
    //
    // 穿透 shadow + 含 shadow 的上溯，理由同上。原来那版用 e.closest('[data-ai-id]')：
    // closest 走到影子树顶就停，影子内部的元素永远得到 id:null，于是 `is_target`
    // 恒为 true —— "抓错节点"的检测被静默跳过，正是它存在的意义所在。
    const atPointJs = (p, selfId) =>
      `var info=${hitInfoExpr(String(p.x), String(p.y))};if(!info)return null;` +
      `return {el:info.el,id:info.id,` +
      `is_target:(info.id===null||info.id===${JSON.stringify(String(selfId))})};`;

    // 起点
    let from = null;
    if (params.from && Number.isFinite(Number(params.from.x))) {
      from = { x: Math.round(Number(params.from.x)), y: Math.round(Number(params.from.y)), via: 'explicit' };
    } else if (aiId) {
      from = await pointFor(aiId, anchorOf(params.from_anchor), params.from_offset);
    }
    if (!from) return { success: false, error: 'drag: start element not found: ' + aiId };

    // 终点：显式坐标 > to_target 元素 > dx/dy 相对位移
    // 绝对坐标同时接受 {to:{x,y}} 与扁平的 to_x/to_y —— MCP 的 schema 用扁平写法
    // （更好填），raw WS 习惯嵌套写法。两种都在**这里**归一，避免"某一层认识、
    // 另一层不认识"的隐性不一致（实测踩过：raw WS 传 to_x 被当成没给落点）。
    let to = null;
    const explicitTo =
      params.to && Number.isFinite(Number(params.to.x))
        ? params.to
        : (Number.isFinite(Number(params.to_x)) || Number.isFinite(Number(params.to_y)))
          ? { x: params.to_x, y: params.to_y }
          : null;
    if (explicitTo && Number.isFinite(Number(explicitTo.x)) && Number.isFinite(Number(explicitTo.y))) {
      to = { x: Math.round(Number(explicitTo.x)), y: Math.round(Number(explicitTo.y)), via: 'explicit' };
    } else if (params.to_target) {
      to = await pointFor(params.to_target, anchorOf(params.to_anchor), params.to_offset);
      if (!to) return { success: false, error: 'drag: to_target not found: ' + params.to_target };
    } else if (Number.isFinite(Number(params.dx)) || Number.isFinite(Number(params.dy))) {
      to = { x: Math.round(from.x + Number(params.dx || 0)), y: Math.round(from.y + Number(params.dy || 0)), via: 'delta' };
    }
    if (!to) return { success: false, error: 'drag: need one of params.to / to_target / dx,dy' };

    // 视口校验：视口外的点直接派发会落到别的元素上，必须明确报错而不是静默误报成功。
    const dims = await run('return {w:window.innerWidth,h:window.innerHeight};');
    const inVp = (p) => p && p.x >= 0 && p.y >= 0 && p.x <= dims.w && p.y <= dims.h;
    if (!inVp(from)) {
      return { success: false, error: `drag: start point (${from.x},${from.y}) is outside the viewport (${dims.w}x${dims.h})`, drag_from: from };
    }
    if (!inVp(to)) {
      return { success: false, error: `drag: end point (${to.x},${to.y}) is outside the viewport (${dims.w}x${dims.h})`, drag_from: from, drag_to: to };
    }

    // 修饰键 → CDP modifiers 位掩码
    const mod = modifierMask(params.hold || params.keys);

    const dbg = view.webContents.debugger;
    const send = (m, p) => dbg.sendCommand(m, p);
    // 按键：画布类应用常把平移绑在中键/右键拖上（左键留给框选），所以要能选按键。
    const btnParam = String(params.button || 'left').toLowerCase();
    const btn = btnParam === 'middle' ? 'middle' : btnParam === 'right' ? 'right' : 'left';
    const downButtons = btn === 'middle' ? 4 : btn === 'right' ? 2 : 1;
    const steps = Math.min(60, Math.max(2, Number(params.steps) || 14));
    const total = Math.min(5000, Math.max(60, Number(params.duration_ms) || 420));
    const per = Math.max(4, Math.round(total / steps));

    // 记录起点/落点上到底是哪个元素：命中遮挡层或**另一个节点**时，调用方能立刻
    // 看出这一拖是不是打偏了，而不是拿到一个笼统的 success 去猜。
    const fromAt = await run(atPointJs(from, aiId)).catch(() => null);
    const toAt = await run(atPointJs(to, aiId)).catch(() => null);
    // 起点抓到了别的节点 = 视觉重叠下的抓错目标。事件会照常派发、页面却纹丝不动，
    // 必须显式告诉调用方，否则调用方只会以为"拖拽不生效"。
    const startOffTarget = !!(fromAt && fromAt.id && fromAt.id !== aiId);

    // 同坐标先 move 一次：让页面进入 hover 态（部分实现只在 hover 后才可拖）。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers: mod });
    await new Promise((r) => setTimeout(r, 30));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: btn, buttons: downButtons, clickCount: 1, modifiers: mod });
    // 按下后必须在**同一点**再补一次 mouseMoved：拖拽实现普遍以"按下后的第一个
    // mousemove"为位移基准点，若直接进位移循环，这一步的偏移会被吃掉 —— 实测
    // 请求 (-180,150) 只走到 (-167,139)，恰好是 13/14，稳定复现。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(20, per)));
    // 中间位移是拖拽的本质：没有它，mousePressed/mouseReleased 同坐标就只是"点击"。
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: btn, buttons: downButtons, modifiers: mod });
      await new Promise((r) => setTimeout(r, per));
    }
    // 收尾再补一次终点位置并等一拍再释放：实测「最后一步 mouseMoved 会被紧跟着的
    // mouseReleased 吃掉」，位移会稳定少 1/steps（14 步时实测 -180,150 只走了
    // -167,139 = 13/14）。多补一次终点让落点精确。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(30, per)));
    // 终点"停稳"：再补几个亚像素级的微动。高缩放的画布上连接点只有 1–3 像素，
    // 一次到点未必被框架的命中判定捕捉到（实测 8.3% 缩放的 React Flow 画布上
    // 连线时好时坏）；人手在目标上也会有这种细微停顿/抖动。
    const settle = Number(params.settle_moves) >= 0 ? Number(params.settle_moves) : 3;
    for (let k = 0; k < settle; k++) {
      const jx = to.x + (k % 2 === 0 ? 1 : -1);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: jx, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
      await new Promise((r) => setTimeout(r, Math.max(12, Math.round(per / 3))));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: btn, buttons: downButtons, modifiers: mod });
    await new Promise((r) => setTimeout(r, Math.max(20, Math.round(per / 2))));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: btn, buttons: 0, clickCount: 1, modifiers: mod });
    return {
      success: true,
      dragged_via: 'cdp-drag',
      button: btn,
      target: aiId,
      drag_from: from,
      drag_to: to,
      from_at: fromAt && fromAt.el,
      from_at_id: fromAt && fromAt.id,
      to_at: toAt && toAt.el,
      to_at_id: toAt && toAt.id,
      start_hit_target: !startOffTarget,
      steps,
      // 抓在了别的元素上：这一拖很可能什么也没动。明确警告而不是让调用方
      // 从"什么都没发生"里自己猜原因。
      warning: startOffTarget
        ? `drag started on a different element (${fromAt.id}) than the target (${aiId}) — often caused by visual overlap; pass from_offset to aim at another point of the element`
        : undefined,
    };
  }

  // 受信按键（ui.act {action:'press'}）——删除节点/撤销重做/取消选中/方向键微调
  // 这类应用快捷键的唯一通路。target 可选：给了就先在页内聚焦它，否则按键发给
  // 当前焦点（多数画布应用的快捷键挂在 document/window 上，先点一下画布即可）。
  async _cdpPress(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const run = async (body) => {
      const fn = `(function(){${body}})()`;
      return owning ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try {
      this._focusWindow(view);
    } catch (e) {}
    if (aiId) {
      // 穿透 shadow：目标在 Web Component 里时 querySelector 拿不到 el，
      // focus 这一步被静默跳过 —— 按键发给"当前焦点"（多半是 body），
      // 现象是快捷键完全没生效，但回执照常 success。
      await run(`var el=${findRefExpr(JSON.stringify(String(aiId)))};if(el&&el.focus)el.focus();return true;`);
    }
    const list = Array.isArray(params.keys) && params.keys.length
      ? params.keys
      : [params.key !== undefined ? params.key : 'Enter'];
    const dbg = view.webContents.debugger;
    const send = (m, p) => dbg.sendCommand(m, p);
    const done = [];
    for (const name of list) {
      const spec = keySpec(name, params.modifiers);
      if (!spec) return { success: false, error: 'press: unsupported key: ' + String(name), pressed: done };
      await this._cdpKey(send, spec, { activate: true });
      done.push(spec.key);
      await new Promise((r) => setTimeout(r, Math.max(20, Number(params.interval_ms) || 60)));
    }
    return { success: true, pressed_via: 'cdp-key', pressed: done };
  }

  // 富文本粘贴（ui.act {action:'paste'}）—— 把带格式内容（HTML）送进编辑器的
  // 唯一可靠通路。
  //
  // 为什么需要这个动作而不是让调用方自己合成事件：
  //   1) setContent/type 走 CDP 受信键盘，只能送**纯文本** —— 标题层级、代码块、
  //      加粗、列表全丢失。B站图文那篇只能发纯文本版，就是这个原因。
  //   2) 在 OOPIF 子帧里（B站 read-editor），ui.evaluate 到不了那个执行上下文，
  //      调用方连"自己搓一个 paste 事件"都做不到 —— 这是最疼的一条。
  //   3) 粘贴是编辑器的**一等公民路径**：Draft.js 的 DraftPasteProcessor、
  //      ProseMirror 的 transformPastedHTML、Quill 的 clipboard 模块都会把
  //      text/html 转成各自的内部文档模型。合成一个带 clipboardData 的
  //      ClipboardEvent('paste') 正是触发这条路径的正规方式，与真人粘贴等效。
  //
  // 参数契约：params.html（优先）或 params.text。两者都空 → 明确报错，
  // 不静默成功（同 cdp-input-empty-text 的教训）。
  async _pasteViaCdp(view, aiId, params, tabId) {
    if (!this._canCdp(view)) return null;
    const html = typeof params.html === 'string' ? params.html : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!html && !text) {
      return {
        success: false,
        error: 'paste called with neither html nor text — nothing to paste. '
          + 'Pass params: {html: "<h2>...</h2>"} for rich text, or {text: "..."} for plain.',
        method: 'paste-empty',
      };
    }
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const inFrame = !!owning;
    const run = async (jsBody) => {
      const fn = `(function(){${jsBody}})()`;
      return inFrame ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    try { this._focusWindow(view); } catch (e) {}

    // 定位 + 聚焦 + 派发**必须在同一次帧内执行里完成**。拆成两步（先 prep 聚焦、
    // 再回来派发）会丢目标：OOPIF 里 focus() 之后 document.activeElement 的
    // 读回可能仍是旧值，且 Draft.js 这类编辑器把 paste 监听挂在**最内层的
    // contenteditable 面子节点**上（.public-DraftEditor-content）——事件从容器
    // 派发不会向下传播到子节点，监听器收不到，defaultPrevented 恒为 false。
    // 实测：B站 read-editor 拆两步派发 → 编辑器完全无反应；合并 + 选定最深层
    // 可编辑元素后成功。
    // 页面内"读回编辑器正文"的共用片段。参数是**已经在前面的表达式里定义好的
    // 变量名**（不是选择器），因为不同时机能拿到的句柄不同：paste 那一刻有
    // `ed`，之后重采样只能重新按 ref 查。
    //
    // 取"多个候选里最长的那个"而不是"第一个非空的"：页面上同时存在搜索框、
    // 标题框、正文编辑器时，第一个非空的很可能是别的东西（知乎顶部搜索框就
    // 这么骗过一次粘性校验）。而正文的长度必然最大 —— 这条启发式在
    // 知乎/掘金/CSDN/OSChina/B站 五个站上都成立。
    const landedProbe = (v) =>
      `var cands=[],push=function(n,s){if(n&&cands.length<6)cands.push([n,s]);};` +
      `push(${v},'target');` +
      // 深层 activeElement（穿透 shadow root）：编辑面常常在编辑器组件自己的
      // shadow DOM 里，document.activeElement 只到宿主元素。
      `try{var a=document.activeElement,g=0;while(a&&a.shadowRoot&&a.shadowRoot.activeElement&&g++<8)a=a.shadowRoot.activeElement;push(a,'active');}catch(_e){}` +
      // 目标内部的第一个编辑面（Draft.js / ProseMirror 的正文都是容器里的子节点）
      `try{var q=${v}&&${v}.querySelector&&${v}.querySelector('[contenteditable=true],textarea,.cm-content,.ProseMirror,[data-lexical-editor=true]');push(q,'inner');}catch(_e){}` +
      // 上层编辑器容器：目标可能只是工具栏/占位层，正文在它的祖先里
      `try{var hh=${v}&&${v}.closest&&${v}.closest('.cm-editor,.cm-scroller,.CodeMirror,.ProseMirror,.DraftEditor-root,[contenteditable=true],form,article,main');push(hh,'host');}catch(_e){}` +
      `var best={n:0,src:'',p:''};` +
      `for(var i=0;i<cands.length;i++){var e=cands[i][0],s=cands[i][1],t='';` +
      `try{t=(e.value!=null)?String(e.value):String(e.innerText||e.textContent||'');}catch(_e){}` +
      `t=t.replace(/\\s+/g,' ');var L=t.replace(/ /g,'').length;` +
      `if(L>best.n)best={n:L,src:s,p:t.slice(0,200)};}`;

    const payload = JSON.stringify({ html, text });
    const res = await run(
      `var p=${payload};` +
      `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return {ok:false,err:'no-ref'};` +
      // 选定真正的编辑面：el 自己可编辑就用 el；否则取内部第一个可编辑后代
      // （Draft.js/ProseMirror 的编辑面都是容器里的一个子 div）。
      `var ed=el;` +
      `var elEditable=(ed.contentEditable==='true')||(ed.tagName==='TEXTAREA')||(ed.tagName==='INPUT');` +
      `if(!elEditable&&ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
      `var editable=(ed.contentEditable==='true')||(ed.tagName==='TEXTAREA')||(ed.tagName==='INPUT');` +
      `if(!editable)return {ok:false,err:'not-editable'};` +
      `ed.focus();` +
      `var dt=new DataTransfer();` +
      `if(p.html)dt.setData('text/html',p.html);` +
      `dt.setData('text/plain',p.text||p.html.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\\s+/g,' ').trim());` +
      `var ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true,composed:true});` +
      `var notPrevented=ed.dispatchEvent(ev);` +
      // 同步读一次：CodeMirror 6 / ProseMirror / Quill 都在 paste handler 里
      // 同步写文档，这一刻就能读到；异步提交的（Draft.js 走 setTimeout）
      // 读不到，交给后面的延迟采样。
      landedProbe('ed') +
      `return {ok:true,prevented:!notPrevented,tag:ed.tagName,landed0:best};`
    );
    if (!res || !res.ok) {
      return { success: false, error: (res && res.err) || 'paste failed', method: 'synthetic-clipboard-event' };
    }
    // 编辑器没接管粘贴（prevented=false）= 页面对合成粘贴不买账。如实报告，
    // 并给出可操作建议，而不是报 success 让调用方以为内容进去了。
    if (!res.prevented) {
      return {
        success: false,
        error: 'paste event was not consumed by the page (defaultPrevented=false) — this editor likely listens on a different surface (e.g. a child element or shadow root). Try pasting into a child node ref, or fall back to setContent for plain text.',
        method: 'synthetic-clipboard-event',
        consumed: false,
      };
    }
    // 落盘校验：读回编辑器内容。
    //
    // 为什么不能只读一次、也不能只读 activeElement（2026-10-19 掘金实机）：
    //   掘金（CodeMirror 6）粘贴成功、正文完整，回执却是 landed_chars: 0。
    //   根因是读回走了 deepActive —— 那一刻 activeElement 并不是编辑面（编辑器
    //   把焦点放在 .cm-scroller 上，真正的内容在 .cm-content），于是读到空。
    //   调用方看到 0 就再粘一次，正文变成两份。**假阴性比漏报贵得多**：它直接
    //   诱发重复写入，而重复写入是这件工具最不该制造的事故。
    //
    // 所以现在：① 以**刚粘贴的那个元素**为主，activeElement / 内部编辑面 /
    // 上层容器依次兜底；② 三次采样（同步 / +350ms / +900ms）取最大值，覆盖
    // 异步提交；③ 真读不到时给 landed_chars: null 而不是 0 —— 0 是"确定空"，
    // null 是"读不到"，这两种事实对调用方的决策完全相反。
    let landed = res.landed0 && res.landed0.n > 0 ? res.landed0 : null;
    let samples = 1;
    for (const wait of [350, 900]) {
      if (landed) break;
      await new Promise((r) => setTimeout(r, wait));
      const again = await run(
        `var t=${findRefExpr(JSON.stringify(aiId))}||document.activeElement;if(!t)return {n:0,src:'none',p:''};` +
        landedProbe('t') + `return best;`
      ).catch(() => null);
      samples++;
      if (again && again.n > 0) landed = again;
    }
    const landedLen = landed ? landed.n : 0;
    if (!landedLen) {
      return {
        success: false,
        // 措辞从 "nothing landed"（断言）改成 "could not be read back"（观测）。
        // 前者在掘金那种场景里是错的 —— 它会把一次成功的粘贴报成失败，而
        // agent 对 success:false 的标准反应就是重试一次。
        error: 'paste was consumed but the editor content could not be read back — this is NOT proof that nothing landed (CodeMirror-style editors keep the document outside the focused node). '
          + 'Verify with get_value on the same ref before doing anything else; re-pasting on a live editor duplicates the content.',
        method: 'synthetic-clipboard-event',
        consumed: true,
        landed_chars: null,
        landed_verified: false,
        landed_samples: samples,
      };
    }
    return {
      success: true,
      method: 'synthetic-clipboard-event',
      consumed: true,
      in_frame: inFrame,
      landed_chars: landedLen,
      landed_verified: true,
      // 读回来源：'target' 最可信；'host' 是容器兜底，可能把页面别处的文字
      // 算进来 —— 长度只用于"有没有落地"，不做逐字比对，所以偏大是安全方向。
      landed_source: landed.src,
      ...(html && !text ? { landed_preview: landed.p || '' } : {}),
    };
  }

  // 文件上传（封面/附件等，跨框架通用）：HTMLInputElement[type=file] 只能由
  // DevTools 的 DOM.setFileInputFiles 写入真实文件路径（网页脚本无法伪造
  // FileList，preload 同样受限），对任何站点/上传组件一视同仁。找到目标 input
  // 的 objectId 后直接注入文件路径，等价于用户在系统文件选择器里选中。
  async _uploadViaCdp(view, aiId, filePath, tabId) {
    if (!this._canCdp(view)) return null;
    if (!filePath) throw new Error('upload requires a file path');
    const dbg = view.webContents.debugger;
    // 用 Runtime.evaluate 拿 objectId，不依赖 DOM nodeId 映射。不额外 click：
    // DOM.setFileInputFiles 会直接在目标 input 上写入文件并触发 change（等价于
    // 用户在系统选择器选中）；若再对它 click 会重新唤起系统文件框并清空 files，
    // 导致刚写入的状态被覆盖。由调用方负责先让上传组件就绪。
    const idRes = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(function(){var el=${findRefExpr(JSON.stringify(aiId))};return el&&el.__proto__&&el.matches?el.matches('input[type=file],input')?el:null:null;})()`,
      returnByValue: false,
    });
    const objId = idRes && idRes.result && idRes.result.objectId;
    if (!objId) return null;
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], objectId: objId });
    // 兜底校验：确认 files 已写入
    const ver = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(function(){var f=${findRefExpr(JSON.stringify(aiId))}.files;return f&&f.length>0?{name:f[0].name,size:f[0].size}:null;})()`,
      returnByValue: true,
    });
    const v = ver && ver.result && ver.result.value;
    if (!v) return { success: false, error: 'Upload not written to input' };
    return { success: true, uploaded: v.name, size: v.size };
  }

  // 跨帧文件上传（含 OOPIF）。CDP 的 DOM.setFileInputFiles 需要顶层文档里的
  // nodeId/objectId，够不着 iframe 内部的 input —— B站封面上传、多数编辑器的
  // "插入图片"都在 iframe 里，实测只得出一条 "no file input found"。
  // 走到帧内：文件读成字节 → 在目标帧构造 File → DataTransfer 赋给 input.files
  // → 派发 change，与"用户在系统选择器里选中文件"等价。
  //
  // 三种状态的控件都要能对付（实测各站点轮流出现）：
  //   1. 目标本身就是 input[type=file] —— 直接写；
  //   2. 目标是容器，input 预挂在里面 —— 取容器里的第一个 file input；
  //   3. 容器里**一个 input 都没有**（组件在"已上传"状态下把上传区整个卸载了，
  //      CSDN 的封面就是：有封面时 .container-coverimage-box 里连
  //      .el-upload__input 都不存在）—— 临时接管 HTMLInputElement.prototype.click
  //      再把容器点开，捕获"点击时才创建"的那个 input。
  // 第 3 种是 target 写成 `.box .el-upload__input` 这类"指向 input 本身的选择器"
  // 时最容易踩的：整条选择器查不到元素，但它的祖先还在。所以 target 先展开成
  // 由长到短的回退候选（selectorAncestors），用第一个命中的祖先当锚点。
  async _uploadViaFrameJs(view, aiId, filePath, tabId) {
    if (!aiId) return null;
    if (!filePath) throw new Error('upload requires a file path');
    // 上传控件经常没有语义节点（B站的「本地上传」就是个纯 div 菜单项，AX 树里
    // 根本没有它），此时调用方给不出 ref，只能给 CSS 选择器。所以 target 先按
    // data-ai-id 找，找不到再当作选择器：先找帧、再找顶层文档。
    const target = String(aiId);
    // 由长到短的候选：`.a .b` → ['.a .b', '.a']。data-ai-id 形状的 target
    // 走 selectorAncestors 会原样返回单元素，行为不变。
    const cands = refGuard.selectorAncestors(target);
    let owning = await this._owningFrameFor(view, aiId, tabId);
    let inTop = false;
    if (!owning) {
      const probe = `(function(){var C=${JSON.stringify(cands)};for(var i=0;i<C.length;i++){try{if(document.querySelector(C[i]))return true;}catch(e){}}return false;})()`;
      for (const frame of (view.webContents.mainFrame.framesInSubtree || [])) {
        if (frame === view.webContents.mainFrame) continue;
        try { if (await frame.executeJavaScript(probe)) { owning = frame; break; } }
        catch (e) { /* skip */ }
      }
      if (!owning) {
        try { inTop = !!(await this.evaluate(probe, tabId)); } catch (e) { inTop = false; }
      }
    }
    if (!owning && !inTop) {
      // 连锚点都找不到：明确说"选择器没命中任何元素"，而不是笼统的
      // "no file input found"（后者会让人以为选择器命中了但里面没 input）。
      return {
        success: false,
        method: 'frame-file-inject',
        error: 'upload target not found: no element matches '
          + JSON.stringify(cands[0] || target) + (cands.length > 1 ? ' (nor its ancestors ' + JSON.stringify(cands.slice(1)) + ')' : '')
          + ' — pass the control that OPENS the file picker, or a CSS selector for it',
        candidates: cands,
      };
    }
    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) {
      return { success: false, method: 'frame-file-inject', error: 'cannot read file: ' + String((e && e.message) || e).slice(0, 160) };
    }
    const name = path.basename(filePath);
    const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
    const mime = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif' : 'application/octet-stream';
    // 内联 base64 直接走 frame.executeJavaScript —— 不受 WS 侧 evaluate 的
    // 5000 字符守卫约束（那个守卫只拦 ui.evaluate 的 js 参数）。
    const b64 = buf.toString('base64');
    const refSel = JSON.stringify('[data-ai-id="' + target + '"]');
    const js = `(function(){
var C=${JSON.stringify(cands)};
var REF=${refSel};
var b64=${JSON.stringify(b64)};
var name=${JSON.stringify(name)};
var mime=${JSON.stringify(mime)};
function isFileInput(e){return !!e&&e.tagName==='INPUT'&&e.type==='file';}
function q(sel,root){try{return (root||document).querySelector(sel);}catch(e){return null;}}
// 1) 先按 data-ai-id 找（ref 才是权威），再按选择器候选由长到短找。
// 按 ref 找必须穿透 shadow：上传控件装在 Web Component 里时，顶层 querySelector
// 拿不到，报出来是 "no-el" —— 看起来像没有上传入口，实际是查询路径够不着。
var host=null,hostSel=null;
var byRef=${findRefExpr('REF')};
if(byRef){host=byRef;hostSel=REF;}
for(var i=0;i<C.length&&!host;i++){var el=q(C[i]);if(el){host=el;hostSel=C[i];break;}}
if(!host) return {ok:false,err:'no-el'};
// <label for=...> 的点击会由浏览器直接激活目标 input、绕过 JS 层拦截 → 系统文件框
// 会真的弹出来。所以遇到 label 先顺着 control 拿 input，拿不到就不点它。
// 找后代同样要穿透 shadow（findDescExpr 会下钻 el.shadowRoot）：宿主可能是
// <bili-*> 之类，真正的 input[type=file] 在它自己的影子树里。
function labelInput(el){try{var c=el.control;if(isFileInput(c))return c;var n=el.querySelector&&${findDescExpr('el', JSON.stringify('input[type=file]'))};if(n)return n;}catch(e){}return null;}
function find(root){
  if(!root)return null;
  if(isFileInput(root))return root;
  if(root.tagName==='LABEL'){var li=labelInput(root);if(li)return li;}
  var r=null;try{r=${findDescExpr('root', JSON.stringify('input[type=file]'))};}catch(e){r=null;}
  return r;
}
var inp=find(host),via='direct';
// 2) 点击捕获：接管原型 click（元素的 .click() 会走到这里），挡住系统框，
//    同时暂时让 showOpenFilePicker 挂起，避免 File System Access API 那条路漏网。
function captureOnce(t){
  if(!t)return null;
  var cap=null,proto=HTMLInputElement.prototype,orig=proto.click,origPicker=window.showOpenFilePicker;
  try{window.showOpenFilePicker=function(){return new Promise(function(){});};}catch(e){}
  proto.click=function(){if(this.type==='file'){cap=this;return;}try{return orig.apply(this,arguments);}catch(e){}};
  try{t.click();}catch(e){}
  try{proto.click=orig;}catch(e){}
  try{window.showOpenFilePicker=origPicker;}catch(e){}
  return cap;
}
var clicked=[];
if(!inp){
  inp=captureOnce(host);
  if(inp)via='click';
  else{
    clicked.push((host.className||host.tagName||'').toString().slice(0,40));
    // 3) 锚点自己点不出东西就往下探一层：只挑"长得像触发器"的、且真正可见的
    //    后代，最多 8 次就收手（每次点击都可能改变页面状态，不能无限试）。
    //    负向词表必须有：封面区里常驻一个「删除封面」按钮，类名带 cover，
    //    正向匹配会命中它 —— 一旦可见就会被点掉用户的封面。
    var RX=/upload|file|add|plus|replace|change|select|image|cover/i;
    var BAD=/remove|delete|del-|trash|clear|cancel|close|drop/i;
    var nodes=[],all=[];
    try{all=host.querySelectorAll('button,label,[role=button],a,div,span,i');}catch(e){all=[];}
    for(var k=0;k<all.length&&nodes.length<8;k++){
      var e2=all[k],cls=String(e2.className||''),tag=e2.tagName,role=e2.getAttribute&&e2.getAttribute('role');
      if(BAD.test(cls))continue;
      if(!(RX.test(cls)||tag==='BUTTON'||tag==='LABEL'||tag==='A'||role==='button'))continue;
      var rc=e2.getBoundingClientRect();
      if(rc.width<2||rc.height<2)continue;   // 不可见的不点（0×0 的多是布局占位）
      nodes.push(e2);
    }
    for(var j=0;j<nodes.length&&!inp;j++){
      var nd=nodes[j];
      if(nd.tagName==='LABEL'&&!labelInput(nd))continue;
      inp=captureOnce(nd);
      clicked.push((nd.className||nd.tagName||'').toString().slice(0,40));
      if(inp)via='click-descendant';
    }
  }
}
if(!inp)inp=find(host);
if(!inp)return {ok:false,err:'no-file-input',host_sel:hostSel,clicked:clicked};
if(!inp.isConnected){
  // 捕获到的 input 往往是"创建了但还没插进文档"（组件打算点完就丢），
  // 挂在锚点下、藏起来：change 才能沿组件自己的 DOM 树冒泡到它的委托处理器。
  try{inp.style.display='none';host.appendChild(inp);}catch(e){}
}
var bin=atob(b64),n=bin.length,arr=new Uint8Array(n);
for(var m=0;m<n;m++)arr[m]=bin.charCodeAt(m);
var file=new File([arr],name,{type:mime});
var dt=new DataTransfer();dt.items.add(file);
inp.files=dt.files;
inp.dispatchEvent(new Event('change',{bubbles:true}));
return {ok:true,name:file.name,size:file.size,via:via,host_sel:hostSel,clicked:clicked};
})()`;
    const res = owning ? await owning.executeJavaScript(js) : await this.evaluate(js, tabId);
    if (!res || !res.ok) {
      const err = (res && res.err) || 'upload-failed';
      if (err === 'no-file-input') {
        return {
          success: false,
          method: 'frame-file-inject',
          error: 'found ' + JSON.stringify((res && res.host_sel) || target)
            + ' but no <input type=file> appeared after clicking it'
            + ' (clicked: ' + JSON.stringify((res && res.clicked) || []) + ')'
            + ' — pass the element that OPENS the file picker (e.g. the "upload local file" menu item) as target',
          candidates: cands,
        };
      }
      return { success: false, method: 'frame-file-inject', error: err, candidates: cands };
    }
    // in_frame 如实反映实际执行位置：顶层文档上传（CSDN 那种）不应报 true。
    return {
      success: true,
      method: 'frame-file-inject',
      uploaded: res.name,
      size: res.size,
      in_frame: !!owning,
      // 上传组件可能有三种入口状态，回执如实说明用了哪条路：
      //   direct = input 本来就在；click = 点了锚点才创建；
      //   click-descendant = 锚点里再往下探了一层才点出 input。
      resolved_by: res.via || 'direct',
      host_sel: res.host_sel === refSel ? '[data-ai-id]' : (res.host_sel || null),
    };
  }

  // 通用文本输入（type/setContent 共用）：先让窗口/视图拿到焦点，再在页面里
  // DOM 原生聚焦（一次 evaluate 同步完成）→ CDP 受信 Cmd+A 全选 + Delete 清空
  // → 逐字符受信键入 + Enter。清空必须走编辑器自身的受信按键链路：Draft 等
  // 编辑器是受控组件，DOM 直接改（execCommand/clearContent）不会同步内部
  // EditorState，后续输入会被忽略（知乎正文 execCommand 清空后输入丢失证实）。
  // Cmd+A 触发编辑器自身 selectAll，Delete 触发 removeRange——但 Draft 的选区
  // 更新是异步的（React 渲染提交），Delete 必须在全选提交后发出，否则落在旧
  // 选区上。逐字符走 Input.dispatchKeyEvent（rawKeyDown/char/keyUp，仅 char
  // 携带 text），等价真实键盘输入，编辑器会应用当前行内样式（加粗/斜体）；
  // Input.insertText 是 IME 插入路径，会丢失行内样式。
  // 不识别编辑器框架；失败返回错误，由 agent 重读重试。
  async _inputViaCdp(view, aiId, text, tabId, opts = {}) {
    if (!this._canCdp(view)) return null;
    const owning = await this._owningFrameFor(view, aiId, tabId);
    const inFrame = !!owning;
    // Run a JS snippet either in the owning frame (OOPIF) or the top frame.
    const run = async (jsBody) => {
      const fn = `(function(){${jsBody}})()`;
      return inFrame ? owning.executeJavaScript(fn) : this.evaluate(fn, tabId);
    };
    // 先激活窗口/视图，再在页面内聚焦（顺序保证渲染进程处于激活态）。
    // 被遮挡时窗口 visibilityState=hidden，键盘事件同样会被渲染器丢弃。
    try {
    // 抢焦点会打断人正在做的事（agent 干活时人几乎不能用电脑）。
    // 策略见 _focusWindow：默认只保证窗口可见，不把它拽到最前、不抢焦点。
    this._focusWindow(view);
    } catch(e) {}
    // 定位可编辑区并原生聚焦（不做 DOM 全选——交给 Cmd+A 受信按键）
    const prep = await run(
      `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return {ok:false,err:'no-ref'};` +
      `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
      `var editable=(ed.contentEditable==='true')||(ed.tagName==='TEXTAREA')||(ed.tagName==='INPUT');` +
      `if(!editable)return {ok:false,err:'not-editable'};` +
      `ed.focus();` +
      // focus() 到底有没有生效，必须当场读，不能假设。
      // 实测（Notion，2026-10-30）：空段落的 contenteditable 拿到 focus() 之后
      // document.activeElement 仍是 BODY —— 它要一次真实点击才进入编辑态。
      // 于是后续的受信按键全打到页面上，而校验读到"没写进去"，报 Input not verified。
      // 那不是"打字失败"，是"没坐上光标"。
      `var a=document.activeElement;` +
      `var took=(a===ed)||(ed.contains&&ed.contains(a))||(a&&a.contains&&a.contains(ed));` +
      `var isCE=(ed.contentEditable==='true');` +
      `return {ok:true,focus_took:!!took,kind:isCE?'ce':'input'};`
    );
    if (!prep || !prep.ok) return null;
    // contenteditable **一律**先来一次真实指针点击，不能只 focus()。
    //
    // 实测（Notion，2026-10-30）：空段落的 contenteditable 调 focus() 之后
    // document.activeElement 确实等于它（所以"焦点有没有坐上"这个判据看不出问题），
    // 但编辑器**没进入编辑态** —— 随后的受信按键全部落空，校验读到空，报
    // Input not verified。真人点一下之后 activeElement 会交给编辑器自己的容器，
    // 按键才生效。也就是说：对这一类块编辑器，"焦点"不等于"可输入"。
    //
    // ⚠️ 点完**不要**再对叶子 focus()。踩过：点开之后补一个 ed.focus() 把焦点从
    // 编辑器容器抢回叶子，编辑态当场被打断，症状与没点一模一样（实测两次）。
    // 点完保持原样，让编辑器自己放光标；type 的 at 定位在后面的选区块里做。
    //
    // input/textarea 不加这一步：原生控件 focus 就够，多点一下反而会把光标
    // 挪到中段（type 的 at:'end' 语义会变）。
    if (prep.kind === 'ce' || prep.focus_took === false) {
      try {
        await this._cdpPointerTarget(view, 'click', aiId, tid);
        await new Promise((r) => setTimeout(r, 150)); // 等编辑器切进编辑态
      } catch (e) { /* 点不到就按原路径继续，后面的校验会如实报错 */ }
    }
    // 清空收尾：拆掉残留的空块外壳。selectAll + 受信 Delete 只删文本不删外层块
    // 标签，浏览器会保留至少一个空块承载光标 —— 清一个 H2 段落得到的是
    // `<h2><br></h2>` 而不是空。残留外壳会让随后的排版一层层嵌进旧外壳（实测出现
    // h2>blockquote>pre>ul>li 的套娃），editor_blocks 的 role 也随之失真。
    // 只在"确实已经没有文本内容"时拆，有内容的块一个都不动。
    const stripEmptyShells = () => run(
      // 与上面 prep 同一口径（穿透 shadow 的 findRefExpr）。两处必须一致：
      // prep 认得的元素、这里也要认得，否则"清空校验"读到空、把已经清干净的
      // 编辑器判成没清掉，接着又拆一遍。
      `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return false;` +
      `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
      `if(ed.tagName==='INPUT'||ed.tagName==='TEXTAREA')return false;` +
      `if(ed.contentEditable!=='true')return false;` +
      `if((ed.innerText||'').trim()!=='')return false;` +
      `var BLOCK=/^(H1|H2|H3|H4|H5|H6|P|BLOCKQUOTE|PRE|UL|OL|LI|DIV|SECTION|ARTICLE)$/;` +
      `for(var g=0;g<12;g++){` +
      `if(ed.children.length!==1)break;` +
      `var k=ed.children[0];` +
      `if(!BLOCK.test(k.tagName))break;` +
      `if((k.innerText||'').trim()!=='')break;` +
      `while(k.firstChild)ed.insertBefore(k.firstChild,k);` +
      `ed.removeChild(k);}` +
      `return true;`
    );
    // clear 时先拆一遍：编辑器可能已经是"空但带外壳"的状态，不拆的话下面的
    // 幂等短路会把它当成"已经是空的"直接返回，外壳就永远留在那儿。
    if (!text) await stripEmptyShells();
    // 校验用的归一化，依次做三件事：
    //   1. \r\n 统一成 \n（Windows 换行与受信 Enter 产出的 \r 不该算差异）；
    //   2. 压掉"排版空白"（空格/tab），但换行本身必须参与比对 —— 把 \s 全剥掉
    //      会让 "a\nb\nc" 与 "abc" 等价，段落结构丢了还判成功，那是谎报；
    //   3. 连续换行压成一个。
    // 第 3 条来自实测：contenteditable 编辑器（Quill/ProseMirror/Slate…）普遍把
    // 一个语义换行渲染成一串 \n —— 往 B站 read-editor 输入 "AA\nBB"，读回是
    // "AA\n\nBB"。逐字比对必然失配，于是**内容明明写进去了却回 success:false /
    // cdp-input-failed**，调用方据此重试或放弃，而页面其实已经是想要的样子。
    // 压缩换行仍然保留"有没有分段"这一层信息，只是不再纠结分了几层。
    const norm = normalizeInputText;
    const skeletal = skeletalInputText;
    // 幂等短路：若可编辑区当前内容已恰好等于目标文本，直接返回而不做清空+重打。
    // 每次全量重写都会把草稿标脏，重新触发编辑器自身的"草稿备份"/版本气泡——对
    // 相同文本的重复调用（重试/校正）不应让它反复闪烁。
    const curText = await run(
      `var e=${deepActiveExpr()};return (e&&(e.innerText||e.value||''))||'';`
    );
    if (norm(curText) === norm(text)) {
      // "目标就是当前内容" 与 "目标本来就是空的" 必须区分开。
      // 后者几乎总是调用方的错误：ui.act 的 WS 契约把动作参数放在 params.params
      // 里（params.params.text），照着 MCP 的扁平形状写成 params.text 就会静默
      // 变成空文本 —— 而空字段恰好命中下面的短路，于是**什么都没打却报
      // success / method=cdp-input-unchanged**。这正是本项目最忌讳的谎报。
      // 实测就是这样被发现的：调用回执"成功"，输入框却仍是空的。
      if (!text) {
        return {
          success: false,
          error: 'type called with empty text — nothing was typed. '
            + 'Over WS the action params go in params.params (e.g. {action:"type", target:"<id>", params:{text:"..."}}), '
            + 'not at the top level. Use action:"clear" to empty a field.',
          method: 'cdp-input-empty-text',
          chars: 0,
        };
      }
      return { success: true, method: 'cdp-input-unchanged', changes: 0, chars: 0 };
    }
    const dbg = view.webContents.debugger;
    const send = (method, params) => dbg.sendCommand(method, params);
    // 全选 + 整段删除。刻意不发送受信 Cmd+A：在本应用里注入受信 Cmd+A 会触发
    // macOS 的应用 About 面板（原生 NSAlert，"版本"弹窗），每次输入都弹。故全选
    // 一律走页内程序化选择。顶层文本流(contenteditable/input/textarea)用 Range/
    // setSelectionRange(_selectAllFallback) + 受信 Delete;OOPIF 子帧编辑器不做受信
    // 删除(受信 Delete 前是 DOM-Range 选区,部分富文本编辑器不把这些选区同步进自身
    // EditorState,Delete 落空→clear 无效),改为在所属帧内 execCommand selectAll+delete,
    // 走编辑器原生选区/删除链路,B站 read-editor 验证可被清到空。顶层路径行为不变。
    // 追加模式（type）：不清空，只把光标放到指定位置 —— 这样"插入话题标签后
    // 继续写正文"才成立。at: 'end' | 'start' | 'cursor'（cursor 表示不干预）。
    const replace = opts.replace !== false;
    if (!replace) {
      const at = opts.at === 'start' || opts.at === 'cursor' ? opts.at : 'end';
      if (at !== 'cursor') {
        await run(
          `var el=${findRefExpr(JSON.stringify(String(aiId)))};if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
          `if(ed.tagName==='INPUT'||ed.tagName==='TEXTAREA'){var L=(ed.value||'').length;` +
          `var p=(${JSON.stringify(at)}==='start')?0:L;try{ed.setSelectionRange(p,p);}catch(e){}return true;}` +
          `if(ed.contentEditable!=='true')return false;` +
          `try{var r=document.createRange();r.selectNodeContents(ed);` +
          `r.collapse(${JSON.stringify(at)}==='start');` +
          `var s=window.getSelection();s.removeAllRanges();s.addRange(r);return true;}catch(e){return false;}`
        );
        await new Promise((r) => setTimeout(r, 80)); // 等光标位置同步进编辑器状态
      }
    } else {
      const cleared = inFrame
        ? await this._clearInFrame(owning, aiId)
        : await (async () => {
            await this._selectAllFallback(view, aiId, tabId, null);
            await new Promise((r) => setTimeout(r, 120)); // 等选区同步进框架状态
            await this._cdpKey(send, { key: 'Delete', code: 'Delete', vk: 46, mod: 0 });
            await new Promise((r) => setTimeout(r, 80)); // 等删除后的空状态提交
            return true;
          })();
      if (!cleared && text) {
        // 清空失败但目标非空：先不空转，仍尝试继续键入（若编辑器未清空，键入会拼接而非替换）。
        await this._cdpKey(send, { key: 'Delete', code: 'Delete', vk: 46, mod: 0 });
      }
      if (!text) {
        // selectAll + 受信 Delete 对**多块内容**可能清不干净。此前每段都被
        // type 整篇替换掉所以没暴露；type 改为追加语义后编辑器会累积多段，
        // 实测残留 "第一段<div>第二段</div><h2>第三段</h2>"。因此清完校验一次，
        // 仍有文本就换编辑器原生 selectAll+delete 再清一遍。
        const left = await run(
          `var el=${findRefExpr(JSON.stringify(String(aiId)))};if(!el)return 0;` +
          `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
          `return String((ed.innerText!=null?ed.innerText:ed.value)||'').trim().length;`
        );
        if (left > 0) {
          await run(
            `var el=${findRefExpr(JSON.stringify(String(aiId)))};if(!el)return false;` +
            `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
            `try{ed.focus();document.execCommand('selectAll');document.execCommand('delete');}catch(e){}return true;`
          );
          await new Promise((r) => setTimeout(r, 150)); // 等编辑器状态提交
        }
        await stripEmptyShells();
      }
    }
    const paras = String(text == null ? '' : text).split('\n');
    // 段落内容快照：用来判断"这一下 Enter 到底有没有生效"。
    const snap = () => run(
      `var e=${deepActiveExpr()};var t=String((e&&(e.innerText||e.value))||'');` +
      `var b=(e&&e.querySelectorAll)?e.querySelectorAll('p,div,br').length:0;` +
      `return {len:t.length,nl:(t.match(/\\n/g)||[]).length,blocks:b};`
    );
    for (let i = 0; i < paras.length; i++) {
      if (paras[i]) await this._typeChars(send, paras[i]);
      if (i < paras.length - 1) {
        // 段间换行。富文本编辑器（ProseMirror/Draft…）自己接 keydown 处理
        // Enter 并已分好段；原生 textarea / 原生 contenteditable 没人接管，
        // 而 rawKeyDown 不带 text 时默认编辑动作不触发 —— 换行会静默丢失。
        // 故：先发受信 Enter，若内容毫无变化（说明没人处理它），再补一个带
        // text 的 char 事件把换行真正插进去。给已分段的编辑器补发会多插空行，
        // 所以这一步必须"看效果再决定"，不能无脑补。
        const before = await snap();
        await this._cdpKey(send, { key: 'Enter', code: 'Enter', vk: 13, mod: 0 });
        const after = await snap();
        const moved =
          Number(after && after.len) > Number(before && before.len) ||
          Number(after && after.nl) > Number(before && before.nl) ||
          Number(after && after.blocks) > Number(before && before.blocks);
        if (!moved) await this._cdpKey(send, { key: '\r', code: 'Enter', vk: 13, mod: 0, text: '\r' });
      }
    }
    // 通用校验：非空文本要求内容包含目标文本；空文本要求已清空（只允许空块残留）。
    // 任一框架均可，无占位符/块数特判。
    const after = await run(
      `var e=${deepActiveExpr()};return {text:(e.innerText||e.value||'')};`
    );
    const want = norm(text);
    const got = norm(after && after.text);
    // clear（空目标）：允许残留空块外壳 —— 编辑器永远乐于留下一个空 <p>。
    const ok = want ? got.includes(want) : skeletal(got) === '';
    if (ok) {
      return { success: true, method: 'cdp-input', chars: (after && after.text) ? after.text.length : 0 };
    }
    // 焦点复核：**焦点不等于我们写的那个编辑器**。
    //
    // 实测（Notion，2026-10-30）：清空一个空段落之后，Notion 把焦点交还给页面
    // （activeElement 变回 BODY），于是 deepActive 读到的是整页文本；而目标块其实
    // 已经空了 —— 明明成功却报 Input not verified。这是**假阴性**，比失败更危险：
    // agent 会重试，对 type 就是写入两份重复内容。
    //
    // 所以失败时再按"我们解析出来的那个可编辑元素"读一次。命中就如实给成功并标明
    // 依据来源。它不会掩盖真错位：文字若落到别的输入框，目标元素里就不会有它。
    try {
      const tgt = await run(
        `var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return {ok:false};` +
        `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
        `return {ok:true,text:(ed.innerText||ed.value||'')};`
      );
      const tText = norm(tgt && tgt.text);
      const okTgt = tgt && tgt.ok && (want ? tText.includes(want) : skeletal(tText) === '');
      if (okTgt) {
        return {
          success: true,
          method: 'cdp-input',
          verified_by: 'target-element',
          chars: (tgt && tgt.text) ? tgt.text.length : 0,
          note: 'verified against the target element because focus moved away after the input (common in block editors after clear).',
        };
      }
    } catch (e) { /* 复核只是加分项，出错不影响下面的如实报错 */ }
    // 诊断：忽略全部空白后再比一次。相等说明东西其实打进去了、只是被编辑器
    // 重新排了版；不等说明大概率压根没落上去。两者的处置方式完全相反。
    const landed = want ? skeletal(after && after.text) === skeletal(text) : false;
    return {
      success: false,
      error: 'Input not verified — please re-read the tree and retry',
      method: 'cdp-input-failed',
      expected_chars: want.length,
      actual_chars: got.length,
      content_landed_ignoring_whitespace: landed,
      hint: landed
        ? 'the text matches once all whitespace is ignored — the editor most likely re-formatted line breaks/padding. Treat as applied and re-read the tree to confirm.'
        : 'the text does not match even after stripping whitespace — the input probably did not land. Check focus/target before retrying.',
    };
  }

  // OOPIF 内整段清空：在所属子帧上下文里聚焦 contenteditable，用 execCommand
  // selectAll + delete 走编辑器原生选区/删除链路（受信 Delete 前置 DOM-Range 选区对
  // 部分富文本编辑器无效）。返回是否已清到空。
  async _clearInFrame(frame, aiId) {
    try {
      const r = await frame.executeJavaScript(`(function(){
        var ref=${findRefExpr(JSON.stringify(aiId))};if(!ref)return {ok:false,reason:'no-ref'};
        var e=ref;if(ref.querySelector){var inner=${findDescExpr('ref', JSON.stringify('[contenteditable="true"],textarea,input[type="text"],input[type="search"],input[type="title"],input:not([type])'))};if(inner)e=inner;}
        var isInput=(e.tagName==='INPUT'||e.tagName==='TEXTAREA');
        var isCE=e.contentEditable==='true';
        if(!(isInput||isCE))return {ok:false,reason:'not-editable'};
        e.focus();
        var ae=document.activeElement&&(document.activeElement===e?'same':'other:'+(document.activeElement.tagName||''));
        var sa=false;
        if(isCE){ sa=document.execCommand('selectAll'); }
        else if(isInput){ var len=(e.value||'').length; if(len){ try{e.setSelectionRange(0,len);}catch(_){ if(e.select)e.select(); } } }
        var del=document.execCommand('delete');
        var txt=isInput?(e.value||''):(e.innerText||e.textContent||'');
        return {ok:txt.trim()==='',sa:!!sa,del:!!del,left:(txt||'').trim().length,ae:ae};
      })()`);
      if (!(r && r.ok)) console.error('[clearInFrame] FAIL', JSON.stringify(r));
      return !!(r && r.ok);
    } catch (e) { console.error('[clearInFrame] THROW', e.message); return false; }
  }

  // 全选回退：Cmd+A 后选区仍为空时，用浏览器原生选区 API 选中可编辑区全部文本。
  // 返回 true 表示已有非空选区（Cmd+A 已生效或回退成功）；框架通过
  // selectionchange 同步内部状态，随后的受信 Delete 即可整段删除。
  async _selectAllFallback(view, aiId, tabId, frame) {
    const r = frame
      ? await frame.executeJavaScript(
          `(function(){var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
          `var s=window.getSelection();` +
          `if(s&&!s.isCollapsed&&s.toString().length>0)return true;` +
          `if(ed.tagName==='TEXTAREA'||ed.tagName==='INPUT'){var v=ed.value||'';if(v){ed.focus();ed.setSelectionRange(0,v.length);}return v.length>0;}` +
          `var walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);` +
          `var first=null,last=null,t;` +
          `while(t=walker.nextNode()){if(t.nodeValue&&t.nodeValue.length){if(!first)first=t;last=t;}}` +
          `if(!first)return false;` +
          `var rng=document.createRange();rng.setStart(first,0);rng.setEnd(last,last.nodeValue.length);` +
          `s.removeAllRanges();s.addRange(rng);` +
          `return rng.toString().length>0;})()`)
      : await this.evaluate(
          `(function(){var el=${findRefExpr(JSON.stringify(aiId))};if(!el)return false;` +
          `var ed=el;if(ed.querySelector){var inner=${findDescExpr('ed', JSON.stringify('[contenteditable=true],input,textarea'))};if(inner)ed=inner;}` +
          `var s=window.getSelection();` +
          `if(s&&!s.isCollapsed&&s.toString().length>0)return true;` +
          `if(ed.tagName==='TEXTAREA'||ed.tagName==='INPUT'){var v=ed.value||'';if(v){ed.focus();ed.setSelectionRange(0,v.length);}return v.length>0;}` +
          `var walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);` +
          `var first=null,last=null,t;` +
          `while(t=walker.nextNode()){if(t.nodeValue&&t.nodeValue.length){if(!first)first=t;last=t;}}` +
          `if(!first)return false;` +
          `var rng=document.createRange();rng.setStart(first,0);rng.setEnd(last,last.nodeValue.length);` +
          `s.removeAllRanges();s.addRange(rng);` +
          `return rng.toString().length>0;})()`,
          tabId);
    return !!r;
  }

  // 逐字符受信键入：rawKeyDown→char→keyUp，等价真实键盘输入。
  // 注意：text 字段对 keyDown 和 char 事件都会插入文本，若 keyDown 也带 text 会
  // 造成每个字符插入两遍（知乎标题曾出现"测测试试标标题题"）；rawKeyDown 会忽略
  // text，按下事件不携带文本，仅 char 事件携带，与 Puppeteer keyboard.type 一致。
  // 编辑器（Draft/ProseMirror/Quill…）会按当前光标处的行内样式应用格式。
  async _typeChars(send, text) {
    for (const ch of Array.from(text)) {
      const base = { key: ch, code: '', windowsVirtualKeyCode: 0, modifiers: 0 };
      await send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      await send('Input.dispatchKeyEvent', { ...base, type: 'char', text: ch, unmodifiedText: ch });
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
  }

  // === Tab lifecycle ===

  /**
   * 新建标签页。
   *
   * @param {string|null} url
   * @param {{show?: boolean}} [opts] show=false 时**不把人眼前的页面顶掉**：
   *   视图保持不挂进窗口，但几何照算、脚本照跑、截图照出（后台标签页的完整能力
   *   有 `npm run background` 钉住）。默认 true 是给"人自己点的"和内部调用用的，
   *   agent 侧由 ws_server 显式传 false（见 shared/tab_route.cjs 的说明）。
   */
  newTab(url = null, opts = {}) {
    const tabId = ++this.tabCounter;
    const self = this;
    const view = new BrowserView({
      webPreferences: {
        preload: this._preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Required for the CommonJS preload (bridge.cjs) to `require()` local
        // modules (./extractor.cjs, ./actions.cjs, ./watcher.cjs). A sandboxed
        // preload can only require Electron's whitelist. Security is unchanged:
        // nodeIntegration stays false + contextIsolation true, so page code
        // has no Node access regardless of the OS-level renderer sandbox.
        sandbox: false,
        // 与 installSessionHooks 用的 session.fromPartition(config.viewPartition)
        // 必须一致 —— 否则 will-download / 权限钩子装到了另一个 session 上，
        // 表现是"页面确实请求了下载，但什么都没发生"（实测踩过，见 config.js）。
        partition: config.viewPartition,
        persistStorage: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.tabs.set(tabId, view);
    // 归属在最早的这一刻定下来：后面所有涉及"组"的判断（上限、标签栏、关闭
    // 后清理空组）都读这一条，晚设一步就会出现"页已经在了、但没人认领"的窗口期。
    this._tabGroup.set(tabId, opts.group || tabGroup.HUMAN_GROUP);
    this._tabUsedAt.set(tabId, Date.now());
    // 每个标签页、从出生起就关掉后台节流。以前只在 setActive 里设，于是"从没
    // 被显示过"的标签页永远带着节流：定时器被拉长到 1s、rAF 停摆，站点的轮询/
    // 动画/自动保存全部变慢，而 agent 看起来只是"这一页有点慢"。
    try { view.webContents.setBackgroundThrottling(false); } catch (_) { /* 老版本没有这个方法 */ }

    // Tabs created after a subscribe should inherit the CDP domains already
    // active, so network_response / js_error keep flowing without re-subscribing.
    // _ensureCdp attach + enable is idempotent (attach guarded by _cdpTabs).
    if (this._runtimeSubscribers.size > 0) this._ensureCdp(tabId, view, 'Runtime');
    // Network：默认在首个真实导航前就启用（不再等订阅），否则初始 HTML/API 与
    // 导航阶段发出的 POST 全部丢失 —— agent 永远拿不到它们的请求体。
    // 关闭开关：AI_BROWSER_NETWORK_CAPTURE=0 或 ui.network_configure{enabled:false}。
    this._ensureNetworkCapture(tabId, view);
    // window.open 垫片不在这里调：它返回的 Promise 要被下面的首次导航等
    // （见文件末尾 navWhenShimReady），在这里提前调会消耗掉首次注入。

    // Mask automation fingerprint: remove Electron from UA
    view.webContents.setUserAgent(config.userAgent);

    // beforeunload：Electron 侧的等价物。**不处理它会静默拦住导航** —— 既没有
    // 对话框、也没有报错，表现成"点了链接/调了 navigate，页面就是不动"。
    // 策略和 CDP 那条路共用一套（shared/dialog_policy.cjs）：默认放行。
    view.webContents.on('will-prevent-unload', (e) => {
      const policy = this.dialogPolicy || dialogPolicy.policyFromEnv();
      if (dialogPolicy.allowUnload({ policy })) e.preventDefault();
    });

    // Intercept window.open / new-window → create new tab instead
    view.webContents.setWindowOpenHandler(({ url: urlToOpen }) => {
      // 派生标签页跟**打开它的那一个**走：可见页里弹出来的照旧弹到人眼前
      // （浏览器惯例），后台页里弹出来的留在后台 —— agent 流程里登录/预览/
      // 下载这类弹窗极多，每弹一个就抢一次视野等于人没法用电脑。
      //
      // 归属也跟打开者走：agent 的页弹出来的子页仍然属于那个 agent，否则它会
      // 悄悄跑到"人的标签页"里，下次人清理自己的标签就把 agent 的流程删了。
      const parentGroup = self.groupOfTab(tabId);
      // 弹窗把组撑满时不能拒绝（站点的脚本在等这个窗口），只能牺牲一页：
      // 最久没用、不在人眼前、没有挂着对话框的那个。
      if (!self.canOpenInGroup(parentGroup).allowed) {
        const victim = self.pickEvictableInGroup(parentGroup, tabId);
        if (victim !== null) {
          const deadUrl = (self._getView(victim) || {}).webContents
            ? self._getView(victim).webContents.getURL() : '';
          self.evictions.push({ tab: victim, url: deadUrl, at: Date.now(), reason: 'group-full' });
          if (self.evictions.length > 20) self.evictions.shift();
          self.closeTab(victim);
        }
      }
      const childId = self.newTab(urlToOpen, {
        show: shouldShowChildTab({ openerIsVisible: tabId === self.activeTab }),
        group: parentGroup,
      });
      // Track which source tab opened a new tab so `executeAction` can report the
      // resulting tab and auto-follow it. Generic (any target=_blank / window.open).
      self._openedTabs.set(tabId, { id: childId, at: Date.now(), url: urlToOpen });
      return { action: 'deny' };
    });

    // 可见与否由调用方决定，但**所有**标签页都挂进窗口、用 z 序决定谁在上面。
    //
    // 为什么不"不显示就不挂"（2026-10-28 实测）：没挂进窗口的 BrowserView 根本
    // 没有合成表面 —— 读树/点击/输入/导航全都正常（那走的是渲染进程和 CDP 输入），
    // 但 ui.screenshot 拿到 0 字节、ui.paint_check 直接 no-frame。也就是说
    // "后台标签页"会变成一个**看不见也拍不到**的黑盒，而 agent 恰恰靠截图判断
    // "这一页到底画出什么了"。
    // 挂上去、把可见的那个置顶，就同时得到：真实表面（可截图/可自检）+ 人只看到
    // 他该看的那一页。
    const show = opts.show !== false;
    this._attachView(view);
    if (show || this.activeTab === null) {
      this.setActive(tabId);
    } else {
      this._layoutView(view);
      try { view.webContents.setBackgroundThrottling(false); } catch (_) { /* 老版本 */ }
      // 新挂的视图默认在最上层 —— 马上把"人该看的那一页"顶回去，否则后台新建
      // 的标签页会盖住用户正在看的页面（那就是"抢视野"的另一种形态）。
      const vis = this._getView(this.activeTab);
      if (vis) this._raiseView(vis);
    }

    // canvas 绘制记录必须在**首个真实导航之前**装好，否则页面早画完了什么都录不到。
    // 但它又必须在 setActive 之后：BrowserView 还没被加进窗口时，debugger 通道
    // 不响应（实测 Runtime.enable 直接挂死）。
    // newTab 仍同步返回 tabId（调用方依赖），导航推迟到 hook 装完；安装失败或超时
    // 也照常导航 —— 绝不能因为要录 canvas 就把 tab 卡死。
    // hook 关闭时（当前默认）走原来的同步导航：把导航推迟成异步会引入时序抖动
    // （实测 richtext 偶发 110/111），这个代价不值得为一个未验证通过的功能付。
    if (isCanvasHookEnabled(process.env.AI_BROWSER_CANVAS_HOOK)) {
      // CDP 的 await 命令在页面加载**之后**才可用（刚创建的 tab 上会挂死），
      // 所以装 hook 的时机放在首次加载完成。代价是首屏已经画完的内容拿不回来
      // （configure({reload:true}) 可以补齐）。
      const install = () => { this._ensureCanvasHook(tabId, view).catch(() => false); };
      view.webContents.once('did-finish-load', install);
    }
    // window.open 垫片注入：CDP 命令在**未导航的空 webContents** 上会挂住
    // （实测 Page.enable 都 1.5s 不 resolve —— renderer 没就绪，命令无人
    // 处理）。所以先 load about:blank 把 renderer 垫起来，did-finish-load
    // 后再发注入命令，最后才 loadURL 真实 URL —— 这样首屏 document 一定
    // 带着垫片（addScriptToEvaluateOnNewDocument 注册后跨导航持久）。
    // 占位 tab（window.open 的空窗口，url=null）就停在 about:blank 等
    // location 赋值来导航；赋值到达时注入通常早已完成（源页面 ajax 往返
    // 至少几十毫秒），基本不存在竞态。
    const wc0 = view.webContents;
    const targetUrl = url || null;
    if (wc0 && !wc0.isDestroyed()) {
      // 还没发起真实导航：停在占位页等垫片注入。
      this._tabNavState.set(tabId, 'pending');
      // 垫片就绪信号：先挂上去，再去加载 about:blank。顺序不能反 ——
      // ai:window_open_nav 可能在这一行之后立刻到达（IPC 保序，但它不等我们）。
      let signalReady = () => {};
      const ready = new Promise((resolve) => { signalReady = resolve; });
      this._windowOpenShimReady.set(tabId, ready);
      // 占位页地址：proceed 要用它判断"这一页还在不在等我"。
      const placeholderUrl = this._loadingPlaceholderUrl(targetUrl);
      let proceeded = false;
      const proceed = () => {
        if (proceeded) return;
        proceeded = true;
        Promise.resolve(this._ensureWindowOpenShim(tabId, view)).finally(() => {
          // 失败也放行：宁可这个 tab 没有垫片，也不能把它卡在占位页。
          signalReady();
          if (targetUrl && wc0 && !wc0.isDestroyed()) {
            // ⚠️ 延迟到达的 proceed **绝不能覆盖已经发生的真实导航**。
            //
            // 实测（2026-10-28，npm run background 在 v2.2.0 上同样复现）：
            // 垫片安装偶尔会挂十几秒，这期间 agent 已经把这一页导航走了；
            // 等它终于 resolve，下面这行 loadURL(启动页) 又把页面盖回去 ——
            // 表现是"打开的是目标页，下一刻自己跳回首页"，读到的树也成了首页的。
            // 判据只看一句：现在还在占位页上吗？不在就什么都不做。
            // 注意判据在 shared/placeholder.cjs 里（按文件名，不按字符串相等）——
            // 这里踩过两次：收紧成"必须等于占位页"会让新标签页永远卡住，
            // 而字符串相等在打包路径含空格时恒为 false。
            if (!placeholder.isPlaceholderUrl(wc0.getURL())) return;
            // 让"正在加载"可被观测：白屏最贵的地方不是慢，是慢得无法和
            // "开错了"区分（见 listTabs 的 state 字段）。
            this._tabNavState.set(tabId, 'loading');
            wc0.once('did-finish-load', () => {
              if (this._tabNavState.get(tabId) === 'loading') this._tabNavState.set(tabId, 'ready');
            });
            wc0.loadURL(targetUrl).catch(() => {});
          } else {
            // 无目标 URL 的占位 tab（window.open("") 的老站模式）：它本来就
            // 要停在这里等站点赋 location，不算"卡住"，但也不是就绪。
            this._tabNavState.set(tabId, 'blank');
          }
        });
      };
      // 兜底：占位页的 did-finish-load 万一来不了（renderer 异常、
      // 视图尚未 attach 等），也不能把真实导航永久挂住——1.2s 后照常放行，
      // 最坏退化成"首屏没有垫片"（与修复前一致），而不是打不开页面。
      const guard = setTimeout(proceed, 1200);
      if (guard.unref) guard.unref();
      // ⚠️ 占位页用 loading.html 而不是 about:blank（2026-10-24 修）。
      //
      // 这段等待原本是纯白的 about:blank。快站约 4s，慢站实测 70s（GitHub
      // OAuth 直到 ERR_CONNECTION_TIMED_OUT 才切到错误页）—— 用户和 agent
      // 看到的都是"弹出来一个空白页面"，和"垫片没把导航发出去"那个老 bug
      // （超星"进入学习"）在现象上完全一样，无法区分。
      // loading.html 只做展示（目标地址 + 转圈），不发请求不跳转，真实导航
      // 仍由上面的 proceed 发起。无目标 URL 的占位 tab（window.open("") 的
      // 老站模式）保持 about:blank：它本来就要停在这里等 location 赋值。
      wc0.loadURL(placeholderUrl).catch(() => {});
      wc0.once('did-finish-load', () => { clearTimeout(guard); proceed(); });
    }

    // Force repaint after load — BrowserView content can be loaded but not
    // painted by the compositor. Remove + re-add forces a full repaint.
    //
    // Hook every navigation signal, not just the two load events. Reported
    // symptom: page HAS navigated to the new view (agent reads the new DOM /
    // canvas through the tree and evaluate) but the window keeps showing the
    // previous one until you click tabs back and forth — clicking a tab is
    // exactly what calls removeBrowserView + addBrowserView + setBounds, i.e.
    // it is the only thing that forces the compositor to repaint.
    //
    //   did-navigate-in-page — SPA route changes (history.pushState / hash).
    //     Fires on every router push, which is how canvas-style apps swap views.
    //   did-frame-finish-load — a sub-frame finished loading. ComfyUI-style
    //     editors boot inside an iframe long after the top document finished,
    //     so did-finish-load has already fired and repainted an empty shell.
    //   did-navigate — any cross-document navigation, including programmatic
    //     location.href assignment the app does on its own.
    // ⚠️ 导航事件**不挂任何重绘**（2026-10-25 修）。
    //
    // 历史：这条钩子是为了对付"页面已导航但窗口还显示旧画面"，手段是
    // removeBrowserView + addBrowserView（后来换成 invalidate）。但两者都有代价：
    // remove/add 会闪一帧白；invalidate() 更麻烦 —— 它强制整页重新栅格化，
    // 而在导航刚开始的那一刻，图层的尺寸还是初始值，于是合成器会先把新页面画进
    // 一个小尺寸 surface 再缩放显示：用户看到的就是"先缩成左上角一小块，闪一下，
    // 然后正常"（2026-10-25 用户报"刷新 baidu 总是一闪一闪"）。
    //
    // 现代 Chromium 在正常情况下不会留旧画面；真留住了也有兜底：
    //   - 白屏/缩放自检（_auditPaint）会判 scale-mismatch 并**定向**重绘
    //   - ui.repaint 显式重绘
    //   - 几何变化由 afterGeometryChange 负责收敛
    // 所以这里什么都不挂。回归：npm run layout 的 G5 断言"一次导航不引发任何重绘"。

    this._attachLoadFailureHooks(tabId, view);
    // "画出来了没有"只能主动看（没有对应事件），"渲染进程崩了"要自己救
    // （以前只打一行日志，用户看到的是永久白屏）。
    this._attachPaintHook(tabId, view);
    this._attachCrashRecovery(tabId, view);
    return tabId;
  }

  /**
   * 导航失败 → 显示我们自己的错误页，而不是 Chromium 的 chrome-error:// 空白页。
   *
   * 为什么必须有：实测（2026-10-14）断网后 ui.navigate 到一个不存在的站点，
   * 页面停在 chrome-error://chromewebdata/，document.body 长度 0、
   * 截图 15KB（正常渲染 220KB），**白屏 8 秒不恢复、页面上零个字的提示**。
   * 这正是用户报的"打开 ai-browser 白屏"：不是启动 bug，是连接失败后
   * 浏览器给了一个空白文档，而我们对这个事件零监听。
   *
   * 不替换成错误页的话，人（产品承诺人可以随时手动介入）看到一块白，
   * agent（ui.get_tree）也读不到任何东西 —— 两头都瞎。
   *
   * 只处理 isMainFrame 的失败：子资源（图片/字体/JS）加载失败太常见，
   * 不该把整个页面换成错误页。aborted 是页面自己取消的请求（通常是正常的
   * 跳转竞态），也不算失败。
   */
  _attachLoadFailureHooks(tabId, view) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    if (!this._failureHooked) this._failureHooked = new WeakSet();
    if (this._failureHooked.has(view.webContents)) return;
    this._failureHooked.add(view.webContents);

    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED：页面自己取消的请求，通常是导航竞态，不是真的失败。
      if (errorCode === -3) return;
      // 防重入：错误页自己加载失败时不要无限套娃。
      // 用普通 Set 而不是 WeakSet —— tabId 是整数，WeakSet.add(整数) 会抛
      // "Invalid value used in weak set"，而那行异常会从 Electron 的事件回调里
      // 冒出去，把 loadURL 的 Promise 一起挂死（实测：navigate 到不通的端口，
      // WS 请求 10s 不返回、页面停在 chrome-error:// 白屏）。
      if (!this._failureGuard) this._failureGuard = new Set();
      if (this._failureGuard.has(tabId)) return;
      this._failureGuard.add(tabId);

      let pagePath = null;
      try {
        pagePath = path.join(__dirname, '../renderer/error_page.html');
      } catch (_) { return; }

      const target = placeholder.fileUrlWithQuery(pagePath, {
        url: String(validatedURL || ''),
        code: String(errorCode),
        text: String(errorDescription || ''),
      });
      try {
        if (!target) throw new Error('bad page path');
        view.webContents.loadURL(target);
      } catch (e) {
        console.error('[page_manager] error page load failed:', e.message);
        this._failureGuard.delete(tabId);
        return;
      }
      // 让 agent 也能读到失败（订阅了事件的会话），而不是只有人看得到。
      this._broadcast('load_failed', {
        tab: tabId,
        url: String(validatedURL || ''),
        error_code: errorCode,
        error: String(errorDescription || ''),
      });
      // 同一件事落盘。错误页在界面上看得见，但"哪个 tab、哪个网址、错误码多少"
      // 一旦进程退出就查不回来了（load_failed 只是一次内存广播）。
      recordError('nav_fail', {
        tab: tabId,
        url: String(validatedURL || ''),
        error_code: errorCode,
        error: String(errorDescription || ''),
        error_page: 'shown',
      });
      // 错误页本身加载成功后清掉防重入标记，否则同 tab 后续失败都不显示。
      view.webContents.once('did-finish-load', () => {
        if (this._failureGuard) this._failureGuard.delete(tabId);
      });
    });
  }

  /**
   * Attach compositor-repaint hooks to a tab's webContents.
   * Idempotent per tab: re-registering would schedule redundant remove/add
   * cycles, so a WeakSet of hooked views guards it.
   */
  /**
   * 已废弃：以前用来给"后来才导航的 tab"补挂重绘钩子。现在导航事件一律不重绘
   * （原因见 newTab 里的长注释），这里只留一个空实现，避免调用点报错。
   */
  _attachRepaintHooks() {}

  _scheduleRepaint(tabId, delay = 120) {
    const prev = this._repaintTimers.get(tabId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._repaintTimers.delete(tabId);
      const view = this._getView(tabId);
      if (view) this._forceRepaint(view);
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    this._repaintTimers.set(tabId, t);
  }

  /**
   * Remove + re-add the BrowserView to force the compositor to paint it.
   * Safe for a non-active tab too: the view is re-added in the same position
   * (only the active view is normally attached, so re-adding an inactive one
   * would show it — guard by re-asserting the active view afterwards).
   */
  /**
   * 窗口几何变过之后调一次：重排 → 软重绘 → 160ms 后确认渲染视口真的跟上了。
   *
   * 为什么不能只 setBounds：实测（e2e/layout_ws 的 G2，2026-10-25）窗口从
   * 1280 缩到 800 之后，视图 bounds 已经是 800，但页面 `innerWidth` 还是 1280 ——
   * 也就是渲染器没接到/没应用这次尺寸变化。此时合成器会把 1280 宽的内容画进
   * 800 的框里，内容整体缩小或错位；等它某一刻突然追上，就是用户说的
   * "一闪一闪、大一下小一下"。
   * 确认的方式和判定口径一致：innerWidth 必须等于视图宽度。不等就做一次 hard
   * 重绘（1px 微调会强制 Chromium 重算 surface 与布局）—— 这时代价是值得的，
   * 因为画面本来就是错的。
   */
  afterGeometryChange() {
    const tid = this.activeTab;
    const view = this._getView(tid);
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    try { this._layoutView(view); } catch (_) { return; }
    this._forceRepaint(view);           // soft：不可见
    const timer = setTimeout(async () => {
      try {
        const v = this._getView(tid);
        if (!v || !v.webContents || v.webContents.isDestroyed()) return;
        const b = v.getBounds();
        const raw = await withDeadline(this.evaluate('(function(){return String(window.innerWidth);})()', tid), 1500, 'geom_iw');
        const iw = Number((raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw) || 0;
        if (iw > 0 && b.width > 0 && Math.abs(iw - b.width) > 2) {
          recordError('layout_mismatch', {
            tab: tid, phase: 'after-resize',
            expected: { width: b.width }, actual: { innerWidth: iw },
          });
          this._forceRepaint(v, { hard: true });
        }
      } catch (_) { /* renderer 正在忙/已销毁：下一次 resize 会再来一次 */ }
    }, 160);
    if (timer.unref) timer.unref();
  }

  /**
   * 让合成器重新画一次，分两档。
   *
   * soft（默认）：只 webContents.invalidate() —— 不改几何、不重排、不可见。
   * hard：额外做 1px 微调（width+1 再 width），因为**只有尺寸变化才会让 surface
   *       重新栅格化**（尺寸不变时 setBounds 被 Chromium 直接忽略）。
   *
   * 为什么要分档（2026-10-25 用户报"一闪一闪、大一下小一下"）：
   * 1px 微调必然触发两次重排，文字会肉眼可见地跳一下；再叠 removeBrowserView /
   * addBrowserView 还会闪一帧白。把这套放在"每次导航完成 / 每次窗口焦点变化"
   * 这种高频路径上，就变成了用户看到的抽搐。
   * 所以高频路径一律 soft；只有"确认 surface 尺寸脱节"（scale-mismatch、白屏阶梯）
   * 才付 hard 的代价。
   *
   * 也不再 remove/add：那是过去没有 invalidate 时的唯一手段，代价是闪一帧白，
   * 而现在 invalidate 覆盖了它的作用。
   */
  _forceRepaint(view, opts = {}) {
    const hard = opts && opts.hard === true;
    const tabId = this._tabIdOfView(view);
    if (tabId === null) return false;
    const wc = view.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      wc.invalidate();
    } catch (e) {
      return false;
    }
    // Cumulative counter, reported by ui.repaint / ui.window_bounds. Not just a
    // debug aid: it is the only externally observable proof that a repaint
    // actually happened, and (for hard) that no geometry nudge leaked into a
    // hot path.
    this._repaintCount = (this._repaintCount || 0) + 1;
    if (!hard) return true;
    try {
      const b = view.getBounds();
      view.setBounds({ ...b, width: b.width + 1 });
      view.setBounds(b);
      this._hardRepaintCount = (this._hardRepaintCount || 0) + 1;
    } catch (e2) { /* 视图正在销毁 */ }
    return true;
  }

  _tabIdOfView(view) {
    for (const [id, v] of this.tabs) if (v === view) return id;
    return null;
  }

  // === 白屏自检 ==============================================================
  //
  // 为什么这一层以前不存在，而它必须存在：
  //   "网络失败"有 did-fail-load（→ 错误页），"渲染进程死了"有 render-process-gone，
  //   但**"页面加载成功、DOM 也有内容、屏幕上却是纯白"**这一类没有任何事件。
  //   它是唯一一种"所有回调都成功"的失败形态，所以只能靠主动看一眼画面。
  //   2026-10-25 用户报"打开了百度有时候是纯白屏"就是这一类 —— 当时工具侧
  //   （evaluate / get_tree / screenshot）全都读得到内容，等于集体失明。
  //
  // 观测口径写在 shared/blank_page.cjs：白度 + 唯一色数 + DOM 事实，三者一起判。

  /** 页面自述的事实：有多少字、多少个节点、到哪一步了。 */
  static PAINT_DOM_JS =
    '(function(){var b=document.body,d=document.documentElement;' +
    'var t=b?(b.innerText||b.textContent||""):"";' +
    'return JSON.stringify({' +
    'text_len:t.replace(/\\s+/g," ").trim().length,' +
    'nodes:document.querySelectorAll("*").length,' +
    'ready_state:document.readyState,' +
    // 渲染口径的三个数：布局视口宽高 + 设备像素比。它们是"窗口几何 vs 实际渲染"
    // 对不上的唯一证据 —— 视图 bounds 1300 而 innerWidth 325，说明页面被按 1/4
    // 缩放渲染（2026-10-25 用户截图那种"内容缩在左上角"就属于这一类）。
    'iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio,' +
    'url:location.href});})()';

  /**
   * 看一眼这个 tab 现在到底画出来了没有（只读，不改任何东西）。
   *
   * 两个数据源，缺一不可：
   *   1. 位图 —— webContents.capturePage()，走 view 自己的 surface，和用户截图同源。
   *      缩到 240px 宽再统计：判"是不是白"不需要细节，缩图把统计开销从 ~3.5M 像素
   *      降到 ~5 万，单次自检从几十毫秒降到个位数。
   *   2. DOM 事实 —— 有文字/有节点却纯白，才是缺陷；本来就空的页纯白是正确的。
   *
   * @returns {Promise<{ok:boolean, tab:number, blank:boolean, verdict:string,
   *   reason:string, white_ratio?:number, unique?:number, dom?:object,
   *   bounds?:object, layout_ok?:boolean, ms?:number, error?:string}>}
   */
  async paintCheck(tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'tab-destroyed', tab: tid };
    const startedAt = Date.now();

    let bounds = null;
    try { bounds = view.getBounds(); } catch (_) { /* 视图正在销毁 */ }

    // 布局是否占了该占的地方。压在 0 高/0 宽上时页面"白"不是内容问题，
    // 是没人给它地方画 —— 这两种在截图上长得一样，必须靠几何量分开。
    let expected = null;
    let layoutOk = null;
    try {
      const cb = this.window.getContentBounds();
      expected = {
        width: cb.width,
        height: Math.max(0, cb.height - config.tabBarHeight - (this._bottomInset || 0)),
      };
      if (bounds) {
        layoutOk = bounds.width >= expected.width - 2 && Math.abs(bounds.height - expected.height) <= 2;
      }
    } catch (_) { /* 窗口已销毁 */ }

    let dom = { text_len: 0, nodes: 0, ready_state: '' };
    try {
      const raw = await withDeadline(this.evaluate(PageManager.PAINT_DOM_JS, tid), 2000, 'paint_dom');
      const s = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
      const parsed = typeof s === 'string' ? JSON.parse(s) : null;
      if (parsed) dom = parsed;
    } catch (_) {
      // 读不到 DOM 事实（渲染器卡住/正在崩溃）。继续往下走：宁可只用位图判，
      // 也不要因为"诊断都失败了"就跳过诊断本身。
    }

    let stats = null;
    let frameError = null;
    try {
      // 位图来源，优先级从"最不容易打扰合成器"往下排：
      //
      // 1) webContents.capturePage() —— 不碰 CDP 的 Page 域、没有 capture 模式，
      //    只是把视图自己的 surface 拷一份。窗口被别的窗口盖住时会返回空图
      //    （isEmpty()），这时跳过、交给下一档，绝不据此判"页面是白的"。
      // 2) CDP Page.captureScreenshot，**不带 clip / scale**。
      //
      // ⚠️ 2026-10-25 血泪：这里原本是
      //     clip: {x:0,y:0,width:w,height:h, scale:0.25}
      // 图省事把统计用的图直接缩到 1/4。带 clip.scale 的截图会让 Chromium
      // **按该比例临时重建 surface**；自检又恰好在 did-finish-load+450ms 跑，
      // 那几十毫秒里窗口往往正在重新合成，于是把这张 1/4 的图贴上去 1–3 帧，
      // 用户看到的就是"每次加载先小一下再恢复"。实测抓到的那一帧内容宽度
      // 正好是 25%，与 clip.scale 一致。
      // 结论：**缩放只许在我们自己这边做**（nativeImage.resize），不许交给合成器。
      try {
        const img0 = await withDeadline(wc.capturePage(), 3000, 'capturePage');
        if (img0 && typeof img0.isEmpty === 'function' && !img0.isEmpty()) {
          const small0 = img0.resize({ width: 240 });
          stats = blankPage.statsFromBitmap(small0.toBitmap());
        }
      } catch (_) { /* 视图被遮挡/正在销毁：交给 CDP 档 */ }
      if (!stats) {
        const shot = await withDeadline(
          (() => {
            this._ensureCdp(tid, view, 'Page');
            return view.webContents.debugger.sendCommand('Page.captureScreenshot', {
              format: 'jpeg',
              quality: 70,
              fromSurface: true,
            });
          })(),
          5000, 'paint_shot'
        ).catch(() => null);
        if (shot && shot.data) {
          const img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
          if (img && !img.isEmpty()) {
            const small = img.resize({ width: 240 });
            stats = blankPage.statsFromBitmap(small.toBitmap());
          }
        }
      }
    } catch (e) {
      frameError = e && e.message ? e.message : String(e);
    }

    let cls = blankPage.classifyPaint({ stats, dom, bounds });
    // 渲染口径与视图几何必须相等。不等只有两种原因：用户主动缩放（合法）或
    // **合成器把旧尺寸的 surface 缩进了新 bounds**（就是"内容缩成左上角一小块"）。
    // 用 zoomFactor 把两者分开：页面缩放有明确的 zoom 值，surface 脱节时 zoom 仍是 1。
    let zoom = null;
    try { zoom = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() : null; } catch (_) {}
    let iw = Number(dom && dom.iw) || 0;
    let mismatched = bounds && bounds.width > 0 && iw > 0 && Math.abs(iw - bounds.width) > 2
      && (zoom === null || Math.abs(zoom - 1) < 0.01);
    if (mismatched) {
      // 刚 resize 完的那一两帧里 innerWidth 会短暂滞后（布局还没跟上新尺寸），
      // 直接判 scale-mismatch 就会误触发 hard 重绘 —— 而 hard 会重排两次，
      // 用户看到的就是"大一下小一下"（2026-10-25 真机就这么抖的）。
      // 所以等 120ms 再读一次：还是不一致才算 surface 真的脱节。
      await new Promise((r) => { const t = setTimeout(r, 120); if (t.unref) t.unref(); });
      let iw2 = 0;
      try {
        const raw2 = await withDeadline(this.evaluate(PageManager.PAINT_DOM_JS, tid), 2000, 'paint_dom2');
        const s2 = (raw2 && typeof raw2 === 'object' && 'value' in raw2) ? raw2.value : raw2;
        const parsed2 = typeof s2 === 'string' ? JSON.parse(s2) : null;
        iw2 = Number(parsed2 && parsed2.iw) || 0;
      } catch (_) { /* 读不到就按原判断 */ }
      if (iw2 > 0) {
        if (Math.abs(iw2 - bounds.width) <= 2) mismatched = false;
        else iw = iw2;
      }
    }
    if (mismatched) {
      cls = {
        verdict: 'scale-mismatch',
        blank: cls.blank,
        reason: `page lays out at ${iw}px but the view is ${bounds.width}px wide (zoom=${zoom})`
          + ' — the compositor is drawing a stale surface',
      };
    }
    // 还在"正在打开…"占位页（file:///…/loading.html?url=…）上：真实导航排在建
    // 垫片之后，还没开始。这时既不是白屏也不是就绪 —— 报 not-ready 才会让调用方
    // "等一会儿"而不是"这页坏了"。这个状态在 new_tab 回执后约 100–200ms 内可见。
    const onPlaceholder = dom && dom.url && /\/loading\.html(\?|$)/.test(String(dom.url));
    const verdict = onPlaceholder ? 'not-ready' : cls.verdict;
    const reason = onPlaceholder
      ? 'still on the loading placeholder — the real navigation has not started yet'
      : cls.reason;
    const blank = cls.blank;
    // 观测到的就是最新结论，落进 _paintState —— 否则 list_tabs 报的是"上一轮自动
    // 自检"的旧结论，和调用方刚刚 paint_check 到的结果自相矛盾。
    // no-frame 不落（那不是对页面的判断，而是我们没看见）。
    if (verdict !== 'no-frame') {
      this._paintState.set(tid, { tab: tid, blank, verdict, reason, dom, at: Date.now(), action: 'none' });
    }
    return {
      ok: true,
      tab: tid,
      blank,
      verdict,
      reason,
      ...(stats ? {
        white_ratio: Math.round(stats.white_ratio * 1000) / 1000,
        unique: stats.unique,
        ...(stats.unique_pinned ? { unique_pinned: true } : {}),
      } : {}),
      dom,
      ...(bounds ? { bounds: { width: bounds.width, height: bounds.height } } : {}),
      ...(expected ? { expected } : {}),
      ...(layoutOk !== null ? { layout_ok: layoutOk } : {}),
      ...(frameError ? { frame_error: frameError } : {}),
      ms: Date.now() - startedAt,
    };
  }

  /**
   * 布局看门狗：活动视图的几何必须等于"内容区"。
   *
   * 为什么需要它：窗口尺寸变了而视图没跟上，是**没有任何事件会报**的一类失败 ——
   * 事件只告诉你"窗口 resize 了"，不告诉你"视图还是旧尺寸"。视图比窗口大时，
   * 合成器会把那张大 surface 缩进新 bounds，表现就是"页面缩成左上角一小块、
   * 其余全白"（2026-10-25 用户截图）。此时 DOM/截图全都正常，只有窗口像素不对。
   *
   * 所以：每次自检顺手量一下几何，错了就当场纠正并落一条 layout_mismatch ——
   * 这样下次再出现，error.jsonl 里会有窗口尺寸和视图尺寸的实际数字。
   */
  _auditLayout(tabId) {
    const view = this._getView(tabId);
    if (!view || !view.webContents || view.webContents.isDestroyed()) return null;
    let expected;
    try {
      const cb = this.window.getContentBounds();
      expected = {
        x: 0,
        y: config.tabBarHeight,
        width: cb.width,
        height: Math.max(0, cb.height - config.tabBarHeight - (this._bottomInset || 0)),
      };
    } catch (_) { return null; }
    let actual;
    try { actual = view.getBounds(); } catch (_) { return null; }
    const bad = actual.width < expected.width - 2
      || Math.abs(actual.height - expected.height) > 2
      || actual.x !== expected.x
      || actual.y !== expected.y;
    if (!bad) return { ok: true, expected, actual };
    // 不一致时先复核一次再动手：窗口刚变化的那一两百毫秒里，getContentBounds 与
    // 视图 bounds 会短暂对不上，此刻"纠正"等于把视图改成中间尺寸 —— 那正是
    // "页面缩成左上角一小块"的成因之一。宁可晚 120ms 修，也不要修错。
    return this._confirmAndFixLayout(tabId, expected, actual);
  }

  _confirmAndFixLayout(tabId, expected, actual) {
    const view = this._getView(tabId);
    if (!view) return { ok: false, expected, actual, fixed: false };
    const t = setTimeout(() => {
      try {
        const v = this._getView(tabId);
        if (!v || !v.webContents || v.webContents.isDestroyed()) return;
        let cb;
        try { cb = this.window.getContentBounds(); } catch (_) { return; }
        const exp = {
          x: 0,
          y: config.tabBarHeight,
          width: cb.width,
          height: Math.max(0, cb.height - config.tabBarHeight - (this._bottomInset || 0)),
        };
        let act;
        try { act = v.getBounds(); } catch (_) { return; }
        const stillBad = act.width < exp.width - 2
          || Math.abs(act.height - exp.height) > 2
          || act.x !== exp.x || act.y !== exp.y;
        if (!stillBad) return;   // 只是中间态，已经自己好了
        try {
          this._layoutView(v);
          v.webContents.invalidate();
        } catch (_) { /* 视图正在销毁 */ }
        recordError('layout_mismatch', { tab: tabId, expected: exp, actual: act });
        this._broadcast('layout_mismatch', { tab: tabId, expected: exp, actual: act });
      } catch (_) { /* 忽略 */ }
    }, 120);
    if (t.unref) t.unref();
    return { ok: false, expected, actual, fixed: 'deferred' };
    try {
      this._layoutView(view);
      view.webContents.invalidate();
    } catch (_) { /* 视图正在销毁 */ }
    const info = { tab: tabId, expected, actual };
    recordError('layout_mismatch', info);
    this._broadcast('layout_mismatch', info);
    return { ok: false, expected, actual, fixed: true };
  }

  /**
   * 排一次自检。合并连发的导航事件；只对**活动** tab 做 —— 后台 tab 不在屏幕上，
   * 它"白不白"没有用户可见的后果，为它反复 capturePage 只是白烧 CPU。
   */
  _schedulePaintAudit(tabId, delay = 450) {
    if (!this._paintAuditEnabled) return;
    if (tabId !== this.activeTab) return;
    // 窗口不可见（隐藏/最小化/后台运行）时**不做**判定：这时"屏幕上有没有画出来"
    // 没有观测意义，取帧拿到的要不是空的、要不是陈旧的，而阶梯会据此 reload ——
    // 那是自己制造的一场重载风暴（后台 agent 每加载一页就刷一次）。
    // 人把窗口点开时由 ui.window{visible:true} 走 afterShowRelayout + 一次自检。
    if (!this._windowVisible()) return;
    const prev = this._paintTimers.get(tabId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._paintTimers.delete(tabId);
      this._auditPaint(tabId).catch(() => {});
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    this._paintTimers.set(tabId, t);
  }

  /**
   * 自检入口。合并并发调用：**同一 tab 同时只跑一轮**，后来的调用者拿到正在跑的那一轮。
   *
   * 为什么不是"发现已在跑就返回 null"：自动自检（did-finish-load 后 450ms）和
   * 调用方的 ui.paint_check{heal:true} 很容易撞在一起，返回 null 会让调用方
   * 拿到一个"什么都没有"的结论，然后自己猜。共享同一个 Promise 才是对的。
   */
  async _auditPaint(tabId) {
    if (!this._paintAuditEnabled) return null;
    const inflight = this._paintAuditInflight.get(tabId);
    if (inflight) return inflight;
    let p;
    p = this._auditPaintNow(tabId).finally(() => {
      if (this._paintAuditInflight.get(tabId) === p) this._paintAuditInflight.delete(tabId);
    });
    this._paintAuditInflight.set(tabId, p);
    return p;
  }

  /**
   * 自检 + 按阶梯自救（真正的执行体，递归时直接调它，避免绕回合并逻辑死等自己）。
   *
   * 阶梯（见 blank_page.decidePaintAction）：repaint → reload → give-up。
   * 有上限是硬要求：CSS 自己把文字刷成白色的页面，reload 一万次也还是白，
   * 而无限重试会变成一个看不见的死循环（CPU 烧着、页面反复重载、用户看到的仍是白屏，
   * 而且没有任何地方说过"我试过了、没用"）。
   */
  async _auditPaintNow(tabId) {
    {
      // 先量几何再量画面：视图没跟上窗口时，像素判定的意义有限（看到的是一张
      // 被缩放的旧 surface），而且这个错误必须先修，否则后面的重画都白做。
      this._auditLayout(tabId);
      const res = await this.paintCheck(tabId);
      if (!res.ok) return res;
      const steps = this._paintSteps.get(tabId) || 0;
      const action = blankPage.decidePaintAction({ verdict: res.verdict, steps });
      const rec = { ...res, action, at: Date.now() };
      this._paintState.set(tabId, rec);

      if (action === 'none') return rec;

      const view = this._getView(tabId);
      if (!view || !view.webContents || view.webContents.isDestroyed()) return rec;
      if (action === 'repaint') {
        this._paintSteps.set(tabId, steps + 1);
        // 这里必须 hard：被判成白屏/scale-mismatch 时，surface 很可能就是旧尺寸，
        // 只 invalidate 不会重新栅格化。用户已经看到坏画面了，1px 重排的代价无所谓。
        this._forceRepaint(view, { hard: true });
        await new Promise((r) => { const t = setTimeout(r, 320); if (t.unref) t.unref(); });
        return this._auditPaintNow(tabId);
      }
      if (action === 'reload') {
        this._paintSteps.set(tabId, steps + 1);
        this._paintSelfReload.add(tabId);
        try {
          view.webContents.reload();
        } catch (e) {
          this._paintSelfReload.delete(tabId);
          return rec;
        }
        await this._waitFinishLoad(tabId, 10000);
        await new Promise((r) => { const t = setTimeout(r, 450); if (t.unref) t.unref(); });
        return this._auditPaintNow(tabId);
      }
      // give-up：救不动就如实上报。这是唯一能让人知道"白屏是真的、重试没用"的地方。
      const info = {
        tab: tabId,
        url: res.dom && res.dom.url,
        verdict: res.verdict,
        reason: res.reason,
        white_ratio: res.white_ratio,
        unique: res.unique,
        attempts: steps,
      };
      recordError('paint_blank', info);
      this._broadcast('paint_blank', info);
      return rec;
    }
  }

  /** 等到 did-finish-load（或超时）。只用于自救后的确认，不影响导航本身。 */
  _waitFinishLoad(tabId, timeoutMs) {
    const view = this._getView(tabId);
    if (!view || !view.webContents || view.webContents.isDestroyed()) return Promise.resolve(false);
    const wc = view.webContents;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { wc.removeListener('did-finish-load', onLoad); } catch (_) {}
        clearTimeout(timer);
        resolve(ok);
      };
      const onLoad = () => finish(true);
      wc.once('did-finish-load', onLoad);
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (timer.unref) timer.unref();
    });
  }

  /**
   * 给一个 tab 挂上自检钩子（幂等）。
   *
   * 为什么是 did-finish-load + dom-ready 两条：did-finish-load 在长轮询/SPA 上可能
   * 迟迟不来（那正是首屏白最久的时候），dom-ready 是更早的第二落点。两次都被
   * _schedulePaintAudit 按 tab 合并，不会真的跑两遍。
   */
  _attachPaintHook(tabId, view) {
    if (!this._paintAuditEnabled) return;
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    if (!this._paintAuditHooked) this._paintAuditHooked = new WeakSet();
    if (this._paintAuditHooked.has(view)) return;
    this._paintAuditHooked.add(view);
    const onLoad = () => {
      // 自己触发的 reload 不清零补救步数 —— 否则 "reload 后还是白" 会重新从
      // repaint 开始，变成"重载 → 再重载"的无限循环。
      if (this._paintSelfReload.has(tabId)) {
        this._paintSelfReload.delete(tabId);
      } else {
        this._paintSteps.set(tabId, 0);
        this._paintState.delete(tabId);
      }
      this._schedulePaintAudit(tabId, 450);
    };
    view.webContents.on('did-finish-load', onLoad);
    view.webContents.on('dom-ready', () => this._schedulePaintAudit(tabId, 900));
  }

  /**
   * 渲染进程崩了 → 自己重载一次。
   *
   * 以前这里只有 console.error：进程崩溃后 Chromium 给窗口留一块**白**的
   * surface，事件不再来，DOM 读不到，用户看到的是永久白屏，而日志里只有一行。
   * reload 之后 Chromium 会重新拉一个渲染进程，页面照常回来。
   * 15 秒内只救一次：崩了又崩说明是死循环，重载只会让人反复看着它闪。
   */
  _attachCrashRecovery(tabId, view) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return;
    if (!this._crashHooked) this._crashHooked = new WeakSet();
    if (this._crashHooked.has(view)) return;
    this._crashHooked.add(view);
    view.webContents.on('render-process-gone', (_e, details) => {
      const reason = (details && details.reason) || 'unknown';
      let url = null;
      try { url = view.webContents.getURL(); } catch (_) {}
      recordError('render_process_gone', { tab: tabId, reason, exit_code: details && details.exitCode, url });
      if (reason === 'clean-exit') return;
      const last = this._crashReloadAt.get(tabId) || 0;
      if (Date.now() - last < 15000) return;
      this._crashReloadAt.set(tabId, Date.now());
      try {
        view.webContents.reload();
        this._broadcast('tab_recovered', { tab: tabId, reason, action: 'reload', url });
      } catch (_) { /* 视图已销毁 */ }
    });
  }

  /**
   * Repaint on demand (ui.repaint). The "page shows stale content" case has
   * no observable state to detect it from — the DOM and evaluate already report
   * the NEW page while the compositor shows the OLD one — so the agent needs an
   * explicit "I know this window looks wrong, redraw it" call rather than a
   * heuristic.
   */
  repaint(tabId, opts = {}) {
    const tid = tabId !== undefined && tabId !== null ? tabId : this.activeTab;
    const view = this._getView(tid);
    if (!view) return { ok: false, error: 'no-such-tab', tab: tid };
    // Cancel any queued repaint so this one is the last word.
    const pending = this._repaintTimers.get(tid);
    // `was_pending` is how a caller tells whether the navigation hooks are
    // alive: right after a navigation there is normally a queued repaint; once
    // it has drained, there is none. It also tells the agent "you did not need
    // to ask, the browser already scheduled one" — i.e. the window was stale
    // for ~120ms and has since caught up on its own.
    if (pending) { clearTimeout(pending); this._repaintTimers.delete(tid); }
    const ok = this._forceRepaint(view, { hard: opts && opts.hard === true });
    return { ok, tab: tid, was_active: tid === this.activeTab, was_pending: !!pending, repaint_count: this._repaintCount || 0 };
  }

  closeTab(tabId) {
    const view = this._getView(tabId);
    if (!view) return false;
    this.window.removeBrowserView(view);
    if (view.webContents && !view.webContents.isDestroyed()) {
      try { view.webContents.debugger.detach(); } catch(e) {}
      view.webContents.close();
    }
    this.tabs.delete(tabId);
    this._forgetTab(tabId);
    // window.open 垫片记账：这个 tab 若是某次 window.open 的目标，token 已
    // 失去意义（nav 到达也只会在上面打一行 warn），清掉防止 Map 无限增长。
    for (const [token, entry] of this._windowOpenTokens) {
      if (entry.tabId === tabId) this._windowOpenTokens.delete(token);
    }
    this._windowOpenShimTabs.delete(tabId);
    this._windowOpenShimReady.delete(tabId);
    this._tabNavState.delete(tabId);
    // 对话框状态跟着 tab 走：留着会让下次同 id 的 tab 继承一个不存在的对话框。
    this._lastDialog.delete(tabId);
    this._openDialogs.delete(tabId);
    this._dialogWatched.delete(tabId);
    // Release per-tab network resources so a closed tab can never leak its
    // debugger attachment or cached request entries / stale monitors.
    this._cleanupTabResources(tabId);
    if (this.activeTab === tabId || this.activeTab === null) {
      // switch to first remaining tab — must re-addBrowserView
      const first = this.tabs.keys().next();
      this.activeTab = first.done ? null : first.value;
      // 上面是直接改 activeTab（没走 setActive），monitor 不会自己知道；
      // 不同步的话它会一直拿已关闭的 tab 当"活跃 tab"，淘汰顺序就反了。
      this.networkMonitor.setActiveTab(this.activeTab);
      if (!first.done) {
        const nextView = this._getView(this.activeTab);
        this.window.addBrowserView(nextView);
        this._layoutView(nextView);
        // Force repaint
        nextView.webContents.setBackgroundThrottling(false);
      }
    }
    return true;
  }

  // Tear down a closed tab's network-monitoring bookkeeping:
  //  - detach that tab's shared per-tab debugger (other tabs/subscribers are
  //    unaffected — each tab owns its own webContents debugger)
  //  - drop cached request entries made on that tab
  _cleanupTabResources(tabId) {
    const entry = this._cdpTabs.get(tabId);
    if (entry) {
      try { entry.wc.debugger.detach(); } catch(e) {}
      this._cdpTabs.delete(tabId);
    }
    for (const [requestId, r] of this._networkRequestMap) {
      if (r.tabId === tabId) this._networkRequestMap.delete(requestId);
    }
    // 释放该 tab 的抓包日志与 body 内存，避免关掉的 tab 继续占着配额。
    this.networkMonitor.clearBodyFetcher(tabId);
    this.networkMonitor.clear(tabId);
    // 该 tab 上取的快照基线一并没有意义了：页面已经没了，之后拿它 diff 只会
    // 得到一堵"全变了"；而留着它则会让整份快照值一直占着内存。
    for (const [sid, s] of this._snapshots) {
      if (s.tab === tabId) this._snapshots.delete(sid);
    }
    // 同理，下载记录只对"这个 tab 还在"有意义。注意**只清记录，不删文件** ——
    // 文件是用户要的东西，删文件是另一个决定，不能藏在关 tab 里。
    this.downloadMonitor.clearTab(tabId);
    // tabId 会被复用，媒体文档记录跟着一起清 —— 否则新 tab 一打开就带着
    // 上一个 tab 的「下载」按钮状态（地址对不上时 recordOf 会兜住，但别依赖兜底）。
    if (this.mediaInline) this.mediaInline.forget(tabId);
    // 白屏自检 / 崩溃自救的 per-tab 状态。不清的话 tabId 会被新 tab 复用，
    // 新 tab 一开就继承上一任的"已经救过两步"，白屏时直接被判定成 give-up。
    this._paintState.delete(tabId);
    this._paintSteps.delete(tabId);
    this._paintSelfReload.delete(tabId);
    this._crashReloadAt.delete(tabId);
    const pt = this._paintTimers.get(tabId);
    if (pt) { clearTimeout(pt); this._paintTimers.delete(tabId); }
  }

  /** 白屏相关的"值得报出去的结论"；正常页面返回 null（listTabs 不带这个字段）。 */
  _paintProblem(tabId) {
    const p = this._paintState.get(tabId);
    if (!p) return null;
    // 这四种都不是"用户可见的白屏"，不该出现在 list_tabs 里：
    //   ok / empty-legit 是正常，not-ready 是还没加载完，no-frame 是**我们自己
    //   没看到画面**（视图被销毁等）—— 把诊断失败说成页面故障，是最坏的一种谎。
    if (p.verdict === 'ok' || p.verdict === 'empty-legit' || p.verdict === 'not-ready' || p.verdict === 'no-frame') return null;
    return {
      blank: !!p.blank,
      verdict: p.verdict,
      reason: p.reason,
      action: p.action,
    };
  }

  listTabs() {
    const list = [];
    for (const [id, view] of this.tabs) {
      const gid = this.groupOfTab(id);
      const g = this.groupMeta(gid);
      list.push({
        id,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        active: id === this.activeTab,
        // 归属：'human' = 人的页，'agent:<session>' = 某个 agent 的工作区。
        // agent 靠它判断"这一页是不是我的"，人靠它在标签栏归拢。
        group: gid,
        group_label: g.label,
        ...(g.color ? { group_color: g.color } : {}),
        ...(g.capped === true && g.limit ? { group_limit: g.limit } : {}),
        ...(g.kind === 'agent' ? { group_kind: 'agent' } : {}),
        // 'pending' = 停在占位页等脚本注入（真实导航还没发起）
        // 'loading' = 真实导航已发起、还没完成 —— 这时候页面多半还是空的，
        //             是"正在打开"而不是"开错了"，等它，不要重试
        // 'blank'   = window.open("") 的占位 tab，在等站点赋 location
        // 'ready'   = 已就绪（没有记录时也按就绪处理）
        state: this._tabNavState.get(id) || 'ready',
        // 只有 manual 策略下才会长期存在。auto 模式下对话框在打开的瞬间就被
        // 应答了，所以正常情况这个字段不出现 —— 出现即意味着"有人需要点它"。
        ...(this._openDialogs.has(id) ? { dialog: this._openDialogs.get(id) } : {}),
        // 白屏只在与众不同时出现：正常页面不带这个字段（省 token，也不给
        // 调用方制造"每次都要判"的噪音）。出现即"这一页没画出来"。
        ...(this._paintProblem(id) ? { paint: this._paintProblem(id) } : {}),
      });
    }
    return list;
  }

  /**
   * 把视图挂进窗口（幂等）。所有标签页都挂着，靠 z 序决定谁可见 ——
   * 原因见 newTab 里的注释（没挂 = 没表面 = 截不到图）。
   */
  _attachView(view) {
    if (!view || !this.window) return;
    try {
      const attached = this.window.getBrowserViews ? this.window.getBrowserViews() : [];
      if (attached.indexOf(view) < 0) this.window.addBrowserView(view);
    } catch (_) { /* 窗口正在销毁 */ }
  }

  /** 把某个视图提到最上层（= 人看到它）。老版本没有 setTopBrowserView 时退回 remove+add。 */
  _raiseView(view) {
    if (!view || !this.window) return;
    try {
      if (typeof this.window.setTopBrowserView === 'function') {
        this.window.setTopBrowserView(view);
        return;
      }
    } catch (_) { /* 落到下面的兼容路径 */ }
    try {
      this.window.removeBrowserView(view);
      this.window.addBrowserView(view);
    } catch (_) { /* 已销毁 */ }
  }

  /** 「人眼前还是启动页」这个判断只对**没被动过**的启动页成立（见 shouldShowNewTab）。 */
  _spendStartupPrivilege() {
    this.startupTab = null;
  }

  setActive(tabId) {
    if (!this.tabs.has(tabId)) return false;
    // 「人眼前还是启动页」这个特权是一次性的：一旦有人（人点了标签页、或 agent 显式
    // 把某一页顶到眼前）真正选过一次，之后新开的标签页就不再顶替它了 ——
    // 否则 agent 每开一页都会把上一页顶掉，等于永远在抢视野。
    if (this.startupTab !== null && tabId !== this.startupTab) this.startupTab = null;
    this.activeTab = tabId;
    // body / 记录淘汰要"先牺牲后台 tab"，所以必须让它知道谁是活跃的。
    this.networkMonitor.setActiveTab(tabId);
    const view = this._getView(tabId);
    if (view) {
      // 只调 z 序：以前是"把所有视图 remove 掉、再 add 一个"，那等于每次切标签页
      // 都让其余标签页失去合成表面（截图/自检全失效），而且 remove+add 本身会
      // 闪一帧白。
      this._attachView(view);
      this._raiseView(view);
      this._layoutView(view);
      this._focusWebContents(view);
      view.webContents.setBackgroundThrottling(false);
    }
    return true;
  }

  /**
   * 让**页面**处于活动状态，但**不**把窗口拽到前台。
   *
   * 这是实测出来的（e2e/focus_ws.cjs）：ui.new_tab / ui.set_active_tab 每次都调
   * webContents.focus()，而它会把整个窗口激活 —— agent 每开一个标签页就把人正在
   * 做的事打断一次。其它所有操作（act / get_tree / evaluate / peek / scroll /
   * canvas / network）经逐项测量都不抢焦点，只有这两个不是。
   *
   * AI_BROWSER_FOCUS=auto（默认）：不碰真实窗口焦点，改用 CDP
   *   Emulation.setFocusEmulationEnabled 让页面内的 document.hasFocus() 等状态
   *   保持正常（依赖它的懒加载 / 动画 / 富文本聚焦态不会僵住），但键盘焦点留在
   *   用户那边 —— 这正是我们要的。
   *   always：旧行为，直接把焦点交给 web contents（个别站点确需时用）。
   *   never：两者都不做。
   */
  _focusWebContents(view) {
    const policy = String(process.env.AI_BROWSER_FOCUS || 'auto').toLowerCase();
    try {
      if (!view || !view.webContents || view.webContents.isDestroyed()) return;
      if (policy === 'never') return;
      if (policy === 'always') {
        // 必须与 _focusWindow 的 always 分支做同样的事：只调 webContents.focus()
        // **不会**把窗口带到前台（实测 focus 套件的 G2 对照组里 new_tab /
        // set_active_tab 因此不抢，而 act type/click 抢 —— 同一个 always 策略
        // 两套行为）。always 的契约就是"每次操作都把窗口带到前台"，这里补齐。
        try {
          if (this.window.show) this.window.show();
          if (this.window.moveTop) this.window.moveTop();
          if (this.window.focus) this.window.focus();
        } catch (e) { /* 窗口已销毁 */ }
        view.webContents.focus();
        return;
      }
      // auto：只"伪造"页面内的焦点状态。CDP 尚未 attach（首次导航前的短暂窗口期）
      // 会 reject，静默忽略 —— 绝不因此影响标签页创建或导航。
      const p = view.webContents.debugger.sendCommand(
        'Emulation.setFocusEmulationEnabled', { enabled: true }
      );
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* debugger 未 attach / 页面已销毁 —— 忽略 */ }
  }

  /**
   * 窗口尺寸诊断 / 复现入口（ui.window_bounds）。
   *
   * 存在的理由：**布局类缺陷此前无法复现也无法回归** —— 没有入口能把窗口改成
   * 另一个尺寸，于是"窗口放大/缩小/全屏之后视图错位、内容缩成一小块"这类问题
   * 只能靠人手拖窗口碰运气。读的时候返回窗口 bounds / content bounds / 各视图
   * 实际 bounds，一眼就能看出"视图没跟上窗口"。
   *
   * 不传尺寸时纯读；传了就 setBounds + 立刻重排，再回读实际结果（不做乐观报告）。
   */
  /**
   * 窗口可见性 / 最小化（读 + 改）。`ui.window`。
   *
   * 为什么必须有（2026-10-28，用户要求"跟无头浏览器一样无感知运行"）：
   * 在这之前没有任何一条路能让 agent 自己决定窗口显示与否 —— 窗口一旦被隐藏，
   * 下一次操作触发的 _focusWindow 又把它拽回来，于是"后台运行"根本不是一个
   * 稳定状态。现在可见性成为显式状态：
   *   - 人：Dock 图标（app 'activate'）/ 手动最小化，随时能点开；
   *   - agent：ui.window {visible|minimized}，AI_BROWSER_START_HIDDEN=1 启动即隐藏。
   *
   * 三条实现约束：
   * 1. **隐藏不影响任何页面能力**。视图仍挂在这个窗口上、几何照算，读树/动作/
   *    截图/上传/下载/对话框全部照旧（`npm run background` 里 20 条断言钉住）。
   * 2. **隐藏不抢焦点**。show 默认走 showInactive()，只有调用方显式 focus:true
   *    才把窗口带到前台 —— 这是"人主动要打开它"和"agent 偷偷弹窗"的区别。
   * 3. **恢复显示后要重排**。macOS/Windows 显示瞬间 content 尺寸与隐藏时不同，
   *    不重排就会出现"视图底部溢出"（Windows 上实测 26px，见 showInitialWindow）。
   */
  /** 窗口此刻是不是"人真的能看见"。判断绘制类问题时它是前置条件（见 _schedulePaintAudit）。 */
  _windowVisible() {
    try {
      if (!this.window) return false;
      if (this.window.isMinimized && this.window.isMinimized()) return false;
      if (this.window.isVisible && !this.window.isVisible()) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  windowState() {
    const out = { ok: true };
    try {
      out.visible = !!(this.window.isVisible && this.window.isVisible());
      out.minimized = !!(this.window.isMinimized && this.window.isMinimized());
      out.focused = !!(this.window.isFocused && this.window.isFocused());
      out.bounds = this.window.getBounds();
    } catch (_) {
      return { ok: false, error: 'no-window' };
    }
    out.tabs = this.tabs.size;
    out.active_tab = this.activeTab;
    out.headless_ready = true;   // 后台能力已可用；留给调用方判断的显式承诺
    return out;
  }

  setWindowVisible(visible, opts = {}) {
    if (!this.window) return { ok: false, error: 'no-window' };
    try {
      if (visible) {
        if (this.window.isMinimized && this.window.isMinimized()) {
          try { this.window.restore(); } catch (_) { /* 已销毁 */ }
        }
        if (opts.focus === true && this.window.show) this.window.show();
        else if (typeof this.window.showInactive === 'function') this.window.showInactive();
        else if (this.window.show) this.window.show();
        this.afterShowRelayout();
        // 人刚刚把窗口点开：立刻自检一次"这一页到底画出来没有"。
        // 后台期间故意不判（见 _schedulePaintAudit），所以这里是唯一能兜住
        // "agent 在后台把页面搞白了、人一打开正好看到白屏"的时刻。
        this._schedulePaintAudit(this.activeTab, 700);
      } else {
        if (this.window.hide) this.window.hide();
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), ...this.windowState() };
    }
    return this.windowState();
  }

  async setWindowMinimized(min) {
    if (!this.window) return { ok: false, error: 'no-window' };
    try {
      if (min) {
        if (this.window.minimize) this.window.minimize();
      } else {
        if (this.window.restore) this.window.restore();
        this.afterShowRelayout();
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), ...this.windowState() };
    }
    // macOS 的 miniaturize 是带动画的：isMinimized() 在动画结束前仍返回 false，
    // 当场回读会告诉调用方"没最小化"（实测踩到）。等动画走完再报，回执才是真的。
    await new Promise((r) => setTimeout(r, 280));
    return this.windowState();
  }

  /**
   * 显示之后补几次重排。Windows 上 show() 之后原生边框才生效，content 高度会变
   * 而外框不变 → 不触发 resize → 视图按显示前的尺寸布局，底部溢出（实测 26px）。
   * 与 index.js 的 showInitialWindow 同一套理由，三次是为了覆盖边框真正应用的时刻。
   */
  afterShowRelayout() {
    const relayout = () => {
      try {
        for (const [id, v] of this.tabs) {
          if (id === this.activeTab) this._layoutView(v);
        }
        const v = this._getView(this.activeTab);
        if (v && v.webContents && !v.webContents.isDestroyed()) v.webContents.invalidate();
      } catch (_) { /* 窗口/视图已销毁 */ }
    };
    relayout();
    const t1 = setTimeout(relayout, 150);
    const t2 = setTimeout(relayout, 450);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
  }

  windowBounds(next) {
    const snapshot = () => {
      const out = { ok: true };
      try { out.bounds = this.window.getBounds(); } catch (_) { /* 窗口已销毁 */ }
      try { out.content = this.window.getContentBounds(); } catch (_) { /* 窗口已销毁 */ }
      out.repaints = { soft: this._repaintCount || 0, hard: this._hardRepaintCount || 0 };
      const views = {};
      for (const [id, view] of this.tabs) {
        try { views[id] = view.getBounds(); } catch (_) { /* 视图已销毁 */ }
      }
      out.views = views;
      return out;
    };
    if (!next || typeof next !== 'object') return snapshot();
    let cur;
    try { cur = this.window.getBounds(); } catch (e) { return { ok: false, error: 'no-window' }; }
    const nb = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
    for (const k of ['x', 'y', 'width', 'height']) {
      if (typeof next[k] === 'number' && isFinite(next[k]) && next[k] > 0) nb[k] = Math.round(next[k]);
    }
    try {
      this.window.setBounds(nb);
    } catch (e) {
      return { ok: false, error: 'setBounds failed: ' + (e && e.message), ...snapshot() };
    }
    // 尺寸变了就必须让每个视图重新栅格化：setBounds 只改几何，surface 可能还是
    // 旧尺寸的 —— 那正是"内容缩成左上角一小块、其余全白"的成因（见 SPEC 白屏一节）。
    const view = this._getView(this.activeTab);
    if (view) {
      this._layoutView(view);
      try { view.webContents.invalidate(); } catch (_) { /* 已销毁 */ }
    }
    return snapshot();
  }

  _layoutView(view) {
    const bounds = this.window.getContentBounds();
    const inset = this._bottomInset || 0;
    view.setBounds({
      x: 0,
      y: config.tabBarHeight,
      width: bounds.width,
      height: Math.max(0, bounds.height - config.tabBarHeight - inset),
    });
  }

  addSubscription(sessionId, events) {
    const existing = this.subscriptions.get(sessionId) || new Set();
    events.forEach(e => existing.add(e));
    this.subscriptions.set(sessionId, existing);
    if (events.includes('network') || events.includes('network_response')) this._startNetworkMonitor(sessionId);
    if (events.includes('js_error') || events.includes('unhandledrejection')) this._startRuntimeMonitor(sessionId);
  }

  _networkRequestMap = new Map(); // requestId -> {url, tabId, finished}

  // DEPRECATED：被 ui.network_list / ui.network_get 取代（下一主版本删除）。
  // 兼容行为：按 url_pattern 选【最近完成】的匹配项（旧实现按 Map 正向遍历，
  // 同 URL 多次请求时拿到的是最旧那条），响应仍保持旧形状 {body:string|null}。
  async getNetworkBody(urlPattern, tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const view = this._getView(tid);
    const dbg = view && view.webContents && view.webContents.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;

    const rec = this.networkMonitor.findLatestFinished(tid, urlPattern || '');
    if (rec) {
      try {
        const detail = await this.networkMonitor.get(rec.network_id, {
          include_response_body: true,
          body_limit: 5000,
        });
        const body = detail && detail.response && detail.response.body && detail.response.body.raw
          ? detail.response.body.raw.data : null;
        return body == null ? null : body;
      } catch (e) {
        // body 被淘汰/不可用：旧契约只能表达 null，但至少不谎报成空响应。
        return null;
      }
    }

    // 抓包关闭时退回旧索引路径（Network 域可能由订阅启用但未记日志）。
    for (const [requestId, entry] of this._networkRequestMap) {
      if (entry.tabId === tid && entry.finished && entry.url.indexOf(urlPattern) >= 0) {
        try {
          const result = await dbg.sendCommand('Network.getResponseBody', { requestId });
          return result.body ? result.body.slice(0, 5000) : null;
        } catch(e) { return null; }
      }
    }
    return null;
  }

  removeSubscription(sessionId, events) {
    const existing = this.subscriptions.get(sessionId);
    if (!existing) return;
    events.forEach(e => existing.delete(e));
    if (existing.size === 0) {
      this.subscriptions.delete(sessionId);
      this._stopNetworkMonitor(sessionId);
      this._stopRuntimeMonitor(sessionId);
    }
  }

  // Per-tab shared CDP debugger. A webContents can only be debugger-attached
  // once, so attach + a single message listener happen exactly once per tab; the
  // Network and Runtime domains are enabled lazily per demand, and subscribers
  // are reference-counted so the shared debugger is detached only when the last
  // network AND runtime subscriber both leave.
  _cdpTabs = new Map();            // tabId -> { wc, domains:Set<'Network'|'Runtime'> }
  _networkSubscribers = new Set(); // sessionIds currently using network events
  _runtimeSubscribers = new Set(); // sessionIds currently using js_error events

  // Attach the shared per-tab debugger if needed and enable a CDP domain.
  // ---- canvas 绘制调用记录 ----
  //
  // 必须在首个真实导航**之前**注入：canvas 是有状态的立即模式 API，页面加载时
  // 就把内容画完了，之后再注入什么都录不到。
  //
  // 两个关键点：
  // 1. Page.addScriptToEvaluateOnNewDocument **不传 worldName** 才进页面 main world。
  //    contextIsolation:true 下 preload 活在 isolated world，改自己 world 的原型
  //    截不到页面代码的调用。
  // 2. 用 Runtime.addBinding 安装上报通道（binding 名每 tab 随机，避免跨 tab 串台），
  //    回传在 CDP 的 Runtime.bindingCalled 里收取。
  async _ensureCanvasHook(tabId, view) {
    if (!isCanvasHookEnabled(process.env.AI_BROWSER_CANVAS_HOOK)) {
      this.canvasMonitor.markHook(tabId, false, ['canvas hook disabled via AI_BROWSER_CANVAS_HOOK']);
      return false;
    }
    const DEBUG = process.env.AI_BROWSER_CANVAS_DEBUG === '1';
    const log = (...a) => { if (DEBUG) console.error('[canvas-hook]', ...a); };
    try {
      this._ensureCdp(tabId, view, 'Page');
      const dbg = view && view.webContents && view.webContents.debugger;
      if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) {
        this.canvasMonitor.markHook(tabId, false, ['cdp debugger not attached']);
        return false;
      }
      const bindingName = `__aiCanvasReport_${tabId}_${Math.random().toString(36).slice(2, 8)}`;
      const source = buildCanvasHookSource({
        bindingName,
        bridgeKey: CANVAS_BRIDGE_KEY,
        mode: 'semantic',
      });

      // ⚠️ 实测结论：在**刚创建的 BrowserView** 上，await dbg.sendCommand('Runtime.enable')
      // 永远不返回（试过 20 秒、8 次重试，全部挂死），而同样"发了不等"的
      // Network.enable 却是生效的。也就是说：命令能送达，但响应在这个阶段回不来。
      // 因此这里一律 **fire-and-forget**，改用 Runtime.evaluate 去**验证**是否真的装上。
      // await 的 CDP 命令在**页面加载之后**是可用的（network 的 getResponseBody
      // 就是证据），但在刚创建的 tab 上会挂死。因此本方法只在加载完成后被调用，
      // 这里一律 await，并把每一步的失败原因打出来便于定位。
      const step = async (label, method, params, ms = 4000) => {
        let timer = null;
        const t = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(label + ' timeout ' + ms + 'ms')), ms);
        });
        try {
          return await Promise.race([dbg.sendCommand(method, params), t]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const tryStep = async (label, method, params, ms) => {
        try {
          await step(label, method, params, ms);
          log(label, 'ok');
          return true;
        } catch (e) {
          log(label, 'FAIL', (e && e.message) || e);
          return false;
        }
      };

      await tryStep('Runtime.enable', 'Runtime.enable', {}, 4000);
      await tryStep('Page.enable', 'Page.enable', {}, 4000);
      await tryStep('Runtime.addBinding', 'Runtime.addBinding', { name: bindingName }, 4000);
      // 对**后续**导航生效（这才是拿到完整绘制历史的正路）
      await tryStep('Page.addScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument', { source }, 4000);

      // 对**已经加载过**的当前页面直接注入，并抓运行时异常（脚本是否真跑起来）
      try {
        const r = await step('Runtime.evaluate', 'Runtime.evaluate',
          { expression: source, returnByValue: true, awaitPromise: false }, 6000);
        const ed = r && r.exceptionDetails;
        if (ed) log('hook 脚本运行时异常:', JSON.stringify(ed).slice(0, 800));
        else log('Runtime.evaluate(注入当前页) ok');
      } catch (e) {
        log('Runtime.evaluate FAIL', (e && e.message) || e);
      }

      this._canvasBindings.set(bindingName, tabId);

      let ok = false;
      try {
        const r = await step('probe', 'Runtime.evaluate', {
          expression: `typeof window[${JSON.stringify(CANVAS_BRIDGE_KEY)}]`,
          returnByValue: true,
        }, 4000);
        const v = r && r.result && r.result.value;
        log('probe typeof bridge =', v);
        ok = v === 'object';
      } catch (e) {
        log('probe FAIL', (e && e.message) || e);
      }
      this.canvasMonitor.markHook(
        tabId,
        ok,
        ok ? [] : ['hook 命令已执行但页面内未生效（见 AI_BROWSER_CANVAS_DEBUG=1 日志）']
      );
      return ok;
    } catch (e) {
      this.canvasMonitor.markHook(tabId, false, [`canvas hook install failed: ${(e && e.message) || e}`]);
      return false;
    }
  }

  /**
   * 窗口焦点策略 —— 这是个真实的可用性问题：agent 每次点击/输入都把窗口
   * 拽到最前，等于人完全没法用电脑。
   *
   * AI_BROWSER_FOCUS:
   *   auto   (默认) **完全不碰窗口状态**：不 show、不 moveTop、不 focus。
   *                  CDP 受信输入（Input.dispatchKeyEvent / dispatchMouseEvent）在窗口
   *                  非前台、最小化、甚至隐藏时依然生效（加上已有的
   *                  disable-backgrounding-occluded-windows / disable-renderer-backgrounding /
   *                  disable-background-timer-throttling，后台窗口不会被降频或丢事件）。
   *                  这是"无头式运行"的前提：窗口隐藏必须是**稳定状态**，而不是
   *                  "下一次操作就弹回来"。
   *   always        旧行为：每次都 show + moveTop + focus（需要抢焦点时用）。
   *   never         与 auto 相同（保留这个名字是为了兼容老配置）。
   *
   * ⚠️ 2026-10-28 之前 auto 会"窗口被最小化/隐藏就 restore + showInactive"，
   * 依据是当时的产品不变量"窗口必须真实可见"。多 agent 并用之后这条不变量反过来
   * 咬人：agent 每操作一次，隐藏的窗口就自己爬出来一次 —— 人在用电脑，窗口在
   * 后台不停弹。现在改成：**窗口可见性只由人（Dock/activate）和显式 ui.window 决定**。
   */
  _focusWindow(view) {
    const policy = String(process.env.AI_BROWSER_FOCUS || 'auto').toLowerCase();
    if (policy !== 'always') return;
    try {
      if (this.window.show) this.window.show();
      if (this.window.moveTop) this.window.moveTop();
      if (this.window.focus) this.window.focus();
      if (view && view.webContents && view.webContents.focus) view.webContents.focus();
    } catch (e) { /* 窗口已销毁等情况，忽略 */ }
  }

  _canvasTab(tabId) {
    return tabId !== undefined ? tabId : this.activeTab;
  }

  canvasList(tabId) {
    return this.canvasMonitor.list(this._canvasTab(tabId));
  }

  canvasRead(tabId, opts = {}) {
    return this.canvasMonitor.read(this._canvasTab(tabId), opts || {});
  }

  async canvasConfigure(tabId, opts = {}) {
    const tid = this._canvasTab(tabId);
    const mode = this.canvasMonitor.setMode(tid, opts.mode);
    if (opts.clear) this.canvasMonitor.clear(tid);
    const view = this._getView(tid);
    if (view) {
      await this._ensureCanvasHook(tid, view);
      // 只有调用方显式要求才重载：hook 对"安装之前已经画完"的内容无能为力，
      // 重载是唯一能拿到完整绘制历史的办法 —— 但它会丢掉用户当前状态，
      // 所以绝不默认做。
      if (opts.reload === true) {
        try { view.webContents.reload(); } catch (e) {}
      }
    }
    const st = this.canvasMonitor.list(tid);
    return {
      mode,
      hook_installed: st.hook_installed,
      // hook 只对安装之后的绘制生效；安装前已经画完的内容拿不回来。
      effective: 'immediate_future_calls',
      past_content_recovered: false,
      reload_required_for_complete_history: !st.hook_installed,
      retention: st.retention,
      warnings: st.warnings,
    };
  }

  // 截图兜底：只在语义层读不懂（WebGL/纯像素）时由调用方显式触发。
  // 默认关闭语义由调用方控制；这里只提供能力并明确警告它会消耗视觉 token。
  async canvasCapture(tabId, canvasId) {
    const tid = this._canvasTab(tabId);
    const view = this._getView(tid);
    if (!view) return null;
    const dbg = view.webContents && view.webContents.debugger;
    if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;
    const rect = await this.evaluate(
      `(function(id){var els=document.querySelectorAll('canvas');` +
      `for(var i=0;i<els.length;i++){var e=els[i];` +
      `if(e.__aiCanvasId===id||e.id===id){var r=e.getBoundingClientRect();` +
      `return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};}}` +
      `return null;})(${JSON.stringify(String(canvasId || ''))})`,
      tid
    );
    if (!rect || !rect.width || !rect.height) return null;
    try {
      const res = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      return {
        mime_type: 'image/png',
        data_base64: (res && res.data) || null,
        width: rect.width,
        height: rect.height,
        warning: 'visual fallback; consumes caller visual tokens',
      };
    } catch (e) {
      return null;
    }
  }

  // === 浏览器级对话框（alert / confirm / prompt / beforeunload）===
  //
  // 这类对话框由 Chromium 交给 embedder 渲染，Electron 画成原生 sheet：不在
  // DOM、不在 AX 树、点不到；**而且打开期间渲染器被阻塞**（Runtime.evaluate
  // 都不返回）。所以它必须由主进程应答 —— 页面侧的任何办法（JS 覆盖
  // window.confirm、语义树里找按钮）都治不了"渲染器已经停住"这件事。
  //
  // 应答走 CDP `Page.handleJavaScriptDialog`：该命令由浏览器进程处理，不需要
  // 渲染器，所以对话框阻塞页面时它照样生效。
  _ensureDialogWatch(tabId, view) {
    if (this._dialogWatched.has(tabId)) return;
    this._dialogWatched.add(tabId);
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) { this._dialogWatched.delete(tabId); return; }
    try {
      // 只有 Page 域启用后才会收到 javascriptDialogOpening。空文档上这条命令
      // 可能挂住，所以不 await（挂住也无害：只是这个 tab 收不到事件，动作超时
      // 时还有 recoverBlockedTab 的兜底探测）。
      wc.debugger.sendCommand('Page.enable').catch(() => {});
    } catch (_e) {
      this._dialogWatched.delete(tabId);
    }
  }

  /** 当前策略（实例字段优先，便于测试/诊断；否则读环境变量）。 */
  _dialogPolicyNow() {
    return this.dialogPolicy || dialogPolicy.policyFromEnv();
  }

  async _handleDialogOpening(tabId, params) {
    const dialog = {
      type: String((params && params.type) || 'alert'),
      message: String((params && params.message) || ''),
      defaultPrompt: params && params.defaultPrompt,
      at: Date.now(),
    };
    const decision = dialogPolicy.decideDialog(dialog, { policy: this._dialogPolicyNow() });
    if (!decision.auto) {
      // manual：不替调用方决定，把状态挂出去（listTabs 可见），由人来点。
      this._openDialogs.set(tabId, { type: dialog.type, message: dialog.message });
      return;
    }
    const handled = await this._answerDialog(tabId, decision.accept, decision.promptText);
    this._openDialogs.delete(tabId);
    if (!handled) return;
    this._lastDialog.set(tabId, {
      type: dialog.type,
      message: dialog.message,
      accept: !!decision.accept,
      ...(decision.accept && decision.promptText ? { prompt_text: decision.promptText } : {}),
      auto: true,
      at: dialog.at,
    });
  }

  async _answerDialog(tabId, accept, promptText) {
    const view = this._getView(tabId);
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return false;
    try {
      const params = { accept: !!accept };
      if (accept && typeof promptText === 'string' && promptText) params.promptText = promptText;
      await withDeadline(
        wc.debugger.sendCommand('Page.handleJavaScriptDialog', params),
        2000,
        'dialog_handle'
      );
      return true;
    } catch (_e) {
      return false;   // "No dialog is showing" / debugger 未 attach：都不是错误
    }
  }

  /**
   * 兜底：动作超时时**探测**是否有对话框把渲染器冻结了，并按策略应答。
   *
   * 为什么需要它：事件监听依赖 Page 域已启用。若某个 tab 从未启用（或启用被
   * 1500ms deadline 掐掉），我们就收不到 javascriptDialogOpening，但仍然必须
   * 有能力把它解开 —— 否则那条 tab 会永久卡死，只能重启浏览器。
   * CDP 对"没有对话框"会返回 "No dialog is showing"，正好当探测用。
   *
   * @returns {null|{type,message,accept,auto,recovered:true}} 解开了就返回信息
   */
  async recoverBlockedTab(tabId) {
    const tid = tabId !== undefined ? tabId : this.activeTab;
    const decision = dialogPolicy.decideDialog({ type: 'confirm' }, { policy: this._dialogPolicyNow() });
    if (!decision.auto) return null;          // manual 策略：不擅自替人点
    const view = this._getView(tid);
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return null;
    try {
      await withDeadline(
        wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: decision.accept }),
        2000,
        'dialog_probe'
      );
    } catch (_e) {
      return null;                            // 没有对话框（或 CDP 不可用）
    }
    const known = this._openDialogs.get(tid) || {};
    this._openDialogs.delete(tid);
    const info = {
      type: known.type || 'unknown',
      message: known.message || '',
      accept: !!decision.accept,
      auto: true,
      recovered: true,
      at: Date.now(),
    };
    this._lastDialog.set(tid, info);
    return info;
  }

  /** 取"这次动作期间"处理过的对话框（回执用）。 */
  _dialogSince(tabId, since) {
    const d = this._lastDialog.get(tabId);
    if (!d || d.at < since) return null;
    const { at, ...rest } = d;
    return rest;
  }

  _ensureCdp(tabId, view, domain) {
    try {
      const wc = view.webContents;
      if (!this._cdpTabs.has(tabId)) {
        wc.debugger.attach('1.3');
        const entry = { wc, domains: new Set() };
        this._cdpTabs.set(tabId, entry);
        // Single shared listener per tab -> no duplicate broadcasts even when
        // many sessions subscribe to network/runtime events on the same tab.
        wc.debugger.on('message', (_event, method, params) => this._onCdpMessage(tabId, method, params));
        // 任何 tab 一旦挂上 CDP，就顺手盯住对话框：漏掉一个 alert 会让整条 tab
        // 永久卡死（渲染器被阻塞，后续每条命令都超时）。
        this._ensureDialogWatch(tabId, view);
      }
      const entry = this._cdpTabs.get(tabId);
      if (!entry.domains.has(domain)) {
        wc.debugger.sendCommand(domain + '.enable');
        entry.domains.add(domain);
      }
    } catch (e) { /* mid-navigation / already-attached elsewhere; skip this tab */ }
  }

  // window.open 垫片注入（见 window_open_shim_source.js 顶部注释）。
  // contextIsolation 下 preload 改不了页面可见的 window.open，只能经
  // Page.addScriptToEvaluateOnNewDocument 注入主 world。
  //
  // ⚠️ 必须在 renderer 就绪后调用：未导航的空 webContents 上 CDP 命令无人
  // 处理会挂住（实测 Page.enable 1.5s 不 resolve）。newTab 的做法是先
  // load about:blank，did-finish-load 后再调这里。
  // 幂等：每个 tab 只注册一次（_windowOpenShimTabs 记账）；跨导航自动保留
  // 正是 addScriptToEvaluateOnNewDocument 的语义，不需要重复注册。
  // 新 tab 的占位页 URL：有目标地址时用 loading.html（把白屏变成可诊断的
  // "正在打开 <url>"），无目标地址时保持 about:blank（window.open("") 的
  // 占位 tab 要停在这里等站点赋 location，不能显示成"正在打开"）。
  _loadingPlaceholderUrl(targetUrl) {
    // 用 pathToFileURL 而不是 'file://' + path：打包后的路径含空格
    // （/Applications/AI Browser.app/...），手拼出来的 URL 与 Chromium 报回来的
    // 一个是字面空格、一个是 %20，任何"字符串相等"的判据都会失效。详见
    // shared/placeholder.cjs 顶部（v2.3.0 的事故）。
    return placeholder.placeholderUrlFor(path.join(__dirname, '../renderer/loading.html'), targetUrl);
  }

  _ensureWindowOpenShim(tabId, view) {
    if (this._windowOpenShimTabs.has(tabId)) return Promise.resolve(true);
    this._windowOpenShimTabs.add(tabId);
    // async IIFE：注入要 await（Page.enable → addScript 有序），但函数本身
    // 仍返回 Promise（调用方 .finally 等它）。
    return (async () => {
      try {
        const wc = view.webContents;
        if (!wc || typeof wc.debugger?.attach !== 'function') return false;
        if (!this._cdpTabs.has(tabId)) {
          wc.debugger.attach('1.3');
          const entry = { wc, domains: new Set() };
          this._cdpTabs.set(tabId, entry);
          wc.debugger.on('message', (_event, method, params) => this._onCdpMessage(tabId, method, params));
        }
        // ⚠️ 必须先 Page.enable：Page 域 agent 未启用时，
        // addScriptToEvaluateOnNewDocument 发出去会**挂住不回**（实测 1.5s
        // 超时也不 resolve，首屏页面因此永远拿不到垫片）。enable 后再注入。
        await withDeadline(
          wc.debugger.sendCommand('Page.enable'),
          1500,
          'window_open_page_enable'
        );
        await withDeadline(
          wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: WINDOW_OPEN_SHIM_SOURCE,
            runForSubFrames: true,
          }),
          1500,
          'window_open_shim_inject'
        );
        return true;
      } catch (e) {
        // 失败时撤掉记账：留着就等于给这个 tab 判了"永久无垫片"。
        // 撤掉后下一次 window.open 还有机会补上（CDP 偶发挂住是环境问题，
        // 不是这个 tab 的固有属性）。
        this._windowOpenShimTabs.delete(tabId);
        console.error('[window_open] shim inject failed:', tabId, e && e.message);
        return false;
      }
    })();
  }

  // 抓包用的 Network 域：默认在 tab 创建后、首个导航前启用。
  // Network.enable 必须显式带 maxPostDataSize，否则 Chromium 可能不内联
  // request.postData（POST 请求体就拿不到，只能靠 getRequestPostData 补）。
  // 实验参数（durable messages / buffer size）在部分 Chromium 上不支持，
  // 逐个降级，最后一档是裸 Network.enable。
  _ensureNetworkCapture(tabId, view) {
    const cfg = this.networkMonitor.tabConfig(tabId);
    if (!cfg.enabled) return;
    try {
      const wc = view.webContents;
      if (!this._cdpTabs.has(tabId)) {
        wc.debugger.attach('1.3');
        const entry = { wc, domains: new Set() };
        this._cdpTabs.set(tabId, entry);
        wc.debugger.on('message', (_event, method, params) => this._onCdpMessage(tabId, method, params));
      }
      const entry = this._cdpTabs.get(tabId);
      if (entry.domains.has('Network')) return;
      const attempts = [
        {
          maxPostDataSize: MAX_POST_DATA_SIZE,
          maxTotalBufferSize: 32 * 1024 * 1024,
          maxResourceBufferSize: 8 * 1024 * 1024,
          enableDurableMessages: true,
        },
        { maxPostDataSize: MAX_POST_DATA_SIZE },
        {},
      ];
      this.networkMonitor.setBodyFetcher(tabId, async (requestId, kind) => {
        if (!wc.debugger || typeof wc.debugger.isAttached !== 'function' || !wc.debugger.isAttached()) return null;
        if (kind === 'request') {
          const r = await wc.debugger.sendCommand('Network.getRequestPostData', { requestId });
          if (!r || r.postData == null) return null;
          // multipart 的文件字节 CDP 不保证给出 —— 如实标 incomplete。
          return { data: r.postData, complete: true };
        }
        const r = await wc.debugger.sendCommand('Network.getResponseBody', { requestId });
        if (!r) return null;
        return { data: r.body || '', base64Encoded: !!r.base64Encoded, complete: true };
      });
      const tryEnable = (i) => {
        if (i >= attempts.length) return;
        Promise.resolve(wc.debugger.sendCommand('Network.enable', attempts[i]))
          .then(() => { entry.domains.add('Network'); })
          .catch(() => tryEnable(i + 1));
      };
      tryEnable(0);
    } catch (e) { /* mid-navigation / already attached; skip */ }
  }

  _teardownCdpIfIdle() {
    // 抓包默认开启时 debugger 是常驻资源，不能因为最后一个订阅者离开就 detach，
    // 否则后续 ui.network_list 拿不到任何东西。
    if (NETWORK_CAPTURE_DEFAULT) return;
    if (this._networkSubscribers.size > 0 || this._runtimeSubscribers.size > 0) return;
    for (const entry of this._cdpTabs.values()) {
      try { entry.wc.debugger.detach(); } catch(e) {}
    }
    this._cdpTabs.clear();
  }

  async _startNetworkMonitor(sessionId) {
    if (this._networkSubscribers.has(sessionId)) return;
    this._networkSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureNetworkCapture(tabId, view);
  }

  async _startRuntimeMonitor(sessionId) {
    if (this._runtimeSubscribers.has(sessionId)) return;
    this._runtimeSubscribers.add(sessionId);
    for (const [tabId, view] of this.tabs) this._ensureCdp(tabId, view, 'Runtime');
  }

  _onCdpMessage(tabId, method, params) {
    // 浏览器级对话框：**必须在最前面处理**，且不能受任何订阅条件限制 ——
    // 它决定这条 tab 会不会被永久冻结（见 _ensureDialogWatch 注释）。
    if (method === 'Page.javascriptDialogOpening') {
      this._handleDialogOpening(tabId, params).catch(() => {});
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      this._openDialogs.delete(tabId);
      return;
    }
    // 抓包：请求侧（method / headers / POST body / initiator）与响应侧都落进
    // network_monitor；旧的网络事件推送行为保持不变。
    if (typeof method === 'string' && method.indexOf('Network.') === 0) {
      this._onNetworkCdpMessage(tabId, method, params);
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      // canvas hook 的上报通道。binding 名每 tab 随机，据此把载荷归到正确的 tab。
      const owner = this._canvasBindings.get(params && params.name);
      if (owner !== undefined && params && typeof params.payload === 'string') {
        try {
          this.canvasMonitor.ingest(owner, JSON.parse(params.payload));
        } catch (e) { /* 坏载荷不该影响页面，也不该冒到上层 */ }
      }
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      // CDP captures page main-world exceptions that preload window.onerror
      // (an isolated world) can never see under contextIsolation.
      const d = params.exceptionDetails || {};
      const ex = d.exception || {};
      this._broadcast('js_error', {
        text: d.text || '',
        message: (ex.description || ex.value) || d.text || '',
        url: d.url || '',
        lineNumber: d.lineNumber,
        columnNumber: d.columnNumber,
        tabId,
      });
    }
  }

  _onNetworkCdpMessage(tabId, method, params) {
    const m = this.networkMonitor;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const rec = m.onRequestWillBeSent(tabId, params);
        // 旧 getNetworkBody 的索引（结构保持 {url, tabId, finished}）。
        this._networkRequestMap.set(params.requestId, {
          url: rec ? rec.url : (params.request && params.request.url) || '',
          tabId,
          finished: false,
        });
        return;
      }
      case 'Network.requestWillBeSentExtraInfo':
        m.onRequestWillBeSentExtraInfo(tabId, params);
        return;
      case 'Network.responseReceivedExtraInfo':
        m.onResponseReceivedExtraInfo(tabId, params);
        return;
      case 'Network.dataReceived':
        m.onDataReceived(tabId, params);
        return;
      case 'Network.responseReceived': {
        m.onResponseReceived(tabId, params);
        const r = params.response || {};
        const entry = this._networkRequestMap.get(params.requestId);
        if (entry) entry.url = r.url;
        else this._networkRequestMap.set(params.requestId, { url: r.url, tabId, finished: false });
        this._broadcast('network_response', { url: r.url, status: r.status, statusText: r.statusText, mimeType: r.mimeType, tabId });
        return;
      }
      case 'Network.loadingFinished': {
        m.onLoadingFinished(tabId, params);
        const entry = this._networkRequestMap.get(params.requestId);
        if (entry) entry.finished = true;
        return;
      }
      case 'Network.loadingFailed': {
        m.onLoadingFailed(tabId, params);
        const requestId = params.requestId || '';
        const entry = this._networkRequestMap.get(requestId);
        const url = entry ? entry.url : requestId;
        this._broadcast('network_response', { url, status: 0, statusText: 'Failed', errorText: params.errorText || '', tabId });
        return;
      }
      default:
        return;
    }
  }

  // ==== 网络抓包查询（ui.network_list / get / clear / configure）====

  networkList(filter = {}) {
    return this.networkMonitor.list(filter);
  }

  async networkGet(networkId, opts = {}) {
    return await this.networkMonitor.get(networkId, opts);
  }

  networkClear(tabId) {
    const cleared = this.networkMonitor.clear(tabId);
    // 只清内存日志。浏览器 cache / cookie / storage 一概不动 —— 命名与响应都
    // 要避免被调用方误以为清了会话。
    return {
      ok: true,
      ...cleared,
      cleared_browser_cache: false,
      cleared_cookies: false,
      cleared_storage: false,
      scope: 'in_memory_request_log_only',
      warning: 'only the in-memory request log was cleared; browser cache, cookies and storage are untouched',
    };
  }

  networkConfigure(tabId, opts = {}) {
    // 上限只能由受控 env/config 改，调用方不能通过 WS 设成无限。
    const cfg = this.networkMonitor.configure(tabId, opts);
    if (cfg.enabled) {
      const view = this._getView(tabId);
      if (view) this._ensureNetworkCapture(tabId, view);
    }
    return {
      enabled: cfg.enabled,
      capture_bodies: cfg.capture_bodies,
      effective: cfg.enabled ? 'future_requests' : 'disabled',
      reload_required_for_initial_navigation: true,
      capabilities: {
        request_headers: true,
        request_body: true,
        durable_response_bodies: false,
        sensitive_headers_optin: this.networkMonitor.sensitiveAllowed,
      },
      limits: this.networkMonitor.captureInfo(tabId).limits,
      // 诊断用：淘汰优先级与当前占用。回答"我的 body 为什么是 evicted"。
      active_tab: this.networkMonitor.captureInfo(tabId).active_tab,
      body_bytes: this.networkMonitor.captureInfo(tabId).body_bytes,
      max_body_bytes: this.networkMonitor.captureInfo(tabId).max_body_bytes,
      note: 'retention limits are controlled by AI_BROWSER_NETWORK_* env only, never by this call',
    };
  }

  async _stopNetworkMonitor(sessionId) {
    if (!this._networkSubscribers.has(sessionId)) return;
    this._networkSubscribers.delete(sessionId);
    this._teardownCdpIfIdle();
  }

  async _stopRuntimeMonitor(sessionId) {
    if (!this._runtimeSubscribers.has(sessionId)) return;
    this._runtimeSubscribers.delete(sessionId);
    this._teardownCdpIfIdle();
  }

  close() {
    // Detach every shared per-tab CDP debugger once, then drop all state.
    for (const entry of this._cdpTabs.values()) {
      try { entry.wc.debugger.detach(); } catch(e) {}
    }
    this._cdpTabs.clear();
    this._networkSubscribers.clear();
    this._runtimeSubscribers.clear();
    this.networkMonitor.clear();
    // Reject any in-flight requests so callers don't hang on close.
    for (const [id, pending] of this._pendingRequests) {
      try { pending.reject(new Error('PageManager closing')); } catch (e) {}
    }
    this._pendingRequests.clear();
    // Same reasoning as closeTab: baselines and queued repaints belong to tabs
    // that are about to stop existing.
    this._snapshots.clear();
    this.downloadMonitor.clearAll();
    if (this.mediaInline) this.mediaInline.clearAll();
    for (const t of this._repaintTimers.values()) clearTimeout(t);
    this._repaintTimers.clear();
    for (const [id, view] of this.tabs) {
      if (view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    this.tabs.clear();
    ipcMain.removeAllListeners('ai:tree');
    ipcMain.removeAllListeners('ai:action_result');
    ipcMain.removeAllListeners('ai:evaluate_result');
    ipcMain.removeAllListeners('ai:diff');
    ipcMain.removeAllListeners('ai:event');
  }
}

export { PageManager };
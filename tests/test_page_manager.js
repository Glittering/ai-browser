// test_page_manager.js — 真的 `new PageManager()` 跑起来的行为判据。
//
// # 为什么必须补这一份（2026-11-01，审计 C12）
//
// `tests/` 里此前**从来没有构造过真的 PageManager** —— `test_ws_handlers` /
// `test_act_params` / `test_cli_call` 里的 `makePageManager()` 都是手写的对象
// 字面量，它们测的是 ws_server 怎么调它，而不是它自己怎么干活。后果是
// `page_manager.js` 这 5800 行里任何一处写错（条件写反、per-tab 状态漏清、
// 归属判错）都只能靠 27 个要起真 Electron 的 e2e 去发现，而 e2e 在 CI 里根本
// 不跑。
//
// # 做法
//
// 用 `vi.mock('electron')` 提供 BrowserView / ipcMain / nativeImage / webContents
// 的最小可用实现，真构造、真调方法、真收 IPC。判据只看**可观察结果**：
// 状态表里还剩什么、pending 有没有被认领、Promise 有没有按预期 reject。
//
// 不追求覆盖所有方法（那等于重写 Electron），只钉住历史上真出过事的三类：
//   1. 关 tab 的 per-tab 清理（泄漏过两轮，见 shared/tab_state.cjs）
//   2. IPC 回执的归属（2026-10-31 的页面伪造树，见 shared/ipc_guard.cjs）
//   3. 悬空 webContents 与超时兜底（2026-10-30 白屏事故）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
// ⚠️ 顺序有意义：'electron' 的 mock 工厂在第一次有人 import electron 时执行，
// 而 page_manager 顶层就 import 了 electron。electronMock 放前面，工厂才会在
// 我们这个模块的绑定就绪之后跑。
import * as electronMock from 'electron';
import { PageManager } from '../src/main/page_manager.js';
import { config } from '../src/shared/config.js';
import tabState from '../src/shared/tab_state.cjs';

// 工厂必须是 **async**：非 async 的工厂会被 hoist 到 import 之前执行，那时
// `node:events` 还没初始化，工厂里的 `class X extends EventEmitter` 会撞 TDZ
// （现象是一句毫无线索的 "Cannot access '__vi_import_0__' before initialization"）。
vi.mock('electron', async () => {
  const { EventEmitter: EE } = await import('node:events');

  const ipcMain = new EE();
  ipcMain.handle = (channel, fn) => { ipcMain.on('handle:' + channel, fn); };
  ipcMain.removeHandler = () => {};

  let seq = 0;
  class FakeWebContents extends EE {
    constructor() {
      super();
      this.id = ++seq;
      this.sent = [];          // [channel, payload]
      this.url = 'about:blank';
      this.title = '';
      this.destroyed = false;
      this.userAgent = '';
      this.zoom = 1;
      this.debugger = {
        attached: false,
        on: () => {},
        attach: () => { this.debugger.attached = true; },
        detach: () => { this.debugger.attached = false; },
        isAttached: () => this.debugger.attached,
        sendCommand: async () => ({}),
      };
    }
    send(channel, payload) { this.sent.push([channel, payload]); }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    getTitle() { return this.title || ''; }
    getUserAgent() { return this.userAgent; }
    setUserAgent(ua) { this.userAgent = ua; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    // 存下 handler，测试才能真的调用它 —— window.open 的两条入口之一
    // （setWindowOpenHandler）的几何判据只能这么测（PM-33）。
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
    setAudioMuted(m) { this.audioMuted = m; }
    isMuted() { return this.audioMuted === true; }
    setZoomFactor(z) { this.zoom = z; }
    getZoomFactor() { return this.zoom; }
    insertCSS() { return Promise.resolve('k'); }
    removeInsertedCSS() { return Promise.resolve(); }
    executeJavaScript() { return Promise.resolve(undefined); }
    focus() {}
    close() { this.destroyed = true; this.emit('destroyed'); }
    inspectElement() {}
    // 一批 PageManager 会碰到的 no-op（列出来是为了**显式**：漏哪个会立刻炸，
    // 而不是被 Proxy 兜住后悄悄走到错的分支）。
    setBackgroundThrottling() {}
    setVisualZoomLevelLimits() { return Promise.resolve(); }
    setZoomLevel() {}
    getZoomLevel() { return 0; }
    sendInputEvent() {}
    isCurrentlyAudible() { return false; }
    getOSProcessId() { return 4242; }
    downloadURL() { return Promise.resolve(); }
    addWordToSpellCheckerDictionary() {}
    capturePage() { return Promise.resolve({ isEmpty: () => false, toPNG: () => Buffer.from('') }); }
    // 重绘计数的落点。热路径到底有没有挂重绘，只有这里能看出来 ——
    // _forceRepaint 的返回值不区分"没挂"和"挂了但合成器没理"。
    invalidate() { this.invalidations = (this.invalidations || 0) + 1; }
    get session() { return { setPermissionRequestHandler: () => {}, cookies: {} }; }
  }

  class FakeBrowserView {
    constructor(opts) {
      this.opts = opts || {};
      this.webContents = new FakeWebContents();
      this.bounds = null;
    }
    setBounds(b) { this.bounds = b; }
    getBounds() { return this.bounds; }
    setBackgroundColor(c) { this.bgColor = c; }
    setAutoResize() {}
    destroy() { this.webContents.close(); }
  }

  const app = new EE();
  app.getPath = () => '/tmp';
  app.isReady = () => true;

  return {
    ipcMain,
    BrowserView: FakeBrowserView,
    app,
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => Buffer.from(''), getSize: () => ({ width: 1, height: 1 }) }),
      createFromPath: () => ({ isEmpty: () => true }),
    },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => {},
        cookies: { get: async () => [], set: async () => {}, flushStore: async () => {} },
      }),
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  };
});

// PageManager 只用窗口的 getContentBounds / contentView / on / emit /
// isVisible / isMinimized（后两个是取帧档位的分水岭）。
function freshWindow() {
  const win = new EventEmitter();
  win.getContentBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 });
  win.contentView = { addChildView: () => {}, removeChildView: () => {} };
  win.setBrowserView = () => {};
  win.removeBrowserView = () => {};
  win.isDestroyed = () => false;
  win.isFocused = () => true;
  // 取帧档位的分水岭要用（见 _isCoveredByOtherTab）：真实窗口默认可见。
  // 写成可覆盖的普通属性，PM-28 要逐格改它、最后 delete 掉模拟"问不到"。
  win.isVisible = () => true;
  win.isMinimized = () => false;
  win.focus = () => {};
  return win;
}

let pm;

beforeEach(() => {
  // IPC 监听挂在模块级 ipcMain 上：不清会把上一个用例的实例留在 EventEmitter
  // 里（这本身就是"清理必须靠登记表"的一个来源场景）。
  electronMock.ipcMain.removeAllListeners();
  pm = new PageManager(freshWindow());
});

afterEach(() => {
  electronMock.ipcMain.removeAllListeners();
});

describe('PageManager 真的能构造起来（闸门）', () => {
  it('PM-1 构造后状态表为空', () => {
    expect(pm.tabs.size).toBe(0);
    expect(pm.activeTab).toBe(null);
  });

  it('PM-2 newTab 登记视图、设 activeTab、preload 指向真实文件', () => {
    const tid = pm.newTab('https://example.com/');
    expect(tid, 'newTab 的返回值是 tabId（既有契约）').toBe(1);
    const view = pm.tabs.get(tid);
    expect(pm.tabs.size).toBe(1);
    expect(pm.activeTab).toBe(1);
    // preload 路径写错（比如 .js）不会报错，只会静默不注入，然后所有读树超时。
    expect(String(pm._preloadPath)).toMatch(/preload[\\/]bridge\.cjs$/);
    expect(view.opts.webPreferences.contextIsolation).toBe(true);
    expect(view.opts.webPreferences.nodeIntegration).toBe(false);
  });
});

describe('关 tab 的 per-tab 清理（Bug 5 / tab_state.cjs 的真实行为）', () => {
  it('PM-3 closeTab 之后，所有 Map/Set 容器里都不再有这个 tabId', () => {
    const tid = pm.newTab('https://a.example/');

    // 只核对**登记表**里的容器：`subscriptions` / `_wsClients` / `_groups` 是
    // 会话/分组级的，本来就不该跟着 tab 走（我第一版把"所有 Map/Set"都当成
    // per-tab，直接红了 11 条 —— 那是判据写宽了，不是代码有问题）。
    const PER_TAB = tabState.PER_TAB;
    for (const row of PER_TAB) {
      const c = pm[row.field];
      if (!c) continue;
      if (row.byValue) c.set('binding-' + tid, tid);
      else if (c instanceof Set) c.add(tid);
      else if (c instanceof Map) c.set(tid, row.timers ? setTimeout(() => {}, 100) : { marker: row.field });
    }
    expect(PER_TAB.length, '登记表不该是空的（否则这条用例空转）').toBeGreaterThan(10);

    pm.closeTab(tid);

    const leftovers = [];
    for (const row of PER_TAB) {
      const c = pm[row.field];
      if (!c) continue;
      if (row.byValue) {
        if (typeof c.entries === 'function') {
          for (const [, v] of c.entries()) if (v === tid) leftovers.push(row.field);
        }
      } else if (typeof c.has === 'function' && c.has(tid)) {
        leftovers.push(row.field);
      }
    }
    expect(leftovers, '这些登记在册的 per-tab 容器在关 tab 后还留着条目：' + leftovers.join(', ')).toEqual([]);
  });

  it('PM-4 tabId 会被复用 → 新 tab 不许继承上一任的自救状态', () => {
    const tid = pm.newTab('https://a.example/');
    pm._paintState.set(tid, 'already-healed');   // 模拟"上一任已经自救过两步"
    pm.closeTab(tid);
    expect(pm._paintState.has(tid)).toBe(false);
  });
});

describe('IPC 回执的归属（页面伪造树那条路）', () => {
  it('PM-5 同 tab 的回执被认领', async () => {
    const tid = pm.newTab('https://a.example/');
    const view = pm.tabs.get(tid);
    const p = pm.getTree(false, tid);
    const entry = view.webContents.sent.find(([ch]) => ch === 'ai:extract');
    expect(entry, 'getTree 必须先发出 ai:extract 才能谈回执').toBeTruthy();
    electronMock.ipcMain.emit('ai:tree', { sender: view.webContents }, { id: entry[1].id, tree: { role: 'Root' }, context: {} });
    await expect(p).resolves.toBeTruthy();
  });

  it('PM-6 别的 tab 撞号回执必须被丢弃（不 resolve）', async () => {
    const tidA = pm.newTab('https://a.example/');
    const a = pm.tabs.get(tidA);
    const p = pm.getTree(false, tidA);
    const payload = a.webContents.sent.find(([ch]) => ch === 'ai:extract')[1];

    // 任何不是本应用标签页的 webContents 发一条 id 相同的回执
    const stranger = new electronMock.BrowserView().webContents;
    electronMock.ipcMain.emit('ai:tree', { sender: stranger }, { id: payload.id, tree: { role: 'Fake' }, context: {} });

    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled, '伪造回执把 pending 认领了 —— 页面就能喂假树').toBe(false);

    // 正确的那条仍然有效（证明"拒绝"没有把通道弄死）
    electronMock.ipcMain.emit('ai:tree', { sender: a.webContents }, { id: payload.id, tree: { role: 'Root' }, context: {} });
    await expect(p).resolves.toBeTruthy();
  });

  it('PM-7 渲染器崩溃（webContents 被换掉）后，pending 靠超时释放而不是永久挂着', async () => {
    const tid = pm.newTab('https://a.example/');
    const view = pm.tabs.get(tid);
    const p = pm.getTree(false, tid);
    // 崩溃 + reload：对象身份变了，`_tabIdForContents` 再也认不出旧 sender
    view.webContents = new electronMock.BrowserView().webContents;
    const t0 = Date.now();
    await expect(p).rejects.toThrow(/timeout/i);
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 15000);
});

describe('文档导航的 UA-CH 出口补头（_installClientHintBridge）', () => {
  // 假 session：只记录挂上去的 filter 与 listener，然后由用例亲手调那个 listener。
  // 判据是"发出去的请求头长什么样"，不是"源码里有没有这行"。
  function stubSession() {
    const rec = { calls: [] };
    return {
      webRequest: {
        onBeforeSendHeaders: (filter, listener) => { rec.filter = filter; rec.listener = listener; },
      },
      rec,
    };
  }

  function run(listener, requestHeaders) {
    let out = null;
    listener({ requestHeaders }, (r) => { out = r; });
    return out && out.requestHeaders;
  }

  it('PM-8 只挂加密连接（明文上补 critical hints 反而是不一致）', () => {
    const ses = stubSession();
    expect(pm._installClientHintBridge(ses), '装不上就等于没补头').toBe(true);
    expect(ses.rec.filter.urls.sort()).toEqual(['https://*/*', 'wss://*/*']);
    expect(pm._clientHintBridge).toBe(true);
  });

  it('PM-9 缺失才补：内核已经给了 sec-ch-ua 的请求一个字都不许改', () => {
    const ses = stubSession();
    pm._installClientHintBridge(ses);
    const already = { 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' };
    const got = run(ses.rec.listener, { ...already, accept: 'text/html' });
    expect(got['sec-ch-ua']).toBe(already['sec-ch-ua']);
    expect(got['sec-ch-ua-mobile']).toBe('?0');
    expect(got['sec-ch-ua-platform']).toBe('"Windows"');
    // 已存在但大小写不同（Sec-CH-UA）同样算存在 —— 否则补出两个同名头。
    const mixed = run(ses.rec.listener, { 'Sec-CH-UA': '"Chromium";v="130"' });
    expect(Object.keys(mixed).filter((k) => k.toLowerCase() === 'sec-ch-ua').length).toBe(1);
  });

  it('PM-10 补出来的三个头与 UA / userAgentData 同源', () => {
    const ses = stubSession();
    pm._installClientHintBridge(ses);
    const got = run(ses.rec.listener, { 'user-agent': config.identity.userAgent });
    const md = config.identity.metadata;
    expect(got['sec-ch-ua']).toBe(md.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '));
    expect(got['sec-ch-ua']).toContain('"Google Chrome"');
    expect(got['sec-ch-ua-platform']).toBe(`"${md.platform}"`);
    expect(got['sec-ch-ua-mobile']).toBe('?0');
    // 版本必须与 UA 里那个大版本一致，否则又是"UA 说一套、hint 说另一套"。
    expect(got['sec-ch-ua']).toContain(`;v="${config.identity.chromeMajor}"`);
  });

  it('PM-11 AI_BROWSER_CLIENT_HINTS=0 时不装钩子', () => {
    const old = process.env.AI_BROWSER_CLIENT_HINTS;
    process.env.AI_BROWSER_CLIENT_HINTS = '0';
    try {
      const ses = stubSession();
      expect(pm._installClientHintBridge(ses)).toBe(false);
      expect(ses.rec.listener, '关开关后还挂 listener = 关不掉').toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.AI_BROWSER_CLIENT_HINTS;
      else process.env.AI_BROWSER_CLIENT_HINTS = old;
    }
  });

  it('PM-12 补头逻辑抛错时请求照发（callback({})），不能把浏览器的网络掐死', () => {
    const ses = stubSession();
    pm._installClientHintBridge(ses);
    let out = 'not-called';
    ses.rec.listener({ get requestHeaders() { throw new Error('boom'); } }, (r) => { out = r; });
    expect(out).toEqual({});
  });
});

// 这两组钉的是 2026-11-01 从 ai-browser-tmp 合进来的两个修复。它们各自的坑都
// 不在"有没有效"，而在"代价落在哪"：
//   · pending 地址：修复地址栏闪回是对的，但把它写进 list_tabs 的 url 会让
//     agent 把"正在请求"当成"已经到达"，于是去读上一页的 DOM。
//   · 热路径重绘：治旧画面只有 hard（1px 微调）有效，而 2026-10-25 用户报的
//     "一闪一闪、大一下小一下"正是 hard 上了高频路径。所以它必须是开关，不是默认。
describe('加载窗口期的目标地址（_pendingNavUrl / pendingNavUrl）', () => {
  it('PM-13 导航在途：pendingNavUrl 给出目标，但 list_tabs 的 url 仍是已 commit 的地址', async () => {
    const tid = pm.newTab('https://old.example/');
    const wc = pm.tabs.get(tid).webContents;
    // 真 Chromium 在这几百毫秒里 getURL() 返回的就是上一页；假对象会立刻改口，
    // 所以把"还没 commit"显式钉回来 —— 否则这条测的是假对象，不是判据。
    wc.getURL = () => 'https://old.example/';
    wc.getTitle = () => '旧页';

    await pm.navigate('https://target.example/', tid, { waitUntil: 'commit' });

    expect(pm.pendingNavUrl(tid)).toBe('https://target.example/');
    const row = pm.listTabs().find((t) => t.id === tid);
    expect(row.state).toBe('loading');
    expect(row.url, 'url 被 pending 覆盖 = agent 以为已经到了，转头去读上一页的 DOM').toBe('https://old.example/');
    expect(row.pending_url, '加载中的目标要有地方说，但不能占用 url 这一列').toBe('https://target.example/');
    // 地址栏取的正是 pending：人敲进去的那个地址不该闪回上一页。
    expect(pm.pendingNavUrl(tid) || wc.getURL()).toBe('https://target.example/');
  });

  it('PM-14 load 落地后 pending 消失，不会挂着一个永远不加载的地址', async () => {
    const tid = pm.newTab('https://old.example/');
    const wc = pm.tabs.get(tid).webContents;
    await pm.navigate('https://target.example/', tid, { waitUntil: 'commit' });
    wc.emit('did-finish-load');

    expect(pm.pendingNavUrl(tid)).toBe(null);
    expect(pm._pendingNavUrl.has(tid), 'markReady 没清 = 这一列永远脏').toBe(false);
    const row = pm.listTabs().find((t) => t.id === tid);
    expect(row.state).toBe('ready');
    expect(row.pending_url, 'state=ready 还带 pending_url = 两个字段互相打脸').toBeUndefined();
  });

  it('PM-15 关 tab 后 pending 条目跟着消失（登记表真的管到了它）', () => {
    const tid = pm.newTab('https://a.example/');
    pm._tabNavState.set(tid, 'loading');
    pm._pendingNavUrl.set(tid, 'https://b.example/');
    expect(pm.pendingNavUrl(tid)).toBe('https://b.example/');
    pm.closeTab(tid);
    expect(pm._pendingNavUrl.has(tid)).toBe(false);
  });
});

describe('占位页那一发导航的状态机出口（newTab 的 proceed）', () => {
  // newTab 先加载占位页、等垫片就绪，才发真实导航。这一次的 loading / pending
  // 由 proceed 自己写、自己清 —— 它比 navigate() 少一个出口，失败一次就永久卡住
  // （2026-11-02：状态机停在 'loading'，pendingNavUrl 的闸门跟着失效）。
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('PM-19 占位页导航失败：不留在 loading，pending 地址跟着消失', async () => {
    const tid = pm.newTab('https://target.example/');
    const wc = pm.tabs.get(tid).webContents;
    wc.emit('did-finish-load');   // 占位页加载完成 → proceed 发出真实导航
    await flush();

    expect(pm._tabNavState.get(tid)).toBe('loading');
    expect(pm.pendingNavUrl(tid)).toBe('https://target.example/');

    wc.emit('did-fail-load', -105, 'ERR_NAME_NOT_RESOLVED', 'https://target.example/', true);

    expect(pm._pendingNavUrl.has(tid), '失败没清 = 地址栏永久挂着一个不会 commit 的目标').toBe(false);
    expect(pm.pendingNavUrl(tid)).toBe(null);
    const row = pm.listTabs().find((t) => t.id === tid);
    expect(row.state, 'state 停在 loading = agent 永远等一个不会来的 ready').not.toBe('loading');
    expect(row.pending_url).toBeUndefined();
  });

  it('PM-20 这一发失败不替接管它的导航改状态（settle 的"还是我的吗"判据）', async () => {
    const tid = pm.newTab('https://target.example/');
    const wc = pm.tabs.get(tid).webContents;
    wc.emit('did-finish-load');
    await flush();

    // 另一次导航接管：pending 换成新目标，state 仍是 loading。
    // 上一次那发会以 -3 ERR_ABORTED 失败 —— 它的出口不能把别人的状态清掉。
    pm._pendingNavUrl.set(tid, 'https://other.example/');
    wc.emit('did-fail-load', -3, 'ERR_ABORTED', 'https://target.example/', true);

    expect(pm.pendingNavUrl(tid), '清了别人的 loading，地址栏就退回旧页').toBe('https://other.example/');
    expect(pm._tabNavState.get(tid)).toBe('loading');
  });
});

describe('热路径重绘档位：默认不抽搐，开了才付 hard 的代价', () => {
  it('PM-16 默认档：导航完成与切标签页都不挂重绘（e2e/layout_ws G4/G5 的单元侧镜像）', async () => {
    const tid = pm.newTab('https://a.example/');
    const wc = pm.tabs.get(tid).webContents;
    await pm.navigate('https://b.example/', tid, { waitUntil: 'commit' });
    wc.emit('did-finish-load');
    const other = pm.newTab('https://c.example/');
    pm.setActive(tid);
    pm.setActive(other);
    pm.setActive(tid);

    expect(wc.invalidations || 0, '热路径一挂重绘，用户就看到"大一下小一下"').toBe(0);
    expect(pm._hardRepaintCount || 0).toBe(0);
  });

  it('PM-17 AI_BROWSER_HOT_REPAINT=hard：这两条路径改为重新栅格化，且尺寸回到原值', async () => {
    const old = process.env.AI_BROWSER_HOT_REPAINT;
    process.env.AI_BROWSER_HOT_REPAINT = 'hard';
    try {
      const tid = pm.newTab('https://a.example/');
      const view = pm.tabs.get(tid);
      const wc = view.webContents;
      await pm.navigate('https://b.example/', tid, { waitUntil: 'commit' });
      wc.emit('did-finish-load');
      expect(wc.invalidations || 0, 'hard 档下导航完成要清掉上一页的像素').toBeGreaterThan(0);
      expect(pm._hardRepaintCount || 0, 'hard 计数是唯一可外部观察的证据').toBeGreaterThan(0);

      const other = pm.newTab('https://c.example/');
      const before = wc.invalidations || 0;
      pm.setActive(tid);
      expect((wc.invalidations || 0) - before, '切回这一页也要重绘').toBeGreaterThan(0);
      // 1px 微调是临时的：切完之后视图尺寸必须和布局算出来的一致，否则几何不变量就坏了。
      expect(view.bounds.width).toBe(1280);
      expect(view.bounds.height).toBe(800 - config.tabBarHeight);
    } finally {
      if (old === undefined) delete process.env.AI_BROWSER_HOT_REPAINT;
      else process.env.AI_BROWSER_HOT_REPAINT = old;
    }
  });

  it('PM-18 档位判据只认 hard，别的值（含 1/true）都保持默认', () => {
    const old = process.env.AI_BROWSER_HOT_REPAINT;
    try {
      for (const v of ['0', '1', 'true', '', 'soft', 'HARD ']) {
        process.env.AI_BROWSER_HOT_REPAINT = v;
        const on = v.trim().toLowerCase() === 'hard';
        expect(pm._hotRepaintHard(), `档位 ${JSON.stringify(v)} 判错`).toBe(on);
        expect(!!pm.hotRepaintOpts().hard, `opts 与判据分叉（${JSON.stringify(v)}）`).toBe(on);
      }
      delete process.env.AI_BROWSER_HOT_REPAINT;
      expect(pm._hotRepaintHard(), '不设置 = 默认关（保持不抽搐）').toBe(false);
    } finally {
      if (old === undefined) delete process.env.AI_BROWSER_HOT_REPAINT;
      else process.env.AI_BROWSER_HOT_REPAINT = old;
    }
  });
});

// 所有标签页的视图都常驻窗口、叠在同一块 bounds 上，可见与否只由 z 序决定。
// z 序只决定"谁在上面"，不保证"上面那张不透" —— 所以底色必须不透明，否则一个
// 根背景透明的页面（按 iframe 浮层设计的登录页被当成顶层文档打开）会把**下面
// 那张视图**照出来，也就是另一个标签页。真实现场与端到端判据见 e2e/paint_ws 的 P6。
describe('标签页的表面必须不透明（"每个标签页独立"在渲染层成立的前提）', () => {
  /** Electron 的底色写法：#RGB / #RRGGBB / #AARRGGBB（alpha 在前）。 */
  const isOpaque = (c) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(c || ''));
    if (!m) return false;
    const hex = m[1];
    return hex.length !== 8 || hex.slice(0, 2).toLowerCase() === 'ff';
  };

  it('PM-21 每个新建标签页的视图都拿到一个不透明底色', () => {
    const a = pm.newTab('https://a.example/');
    const b = pm.newTab('https://b.example/');
    for (const id of [a, b]) {
      const view = pm.tabs.get(id);
      expect(view.bgColor, `tab ${id} 没设底色：透明像素会把别的标签页透出来`).toBeTruthy();
      expect(isOpaque(view.bgColor), `tab ${id} 的底色 ${view.bgColor} 不是不透明的`).toBe(true);
    }
  });
});

// 截图取帧的两档分工（2026-11-02）。事故现场：agent 在**后台**标签页（百度 / dumate）
// 上截图，20 秒后拿到 `captureScreenshot timeout after 20000ms — the page main thread
// is likely blocked`，而屏幕上是一张正常画面。裸 Electron 对照实验（四格矩阵）证明
// 那句诊断是错的：
//
//   屏幕上是这一页 + 空闲     ：capturePage 20ms ✓   CDP 61ms ✓
//   被兄弟视图盖住  + 空闲     ：capturePage 9ms ✓    CDP >12s ✗   ← 主线程根本没忙
//   屏幕上是这一页 + 占死 26s ：capturePage >20s ✗    CDP 3.9s ✓
//   被兄弟视图盖住  + 占死     ：capturePage 18ms ✓   CDP >12s ✗
//
// 两档的失败面**正好互补**，所以档位由"它是不是屏幕上那一张"决定，另一档兜底。
// 被盖住的视图 capturePage 给的是它自己的合成表面，而且是活帧（每 300ms 换底色的
// 页面，隔 1.5s 再取颜色跟着变）。端到端那一面见 e2e/shot_ws.cjs。
describe('截图取帧：档位由「它是不是屏幕上那一张」决定', () => {
  const frame = (px) => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from('PNGFRAME'),
    toJPEG: () => Buffer.from('JPEGRAME'),
    getSize: () => px,
  });
  const noFrame = { isEmpty: () => true, toPNG: () => Buffer.from('') };
  const cdpOk = (method) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1264, clientHeight: 661 } };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('CDPFRAME').toString('base64') };
    return {};
  };

  // 按方法记下有没有真的发过 CDP 命令。只数 Page.captureScreenshot：探密码框那次
  // evaluate 允许试（surface 档下 1.5s 就被掐掉），它不是"取帧"。
  function spyCdp(wc, impl) {
    const calls = { by: {} };
    wc.debugger.sendCommand = (method) => {
      calls.by[method] = (calls.by[method] || 0) + 1;
      return impl ? impl(method) : new Promise(() => {});
    };
    return calls;
  }
  const captureCalls = (calls) => calls.by['Page.captureScreenshot'] || 0;

  // newTab 会把自己设成 activeTab，所以开两页再把前面那页设回去，就得到
  // "屏幕上是 shown、back 被整个盖住"的形状 —— 和用户现场一致。
  function shownAndCovered() {
    const shown = pm.newTab('https://shown.example/');
    const back = pm.newTab('https://back.example/');
    pm.setActive(shown);
    return { shown, back };
  }

  it('PM-22 被盖住的标签页：surface 档先答，一次 CDP 截图命令都不发', async () => {
    const { back } = shownAndCovered();
    const view = pm.tabs.get(back);
    const wc = view.webContents;
    const b = view.getBounds();
    wc.capturePage = () => Promise.resolve(frame({ width: b.width * 2, height: b.height * 2 }));
    // CDP 这一档现在是"永远不返回"的形状（实测被盖住的视图就是这样）。
    const cdp = spyCdp(wc);
    // evaluate 也占死：surface 档不该为了"探密码框 / 读 dpr"去等主线程。
    wc.executeJavaScript = () => new Promise(() => {});

    const t0 = Date.now();
    const r = await pm.screenshot(back, {});
    const waited = Date.now() - t0;

    expect(r.ok, r.error).toBe(true);
    expect(r.source).toBe('surface');
    expect(captureCalls(cdp), '这一档成了还去发截图命令 = 白等一整个 20s deadline').toBe(0);
    expect(waited, '被盖住的页面旧路径必然 20s 超时，这里必须是秒级').toBeLessThan(5000);
    expect(Buffer.from(r.data, 'base64').toString()).toBe('PNGFRAME');
    expect(r.width).toBe(b.width);
    expect(r.height).toBe(b.height);
    expect(r.device_pixel_ratio, '位图宽/视图宽就是 dpr，不必去问主线程').toBe(2);
    expect(r.password_probe, '探不到密码框要如实说没探成，不能当成"没有密码框"').toBe('skipped');
    expect(r.warning).toContain('typed secrets');
  });

  it('PM-23 屏幕上是这一页：CDP 优先（要的是新鲜帧），capturePage 一次都不叫', async () => {
    const { shown } = shownAndCovered();
    const wc = pm.tabs.get(shown).webContents;
    let captureCalls_ = 0;
    wc.capturePage = () => { captureCalls_++; return new Promise(() => {}); };   // 叫了就是白等 5s
    spyCdp(wc, cdpOk);

    const t0 = Date.now();
    const r = await pm.screenshot(shown, {});
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toBe('cdp');
    expect(captureCalls_, 'CDP 已经答了，不该再去拷表面').toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(Buffer.from(r.data, 'base64').toString()).toBe('CDPFRAME');
  });

  it('PM-24 屏幕上是这一页但 CDP 等不到帧 → 兜底到 surface（旧行为是直接报错）', async () => {
    const { shown } = shownAndCovered();
    const view = pm.tabs.get(shown);
    const wc = view.webContents;
    const b = view.getBounds();
    wc.capturePage = () => Promise.resolve(frame({ width: b.width, height: b.height }));
    // 把"CDP 超时"这一形状显式摆出来（20s 不在单测里真等）：__deadline 是
    // deadline.js 的标记，_shotFromCdp 靠它区分超时和别的错误。
    const boom = Object.assign(new Error('captureScreenshot timeout after 20000ms'), { __deadline: true });
    spyCdp(wc, (method) => (method === 'Page.getLayoutMetrics' ? Promise.resolve({}) : Promise.reject(boom)));

    const r = await pm.screenshot(shown, {});
    expect(r.ok, r.error).toBe(true);
    expect(r.source, 'CDP 拿不到时至少有表面可给，别把一帧好好的画面说成截不到').toBe('surface');
  });

  it('PM-25 被盖住的页面 surface 给不到位图时，仍然回落 CDP（档位会换，图不许没有）', async () => {
    const { back } = shownAndCovered();
    const wc = pm.tabs.get(back).webContents;
    wc.capturePage = () => Promise.resolve(noFrame);
    spyCdp(wc, cdpOk);

    const r = await pm.screenshot(back, {});
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toBe('cdp');
    expect(r.width).toBe(1264);
  });

  it('PM-26 负对照：显式 source 只点一档，就不许偷偷换档', async () => {
    const { back } = shownAndCovered();
    const view = pm.tabs.get(back);
    const wc = view.webContents;
    const b = view.getBounds();
    // surface 明明有图，但这一发只要 CDP —— 修的是档位选择，不是把超时藏起来。
    wc.capturePage = () => Promise.resolve(frame({ width: b.width, height: b.height }));
    const boom = Object.assign(new Error('captureScreenshot timeout after 20000ms'), { __deadline: true });
    const calls = spyCdp(wc, (method) => (method === 'Page.getLayoutMetrics' ? Promise.resolve({}) : Promise.reject(boom)));

    const onlyCdp = await pm.screenshot(back, { source: 'cdp' });
    expect(onlyCdp.ok).toBe(false);
    expect(onlyCdp.error).toContain('captureScreenshot timeout after 20000ms');
    expect(captureCalls(calls)).toBe(1);

    wc.capturePage = () => Promise.resolve(noFrame);
    const onlySurface = await pm.screenshot(back, { source: 'surface' });
    expect(onlySurface.ok).toBe(false);
    expect(onlySurface.error).toContain('no-surface-frame');
    expect(captureCalls(calls), '点名只要 surface，就不该替他发截图命令').toBe(1);
  });

  it('PM-27 语义要渲染进程配合的请求（fullPage / clip / webp）不许由 surface 档应答', async () => {
    const { back } = shownAndCovered();   // 即使是被盖住的那一页（surface 优先的档位）
    const wc = pm.tabs.get(back).webContents;
    wc.capturePage = () => Promise.resolve(frame({ width: 1264, height: 661 }));
    spyCdp(wc, cdpOk);

    for (const req of [
      { fullPage: true },
      { clip: { x: 0, y: 400, width: 300, height: 200 } },
      { format: 'webp' },
    ]) {
      const r = await pm.screenshot(back, req);
      expect(r.ok, JSON.stringify(req) + ' → ' + r.error).toBe(true);
      expect(r.source, JSON.stringify(req) + ' 位图里没有视口外的布局、clip 的文档坐标也不等于当前视口那一帧').toBe('cdp');
    }
  });

  it('PM-28 分水岭判据：只有「窗口在屏幕上 且 不是 activeTab」才算被盖住', () => {
    const { shown, back } = shownAndCovered();
    expect(pm._isCoveredByOtherTab(back), '后台标签页是被盖住的（现场就是这一格）').toBe(true);
    expect(pm._isCoveredByOtherTab(shown), '屏幕上那一张不算').toBe(false);

    pm.window.isVisible = () => false;                       // 窗口隐藏：没有兄弟视图压在上面
    expect(pm._isCoveredByOtherTab(back), '隐藏时确实"没有被兄弟盖住"——但这不再等于档位顺序（见下面那一组）').toBe(false);
    pm.window.isVisible = () => true;
    pm.window.isMinimized = () => true;
    expect(pm._isCoveredByOtherTab(back), '最小化同理').toBe(false);
    pm.window.isMinimized = () => false;

    delete pm.window.isVisible;
    delete pm.window.isMinimized;
    expect(pm._isCoveredByOtherTab(back), '问不到可见性就按旧路径办，不搞意外').toBe(false);
  });

  it('PM-29 屏幕上那一页主线程占死：先交付帧，布局指标只是附属（问不到就用几何算）', async () => {
    const { shown } = shownAndCovered();
    const view = pm.tabs.get(shown);
    const wc = view.webContents;
    const b = view.getBounds();
    // 这一格摆的是"截图答得快、附属命令排队排不通"的形状（页面主线程慢/被长任务占着）：
    // 旧实现先问布局指标（10s deadline）再发截图，整发被一次用不上的探测顶到超时线上。
    const order = [];
    wc.debugger.sendCommand = (method) => {
      order.push(method);
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: Buffer.from('CDPFRAME').toString('base64') });
      }
      return new Promise(() => {});
    };
    // 探密码框那次 evaluate 同样排不通 —— 快速失败即可，这里要测的是顺序不是预算。
    wc.executeJavaScript = () => Promise.reject(new Error('blocked'));
    const prev = process.env.AI_BROWSER_SHOT_METRICS_MS;
    process.env.AI_BROWSER_SHOT_METRICS_MS = '300';   // 不让单测真的等 1.5s

    const t0 = Date.now();
    const r = await pm.screenshot(shown, {});
    const waited = Date.now() - t0;
    if (prev === undefined) delete process.env.AI_BROWSER_SHOT_METRICS_MS;
    else process.env.AI_BROWSER_SHOT_METRICS_MS = prev;

    expect(r.ok, r.error).toBe(true);
    expect(r.source).toBe('cdp');
    expect(order.indexOf('Page.captureScreenshot'), '截图命令必须排在布局指标前面')
      .toBeGreaterThanOrEqual(0);
    expect(order.indexOf('Page.getLayoutMetrics') > order.indexOf('Page.captureScreenshot'),
      '先问指标 = 让已经能到手的好帧去排一个它不需要的队（实测多等 10s）').toBe(true);
    expect(waited, '整发只花两个附属预算（这里 300ms + 探测 3s）；旧顺序还要再加 10s 指标空等').toBeLessThan(4000);
    expect(r.width, '布局指标问不到就用视图边界 —— 尺寸本来就有几何答案').toBe(b.width);
    expect(r.password_probe, '探测排不通就如实标 skipped').toBe('skipped');
  });
});

// 2026-11-03 的探针实测把分水岭的尺子换了一次。上面 PM-28 那条判据（"有没有兄弟视图
// 压在它上面"）在**窗口不显示**时算出"没被盖住"，于是隐藏窗口里的每一发截图都先排 CDP
// 那条 20s 的队 —— 而那一格只有正在重绘的页面答得出截图，静态页一直等到 deadline，
// surface 档几十毫秒就给帧（甚至 2ms 就如实说"这一帧不存在"）。现场是 agent 常在隐藏
// 窗口里干活，所以最该快的那一格长期走的是最慢的那条路。
//
// 同时修归因：旧实现两档往同一个 lastError 里写，后一档把前一档覆盖掉，于是明明白等了
// CDP 的 20 秒，回执只剩一句"这一页从来没画过"——把人去修错的地方。
describe('截图取帧：窗口不在屏幕上时 surface 先答，两档的理由都进回执', () => {
  const frame = (px) => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from('PNGFRAME'),
    toJPEG: () => Buffer.from('JPEGRAME'),
    getSize: () => px,
  });
  const noFrame = { isEmpty: () => true, toPNG: () => Buffer.from('') };
  // 接单永远不回的 CDP（被盖住 / 不重绘的页面实测就是这个形状）。
  // 只记 Page.captureScreenshot：图到手之后探密码框那次命令允许试（它有短预算），
  // 它不是"取帧"，混进来就把档位顺序量歪了。
  const isShot = (m) => m === 'Page.captureScreenshot';
  const cdpHang = (wc, order) => {
    wc.debugger.sendCommand = (method) => {
      if (isShot(method)) order.push('cdp');
      return new Promise(() => {});
    };
  };

  // 隐藏窗口里的两个形状：后台那一页、以及"就是 activeTab 但窗口没显示"那一页
  //（旧判据把后者算成"屏幕上那一张"，于是让它去排 CDP —— 屏幕上根本没有这一帧）。
  function hiddenTabs() {
    const front = pm.newTab('https://front.example/');
    const back = pm.newTab('https://back.example/', { show: false });
    pm.setActive(front);
    pm.window.isVisible = () => false;
    return { front, back };
  }

  it('PM-60 窗口隐藏 + 后台标签页：surface 档先答，一次 CDP 截图命令都不发', async () => {
    const { back } = hiddenTabs();
    const view = pm.tabs.get(back);
    const wc = view.webContents;
    const b = view.getBounds();
    const order = [];
    wc.capturePage = () => { order.push('surface'); return Promise.resolve(frame({ width: b.width * 2, height: b.height * 2 })); };
    cdpHang(wc, order);

    const t0 = Date.now();
    const r = await pm.screenshot(back, {});
    const waited = Date.now() - t0;

    expect(r.ok, r.error).toBe(true);
    expect(order, '旧顺序这里先排 CDP，20s 之后才想起 surface').toEqual(['surface']);
    expect(r.source).toBe('surface');
    expect(waited, '这一档几十毫秒的事，等满 20s 就是白烧').toBeLessThan(5000);
    expect(r.device_pixel_ratio, 'dpr 由位图宽/视图宽算，不必去问主线程').toBe(2);
  });

  it('PM-61 窗口隐藏 + activeTab：也不算「屏幕上这一帧」，仍然 surface 优先', async () => {
    const { front } = hiddenTabs();
    const view = pm.tabs.get(front);
    const wc = view.webContents;
    const b = view.getBounds();
    const order = [];
    wc.capturePage = () => { order.push('surface'); return Promise.resolve(frame({ width: b.width, height: b.height })); };
    cdpHang(wc, order);

    const r = await pm.screenshot(front, {});
    expect(r.ok, r.error).toBe(true);
    expect(order).toEqual(['surface']);
    expect(r.source).toBe('surface');
  });

  it('PM-62 两档都给不到位图：两句理由都在回执里，前一档不再被覆盖', async () => {
    const front = pm.newTab('https://front.example/');
    const back = pm.newTab('https://back.example/', { show: false });
    pm.setActive(front);                       // 窗口可见 → back 是被盖住的那一张，surface 先
    const view = pm.tabs.get(back);
    const wc = view.webContents;
    const order = [];
    wc.capturePage = () => { order.push('surface'); return Promise.resolve(noFrame); };
    // CDP 这一档摆成"到 deadline"的形状（20s 不在单测里真等）：__deadline 是
    // deadline.js 的标记，_shotFromCdp 靠它区分超时和别的错误。
    const boom = Object.assign(new Error('captureScreenshot timeout after 20000ms'), { __deadline: true });
    wc.debugger.sendCommand = (method) => {
      if (isShot(method)) order.push('cdp');
      return Promise.reject(boom);
    };

    const r = await pm.screenshot(back, {});
    expect(r.ok).toBe(false);
    expect(order).toEqual(['surface', 'cdp']);
    expect(r.tiers_tried).toEqual(['surface', 'cdp']);
    expect(r.error).toContain('no-surface-frame');
    expect(r.error, '白等的那 20 秒要在回执里说清楚，不然调用方只会去查"页面为什么没画"')
      .toContain('captureScreenshot timeout after 20000ms');
    expect(r.error).toContain('[surface]');
    expect(r.error).toContain('[cdp]');
  });
});

// 对话框盯梢（2026-11-03）。这一条不是顺手补的：把截图档位改成 surface 优先之后，
// background_ws 的 B2 当场整段卡死 —— 一个 alert 冻住渲染器，之后 get_tree、navigate、
// 连最小化全都超时。查下去才发现旧实现"发一条 Page.enable 不等回执、当场记成已盯梢"，
// 而 attach 那一刻往往正是渲染器不接单的时候；以前是**截图的 CDP 档又发了一次 enable**
// 才让事件监听真的装上。也就是说 alert 能不能被解开，取决于这条 tab 恰好有没有被
// CDP 截过图。修法是"回执成功才算装上"，并且在文档就绪、动作之前各补一次。
describe('对话框盯梢：Page.enable 要拿到回执才算装上', () => {
  const armEnv = 'AI_BROWSER_DIALOG_ARM_MS';
  let prevArm;

  beforeEach(() => {
    prevArm = process.env[armEnv];
    process.env[armEnv] = '200';        // 落空的那一次不该让单测真等 1.5s
  });
  afterEach(() => {
    if (prevArm === undefined) delete process.env[armEnv];
    else process.env[armEnv] = prevArm;
  });

  // 让 Page.enable 前 N 次"发出去没人应答"（渲染器还没就绪的形状），之后正常。
  function enableFailsFirst(wc, times) {
    let tries = 0;
    const bys = [];
    wc.debugger.sendCommand = (method) => {
      bys.push(method);
      if (method === 'Page.enable' && tries < times) {
        tries++;
        return new Promise(() => {});
      }
      return Promise.resolve({});
    };
    return bys;
  }

  it('PM-63 enable 落空时不记账；下一次机会补上回执才算盯住', async () => {
    const tid = pm.newTab('https://a.example/');
    const view = pm.tabs.get(tid);
    pm._dialogWatched.delete(tid);
    pm._dialogWatchArming.delete(tid);
    enableFailsFirst(view.webContents, 1);

    expect(await pm._armDialogWatch(tid, view), '那条 enable 没人应答 = 没有盯梢').toBe(false);
    expect(pm._dialogWatched.has(tid), '落空还记账，就等于这条 tab 永远不再被试').toBe(false);

    // 渲染器就绪了（后面的命令正常回执）—— 必须能补上
    view.webContents.debugger.sendCommand = () => Promise.resolve({});
    expect(await pm._armDialogWatch(tid, view)).toBe(true);
    expect(pm._dialogWatched.has(tid)).toBe(true);
    expect(await pm._armDialogWatch(tid, view), '已盯住就不该再发一遍 enable').toBe(true);
  });

  it('PM-64 动作之前把盯梢补上：没装上的 tab 一点 alert 就永久冻死', async () => {
    const tid = pm.newTab('https://a.example/');
    const view = pm.tabs.get(tid);
    pm._dialogWatched.delete(tid);
    pm._dialogWatchArming.delete(tid);
    const bys = enableFailsFirst(view.webContents, 0);

    await pm.executeAction('click', { role: 'button', name: '按钮' }, { tab: tid }, tid)
      .catch(() => null);   // 动作本身成不成不重要，这里钉的是"投递之前有没有装好监听"

    expect(bys.filter((m) => m === 'Page.enable').length, '动作前必须确认过盯梢').toBeGreaterThanOrEqual(1);
    expect(pm._dialogWatched.has(tid)).toBe(true);
  });

  it('PM-65 没挂上调试器不等于已盯梢（attach 失败不能记成成功）', async () => {
    const tid = pm.newTab('https://a.example/');
    const view = pm.tabs.get(tid);
    pm._cdpTabs.delete(tid);
    pm._dialogWatched.delete(tid);
    pm._dialogWatchArming.delete(tid);
    view.webContents.debugger.attach = () => { throw new Error('Debugger is already attached'); };
    view.webContents.debugger.sendCommand = () => Promise.resolve({});

    expect(await pm._armDialogWatch(tid, view), 'attach 都没成，域肯定没启用').toBe(false);
    expect(pm._dialogWatched.has(tid)).toBe(false);
  });
});

describe('window.open 弹窗按请求的几何呈现（不再长成整号标签页）', () => {
  // freshWindow 的内容区是 1280×800，减去标签栏 74 → 整号视图是 {0,74,1280,726}。
  const FULL = { x: 0, y: 74, width: 1280, height: 726 };

  it('PM-30 popupRect 在挂视图之前就记好：新建那一刻就是浮层尺寸', () => {
    const rect = { x: 120, y: 154, width: 420, height: 520 };
    const tid = pm.newTab('https://a.example/login', { popupRect: rect });
    expect(pm.tabs.get(tid).getBounds()).toEqual(rect);
    expect(pm._popupRects.get(tid)).toEqual(rect);
  });

  it('PM-31 几何只有一个出口：窗口缩小浮层跟着夹，放大不把它撑回去', () => {
    const tid = pm.newTab('https://a.example/', { popupRect: { x: 300, y: 200, width: 420, height: 520 } });
    pm._layoutAllViews({ width: 500, height: 600 });   // 内容区 500×526
    expect(pm.tabs.get(tid).getBounds(), '浮层不许跑到窗口外面去').toEqual({ x: 80, y: 80, width: 420, height: 520 });
    pm._layoutAllViews({ width: 1280, height: 800 });
    expect(pm.tabs.get(tid).getBounds(), '可用区变大不等于站点重新请求过尺寸').toEqual({ x: 300, y: 200, width: 420, height: 520 });
    // 对照：普通 tab 永远铺满
    const other = pm.newTab('https://b.example/', { show: false });
    pm._layoutAllViews({ width: 1280, height: 800 });
    expect(pm.tabs.get(other).getBounds()).toEqual(FULL);
  });

  it('PM-32 布局审计的反查也问同一份判据：浮层被"纠正"回整屏才算坏，占小格子不算坏', () => {
    const popup = pm.newTab('https://a.example/', { popupRect: { x: 10, y: 84, width: 300, height: 200 } });
    const normal = pm.newTab('https://b.example/', { show: false });
    expect(pm._layoutIsBad(popup, pm.tabs.get(popup).getBounds()), '正合请求 → 不该报').toBe(false);
    expect(pm._layoutIsBad(popup, FULL), '浮层被摆成整屏 → 正是这条审计要看见的形态').toBe(true);
    expect(pm._layoutIsBad(normal, FULL), '普通页铺满是对的').toBe(false);
    expect(pm._layoutIsBad(normal, { x: 0, y: 74, width: 640, height: 726 }), '普通页缩一半是错的（历史 bug）').toBe(true);
    // 白屏自检里"该占多大"问的是同一个函数：判据分叉 = 每个弹窗都被记成 layout_mismatch
    expect(pm._expectedBounds(popup)).toEqual({ x: 10, y: 84, width: 300, height: 200 });
    expect(pm._expectedBounds(normal)).toEqual(FULL);
    expect(pm._expectedBounds(null)).toEqual(FULL);   // null = "可用区"本身，不是某个 tab
  });

  it('PM-33 setWindowOpenHandler：写了尺寸才当弹窗，没写尺寸照旧整号', () => {
    const opener = pm.newTab('https://a.example/');
    const handler = pm.tabs.get(opener).webContents.windowOpenHandler;
    expect(typeof handler, 'newTab 没装 setWindowOpenHandler').toBe('function');

    const r = handler({ url: 'https://a.example/login', features: 'width=420,height=520,left=120,top=80' });
    expect(r.action, '仍然自建 tab，不交给 Electron 开原生窗口').toBe('deny');
    const child = pm.tabs.get(pm.listTabs().find((t) => t.id !== opener).id);
    expect(child.getBounds(), 'left/top 是相对内容区的偏移，y 已含标签栏').toEqual({ x: 120, y: 154, width: 420, height: 520 });

    const before = pm.tabs.size;
    // noopener / _blank 不是尺寸 —— Chrome 也不把它们当弹窗，否则所有外链都弹成小窗
    handler({ url: 'https://c.example/', features: 'noopener=yes,noreferrer=yes' });
    const plain = pm.tabs.get(before + 1);
    expect(plain.getBounds()).toEqual(FULL);
    expect(pm._popupRects.has(before + 1)).toBe(false);
  });

  it('PM-34 两条打开入口给同一个几何：垫片 IPC 与原生 handler 判据一致', () => {
    const opener = pm.newTab('https://a.example/');
    const features = 'width=420,height=520,left=120,top=80';
    pm.tabs.get(opener).webContents.windowOpenHandler({ url: 'https://a.example/x', features });
    const viaNative = pm.tabs.get(2).getBounds();

    electronMock.ipcMain.emit('ai:window_open',
      { sender: pm.tabs.get(opener).webContents },
      { token: 'wo1', url: '', name: '_blank', features });
    expect(pm.tabs.get(3).getBounds(), '同一个特性串走两条路得到同一块地方').toEqual(viaNative);
    // 特性串缺失（老版本桥/测试桩）→ 整号，不报错
    electronMock.ipcMain.emit('ai:window_open',
      { sender: pm.tabs.get(opener).webContents },
      { token: 'wo2', url: '', name: '_blank' });
    expect(pm.tabs.get(4).getBounds()).toEqual(FULL);
  });

  it('PM-35 listTabs 把浮层的矩形报出去（agent 按整屏点这一页会打空）', () => {
    const normal = pm.newTab('https://a.example/');
    const popup = pm.newTab('https://b.example/', { show: false, popupRect: { x: 10, y: 84, width: 300, height: 200 } });
    const byId = new Map(pm.listTabs().map((t) => [t.id, t]));
    expect(byId.get(normal).popup, '普通 tab 不该带 popup 字段（省 token，也不制造噪音）').toBeUndefined();
    expect(byId.get(popup).popup).toEqual({ x: 10, y: 84, width: 300, height: 200 });
  });

  it('PM-36 关弹窗后矩形跟着消失：下一个 tab 不许继承浮层尺寸', () => {
    const tid = pm.newTab('https://a.example/', { popupRect: { x: 10, y: 84, width: 300, height: 200 } });
    pm.closeTab(tid);
    expect(pm._popupRects.has(tid)).toBe(false);
    const next = pm.newTab('https://b.example/');
    expect(pm.tabs.get(next).getBounds(), '新 tab 必须铺满，而不是继续当浮层').toEqual(FULL);
  });
});

// ---------------------------------------------------------------------------
// 声音只跟人眼前那一页（2026-11-03 对照 Chromium 吸收的第 1 项）
//
// 所有标签页挂在同一个窗口上，可见性靠 z 序，**音频没有 z 序**：agent 在后台开的
// 视频页会一路响，而人找不到那个喇叭图标去关它。判据在 shared/tab_audio.cjs，
// 这里钉的是"接线"：什么时候算、什么时候重算、回执说不说实话。
// ---------------------------------------------------------------------------
describe('后台标签页静音：agent 的后台页不出声，人的页照旧', () => {
  const agentGroup = (sessionId, limit) => {
    const g = pm.ensureGroup(sessionId, null, { capped: true });
    if (limit) g.limit = limit;
    return g.id;
  };

  it('PM-37 agent 的后台页从出生就是静音的（不等第一次 setActive）', () => {
    const human = pm.newTab('https://human.example/');      // 人眼前那一页
    const bg = pm.newTab('https://a.example/video', { show: false, group: agentGroup('s1') });
    expect(pm.tabs.get(bg).webContents.isMuted(), '从 newTab 那一刻就按住，晚设一步就是先响几分钟').toBe(true);
    expect(pm.tabs.get(human).webContents.isMuted()).toBe(false);
  });

  it('PM-38 人点开那一页 → 放开；被顶下去的 agent 页 → 按住；人的页切走了也照旧响', () => {
    const before = pm.newTab('https://human.example/');
    const bg = pm.newTab('https://a.example/', { show: false, group: agentGroup('s1') });
    pm.setActive(bg);
    expect(pm.tabs.get(bg).webContents.isMuted(), '人点开就该听见').toBe(false);
    expect(pm.tabs.get(before).webContents.isMuted(), '人自己的页切走了也不许静音（Chrome 不这么做）').toBe(false);
    pm.setActive(before);
    expect(pm.tabs.get(bg).webContents.isMuted(), '回到后台就重新按住').toBe(true);
  });

  it('PM-39 agent 把某一页顶到人眼前也算"眼前"（判据是 activeTab，不是谁点的）', () => {
    pm.newTab('https://human.example/');
    const gid = agentGroup('s1');
    const a = pm.newTab('https://a.example/', { show: false, group: gid });
    const b = pm.newTab('https://b.example/', { show: false, group: gid });
    pm.setActive(a);
    expect(pm.tabs.get(a).webContents.isMuted()).toBe(false);
    expect(pm.tabs.get(b).webContents.isMuted()).toBe(true);
    pm.setActive(b);
    expect(pm.tabs.get(a).webContents.isMuted()).toBe(true);
    expect(pm.tabs.get(b).webContents.isMuted()).toBe(false);
  });

  it('PM-40 只在状态真的变化时调 setAudioMuted（切一次页把八页各设一遍是纯浪费）', () => {
    pm.newTab('https://human.example/');
    const bg = pm.newTab('https://a.example/', { show: false, group: agentGroup('s1') });
    const wc = pm.tabs.get(bg).webContents;
    const calls = [];
    wc.setAudioMuted = (m) => { calls.push(m); wc.audioMuted = m; };
    pm._mutedTabs.delete(bg);      // 抹掉出生那一次的记账，让"第一次真的按下"被数到
    pm._syncMute();
    pm._syncMute();
    pm._syncMute();
    expect(calls, '第一次之后状态没变，不该再往下调').toEqual([true]);
    // 反过来也一样：放开一次就够
    pm.setActive(bg);
    pm._syncMute();
    expect(wc.isMuted()).toBe(false);
  });

  it('PM-41 关掉人眼前那一页之后，声音归属跟着重算（换人就是换判据）', () => {
    const gid = agentGroup('s1');
    const a = pm.newTab('https://a.example/', { show: false, group: gid });   // 第一页：自动到人眼前
    const b = pm.newTab('https://b.example/', { show: false, group: gid });
    pm.setActive(b);
    expect(pm.tabs.get(a).webContents.isMuted(), 'a 回到后台，按住').toBe(true);
    expect(pm.tabs.get(b).webContents.isMuted()).toBe(false);
    pm.closeTab(b);
    expect(pm.activeTab).toBe(a);
    expect(pm.tabs.get(a).webContents.isMuted(), '它现在是新的"人眼前那一页"').toBe(false);
  });

  it('PM-42 人接手 agent 的页之后切走 → 放开（归属换了，判据就得跟着换）', () => {
    pm.newTab('https://human.example/');
    const bg = pm.newTab('https://a.example/', { show: false, group: agentGroup('s1') });
    expect(pm.tabs.get(bg).webContents.isMuted()).toBe(true);
    pm.moveToGroup(bg, 'human');
    expect(pm.tabs.get(bg).webContents.isMuted(), '现在它是人自己开的后台页 = Chrome 行为，继续响').toBe(false);
  });

  it('PM-43 AI_BROWSER_BG_MUTE=0 一律不静音，而且连账都不留', () => {
    process.env.AI_BROWSER_BG_MUTE = '0';
    try {
      pm.newTab('https://human.example/');
      const bg = pm.newTab('https://a.example/', { show: false, group: agentGroup('s1') });
      expect(pm.tabs.get(bg).webContents.isMuted()).toBe(false);
      expect(pm._mutedTabs.has(bg), '关掉开关后连账都不该留：集合里有的才是真被按住的').toBe(false);
      expect(pm.listTabs().find((t) => t.id === bg).muted).toBeUndefined();
    } finally {
      delete process.env.AI_BROWSER_BG_MUTE;
    }
  });

  it('PM-44 listTabs 把静音说出去（视频在动却没声音，判据只能是这个字段）', () => {
    pm.newTab('https://human.example/');
    const bg = pm.newTab('https://a.example/', { show: false, group: agentGroup('s1') });
    const byId = new Map(pm.listTabs().map((t) => [t.id, t]));
    expect(byId.get(bg).muted).toBe(true);
    expect(byId.get(1).muted, '没静音的页不该带这个字段').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 淘汰保护：整页关掉之前，先看它有没有"还没提交的东西"
//
// 我们的淘汰比 Chrome 的 discard 狠（discard 至少留着表单，我们一关全没），所以保护
// 必须更紧。判据在 shared/tab_group.cjs，这里钉的是"事实从哪儿来"：草稿 = 主进程
// 记账（架构保证人只能在看得见的那页打字，而那正是 activeTab，已经排除在外）；
// 下载 = DownloadMonitor.hasActive。
// ---------------------------------------------------------------------------
describe('淘汰保护：草稿页与下载中的页不被牺牲', () => {
  const fillGroup = (sessionId, limit) => {
    const gid = pm.ensureGroup(sessionId, null, { capped: true }).id;
    if (limit) pm.groupMeta(gid).limit = limit;
    pm.newTab('https://human.example/');                     // 人眼前那一页
    const old = pm.newTab('https://old.example/compose', { show: false, group: gid });
    const opener = pm.newTab('https://opener.example/', { show: false, group: gid });
    pm._tabUsedAt.set(old, 100);          // 最久没用 —— 本来该它当牺牲品
    pm._tabUsedAt.set(opener, 900);
    return { gid, old, opener };
  };

  it('PM-45 默认照旧：最久没用的那一页被牺牲（没有保护时不许改变既有行为）', () => {
    const { gid, old, opener } = fillGroup('s2', 2);
    expect(pm.pickEvictableInGroup(gid, opener)).toBe(old);
  });

  it('PM-46 这一页有没提交的输入 → 不牺牲它；没有别的可牺牲就宁可超限', () => {
    const { gid, old, opener } = fillGroup('s3', 2);
    pm._setDraft(old, true);
    expect(pm.pickEvictableInGroup(gid, opener), '写了一半的私信被关掉 = 把几分钟的工作删了').toBe(null);
    pm._setDraft(old, false);
    expect(pm.pickEvictableInGroup(gid, opener), '销掉保护就回到原样').toBe(old);
  });

  it('PM-47 进行中的下载 → 不牺牲它（关页会连带取消那条下载）', () => {
    const { gid, old, opener } = fillGroup('s4', 2);
    expect(pm.downloadMonitor.hasActive(old)).toBe(false);
    pm.downloadMonitor._byTab.set(old, new Map([['dl-1', { id: 'dl-1', state: 'progressing' }]]));
    expect(pm.pickEvictableInGroup(gid, opener)).toBe(null);
    // 已经停下的下载不保护：不然一个失败的下载能永远占住一页，上限就失效了
    pm.downloadMonitor._byTab.set(old, new Map([['dl-1', { id: 'dl-1', state: 'interrupted' }]]));
    expect(pm.pickEvictableInGroup(gid, opener)).toBe(old);
  });

  it('PM-48 保护状态要说得出来：tabsInGroup 带上 draft、downloading', () => {
    const { gid, old } = fillGroup('s5', 2);
    pm._setDraft(old, true);
    pm.downloadMonitor._byTab.set(old, new Map([['dl-1', { id: 'dl-1', state: 'progressing' }]]));
    const row = pm.tabsInGroup(gid).find((t) => t.id === old);
    expect(row.draft).toBe(true);
    expect(row.downloading).toBe(true);
    const clean = pm.tabsInGroup(gid).find((t) => t.id !== old);
    expect(clean.draft, '干净的页不该带字段（每一条都会进回执）').toBeUndefined();
    expect(clean.downloading).toBeUndefined();
  });

  it('PM-49 type 置位，clear 与主框架导航销位，页内导航不销', () => {
    pm.newTab('https://human.example/');
    const tid = pm.newTab('https://a.example/compose', {
      show: false, group: pm.ensureGroup('s6', null, { capped: true }).id,
    });
    // 记账在 executeAction 的第一个 await 之前，所以不用等它跑完（动作本身在这套桩
    // 里会失败，那是另一件事 —— 这里钉的是"把文字送进页面会留下草稿标记"）。
    pm.executeAction('type', 'e:div', { text: '写到一半' }, tid).catch(() => {});
    expect(pm._tabHasDraft.get(tid), 'agent 输入过的页不许被弹窗挤掉').toBe(true);

    pm.executeAction('clear', 'e:div', {}, tid).catch(() => {});
    expect(pm._tabHasDraft.has(tid), '内容被清掉了就没有草稿可丢，保护该跟着销').toBe(false);

    pm._setDraft(tid, true);
    pm.tabs.get(tid).webContents.emit('did-navigate', {}, 'https://a.example/other');
    expect(pm._tabHasDraft.has(tid), '换了文档 = 草稿要么提交了要么没了').toBe(false);

    pm._setDraft(tid, true);
    // 页内导航（pushState / #hash）**不**销：SPA 发私信、发评论走的就是这条路
    pm.tabs.get(tid).webContents.emit('did-navigate-in-page', {}, 'https://a.example/#x');
    expect(pm._tabHasDraft.get(tid), '页内导航不等于内容已经保存').toBe(true);
  });

  it('PM-50 关掉草稿页之后标记跟着消失：下一个 tab 不许继承别人的草稿', () => {
    pm.newTab('https://human.example/');                 // 人眼前那一页，别让新页被自动顶上去
    const gid = pm.ensureGroup('s7', null, { capped: true }).id;
    const tid = pm.newTab('https://a.example/compose', { show: false, group: gid });
    pm._setDraft(tid, true);
    pm.closeTab(tid);
    expect(pm._tabHasDraft.has(tid)).toBe(false);
    expect(pm._mutedTabs.has(tid), '静音状态同理').toBe(false);
    const next = pm.newTab('https://b.example/', { show: false, group: gid });
    expect(pm._tabHasDraft.has(next), 'tabId 不复用，但判据也不能靠"上一个"').toBe(false);
    expect(pm.tabs.get(next).webContents.isMuted(), '新页按自己的归属重算').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 受信输入前的可见性闸门（shared/input_routing.cjs 的执行侧）
//
// 钉的是 2026-11-03 逐杠杆实测换来的那条事实：窗口从未显示过时，页面自报
// document.visibilityState:'visible' 的**唯一条件**是它拿到过 CDP 的
// Emulation.setFocusEmulationEnabled；没拿到的页一律 hidden，而 Chromium 对 hidden
// 文档**丢弃**模拟输入 —— 发出去不报错、不排队、也不改投给别人，而旧回执照样写
// success:true。判据本身在纯函数里钉（tests/test_input_routing.js），这里只钉执行：
// 命令发没发、发了几发、失败回执长什么样、以及有没有顺手把 z 序 / activeTab 改了。
// ---------------------------------------------------------------------------
describe('动作之前先确认这一页收得到输入（hidden 文档会吞掉 CDP 输入）', () => {
  const agentGroup = (sessionId) => pm.ensureGroup(sessionId, null, { capped: true }).id;

  // 背景：先有一页在"人眼前"，再开一页 agent 的后台页 —— 后者的 debugger 换成
  // 可观测的桩：记下每一发 CDP 命令，并按给定序列回答"你现在 visible 吗"。
  // 用**序列**而不是布尔，是因为闸门补完那一招会再问一次，测试要能分别描述
  // "补完就翻成 visible"和"补完还是 hidden"这两种真实结果。
  function observeCdp(tid, visibilityAnswers) {
    const wc = pm.tabs.get(tid).webContents;
    wc.debugger.attached = true;
    const cmds = [];
    let n = 0;
    wc.debugger.sendCommand = async (method, params) => {
      cmds.push({ method, params });
      const expr = params && params.expression;
      // 两条 Runtime.evaluate 靠**长度**分开：可见性探针是一句极短的读，页面指纹
      // 探针是一大段 JS。刻意不去匹配实现里的具体语句 —— 改措辞会让这个桩静默
      // 走错分支，而分错的样子（指纹那边拿到字符串）会直接让断言变红。
      const isVisProbe = method === 'Runtime.evaluate' && typeof expr === 'string' && expr.length < 200;
      if (isVisProbe) {
        const v = visibilityAnswers[Math.min(n, visibilityAnswers.length - 1)];
        n += 1;
        return v === undefined || v === null ? {} : { result: { value: v } };
      }
      // 指纹探针给 __err 形状 → _pageProbe 降级成 null（不然会走 canvas 三采样白等）。
      return { result: { value: { __err: 'stub' } } };
    };
    const methods = () => cmds.map((c) => c.method);
    const emulate = () => cmds.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled');
    return { wc, cmds, methods, emulate };
  }

  const bgTab = (sessionId, url = 'https://a.example/compose') => {
    pm.newTab('https://human.example/');                  // 人眼前那一页（挡住新页被自动顶上去）
    return pm.newTab(url, { show: false, group: agentGroup(sessionId) });
  };

  it('PM-51 量到 hidden → 补一发焦点伪造；补完翻成 visible 就放行', async () => {
    const tid = bgTab('s8');
    const cdp = observeCdp(tid, ['hidden', 'visible']);
    const activeBefore = pm.activeTab;
    const gate = await pm._inputGate('click', 'e:1', tid);
    expect(gate, '补完已经收得到 → 放行（这正是"第二个 agent 点不动"的解）').toBe(null);
    expect(cdp.emulate(), '一次就翻转，是实测出来的').toHaveLength(1);
    expect(cdp.emulate()[0].params.enabled).toBe(true);
    expect(pm.activeTab, '这一招不许动 activeTab').toBe(activeBefore);
  });

  it('PM-52 补完还是 hidden → 只补一次，然后如实失败、输入事件一发都不投', async () => {
    const tid = bgTab('s9');
    const cdp = observeCdp(tid, ['hidden']);
    const res = await pm.executeAction('click', 'e:1', {}, tid);
    expect(res.success).toBe(false);
    expect(res.input_blocked, '调用方熟悉的旧回执是 success:true，必须有个字段点破"什么都没发生"').toBe(true);
    expect(res.visibility).toBe('hidden');
    expect(res.error).toContain('was NOT delivered');
    expect(res.error).toContain('Nothing was clicked or typed');
    expect(cdp.methods().filter((m) => m.startsWith('Input.')), '被丢弃的事件不算失败，伪装成功才算失败').toEqual([]);
    expect(cdp.emulate(), '补一次是修，补两次是抖').toHaveLength(1);
  });

  it('PM-53 本来就 visible → 一发伪造都不发（常规路径不多做事）', async () => {
    const tid = bgTab('s10');
    const cdp = observeCdp(tid, ['visible']);
    expect(await pm._inputGate('type', 'e:1', tid)).toBe(null);
    expect(cdp.emulate()).toHaveLength(0);
    expect(cdp.methods().filter((m) => m === 'Runtime.evaluate'), '问一次就够').toHaveLength(1);
  });

  it('PM-54 只读与控制类动作连可见性都不问（upload 走 JS 路径，hidden 照样收）', async () => {
    const tid = bgTab('s11');
    const cdp = observeCdp(tid, ['hidden']);
    for (const a of ['get_value', 'reload', 'repaint', 'upload', 'scroll']) {
      expect(await pm._inputGate(a, 'e:1', tid), a + ' 不该被闸').toBe(null);
    }
    expect(cdp.cmds, '一次都不该有').toEqual([]);
  });

  it('PM-55 量不到（没有 CDP 会话）→ 放行，而且一次命令都不试', async () => {
    const tid = bgTab('s12');
    const wc = pm.tabs.get(tid).webContents;
    const tried = [];
    wc.debugger.sendCommand = async (m) => { tried.push(m); return {}; };
    wc.debugger.attached = false;          // 没有 debugger 会话的那条老路的形状
    expect(await pm._visibilityState(tid)).toBe(null);
    expect(await pm._inputGate('click', 'e:1', tid), '观测能力不足不许反过来让动作失败').toBe(null);
    expect(tried, '没 attach 就一次都不发（发出去只会拿到一个 reject）').toEqual([]);
    expect(wc.debugger.attached, '也不许由闸门去补 attach —— 那是别人的生命周期').toBe(false);
  });

  it('PM-56 AI_BROWSER_INPUT_FOCUS=0 关掉的是"那一招"，不是"别说谎"', async () => {
    process.env.AI_BROWSER_INPUT_FOCUS = '0';
    try {
      const tid = bgTab('s13');
      const cdp = observeCdp(tid, ['hidden']);
      const gate = await pm._inputGate('click', 'e:1', tid);
      expect(cdp.emulate(), '开关关掉就不补').toHaveLength(0);
      expect(gate && gate.success, '但退路退到如实报错，不是退到假装成功').toBe(false);
      expect(gate.input_blocked).toBe(true);
      expect(gate.error).toContain('AI_BROWSER_INPUT_FOCUS=0');
    } finally {
      delete process.env.AI_BROWSER_INPUT_FOCUS;
    }
  });

  it('PM-57 AI_BROWSER_FOCUS=never 下这一招根本做不到：一发的伪造都不许有，文案点名原因', async () => {
    // 这一格是同一次实测里顺手证伪的：never 时**连活动页都是 hidden**，模拟输入
    // 一样被丢，而旧回执照样写 success:true。那种组合结构性地做不到，只能说。
    process.env.AI_BROWSER_FOCUS = 'never';
    try {
      const tid = bgTab('s14');
      const cdp = observeCdp(tid, ['hidden']);
      const gate = await pm._inputGate('click', 'e:1', tid);
      expect(cdp.emulate(), '策略不许伪造，伪造一发都不许发').toHaveLength(0);
      expect(gate.success).toBe(false);
      expect(gate.error).toContain('AI_BROWSER_FOCUS=never');
    } finally {
      delete process.env.AI_BROWSER_FOCUS;
    }
  });

  it('PM-58 闸门只动那一页的焦点态：z 序、窗口、别人的页一概不碰', async () => {
    const human = 1;
    const tid = bgTab('s15');
    const cdp = observeCdp(tid, ['hidden', 'visible']);
    const other = observeCdp(human, ['visible']);
    const win = pm.window;
    const hits = [];
    win.setTopBrowserView = () => hits.push('setTopBrowserView');
    win.addBrowserView = () => hits.push('addBrowserView');
    win.getBrowserViews = () => [pm.tabs.get(human), pm.tabs.get(tid)];
    win.show = () => hits.push('show');
    win.focus = () => hits.push('focus');
    const origSetBounds = win.setBounds || (() => {});
    win.setBounds = () => { hits.push('setBounds'); origSetBounds(); };

    expect(await pm._inputGate('click', 'e:1', tid)).toBe(null);
    expect(hits, '置顶 / 重挂 / 显示窗口 / 抢焦点 / 重排 全部实测无效，闸门一律不许做').toEqual([]);
    expect(other.emulate(), '只补要操作的那一页，不把八页各伪造一遍').toHaveLength(0);
    expect(pm.activeTab).toBe(human);
    expect(pm.tabs.get(tid).webContents.isMuted(), '也不许顺手改静音归属').toBe(true);
  });

  it('PM-59 可见性探针的三种降级形状一律返回 null，绝不抛', async () => {
    const tid = bgTab('s16');
    expect(await pm._visibilityState(9866), '拿不到视图').toBe(null);
    const wc = pm.tabs.get(tid).webContents;
    wc.debugger.attached = true;
    wc.debugger.sendCommand = async () => { throw new Error('CDP 会话断了'); };
    expect(await pm._visibilityState(tid), '命令 reject').toBe(null);
    wc.debugger.sendCommand = async () => ({ result: { value: { nested: 'not a string' } } });
    expect(await pm._visibilityState(tid), '回来的不是字符串（页面被改写过 / 拿到了别的东西）').toBe(null);
    wc.debugger.sendCommand = async () => { throw new Error('不该被等到'); };
    expect(await pm._inputGate('click', 'e:1', tid), '探针坏了也要放行').toBe(null);
  });
});

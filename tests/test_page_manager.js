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
    setWindowOpenHandler() {}
    setAudioMuted() {}
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
    expect(pm._isCoveredByOtherTab(back), '隐藏窗口时维持旧路径（CDP 优先，background_ws B1/B3 靠这个）').toBe(false);
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

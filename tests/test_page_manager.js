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
    setBackgroundColor() {}
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

// PageManager 只用窗口的 getContentBounds / contentView / on / emit。
function freshWindow() {
  const win = new EventEmitter();
  win.getContentBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 });
  win.contentView = { addChildView: () => {}, removeChildView: () => {} };
  win.setBrowserView = () => {};
  win.removeBrowserView = () => {};
  win.isDestroyed = () => false;
  win.isFocused = () => true;
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

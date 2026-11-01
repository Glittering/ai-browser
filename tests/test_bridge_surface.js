// tests/test_bridge_surface.js — 攻击用例：页面的主世界里不许有"往主进程灌数据"的出口。
//
// 背景：`bridge.cjs` 通过 contextBridge 把 `sendTree` / `sendDiff` 暴露给页面主世界，
// 主进程 `ai:tree` 只按 `payload.id` 取 pending，不校验 sender。页面脚本于是可以
// 循环 id=1..N 灌一棵假树，撞上在途的 getTree 就能让 agent 读到伪造的页面
// （例如把"确认支付"换成"取消"）。实测 requestId 是 `++` 自增，可枚举。
//
// 本文件用 vm 真加载 bridge.cjs（stub 掉 electron 与三个兄弟模块），
// 断言暴露面是白名单 —— 不是 grep 源码，而是拿到运行时真实的 exposeInMainWorld 入参。
//
// 2026-11-01 加了第二层判据：**这个桥只对自家 document 打开**。之前
// exposeInMainWorld 无条件执行，等于给每一个站点页面的 window 都挂上
// `__ai_browser__`（实测百度页面可见）。B6/B7 钉住这条，href 由用例注入。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WINDOW_OPEN_SHIM_SOURCE } from '../src/main/window_open_shim_source.js';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'src/preload/bridge.cjs');

// 桥的暴露判据（shouldExposeBridge）直接 require 这份实现，测试与生产同一套代码：
// 在这里重写一遍判据等于没测。
const identityUtil = require('../src/shared/browser_identity.cjs');

/** 在 vm 里加载 bridge.cjs，返回它暴露出去的对象与所有 IPC send 记录。 */
function loadBridge(opts = {}) {
  const href = opts.href || 'file:///app/src/renderer/download.html';
  const env = opts.env || {};
  const code = readFileSync(BRIDGE, 'utf8');
  const exposed = {};
  const sends = [];
  const listeners = [];
  const ipcRenderer = {
    send(channel, payload) { sends.push({ channel, payload }); },
    invoke: async () => ({ found: false }),
    on(channel, fn) { listeners.push({ channel, fn }); },
  };
  const stubs = {
    electron: { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer },
    './extractor.cjs': { extractTree: () => ({ id: 'root', children: [] }), extractPageContext: () => ({}) },
    './actions.cjs': { executeAction: () => ({}) },
    './watcher.cjs': { startTracking: () => {} },
    '../shared/browser_identity.cjs': identityUtil,
  };
  const sandbox = {
    require: (id) => {
      if (id in stubs) return stubs[id];
      throw new Error('unexpected require: ' + id);
    },
    document: { readyState: 'loading', addEventListener() {} },
    // URL 是全局构造器，真实 preload 的 world 里有；vm 里必须补，否则
    // shouldExposeBridge 的 new URL(href) 直接抛错、判据永远走 false 分支。
    URL: (0, URL),
    process: { env },
    window: { addEventListener() {}, location: { href } },
    setTimeout: () => 0,
    console: { error() {}, log() {} },
    module: { exports: {} },
    exports: {},
  };
  vm.runInNewContext(code, sandbox, { filename: BRIDGE });
  return { exposed, sends, listeners };
}

describe('preload 暴露面白名单', () => {
  it('B1 vm 里真的加载到了 bridge 并捕获到 exposeInMainWorld（否则下面的断言是空转）', () => {
    const { exposed } = loadBridge();
    expect(Object.keys(exposed), '没捕获到 __ai_browser__ —— 加载方式坏了，下面的白名单测试无意义')
      .toContain('__ai_browser__');
  });

  it('B2 页面主世界拿不到 sendTree / sendDiff（灌假数据的两条路必须消失）', () => {
    const { exposed } = loadBridge();
    const surface = exposed.__ai_browser__ || {};
    expect(surface.sendTree, '页面仍可直接写 ai:tree —— agent 会被喂假树').toBeUndefined();
    expect(surface.sendDiff, '页面仍可直接写 ai:diff —— agent 会收到伪造的 dom_change').toBeUndefined();
  });

  it('B3 暴露面只有白名单里的键（新增暴露必须显式改这条测试）', () => {
    const { exposed } = loadBridge();
    expect(Object.keys(exposed.__ai_browser__ || {}).sort()).toEqual(['dl', 'windowOpenBridge']);
  });

  it('B4 dl 三件套仍然是函数（自己的下载页要用）', () => {
    const { exposed } = loadBridge();
    const dl = exposed.__ai_browser__.dl || {};
    for (const k of ['record', 'open', 'reveal']) expect(typeof dl[k], `dl.${k}`).toBe('function');
  });

  it('B5 bridge 自己仍然会回树（走的是内部 IPC，不是暴露给页面的函数）', () => {
    const { listeners, sends } = loadBridge();
    const extract = listeners.find((l) => l.channel === 'ai:extract');
    expect(extract, '找不到 ai:extract 监听 —— 页面读树会整条断掉').toBeTruthy();
    extract.fn({}, { id: 7 });
    const tree = sends.find((s) => s.channel === 'ai:tree');
    expect(tree, 'ai:extract 没有回发 ai:tree').toBeTruthy();
    expect(tree.payload.id).toBe(7);
  });

  it('B6 站点页面拿不到桥：window 上不许出现 __ai_browser__', () => {
    const { exposed } = loadBridge({ href: 'https://www.baidu.com/' });
    expect(exposed.__ai_browser__, '桥暴露到了站点主世界 —— 扫一遍 window 就能认出我们')
      .toBeUndefined();
  });

  it('B7 桥只在两种 document 上打开：自家界面页 / 显式开了 popup 垫片的域', () => {
    const own = loadBridge({ href: 'file:///app/src/renderer/download.html' });
    expect(own.exposed.__ai_browser__, '自家下载页必须拿得到 dl 通道').toBeTruthy();

    const gated = loadBridge({
      href: 'https://course.example.chaoxing.com/x',
      env: { AI_BROWSER_POPUP_SHIM: 'chaoxing.com' },
    });
    expect(gated.exposed.__ai_browser__, '垫片本体在主 world，它发的消息要走这个桥')
      .toBeTruthy();

    const notMine = loadBridge({
      href: 'https://www.baidu.com/',
      env: { AI_BROWSER_POPUP_SHIM: 'chaoxing.com' },
    });
    expect(notMine.exposed.__ai_browser__, '白名单外的站点仍然被贴了我们的标记').toBeUndefined();

    const all = loadBridge({ href: 'https://any.site/', env: { AI_BROWSER_POPUP_SHIM: 'on' } });
    expect(all.exposed.__ai_browser__, 'AI_BROWSER_POPUP_SHIM=on 应当全域开（含桥）').toBeTruthy();
  });

  // B8 是**跨文件**的契约测试：垫片源码（main/window_open_shim_source.js）真的调用
  // bridge.cjs 暴露的函数，再看落到 IPC 上的 payload。两岸各自单测都能绿，
  // 但参数少一个、键名写错、features 没带 —— 只有这么串起来才看得见。
  // （2026-10-19 那次"垫片注入了但 window.open 返回 null"就是少传一个参数被
  //  catch 吞掉；2026-11-02 丢 features 同理：任何一侧单测都不报错，症状却在用户面前。）
  it('B8 垫片 → 桥 → IPC：payload 形状与 features 传递是通的', () => {
    const { exposed, sends } = loadBridge({
      href: 'https://course.example.chaoxing.com/x',
      env: { AI_BROWSER_POPUP_SHIM: 'on' },
    });
    const bridge = exposed.__ai_browser__;
    expect(bridge, 'B8 依赖桥真的被暴露').toBeTruthy();

    const shimWindow = { __ai_browser__: bridge };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'URL', WINDOW_OPEN_SHIM_SOURCE)(
      shimWindow, { baseURI: 'https://course.example.chaoxing.com/x' }, URL);

    const w = shimWindow.open('', '_blank', 'width=420,height=520,left=10,top=20');
    expect(w, '桥存在时 window.open 不许返回 null（返回 null = 站点以为弹窗被拦）').toBeTruthy();

    const open = sends.find((s) => s.channel === 'ai:window_open');
    expect(open, 'window.open 没有落到 ai:window_open').toBeTruthy();
    expect(open.payload.features).toBe('width=420,height=520,left=10,top=20');
    expect(typeof open.payload.token).toBe('string');
    expect(open.payload.name).toBe('_blank');

    // 不写第三参数时也不能留 undefined：主进程判据拿的是字符串，
    // 而 contextBridge 两岸参数数量不一致会抛错（历史症状 = 静默 null）。
    sends.length = 0;
    shimWindow.open('https://course.example.chaoxing.com/y', '_blank');
    const plain = sends.find((s) => s.channel === 'ai:window_open');
    expect(plain.payload.features, '缺省特性串必须是空串，不是 undefined').toBe('');

    sends.length = 0;
    w.location = 'https://course.example.chaoxing.com/target';
    const nav = sends.find((s) => s.channel === 'ai:window_open_nav');
    expect(nav, 'location 赋值没有落到 ai:window_open_nav').toBeTruthy();
    expect(nav.payload.url).toBe('https://course.example.chaoxing.com/target');
    expect(nav.payload.features, 'nav 不该带 features（特性只在 open 这一发有效）').toBeUndefined();
  });
});

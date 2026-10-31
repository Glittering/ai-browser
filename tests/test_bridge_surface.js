// tests/test_bridge_surface.js — 攻击用例：页面的主世界里不许有"往主进程灌数据"的出口。
//
// 背景：`bridge.cjs` 通过 contextBridge 把 `sendTree` / `sendDiff` 暴露给页面主世界，
// 主进程 `ai:tree` 只按 `payload.id` 取 pending，不校验 sender。页面脚本于是可以
// 循环 id=1..N 灌一棵假树，撞上在途的 getTree 就能让 agent 读到伪造的页面
// （例如把"确认支付"换成"取消"）。实测 requestId 是 `++` 自增，可枚举。
//
// 本文件用 vm 真加载 bridge.cjs（stub 掉 electron 与三个兄弟模块），
// 断言暴露面是白名单 —— 不是 grep 源码，而是拿到运行时真实的 exposeInMainWorld 入参。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'src/preload/bridge.cjs');

/** 在 vm 里加载 bridge.cjs，返回它暴露出去的对象与所有 IPC send 记录。 */
function loadBridge() {
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
  };
  const sandbox = {
    require: (id) => {
      if (id in stubs) return stubs[id];
      throw new Error('unexpected require: ' + id);
    },
    document: { readyState: 'loading', addEventListener() {} },
    window: { addEventListener() {} },
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
});

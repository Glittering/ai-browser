// tests/test_ws_handlers.js — WebSocket JSON-RPC handler unit tests.
// Starts a real WS server on an ephemeral port (0) with a Mock PageManager,
// so ui.wait / ui.scroll / the evaluate guard / error codes can be tested in
// isolation without a running Electron instance or the real 9223 port.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import vm from 'node:vm';
import { startWSServer } from '../src/main/ws_server.js';

let server;
let client;
let pm;

// Behavior closures — swapped per test; the recorders are fixed.
let evaluateImpl = () => undefined;
let getTreeImpl = () => ({ tree: {}, context: { modals: [], messages: [] } });
// ui.network_get 的替身：默认成功；个别用例让它抛带 rpcCode 的错误，
// 用来验证"业务失败回精确错误码、且不会被记成成功"（AUDIT-2026-10-30 P2-1）。
let networkGetImpl = async () => ({ id: 'n1', request: { url: 'https://x/' } });

function makePageManager() {
  const obj = {
    _evaluateCalls: [],
    evaluate: async (js) => { obj._evaluateCalls.push(js); return evaluateImpl(js); },
    getTree: async () => getTreeImpl(),
    executeAction: async () => ({ success: true }),
    navigate: async () => true,
    newTab: () => 1,
    closeTab: () => true,
    setActive: () => true,
    listTabs: () => [],
    getFocused: async () => null,
    getNetworkBody: async () => null,
    networkGet: async (...a) => networkGetImpl(...a),
    networkList: () => ({ requests: [], pagination: {} }),
    registerClient: () => {},
    unregisterClient: () => {},
    addSubscription: () => {},
    removeSubscription: () => {},
  };
  return obj;
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// JSON-RPC request, resolves with the full response object.
function rpc(ws, method, params = {}, id = Date.now(), waitMs = 6000) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('rpc timeout')); }, waitMs);
  });
}

// Send a raw string (not valid JSON) and resolve with the first response.
function rawSend(ws, text) {
  return new Promise((resolve) => {
    const onMsg = (data) => { ws.off('message', onMsg); resolve(JSON.parse(data.toString())); };
    ws.on('message', onMsg);
    ws.send(text);
  });
}

beforeAll(async () => {
  pm = makePageManager();
  server = startWSServer(pm, 0);
  await server.ready;
  client = await openClient(server.port);
});

afterAll(async () => {
  client.close();
  server.close();
});

describe('ws_server transport security', () => {
  it('W-SEC-1 binds loopback only — the unauthenticated JSON-RPC port must never listen on 0.0.0.0', () => {
    // Regression: new WebSocketServer({ port }) defaults to 0.0.0.0, which
    // exposed the browser and its persisted sessions to the whole LAN.
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(server.host);
  });
});

describe('ws_server ui.wait', () => {
  it('W-1 text_contains succeeds when the body text matches', async () => {
    pm._evaluateCalls = [];
    evaluateImpl = async () => 'hello world from the page';
    getTreeImpl = () => ({ tree: {}, context: { modals: [] } });

    const res = await rpc(client, 'ui.wait', { condition: 'text_contains', text: 'world', timeout_ms: 500 });
    expect(res.result.satisfied).toBe(true);
    expect(pm._evaluateCalls.length).toBeGreaterThan(0); // polled via evaluate
  });

  it('W-2 modal_appeared succeeds when a modal is in context', async () => {
    getTreeImpl = () => ({ tree: {}, context: { modals: [{ header: 'modal' }] } });
    const res = await rpc(client, 'ui.wait', { condition: 'modal_appeared', timeout_ms: 500 });
    expect(res.result.satisfied).toBe(true);
  });

  it('W-3 times out with satisfied=false when the condition never holds', async () => {
    pm._evaluateCalls = [];
    evaluateImpl = async () => 'aaa';
    getTreeImpl = () => ({ tree: {}, context: { modals: [] } });

    const start = Date.now();
    const res = await rpc(client, 'ui.wait', { condition: 'text_contains', text: 'zzz', timeout_ms: 600 });
    expect(res.result.satisfied).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000); // bounded by the timeout, not hanging
  });
});

describe('ws_server ui.scroll', () => {
  it('S-1 JSON-encodes the target so a malicious payload cannot break out of the JS', async () => {
    // A computed access payload would terminate a single-quoted JS literal if
    // the target were naively interpolated. It must stay inside the generated
    // double-quoted argument and cause no side effect.
    const evil = "x']);globalThis.PWNED=1;//";
    pm._evaluateCalls = [];
    evaluateImpl = async (js) => {
      const sandbox = {
        document: { querySelectorAll: () => [], getAttribute: () => null },
        window: { scrollBy: () => {} },
      };
      vm.createContext(sandbox);
      try { return vm.runInContext(js, sandbox) ?? {}; }
      catch (e) { return { __threw: e.message }; } // a break-out would throw a SyntaxError
    };

    const res = await rpc(client, 'ui.scroll', { target: evil, direction: 'down', amount: 500 });
    // JSON-encoded (double-quoted) form is present, not single-quote interpolation.
    expect(pm._evaluateCalls[0]).toContain(JSON.stringify(evil));
    // The generated JS parsed and ran cleanly, so the payload did not break out.
    expect(res.result.__threw).toBeUndefined();
    expect(res.result).toMatchObject({ ok: false }); // no [data-ai-id] matched -> healthy failure
  });
});

describe('ws_server ui.evaluate guard', () => {
  it('E-1 rejects an over-length script with -32602 without calling evaluate', async () => {
    pm._evaluateCalls = [];
    evaluateImpl = async () => 'SHOULD NOT RUN';
    const res = await rpc(client, 'ui.evaluate', { js: 'x'.repeat(5001) });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain('char limit');
    expect(pm._evaluateCalls.length).toBe(0);
  });

  it('E-2 rejects a Node-identifier script with -32602 without calling evaluate', async () => {
    pm._evaluateCalls = [];
    evaluateImpl = async () => 'SHOULD NOT RUN';
    const res = await rpc(client, 'ui.evaluate', { js: 'process.env' });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/Node-specific identifier/);
    expect(pm._evaluateCalls.length).toBe(0);
  });

  it('E-3 passes a benign script through to evaluate', async () => {
    pm._evaluateCalls = [];
    evaluateImpl = async () => 42;
    const res = await rpc(client, 'ui.evaluate', { js: '1 + 1' });
    expect(res.result.value).toBe(42);
    expect(pm._evaluateCalls).toEqual(['1 + 1']);
  });
});

describe('ws_server error codes', () => {
  it('ERR-1 malformed JSON returns parse error -32700', async () => {
    const res = await rawSend(client, '{ not valid json');
    expect(res.error.code).toBe(-32700);
  });

  it('ERR-2 unknown method returns -32601', async () => {
    const res = await rpc(client, 'ui.no_such_method', {});
    expect(res.error.code).toBe(-32601);
  });
});// ---------------------------------------------------------------------------
// RPC 边界保底：ui.act 必须在有限时间内返回
//
// 实测依据（tools/_oneoff/blocked_renderer_probe.cjs，页面跑 while 循环占住主线程
// 120s，单项上限 45s）：ui.get_tree 5s 报错、ui.evaluate 10s 报错，
// 而 ui.act **45 秒仍无回包**。原因是它内部 await 的 CDP 命令（Input.dispatchMouseEvent
// 等）要等渲染进程 ack，主线程被占住时 ack 永不来。
//
// 后果不是"慢"：agent 的工具调用永久悬挂、整个会话死掉，且没有任何错误可看。
//
// 这一组用 mock PageManager 复现"永不返回的 executeAction"，断言客户端**能收到回包**。
// 可证伪：把 ws_server 里 ui.act 的 withDeadline 拆掉，这些测试会全部挂到超时变红。
// ---------------------------------------------------------------------------
describe('ws_server ui.act deadline (RPC boundary)', () => {
  // pm 在 beforeAll 里才赋值，而 describe 体在收集阶段执行 —— 必须惰性读取。
  let realExecuteAction = null;
  beforeAll(() => { realExecuteAction = pm.executeAction; });
  afterEach(() => { if (realExecuteAction) pm.executeAction = realExecuteAction; });

  // JSON-RPC 的 params.params 才是 act 的参数体。多套一层是这组测试第一次写错的地方：
  // {params:{params:{timeout_ms}}} 会让 actionDeadlineMs 读不到值，于是测试因为
  // 错误的原因通过（动作自己在 3.2s 返回了，跟预算够不够无关）。
  const actCall = (action, actParams, id, waitMs) =>
    rpc(client, 'ui.act', { action, target: 'x', params: actParams || {} }, id, waitMs);

  it('ACT-DL-1: 默认预算（不传 timeout_ms）也能兜住永不返回的动作', async () => {
    pm.executeAction = () => new Promise(() => {});   // 模拟被占住的主线程
    const t0 = Date.now();
    // 默认预算 15s，超过 vitest 全局 testTimeout(15s)，必须显式放宽。
    const res = await actCall('click', {}, Date.now(), 30000);
    expect(Date.now() - t0).toBeGreaterThan(10000);   // 确认真的等到了默认预算
    expect(res.result).toMatchObject({ success: false, timed_out: true });
    expect(res.result.error).toMatch(/timeout after 15000ms/);
    expect(res.result.error).toMatch(/partially applied/);
  }, 30000);

  it('ACT-DL-2: 正常动作不受影响，success 原样透出', async () => {
    pm.executeAction = async () => ({ success: true, clicked_via: 'cdp' });
    const res = await actCall('click', {});
    expect(res.result).toEqual({ success: true, clicked_via: 'cdp' });
  });

  it('ACT-DL-3: 动作自己的失败原样透出，不会被误判成超时', async () => {
    pm.executeAction = async () => ({ success: false, error: 'target_not_found' });
    const res = await actCall('click', {});
    expect(res.result).toEqual({ success: false, error: 'target_not_found' });
    expect(res.result.timed_out).toBeUndefined();
  });

  it('ACT-DL-4: 非超时的抛错仍走 JSON-RPC error 通道', async () => {
    pm.executeAction = async () => { throw new Error('Tab not found'); };
    const res = await actCall('click', {});
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(-32603);
  });

  it('ACT-DL-5: type 的长文本拿到更长预算 —— 3.2s 的动作不许被 15s 默认值卡死', async () => {
    // 500 字 × 60ms ≈ 30s，预算必须 >30s。用一个 3.2s 才返回的假动作验证"预算够"，
    // 不用真等 30s。若预算退回默认 15s，这条仍会过（3.2<15）—— 所以真正的保证由
    // DL-011 在算术层断言，这里只验证参数确实传到了预算函数。
    pm.executeAction = () => new Promise((r) => setTimeout(() => r({ success: true }), 3200));
    const res = await actCall('type', { text: 'x'.repeat(500) }, Date.now(), 20000);
    expect(res.result).toEqual({ success: true });
  });

  it('ACT-DL-6: 调用方可用 timeout_ms 显式缩短预算（逃生门）', async () => {
    pm.executeAction = () => new Promise(() => {});
    const t0 = Date.now();
    const res = await actCall('click', { timeout_ms: 1200 });
    expect(res.result.timed_out).toBe(true);
    expect(res.result.error).toMatch(/timeout after 1200ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// ui.set_active_tab 的回执契约
//
// 2026-10-19 实测事故：index.js 为了挂「地址栏跟随」给 setActive 套了包装却忘了
// return，`const ok = pageManager.setActive(...)` 拿到 undefined，
// JSON.stringify({ok: undefined}) 直接把键删掉 —— agent 收到 `{}`。
// tab 其实切成功了（list_tabs 显示 active 已变），所以只看行为发现不了，
// 只有盯回执才能发现。这里把回执形状锁死。
// ---------------------------------------------------------------------------
describe('ws_server ui.set_active_tab 回执', () => {
  it('TAB-1: 切换成功回 {ok:true} —— agent 必须能拿到确认，不能是空对象', async () => {
    pm.setActive = () => true;
    const res = await rpc(client, 'ui.set_active_tab', { tab: 1 });
    expect(res.result).toEqual({ ok: true });
  });

  it('TAB-2: tab 不存在回 {ok:false} + 原因，不能回空对象也不能报错', async () => {
    pm.setActive = () => false;
    const res = await rpc(client, 'ui.set_active_tab', { tab: 99 });
    // 2026-10-28：多了 error 字段。理由：只回 {ok:false} 时调用方分不清
    // "tab 没了" 和 "切了但没生效"，而这两件事的下一步动作完全不同。
    // 仍然是**结果**而不是 JSON-RPC error —— 这是"这次没切成"，不是"调用不合法"。
    expect(res.result.ok).toBe(false);
    expect(res.result.error).toBe('no-such-tab');
    expect(res.error).toBeUndefined();
  });

  it('TAB-3: 经过 index.js 同款包装后 ok 仍在（本事故的回归点）', async () => {
    // 复刻 index.js 的调用方式：用 wrapSetActive 挂钩子，钩子里不做任何特别的事。
    const { wrapSetActive } = await import('../src/shared/tab_hooks.js');
    const fake = {
      tabs: new Map([[1, {}], [2, {}]]),
      activeTab: 1,
      setActive(tabId) {
        if (!this.tabs.has(tabId)) return false;
        this.activeTab = tabId;
        return true;
      },
    };
    wrapSetActive(fake, () => {});
    pm.setActive = fake.setActive.bind(fake);
    const res = await rpc(client, 'ui.set_active_tab', { tab: 2 });
    expect(res.result).toEqual({ ok: true });   // 事故时是 {}
    expect(fake.activeTab).toBe(2);             // 副作用也照常发生
  });
});

// ---------------------------------------------------------------------------
// ui.wait 抗导航抖动（AUDIT-2026-10-30 P1-3）
//
// 事故形态：`browse_wait({cond:'text_contains'})` 最常见的用法就在 navigate 之后，
// 而那几百毫秒正是文档在换、preload 的 ai:extract 会超时（getTree 硬 5s reject）
// 的窗口。此前 poll() 里没有 try/catch，整条等待直接变成 -32603 internal error，
// 调用方看到"内部错误"就会**重试导航**，把已经成功的导航重做一遍。
// ---------------------------------------------------------------------------
describe('ws_server ui.wait 抗导航抖动', () => {
  it('W-4: 单次抽取抛错不算等待失败 —— 继续轮询直到条件成立', async () => {
    let calls = 0;
    getTreeImpl = () => {
      calls++;
      // 前两轮模拟"文档正在换"：tree 抽取超时
      if (calls <= 2) throw new Error('getTree timeout');
      return { tree: {}, context: { modals: [{ header: 'ready' }] } };
    };

    const res = await rpc(client, 'ui.wait', { condition: 'modal_appeared', timeout_ms: 5000 });
    expect(res.error, '不许再变成 JSON-RPC internal error').toBeUndefined();
    expect(res.result.satisfied, '抖动过去之后必须能等到').toBe(true);
    expect(res.result.attempts, '至少要试到第 3 轮才可能成功').toBeGreaterThanOrEqual(3);
  });

  it('W-5: 一直读不到时 satisfied=false，但要如实带 last_error（不许静默）', async () => {
    getTreeImpl = () => { throw new Error('getTree timeout'); };

    const res = await rpc(client, 'ui.wait', { condition: 'modal_appeared', timeout_ms: 600 });
    expect(res.error).toBeUndefined();
    expect(res.result.satisfied).toBe(false);
    expect(res.result.attempts).toBeGreaterThan(0);
    expect(res.result.last_error, '读失败的原因必须能看见').toContain('getTree timeout');
  });

  it('W-6: timeout_ms 有下限（传 1ms 也至少轮询一次，不是空转即返回）', async () => {
    getTreeImpl = () => ({ tree: {}, context: { modals: [] } });
    const started = Date.now();
    const res = await rpc(client, 'ui.wait', { condition: 'modal_appeared', timeout_ms: 1 });
    expect(res.result.satisfied).toBe(false);
    expect(res.result.attempts).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// 错误路径不许撒谎（AUDIT-2026-10-30 P2-1 / P2-2）
// ---------------------------------------------------------------------------
describe('ws_server 错误路径', () => {
  it('N-1: network_get 的业务失败回精确 rpcCode，且不返回 result', async () => {
    networkGetImpl = async () => {
      const e = new Error('body evicted (retention limit)');
      e.rpcCode = -32010;
      e.data = { id: 'n1', reason: 'evicted' };
      throw e;
    };
    const res = await rpc(client, 'ui.network_get', { network_id: 'n1' });
    expect(res.error && res.error.code, 'rpcCode 必须原样回给调用方').toBe(-32010);
    expect(res.error.message).toContain('body evicted');
    expect(res.error.data).toMatchObject({ reason: 'evicted' });
    expect(res.result, '失败时不许同时给 result').toBeUndefined();
  });

  it('N-2: network_get 的普通异常回 -32603（兜底不许吞）', async () => {
    networkGetImpl = async () => { throw new Error('n2-plain-boom'); };
    const res = await rpc(client, 'ui.network_get', { network_id: 'n1' });
    expect(res.error.code).toBe(-32603);
    expect(res.result).toBeUndefined();
  });

  // P2-1 的核心判据：**错误调用不许被记成成功**。
  // 旧实现在 case 内部自带 try/catch，catch 里 send 完继续往下走，最后落到统一的
  // noteCall(..., true) —— 于是错误日志里"崩溃前最近调用"把一次失败的 network_get
  // 记成成功，事后排查会被这条假证据带偏。这里直接读那条 error 条目自带的
  // recent_calls 上下文（recordError 会把最近 20 次调用钉在里面）。
  it('N-3: network_get 普通异常必须落盘为 ws_error，且 recent_calls 里那次调用记为 error', async () => {
    networkGetImpl = async () => { throw new Error('n3-exploded'); };
    const res = await rpc(client, 'ui.network_get', { network_id: 'n3' });
    expect(res.error.code).toBe(-32603);

    const listed = await rpc(client, 'ui.errors', { kind: 'ws_error', limit: 200 });
    const items = (listed.result && listed.result.items) || [];
    const entry = items.find(
      (e) => e.method === 'ui.network_get' && String(e.message || '').includes('n3-exploded')
    );
    expect(entry, '普通异常必须能在 ui.errors 里查到（旧实现在内层 catch 里吞掉了）').toBeTruthy();

    const call = (entry.recent_calls || []).find((c) => c && c.method === 'ui.network_get');
    expect(call, 'recent_calls 里应当有这次调用').toBeTruthy();
    expect(
      String(call.outcome),
      '这次调用必须以错误收尾 —— 记成 true 就是日志在撒谎（AUDIT P2-1）'
    ).toMatch(/error/i);
  });

  it('S-2: scroll 拿不到页面回执时不许报 ok（evaluate 返回 undefined）', async () => {
    evaluateImpl = async () => undefined;
    const res = await rpc(client, 'ui.scroll', { direction: 'down', amount: 10 });
    expect(res.result.ok, '没有回执就不能说成功').toBe(false);
    expect(res.result.error).toMatch(/no result/);
  });
});

describe('ws_server ui.wait 参数校验', () => {
  it('W-4 未知 condition 立刻 -32602，不白等到 timeout', async () => {
    const t0 = Date.now();
    const res = await rpc(client, 'ui.wait', { condition: 'text-contaíns', text: 'x', timeout_ms: 30000 });
    const cost = Date.now() - t0;
    expect(res.error && res.error.code).toBe(-32602);
    expect(cost, '不应该进入轮询（此前会白抽 120s）').toBeLessThan(2000);
  });

  it('W-5 text_contains 不再每轮抽整棵树（只调 evaluate）', async () => {
    pm._evaluateCalls = [];
    let treeCalls = 0;
    getTreeImpl = () => { treeCalls++; return { tree: {}, context: { modals: [] } }; };
    evaluateImpl = async () => 'nothing here';
    await rpc(client, 'ui.wait', { condition: 'text_contains', text: 'zzz', timeout_ms: 700 });
    expect(treeCalls, 'text 条件不该为了等一句话去建整棵树').toBe(0);
    expect(pm._evaluateCalls.length).toBeGreaterThan(0);
  });
});

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

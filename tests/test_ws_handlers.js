// tests/test_ws_handlers.js — WebSocket JSON-RPC handler unit tests.
// Starts a real WS server on an ephemeral port (0) with a Mock PageManager,
// so ui.wait / ui.scroll / the evaluate guard / error codes can be tested in
// isolation without a running Electron instance or the real 9223 port.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
function rpc(ws, method, params = {}, id = Date.now()) {
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
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('rpc timeout')); }, 6000);
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
  client = await openClient(server.port);
});

afterAll(async () => {
  client.close();
  server.close();
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
});
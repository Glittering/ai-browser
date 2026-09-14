// tests/test_mcp_ws.js — Persistent WS JSON-RPC client (mcp_ws.js) unit tests.
// A real WS server (ws_server.js) is started on an ephemeral port with a mock
// PageManager; the mock counts registerClient() calls to observe how many
// physical connections the client opens. Confirms connection reuse, correct
// routing under concurrency, error mapping, and reconnect after a close.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWSServer } from '../src/main/ws_server.js';
import { createWsClient } from '../src/main/mcp_ws.js';

function makeServer(pm) {
  const server = startWSServer(pm, 0);
  return { server, port: server.port };
}

function makeMockPM() {
  let n = 0;
  const obj = {
    _connections: 0,
    _evalValue: 0,
    registerClient: () => { obj._connections += 1; },
    unregisterClient: () => {},
    addSubscription: () => {},
    removeSubscription: () => {},
    evaluate: async (js) => { obj._evalValue += 1; return obj._evalValue; },
    getTree: async () => ({ tree: {}, context: {} }),
    executeAction: async () => ({ success: true }),
    navigate: async () => true,
    newTab: () => 1,
    closeTab: () => true,
    setActive: () => true,
    listTabs: () => [],
    getFocused: async () => null,
    getNetworkBody: async () => null,
    _evalCount: () => n, // unused placeholder kept out of hot path
  };
  return obj;
}

// A pageManager whose evaluate never resolves — used to force a client timeout.
function makeHangingPM() {
  return {
    _connections: 0,
    registerClient: function () { this._connections += 1; },
    unregisterClient: () => {},
    addSubscription: () => {},
    removeSubscription: () => {},
    evaluate: () => new Promise(() => {}),
    getTree: async () => ({ tree: {}, context: {} }),
    executeAction: async () => ({ success: true }),
    navigate: async () => true,
    newTab: () => 1,
    closeTab: () => true,
    setActive: () => true,
    listTabs: () => [],
    getFocused: async () => null,
    getNetworkBody: async () => null,
  };
}

let pm;
let serverInfo;
let client;

beforeAll(async () => {
  pm = makeMockPM();
  serverInfo = makeServer(pm);
  client = createWsClient({ url: `ws://127.0.0.1:${serverInfo.port}`, timeout: 800 });
});

afterAll(() => {
  try { client.close(); } catch (_e) {}
  try { serverInfo.server.close(); } catch (_e) {}
});

describe('mcp_ws persistent client', () => {
  it('MW-1 reuses a single connection across sequential calls', async () => {
    await client.call('ui.evaluate', { js: 'a' });
    await client.call('ui.evaluate', { js: 'b' });
    await client.call('ui.evaluate', { js: 'c' });
    expect(pm._connections).toBe(1); // one WebSocket served all three
    expect(pm._evalValue).toBe(3);
  });

  it('MW-2 resolves concurrent calls to their own responses on one connection', async () => {
    const before = pm._connections;
    const results = await Promise.all(
      [1, 2, 3].map((i) => client.call('ui.evaluate', { js: `x${i}` }))
    );
    // Each returns { value: n } with distinct, incrementing n in arrival order.
    const values = results.map((r) => r.value);
    expect(new Set(values).size).toBe(3);
    expect(pm._connections).toBe(before); // no new physical connection was opened
  });

  it('MW-3 maps a server error to a rejected promise', async () => {
    await expect(client.call('ui.no_such_method', {})).rejects.toThrow('Method not found');
  });

  it('MW-4 reconnects after the underlying socket is closed', async () => {
    const before = pm._connections;
    client.close();
    await client.call('ui.evaluate', { js: 'again' });
    expect(pm._connections).toBe(before + 1); // fresh connection for the next call
  });
});

describe('mcp_ws timeout', () => {
  it('MW-5 rejects with WS timeout when the server never responds', async () => {
    const hpm = makeHangingPM();
    const { server, port } = makeServer(hpm);
    const slow = createWsClient({ url: `ws://127.0.0.1:${port}`, timeout: 200 });
    try {
      await expect(slow.call('ui.evaluate', { js: 'hang' })).rejects.toThrow('WS timeout');
    } finally {
      slow.close();
      server.close();
    }
  });
});
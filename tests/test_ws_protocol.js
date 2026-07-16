// tests/test_ws_protocol.js — WebSocket JSON-RPC server integration tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:9223';
let ws;

// Helper: send JSON-RPC request and wait for response
function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (e) {
        // Skip non-JSON or mismatched responses
      }
    }

    ws.on('message', handler);
    ws.send(request);
  });
}

describe('WebSocket Protocol', () => {
  beforeAll(async () => {
    // Connect to WS server (must be running)
    ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    });
  });

  afterAll(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  it('WS-001: connects successfully', () => {
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('WS-002: get_tree returns valid tree with context', async () => {
    const response = await rpcCall('ui.get_tree', {});
    expect(response.result).toBeDefined();
    expect(response.result.tree).toBeDefined();
    expect(response.result.tree.id).toBeDefined();
    expect(response.result.tree.role).toBeDefined();
    // v3: also has page context
    expect(response.result.context).toBeDefined();
    expect(response.result.context.page_type).toBeDefined();
  });

  it('WS-003: response id matches request', async () => {
    const response = await rpcCall('ui.get_tree', {});
    expect(response.id).toBeDefined();
  });

  it('WS-005: invalid action target returns error', async () => {
    const response = await rpcCall('ui.act', {
      action: 'click',
      target: 'e:nonexistent-99999',
    });
    expect(response.result.success).toBe(false);
  });

  it('WS-010: invalid method returns JSON-RPC error', async () => {
    const response = await rpcCall('ui.invalid_method', {});
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
  });
});
// tests/test_act_params.js — act 参数形状归一（纯函数 + WS 契约）
//
// 实测事故：同一句 act，写成 {action,target,text} 失败（"type called with empty
// text"），写成 {action,target,params:{text}} 成功 —— 顶层字段被静默丢掉。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { hoistActParams } from '../src/shared/act_params.cjs';
import { startWSServer } from '../src/main/ws_server.js';

describe('hoistActParams()', () => {
  it('AP-1: canonical nested params pass through untouched', () => {
    const r = hoistActParams({ action: 'type', target: 'e:1', params: { text: 'hi' } });
    expect(r.params).toEqual({ text: 'hi' });
    expect(r.hoisted).toEqual([]);
  });

  it('AP-2: flat action params are hoisted instead of dropped', () => {
    const r = hoistActParams({ action: 'type', target: 'e:1', text: 'hi', timeout_ms: 5000 });
    expect(r.params.text).toBe('hi');
    expect(r.params.timeout_ms).toBe(5000);
    expect(r.hoisted.sort()).toEqual(['text', 'timeout_ms']);
  });

  it('AP-3: nested wins when both are present (no silent overwrite)', () => {
    const r = hoistActParams({ action: 'type', text: 'flat', params: { text: 'nested' } });
    expect(r.params.text).toBe('nested');
    expect(r.hoisted).toEqual([]);
  });

  it('AP-4: from_x/from_y become from:{x,y} for coordinate drags', () => {
    const r = hoistActParams({ action: 'drag', from_x: 30, from_y: 100 });
    expect(r.params.from).toEqual({ x: 30, y: 100 });
    expect(r.hoisted).toContain('from(x,y)');
  });

  it('AP-5: half a coordinate is NOT turned into (x, 0)', () => {
    const r = hoistActParams({ action: 'drag', from_x: 30 });
    expect(r.params.from).toBeUndefined();
  });

  it('AP-6: non-action keys are not smuggled in (tab/action/target stay at the RPC layer)', () => {
    const r = hoistActParams({ action: 'click', target: 'e:1', tab: 3, keep_tab: true });
    expect(r.params.tab).toBeUndefined();
    expect(r.params.keep_tab).toBe(true);
  });

  it('AP-7: no params at all is not an error', () => {
    expect(hoistActParams({ action: 'press' }).params).toEqual({});
    expect(hoistActParams(undefined).params).toEqual({});
  });
});

// ---- WS 契约：平铺参数真的到达 executeAction，且回执说明被提升 ----
let server, client, calls;

function makePageManager() {
  return {
    executeAction: async (action, target, params) => { calls.push({ action, target, params }); return { success: true, filled: params.text || '' }; },
    evaluate: async () => null,
    getTree: async () => ({ tree: {}, context: {} }),
    navigate: async () => ({ ok: true }),
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
}

function rpc(ws, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.off('message', onMsg); resolve(msg); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('rpc timeout')); }, 5000);
  });
}

describe('ui.act — flat vs nested params over WS', () => {
  beforeAll(async () => {
    calls = [];
    server = startWSServer(makePageManager(), 0);
    await server.ready;
    client = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  });
  afterAll(() => { client.close(); server.close(); });

  it('AP-8: flat text reaches the action, and the receipt says it was hoisted', async () => {
    calls.length = 0;
    const res = await rpc(client, 'ui.act', { action: 'type', target: 'e:1', text: 'hello' });
    expect(calls[0].params.text).toBe('hello');
    expect(res.result.filled).toBe('hello');
    expect(res.result.params_hoisted).toContain('text');
  });

  it('AP-9: nested params still work and report no hoisting', async () => {
    calls.length = 0;
    const res = await rpc(client, 'ui.act', { action: 'type', target: 'e:1', params: { text: 'nested' } }, 2);
    expect(calls[0].params.text).toBe('nested');
    expect(res.result.params_hoisted).toBeUndefined();
  });
});

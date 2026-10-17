// tests/test_evaluate_frame_ref.js — ui.evaluate 的 OOPIF 显式路由契约
// 坑：OOPIF 路由原先只认 JS 里的字面量 data-ai-id="axf-..."。调用方用字符串
// 拼接构造选择器时路由静默失效，顶层执行对 iframe 内元素返回 null —— 调用方
// 会以为"元素不存在"。现在 ws 层把 params.frame_ref 显式传给 pageManager。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startWSServer } from '../src/main/ws_server.js';

let server;
let client;
let lastEvalArgs = null;

function makePageManager() {
  return {
    // 记录完整调用参数（含第三参 opts），这是本测试的观测点。
    evaluate: async (js, tabId, opts) => { lastEvalArgs = { js, tabId, opts }; return 'ok'; },
    getTree: async () => ({ tree: {}, context: {} }),
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

describe('ui.evaluate frame_ref contract', () => {
  beforeAll(async () => {
    server = startWSServer(makePageManager(), 0);
    await server.ready;
    client = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  });
  afterAll(() => { client.close(); server.close(); });

  it('EFR-1: params.frame_ref reaches pageManager.evaluate as opts.frameRef', async () => {
    lastEvalArgs = null;
    const res = await rpc(client, 'ui.evaluate', {
      js: '(function(){return document.title})()',
      frame_ref: 'axf-3-1',
    });
    expect(res.result.value).toBe('ok');
    expect(lastEvalArgs).toBeTruthy();
    expect(lastEvalArgs.opts).toEqual({ frameRef: 'axf-3-1' });
  });

  it('EFR-2: without frame_ref, opts carries no frameRef (literal route still active)', async () => {
    lastEvalArgs = null;
    await rpc(client, 'ui.evaluate', { js: '(function(){return 1})()' }, 2);
    expect(lastEvalArgs.opts).toEqual({ frameRef: undefined });
  });
});

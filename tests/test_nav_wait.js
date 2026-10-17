// tests/test_nav_wait.js — P2-3：navigate 的完成信号
//
// 事故：SPA（带 markdown 高亮的编辑器）永不 fire load，而 navigate 走 loadURL
// （did-finish-load 才 resolve）。页面明明可用，调用方却等到 30s 超时，之后所有
// act/evaluate 连锁超时，结论变成"编辑器坏了"。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { normalizeWaitUntil, LEVELS, DEFAULT_LEVEL } from '../src/shared/nav_wait.cjs';
import { startWSServer } from '../src/main/ws_server.js';

describe('normalizeWaitUntil()', () => {
  it('NW-1: default is domcontentloaded, never load', () => {
    expect(normalizeWaitUntil(undefined).value).toBe('domcontentloaded');
    expect(normalizeWaitUntil(null).value).toBe('domcontentloaded');
    expect(normalizeWaitUntil('').value).toBe('domcontentloaded');
    expect(DEFAULT_LEVEL).toBe('domcontentloaded');
  });

  it('NW-2: the three levels are accepted verbatim', () => {
    for (const v of LEVELS) expect(normalizeWaitUntil(v).value).toBe(v);
  });

  it('NW-3: spelling variants normalize instead of erroring', () => {
    expect(normalizeWaitUntil('DOMContentLoaded').value).toBe('domcontentloaded');
    expect(normalizeWaitUntil('dom-ready').value).toBe('domcontentloaded');
    expect(normalizeWaitUntil('dom_content_loaded').value).toBe('domcontentloaded');
    expect(normalizeWaitUntil('Load').value).toBe('load');
  });

  it('NW-4: unknown values error and list the valid ones (no silent fallback)', () => {
    const r = normalizeWaitUntil('networkidle');
    expect(r.error).toBeTruthy();
    expect(r.error).toContain('commit');
    expect(r.error).toContain('domcontentloaded');
    expect(r.error).toContain('load');
    expect(r.value).toBeUndefined();
  });
});

// ---- WS 契约：wait_until 必须真的传到 pageManager.navigate ----
let server;
let client;
let lastNavArgs = null;

function makePageManager() {
  return {
    navigate: async (url, tabId, opts) => { lastNavArgs = { url, tabId, opts }; return { ok: true, waited_for: opts && opts.waitUntil }; },
    evaluate: async () => null,
    getTree: async () => ({ tree: {}, context: {} }),
    executeAction: async () => ({ success: true }),
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

describe('ui.navigate wait_until contract', () => {
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

  it('NW-5: params.wait_until reaches pageManager.navigate as opts.waitUntil', async () => {
    lastNavArgs = null;
    const res = await rpc(client, 'ui.navigate', { url: 'https://example.com', wait_until: 'commit' });
    expect(res.result.ok).toBe(true);
    expect(lastNavArgs.opts).toEqual({ waitUntil: 'commit' });
    expect(res.result.waited_for).toBe('commit');
  });

  it('NW-6: omitting it leaves the decision to page_manager (no invented default at the transport layer)', async () => {
    lastNavArgs = null;
    await rpc(client, 'ui.navigate', { url: 'https://example.com' }, 2);
    expect(lastNavArgs.opts).toEqual({ waitUntil: undefined });
  });
});

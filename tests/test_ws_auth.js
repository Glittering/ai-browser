// tests/test_ws_auth.js — 攻击用例：浏览器内的页面不能连上控制面。
//
// 背景（2026-10-31 实测）：一个普通 http 页面里 `new WebSocket('ws://127.0.0.1:9223')`
// 能连上，随后 `ui.list_tabs` 枚举出全部标签页、`ui.evaluate` 读到**另一个源**的正文。
// 浏览器在 WebSocket 握手时**必发** `Origin`，而 Node 客户端（`ws` 包 / 全局 WebSocket）
// **不发**（实测）。所以判据可以很硬：握手带 Origin 一律拒。
//
// 本文件只测传输层判据，不测"页面里能不能跑脚本"——那需要真 Electron，见 e2e/security_ws.cjs。
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startWSServer } from '../src/main/ws_server.js';

const pm = {
  registerClient() {}, unregisterClient() {},
  addSubscription() {}, removeSubscription() {},
  listTabs: () => [],
};

/** 起一个服务器，返回 { srv, port, close }。opts 透传给 startWSServer。 */
async function boot(opts) {
  const srv = startWSServer(pm, 0, null, opts);
  await srv.ready;
  return { srv, port: srv.port, close: () => srv.close() };
}

/**
 * 连接并记录结局：
 *   { opened, closed, code, reason, replied }
 * 判定必须看 close code —— 只看"有没有报错"会把"服务没起来"误判成"被拦住了"。
 */
function attempt(port, headers = {}, { rpc = false, waitMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const out = { opened: false, closed: false, code: null, reason: '', replied: false };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers && Object.keys(headers).length ? { headers } : undefined);
    let timer;
    const finish = () => { clearTimeout(timer); try { ws.terminate(); } catch {} resolve(out); };
    ws.on('open', () => {
      out.opened = true;
      if (rpc) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ui.list_tabs', params: {} }));
    });
    ws.on('message', () => { out.replied = true; });
    ws.on('close', (code, reason) => { out.closed = true; out.code = code; out.reason = String(reason || ''); finish(); });
    ws.on('error', () => { /* 用 close/超时判定，不把 error 当结论 */ });
    timer = setTimeout(finish, waitMs);
  });
}

let cur;
afterEach(() => { if (cur) { cur.close(); cur = null; } });

describe('WS 握手：页面（带 Origin）必须被拒', () => {
  it('A1 任意站点 Origin 的连接被关闭，close code = 1008', async () => {
    cur = await boot();
    const r = await attempt(cur.port, { Origin: 'http://evil.example' });
    expect(r.closed, '连接没有在 1.2s 内被关闭 —— 页面对着控制面还开着').toBe(true);
    expect(r.code, 'close code 应该是 1008（policy violation）').toBe(1008);
    expect(r.replied, '被拒的连接不许收到任何 RPC 回执').toBe(false);
  });

  it('A2 即便是"看起来像自己"的 Origin 也拒（不猜白名单）', async () => {
    cur = await boot();
    for (const o of ['http://127.0.0.1:9223', 'http://localhost', 'file://', 'null']) {
      const r = await attempt(cur.port, { Origin: o });
      expect(r.closed, `Origin=${o} 没被关闭`).toBe(true);
      expect(r.code, `Origin=${o} 的 close code`).toBe(1008);
    }
  });

  it('A3 带 Origin 且发 RPC 的连接，一个字节的回执都收不到', async () => {
    cur = await boot();
    const r = await attempt(cur.port, { Origin: 'https://evil.example' }, { rpc: true, waitMs: 1500 });
    expect(r.replied).toBe(false);
  });

  it('A4 无 Origin 的 Node 客户端正常可用（不误伤 MCP / CLI / e2e）', async () => {
    cur = await boot();
    const r = await attempt(cur.port, {}, { rpc: true });
    expect(r.opened, '无 Origin 的连接必须能建立').toBe(true);
    expect(r.replied, '无 Origin 的连接必须能拿到 RPC 回执').toBe(true);
  });

  it('A5 阳性对照：显式放开 Origin 时，同一个请求能成功 —— 证明拦截器真的在起作用', async () => {
    // 这条是给 A1/A2/A3 做对照的：如果拦截器根本没接上，A1 会因为"连不上"
    // 而变绿，而 A5 也必须变绿才说明"开关确实生效"。反过来，A5 红了就说明
    // allowOrigin 选项没被实现（拦的是别的东西）。
    cur = await boot({ allowOrigin: true });
    const r = await attempt(cur.port, { Origin: 'http://evil.example' }, { rpc: true });
    expect(r.opened, 'allowOrigin 下应当能连上').toBe(true);
    expect(r.replied, 'allowOrigin 下应当能拿到 RPC 回执').toBe(true);
  });
});

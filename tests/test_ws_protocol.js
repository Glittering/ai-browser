// tests/test_ws_protocol.js — WebSocket JSON-RPC server integration tests
//
// 这些用例需要一个活着的 ai-browser（Electron + WS server）。原先的写法是
// "探测 9223，探测不到就静默 skip" —— 结果是**同一个 `npm test` 会有两种结果**：
// 机器上恰好开着 ai-browser 时 239 passed，没开时 234 passed + 5 skipped。
// 而"绿"到底代表跑过还是跳过了，从输出里看不出来 —— 这正是最不该有的模糊验证。
//
// 现在：9223 上有实例就直接用（沿用原行为）；没有就**自己拉一个**临时实例
// （独立端口 + 独立 profile），跑完回收。只有连拉都拉不起来时才 skip，
// 并且**明确打印**为什么跳过 —— 不再有静默降级。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTERNAL_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
let PORT = EXTERNAL_PORT;
let ws;

function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// 在模块加载期完成"找到或拉起一个实例"，因为 it.skipIf 需要在注册时就拿到结论。
let spawned = null;
let skipReason = null;
try {
  if (await probePort(EXTERNAL_PORT)) {
    PORT = EXTERNAL_PORT;
    console.log(`[ws-protocol] 复用 ${EXTERNAL_PORT} 上已有的 ai-browser 实例`);
  } else {
    const p = await freePort();
    const env = { ...process.env, AI_BROWSER_PORT: String(p), AI_BROWSER_USER_DATA: `/tmp/ai-browser-unit-${p}` };
    // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动 —— 不起窗口、不监听 WS。
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: 'ignore', detached: true, env });
    child.unref();
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 40000) {
      if (await probePort(p, 400)) { up = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (up) {
      spawned = child;
      PORT = p;
      console.log(`[ws-protocol] 自起临时实例 @ ${p}（独立 profile，跑完回收）`);
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* ignore */ } }
      skipReason = '无法拉起 Electron 实例（无图形会话？）';
    }
  }
} catch (e) {
  skipReason = String((e && e.message) || e);
}

const wsAvailable = !skipReason;
if (!wsAvailable) {
  console.warn(`[ws-protocol] 跳过该套件：${skipReason}。`);
  console.warn('[ws-protocol] 想跑它：先 `npm start` 起一个实例，或确认本机能启动 Electron。');
}

const WS_URL = `ws://localhost:${PORT}`;

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
    if (!wsAvailable) return;
    ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    });
  }, 10000);

  afterAll(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    if (spawned) {
      try { process.kill(-spawned.pid, 'SIGTERM'); } catch { try { spawned.kill(); } catch { /* ignore */ } }
    }
  });

  it.skipIf(!wsAvailable)('WS-001: connects successfully', () => {
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it.skipIf(!wsAvailable)('WS-002: get_tree returns valid tree with context', async () => {
    const response = await rpcCall('ui.get_tree', {});
    expect(response.result).toBeDefined();
    expect(response.result.tree).toBeDefined();
    expect(response.result.tree.id).toBeDefined();
    expect(response.result.tree.role).toBeDefined();
    expect(response.result.context).toBeDefined();
    expect(response.result.context.session).toBeDefined();
  });

  it.skipIf(!wsAvailable)('WS-003: response id matches request', async () => {
    const response = await rpcCall('ui.get_tree', {});
    expect(response.id).toBeDefined();
  });

  it.skipIf(!wsAvailable)('WS-005: invalid action target returns error', async () => {
    const response = await rpcCall('ui.act', {
      action: 'click',
      target: 'e:nonexistent-99999',
    });
    expect(response.result.success).toBe(false);
  });

  it.skipIf(!wsAvailable)('WS-010: invalid method returns JSON-RPC error', async () => {
    const response = await rpcCall('ui.invalid_method', {});
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
  });
});

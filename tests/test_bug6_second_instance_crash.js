// tests/test_bug6_second_instance_crash.js — Bug 6 的行为判据。
//
// 用户反馈"经常跑两个 ai-browser，关一个还会崩溃"。核对后根因有两条，这里覆盖
// 能独立复现的第二条：
//   ① 单实例锁在 macOS 打包版被豁免 → 两个实例并存（真机黑盒验证过：打包版
//      第二个进程不退出；修好后 code=0 干净退出。见 tools/_oneoff/
//      verify_single_instance.cjs，只能在真 Electron 里跑）。
//   ② **WS 端口被占时原来一声不响**：ws_server 把 ready 的 rejection
//      `.catch(() => {})` 吞掉了。实测两个实例（不同 userData、同端口）时，
//      第二个照常起窗口，但没有 WS、没有一行报错、error.jsonl 只有 boot ——
//      用户看到"窗口开着但什么都不响应"，agent 连不上，两边都查不出原因。
//
// ② 可以在 vitest 里真复现（ws_server 不依赖 electron），所以判据落在行为上：
// 占住端口 → 起服务 → 断言 ready 必须 reject、code 必须是 EADDRINUSE、
// 并且**必须落盘**一条 ws_listen_error。原来的 grep 型判据对这条链路毫无覆盖。
import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initErrorLog, recentErrors } from '../src/main/error_log.js';
import { startWSServer } from '../src/main/ws_server.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-bug6-'));
initErrorLog({ dir: TMP, meta: { test: 'bug6' } });

/** 占住一个端口，返回 { port, close }。 */
function occupy() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

describe('Bug 6 — WS 监听失败必须是可观测的失败，不是静默', () => {
  it('B6-01: 端口被占用时 ready 必须 reject，且 code=EADDRINUSE', async () => {
    const held = await occupy();
    const srv = startWSServer(null, held.port, null);
    await expect(srv.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(srv.listenError).toBeTruthy();
    expect(srv.listenError.code).toBe('EADDRINUSE');
    await held.close();
  });

  it('B6-02: 监听失败必须落盘 ws_listen_error（Finder 启动时 stderr 是黑洞）', async () => {
    const held = await occupy();
    const srv = startWSServer(null, held.port, null);
    await srv.ready.catch(() => {});
    const found = recentErrors(20, 'ws_listen_error');
    expect(found.items.length, '没有任何 ws_listen_error 记录 —— 又是一次静默失败').toBeGreaterThan(0);
    const last = found.items[found.items.length - 1];
    expect(last.code).toBe('EADDRINUSE');
    expect(String(last.note || '')).toMatch(/收不到|入口/);
    await held.close();
  });

  it('B6-03: 端口可用时 ready 正常 resolve，listenError 为 null（阳性对照）', async () => {
    const srv = startWSServer(null, 0, null);
    await srv.ready;
    expect(srv.listenError).toBe(null);
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.host).toBe('127.0.0.1');   // 只绑回环：协议本身没有鉴权
    srv.close();
  });

  it('B6-04: 关掉之后端口真的释放，同端口能再起来', async () => {
    const first = startWSServer(null, 0, null);
    await first.ready;
    const p = first.port;
    first.close();
    for (let i = 0; i < 40; i++) {
      const probe = startWSServer(null, p, null);
      try {
        await probe.ready;
        expect(probe.port).toBe(p);
        probe.close();
        return;
      } catch (_) {
        probe.close();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('端口没有释放：' + p);
  });
});

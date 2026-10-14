// tests/test_e2e_harness.js — e2e 启动保障的单测（纯 Node，不起 Electron）
//
// 覆盖两件事，都是 2026-10-15 实测出来的真实缺口：
//   1. assertIdentity —— 套件能不能发现"自己连上的不是自己起的进程"
//   2. waitPortFree   —— 端口预检是"真等到空闲"还是"探一次算数"
//
// 每个"不应该发生"的断言都配了阳性对照，否则观测一失效就永远绿。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const harness = require('../e2e/_harness.cjs');
const runner = require('../e2e/run_all.cjs');

// 假 browser：只实现 assertIdentity 用到的 call()
function fakeBrowser(pid) {
  return { call: async () => ({ result: pid === null ? null : { pid, started_at: 1 } }) };
}

// 捕获 process.exit：记录码并抛异常，模拟"进程真的停下来了"
async function captureExit(fn) {
  const orig = process.exit;
  let code = null;
  process.exit = (c) => { code = c; const e = new Error('__exit__'); e.exitCode = c; throw e; };
  try { await fn(); } catch (e) { if (e && e.message !== '__exit__') throw e; }
  finally { process.exit = orig; }
  return code;
}

describe('assertIdentity — 连的是不是自己起的进程', () => {
  it('HR-01 pid 一致时正常返回，不退出', async () => {
    const code = await captureExit(() => harness.assertIdentity(fakeBrowser(4242), { pid: 4242 }, 't'));
    expect(code).toBeNull();
  });

  it('HR-02 pid 不一致 → 必须退出且码非零（不再继续往下测）', async () => {
    const code = await captureExit(() => harness.assertIdentity(fakeBrowser(1), { pid: 4242 }, 't'));
    expect(code).toBe(4);
  });

  it('HR-02b 服务端压根没回 server_info（冒牌/老版本）→ 同样拦下', async () => {
    // 冒牌实验里最现实的形态：对方根本不认识 ui.server_info。
    const code = await captureExit(() => harness.assertIdentity(fakeBrowser(null), { pid: 4242 }, 't'));
    expect(code).toBe(4);
  });

  it('HR-02c 阳性对照：pid 一致时上面那套退出机制不会误触发', async () => {
    // 没有这条，HR-02 可能只是"captureExit 永远返回 4"。
    const code = await captureExit(() => harness.assertIdentity(fakeBrowser(7), { pid: 7 }, 't'));
    expect(code).toBeNull();
    expect(code === 4).toBe(false);
  });

  it('HR-02d 拿不到子进程 pid 时抛错（不是静默放行）', async () => {
    await expect(harness.assertIdentity(fakeBrowser(1), null, 't')).rejects.toThrow(/pid/);
  });
});

describe('waitPortFree — 等到端口真的空闲', () => {
  function listen() {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
  }

  it('HR-03 端口被占时返回 false（而不是当成空闲）', async () => {
    const { srv, port } = await listen();
    try {
      expect(await harness.waitPortFree(port, 1200)).toBe(false);
    } finally { srv.close(); }
  });

  it('HR-03b 阳性对照：端口空闲时返回 true（证明 HR-03 的 false 来自占用）', async () => {
    const { srv, port } = await listen();
    srv.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await harness.waitPortFree(port, 3000)).toBe(true);
  });

  it('HR-04 占用中途释放 → 最终返回 true（会等，不是一探了事）', async () => {
    const { srv, port } = await listen();
    setTimeout(() => srv.close(), 400);
    expect(await harness.waitPortFree(port, 5000)).toBe(true);
  });
});

describe('run_all 摘要解析 — 不靠 shell grep', () => {
  // 当初的假红就是栽在这：正则 `==== .* PASS=` 要求两个空格，
  // `==== PASS=28 FAIL=0 ====`（view）和 `[modeldiff] PASS=12 FAIL=0`
  // 一概匹配不到，被我读成了"套件崩溃"。现在只认数字对，格式无关。
  it('HR-05 三种真实摘要格式都能解析出来', () => {
    expect(runner.parseVerdict('==== smoke PASS=31 FAIL=0 ====')).toEqual({ pass: 31, fail: 0 });
    expect(runner.parseVerdict('==== PASS=28 FAIL=0 ====')).toEqual({ pass: 28, fail: 0 });
    expect(runner.parseVerdict('[modeldiff] PASS=12 FAIL=0')).toEqual({ pass: 12, fail: 0 });
  });

  it('HR-05b 取最后一个摘要（前面可能有分段小计）', () => {
    const out = 'x PASS=1 FAIL=0\n==== value PASS=15 FAIL=0 ====';
    expect(runner.parseVerdict(out)).toEqual({ pass: 15, fail: 0 });
  });

  it('HR-05c 没有摘要时返回 null —— 而且 null 必须被当成"未知"而不是"通过"', () => {
    expect(runner.parseVerdict('some crash output')).toBeNull();
  });

  it('HR-05d 阳性对照：解析真的会报错(不是恒返回 null 蒙混)', () => {
    expect(runner.parseVerdict('==== x PASS=3 FAIL=1 ====').fail).toBe(1);
  });
});

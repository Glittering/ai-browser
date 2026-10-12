// tests/test_deadline.js — shared/deadline.js 的单元测试
//
// 这个文件防的是一类**不崩、不报错、只是让 agent 永久等待**的缺陷。实测依据：
// tools/_oneoff/blocked_renderer_probe.cjs（页面跑 while 循环占住主线程 120s）——
//     ui.get_tree      5006ms  ERR   （本来就有超时）
//     ui.evaluate     10012ms  ERR   （CDP 5s + preload 回落 5s）
//     ui.act          45001ms  无回包 ← 唯一真挂的一条，也就是这个文件存在的原因
//
// 因此测试分两组：① withDeadline 的机制（能拦住永不返回的 promise）；② 预算算术
// （不能把合法长操作误杀）。第二组更重要：一个把 500 字 type 卡死在 15s 的超时，
// 比没有超时更糟 —— 它会把"慢但正确"变成"失败"。
import { describe, it, expect, vi } from 'vitest';
import {
  withDeadline,
  actionDeadlineMs,
  DEFAULT_ACTION_DEADLINE_MS,
  MAX_ACTION_DEADLINE_MS,
} from '../src/shared/deadline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('withDeadline', () => {
  it('DL-001: 永不返回的 promise 会被拦下，并带上 __deadline 标记', async () => {
    const never = new Promise(() => {}); // 模拟被占住主线程的 CDP 命令
    await expect(withDeadline(never, 30, 'action:click')).rejects.toMatchObject({
      __deadline: true,
    });
  });

  it('DL-002: 超时错误信息里带标签与预算 —— agent 要能看出是哪个动作、等了多久', async () => {
    const never = new Promise(() => {});
    await expect(withDeadline(never, 40, 'action:type')).rejects.toThrow(/action:type timeout after 40ms/);
  });

  it('DL-003: 正常 resolve 的值原样透出，不被包装', async () => {
    await expect(withDeadline(Promise.resolve({ success: true }), 1000, 'x'))
      .resolves.toEqual({ success: true });
  });

  it('DL-004: 正常 reject 的错误原样抛出（不是所有失败都该算超时）', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'x'))
      .rejects.toThrow('boom');
  });

  it('DL-005: 超时后原 promise 迟到拒绝，不会变成 unhandled rejection', async () => {
    // 这一条不是洁癖：超时之后底层 CDP 命令仍可能失败，若没人接住，Node 会打
    // unhandledRejection 警告，严重时直接终止进程 —— 那会让"加超时"这个修复
    // 本身变成新的崩溃源。
    const late = (async () => { await sleep(40); throw new Error('late failure'); })();
    await expect(withDeadline(late, 10, 'x')).rejects.toMatchObject({ __deadline: true });
    await sleep(80); // 给迟到拒绝一个机会冒出来
    expect(true).toBe(true);
  });

  it('DL-006: 没有孤儿定时器 —— 快速完成时定时器必须被清掉', async () => {
    // 用假定时器数 setTimeout/clearTimeout 的配对。清不干净会让每个 act 都留一个
    // 定时器，长会话下堆积。
    const spies = { set: 0, clear: 0 };
    const origSet = global.setTimeout;
    const origClear = global.clearTimeout;
    global.setTimeout = ((...a) => { spies.set++; return origSet(...a); });
    global.clearTimeout = ((...a) => { spies.clear++; return origClear(...a); });
    try {
      await withDeadline(Promise.resolve(1), 100000, 'x');
      expect(spies.set).toBe(1);
      expect(spies.clear).toBe(1);
    } finally {
      global.setTimeout = origSet;
      global.clearTimeout = origClear;
    }
  });
});

describe('actionDeadlineMs —— 预算不得误杀合法长操作', () => {
  it('DL-010: 无参数动作给基线值', () => {
    expect(actionDeadlineMs('click', {})).toBe(DEFAULT_ACTION_DEADLINE_MS);
    expect(actionDeadlineMs('get_value', {})).toBe(DEFAULT_ACTION_DEADLINE_MS);
  });

  it('DL-011: type 的预算随字数增长（每字 interval_ms，默认 60ms）', () => {
    const short = actionDeadlineMs('type', { text: 'ab' });
    const long = actionDeadlineMs('type', { text: 'x'.repeat(500) });
    expect(short).toBe(DEFAULT_ACTION_DEADLINE_MS);          // 短文本走基线
    expect(long).toBeGreaterThan(500 * 60);                  // 500 字 ≈ 30s，必须放行
  });

  it('DL-012: type 尊重调用方自报的 interval_ms', () => {
    const fast = actionDeadlineMs('type', { text: 'x'.repeat(100), interval_ms: 5 });
    const slow = actionDeadlineMs('type', { text: 'x'.repeat(100), interval_ms: 200 });
    expect(slow).toBeGreaterThan(fast);
  });

  it('DL-013: drag 的预算覆盖 duration_ms + steps', () => {
    const d = actionDeadlineMs('drag', { duration_ms: 5000, steps: 20 });
    expect(d).toBeGreaterThanOrEqual(5000 + 20 * 40);
  });

  it('DL-014: press 的预算覆盖 repeat × interval_ms', () => {
    const p = actionDeadlineMs('press', { repeat: 50, interval_ms: 100 });
    expect(p).toBeGreaterThanOrEqual(50 * 100);
  });

  it('DL-015: clear 比 click 宽松（要走编辑器状态提交与回读校验）', () => {
    expect(actionDeadlineMs('clear', {})).toBeGreaterThan(actionDeadlineMs('click', {}));
  });

  it('DL-016: 单次调用 timeout_ms 是最高优先级的逃生门', () => {
    expect(actionDeadlineMs('type', { text: 'x'.repeat(999), timeout_ms: 1234 })).toBe(1234);
  });

  it('DL-017: env AI_BROWSER_ACTION_TIMEOUT_MS 覆盖推算值，但低于单次调用', () => {
    const prev = process.env.AI_BROWSER_ACTION_TIMEOUT_MS;
    process.env.AI_BROWSER_ACTION_TIMEOUT_MS = '7000';
    try {
      expect(actionDeadlineMs('type', { text: 'x'.repeat(999) })).toBe(7000);
      expect(actionDeadlineMs('type', { text: 'x'.repeat(999), timeout_ms: 9000 })).toBe(9000);
    } finally {
      if (prev === undefined) delete process.env.AI_BROWSER_ACTION_TIMEOUT_MS;
      else process.env.AI_BROWSER_ACTION_TIMEOUT_MS = prev;
    }
  });

  it('DL-017b: 任何来源的超时都有 1s 下限 —— 防 Agent 传个 timeout_ms:5 把自己卡死', () => {
    // 这不是代码缺陷而是契约：低于 1 秒的预算连一次 CDP 往返都不够，给了必然误杀。
    expect(actionDeadlineMs('click', { timeout_ms: 5 })).toBe(1000);
    // 0 / 非数字按"未指定"处理，回落默认值 —— 不解释成"不要超时"，
    // 因为"关掉超时"正是这个修复要消灭的东西。
    expect(actionDeadlineMs('click', { timeout_ms: 0 })).toBe(DEFAULT_ACTION_DEADLINE_MS);
    expect(actionDeadlineMs('click', { timeout_ms: 'soon' })).toBe(DEFAULT_ACTION_DEADLINE_MS);
  });

  it('DL-018: 预算被夹在 [1s, MAX] 之间 —— 非法输入不能产出 0 或 Infinity', () => {
    expect(actionDeadlineMs('type', { text: 'x'.repeat(1e6), interval_ms: 1e9 })).toBe(MAX_ACTION_DEADLINE_MS);
    expect(actionDeadlineMs('type', { timeout_ms: -5 })).toBe(DEFAULT_ACTION_DEADLINE_MS);
    expect(actionDeadlineMs('type', { timeout_ms: 'abc' })).toBe(DEFAULT_ACTION_DEADLINE_MS);
    expect(actionDeadlineMs('type', { text: null, interval_ms: null })).toBe(DEFAULT_ACTION_DEADLINE_MS);
  });

  it('DL-019: 表格驱动 —— 一组代表性动作的预算都要在合理区间', () => {
    const rows = [
      ['click', {}, 15000],
      ['hover', {}, 15000],
      ['type', { text: 'hello' }, 15000],
      ['setContent', { text: 'a'.repeat(1000) }, 60000],
      ['clear', {}, 20000],
      ['upload', { file: '/tmp/x' }, 15000],
      ['get_value', {}, 15000],
      ['drag', {}, 15000],
      ['press', { key: 'Enter' }, 15000],
      ['wheel', {}, 15000],
    ];
    for (const [action, params, expectAtLeast] of rows) {
      const ms = actionDeadlineMs(action, params);
      expect(ms, `${action} ${JSON.stringify(params).slice(0, 40)}`).toBeGreaterThanOrEqual(expectAtLeast);
      expect(ms).toBeLessThanOrEqual(MAX_ACTION_DEADLINE_MS);
    }
  });
});

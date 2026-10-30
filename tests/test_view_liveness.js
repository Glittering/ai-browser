// tests/test_view_liveness.js — "这个 BrowserView 还能不能碰"的判定口径。
//
// 事故（2026-10-30）：tabBarView.webContents 变 undefined 后，
// `view.webContents.isDestroyed()` 抛 Cannot read properties of undefined，
// 被 setInterval 每 1.5s 触发一次，累计 22 次击穿主进程 → 白屏 + 深红横幅 + 进程半死。
//
// 这里用假对象把 Electron 的两种真实失效形态钉死（都是真机探针实测过的）：
//   - close()/destroy() 后 → webContents === undefined（抛错形态）
//   - render-process-gone 后 → webContents 还在、isDestroyed=false，但内容不渲染
// 后者 isAlive 仍返回 true（对象能用），由调用方决定是否 reload —— 判定与救治分开。
import { describe, it, expect } from 'vitest';
import viewLiveness from '../src/shared/view_liveness.cjs';
const { isAlive, liveness } = viewLiveness;

describe('isAlive — 绝不抛异常，覆盖全部失效形态', () => {
  it('VL-01 null/undefined → false', () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });

  it('VL-02 健康视图 → true', () => {
    expect(isAlive({ webContents: { isDestroyed: () => false } })).toBe(true);
  });

  it('VL-03 webContents 是 undefined（close/destroy 后，事故形态）→ false，不抛', () => {
    // 这正是主进程日志里 22 次的形态：view 对象还在，.webContents 已变 undefined。
    expect(() => isAlive({ webContents: undefined })).not.toThrow();
    expect(isAlive({ webContents: undefined })).toBe(false);
    expect(isAlive({})).toBe(false);
  });

  it('VL-04 isDestroyed() 返回 true → false', () => {
    expect(isAlive({ webContents: { isDestroyed: () => true } })).toBe(false);
  });

  it('VL-05 读 webContents 就抛异常 → false，不冒出去', () => {
    const evil = {};
    Object.defineProperty(evil, 'webContents', { get() { throw new Error('torn'); } });
    expect(() => isAlive(evil)).not.toThrow();
    expect(isAlive(evil)).toBe(false);
  });

  it('VL-06 isDestroyed() 自己抛异常 → false，不冒出去', () => {
    const evil = { webContents: { isDestroyed() { throw new Error('boom'); } } };
    expect(() => isAlive(evil)).not.toThrow();
    expect(isAlive(evil)).toBe(false);
  });

  it('VL-07 isDestroyed 不是函数（残缺对象）→ false', () => {
    expect(isAlive({ webContents: {} })).toBe(false);
  });
});

describe('liveness — 区分失效原因（救治方式不同）', () => {
  it('VL-08 五态齐全', () => {
    expect(liveness(null)).toBe('no-view');
    expect(liveness({})).toBe('no-webcontents');
    expect(liveness({ webContents: { isDestroyed: () => true } })).toBe('destroyed');
    expect(liveness({ webContents: { isDestroyed: () => false } })).toBe('ok');
    expect(liveness({ webContents: {} })).toBe('unknown');
  });

  it('VL-09 getter 抛异常 → unknown，不冒出去', () => {
    const evil = {};
    Object.defineProperty(evil, 'webContents', { get() { throw new Error('torn'); } });
    expect(() => liveness(evil)).not.toThrow();
    expect(liveness(evil)).toBe('unknown');
  });

  it('VL-10 isDestroyed 抛异常 → unknown，不冒出去', () => {
    const evil = { webContents: { isDestroyed() { throw new Error('boom'); } } };
    expect(liveness(evil)).toBe('unknown');
  });

  it('VL-11 isAlive 与 liveness 一致：只有 ok 时 isAlive 才 true', () => {
    const cases = [
      null,
      {},
      { webContents: { isDestroyed: () => true } },
      { webContents: { isDestroyed: () => false } },
      { webContents: {} },
    ];
    for (const c of cases) {
      expect(isAlive(c)).toBe(liveness(c) === 'ok');
    }
  });
});

// tests/test_nav_follow.js — 地址栏跟随的挂载状态机（Bug 7 的行为判据）。
//
// 背景：这段逻辑原来写在 index.js 的闭包里，回归只能 grep 源码
// （"出现 removeListener 就算对"）。实测 A→B→A 切 5 次后，A 上 `did-navigate`
// 的监听数是 3（应为 1），每次导航 pushNavState 被调 3 次，超过 10 个还会触发
// MaxListenersExceededWarning —— 而 grep 型判据**全绿**。
//
// 所以这里的判据一律数 listenerCount / 数 push 调用次数，不看源码字符串。
// NF-07 反过来复刻"只靠 isDestroyed 判重"的旧实现，断言它在本判据下会失败 ——
// 证明这些断言真的能证伪，而不是摆设。
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import navFollow from '../src/shared/nav_follow.cjs';

const { createNavFollower, NAV_EVENTS } = navFollow;

/** 假 webContents：只具备本模块用到的三个能力。 */
function fakeWc() {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  return wc;
}

/** 每个跟随事件上的监听数（用于断言"只挂一次"）。 */
function counts(wc) {
  const out = {};
  for (const ev of NAV_EVENTS) out[ev] = wc.listenerCount(ev);
  return out;
}

describe('nav_follow — 幂等挂载', () => {
  it('NF-01: 同一个 webContents 连 wire 5 次，每个事件仍只有 1 个监听', () => {
    const calls = [];
    const f = createNavFollower({ push: () => calls.push(1) });
    const wc = fakeWc();
    for (let i = 0; i < 5; i++) f.wire(wc);
    expect(counts(wc)).toEqual(Object.fromEntries(NAV_EVENTS.map((e) => [e, 1])));
    // 阳性对照：事件真的还能触发一次推送，且只触发一次
    wc.emit('did-navigate');
    expect(calls.length).toBe(1);
  });

  it('NF-02: A→B→A 来回切换 5 轮，两边都只有 1 个监听（原缺陷的直接判据）', () => {
    const f = createNavFollower({ push: () => {} });
    const a = fakeWc();
    const b = fakeWc();
    for (let i = 0; i < 5; i++) { f.wire(a); f.wire(b); }
    f.wire(a);
    expect(counts(a)).toEqual(Object.fromEntries(NAV_EVENTS.map((e) => [e, 1])));
    expect(counts(b)).toEqual(Object.fromEntries(NAV_EVENTS.map((e) => [e, 1])));
    expect(f.current()).toBe(a);
  });

  it('NF-03: 每个跟随事件都会触发 push（不是只挂了 did-navigate 一个）', () => {
    let n = 0;
    const f = createNavFollower({ push: () => { n++; } });
    const wc = fakeWc();
    f.wire(wc);
    for (const ev of NAV_EVENTS) wc.emit(ev);
    expect(n).toBe(NAV_EVENTS.length);
  });
});

describe('nav_follow — 生命周期', () => {
  it('NF-04: webContents 销毁后清掉引用，且后续 wire 不抛', () => {
    const f = createNavFollower({ push: () => {} });
    const wc = fakeWc();
    f.wire(wc);
    expect(f.current()).toBe(wc);
    wc.destroyed = true;
    wc.emit('destroyed');
    expect(f.current()).toBe(null);
    expect(() => f.wire(fakeWc())).not.toThrow();
    expect(f.current()).not.toBe(null);
  });

  it('NF-05: wire(null/undefined) 是合法调用（没有激活 tab），返回 null 且不改跟随目标', () => {
    const f = createNavFollower({ push: () => {} });
    const wc = fakeWc();
    f.wire(wc);
    expect(f.wire(null)).toBe(null);
    expect(f.wire(undefined)).toBe(null);
    expect(f.current()).toBe(wc);
  });

  it('NF-06: push 不是函数时立刻抛 TypeError（不允许静默失效）', () => {
    expect(() => createNavFollower({})).toThrow(TypeError);
    expect(() => createNavFollower({ push: 'nope' })).toThrow(TypeError);
  });
});

describe('nav_follow — 判据自证（证伪力对照）', () => {
  // 复刻 index.js 里被替换掉的旧实现：只用 "当前是不是同一个对象 + 旧对象是否已销毁"
  // 判重，不记账。它的漏洞正是：切回一个仍然活着的旧 tab 时会再挂一遍。
  function legacyWire(state, wc, push) {
    if (state.current === wc) return;
    if (state.current && state.current.isDestroyed && state.current.isDestroyed()) {
      for (const ev of NAV_EVENTS) state.current.removeListener(ev, push);
      state.current = null;
    }
    state.current = wc;
    for (const ev of NAV_EVENTS) wc.on(ev, push);
  }

  it('NF-07: 旧实现在同一判据下会失败（证明 NF-02 不是摆设）', () => {
    const push = () => {};
    const state = { current: null };
    const a = fakeWc();
    const b = fakeWc();
    for (let i = 0; i < 5; i++) { legacyWire(state, a, push); legacyWire(state, b, push); }
    legacyWire(state, a, push);   // 切回 A：A 还活着 → 旧实现会再挂一遍
    expect(a.listenerCount('did-navigate')).toBeGreaterThan(1);  // 旧实现确实累加
    // 而新实现在同一序列下是 1（见 NF-02）—— 两者结论相反，说明判据有效
    const f = createNavFollower({ push });
    const a2 = fakeWc();
    const b2 = fakeWc();
    for (let i = 0; i < 5; i++) { f.wire(a2); f.wire(b2); }
    f.wire(a2);
    expect(a2.listenerCount('did-navigate')).toBe(1);
  });
});

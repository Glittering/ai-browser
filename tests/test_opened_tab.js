// tests/test_opened_tab.js — "这条新标签记录是不是本次动作造成的"
//
// 事故：在课程列表页点过「进入学习」之后，随后的 hover 回执里 opened_tab
// 指向那个 about:blank —— 与本次操作毫无关系。原因是一次 ui.evaluate 里的
// el.click() 触发了 window.open，记录写进 _openedTabs 却没有人消费，
// 下一次 act 就把它当成了"我刚开的标签"。

import { describe, it, expect } from 'vitest';
import { pickOpenedTab, openedTabGraceMs, DEFAULT_OPENED_TAB_GRACE_MS } from '../src/shared/opened_tab.js';

describe('pickOpenedTab', () => {
  it('O-1: 没有记录 → null', () => {
    expect(pickOpenedTab(undefined, 1000)).toBeNull();
    expect(pickOpenedTab(null, 1000)).toBeNull();
  });

  it('O-2: 记录发生在本次动作之后 → 算本次的', () => {
    const e = { id: 3, url: 'https://x/y', at: 1005 };
    expect(pickOpenedTab(e, 1000)).toEqual(e);
  });

  it('O-3: 陈旧记录（早于动作开始）→ 丢弃（事故回归）', () => {
    const stale = { id: 3, url: 'about:blank', at: 500 };
    expect(pickOpenedTab(stale, 1000)).toBeNull();
  });

  it('O-4: 同一毫秒内记录也算本次（>= 而非 >）', () => {
    const e = { id: 2, url: 'about:blank', at: 1000 };
    expect(pickOpenedTab(e, 1000)).toEqual(e);
  });

  it('O-5: 没有时间戳的旧记录一律视为陈旧（宁漏报，不误报）', () => {
    expect(pickOpenedTab({ id: 1, url: 'about:blank' }, 1000)).toBeNull();
  });

  it('O-6: 调用方没给时间基准时保持旧行为（不过滤）', () => {
    const e = { id: 1, url: 'about:blank' };
    expect(pickOpenedTab(e, undefined)).toEqual(e);
  });
});

// ── 宽限窗口：点完等多久再收新标签记录 ────────────────────────────────────
//
// 2026-10-19 实测：act 10~15ms 返回，新标签 105~119ms 才出现（三次一致）。
// 于是回执说 opened_tab:null，标签其实开了 —— agent 会以为"点了没反应"。
// 这组测试钉住窗口的取值规则（默认值、显式覆盖、0 关闭、封顶），
// 不钉具体毫秒数能不能覆盖某个站点（那是实测的事，不是单测的事）。
describe('openedTabGraceMs', () => {
  it('G-1: 默认值（没有参数、没有环境变量）', () => {
    expect(openedTabGraceMs({}, {})).toBe(DEFAULT_OPENED_TAB_GRACE_MS);
    expect(openedTabGraceMs(undefined, {})).toBe(DEFAULT_OPENED_TAB_GRACE_MS);
  });

  it('G-2: 调用方显式给值优先，且 0 是有效值（不是"没给"）', () => {
    expect(openedTabGraceMs({ opened_tab_wait_ms: 300 }, {})).toBe(300);
    expect(openedTabGraceMs({ opened_tab_wait_ms: 0 }, {})).toBe(0);
  });

  it('G-3: 环境变量可全局关掉（跑基准时不想被固定延迟污染）', () => {
    expect(openedTabGraceMs({}, { AI_BROWSER_OPENED_TAB_WAIT_MS: '0' })).toBe(0);
    expect(openedTabGraceMs({}, { AI_BROWSER_OPENED_TAB_WAIT_MS: '400' })).toBe(400);
    // 显式参数比环境变量更具体 —— 单次调用能覆盖全局开关
    expect(openedTabGraceMs({ opened_tab_wait_ms: 50 }, { AI_BROWSER_OPENED_TAB_WAIT_MS: '0' })).toBe(50);
  });

  it('G-4: 非法值退回默认，不抛也不返回 NaN（NaN 会让 setTimeout 立刻触发，等于没等）', () => {
    expect(openedTabGraceMs({ opened_tab_wait_ms: 'abc' }, {})).toBe(DEFAULT_OPENED_TAB_GRACE_MS);
    expect(openedTabGraceMs({ opened_tab_wait_ms: -5 }, {})).toBe(DEFAULT_OPENED_TAB_GRACE_MS);
    expect(openedTabGraceMs({}, { AI_BROWSER_OPENED_TAB_WAIT_MS: 'x' })).toBe(DEFAULT_OPENED_TAB_GRACE_MS);
  });

  it('G-5: 封顶 2000ms —— 这个等待是加在每个点击上的，不许无限长', () => {
    expect(openedTabGraceMs({ opened_tab_wait_ms: 99999 }, {})).toBe(2000);
    expect(openedTabGraceMs({}, { AI_BROWSER_OPENED_TAB_WAIT_MS: '60000' })).toBe(2000);
  });
});

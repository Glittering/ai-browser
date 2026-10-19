// tests/test_opened_tab.js — "这条新标签记录是不是本次动作造成的"
//
// 事故：在课程列表页点过「进入学习」之后，随后的 hover 回执里 opened_tab
// 指向那个 about:blank —— 与本次操作毫无关系。原因是一次 ui.evaluate 里的
// el.click() 触发了 window.open，记录写进 _openedTabs 却没有人消费，
// 下一次 act 就把它当成了"我刚开的标签"。

import { describe, it, expect } from 'vitest';
import { pickOpenedTab } from '../src/shared/opened_tab.js';

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

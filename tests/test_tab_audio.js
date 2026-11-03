// tests/test_tab_audio.js — 谁的声音能出喇叭（shared/tab_audio.cjs）
//
// 这一条判据影响的是**人的听觉**，写反了有两种相反的坏结果：
//   全部静音 → 人在看的视频页没有声音（等于把产品弄坏）
//   全部放开 → agent 在后台开的五页同时响，而标签条上没有逐个静音的按钮（等于吵到人）
// 所以两条排除各钉一条，且都钉"人的页切走了不许静音" —— 那是 Chrome 的行为，
// 我们吸收的是 agent 那一半，不是去改人自己开的那一半。
import { describe, it, expect } from 'vitest';
import tabAudio from '../src/shared/tab_audio.cjs';
import tabGroup from '../src/shared/tab_group.cjs';

const { shouldMute, bgMuteEnabled } = tabAudio;
const HUMAN = tabGroup.HUMAN_GROUP;

describe('AU 开关', () => {
  it('AU-1 默认开；显式 0/false/off/no 才关', () => {
    expect(bgMuteEnabled({})).toBe(true);
    expect(bgMuteEnabled({ AI_BROWSER_BG_MUTE: '' })).toBe(true);
    expect(bgMuteEnabled({ AI_BROWSER_BG_MUTE: '1' })).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(bgMuteEnabled({ AI_BROWSER_BG_MUTE: off }), off).toBe(false);
    }
  });
});

describe('AU 静音判据', () => {
  it('AU-2 人眼前那一页永远有声', () => {
    expect(shouldMute({ tabId: 3, activeTab: 3, group: 'agent:s1', enabled: true })).toBe(false);
  });

  it('AU-3 agent 的后台页静音 —— 这条存在的全部理由', () => {
    expect(shouldMute({ tabId: 4, activeTab: 3, group: 'agent:s1', enabled: true })).toBe(true);
  });

  it('AU-4 人自己开的后台页照旧响：切走就静音是 Chrome 没有的行为', () => {
    expect(shouldMute({ tabId: 2, activeTab: 3, group: HUMAN, enabled: true })).toBe(false);
    expect(shouldMute({ tabId: 2, activeTab: 3, group: undefined, enabled: true })).toBe(false);
  });

  it('AU-5 activeTab 还没定（空窗口）时按归属判，不能把两页都当成"眼前那一页"', () => {
    expect(shouldMute({ tabId: 1, activeTab: null, group: 'agent:s1', enabled: true })).toBe(true);
    expect(shouldMute({ tabId: 1, activeTab: null, group: HUMAN, enabled: true })).toBe(false);
    expect(shouldMute({ tabId: null, activeTab: null, group: 'agent:s1', enabled: true })).toBe(false);
  });

  it('AU-6 开关关掉时谁都不静音', () => {
    expect(shouldMute({ tabId: 4, activeTab: 3, group: 'agent:s1', enabled: false })).toBe(false);
  });

  it('AU-7 enabled 不传时读环境变量（进程里 AI_BROWSER_BG_MUTE=0 就是一条都不静音）', () => {
    const saved = process.env.AI_BROWSER_BG_MUTE;
    process.env.AI_BROWSER_BG_MUTE = '0';
    try {
      expect(shouldMute({ tabId: 4, activeTab: 3, group: 'agent:s1' })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AI_BROWSER_BG_MUTE;
      else process.env.AI_BROWSER_BG_MUTE = saved;
    }
  });

  it('AU-8 回执只在静音时给字段（没静音的页不该带噪音）', () => {
    expect(tabAudio.muteField(true)).toEqual({ muted: true });
    expect(tabAudio.muteField(false)).toEqual({});
    expect(tabAudio.muteField(undefined)).toEqual({});
  });
});

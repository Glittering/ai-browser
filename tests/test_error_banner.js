// tests/test_error_banner.js — 主进程异常横幅的文案装配（src/shared/error_banner.cjs）
//
// 这些断言看着琐碎，但每一条都对应横幅上的一个具体失效模式：
//   横幅只有 34px 高 → 消息里带换行会把文字挤出可视区（一片红却读不到原因）
//   消息可能很长（含整个 URL / 选择器） → 不截断会把日志路径挤没
//   横幅是提醒不是全部 → 日志路径必须出现，否则又回到"点掉之后无从查证"

import { describe, it, expect } from 'vitest';
import banner from '../src/shared/error_banner.cjs';

const { buildBannerPayload, MAX_DETAIL } = banner;

describe('buildBannerPayload()', () => {
  it('BN-1: 多行消息压成一行（横幅是单行布局，换行会被裁掉）', () => {
    const p = buildBannerPayload({ detail: 'TypeError: x is undefined\n    at foo (a.js:1:1)\n    at bar' });
    expect(p.detail).not.toContain('\n');
    expect(p.detail).toContain('TypeError: x is undefined');
    // 栈帧仍保留同一行里（信息不丢，只是不换行）
    expect(p.detail).toContain('at foo');
  });

  it('BN-2: 连续空白/制表符归一成一个空格', () => {
    const p = buildBannerPayload({ detail: 'a\t\t b   \n\n  c' });
    expect(p.detail).toBe('a b c');
  });

  it('BN-3: 超长消息截断并带省略号，总长不超过 MAX_DETAIL', () => {
    const p = buildBannerPayload({ detail: 'x'.repeat(MAX_DETAIL * 2) });
    expect(p.detail.length).toBe(MAX_DETAIL);
    expect(p.detail.endsWith('…')).toBe(true);
  });

  it('BN-4: 空消息给占位文案，不返回空串（红条上空无一字最糟）', () => {
    expect(buildBannerPayload({ detail: '' }).detail).toBe('(没有消息)');
    expect(buildBannerPayload({ detail: '   \n ' }).detail).toBe('(没有消息)');
    expect(buildBannerPayload({}).detail).toBe('(没有消息)');
  });

  it('BN-5: 必须带日志路径 —— 横幅是提醒，真相在日志里', () => {
    const p = buildBannerPayload({ detail: 'boom', logPath: '/Users/x/.ai-browser/logs/error.jsonl' });
    expect(p.log_path).toBe('/Users/x/.ai-browser/logs/error.jsonl');
  });

  it('BN-6: 日志路径过长时也压成一行并截断（userData 可能很深）', () => {
    const p = buildBannerPayload({ detail: 'boom', logPath: '/' + 'deep/'.repeat(60) + 'error.jsonl' });
    expect(p.log_path).not.toContain('\n');
    expect(p.log_path.length).toBeLessThanOrEqual(120);
  });

  it('BN-7: 没有日志路径时是空串（渲染侧据此不显示那一段），不是 "undefined"', () => {
    expect(buildBannerPayload({ detail: 'boom' }).log_path).toBe('');
    expect(buildBannerPayload({ detail: 'boom', logPath: null }).log_path).toBe('');
  });

  it('BN-8: count 默认 1，非法值也回落 1（角标不显示 "×NaN"）', () => {
    expect(buildBannerPayload({ detail: 'boom' }).count).toBe(1);
    expect(buildBannerPayload({ detail: 'boom', count: 7 }).count).toBe(7);
    expect(buildBannerPayload({ detail: 'boom', count: 'x' }).count).toBe(1);
    expect(buildBannerPayload({ detail: 'boom', count: -3 }).count).toBe(1);
    expect(buildBannerPayload({ detail: 'boom', count: 2.7 }).count).toBe(2);
  });

  it('BN-9: title 稳定（渲染侧把它当标签，不与正文重复）', () => {
    expect(buildBannerPayload({ detail: 'boom' }).title).toBe('AI Browser 主进程异常');
  });

  it('BN-10: 入参为 null/undefined 不抛（崩溃路径里再抛一次就彻底没了）', () => {
    expect(() => buildBannerPayload()).not.toThrow();
    expect(() => buildBannerPayload(null)).not.toThrow();
    expect(buildBannerPayload(null).detail).toBe('(没有消息)');
  });

  it('BN-11: 非字符串 detail（Error 对象 / 数字）被安全字符串化', () => {
    expect(buildBannerPayload({ detail: 42 }).detail).toBe('42');
    expect(buildBannerPayload({ detail: new Error('kaboom') }).detail).toContain('kaboom');
  });

  it('BN-12: at 可由调用方指定（同一批异常共用时间戳时便于对账）', () => {
    const at = '2026-10-17T10:00:00.000Z';
    expect(buildBannerPayload({ detail: 'boom', at }).at).toBe(at);
    // 不给就自己生成 ISO 串
    expect(buildBannerPayload({ detail: 'boom' }).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

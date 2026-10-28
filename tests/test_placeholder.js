// tests/test_placeholder.js — 新标签页占位页的地址与判定（shared/placeholder.cjs）
//
// 这个文件的每一条都对应一次真实事故（2026-10-28，v2.3.0 发布后才发现）：
// 占位页 URL 是手拼的 `'file://' + path`，而打包后的路径是
// `/Applications/AI Browser.app/...`（含空格）。Chromium 把空格报成 `%20`，
// 于是"字符串相等"的判据在**打包后**恒为 false，只有在 /Applications 里跑才复现 ——
// 开发树的路径没有空格，所有 e2e 全绿，发出去的 2.3.0 里新开标签页永远停在占位页。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/shared/placeholder.cjs');

const PACKAGED = '/Applications/AI Browser.app/Contents/Resources/app.asar/src/renderer/loading.html';
const DEV = '/Users/someone/projects/ai-browser/src/renderer/loading.html';

describe('PH 构造占位页地址', () => {
  it('PH-1 路径里的空格必须转义成 %20（手拼 file:// 会留下字面空格）', () => {
    const u = P.placeholderUrlFor(PACKAGED, 'https://example.com/a b');
    expect(u.startsWith('file://')).toBe(true);
    expect(u.indexOf('AI%20Browser.app')).toBeGreaterThan(0);
    expect(u.indexOf(' ')).toBe(-1);
  });

  it('PH-2 目标地址进 query 且被正确转义（含 # ? & 的中文地址）', () => {
    const target = 'https://例子.com/path?x=1&y=2#frag';
    const u = P.placeholderUrlFor(DEV, target);
    const q = new URL(u).searchParams.get('url');
    expect(q).toBe(target);
  });

  it('PH-3 没有目标地址 → about:blank（window.open("") 的老站模式）', () => {
    expect(P.placeholderUrlFor(DEV, null)).toBe('about:blank');
    expect(P.placeholderUrlFor(DEV, '')).toBe('about:blank');
  });
});

describe('PH 判定"还在不在占位页上"', () => {
  it('PH-4 打包路径（%20）认得出 —— 这一条就是那次事故的回归', () => {
    const u = P.placeholderUrlFor(PACKAGED, 'https://example.com');
    expect(P.isPlaceholderUrl(u)).toBe(true);
    // 同一个地址如果被写成字面空格也必须认
    expect(P.isPlaceholderUrl(u.replace('%20', ' '))).toBe(true);
  });

  it('PH-5 空 / about:blank 算"还没开始"（占位页刚发起那一瞬 getURL() 是空）', () => {
    expect(P.isPlaceholderUrl('')).toBe(true);
    expect(P.isPlaceholderUrl(null)).toBe(true);
    expect(P.isPlaceholderUrl(undefined)).toBe(true);
    expect(P.isPlaceholderUrl('about:blank')).toBe(true);
  });

  it('PH-6 真正的目标页一律不算（否则会把"已经导航走"误判成"还在等"）', () => {
    expect(P.isPlaceholderUrl('https://www.baidu.com/')).toBe(false);
    expect(P.isPlaceholderUrl('http://127.0.0.1:8080/bg')).toBe(false);
    // 站点里恰好有个 loading.html 的页面，也不能被当成我们的占位页
    expect(P.isPlaceholderUrl('https://example.com/loading.html')).toBe(false);
    expect(P.isPlaceholderUrl('file:///tmp/error.html?x=1')).toBe(false);
  });

  it('PH-7 query 顺序 / 尾斜杠不影响判定（只认文件名）', () => {
    expect(P.isPlaceholderUrl('file:///a/b/loading.html?url=x&extra=1')).toBe(true);
    expect(P.isPlaceholderUrl('file:///a/b/loading.html')).toBe(true);
  });
});

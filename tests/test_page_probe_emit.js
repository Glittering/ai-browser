// tests/test_page_probe_emit.js
// 执行**真正的** PAGE_PROBE_JS，验证它确实把 g（"看见的画布是 GPU 画的"）带出来。
//
// 为什么单独一个文件、单独一个 jsdom 环境：test_page_probe.js 跑在纯 node 里，
// 只能对新加的字段做字符串断言 —— 而字符串断言正是记忆里那条踩过的坑：
// 只查"脚本里出现了某个词"，格式一漂移照样全绿。这里让脚本真的跑一遍。
//
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { PAGE_PROBE_JS } from '../src/shared/page_probe.js';

const run = () => new Function('return ' + PAGE_PROBE_JS)();

afterEach(() => {
  delete window.__aiCanvasFp;
  document.body.innerHTML = '';
});

describe('PAGE_PROBE_JS 真的会产出 g', () => {
  it('PE-01 钩子报 g:1（可见画布是 GPU）→ 探针字段 g 必须是 1', () => {
    document.body.innerHTML = '<p>hello</p>';
    window.__aiCanvasFp = () => ({ n: 3, fp: 111, frames: 2, last: 111, on: 1, g: 1 });
    const out = run();
    expect(out.c).toBe('111');
    expect(out.g).toBe(1);
  });

  it('PE-02 钩子没有 g 字段（老版本/非 GPU 页）→ 必须是 0，不能是 undefined', () => {
    // "字段缺失"与"值为假"在调用方长得不一样：undefined 会让
    // `before.g === 1` 这种判断照常工作，但会让"有没有这个信号"的显式检查落空。
    document.body.innerHTML = '<p>hello</p>';
    window.__aiCanvasFp = () => ({ n: 3, fp: 111, frames: 2, last: 111, on: 1 });
    expect(run().g).toBe(0);
  });

  it('PE-03 页面根本没有钩子 → g 仍是 0，且不抛异常', () => {
    document.body.innerHTML = '<p>hello</p>';
    const out = run();
    expect(out.g).toBe(0);
    expect(out.c).toBeNull();
  });
});

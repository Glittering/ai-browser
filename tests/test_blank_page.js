// tests/test_blank_page.js — "这一页画出来了没有"的判定口径。
//
// 这个模块的价值全在**不误报**上：把白底内容页判成白屏，就会触发 reload，
// 把用户正在填的表单刷掉。所以两类边界要在同一个文件里钉死：
//   真白屏（纯白 + DOM 有字）→ 必须报
//   白底内容页（百度首页那种 90% 白、几千种颜色）→ 必须不报
import { describe, it, expect } from 'vitest';
import blankPage from '../src/shared/blank_page.cjs';

const { statsFromBitmap, classifyPaint, decidePaintAction, THRESHOLDS } = blankPage;

/** 造一张 BGRA 位图：pixels 是 [r,g,b] 数组。 */
function bmp(pixels) {
  const buf = Buffer.alloc(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = 255;
  });
  return buf;
}

describe('statsFromBitmap', () => {
  it('纯白：白度 100%，只有 1 种颜色', () => {
    const s = statsFromBitmap(bmp(Array.from({ length: 100 }, () => [255, 255, 255])));
    expect(s.total).toBe(100);
    expect(s.white).toBe(100);
    expect(s.white_ratio).toBe(1);
    expect(s.unique).toBe(1);
    expect(s.unique_pinned).toBe(false);
  });

  it('一半白一半黑：白度 50%，2 种颜色', () => {
    const px = [];
    for (let i = 0; i < 50; i++) px.push([255, 255, 255]);
    for (let i = 0; i < 50; i++) px.push([0, 0, 0]);
    const s = statsFromBitmap(bmp(px));
    expect(s.white_ratio).toBeCloseTo(0.5, 5);
    expect(s.unique).toBe(2);
  });

  it('颜色数超上限后不再增长（内存有界），但白度仍然数到底', () => {
    // 300 个不同颜色 + 700 个白色：颜色数被封顶，白度必须还是 0.7
    const px = [];
    for (let i = 0; i < 300; i++) px.push([i % 256, (i * 7) % 256, (i * 13) % 256]);
    for (let i = 0; i < 700; i++) px.push([255, 255, 255]);
    const s = statsFromBitmap(bmp(px));
    expect(s.unique_pinned).toBe(true);
    expect(s.unique).toBe(THRESHOLDS.UNIQUE_MAX + 1);
    expect(s.white_ratio).toBeCloseTo(0.7, 5);
  });

  it('空 buffer 不抛异常，返回全零', () => {
    const s = statsFromBitmap(Buffer.alloc(0));
    expect(s.total).toBe(0);
    expect(s.white_ratio).toBe(0);
  });
});

describe('classifyPaint — 真白屏必须报出来', () => {
  const white = statsFromBitmap(bmp(Array.from({ length: 100 }, () => [255, 255, 255])));

  it('纯白 + DOM 里有文字 → blank-with-text', () => {
    const r = classifyPaint({ stats: white, dom: { text_len: 397, nodes: 610, ready_state: 'complete' } });
    expect(r.verdict).toBe('blank-with-text');
    expect(r.blank).toBe(true);
    expect(r.reason).toContain('397');
  });

  it('纯白 + 几十个节点但没有文字 → blank-with-dom', () => {
    const r = classifyPaint({ stats: white, dom: { text_len: 0, nodes: 80, ready_state: 'complete' } });
    expect(r.verdict).toBe('blank-with-dom');
    expect(r.blank).toBe(true);
  });
});

describe('classifyPaint — 不该报的一个都不能报', () => {
  it('百度首页那种 90% 白、几千种颜色 → ok', () => {
    const stats = { total: 100, white: 91, white_ratio: 0.91, unique: 33, unique_pinned: true };
    const r = classifyPaint({ stats, dom: { text_len: 397, nodes: 610, ready_state: 'complete' } });
    expect(r.verdict).toBe('ok');
    expect(r.blank).toBe(false);
  });

  it('99% 白但颜色数超上限（有内容的浅色页）→ ok', () => {
    const stats = { total: 100, white: 99, white_ratio: 0.99, unique: 33, unique_pinned: true };
    const r = classifyPaint({ stats, dom: { text_len: 12, nodes: 40, ready_state: 'complete' } });
    expect(r.verdict).toBe('ok');
  });

  it('本来就空的文档 → empty-legit（白是正确结果，不该 reload）', () => {
    const white = statsFromBitmap(bmp(Array.from({ length: 100 }, () => [255, 255, 255])));
    const r = classifyPaint({ stats: white, dom: { text_len: 0, nodes: 1, ready_state: 'complete' } });
    expect(r.verdict).toBe('empty-legit');
    expect(r.blank).toBe(false);
  });

  it('还没加载完（loading）→ not-ready，不判缺陷', () => {
    const white = statsFromBitmap(bmp(Array.from({ length: 100 }, () => [255, 255, 255])));
    const r = classifyPaint({ stats: white, dom: { text_len: 0, nodes: 0, ready_state: 'loading' } });
    expect(r.verdict).toBe('not-ready');
    expect(decidePaintAction({ verdict: r.verdict, steps: 0 })).toBe('none');
  });

  it('深色加载页（0% 白）→ ok', () => {
    const dark = statsFromBitmap(bmp(Array.from({ length: 100 }, () => [30, 30, 30])));
    const r = classifyPaint({ stats: dark, dom: { text_len: 40, nodes: 30, ready_state: 'complete' } });
    expect(r.verdict).toBe('ok');
  });
});

describe('classifyPaint — 拿不到画面时不许瞎猜', () => {
  it('视图被压成 0 高 → collapsed（不是内容问题，是没地方画）', () => {
    const r = classifyPaint({ stats: { total: 10, white: 10, white_ratio: 1, unique: 1 }, dom: {}, bounds: { width: 1280, height: 0 } });
    expect(r.verdict).toBe('collapsed');
    expect(r.reason).toContain('0');
  });

  it('没有位图 → no-frame，且 blank=false（不许把诊断失败说成白屏）', () => {
    const r = classifyPaint({ stats: null, dom: { text_len: 100, nodes: 50, ready_state: 'complete' } });
    expect(r.verdict).toBe('no-frame');
    expect(r.blank).toBe(false);
  });
});

describe('decidePaintAction', () => {
  it('repaint → reload → give-up，且到此为止', () => {
    expect(decidePaintAction({ verdict: 'blank-with-text', steps: 0 })).toBe('repaint');
    expect(decidePaintAction({ verdict: 'blank-with-text', steps: 1 })).toBe('reload');
    expect(decidePaintAction({ verdict: 'blank-with-text', steps: 2 })).toBe('give-up');
    expect(decidePaintAction({ verdict: 'blank-with-text', steps: 99 })).toBe('give-up');
  });

  it('collapsed 也会被救（先重画、再重载），不会直接放弃', () => {
    expect(decidePaintAction({ verdict: 'collapsed', steps: 0 })).toBe('repaint');
  });


  it('scale-mismatch 也走同一阶梯（先重画、再重载、然后放弃）', () => {
    expect(decidePaintAction({ verdict: 'scale-mismatch', steps: 0 })).toBe('repaint');
    expect(decidePaintAction({ verdict: 'scale-mismatch', steps: 1 })).toBe('reload');
    expect(decidePaintAction({ verdict: 'scale-mismatch', steps: 2 })).toBe('give-up');
  });

  it('正常页/空页/未就绪一律不动（reload 会丢用户正在填的东西）', () => {
    for (const v of ['ok', 'empty-legit', 'not-ready', 'no-frame']) {
      expect(decidePaintAction({ verdict: v, steps: 0 })).toBe('none');
      expect(decidePaintAction({ verdict: v, steps: 1 })).toBe('none');
    }
  });
});

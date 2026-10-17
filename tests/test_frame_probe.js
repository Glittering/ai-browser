// tests/test_frame_probe.js — 跨进程子帧（OOPIF）探测与自动路由
// 两层：
//   1) shared/frame_probe.cjs 纯函数（node 环境）
//   2) preload/extractor.cjs 的 jsdom 端到端（@vitest-environment jsdom）
import { describe, it, expect } from 'vitest';
import {
  summarizeOpaqueFrames,
  shouldAutoAx,
  describeAutoAx,
} from '../src/shared/frame_probe.cjs';

describe('summarizeOpaqueFrames — context field shape', () => {
  it('FP-SUM-1: no frames → count 0, suggestion null (cheap no-op for normal pages)', () => {
    expect(summarizeOpaqueFrames([])).toEqual({ count: 0, visible_count: 0, suggestion: null });
    expect(summarizeOpaqueFrames(null)).toEqual({ count: 0, visible_count: 0, suggestion: null });
    expect(summarizeOpaqueFrames([null, undefined])).toEqual({ count: 0, visible_count: 0, suggestion: null });
  });

  it('FP-SUM-2: visible frames counted separately from hidden ones', () => {
    const s = summarizeOpaqueFrames([
      { id: 'a', src: 'https://x.test/', width: 600, height: 400 },
      { id: 'b', src: 'https://y.test/', width: 0, height: 0 }, // 埋点/广告帧
    ]);
    expect(s.count).toBe(2);
    expect(s.visible_count).toBe(1);
  });

  it('FP-SUM-3: suggestion names the rescue path (ax:true) — it was undiscoverable before', () => {
    const s = summarizeOpaqueFrames([{ width: 10, height: 10 }]);
    expect(s.suggestion).toContain('ax:true');
  });
});

describe('shouldAutoAx — conservative gate', () => {
  it('FP-AUTO-1: only visible unreadable frames trigger the extra CDP read', () => {
    expect(shouldAutoAx({ count: 3, visible_count: 0 })).toBe(false); // 全隐藏：不值得每次多付一次往返
    expect(shouldAutoAx({ count: 1, visible_count: 1 })).toBe(true);
    expect(shouldAutoAx({ count: 0, visible_count: 0 })).toBe(false);
    expect(shouldAutoAx(null)).toBe(false);
  });
});

describe('describeAutoAx — three distinguishable outcomes', () => {
  it('FP-AUTO-2: merged reports how many frames were read', () => {
    expect(describeAutoAx({ merged: true, framesRead: 2 })).toEqual({ auto_ax: 'merged', frames_read: 2 });
  });

  it('FP-AUTO-3: no-new-content is distinct from merged (nothing to splice in)', () => {
    expect(describeAutoAx({ merged: false })).toEqual({ auto_ax: 'no-new-content' });
  });

  it('FP-AUTO-4: failure carries the reason so callers can retry manually', () => {
    const h = describeAutoAx({ error: 'cdp-unavailable' });
    expect(h.auto_ax).toBe('failed');
    expect(h.reason).toBe('cdp-unavailable');
  });
});

// ============================================================
// extractor 端到端（jsdom）
// ============================================================
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname2 = resolve(fileURLToPath(import.meta.url), '..');

describe('extractor: cross-process iframe probing (jsdom)', () => {
  let extractor;
  let restore;

  async function loadWith(html) {
    document.documentElement.innerHTML = html;
    // 每次动态 import 会命中模块缓存；extractor 无跨调用状态（AI_ID_SEQ 只增），
    // 同一实例复用即可，但 DOM 必须重建。
    if (!extractor) {
      const mod = await import('../src/preload/extractor.cjs');
      extractor = mod.default || mod;
    }
    return extractor;
  }

  it('FP-EXT-1: cross-origin iframe yields an opaque placeholder + context.cross_process_frames', async () => {
    const ext = await loadWith(`<html><body>
      <h1>Main page</h1>
      <iframe id="editor" src="https://other.example.com/editor" style="width:600px;height:400px"></iframe>
    </body></html>`);
    // jsdom 不布局：getBoundingClientRect 恒 0。真实浏览器里这个编辑器有尺寸，
    // visible_count 才会 >0。mock 出真实场景。
    const ifr = document.getElementById('editor');
    ifr.getBoundingClientRect = () => ({ x: 0, y: 0, width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400 });

    const ctx = ext.extractPageContext();
    expect(ctx.cross_process_frames.count).toBe(1);
    expect(ctx.cross_process_frames.visible_count).toBe(1);
    expect(ctx.cross_process_frames.suggestion).toContain('ax:true');

    const tree = ext.extractTree();
    const flat = [];
    (function w(n) { if (!n) return; flat.push(n); for (const c of n.children || []) w(c); })(tree);
    const opaque = flat.filter((n) => n.opaque === true);
    expect(opaque.length).toBeGreaterThanOrEqual(1);
    expect(opaque[0].src).toBe('https://other.example.com/editor');
  });

  it('FP-EXT-2: same-origin (about:blank) iframe stays readable — no opaque, no hint', async () => {
    const ext = await loadWith(`<html><body>
      <iframe id="local"></iframe>
    </body></html>`);
    const ctx = ext.extractPageContext();
    expect(ctx.cross_process_frames.count).toBe(0);
    expect(ctx.cross_process_frames.suggestion).toBeNull();

    const tree = ext.extractTree();
    const flat = [];
    (function w(n) { if (!n) return; flat.push(n); for (const c of n.children || []) w(c); })(tree);
    expect(flat.some((n) => n.opaque === true)).toBe(false);
  });

  it('FP-EXT-3: hidden OOPIF (zero-size) is reported but does not trigger auto-AX', async () => {
    const ext = await loadWith(`<html><body>
      <iframe id="tracker" src="https://tracker.example.com/"></iframe>
    </body></html>`);
    const ctx = ext.extractPageContext();
    expect(ctx.cross_process_frames.count).toBe(1);
    expect(ctx.cross_process_frames.visible_count).toBe(0);
    expect(shouldAutoAx(ctx.cross_process_frames)).toBe(false);
  });

  it('FP-EXT-4: pages without iframes cost nothing (count 0, suggestion null)', async () => {
    const ext = await loadWith(`<html><body><button>ok</button></body></html>`);
    const ctx = ext.extractPageContext();
    expect(ctx.cross_process_frames).toEqual({ count: 0, visible_count: 0, suggestion: null });
  });
});

// ---- P2-2 后续：子帧里的必填提示 / 校验错误要合进顶层 context ----
import { mergeFrameContext } from '../src/shared/frame_probe.cjs';

describe('mergeFrameContext()', () => {
  it('FM-1: subframe hints/errors are merged, deduped, and labelled', () => {
    const ctx = { required_hints: ['请输入标题'], validation_errors: [{ text: '顶层错误', near: 'a' }] };
    const frames = [{
      key: 'frame-3',
      context: {
        required_hints: ['请输入标题', '请输入正文'],
        validation_errors: [{ text: '至少添加一个标签', near: 'tag-input' }, { text: '顶层错误', near: 'a' }],
      },
    }];
    const m = mergeFrameContext(ctx, frames);
    expect(m.required_hints).toEqual(['请输入标题', '请输入正文']);
    expect(m.validation_errors).toHaveLength(2); // 重复的那条没有再来一次
    expect(m.validation_errors[1]).toEqual({ text: '至少添加一个标签', near: 'tag-input', frame: 'frame-3' });
    expect(m.frame_context_merged).toBe(2);
    // 纯函数：入参没被改
    expect(ctx.required_hints).toEqual(['请输入标题']);
    expect(ctx.validation_errors).toHaveLength(1);
  });

  it('FM-2: nothing new means null (callers can tell "merged" from "nothing to merge")', () => {
    expect(mergeFrameContext({}, [])).toBeNull();
    expect(mergeFrameContext({}, [{ key: 'f', context: { required_hints: [], validation_errors: [] } }])).toBeNull();
    expect(mergeFrameContext({}, [{ key: 'f' }])).toBeNull();
  });

  it('FM-3: empty error text is not turned into a phantom entry', () => {
    const m = mergeFrameContext({}, [{ key: 'f', context: { validation_errors: [{ text: '  ', near: 'x' }] } }]);
    expect(m).toBeNull();
  });
});

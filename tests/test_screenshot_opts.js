// tests/test_screenshot_opts.js — 截图参数规范化单测
// 数据来源：ui.screenshot 接入时预想的典型误用（坏 format、越界 quality、
// clip/fullPage 同传、负坐标），以及现场需求（zoom 单元素、长页 jpeg 省钱）。
import { describe, it, expect } from 'vitest';
import {
  normalizeScreenshotOpts,
  describeShot,
  FORMATS,
  MAX_DATA_URL_CHARS,
} from '../src/shared/screenshot_opts.cjs';

describe('normalizeScreenshotOpts — defaults', () => {
  it('S-OPT-1: empty input yields png, viewport-only, no clip', () => {
    const r = normalizeScreenshotOpts({});
    expect(r.ok).toBe(true);
    expect(r.opts.format).toBe('png');
    expect(r.opts.fullPage).toBe(false);
    expect(r.opts.clip).toBeUndefined();
    expect(r.opts.quality).toBeUndefined();
  });

  it('S-OPT-2: undefined/null tolerated as "not provided"', () => {
    expect(normalizeScreenshotOpts(undefined).ok).toBe(true);
    expect(normalizeScreenshotOpts(null).ok).toBe(true);
    const r = normalizeScreenshotOpts({ format: null, quality: null, fullPage: null, clip: null });
    expect(r.ok).toBe(true);
    expect(r.opts.format).toBe('png');
  });

  it('S-OPT-3: jpeg without quality defaults to 85 (text pages look lossless, 5x smaller)', () => {
    const r = normalizeScreenshotOpts({ format: 'jpeg' });
    expect(r.opts.quality).toBe(85);
  });

  it('S-OPT-4: png with explicit quality keeps it (harmless; CDP ignores)', () => {
    const r = normalizeScreenshotOpts({ format: 'png', quality: 40 });
    expect(r.ok).toBe(true);
    expect(r.opts.quality).toBe(40);
  });
});

describe('normalizeScreenshotOpts — rejects bad input with readable errors', () => {
  it('S-OPT-5: unknown format rejected, error lists the legal set', () => {
    const r = normalizeScreenshotOpts({ format: 'gif' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('png');
    expect(r.error).toContain('jpeg');
  });

  it('S-OPT-6: quality must be numeric 0..100', () => {
    expect(normalizeScreenshotOpts({ quality: 'high' }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ quality: -1 }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ quality: 101 }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ quality: NaN }).ok).toBe(false);
  });

  it('S-OPT-7: fullPage must be boolean (truthy strings are a caller bug)', () => {
    expect(normalizeScreenshotOpts({ fullPage: 'yes' }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ fullPage: 1 }).ok).toBe(false);
  });

  it('S-OPT-8: clip needs all four numbers', () => {
    const r = normalizeScreenshotOpts({ clip: { x: 0, y: 0, width: 100 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('height');
  });

  it('S-OPT-9: negative / zero clip geometry rejected', () => {
    expect(normalizeScreenshotOpts({ clip: { x: -1, y: 0, width: 10, height: 10 } }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ clip: { x: 0, y: 0, width: 0, height: 10 } }).ok).toBe(false);
  });

  it('S-OPT-10: clip.scale bounded (0, 4]', () => {
    expect(normalizeScreenshotOpts({ clip: { x: 0, y: 0, width: 1, height: 1, scale: 0 } }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ clip: { x: 0, y: 0, width: 1, height: 1, scale: 5 } }).ok).toBe(false);
    const ok = normalizeScreenshotOpts({ clip: { x: 0, y: 0, width: 1, height: 1, scale: 2 } });
    expect(ok.ok).toBe(true);
    expect(ok.opts.clip.scale).toBe(2);
  });

  it('S-OPT-11: fullPage + clip rejected — Chromium semantics would be "clip top through page bottom", almost never the intent', () => {
    const r = normalizeScreenshotOpts({
      fullPage: true,
      clip: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mutually exclusive');
  });

  it('S-OPT-12: valid clip passes through with scale defaulted to 1', () => {
    const r = normalizeScreenshotOpts({ clip: { x: 10, y: 20, width: 300, height: 200 } });
    expect(r.ok).toBe(true);
    expect(r.opts.clip).toEqual({ x: 10, y: 20, width: 300, height: 200, scale: 1 });
  });
});

describe('describeShot — receipt summary', () => {
  it('S-DSC-1: carries format/mime/bytes/size plus url/title when known', () => {
    const s = describeShot({
      format: 'jpeg', mime: 'image/jpeg', bytes: 12345,
      width: 1440, height: 900, url: 'https://example.com', title: 'Example',
    });
    expect(s).toMatchObject({
      format: 'jpeg', mime: 'image/jpeg', bytes: 12345,
      width: 1440, height: 900, url: 'https://example.com', title: 'Example',
      truncated: false,
    });
  });

  it('S-DSC-2: visible password input raises a warning (captureScreenshot does not redact)', () => {
    const s = describeShot({ hasVisiblePasswordInput: true });
    expect(s.warning).toContain('password');
    expect(describeShot({}).warning).toBeUndefined();
  });

  it('S-DSC-4: device_pixel_ratio passes through (clip is CSS px, output is device px)', () => {
    expect(describeShot({ devicePixelRatio: 2 }).device_pixel_ratio).toBe(2);
    expect(describeShot({}).device_pixel_ratio).toBeUndefined();
  });

  it('S-DSC-3: missing fields become null, not undefined (stable JSON shape)', () => {
    const s = describeShot({});
    expect(s.bytes).toBeNull();
    expect(s.width).toBeNull();
    expect(s.height).toBeNull();
  });
});

describe('constants', () => {
  it('S-CST-1: FORMATS matches the enum advertised in the MCP schema', () => {
    expect(FORMATS).toEqual(['png', 'jpeg', 'webp']);
  });

  it('S-CST-2: MAX_DATA_URL_CHARS is a sane ceiling (~512KB base64)', () => {
    expect(MAX_DATA_URL_CHARS).toBe(512 * 1024);
  });
});

// ---- P0-1 后续：path 落盘参数（此前传 path 被静默忽略）----
describe('normalizeScreenshotOpts — path (write to disk)', () => {
  it('S-OPT-PATH-1: absolute path is carried through', () => {
    const r = normalizeScreenshotOpts({ path: '/tmp/shot.png' });
    expect(r.ok).toBe(true);
    expect(r.opts.path).toBe('/tmp/shot.png');
  });

  it('S-OPT-PATH-2: absent/empty means "return base64 only"', () => {
    expect(normalizeScreenshotOpts({}).opts.path).toBeUndefined();
    expect(normalizeScreenshotOpts({ path: '' }).opts.path).toBeUndefined();
    expect(normalizeScreenshotOpts({ path: null }).opts.path).toBeUndefined();
  });

  it('S-OPT-PATH-3: wrong type is rejected, not silently ignored', () => {
    expect(normalizeScreenshotOpts({ path: 123 }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ path: '   ' }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ path: 123 }).error).toContain('path');
  });
});

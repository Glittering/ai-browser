// tests/test_screenshot_opts.js — 截图参数规范化单测
// 数据来源：ui.screenshot 接入时预想的典型误用（坏 format、越界 quality、
// clip/fullPage 同传、负坐标），以及现场需求（zoom 单元素、长页 jpeg 省钱）。
import { describe, it, expect } from 'vitest';
import {
  normalizeScreenshotOpts,
  describeShot,
  canUseSurface,
  pickShotTiers,
  joinShotFailures,
  surfaceMeta,
  FORMATS,
  SHOT_SOURCES,
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

// 取帧档位（2026-11-02）。事故：百度 / dumate 的 tab 上 ui.screenshot 报
// `captureScreenshot timeout after 20000ms`，而屏幕上是一帧正常画面 ——
// CDP 那条命令要在渲染进程主线程排队，页面脚本把主线程占死就没人接单。
// 位图本身在合成器手里，capturePage() 直接拷它就绕开排队。
describe('canUseSurface — 哪些请求能走 surface 档', () => {
  it('S-SRC-1: 整视口 png/jpeg 走 surface（这是绝大多数截图，也是超时的那一类）', () => {
    expect(canUseSurface({ format: 'png', fullPage: false })).toBe(true);
    expect(canUseSurface({ format: 'jpeg', quality: 85 })).toBe(true);
    expect(canUseSurface({})).toBe(true);
  });

  it('S-SRC-2: fullPage 不许走 surface —— captureBeyondViewport 要渲染进程给视口外的布局', () => {
    expect(canUseSurface({ fullPage: true })).toBe(false);
  });

  it('S-SRC-3: clip 不许走 surface —— CDP 的 clip 是文档坐标，位图只有当前视口那一帧，' +
    '本地裁剪会把两个坐标系混成一个（宁可慢，不要静默给错区域）', () => {
    expect(canUseSurface({ clip: { x: 0, y: 400, width: 300, height: 200, scale: 1 } })).toBe(false);
  });

  it('S-SRC-4: webp 不许走 surface —— nativeImage 只有 toPNG/toJPEG', () => {
    expect(canUseSurface({ format: 'webp' })).toBe(false);
  });

  it('S-SRC-5: 坏输入不炸（判据是"能不能走"，不是"参数合不合法"，合法性由 normalize 管）', () => {
    expect(canUseSurface(undefined)).toBe(true);
    expect(canUseSurface(null)).toBe(true);
    expect(canUseSurface('clip')).toBe(true);
  });

  it('S-SRC-6: source 参数只认 auto/surface/cdp，别的值当场给可读错误', () => {
    expect(normalizeScreenshotOpts({}).opts.source).toBe('auto');
    for (const v of SHOT_SOURCES) {
      expect(normalizeScreenshotOpts({ source: v }).opts.source).toBe(v);
    }
    expect(normalizeScreenshotOpts({ source: 'offscreen' }).ok).toBe(false);
    expect(normalizeScreenshotOpts({ source: 1 }).error).toContain('auto/surface/cdp');
    // null / undefined 是"未提供"，不是"传错类型"
    expect(normalizeScreenshotOpts({ source: null }).opts.source).toBe('auto');
  });
});

describe('surfaceMeta — surface 档怎么给出 CSS 尺寸与 dpr', () => {
  it('S-SRC-7: 位图是设备像素、视图 bounds 是 CSS 像素，比值就是 dpr', () => {
    expect(surfaceMeta({ width: 2528, height: 1322 }, { width: 1264, height: 661 }))
      .toEqual({ width: 1264, height: 661, devicePixelRatio: 2 });
  });

  it('S-SRC-8: bounds 不可用给空对象，回执退化成 width/height=null —— 不许瞎报一个尺寸', () => {
    expect(surfaceMeta({ width: 100, height: 50 }, null)).toEqual({});
    expect(surfaceMeta({ width: 100 }, { width: 0, height: 0 })).toEqual({});
    expect(surfaceMeta({}, { width: 1264, height: 661 })).toEqual({ width: 1264, height: 661 });
  });

  it('S-SRC-9: 非整数 dpr 保留三位（1.5 倍屏常见），不四舍五入成 2', () => {
    expect(surfaceMeta({ width: 1896 }, { width: 1264, height: 661 }).devicePixelRatio).toBe(1.5);
  });
});

describe('describeShot — 回执要交代帧是哪一档来的', () => {
  it('S-SRC-10: source 原样带出（调用方要知道这张图是不是"屏幕上的那一帧"）', () => {
    expect(describeShot({ source: 'surface' }).source).toBe('surface');
    expect(describeShot({ source: 'cdp' }).source).toBe('cdp');
    expect(describeShot({}).source).toBeUndefined();
  });

  it('S-SRC-11: surface 档探不到密码框时，warning 要说"这件事没查成"，不能当成"没有密码框"', () => {
    const skipped = describeShot({ passwordProbe: 'skipped' });
    expect(skipped.password_probe).toBe('skipped');
    expect(skipped.warning).toContain('may contain typed secrets');
    // 探到了就照旧：只有真的有密码框才警告
    expect(describeShot({ hasVisiblePasswordInput: true }).warning).toContain('password input');
    expect(describeShot({}).warning).toBeUndefined();
  });
});

// auto 档的顺序（2026-11-03 换了尺子）。旧判据是"有没有兄弟视图压在它上面"，
// 于是**窗口不显示**时算出"没被盖住"→ 先排 CDP 那条 20s 的队。实测那一格：
//   窗口隐藏 + 正在重绘的页 ：capturePage 57–107ms ✓  CDP 1.1–2.1s ✓
//   窗口隐藏 + 静态页       ：capturePage ✓           CDP 等到 20s deadline ✗
//   窗口隐藏 + 从没激活过的视图：capturePage 2–3ms 空图  CDP 20s ✗（这一帧确实不存在）
// agent 长期在隐藏窗口里干活，所以最该快的那一格长期走的是最慢的那条路。
describe('pickShotTiers — 只有「确定屏幕上就是这一帧」才让 CDP 优先', () => {
  const cases = [
    ['屏幕上就是这一页（可见 + activeTab）', { windowOnScreen: true, isActive: true }, ['cdp', 'surface']],
    ['被兄弟视图整个盖住（可见 + 后台）', { windowOnScreen: true, isActive: false }, ['surface', 'cdp']],
    ['窗口隐藏 —— 后台那一页', { windowOnScreen: false, isActive: false }, ['surface', 'cdp']],
    ['窗口隐藏 —— 连 activeTab 也不算"屏幕上这一帧"（这一格是旧判据漏的；最小化同理，' +
      '调用方把两者都归成 windowOnScreen=false）',
      { windowOnScreen: false, isActive: true }, ['surface', 'cdp']],
    ['可见性问不到：surface 先答不亏（几毫秒就给结论，CDP 仍是后手）',
      { windowOnScreen: null, isActive: true }, ['surface', 'cdp']],
    ['点名单一档绝不换档：只要 surface', { source: 'surface', windowOnScreen: true, isActive: true }, ['surface']],
    ['点名单一档绝不换档：只要 cdp', { source: 'cdp', windowOnScreen: false, isActive: false }, ['cdp']],
    ['坏输入不炸', undefined, ['surface', 'cdp']],
  ];
  for (const [name, st, want] of cases) {
    it(`S-TIER: ${name}`, () => {
      expect(pickShotTiers(st)).toEqual(want);
    });
  }
});

// 失败归因（同一个提交里修的第二件事）。旧实现两档往同一个 lastError 里写，后一档
// 覆盖前一档：隐藏窗口那一发明明白等了 CDP 的 20 秒，回执只剩"这一页从来没画过"。
describe('joinShotFailures — 每一档的失败理由都要活到回执里', () => {
  it('S-WHY-1: 两档都失败时两句都在，各自带 [tier] 前缀', () => {
    const s = joinShotFailures([
      { tier: 'surface', reason: 'no-surface-frame — this view has no readable surface' },
      { tier: 'cdp', reason: 'captureScreenshot timeout after 20000ms' },
    ]);
    expect(s).toContain('no-surface-frame');
    expect(s).toContain('[surface]');
    expect(s).toContain('captureScreenshot timeout after 20000ms');
    expect(s).toContain('[cdp]');
    expect(s.indexOf('[surface]'), '顺序跟着档位走，读的人才知道谁先谁后').toBeLessThan(s.indexOf('[cdp]'));
  });

  it('S-WHY-2: 只有一档时不加分隔符，也不许丢掉 [tier] 标记', () => {
    expect(joinShotFailures([{ tier: 'cdp', reason: 'cdp-unavailable' }])).toBe('[cdp] cdp-unavailable');
  });

  it('S-WHY-3: 空 reason / 坏形状不许混进回执（"两句理由"不能有一句是空的）', () => {
    expect(joinShotFailures([{ tier: 'surface', reason: '' }, { tier: 'cdp', reason: 'boom' }])).toBe('[cdp] boom');
    expect(joinShotFailures([null, undefined, '裸字符串'])).toBe('screenshot failed — no tier produced a frame');
    expect(joinShotFailures(undefined)).toBe('screenshot failed — no tier produced a frame');
  });
});

// tests/test_media_doc.js — 「这条响应该显示，还是该下载」的判定口径。
//
// 这个模块的全部价值在两条边界上：
//   1. 能看的东西**不要**变成下载（用户点"证书下载"要的是看到证书）
//   2. 不该显示的东西**绝不**硬塞进页面（zip/exe 铺满一屏是一堆乱码）
// 所以白名单必须窄，且"没把握"时一律回到浏览器的默认行为（下载）。
import { describe, it, expect } from 'vitest';
import mediaDoc from '../src/shared/media_doc.cjs';

const {
  headerValue, mimeOf, dispositionOf, isRenderableMime,
  shouldRenderInline, stripDisposition, kindOf, humanSize,
  isPlaceholderUrl, placeholderTarget, isChromePageUrl,
} = mediaDoc;

/** Electron 的 responseHeaders 是 Record<string, string[]>。 */
const H = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [v]]));

describe('headerValue / mimeOf', () => {
  it('大小写不敏感（服务端写 Content-Type 还是 content-type 都见过）', () => {
    expect(headerValue(H({ 'Content-Type': 'image/png' }), 'content-type')).toBe('image/png');
    expect(headerValue(H({ 'content-type': 'image/png' }), 'Content-Type')).toBe('image/png');
  });
  it('去掉 charset 参数并转小写', () => {
    expect(mimeOf(H({ 'Content-Type': 'image/png;charset=UTF-8' }))).toBe('image/png');
    expect(mimeOf(H({ 'Content-Type': 'Application/PDF' }))).toBe('application/pdf');
  });
  it('没有 Content-Type → 空串（调用方据此判定"不知道，别动"）', () => {
    expect(mimeOf({})).toBe('');
    expect(mimeOf(null)).toBe('');
  });
});

describe('dispositionOf', () => {
  it('attachment / inline / 没有', () => {
    expect(dispositionOf(H({ 'Content-Disposition': 'attachment;filename=a.png' }))).toBe('attachment');
    expect(dispositionOf(H({ 'Content-Disposition': 'inline' }))).toBe('inline');
    expect(dispositionOf({})).toBe('none');
  });
  it('form-data 不是 attachment（别把无关响应当下载声明）', () => {
    expect(dispositionOf(H({ 'Content-Disposition': 'form-data; name="file"' }))).toBe('none');
  });
});

describe('isRenderableMime / shouldRenderInline', () => {
  it('图片 / 视频 / 音频 / PDF 算可显示', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg', 'application/pdf']) {
      expect(isRenderableMime(m), m).toBe(true);
    }
  });
  it('压缩包 / 安装包 / 文档 / 二进制流一律不算', () => {
    for (const m of ['application/zip', 'application/x-msdownload', 'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/csv', 'text/plain', 'application/json', '']) {
      expect(isRenderableMime(m), m).toBe(false);
    }
  });
  it('只有"能显示 + 声明了 attachment"才救 —— 本来就 inline 的不碰', () => {
    expect(shouldRenderInline(H({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment' }))).toBe(true);
    expect(shouldRenderInline(H({ 'Content-Type': 'image/png', 'Content-Disposition': 'inline' }))).toBe(false);
    expect(shouldRenderInline(H({ 'Content-Type': 'image/png' }))).toBe(false);
    // 关键反例：zip 带 attachment 时必须继续走下载
    expect(shouldRenderInline(H({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment' }))).toBe(false);
  });
});

describe('stripDisposition', () => {
  it('摘掉 attachment，其它头原样保留', () => {
    const src = H({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment;filename=a.png', 'Cache-Control': 'no-cache' });
    const { headers, changed } = stripDisposition(src);
    expect(changed).toBe(true);
    expect(mimeOf(headers)).toBe('image/png');
    expect(headerValue(headers, 'cache-control')).toBe('no-cache');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-disposition');
  });
  it('不修改入参（Electron 可能缓存同一个对象）', () => {
    const src = H({ 'Content-Disposition': 'attachment' });
    stripDisposition(src);
    expect(headerValue(src, 'content-disposition')).toBe('attachment');
  });
  it('没有该头时 changed=false 且返回原对象', () => {
    const src = H({ 'Content-Type': 'image/png' });
    const r = stripDisposition(src);
    expect(r.changed).toBe(false);
    expect(r.headers).toBe(src);
  });
});

describe('kindOf / humanSize', () => {
  it('分类用于结果页画图标/缩略图', () => {
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('audio/mpeg')).toBe('audio');
    expect(kindOf('application/pdf')).toBe('pdf');
    expect(kindOf('application/zip')).toBe('file');
    expect(kindOf('')).toBe('file');
  });
  it('大小格式化：未知不显示成 0B', () => {
    expect(humanSize(575069)).toBe('562KB');
    expect(humanSize(0)).toBe('大小未知');
    expect(humanSize(-1)).toBe('大小未知');
    expect(humanSize(NaN)).toBe('大小未知');
    expect(humanSize(1024 * 1024 * 3.4)).toBe('3.4MB');
  });
});

describe('占位页与自家页面判定', () => {
  it('识别"正在打开…"占位页（这是"为这次下载而开的标签页"的判据）', () => {
    expect(isPlaceholderUrl('file:///a/src/renderer/loading.html?url=https%3A%2F%2Fx%2Fa.png')).toBe(true);
    expect(isPlaceholderUrl('https://x.com/a.png')).toBe(false);
  });
  it('取出占位页的目标地址', () => {
    expect(placeholderTarget('file:///a/loading.html?url=https%3A%2F%2Fx%2Fa.zip')).toBe('https://x/a.zip');
    expect(placeholderTarget('file:///a/loading.html')).toBe('');
  });
  it('自家界面页（dl:* 通道只对它们放行）', () => {
    expect(isChromePageUrl('file:///a/src/renderer/download.html?name=x')).toBe(true);
    expect(isChromePageUrl('file:///a/src/renderer/tab_bar.html')).toBe(true);
    expect(isChromePageUrl('https://evil.example/renderer/download.html')).toBe(false);
    expect(isChromePageUrl('https://x.com/')).toBe(false);
  });
});

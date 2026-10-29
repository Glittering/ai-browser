// tests/test_icon_geometry.js — 应用图标"尺寸"的单测（纯 Node，不起 Electron）
//
// # 为什么图标也要测
//
// 2026-10-29 用户报"电脑里 icon 一会大一会小"。根因是两条渲染路径的几何不一致：
//
//   bundle 的 icns（打包版）      → macOS 图标网格 → 内容占 ~86.7%
//   dock.setIcon 的裸 PNG（源码）  → 不套网格     → 内容占 100%
//
// 这个差异**没有任何编译期或运行期报错**，肉眼也只在两种启动方式之间来回切才会
// 察觉。所以把它钉成数字：icon-dock.png 的内容占比必须落在系统网格上；同时用
// icon.png（满出血）做阳性对照，证明这条判据不是恒绿。
//
// 解码器 parse 失败不静默降级 —— 量不出来的数字比错的数字更危险。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contentBox, decodePng } = require('../scripts/icon_geometry.cjs');
const { GRID_CONTENT, GRID_TOL } = require('../scripts/check_icon.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 最小 PNG 编码器（只为造夹具；8bit RGBA，filter 0）---------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 造一张 size×size 的 RGBA 图：只在 [x,y,w,h] 区域内涂不透明红 */
function makePng(size, box) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    raw[off] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      const inside = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      raw[p] = 200; raw[p + 1] = 40; raw[p + 2] = 40;
      raw[p + 3] = inside ? 255 : 0;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('图标几何：解码与包围盒（ICON-01..03）', () => {
  it('ICON-01 满出血图的占比是 1.0', () => {
    const png = makePng(32, { x: 0, y: 0, w: 32, h: 32 });
    const b = contentBox(png);
    expect(b.ratio).toBeCloseTo(1, 5);
    expect(b.opaque).toBe(false);
  });

  it('ICON-02 居中留白能精确量出来（半宽 = 0.5）', () => {
    const png = makePng(32, { x: 8, y: 8, w: 16, h: 16 });
    const b = contentBox(png);
    expect(b.ratio).toBeCloseTo(0.5, 5);
    expect(b.x).toBe(8);
    expect(b.y).toBe(8);
  });

  it('ICON-03 完全透明的图不该报 1.0（阴性对照：观测能看见"什么都没有"）', () => {
    const png = makePng(16, null);
    expect(contentBox(png).ratio).toBe(0);
  });

  it('ICON-03b 非 PNG 输入直接抛错，不返回编造的数字', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/PNG/i);
  });
});

describe('图标几何：build/ 里的真实产物（ICON-04..05）', () => {
  const pngPath = path.join(ROOT, 'build', 'icon.png');
  const dockPath = path.join(ROOT, 'build', 'icon-dock.png');

  it('ICON-04 icon.png 是满出血母版（icns 与窗口图标的源）', () => {
    expect(fs.existsSync(pngPath), '先跑 npm run icon').toBe(true);
    const ratio = contentBox(fs.readFileSync(pngPath)).ratio;
    expect(ratio).toBeGreaterThan(0.99);
  });

  it('ICON-05 icon-dock.png 落在 macOS 图标网格上（这正是不再"一会大一会小"的判据）', () => {
    expect(fs.existsSync(dockPath), '先跑 npm run icon').toBe(true);
    const ratio = contentBox(fs.readFileSync(dockPath)).ratio;
    // 只有这一条还不够 —— 见 ICON-05b 的阳性对照
    expect(Math.abs(ratio - GRID_CONTENT)).toBeLessThanOrEqual(GRID_TOL);
  });

  it('ICON-05b 阳性对照：满出血的 icon.png 会被同一条判据判为不合格', () => {
    const full = contentBox(fs.readFileSync(pngPath)).ratio;
    expect(Math.abs(full - GRID_CONTENT)).toBeGreaterThan(GRID_TOL);
  });

  it('ICON-05c Dock 图必须真的比母版小一圈（不是把同一个文件复制过来）', () => {
    const dock = contentBox(fs.readFileSync(dockPath)).ratio;
    const full = contentBox(fs.readFileSync(pngPath)).ratio;
    expect(dock).toBeLessThan(full);
  });
});

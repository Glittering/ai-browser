'use strict';
// scripts/icon_geometry.cjs — 量一个图标 PNG 里「画出来的东西」占画布多大。
//
// # 为什么需要量这个
//
// macOS 26/27 给应用图标套了一层统一的图标网格（artwork 里再留出边距、套 squircle）。
// 于是**同一个图标经过两条渲染路径，尺寸不一样**：
//
//   · bundle 的 icns（打包版）  → 系统按网格缩放，实测内容占 85.9%
//   · dock.setIcon 的裸 PNG（源码启动）→ 系统原样铺满，占 100%
//
// 85.9% 不是拍出来的：Safari / Finder 在同一口径下也都是 85.9%。所以"占 85.9%"
// 才是"和系统图标一样大"。100% 的那条会明显比旁边图标大一圈 —— 用户看到的就是
// "图标一会大一会小"（取决于这次是从 /Applications 启动还是 npm start）。
//
// 这个模块只做一件事：把 PNG 解出来，算 alpha 的包围盒占比。纯 Node，不调系统
// 工具，所以既能被 scripts/check_icon.cjs 用，也能被 vitest 直接跑。
//
// 支持范围：8bit、非隔行、colorType 0/2/4/6（灰/RGB/灰A/RGBA）。图标链上所有
// PNG 都落在这个范围里；超出范围直接抛错，不静默返回 1.0 —— 一个量不出来的
// 数字比一个错的数字更危险。

const zlib = require('node:zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解 PNG，返回 { width, height, channels, data }，data 是去掉过滤后的原始像素。
 * 位深必须 8，不能是隔行（图标链上不会出现这两种）。
 */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG (bad signature)');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) throw new Error(`unsupported PNG color type: ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * 内容包围盒。返回 { x, y, w, h, ratio, ratioW, ratioH }：
 *   ratio = 内容宽度 / 画布宽度（0~1）
 * 没有 alpha 通道（colorType 0/2）时视为整块不透明 —— 调用方多半拿它比"有没有留白"，
 * 不透明图没有留白可言，返回 1 是诚实的。
 */
function contentBox(buf, { alphaThreshold = 2 } = {}) {
  const { width, height, channels, data } = decodePng(buf);
  const hasAlpha = channels === 4 || channels === 2;
  if (!hasAlpha) {
    return { x: 0, y: 0, w: width, h: height, ratio: 1, ratioW: 1, ratioH: 1, opaque: true };
  }
  const alphaOff = channels === 4 ? 3 : 1; // RGBA / 灰A
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      if (data[row + x * channels + alphaOff] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, ratio: 0, ratioW: 0, ratioH: 0, opaque: false };
  const w = maxX - minX + 1, h = maxY - minY + 1;
  return {
    x: minX, y: minY, w, h,
    ratio: w / width,      // 老字段，等价于 ratioW
    ratioW: w / width,
    ratioH: h / height,
    opaque: false,
  };
}

module.exports = { decodePng, contentBox };

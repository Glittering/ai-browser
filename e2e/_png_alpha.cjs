// e2e/_png_alpha.cjs —— 解 Chromium 截出来的 PNG，只回答一个问题：
// **这张表面里有没有 alpha < 255 的像素。**
//
// # 为什么测试要自己解像素（2026-11-02）
//
// 所有标签页的视图都常驻窗口、叠在同一块 bounds 上，可见与否只由 z 序决定。
// z 序只决定"谁在上面"，不保证"上面那张不透"：活动标签页只要有一个透明像素，
// 它**下面那张视图**（= 另一个标签页）就从那个像素里照出来。事故现场是
// auth.smartedu.cn/uias/login（按 iframe 浮层设计，html/body 全透明）作为顶层
// 文档打开，自己那张帧 86.3% 的像素 alpha<255，用户看到"点登录，背景成了百度"。
//
// 这件事在 DOM、树、回执里**都没有痕迹** —— 页面自认画得好好的。唯一可证伪的
// 观测就是截帧的 alpha 通道，所以这里手写一个最小 PNG 解码器（8bit，五种 filter
// 全支持），而不是"看起来白就算对"。
'use strict';

const zlib = require('node:zlib');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * @param {Buffer|string} png Buffer 或 base64 字符串
 * @returns {{ok:boolean, width:number, height:number, colorType:number, hasAlphaChannel:boolean,
 *            transparent:number, opaque:number, error?:string}}
 */
function analyzePngAlpha(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(String(png), 'base64');
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) {
    return { ok: false, error: 'not-a-png', width: 0, height: 0, colorType: -1, hasAlphaChannel: false, transparent: 0, opaque: 0 };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const channels = CHANNELS[colorType];
  const hasAlphaChannel = colorType === 4 || colorType === 6;
  if (bitDepth !== 8 || !channels) {
    // 非 8bit / 调色板：Chromium 的截图不会走到这里。真走到了就如实报错，
    // 不许"解不出来 = 通过"。
    return { ok: false, error: `unsupported-png(bitDepth=${bitDepth},colorType=${colorType})`,
      width, height, colorType, hasAlphaChannel, transparent: 0, opaque: 0 };
  }

  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;

  let transparent = 0;
  let opaque = 0;
  const top = new Map();
  const pad2 = (n) => n.toString(16).padStart(2, '0');
  // colorType 2/6 才是真 RGB；0/3/4 是灰度，三个通道同值。Chromium 截图只会给 2/6，
  // 灰度这条分支是为了"万一换了编码也照样说得清这是哪一页"，不是为了好看。
  const rgbAt = (colorType === 2 || colorType === 6)
    ? (line, base) => pad2(line[base]) + pad2(line[base + 1]) + pad2(line[base + 2])
    : (line, base) => pad2(line[base]) + pad2(line[base]) + pad2(line[base]);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    if (hasAlphaChannel) {
      const ai = colorType === 6 ? 3 : 1;
      for (let x = 0; x < width; x++) {
        if (line[x * bpp + ai] < 255) transparent++; else opaque++;
      }
    } else {
      opaque += width;
    }
    // 主色调直方图（shot_ws 用它证明"截到的是这一页，不是压在它上面的另一个标签页"
    // —— 后台 tab 的表面如果被别人盖住，取错帧不会有任何报错，只会给你一张
    // **别人的**画面。这是本文件里唯一能发现它的手段）。
    // 只收前 256 种颜色：底色是大块连续区，一定进得来；抗锯齿边缘的成百上千种
    // 杂色不是要找一个页面"是谁"时需要分辨的东西。
    for (let x = 0; x < width; x++) {
      const k = rgbAt(line, x * bpp);
      if (top.size < 256 || top.has(k)) top.set(k, (top.get(k) || 0) + 1);
    }
    prev = line;
  }
  const dominant = [...top.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hex, count]) => ({ color: '#' + hex, count }));
  return { ok: true, width, height, colorType, hasAlphaChannel, transparent, opaque, dominant };
}

module.exports = { analyzePngAlpha };

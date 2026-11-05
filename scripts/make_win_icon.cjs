#!/usr/bin/env node
// scripts/make_win_icon.cjs — build/icon-dock.png（1024 母版）→ build/icon.ico（多尺寸）。
//
// 为什么需要它：Windows 的 exe / Setup.exe 图标只吃 .ico，而本项目只提交了 macOS 的
// icon.icns。缺 .ico 时 build_win / build_installer 会**静默**用 Electron 默认图标
// （两个脚本都是 `fs.existsSync(icoPath) ? icoPath : undefined`），产物看起来像
// "一个没做完的 Electron 壳"，而构建日志一个字都不会提。
//
// 为什么不用 ImageMagick / sharp：本机都没有。项目本来就带着一整个 Chromium，
// 用 Electron 的 nativeImage 缩放零新增依赖，和 render_icon.cjs 的思路一致。
//
// 用法（要 Electron，不是 node）：
//   node_modules/electron/dist/electron.exe scripts/make_win_icon.cjs
// 产物：build/icon.ico（16/24/32/48/64/128/256 七个尺寸，PNG 压缩载荷）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { nativeImage, app } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-dock.png');
const OUT = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(() => {
  if (!fs.existsSync(SRC)) {
    console.error('[ico] 找不到母版：' + SRC);
    app.exit(2);
    return;
  }
  const base = nativeImage.createFromPath(SRC);
  const { width, height } = base.getSize();
  if (!width || !height) {
    console.error('[ico] 母版读不出来：' + SRC);
    app.exit(2);
    return;
  }
  console.log(`[ico] 母版 ${width}x${height} → ${SIZES.join('/')}`);

  // 每个尺寸单独存 PNG（ICO 允许 PNG 载荷，Vista 起是标准做法，体积也最小）。
  const images = SIZES.map((size) => {
    const buf = base.resize({ width: size, height: size, quality: 'best' }).toPNG();
    console.log(`[ico]   ${size}x${size}  ${buf.length}B`);
    return { size, buf };
  });

  // ICONDIR(6) + ICONDIRENTRY*n(16) + 各个 PNG
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = 1 (icon)
  header.writeUInt16LE(images.length, 4);  // count
  let offset = header.length;
  images.forEach((img, i) => {
    const p = 6 + 16 * i;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, p);      // 0 表示 256
    header.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1);
    header.writeUInt8(0, p + 2);            // palette
    header.writeUInt8(0, p + 3);            // reserved
    header.writeUInt16LE(1, p + 4);         // color planes
    header.writeUInt16LE(32, p + 6);        // bits per pixel
    header.writeUInt32LE(img.buf.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += img.buf.length;
  });

  fs.writeFileSync(OUT, Buffer.concat([header, ...images.map((i) => i.buf)]));
  console.log('[ico] 写入 ' + OUT + ' (' + fs.statSync(OUT).size + 'B)');
  app.exit(0);
}).catch((e) => {
  console.error('[ico] 失败：' + (e && e.message));
  app.exit(1);
});

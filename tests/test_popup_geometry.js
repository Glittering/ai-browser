// tests/test_popup_geometry.js — window.open 特性 → 视图几何的纯函数表驱动单测
// 数据来源：站点实际写法（登录框/支付码常用 width=420,height=520,left=...）、
// Chrome 的弹窗判据（只有尺寸类特性才算弹窗）、以及"窗口被缩小"这个必现的后续状态。
import { describe, it, expect } from 'vitest';
import {
  parseFeatures,
  wantsPopup,
  popupRect,
  clampRect,
  MIN_WIDTH,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
} from '../src/shared/popup_geometry.cjs';

// 一个 1264×661 的内容区（视图坐标系，y 已含 39px 标签栏）——和项目里真实窗口一致。
const BOX = { x: 0, y: 39, width: 1264, height: 661 };

describe('parseFeatures — 两种来源都要折成同一张表', () => {
  it('PG-01 站点特性串：分号/逗号/空格都收，键小写', () => {
    expect(parseFeatures('width=420, height=520')).toEqual({ width: '420', height: '520' });
    expect(parseFeatures('width=420;height=520;top=80')).toEqual({ width: '420', height: '520', top: '80' });
    expect(parseFeatures('WIDTH=420')).toEqual({ width: '420' });
  });

  it('PG-02 没有值的裸开关（popup / noopener 这种写法）→ true，不是 undefined', () => {
    expect(parseFeatures('popup')).toEqual({ popup: true });
    expect(parseFeatures('width=420,noopener')).toEqual({ width: '420', noopener: true });
  });

  it('PG-03 Electron 的 details.features 是对象，值可能是 boolean 或字符串', () => {
    expect(parseFeatures({ width: '420', popup: true, menubar: 'no' })).toEqual({ width: '420', popup: true, menubar: 'no' });
    expect(parseFeatures({ Width: '420' })).toEqual({ width: '420' });
    expect(parseFeatures({ width: undefined, height: null })).toEqual({});
  });

  it('PG-04 空/非字符串/非对象都当"没有特性"，不许抛', () => {
    expect(parseFeatures('')).toEqual({});
    expect(parseFeatures(null)).toEqual({});
    expect(parseFeatures(undefined)).toEqual({});
    expect(parseFeatures(42)).toEqual({});
  });
});

describe('wantsPopup — 判据照 Chrome：只有请求了尺寸才算弹窗', () => {
  it.each([
    ['', false],
    ['noopener', false],
    ['noopener,noreferrer', false],          // 这两个不是尺寸，Chrome 也开新标签页
    ['menubar=no,status=no', false],
    ['width=420', true],
    ['height=520', true],
    ['width=420,height=520', true],
    ['popup=yes', true],
    ['popup=1', true],
    ['popup', true],
    ['popup=no', false],
    ['popup=0', false],
  ])('PG-05 %s → %s', (feat, want) => {
    expect(wantsPopup(feat)).toBe(want);
  });

  it('PG-06 解不出数字的 width 不算尺寸请求（width=auto 不该弹成 100×100）', () => {
    expect(wantsPopup('width=auto')).toBe(false);
    expect(wantsPopup('width=abc,height=520')).toBe(true);   // height 仍是真尺寸
    expect(wantsPopup({ width: true })).toBe(false);          // boolean 不是数字
  });

  it('PG-07 对象形式同样判', () => {
    expect(wantsPopup({ width: '420', height: '520' })).toBe(true);
    expect(wantsPopup({ noopener: true })).toBe(false);
  });
});

describe('popupRect — 请求的几何折成可用区里的矩形', () => {
  it('PG-08 给全 left/top 就用，坐标含可用区原点（y 不会跑到标签栏上）', () => {
    expect(popupRect('width=420,height=520,left=100,top=80', BOX))
      .toEqual({ x: 100, y: 39 + 80, width: 420, height: 520 });
  });

  it('PG-09 没给位置就居中（可复现，不用级联偏移）', () => {
    const r = popupRect('width=420,height=520', BOX);
    expect(r.x).toBe(Math.round((BOX.width - 420) / 2));
    expect(r.y).toBe(BOX.y + Math.round((BOX.height - 520) / 2));
  });

  it('PG-10 只给一个尺寸：另一个取缺省量级，而不是整屏（整屏等于没修）', () => {
    const wOnly = popupRect('width=420', BOX);
    expect(wOnly.width).toBe(420);
    expect(wOnly.height).toBe(Math.min(DEFAULT_HEIGHT, BOX.height));
    const hOnly = popupRect('height=520', BOX);
    expect(hOnly.height).toBe(520);
    expect(hOnly.width).toBe(DEFAULT_WIDTH);
  });

  it('PG-11 比可用区还大的请求夹到可用区（不许盖住标签栏，也不许自己带滚动条）', () => {
    const r = popupRect('width=99999,height=99999,left=0,top=0', BOX);
    expect(r).toEqual({ x: 0, y: 39, width: BOX.width, height: BOX.height });
  });

  it('PG-12 小于 100 的尺寸抬到下限（站点写 width=50 多半是笔误）', () => {
    const r = popupRect('width=50,height=50', BOX);
    expect(r.width).toBe(MIN_WIDTH);
    expect(r.height).toBe(MIN_WIDTH);
  });

  it('PG-13 位置越界夹回可用区：右侧/下方溢出保留可见部分，负值不吞成 0', () => {
    const right = popupRect('width=420,height=520,left=9000,top=0', BOX);
    expect(right.x).toBe(BOX.width - 420);
    const below = popupRect('width=420,height=520,left=0,top=9000', BOX);
    expect(below.y).toBe(BOX.y + BOX.height - 520);
    expect(popupRect('width=420,height=520,left=-80,top=-80', BOX)).toEqual({ x: 0, y: 39, width: 420, height: 520 });
  });

  it('PG-14 不是弹窗 / 可用区无效 → null，由调用方按整号标签页处理', () => {
    expect(popupRect('noopener', BOX)).toBeNull();
    expect(popupRect('', BOX)).toBeNull();
    expect(popupRect('width=420', null)).toBeNull();
    expect(popupRect('width=420', { x: 0, y: 39, width: 0, height: 661 })).toBeNull();
  });

  it('PG-15 可用区比下限还窄时不会算出负坐标（夹的上界低于下界也要有解）', () => {
    const tiny = { x: 0, y: 39, width: 60, height: 60 };
    const r = popupRect('width=420,height=520,left=10,top=10', tiny);
    expect(r).toEqual({ x: 0, y: 39, width: 60, height: 60 });
  });
});

describe('clampRect — 窗口缩放时把已存的弹窗矩形夹回可用区', () => {
  const R = popupRect('width=420,height=520,left=700,top=100', BOX);

  it('PG-16 幂等：同一个可用区再夹一次结果不变', () => {
    expect(clampRect(R, BOX)).toEqual(R);
    expect(clampRect(clampRect(R, BOX), BOX)).toEqual(R);
  });

  it('PG-17 可用区变小：位置挪回来、尺寸最多缩到还能放下，不许跑出窗口', () => {
    const small = { x: 0, y: 39, width: 500, height: 300 };
    const r = clampRect(R, small);
    expect(r.x).toBe(500 - 420);
    expect(r.y).toBe(39 + 300 - 300);
    expect(r.width).toBe(420);
    expect(r.height).toBe(300);   // 300 < 520：只能缩
  });

  it('PG-18 可用区变大不把弹窗放大回去（它请求的就是那个尺寸）', () => {
    const big = { x: 0, y: 39, width: 2000, height: 1400 };
    const r = clampRect(R, big);
    expect(r.width).toBe(420);
    expect(r.height).toBe(520);
    expect(r.x).toBe(R.x);
    expect(r.y).toBe(R.y);
  });

  it('PG-19 底部横幅出现（可用区矮了 44px）时弹窗仍然完整可见', () => {
    const withBanner = { x: 0, y: 39, width: 1264, height: 661 - 44 };
    const r = clampRect(R, withBanner);
    expect(r.y + r.height).toBeLessThanOrEqual(withBanner.y + withBanner.height);
  });

  it('PG-20 无效输入不抛（box 缺字段 / rect 是脏数据都返回 null 或夹好的矩形）', () => {
    expect(clampRect(R, {})).toBeNull();
    expect(clampRect(null, BOX)).toEqual({ x: 0, y: 39, width: BOX.width, height: BOX.height });
    expect(clampRect({ width: 'abc', height: 'abc' }, BOX))
      .toEqual({ x: 0, y: 39, width: BOX.width, height: BOX.height });
  });
});

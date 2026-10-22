// tests/test_editors_probe.js — 默认读法（DOM）的编辑器消歧索引。
//
// 与 tests/test_ax_editors.js 覆盖同一件事的两条通路。为什么两条都要测：
// AX 路径与 DOM 路径的口径一旦分叉，同一个页面在 ax:true / 默认下会给出
// 相反的 primary —— 那比没有索引更糟（agent 会以为自己选对了）。
import { describe, it, expect } from 'vitest';
import { buildEditorsIndex, EDITORS_PROBE_JS } from '../src/shared/editors_probe.js';

const row = (o) => ({
  ref: 'e:1', role: 'textbox', editor_type: 'textbox',
  w: 300, h: 40, label: '', placeholder: '', readonly: false, type: 'text', ...o,
});

describe('buildEditorsIndex', () => {
  const PAGE = [
    row({ ref: 'e:search', w: 300, h: 36, placeholder: '搜索你感兴趣的内容', type: 'search' }),
    row({ ref: 'e:title', w: 720, h: 44, placeholder: '请输入标题' }),
    row({ ref: 'e:body', w: 720, h: 600, editor_type: 'richtext', type: '' }),
  ];

  it('EP-1 按面积降序，最大且非搜索的那个拿 primary', () => {
    const out = buildEditorsIndex(PAGE, new Set(['e:search', 'e:title', 'e:body']));
    expect(out.map((e) => e.ref)).toEqual(['e:body', 'e:title', 'e:search']);
    expect(out[0].primary).toBe(true);
    expect(out.filter((e) => e.primary)).toHaveLength(1);
  });

  it('EP-2 搜索框带 searchlike，且不参与 primary 竞争', () => {
    const out = buildEditorsIndex(PAGE, new Set(['e:search', 'e:title', 'e:body']));
    const s = out.find((e) => e.ref === 'e:search');
    expect(s.searchlike).toBe(true);
    expect(s.primary).toBeUndefined();
  });

  it('EP-3 少于两个有效编辑区 → null（没有歧义就不输出）', () => {
    expect(buildEditorsIndex([PAGE[2]], null)).toBeNull();
    expect(buildEditorsIndex([], null)).toBeNull();
    expect(buildEditorsIndex(null, null)).toBeNull();
    expect(buildEditorsIndex({ __err: 'boom' }, null)).toBeNull();
  });

  it('EP-4 树里不存在的 ref 被过滤（探针是全局扫的）', () => {
    const out = buildEditorsIndex(PAGE, new Set(['e:body', 'e:search']));
    expect(out.map((e) => e.ref)).toEqual(['e:body', 'e:search']);
  });

  it('EP-5 1px / 隐藏元素被过滤', () => {
    const out = buildEditorsIndex([
      row({ ref: 'e:a', w: 1, h: 1 }),
      row({ ref: 'e:b', w: 600, h: 400 }),
      row({ ref: 'e:c', w: 600, h: 300 }),
    ], null);
    expect(out.map((e) => e.ref)).toEqual(['e:b', 'e:c']);
  });

  it('EP-6 只读的不拿 primary，次大的可写者接手', () => {
    const out = buildEditorsIndex([
      row({ ref: 'e:ro', w: 900, h: 700, readonly: true }),
      row({ ref: 'e:rw', w: 600, h: 400 }),
    ], null);
    expect(out.find((e) => e.ref === 'e:ro').readonly).toBe(true);
    expect(out.find((e) => e.ref === 'e:rw').primary).toBe(true);
  });

  it('EP-7 上限 8 条，area 不外露', () => {
    const many = Array.from({ length: 12 }, (_, i) => row({ ref: 'e:' + i, h: 100 + i }));
    const out = buildEditorsIndex(many, null);
    expect(out).toHaveLength(8);
    expect(out[0].area).toBeUndefined();
  });

  it('EP-8 全是搜索框时不给 primary（首页场景）', () => {
    const out = buildEditorsIndex([
      row({ ref: 'e:a', w: 400, h: 40, role: 'searchbox' }),
      row({ ref: 'e:b', w: 320, h: 36, placeholder: '站内搜索' }),
    ], null);
    expect(out.every((e) => !e.primary)).toBe(true);
  });

  it('EP-9 探针脚本可被解析，且只读（不含 setAttribute / innerHTML 赋值）', () => {
    expect(() => new Function('return ' + EDITORS_PROBE_JS)).not.toThrow();
    expect(EDITORS_PROBE_JS).not.toMatch(/setAttribute|innerHTML\s*=|\.value\s*=/);
    expect(EDITORS_PROBE_JS).toMatch(/data-ai-id/);
  });
});

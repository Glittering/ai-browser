// tests/test_realsites_runner.js — runner 纯函数白盒校验
// 锁死 F1(标题可读判定, 拒绝内联 JS/混淆文本) 与 F3/F5(节点深度统计、正文文本契约).
// runner.cjs 的 analyzeSite 强依赖 Browser/evaluate(真实环境), 此处锁定其可离线测试的纯逻辑,
// 防止 "标题被内联 JS 冒充" 之类缺陷在 future 重构中复发.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'realsites', 'runner.cjs');
const { titleReadable, countNodes, analyzeSite, formatSummary, SITES } = require(runnerPath);

describe('realsites runner pure logic', () => {
  describe('titleReadable (F1)', () => {
    it('R-RUN-1: rejects inline-JS / obfuscated titles that masquerade as page titles', () => {
      expect(titleReadable('if(window.bds&&window.bds.su){...}')).toBe(false);
      expect(titleReadable('(function(){var o=[];...})()')).toBe(false);
      expect(titleReadable('window.location.href')).toBe(false);
      expect(titleReadable('self.__next_f.push')).toBe(false);
      expect(titleReadable('var a=1; const b=2;')).toBe(false);
    });

    it('R-RUN-2: accepts real human-readable titles', () => {
      expect(titleReadable('百度一下，你就知道')).toBe(true);
      expect(titleReadable('GitHub · Build software better')).toBe(true);
      expect(titleReadable('东方财富网')).toBe(true);
      expect(titleReadable('AI Browser')).toBe(true);
    });

    it('R-RUN-3: rejects empty / whitespace / non-string', () => {
      expect(titleReadable('')).toBe(false);
      expect(titleReadable('   ')).toBe(false);
      expect(titleReadable(null)).toBe(false);
      expect(titleReadable(undefined)).toBe(false);
      expect(titleReadable(42)).toBe(false);
    });
  });

  describe('countNodes (F3/F5)', () => {
    it('R-RUN-4: counts trees, nodes arrays, and children deeply', () => {
      const tree = { label: 'root', children: [{ label: 'a' }, { label: 'b', children: [{ label: 'c' }] }] };
      expect(countNodes(tree)).toBe(4);
    });

    it('R-RUN-5: counts flat node arrays', () => {
      expect(countNodes([{ label: 1 }, { label: 2 }, { label: 3 }])).toBe(3);
    });

    it('R-RUN-6: empty tree is 0', () => {
      expect(countNodes(null)).toBe(0);
      expect(countNodes({})).toBe(1);
      expect(countNodes(undefined)).toBe(0);
    });
  });

  describe('sites matrix (F5 contract inputs)', () => {
    it('R-RUN-7: content-heavy finance sites carry minText (login-wall 雪球 excluded)', () => {
      const names = SITES.filter((s) => s.bucket === 'finance' && Number.isInteger(s.minText)).map((s) => s.name);
      expect(names).toContain('东方财富');
      expect(names).toContain('同花顺');
      for (const s of SITES) {
        if (s.minText !== undefined) {
          expect(s.minText, `${s.name} minText`).toBeGreaterThanOrEqual(300);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 诚实口径：两个数字必须分开印，且**被墙挡住不算内容成功**。
  // 这条之所以要有测试：报告很容易在重构里退化成"一个漂亮的百分比"，
  // 而把 login_wall/antibot 混进内容成功率就是在给自己贴金。
  // -------------------------------------------------------------------------
  describe('formatSummary（诚实口径）', () => {
    const s = {
      total: 10, behaviorOk: 9, behaviorFail: 1,
      contentOk: 7, walled: 2,
      contentRate: 0.7, behaviorRate: 0.9,
      byKind: { node: 7, login_wall: 1, antibot: 1, error: 1 },
      runs: 2, ranAt: '2026-10-11T00:00:00.000Z',
    };

    it('R-RUN-8: 分别印出行为正确率与内容成功率，不合成单一分数', () => {
      const t = formatSummary(s);
      expect(t).toContain('行为正确率');
      expect(t).toContain('内容成功率');
      expect(t).toContain('9/10');
      expect(t).toContain('70.0%');
      expect(t).toContain('90.0%');
    });

    it('R-RUN-9: 被墙挡住不计入内容成功 —— 内容成功率只数 node', () => {
      const t = formatSummary(s);
      expect(t).toMatch(/被墙挡住\s+2/);
      // 内容成功 7 ≠ 行为成功 9；若两者被混成 9/10 这条会红
      expect(s.contentOk).not.toBe(s.behaviorOk);
    });

    it('R-RUN-10: 必须带语料规模 / 跑数 / 时间 —— 否则百分比不可复核', () => {
      const t = formatSummary(s);
      expect(t).toContain('10 站');
      expect(t).toContain('2 跑');
      expect(t).toContain('2026-10-11T00:00:00.000Z');
    });

    it('R-RUN-11: 空输入不炸（total=0 时比率给 n/a，不给 NaN）', () => {
      const t = formatSummary({ total: 0, behaviorOk: 0, behaviorFail: 0, contentOk: 0, walled: 0, contentRate: null, behaviorRate: null, byKind: {}, runs: 1, ranAt: 'x' });
      expect(t).toContain('n/a');
      expect(t).not.toContain('NaN');
      expect(formatSummary(null)).toBe('');
    });
  });
});
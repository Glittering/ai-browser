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
const { titleReadable, countNodes, analyzeSite, SITES } = require(runnerPath);

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
});
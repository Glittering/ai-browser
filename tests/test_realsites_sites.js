// tests/test_realsites_sites.js — 站点矩阵结构白盒校验（表驱动输入锁定）
// 防止"加站加出坏行"：每行字段类型/取值合法、URL 唯一、站点数满足下界。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sitesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'realsites', 'sites.cjs');
const { BUCKETS } = require(sitesPath);
const SITES = require(sitesPath).default || require(sitesPath);

const list = Array.isArray(SITES) ? SITES : SITES.filter((s) => s && typeof s === 'object');

describe('realsites sites matrix integrity', () => {
  it('R-META-1: has at least 17 sites (Phase 3 lower bound)', () => {
    expect(list.length).toBeGreaterThanOrEqual(17);
  });

  it('R-META-2: every site has a non-empty name and http(s) url', () => {
    for (const s of list) {
      expect(typeof s.name).toBe('string');
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(typeof s.url).toBe('string');
      expect(s.url).toMatch(/^https?:\/\//);
    }
  });

  it('R-META-3: every site has a known bucket', () => {
    expect(Array.isArray(BUCKETS)).toBe(true);
    for (const s of list) {
      expect(BUCKETS).toContain(s.bucket);
    }
  });

  it('R-META-4: every site has an integer minNodes >= 1', () => {
    for (const s of list) {
      expect(Number.isInteger(s.minNodes)).toBe(true);
      expect(s.minNodes).toBeGreaterThanOrEqual(1);
    }
  });

  it('R-META-5: loginWall / antiBot, when present, are booleans', () => {
    for (const s of list) {
      if ('loginWall' in s) expect(typeof s.loginWall).toBe('boolean');
      if ('antiBot' in s) expect(typeof s.antiBot).toBe('boolean');
    }
  });

  it('R-META-6: site urls are unique (no duplicated target)', () => {
    const urls = list.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
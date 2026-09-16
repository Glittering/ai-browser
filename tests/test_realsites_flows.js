// tests/test_realsites_flows.js — 专项流程结构白盒校验
// 锁死 F6 复发：入口登记的专项必须全部存在于 flows.cjs（防误删 multiTab 等导致
// 默认 `npm run realsites` 崩溃）；并校验每个专项是可调用函数。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'realsites', 'flows.cjs');
const flows = require(flowsPath);

// 与 e2e/e2e_realsites.cjs 中登记的专项保持一致
const EXPECTED = ['baiduFollowFirstResult', 'zhihuCreatorProbe', 'multiTab', 'githubSearch'];

describe('realsites flows integrity', () => {
  it('R-FLOW-1: entry-registered flows all exist and are callable', () => {
    for (const name of EXPECTED) {
      expect(flows[name], `missing flow: ${name}`).toBeTypeOf('function');
    }
  });

  it('R-FLOW-2: no stray null/undefined flows creep in', () => {
    for (const [k, v] of Object.entries(flows)) {
      expect(v, `flow ${k} must be a function`).toBeTypeOf('function');
    }
    expect(Object.keys(flows).length).toBeGreaterThanOrEqual(EXPECTED.length);
  });
});
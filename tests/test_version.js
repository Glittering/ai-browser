import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION } from '../src/shared/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version: pkgVersion } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('version single-source consistency', () => {
  it('package.json "version" matches src/shared/version.js', () => {
    expect(
      pkgVersion,
      [
        `版本号漂移：package.json 是 "${pkgVersion}"，src/shared/version.js 导出的是 "${VERSION}"。`,
        '运行时版本号由 src/shared/version.js 提供（mcp_server.js 把它报给 MCP 客户端），',
        '而发版 / GitHub issue 模板 / 用户手动安装时看的是 package.json 的版本。',
        '两处一旦漂移，issue 里报的版本号就是错的 —— 维护者会照着一个根本不存在的版本去查问题，',
        '复现环境和真实环境对不上，排查直接跑偏。',
        '恢复方式：把两处改成同一个值（以 src/shared/version.js 为准，同步改 package.json 的 "version"）。',
      ].join('\n')
    ).toBe(VERSION);
  });

  it('package.json "version" is a non-empty semver string', () => {
    expect(
      typeof pkgVersion === 'string' && pkgVersion.trim() !== '',
      [
        `package.json 的 "version" 当前是 ${JSON.stringify(pkgVersion)}，不是非空字符串。`,
        '发版脚本和 issue 模板直接读这个字段，缺失或非字符串会让报出来的版本号变成 undefined，',
        '等于丢掉定位问题最重要的上下文。',
        '恢复方式：把 "version" 写成 "主版本.次版本.修订号" 形式的字符串，并与 src/shared/version.js 保持一致。',
      ].join('\n')
    ).toBe(true);
  });

  it('adheres to the v1.1.x semver scheme', () => {
    expect(VERSION).toMatch(/^1\.1\.\d+$/);
  });
});
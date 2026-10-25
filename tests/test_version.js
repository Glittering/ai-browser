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

  it('package-lock.json 的版本号与 package.json 一致', () => {
    // 锁文件的 "version" 字段 npm 自己不校验，但它**会被 npm install 改**：
    // 发版时只改 package.json、忘了锁文件，下一次任何人 install 就把工作区弄脏，
    // 发版脚本的前置检查（工作区必须干净）随即卡住 —— 2026-10-25 真的卡了一轮。
    // 锁文件里有两处（顶层 + packages[""]），两处都得对。
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const bad = [];
    if (lock.version !== pkgVersion) bad.push(`顶层 version=${lock.version}`);
    const rootPkg = (lock.packages || {})[''] || {};
    if (rootPkg.version !== pkgVersion) bad.push(`packages[""].version=${rootPkg.version}`);
    expect(
      bad.length === 0,
      [
        `package-lock.json 与 package.json 版本号不一致（package.json=${pkgVersion}）：${bad.join('，')}。`,
        '恢复方式：把锁文件里这两处改成与 package.json 相同的值（或跑一次 `npm install --package-lock-only`）。',
      ].join('\n')
    ).toBe(true);
  });

  it('major 版本 ≥ 2 时必须同时存在迁移文档', () => {
    // 首个公开发布是 v1.2.0。2026-10-19 起进入 v2（标签页工具合并为 browse_tabs），
    // 这是一次有意的破坏性变更 —— 所以这条断言从"必须留在 1.x"改成
    // "敢升 major，就必须写清楚怎么迁移"。
    // 没有迁移文档的 major 升级 = 让用户自己猜，那比不升级更糟。
    const major = Number(String(VERSION).split('.')[0]);
    expect(Number.isInteger(major) && major >= 1).toBe(true);

    if (major >= 2) {
      const doc = path.join(root, `docs/MIGRATION_V${major}.md`);
      const exists = (() => {
        try {
          return readFileSync(doc, 'utf8').length > 200;
        } catch {
          return false;
        }
      })();
      expect(
        exists,
        `版本已经到 ${VERSION}，但找不到 docs/MIGRATION_V${major}.md（或内容太短）。\n` +
          '破坏性变更必须配迁移文档：用户要知道哪几个调用变了、怎么替换、哪些没变。'
      ).toBe(true);
    }
  });
});
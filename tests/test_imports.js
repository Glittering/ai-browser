// tests/test_imports.js — 静态校验：src/ 下每条本地具名导入都必须真实存在。
//
// 为什么需要它：删掉一个导出后忘了同步删调用方的 import，在 ESM 下是
// **模块链接期**的错误 —— 只有真正启动 Electron 才会炸（SyntaxError:
// does not provide an export named ...）。`npm test` 完全测不到，因为
// 单测从不 import 主进程文件。这个坑真实发生过一次（watchdog 的
// shouldDeferRelaunch 被删后 index.js 仍导入它，导致 app 起不来）。
//
// 纯文本扫描，不 import 任何主进程模块（那些依赖 electron，无法在单测里加载）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 收集一个模块对外暴露的所有名字（具名导出 + default）。 */
function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const add = (re, group = 1) => {
    for (const m of src.matchAll(re)) names.add(m[group]);
  };
  add(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g);
  add(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/);
      const exposed = (alias[1] || alias[0] || '').trim();
      if (exposed) names.add(exposed);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

/** 抽出 `{ a, b as c } from './x.js'` 里的原始名（as 之前）。 */
function namedImportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    found.push({ spec: m[2], names });
  }
  return found;
}

describe('src/ 模块导入完整性', () => {
  const files = walk(SRC_ROOT);

  it('扫到了源文件（防止路径写错导致空跑通过）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [path.relative(SRC_ROOT, f), f]))(
    '%s 的本地具名导入都真实存在',
    (_rel, file) => {
      for (const { spec, names } of namedImportsOf(file)) {
        if (!spec.startsWith('.')) continue; // electron / node: 内置，跳过
        const target = path.resolve(path.dirname(file), spec);
        expect(fs.existsSync(target), `${file} 导入了不存在的 ${spec}`).toBe(true);
        if (!fs.existsSync(target)) continue;
        const available = exportsOf(target);
        for (const n of names) {
          expect(
            available.has(n),
            `${path.relative(SRC_ROOT, file)} 从 ${spec} 导入了 ${n}，但该模块没有导出它。` +
              ` 要么补回导出，要么删掉调用方的 import —— 否则 ESM 链接期会直接抛 SyntaxError，app 起不来。`
          ).toBe(true);
        }
      }
    }
  );
});

// 门 2：`.cjs` 模块必须能被真的 require 起来。
//
// 为什么单独一条：上面的门只扫 `.js` 的 ESM 具名导入。`src/preload/*.cjs` 与
// `src/shared/*.cjs` 走的是 CommonJS，**没有任何静态检查**覆盖它们 —— 一个语法
// 错误、或者 `module.exports = undefined`，单测全绿（没人 import 它），直到真机
// 跑起来才炸，而那时错误在渲染器里，主进程日志里什么都没有。
describe('.cjs 模块可加载', () => {
  const cjs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.cjs')) cjs.push(full);
    }
  })(SRC_ROOT);

  it('C-0 确实扫到了 .cjs（否则下面的用例会空转成绿灯）', () => {
    expect(cjs.length).toBeGreaterThan(5);
  });

  // bridge.cjs 在模块顶层就要 `require('electron').contextBridge`，而 vitest 里
  // 没有 Electron —— 它的加载方式由 tests/test_bridge_surface.js 用 vm + fake
  // require 承担。这里**显式**跳过并钉住名单，防止以后有人顺手把别的文件也加进来。
  const SKIP = new Set(['preload/bridge.cjs']);
  const loadable = cjs.filter((f) => !SKIP.has(path.relative(SRC_ROOT, f)));

  it('C-1 跳过名单只允许这一个文件（新增必须写理由）', () => {
    expect([...SKIP]).toEqual(['preload/bridge.cjs']);
  });

  it.each(loadable.map((f) => [path.relative(SRC_ROOT, f), f]))('%s 能被 require 且有导出', (_rel, file) => {
    const mod = require(file);
    const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
    expect(
      keys.length,
      `${_rel} 没有导出任何东西（module.exports 为空/undefined）—— 调用方拿到的全是 undefined`
    ).toBeGreaterThan(0);
  });
});

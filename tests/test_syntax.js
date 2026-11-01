// test_syntax.js — 语法闸门：`src/` 下每一个文件都必须能被 Node 解析。
//
// # 为什么需要它（2026-11-01，审计 C17「无 lint/类型检查」的最小替代）
//
// `npm test` 会 import 大部分 `src/**/*.js`，但**不是全部**：
//   · `src/main/index.js` 只能由 Electron 加载，单测从不碰它 —— 里面写错一个
//     括号，整个应用起不来，而 CI 全绿；
//   · `src/preload/*.cjs` 走 require 的那条闸门（test_imports 的 C 段）能覆盖，
//     但 `src/renderer/*.html` 里的内联脚本不在任何检查里；
//   · 只在某些分支才 require 的模块（例如打包脚本 require 的、`--selftest`
//     路径上的）平时也不被 import。
//
// 不引入 eslint（20k 行存量代码会一次报几千条，等于把它关掉），只做**能解析**
// 这一条 —— 它能抓住的是"语法错误 / 括号不配对 / 非法字符"这类"提交了就挂"的
// 问题，恰好是单测覆盖不到的那部分。
//
// 判据是行为化的：真的起 `node --check`，而不是 grep。

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'bin'];
const EXTS = new Set(['.js', '.cjs', '.mjs']);

function collect() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          // node_modules 只可能在 bin/ 下（有的话），跳过
          if (e.name === 'node_modules') continue;
          walk(full);
        } else if (EXTS.has(path.extname(e.name))) {
          out.push(full);
        }
      }
    };
    walk(abs);
  }
  return out.sort();
}

describe('src/ 与 bin/ 的每个文件都能被 Node 解析', () => {
  const files = collect();

  it('S-0 确实扫到了文件（否则下面的用例会空转成绿灯）', () => {
    expect(files.length, '一个文件都没扫到 —— 目录结构变了？').toBeGreaterThan(40);
  });

  it('S-1 没有语法错误', () => {
    const bad = [];
    for (const f of files) {
      try {
        // `node --check` 按 package.json 的 type 决定解析模式：.js → ESM，
        // .cjs → CommonJS。它只解析、不执行，所以可以对着 Electron-only 的文件跑。
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', timeout: 10000 });
      } catch (e) {
        const msg = String((e.stderr && e.stderr.toString()) || e.message || e).trim();
        bad.push(path.relative(ROOT, f) + '\n' + msg.split('\n').slice(0, 4).join('\n'));
      }
    }
    expect(bad, '这些文件 Node 都解析不了（单测可能从未 import 它们）：\n' + bad.join('\n\n')).toEqual([]);
  }, 120000);
});

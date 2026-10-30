// tests/test_asar_verify.js — Bug 8 的行为判据。
//
// 原来的 test_bug8 是源码 grep（`expect(src).toContain('@vitest')`）：只要黑名单
// 里出现这几个字就算过，无论这条正则实际匹配什么。而这条正则恰恰在真实产物上
// 出过两次事故：
//   1. `dist` 用任意层级匹配，把**依赖自己的 dist/** 删了（@modelcontextprotocol/sdk
//      677 个文件只剩 3 个），而 grep 型判据全绿；
//   2. 改成 `^` 锚死后，packager 传进来的路径带前导 `/`，整条规则静默失效，
//      体积从 12.5MB 涨到 89MB（outputs/ 的取证截图全打进去了）。
//
// 所以这里一律把 build 脚本里的正则**真求值**，拿真实路径去 test；入口解析与
// asar 校验也用真 asar 夹具跑，不看源码字符串。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import verifyAsar from '../scripts/verify_asar.cjs';

const { entryCandidates, verifyAsarDeps } = verifyAsar;

/**
 * 造 asar 夹具必须走**干净 env 的子进程**：本机（以及 CI 的受管环境）会通过
 * NODE_OPTIONS 注入一个 fs 代理，它对 createWriteStream 做 token 校验，
 * @electron/asar 写 asar 必然失败。build_dmg.cjs 顶部为此专门重启了自己一遍，
 * 单测里则用 env.NODE_OPTIONS='' 的子进程绕开 —— 不然这条判据在任何受管环境都跑不了。
 */
function createAsar(src, dest) {
  const code = "require('@electron/asar').createPackage(" + JSON.stringify(src) + ', ' + JSON.stringify(dest) + ')'
    + ".then(()=>process.exit(0)).catch(e=>{console.error(e && e.message);process.exit(1)})";
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (r.status !== 0) throw new Error('createPackage 失败: ' + (r.stderr || r.stdout || r.status));
}
const ROOT = process.cwd();

/** 把 build 脚本里的 `const IGNORE = new RegExp(...)` 真求值成 RegExp。 */
function ignoreOf(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const marker = 'const IGNORE = new RegExp(';
  const i = src.indexOf(marker);
  expect(i, `${rel} 里找不到 IGNORE`).toBeGreaterThan(-1);
  const start = i + marker.length - 1;
  let depth = 0;
  let inStr = null;
  let end = -1;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { end = k; break; } }
  }
  expect(end, `${rel} 的 IGNORE 括号没配平`).toBeGreaterThan(start);
  const expr = src.slice(start, end + 1);
  const re = new Function('return new RegExp' + expr)();
  expect(re).toBeInstanceOf(RegExp);
  return re;
}

describe('Bug 8 — 打包黑名单的实际匹配行为', () => {
  const dmg = ignoreOf('scripts/build_dmg.cjs');
  const win = ignoreOf('scripts/build_win.cjs');

  it('A8-01: 顶层垃圾目录必须被排除（路径带前导 / 也要命中，packager 就是这么传的）', () => {
    for (const p of ['/outputs/verify/x.png', '/tools/_oneoff/a.png', '/dist/x', '/docs/a.md',
      '/tests/a.js', '/e2e/a.cjs', '/build/icon.png', '/.git/config', '/.workbuddy/memory/x.md']) {
      expect(dmg.test(p), `build_dmg 没排除 ${p}`).toBe(true);
      expect(win.test(p), `build_win 没排除 ${p}`).toBe(true);
    }
  });

  it('A8-02: 依赖自己的 dist/ 绝不能被排除（历史事故：674/677 文件丢失）', () => {
    for (const p of [
      '/node_modules/@modelcontextprotocol/sdk/dist/esm/index.js',
      '/node_modules/ajv/dist/ajv.js',
      '/node_modules/boolean/build/lib/index.js',
      '/node_modules/hono/dist/index.js',
    ]) {
      expect(dmg.test(p), `build_dmg 误删了依赖代码 ${p}`).toBe(false);
      expect(win.test(p), `build_win 误删了依赖代码 ${p}`).toBe(false);
    }
  });

  it('A8-03: 运行时依赖与源码必须保留，dev 工具链必须排除', () => {
    for (const keep of ['/node_modules/ws/index.js', '/node_modules/zod/lib/index.js', '/src/main/index.js', '/package.json']) {
      expect(dmg.test(keep), `误删了必须保留的 ${keep}`).toBe(false);
    }
    for (const drop of ['/node_modules/electron/package.json', '/node_modules/@vitest/runner/x.js',
      '/node_modules/vitest/dist/cli.js', '/node_modules/@types/node/index.d.ts',
      '/node_modules/jsdom/lib/api.js', '/node_modules/@electron/packager/x.js']) {
      expect(dmg.test(drop), `没排除 dev 依赖 ${drop}`).toBe(true);
    }
  });
});

describe('Bug 8 — 入口解析与 asar 校验', () => {
  it('A8-04: 入口解析要递归条件导出（pkce-challenge 的 exports[.].node.{import,require}）', () => {
    const cands = entryCandidates({
      exports: { '.': { types: { require: './dist/a.d.cts' }, node: { import: './dist/index.node.js', require: './dist/index.node.cjs' } } },
    });
    expect(cands).toContain('dist/index.node.cjs');
    expect(cands).toContain('dist/index.node.js');
  });

  it('A8-05: 入口解析要认 main（含无扩展名形态）', () => {
    expect(entryCandidates({ main: './index' })).toEqual(['index']);
    expect(entryCandidates({ main: 'lib/main.js' })).toEqual(['lib/main.js']);
    expect(entryCandidates({})).toEqual([]);
  });

  it('A8-06: 真 asar 夹具 —— 入口文件缺了就报违规，完整就通过', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-asar-'));
    const pkgDir = path.join(tmp, 'node_modules', 'foo');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'foo', main: 'index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');

    const appDir = path.join(tmp, 'App.app', 'Contents', 'Resources');
    fs.mkdirSync(appDir, { recursive: true });
    const fullAsar = path.join(appDir, 'app.asar');
    createAsar(tmp, fullAsar);

    const okRes = verifyAsarDeps(path.join(tmp, 'App.app'), { sourceNodeModules: path.join(tmp, 'node_modules') });
    expect(okRes.ok, JSON.stringify(okRes.violations)).toBe(true);

    // 造一份"包只剩 package.json"的坏产物 —— 历史事故的形态
    const brokenSrc = path.join(tmp, 'broken');
    fs.mkdirSync(path.join(brokenSrc, 'node_modules', 'foo'), { recursive: true });
    fs.copyFileSync(path.join(pkgDir, 'package.json'), path.join(brokenSrc, 'node_modules', 'foo', 'package.json'));
    const brokenResDir = path.join(brokenSrc, 'App.app', 'Contents', 'Resources');
    fs.mkdirSync(brokenResDir, { recursive: true });
    createAsar(brokenSrc, path.join(brokenResDir, 'app.asar'));

    const badRes = verifyAsarDeps(path.join(brokenSrc, 'App.app'), { sourceNodeModules: path.join(tmp, 'node_modules') });
    expect(badRes.ok).toBe(false);
    expect(badRes.violations.some((v) => v.pkg === 'foo')).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('A8-07: 源路径对照必须真的生效（pkgDir 已含 node_modules/，不能再拼一层）', () => {
    // 回归：曾经 path.join(srcNM, 'node_modules/foo') → node_modules/node_modules/foo，
    // 于是"源里有没有"恒为 false，整条闸门永远绿。
    const res = verifyAsarDeps(path.join(ROOT, 'dist', 'AI Browser-darwin-arm64', 'AI Browser.app'));
    if (res.skippedReason) return;            // 没打过包就跳过
    if (!res.asar) return;
    expect(res.checked).toBeGreaterThan(10);  // 至少扫到了若干包
  });
});

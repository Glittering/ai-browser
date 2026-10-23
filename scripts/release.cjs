#!/usr/bin/env node
// scripts/release.cjs — 一条命令走完发版闭环：版本号 → 测试 → commit → tag →
// push(GitHub) → npm publish → MCP registry publish。
//
// 为什么要这个脚本（而不是每次手工敲 8 条命令）：
//   发版最容易漏的不是编译，是**同步**。版本号有 4 处（package.json、
//   server.json 两处、src/shared/version.js），GitHub 有 2 条分支 + 1 个 tag，
//   发布有 2 个仓库（npm、MCP registry）。漏一处不会报错，只会让用户在
//   issue 里报一个不存在的版本、或者让 npx 拉到的还是旧版 —— 而且要到
//   下一次有人装的时候才发现。机器不会漏，人会。
//
// 用法：
//   node scripts/release.cjs patch          # 2.1.2 → 2.1.3
//   node scripts/release.cjs minor --dry    # 只看会做什么
//   node scripts/release.cjs patch --notes notes.txt
//
// 设计原则：**每一步失败都不静默**。git 成功但 npm 失败时，脚本以非零退出并
// 打印"已完成的步骤 + 怎么补救"，而不是假装整条链路都成功了。
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const bumpKind = args.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';
const notesIdx = args.indexOf('--notes');
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null;
// 全量测试 4 分钟起，发版时默认只跑"会拦住错误发版"的那几个：
// 版本一致性、导入完整性、schema 预算。其余靠 CI / 平时。
const fullTests = args.includes('--full-test');

const c = (s) => `\x1b[${s}m`;
const ok = (m) => console.log(`${c(32)}✓${c(0)} ${m}`);
const warn = (m) => console.log(`${c(33)}!${c(0)} ${m}`);
const fail = (m) => console.log(`${c(31)}✗${c(0)} ${m}`);
const step = (m) => console.log(`\n${c(36)}▸ ${m}${c(0)}`);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${argv.join(' ')} 失败:\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return r;
}
function git(...argv) { return run('git', argv); }
function gitOut(...argv) { return run('git', argv).stdout.trim(); }

// registry 的 github 登录可以吃环境变量，从而绕开 device flow ——
// device flow 在无 TTY / 后台执行时会静默卡在 "Logging in..." 不打印 URL，
// 看起来像卡死，实际是在等一个永远不会被打开的浏览器。
function ghToken() {
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

const done = [];
function mark(m) { done.push(m); }

// ---- 0. 前置检查 ----------------------------------------------------------
step('前置检查');
const branch = gitOut('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main' && branch !== 'dev') {
  fail(`当前分支是 ${branch}，发版只允许在 main 或 dev 上做`);
  process.exit(1);
}
const dirty = gitOut('status', '--porcelain');
if (dirty) {
  fail('工作区不干净，先提交或 stash：');
  console.log(dirty.split('\n').map((l) => '    ' + l).join('\n'));
  process.exit(1);
}
ok(`分支 ${branch}，工作区干净`);

// ---- 1. 版本号 ------------------------------------------------------------
step('计算并写入版本号');
const pkgPath = path.join(ROOT, 'package.json');
const serverPath = path.join(ROOT, 'server.json');
const verPath = path.join(ROOT, 'src', 'shared', 'version.js');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const from = pkg.version;
const [maj, min, pat] = from.split('.').map(Number);
const to = bumpKind === 'major' ? `${maj + 1}.0.0`
  : bumpKind === 'minor' ? `${maj}.${min + 1}.0`
  : `${maj}.${min}.${pat + 1}`;
console.log(`    ${from} → ${to} (${bumpKind})`);

if (dry) {
  warn('--dry：只打印，不写文件、不提交、不发布');
  process.exit(0);
}

function rewrite(file, fn) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${file} 没发生替换 —— 版本号格式变了？请人工确认`);
  fs.writeFileSync(p, after);
}
rewrite('package.json', (s) => s.replace(`"version": "${from}"`, `"version": "${to}"`));
// server.json 里有两处（顶层 + packages[0]），必须都改：只改顶层会让
// registry 认为"清单说 2.1.3、实际包是 2.1.2"，校验直接不通过。
rewrite('server.json', (s) => s.split(`"version": "${from}"`).join(`"version": "${to}"`));
rewrite('src/shared/version.js', (s) => s.replace(`VERSION = '${from}'`, `VERSION = '${to}'`));
ok('4 处版本号已同步（package.json / server.json×2 / version.js）');
mark('版本号');

// ---- 2. 测试 --------------------------------------------------------------
step(fullTests ? '全量测试' : '发版闸门测试');
const testFiles = fullTests
  ? []
  : ['tests/test_version.js', 'tests/test_imports.js', 'tests/test_api_budget.js', 'tests/test_mcp_tools.js'];
const t = spawnSync('npx', ['vitest', 'run', ...testFiles, '--no-file-parallelism'], {
  cwd: ROOT, encoding: 'utf8',
});
if (t.status !== 0) {
  fail('测试未通过，发版中止。版本号改动已写在工作区，可用 git checkout 撤销。');
  console.log((t.stdout || '').split('\n').slice(-25).join('\n'));
  process.exit(1);
}
ok('测试通过');
mark('测试');

// ---- 3. commit + tag ------------------------------------------------------
step('提交并打 tag');
const notes = notesFile && fs.existsSync(path.join(ROOT, notesFile))
  ? fs.readFileSync(path.join(ROOT, notesFile), 'utf8').trim()
  : `v${to}`;
git('add', 'package.json', 'server.json', 'src/shared/version.js');
git('commit', '-m', `chore(release): v${to}`);
ok(`commit chore(release): v${to}`);
mark('commit');

// tag 打在 main 上（历史 v2.1.x 都在 main）。dev 上发版就先 ff 到 main。
if (branch === 'dev') {
  git('checkout', 'main');
  try { git('merge', '--ff-only', 'dev'); } catch (e) {
    fail('main 无法快进到 dev（有分叉），需要人工处理。tag 未创建。');
    git('checkout', 'dev');
    process.exit(1);
  }
  ok('main 已快进到 dev');
}
git('tag', '-a', `v${to}`, '-m', notes);
ok(`tag v${to}`);
mark('tag');

// ---- 4. push --------------------------------------------------------------
step('推送到 GitHub');
try {
  git('push', 'origin', 'main');
  git('push', 'origin', 'dev');
  git('push', 'origin', `v${to}`);
  ok('main / dev / tag 已推送');
  mark('git push');
} catch (e) {
  fail('推送失败（网络或权限）：' + String(e.message).split('\n')[0]);
  warn(`本地 commit 与 tag 都在，网络恢复后执行：git push origin main dev v${to}`);
}

// ---- 5. npm ---------------------------------------------------------------
step('发布到 npm');
const npm = spawnSync('npm', ['publish'], { cwd: ROOT, encoding: 'utf8' });
if (npm.status === 0) {
  ok(`@glittering0717/ai-browser@${to} 已发布`);
  mark('npm publish');
} else {
  const out = `${npm.stdout || ''}${npm.stderr || ''}`;
  // 三层认证失败的表现各不相同，逐条给可执行的下一步（2026-10-23 一天踩完）：
  //   401 / E404 on PUT  → token 过期或被撤销（npm 用 404 掩盖"没权限"）
  //   403 + "bypass 2fa" → token 有效但建的时候没勾 Bypass 2FA
  //   EPUBLISHCONFLICT  → 版本号已被占用
  if (/bypass 2fa enabled is required/i.test(out)) {
    fail('npm token 没有开 Bypass 2FA —— 账号开了 2FA 时，granular token 必须勾这个开关才能发布');
    console.log('      https://www.npmjs.com/settings/glittering0717/tokens/new');
    console.log('      Permissions: Read and write ｜ Scope: @glittering0717 ｜ 勾 Bypass 2FA');
  } else if (/E401|E404|Unauthorized|Not found/i.test(out)) {
    fail('npm 认证失效（401/404）。需要重新登录一次，之后本脚本可全自动：');
    console.log('      npm login                      # 浏览器登录');
    console.log('      或：把新的 granular access token 写进 ~/.npmrc 的 //registry.npmjs.org/:_authToken');
  } else if (/EPUBLISHCONFLICT|cannot publish over/i.test(out)) {
    fail(`npm 上已存在 ${to}，版本号需要再往上走一格`);
  } else {
    fail('npm publish 失败：' + out.split('\n').filter(Boolean).slice(-4).join(' | '));
  }
  warn(`补救：token 恢复后执行  npm publish  （当前目录版本已是 ${to}）`);
}

// ---- 6. MCP registry ------------------------------------------------------
step('发布到 MCP registry');
const publisher = ['mcp-publisher', '/tmp/mcp-pub/mcp-publisher', '/opt/homebrew/bin/mcp-publisher']
  .find((p) => { try { return fs.existsSync(p) || execFileSync('which', [p]).length > 0; } catch { return false; } });
if (!publisher) {
  warn('未找到 mcp-publisher，跳过。安装：gh release download --repo modelcontextprotocol/registry \\');
  console.log('      --pattern "mcp-publisher_darwin_arm64.tar.gz" && tar xzf ...');
} else {
  // registry 的登录态是一枚短期 JWT（几小时就过期）。过期表现是 401
  // "token has invalid claims: token is expired" —— 不是"没登录"，
  // 所以 `login` 会直接成功但不会有人去重跑它。这里自动续一次：
  // MCP_GITHUB_TOKEN 让 login 走非交互路径（device flow 在无 TTY 时会静默卡住）。
  const doPublish = () => spawnSync(publisher, ['publish'], { cwd: ROOT, encoding: 'utf8' });
  let pub = doPublish();
  let pubOut = `${pub.stdout || ''}${pub.stderr || ''}`;
  if (pub.status !== 0 && /expired|invalid or expired|status 401/i.test(pubOut)) {
    warn('registry 登录已过期，自动续期一次…');
    const relogin = spawnSync(publisher, ['login', 'github'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MCP_GITHUB_TOKEN: ghToken() },
    });
    const reloginOut = `${relogin.stdout || ''}${relogin.stderr || ''}`;
    if (relogin.status === 0 && /logged in/i.test(reloginOut)) {
      ok('已重新登录');
      pub = doPublish();
      pubOut = `${pub.stdout || ''}${pub.stderr || ''}`;
    } else {
      warn('自动续期失败（需要 gh CLI 已登录）：' + reloginOut.trim().split('\n').pop());
    }
  }
  if (pub.status === 0 && /successfully published/i.test(pubOut)) {
    ok('MCP registry 已发布');
    mark('mcp registry');
  } else {
    fail('MCP registry 发布失败：' + pubOut.split('\n').filter(Boolean).slice(-6).join(' | '));
    if (/was not found \(status: 404\)/i.test(pubOut)) {
      warn('registry 要求 npm 上先有该版本 —— 先把 npm 那步修好，再重跑本脚本');
    }
    warn('补救：mcp-publisher publish');
  }
}

// ---- 摘要 -----------------------------------------------------------------
console.log(`\n${c(36)}── v${to} 发版摘要 ──${c(0)}`);
console.log('   已完成: ' + (done.length ? done.join(' → ') : '（无）'));
const skipped = ['版本号', '测试', 'commit', 'tag', 'git push', 'npm publish', 'mcp registry']
  .filter((s) => !done.includes(s));
if (skipped.length) console.log(`   未完成: ${skipped.join(', ')}`);
process.exit(skipped.length ? 2 : 0);

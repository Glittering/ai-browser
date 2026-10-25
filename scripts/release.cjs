#!/usr/bin/env node
// scripts/release.cjs — 一条命令走完发版闭环：版本号 → 测试 → commit → tag →
// push(GitHub) → npm publish → MCP registry publish。
//
// 为什么要这个脚本（而不是每次手工敲 8 条命令）：
//   发版最容易漏的不是编译，是**同步**。版本号有 5 处（package.json、
//   package-lock 两处、server.json 两处、src/shared/version.js），GitHub 有 2 条分支 + 1 个 tag，
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
const notesArg = notesIdx >= 0 ? args[notesIdx + 1] : null;
// --notes 既接受仓库内相对路径，也接受绝对路径（写手稿时通常放在 /tmp）。
// path.join(ROOT, '/tmp/x') 会拼出 ROOT/tmp/x 这种不存在的路径，所以先判绝对。
const notesPath = notesArg ? (path.isAbsolute(notesArg) ? notesArg : path.join(ROOT, notesArg)) : null;
const notesFile = notesPath && fs.existsSync(notesPath) ? notesPath : null;
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
// package-lock 里的 version 字段（顶层 + packages[""]）也得改。npm 自己不校验它，
// 但任何人 `npm install` 一次就会把它刷成新值 —— 于是工作区变脏、下一次发版的
// 「前置检查」直接卡住（2026-10-25 就在这上面卡过一轮）。锁文件的两个 version
// 都替换；少了任何一处，下次 install 又会漂回去。
try {
  rewrite('package-lock.json', (s) => s.split(`"version": "${from}"`).join(`"version": "${to}"`));
} catch (e) {
  warn('package-lock.json 版本号未同步（可能本来就漂着）：' + String(e.message).split('\n')[0]);
}
ok('5 处版本号已同步（package.json / package-lock×2 / server.json×2 / version.js）');
mark('版本号');

// ---- 2. 测试 --------------------------------------------------------------
step(fullTests ? '全量测试' : '发版闸门测试');
const testFiles = fullTests
  ? []
  : ['tests/test_version.js', 'tests/test_imports.js', 'tests/test_api_budget.js', 'tests/test_mcp_tools.js', 'tests/test_release_loop.js'];
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
const notes = notesFile
  ? fs.readFileSync(notesFile, 'utf8').trim()
  : `v${to}`;
git('add', 'package.json', 'package-lock.json', 'server.json', 'src/shared/version.js');
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

// ---- 4.5 GitHub Release ---------------------------------------------------
// **tag ≠ Release**。git tag 只是仓库里的一个 ref，GitHub 的 /releases 页面
// 读的是 Release 对象；只打 tag 不建 Release，页面会一直停在很久以前的版本
// （2026-10-24 用户就是在这里发现"releases 还是 2.1.1"，而 tag 已经有 2.1.7）。
//
// 用 --generate-notes：GitHub 按 commit 自动生成 changelog，比手写更容易保持。
// 幂等：重复跑发版时该 tag 的 Release 已存在就跳过，不报错。
step('创建 GitHub Release');
let releaseOk = false;
{
  const hasGh = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasGh) {
    warn('未找到 gh CLI，跳过 Release 创建。补救：gh release create v' + to + ' --generate-notes');
  } else {
    const exists = spawnSync('gh', ['release', 'view', `v${to}`], { cwd: ROOT, encoding: 'utf8' }).status === 0;
    if (exists) {
      ok(`v${to} 的 Release 已存在，跳过`);
      releaseOk = true;
      mark('github release');
    } else {
      // 标题尽量带上人话摘要：notes 的第一行通常写成 "# v2.1.8 — xxx"，
      // 直接用它，releases 列表就不会是一串光秃秃的版本号。
      let releaseTitle = `v${to}`;
      const headLine = String(notes || '').split('\n')[0].replace(/^#+\s*/, '').trim();
      if (headLine.startsWith(`v${to}`) && headLine.length > `v${to}`.length) releaseTitle = headLine;
      const argv = ['release', 'create', `v${to}`, '--verify-tag', '--latest', '--title', releaseTitle];
      if (notesFile) {
        argv.push('--notes-file', notesFile);
      } else {
        argv.push('--generate-notes');
      }
      const r = spawnSync('gh', argv, { cwd: ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (r.status === 0) {
        ok('Release 已创建：' + out.split('\n').filter(Boolean).pop());
        releaseOk = true;
        mark('github release');
      } else {
        fail('创建 Release 失败：' + out.split('\n').filter(Boolean).slice(-3).join(' | '));
        warn(`补救：gh release create v${to} --verify-tag --latest --generate-notes`);
      }
    }
  }
}

// ---- 5. 打包（桌面 App）---------------------------------------------------
// 放在 npm 之前：打包失败就不该把版本发出去（npm 上发出去的版本撤不回来，
// 只能靠再发一个版本补救）。但 MCP registry 又要求 npm 先有版本，所以顺序
// 只能是 打包 → npm → MCP。
//
// 为什么"打包"必须在发版流程里（2026-10-24 事故）：修好标签栏滚动、测试
// 过、npm/GitHub/MCP 全绿发了 v2.1.4，但用户桌面上的 App 还是 10-19 打的
// v1.3.1 —— 因为打包是手工的。用户看到的是"你根本没修好"。任何"源码已修"
// 的说法，没有产物同步就是不成立的。
step('打包桌面 App');
{
  // NODE_OPTIONS 会被受管环境注入一个 fs 代理 shim，它拦截 asar 的
  // createWriteStream 写入（报 "Brokered file token refused: modify backup
  // failed"，且没有栈）。打包本身不联网、不碰沙箱，直接摘掉这个预加载。
  const buildEnv = { ...process.env };
  delete buildEnv.NODE_OPTIONS;
  const b = spawnSync(process.execPath, ['scripts/build_dmg.cjs'], {
    cwd: ROOT, encoding: 'utf8', env: buildEnv,
  });
  if (b.status === 0) {
    const line = (b.stdout || '').split('\n').filter((l) => /dmg:|size:/.test(l)).join(' ');
    ok('打包完成：' + line.trim());
    mark('打包');
  } else {
    fail('打包失败：' + (b.stdout || b.stderr || '').split('\n').filter(Boolean).slice(-4).join(' | '));
    warn('补救：修好后执行  node scripts/build_dmg.cjs  （npm 尚未发布，可继续发）');
  }

  // 产物与源码逐字节比对 + 版本一致性。这一步就是"防止再出现 App 落后
  // 好几个版本"的闸门：不通过就不该继续发布。
  const v = spawnSync(process.execPath, ['scripts/verify_build.cjs', '--quiet'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (v.status === 0) {
    ok('打包产物与源码一致');
    mark('打包校验');
  } else {
    fail('打包产物与源码不一致，发版中止（否则用户装的还是旧代码）：');
    console.log((v.stdout || '').split('\n').map((l) => '    ' + l).join('\n'));
    process.exit(1);
  }

  // 把 dmg 挂到 Release 上 —— 否则 /releases 页面只有一段 changelog，用户还得
  // 自己去找 App。上传放在校验之后：不一致的产物绝对不能对外发。
  const dmg = path.join(ROOT, 'dist', `AI-Browser-${to}-arm64.dmg`);
  if (releaseOk && fs.existsSync(dmg)) {
    const up = spawnSync('gh', ['release', 'upload', `v${to}`, dmg, '--clobber'], {
      cwd: ROOT, encoding: 'utf8',
    });
    if (up.status === 0) {
      ok(`dmg 已挂到 Release（${(fs.statSync(dmg).size / 1024 / 1024).toFixed(1)} MB）`);
      mark('release asset');
    } else {
      fail('dmg 上传失败：' + `${up.stdout || ''}${up.stderr || ''}`.trim().split('\n').slice(-2).join(' | '));
      warn(`补救：gh release upload v${to} ${dmg} --clobber`);
    }
  } else if (!fs.existsSync(dmg)) {
    warn('dmg 不存在，跳过上传');
  }
}

// ---- 6. npm ---------------------------------------------------------------
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
  } else if (pub.status !== 0 && /was not found \(status: 404\)/i.test(pubOut)) {
    // npm 刚发完，registry 的校验端还看不到新版本 —— 这是 npm CDN 的传播
    // 延迟（实测 1-3 分钟），不是真的没发上去。连续两次发版都在这里被打断
    // 叫回来手工重跑，所以直接自动等待重试。
    let ok404 = false;
    for (let i = 1; i <= 4; i++) {
      warn(`registry 还没看到 npm 上的 v${to}（传播延迟），45s 后重试 ${i}/4…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45000);
      pub = doPublish();
      pubOut = `${pub.stdout || ''}${pub.stderr || ''}`;
      if (pub.status === 0 && /successfully published/i.test(pubOut)) { ok404 = true; break; }
      // 错误形态变了（不再是传播延迟）就交回统一处理，别空转
      if (!/was not found \(status: 404\)/i.test(pubOut)) break;
    }
    if (ok404) { ok('MCP registry 已发布'); mark('mcp registry'); }
    else {
      const pkgName = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
      fail('MCP registry 发布失败：' + pubOut.split('\n').filter(Boolean).slice(-6).join(' | '));
      warn(`补救：确认 npm 上有 ${to}（npm view ${pkgName} version）后执行  mcp-publisher publish`);
    }
  } else {
    fail('MCP registry 发布失败：' + pubOut.split('\n').filter(Boolean).slice(-6).join(' | '));
    if (/auth|login|token|unauthor/i.test(pubOut)) {
      warn('需要先登录一次：mcp-publisher login github（device flow，点一下浏览器）');
    }
    warn('补救：登录后执行  mcp-publisher publish');
  }
}

// ---- 7. 装到本机 /Applications ---------------------------------------------
// 这是"用户真正会打开的那个副本"。不做这一步，前面所有步骤再绿，桌面上
// 跑的可能还是几个版本前的包（2026-10-24 事故）。
step('安装到 /Applications');
if (process.platform !== 'darwin') {
  warn('非 macOS，跳过（dmg 在 dist/）');
} else if (args.includes('--no-install')) {
  warn('--no-install：跳过安装，dist/ 里的 dmg 已就绪');
} else {
  const ins = spawnSync(process.execPath, ['scripts/install_app.cjs'], {
    cwd: ROOT, encoding: 'utf8',
  });
  const insOut = `${ins.stdout || ''}${ins.stderr || ''}`;
  if (ins.status === 0) {
    ok('已安装并启动（用户数据 ~/.ai-browser 未动，登录态保留）');
    mark('安装');
  } else {
    fail('安装失败：' + insOut.split('\n').filter(Boolean).slice(-3).join(' | '));
    warn('补救：node scripts/install_app.cjs  或手工拖 dist 里的 dmg');
  }
}

// ---- 8. 验收"装好的那个 App" ----------------------------------------------
// 前面每一步验的都是"仓库里的东西"：测试跑 dev 树、verify_build 比 asar 里的
// 字节。但用户双击的是 /Applications 里那个包，**没有人跑过它**。
// 2026-10-24 两次事故（App 落后 4 个版本 / 对话框修复只在 dev 生效）都出在这一层。
// 现在装完立刻用 e2e/shipped_ws.cjs 直接 spawn 这个包，跑对话框和多标签关键路径。
step('验收已安装的 App（在打包产物上跑，不是 dev 树）');
if (process.platform !== 'darwin' || args.includes('--no-install')) {
  warn('跳过（非 macOS 或 --no-install）');
} else {
  const vEnv = { ...process.env, AI_BROWSER_PORT: '9233' };
  delete vEnv.ELECTRON_RUN_AS_NODE;
  delete vEnv.NODE_OPTIONS;
  const vr = spawnSync(process.execPath, ['e2e/shipped_ws.cjs'], {
    cwd: ROOT, encoding: 'utf8', env: vEnv,
  });
  const vrOut = `${vr.stdout || ''}${vr.stderr || ''}`;
  const tally = (vrOut.match(/PASS=(\d+) FAIL=(\d+)/) || []).slice(1);
  if (vr.status === 0) {
    ok(`已安装的 App 通过验收（PASS=${tally[0] || '?'}）`);
    mark('产物验收');
  } else {
    fail(`已安装的 App 验收失败（PASS=${tally[0] || '?'} FAIL=${tally[1] || '?'}）—— 桌面上那个包的行为和源码不一致：`);
    console.log((vrOut.split('\n').filter((l) => /FAIL \||ERR|失败明细/.test(l)).slice(0, 12)).map((l) => '    ' + l).join('\n'));
    warn('补救：npm run verify:app  （默认验 /Applications/AI Browser.app，可用 AIB_APP= 指定）');
  }
}

// ---- 摘要 -----------------------------------------------------------------
console.log(`\n${c(36)}── v${to} 发版摘要 ──${c(0)}`);
console.log('   已完成: ' + (done.length ? done.join(' → ') : '（无）'));
const skipped = ['版本号', '测试', 'commit', 'tag', 'git push', 'github release', '打包', '打包校验', 'release asset', 'npm publish', 'mcp registry', '安装', '产物验收']
  .filter((s) => !done.includes(s));
if (skipped.length) console.log(`   未完成: ${skipped.join(', ')}`);
process.exit(skipped.length ? 2 : 0);

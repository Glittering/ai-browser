'use strict';
// e2e/run_all.cjs — 一次跑完所有 e2e 套件，并给出可信的汇总。
//
// 为什么需要它（2026-10-15 实测）：
//
//  1. 以前靠 shell：`node e2e/x.cjs | grep -oE "==== .* PASS=[0-9]+ FAIL=[0-9]+ ===="`。
//     那个正则要求 `==== ` 与 ` PASS` 之间至少隔一个字符（实际是两个空格），于是
//     `==== PASS=28 FAIL=0 ====`（view）和 `[modeldiff] PASS=12 FAIL=0` **永远
//     匹配不到**。输出空被我读成"套件崩溃了/没跑完"，进而误判成"串行跑会假红"。
//     —— 是观测手段坏了，不是产品坏了。现在只认 `PASS=n FAIL=m` 数字对，与
//     格式无关；解析不出摘要一律记为"未知"并判失败，绝不当成通过。
//
//  2. 每个套件分配**独立端口**。共用 9223 时会互相抢 Electron 的单实例锁和
//     WS 端口；即便没抢上，也有"连到上一个残留实例"的风险（见 _harness.cjs）。
//
// 用法：
//   node e2e/run_all.cjs                    # 全部套件
//   SUITES=smoke,network node e2e/run_all.cjs
//   BASE_PORT=9500 node e2e/run_all.cjs

const { execFile } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_PORT = Number(process.env.BASE_PORT) || 9410;

const SUITES = [
  'smoke', 'capabilities', 'richtext', 'network', 'value', 'canvas',
  'modeldiff', 'audit', 'nav', 'focus', 'interact', 'upload', 'view',
];

/**
 * 从套件输出里取最终摘要。只认 `PASS=<n> FAIL=<m>` 数字对，不依赖任何
 * `====` / 套件名 之类的装饰 —— 那正是上一次误判的根源。
 * 取**最后一个**（中途可能有分段小计）。
 * @returns {{pass:number, fail:number}|null} null = 没有摘要
 */
function parseVerdict(out) {
  const all = String(out || '').match(/PASS=(\d+)\s+FAIL=(\d+)/g);
  if (!all || !all.length) return null;
  const m = /PASS=(\d+)\s+FAIL=(\d+)/.exec(all[all.length - 1]);
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

function runOne(suite, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'e2e', suite + '_ws.cjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 420000,
      env: { ...process.env, AI_BROWSER_PORT: String(port) },
      maxBuffer: 40 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      resolve({
        suite, port, ms: Date.now() - t0,
        code: err ? (String(err.code) === 'TIMEOUT' ? 'TIMEOUT' : err.code) : 0,
        verdict: parseVerdict(out),
        fails: out.split('\n').filter((l) => l.indexOf('FAIL |') >= 0).map((l) => l.trim().slice(0, 180)),
        // 身份核对 / 端口占用 的拦截信息，出现就说明环境有问题
        notes: out.split('\n').filter((l) => /不是本次拉起的进程|一直被占用|is busy/.test(l)).map((l) => l.trim().slice(0, 180)),
      });
    });
  });
}

async function main() {
  const only = process.env.SUITES ? process.env.SUITES.split(',').map((s) => s.trim()).filter(Boolean) : SUITES;
  console.log('e2e 全量验收 —— 每个套件独立端口（base ' + BASE_PORT + '），共 ' + only.length + ' 个\n');

  const rows = [];
  for (let i = 0; i < only.length; i++) {
    const r = await runOne(only[i], BASE_PORT + i);
    rows.push(r);
    const v = r.verdict;
    const tag = v ? `PASS=${v.pass} FAIL=${v.fail}` : '无摘要(未知)';
    const ok = v && v.fail === 0 && r.code === 0;
    console.log(
      `${r.suite.padEnd(13)} port=${r.port} ${String(r.ms + 'ms').padEnd(8)} exit=${String(r.code).padEnd(6)} ${tag.padEnd(16)} ${ok ? '' : '  <<<'}`
    );
    r.fails.forEach((f) => console.log('      ! ' + f));
    r.notes.forEach((n) => console.log('      ~ ' + n));
  }

  const total = rows.reduce((a, r) => a + (r.verdict ? r.verdict.pass + r.verdict.fail : 0), 0);
  const totalFail = rows.reduce((a, r) => a + (r.verdict ? r.verdict.fail : 0), 0);
  // "没摘要"绝不能算通过 —— 上次就是把"没摘要"当成了"跑完了但崩溃"。
  const unknown = rows.filter((r) => !r.verdict).map((r) => r.suite);
  const bad = rows.filter((r) => !r.verdict || r.verdict.fail > 0 || r.code !== 0).map((r) => r.suite);

  console.log('\n' + '='.repeat(58));
  console.log(`套件 ${rows.length} 个 | 断言 ${total} 项 | 失败 ${totalFail}`);
  if (unknown.length) console.log('⚠️  无摘要（必须查，不能当通过）: ' + unknown.join(', '));
  console.log(bad.length ? '❌ 未通过: ' + bad.join(', ') : '✅ 全部通过');
  process.exit(bad.length ? 1 : 0);
}

module.exports = { parseVerdict, SUITES };

if (require.main === module) main();

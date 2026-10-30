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
  // 读能力不变量：受控页面 fixture，钉住「读不全就必须给出可执行 hint」
  'readcov',
  // window.open("") + location 赋值：钉住「派生出来的 tab 自己也得带垫片」，
  // 否则超星系站点在第二层再走同一条路就静默不跳转（2026-10-20 第三次复发）。
  'window_open',
  // 2026-10-25 补进来的三个：它们此前只在自己文件里，`e2e:all` 从没跑过 ——
  // 「加了套件但没进全量」等于没有套件。
  //   dialog  —— 浏览器级对话框（原生 sheet 阻塞渲染器）
  //   wrapper —— 「树里有、点不动」= 按文字命中了容器
  //   paint   —— 白屏自检（判定 / 阶梯 / 不误报）
  //   layout  —— 几何三等式 + 不抽搐（G4/G5）
  'dialog', 'wrapper', 'paint', 'layout',
  // download —— 「点下载」到底发生了什么：可显示的媒体文档不许变成下载、
  //             不可显示的不许把标签页留在"正在打开…"上（2026-10-27 证书事故）。
  'download',
  // multiagent —— 多个 agent 并用：各自的目标、互不干扰、目标被关掉要报错
  // background —— 窗口隐藏/最小化时全能力可用（无头式无人值守）
  'multiagent', 'background',
  // icon —— 应用图标的两条渲染路径必须同尺寸（bundle 的 icns vs 源码启动的
  //         dock.setIcon）。用户报"图标一会大一会小"就是这条不一致（2026-10-29）。
  'icon',
  // app_model —— 「实例关在闭包里」：capabilities{deep} 能不能把 fabric/Konva
  // 的模型挖出来并改正路线。单测跑在 jsdom 上，而 jsdom 的 getBoundingClientRect
  // 恒 0、没有真实事件链路 —— 「派发一条合成 mousemove 就能走到 tee」这个核心
  // 假设在那里是被 mock 兜住的，只有真浏览器能证伪它（2026-10-30）。
  'app_model',
  // lifecycle —— BrowserView 生命周期治理（2026-10-30 白屏事故）：视图悬空后
  // 不许击穿主进程、标签栏自动重建、横幅自动收敛。用 selftest=chrome-gone 受控
  // 复现，隐藏模式即可（与窗口可见性无关）。红→绿对照见套件头注释。
  'lifecycle',
  // flicker（帧级：加载时画面不许缩成一小块）**故意不在这里**：它要屏幕录制权限、
  // 窗口必须真的在屏幕上、且一轮要录 7 秒 × 3 轮。单独跑：`npm run flicker`。
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

// 端口被谁占着 —— "一直被占用"这句话如果不带 pid，排查要多花十分钟。
// 实测 2026-10-20：focus 套件按组跑三遍、每组 SIGTERM 后立刻 release，
// 留下三个实例占着 9609/9610/9611，后面 interact/upload 直接判"未知失败"，
// 看起来像这两个套件坏了，其实是上一个套件没收拾干净。
function portHolder(port) {
  try {
    const out = require('node:child_process')
      .execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = String(out).trim().split('\n')[0];
    return pid || null;
  } catch { return null; }
}

function runOne(suite, port) {
  const holderBefore = portHolder(port);
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'e2e', suite + '_ws.cjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 420000,
      env: { ...process.env, AI_BROWSER_PORT: String(port) },
      maxBuffer: 40 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const verdict = parseVerdict(out);
      resolve({
        suite, port, ms: Date.now() - t0, holderBefore,
        code: err ? (String(err.code) === 'TIMEOUT' ? 'TIMEOUT' : err.code) : 0,
        verdict,
        fails: out.split('\n').filter((l) => l.indexOf('FAIL |') >= 0).map((l) => l.trim().slice(0, 180)),
        // 没有摘要 = 套件没跑完（挂住/崩了）。这时候**最有用的就是它最后几行输出** ——
        // 以前这里什么都不留，只写"无摘要(未知)"，等于把唯一的线索扔了。
        tail: verdict ? [] : out.split('\n').filter((l) => l.trim()).slice(-12).map((l) => l.trim().slice(0, 200)),
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
    if (!v && r.tail && r.tail.length) {
      console.log('      ~ 最后几行输出（没有摘要时这是唯一线索）：');
      for (const l of r.tail) console.log('        | ' + l);
    }
    r.notes.forEach((n) => console.log('      ~ ' + n));
    // 起跑前端口就被别人占着 → 这套件根本没机会跑。必须说清是谁占的，
    // 否则结论是"这个套件坏了"，而真相是"上一个套件没收拾干净"。
    if (r.holderBefore) {
      console.log(`      ~ 起跑前 port=${r.port} 已被 pid ${r.holderBefore} 占用（不是本次拉起的，套件会拒绝跑）`);
    }
  }

  const total = rows.reduce((a, r) => a + (r.verdict ? r.verdict.pass + r.verdict.fail : 0), 0);
  const totalFail = rows.reduce((a, r) => a + (r.verdict ? r.verdict.fail : 0), 0);
  // "没摘要"绝不能算通过 —— 上次就是把"没摘要"当成了"跑完了但崩溃"。
  const unknown = rows.filter((r) => !r.verdict).map((r) => r.suite);
  // 端口被占 ≠ 产品坏了。分开报，否则"环境脏"会一直伪装成"代码回归"。
  const envBad = rows.filter((r) => r.holderBefore || r.notes.some((n) => /一直被占用/.test(n)))
    .map((r) => r.suite);
  const bad = rows.filter((r) => !r.verdict || r.verdict.fail > 0 || r.code !== 0).map((r) => r.suite);

  console.log('\n' + '='.repeat(58));
  console.log(`套件 ${rows.length} 个 | 断言 ${total} 项 | 失败 ${totalFail}`);
  if (unknown.length) console.log('⚠️  无摘要（必须查，不能当通过）: ' + unknown.join(', '));
  if (envBad.length) console.log('⚠️  环境未清理（端口起跑前就被占，套件没跑）: ' + envBad.join(', '));
  console.log(bad.length ? '❌ 未通过: ' + bad.join(', ') : '✅ 全部通过');
  process.exit(bad.length ? 1 : 0);
}

module.exports = { parseVerdict, SUITES };

if (require.main === module) main();

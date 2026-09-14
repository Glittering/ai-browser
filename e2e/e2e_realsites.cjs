// e2e/e2e_realsites.cjs — 真实驱动 AI Browser 的站点测试入口（表驱动）
// 1) 先跑矩阵三件套（e2e/realsites/runner.cjs）
// 2) 再按需跑专项流程（e2e/realsites/flows.cjs：百度进站 / 知乎创作 / 多标签）
// 用法：
//   node e2e/e2e_realsites.cjs            # 矩阵 + 全部专项
//   node e2e/e2e_realsites.cjs --flow zhihu|baidu|tabs   # 仅矩阵 + 指定专项
//   node e2e/e2e_realsites.cjs --runs 2   # 双跑（质量门）
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { runContract, SITES } = require('./realsites/runner.cjs');
const flows = require('./realsites/flows.cjs');
const { Browser } = require(path.join(__dirname, '..', 'tools/browser.cjs'));

const ROOT = path.resolve(__dirname, '..');
const WS_PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模块级记录本次自拉的 child（供超时/异常出口清理）；未自拉则为 null
let childRef = null;

function section(t) { console.log("\n" + "=".repeat(60) + "\n" + t + "\n" + "=".repeat(60)); }

// 端口探活：self-contained（对齐 smoke），未监听则 spawn Electron 并等待
function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    setTimeout(() => fin(false), 500);
  });
}
async function waitForPort(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await checkPort(port)) return true; await sleep(500); }
  return false;
}
async function ensureElectron() {
  if (await checkPort(WS_PORT)) return null;
  console.log('port 9223 未监听 — spawn Electron (npm start)');
  const child = spawn('npm', ['start'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  if (!(await waitForPort(WS_PORT, 30000))) { console.error('Electron 30s 内未起来'); return null; }
  return child;
}

// 清理本次自拉的 Electron（仅当 ensureElectron 返回了 child，即端口原本无人监听）。
// 避免脚本退出后留下孤儿 Electron 占用 9223，阻塞后续 npm run smoke。
function cleanupSpawned(child) {
  if (!child) return;
  pidof(WS_PORT).forEach((p) => { try { process.kill(p, 'SIGTERM'); } catch {} });
}
function pidof(port) {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    return out ? out.split('\n').map((s) => Number(s)).filter((n) => Number.isInteger(n)) : [];
  } catch { return []; }
}

async function main() {
  const child = await ensureElectron();
  childRef = child;
  if (!(await checkPort(WS_PORT))) { console.error('无法连接 9223 — 退出'); cleanupSpawned(child); process.exit(2); }
  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith('--runs='));
  const runs = runsArg ? Number(runsArg.split('=')[1]) : 1;
  const flowArgIndex = args.indexOf('--flow');
  const onlyFlow = flowArgIndex >= 0 ? args[flowArgIndex + 1] : null;

  // ==== 1) 矩阵三件套 ====
  section(`矩阵三件套（${SITES.length} 站 · runs=${runs}）`);
  const { PASS, FAIL } = await runContract(SITES, { runs });

  // ==== 2) 专项流程（默认全部；可用 --flow 过滤）====
  const b = new Browser();
  try {
    await b.ready();
    const names = ['baiduFollowFirstResult', 'zhihuCreatorProbe', 'multiTab', 'githubSearch'];
    const want = onlyFlow ? names.filter((n) => n === onlyFlow) : names;
    for (const n of want) {
      section('专项 · ' + n);
      await flows[n](b);
    }
  } finally {
    try { b.close(); } catch {}
  }

  console.log("\n== E2E 完成 ==");
  cleanupSpawned(child);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('e2e error:', e.message); cleanupSpawned(childRef); process.exit(2); });

// 超时兜底同样清理本次自拉的 Electron
setTimeout(() => {
  console.error('E2E TIMEOUT');
  cleanupSpawned(childRef);
  process.exit(1);
}, 180000);
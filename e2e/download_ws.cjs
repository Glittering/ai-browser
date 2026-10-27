// e2e/download_ws.cjs —— "点下载以后到底发生了什么"的回归套件
//
// 事故（2026-10-27，用户报）：沧州市教师继续教育网 →「证书下载」→ 标签页停在
// 「正在打开…」，下面挂着一坨 png URL，永远不动。文件其实下载成功了，落在
// ~/.ai-browser/downloads/<tab>/ 里，但界面上零回执 —— 人只能判断成"卡住了"。
//
// 两个独立的原因，本套件各钉一组：
//   D1 服务端用 `Content-Disposition: attachment` 送一张 png。以前浏览器把它当
//      下载，导航**永远不会提交**；现在按内容类型直接显示（这才是"打开图片"）。
//   D2 zip/dmg 这类本来就不该显示的东西：下载 + 那个"为它而开的标签页"必须变成
//      下载结果页，而不是永远停在占位页上。
//   D3 页面里点"导出"那种下载：页面**不许**被顶掉（只是下载），并且要有记录。
//   D4 对照组：本来就 inline 的图片必须照旧显示 —— 证明我们只改了 attachment 那一支。
//
// 自带 fixture、不依赖外网。Run: npm run download

const harness = require('./_harness.cjs');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('./_spawn_guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const { Browser } = require(path.join(ROOT, 'tools/browser.cjs'));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9247;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

// 1×1 png。内容是什么不重要 —— 断言看的是"渲染器把它当文档显示了吗"，
// 不是"图好不好看"。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// 假 zip：足够大，能看出"落盘的是同一个东西"。
const ZIP = Buffer.alloc(64 * 1024, 0x5a);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>download fixture</title>
<style>body{font:14px/1.7 -apple-system,sans-serif;padding:24px}a{display:block;margin:8px 0}</style>
</head><body>
<h1>下载 fixture</h1>
<a id="img" href="/cert.png" target="_blank">证书（png + attachment，新标签）</a>
<a id="zip" href="/pkg.zip" target="_blank">安装包（zip + attachment，新标签）</a>
<a id="inline" href="/inline.png" target="_blank">普通图片（inline）</a>
<a id="same" href="/pkg-same.zip">就地下载（不开新标签）</a>
</body></html>`;

let PASS = 0, FAIL = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = String(req.url || '').split('?')[0];
      const attach = (name) => ({ 'Content-Disposition': 'attachment;filename=' + name });
      if (url === '/cert.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', ...attach('cert.png') });
        return res.end(PNG);
      }
      if (url === '/inline.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(PNG);
      }
      if (url === '/pkg.zip' || url === '/pkg-same.zip') {
        res.writeHead(200, {
          'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
          ...attach(path.basename(url)),
        });
        return res.end(ZIP);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function spawnElectron(port) {
  const electronPath = require('electron');
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (!childEnv.AI_BROWSER_USER_DATA) {
    childEnv.AI_BROWSER_USER_DATA = path.join(os.tmpdir(), `ai-browser-e2e-dl-${port}`);
  }
  // 每次跑都从干净的下载目录开始：否则上一轮的文件会让"有没有真的下载"变成
  // 一个靠运气的断言。
  if (!childEnv.AI_BROWSER_DOWNLOAD_DIR) {
    childEnv.AI_BROWSER_DOWNLOAD_DIR = path.join(childEnv.AI_BROWSER_USER_DATA, 'downloads');
  }
  try { fs.rmSync(childEnv.AI_BROWSER_DOWNLOAD_DIR, { recursive: true, force: true }); } catch (_) {}

  const child = spawn(electronPath, ['.'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: childEnv,
  });
  const lines = [];
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  });
  child.__stderrLines = lines;
  child.__downloadDir = childEnv.AI_BROWSER_DOWNLOAD_DIR;
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  return child;
}

/** 等页面真的到某个 URL（download 场景下导航可能永不提交，所以必须带超时）。 */
async function waitUrl(b, tab, match, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = unwrap(await b.call('ui.evaluate', {
        tab, js: 'JSON.stringify({href:location.href,ct:document.contentType||"",imgs:document.images.length,rs:document.readyState})',
      }));
      const raw = r && r.value !== undefined ? r.value : r;
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (s && match(s)) return s;
    } catch (_) { /* 导航中渲染器短暂不可读 */ }
    await sleep(150);
  }
  return null;
}

async function downloads(b, tab) {
  const r = unwrap(await b.call('ui.downloads', { tab })) || {};
  return r.downloads || [];
}

/** 轮询到某个 tab 出现 completed 的下载记录。 */
async function waitDownload(b, tab, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await downloads(b, tab);
    const done = list.filter((d) => d.state === 'completed');
    if (done.length) return done[done.length - 1];
    await sleep(200);
  }
  return null;
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`fixture @ ${base}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error('!! 端口 ' + WS_PORT + ' 被占用 —— 换一个 AI_BROWSER_PORT');
    process.exit(3);
  }
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, 'download');

  // ---- D1 图片 + attachment：必须显示，不能变成下载 ----
  console.log('\n[D1] png 带 Content-Disposition: attachment → 直接显示（这就是"打开证书"）');
  let imgTab = null;
  {
    imgTab = unwrap(await b.call('ui.new_tab', { url: `${base}/cert.png` })).tab;
    const s = await waitUrl(b, imgTab, (x) => x.href.endsWith('/cert.png') && x.ct.startsWith('image/'));
    check('D1 导航真的提交了（不是停在 loading.html 占位页）', !!s, s ? s.href : 'timeout');
    check('D1 渲染器把它当图片文档', !!s && s.ct === 'image/png', s && s.ct);
    check('D1 页面里确实有那张图', !!s && s.imgs >= 1, s && String(s.imgs));
    const list = await downloads(b, imgTab);
    check('D1 没有被当成下载（不该有下载记录）', list.length === 0, JSON.stringify(list.map((d) => d.filename)));
  }

  // ---- D2 zip + attachment，且是新标签：下载 + 结果页 ----
  console.log('\n[D2] zip 在新标签里打开 → 下载，且那个标签页变成"下载结果页"');
  let zipTab = null;
  {
    zipTab = unwrap(await b.call('ui.new_tab', { url: `${base}/pkg.zip` })).tab;
    const rec = await waitDownload(b, zipTab);
    check('D2 产生了下载记录', !!rec, JSON.stringify(await downloads(b, zipTab)));
    check('D2 状态 completed', !!rec && rec.state === 'completed', rec && rec.state);
    check('D2 文件真的落盘了', !!rec && fs.existsSync(rec.path), rec && rec.path);
    check('D2 落盘大小与响应一致', !!rec && fs.existsSync(rec.path) && fs.statSync(rec.path).size === ZIP.length,
      rec && String(fs.existsSync(rec.path) ? fs.statSync(rec.path).size : 'missing'));

    const s = await waitUrl(b, zipTab, (x) => x.href.indexOf('/renderer/download.html') >= 0);
    check('D2 标签页不再是"正在打开…"占位页', !!s, s ? s.href : 'still placeholder / timeout');
    check('D2 结果页带上了文件名与路径', !!s && decodeURIComponent(s.href).indexOf('pkg.zip') >= 0,
      s && decodeURIComponent(s.href).slice(0, 200));

    // 结果页必须把信息真的渲染出来（"页面打开了但一片空白"是同一类症状的另一种表现）
    await sleep(400);
    const dom = unwrap(await b.call('ui.evaluate', {
      tab: zipTab,
      js: 'JSON.stringify({name:(document.getElementById("name")||{}).textContent||"",buttons:[...document.querySelectorAll("button")].map(b=>b.textContent),meta:(document.getElementById("meta")||{}).textContent||""})',
    }));
    const raw = dom && dom.value !== undefined ? dom.value : dom;
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    check('D2 结果页显示了文件名', !!d && d.name === 'pkg.zip', d && d.name);
    check('D2 结果页有「打开 / 在 Finder 中显示」', !!d && d.buttons.length >= 3, d && JSON.stringify(d.buttons));
    check('D2 结果页标出大小（64KB 的假 zip）', !!d && /KB/.test(d.meta), d && d.meta);
  }

  // ---- D3 页面里点下载（就地）：页面不许被顶掉 ----
  console.log('\n[D3] 页面里点下载（不开新标签）→ 页面保持，只有下载发生');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${base}/page` })).tab;
    const s0 = await waitUrl(b, tab, (x) => x.href.endsWith('/page') && x.rs !== 'loading');
    check('D3 页面已就绪', !!s0, s0 ? s0.href : 'timeout');
    // 直接点链接（等同于用户点"导出"）：地点在本 tab
    unwrap(await b.call('ui.evaluate', { tab, js: 'document.getElementById("same").click(); true' }));
    const rec = await waitDownload(b, tab);
    check('D3 就地下载产生了记录', !!rec && rec.state === 'completed', rec && rec.state);
    const s1 = await waitUrl(b, tab, (x) => x.href.endsWith('/page'));
    check('D3 原页面**没有**被顶掉', !!s1 && s1.href.endsWith('/page'), s1 ? s1.href : 'page lost');
    // 工具条的"已下载 xxx"回执就是靠这条记录；记录没了回执也不会出现。
    check('D3 文件在下载目录里', !!rec && rec.path.indexOf(String(child.__downloadDir)) === 0, rec && rec.path);
    unwrap(await b.call('ui.close_tab', { tab }));
  }

  // ---- D4 对照组：inline 图片照旧显示 ----
  console.log('\n[D4] 本来就 inline 的图片 → 照旧显示（证明只改了 attachment 那一支）');
  {
    const tab = unwrap(await b.call('ui.new_tab', { url: `${base}/inline.png` })).tab;
    const s = await waitUrl(b, tab, (x) => x.href.endsWith('/inline.png') && x.ct.startsWith('image/'));
    check('D4 直接显示', !!s && s.ct === 'image/png', s && s.ct);
    check('D4 同样没有下载记录', (await downloads(b, tab)).length === 0);
    unwrap(await b.call('ui.close_tab', { tab }));
  }

  // ---- D5 「下载」入口：显示出来的图片也要能存成文件 ----
  console.log('\n[D5] ui.download：把正在显示的图片存成文件（工具条那个「下载」按钮的同一个实现）');
  if (imgTab !== null) {
    const r = unwrap(await b.call('ui.download', { tab: imgTab }));
    check('D5 调用成功', !!r && r.ok === true, JSON.stringify(r));
    const rec = await waitDownload(b, imgTab);
    check('D5 真的产生了下载（没有被内联钩子又改回显示）', !!rec && rec.state === 'completed', rec && rec.state);
    check('D5 文件落盘且非空', !!rec && fs.existsSync(rec.path) && fs.statSync(rec.path).size === PNG.length,
      rec && rec.path);
    const s = await waitUrl(b, imgTab, (x) => x.href.endsWith('/cert.png'));
    check('D5 页面仍然是那张图（下载不该顶掉正在看的文档）', !!s && s.ct === 'image/png', s && s.href);
  }

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (FAIL) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  - ' + f);
    const lines = (child && child.__stderrLines) || [];
    if (lines.length) {
      console.log('  主进程最后 10 行：');
      for (const l of lines.slice(-10)) console.log('    | ' + l.slice(0, 200));
    }
  }
  b.close();
  server.close();
  guard.killChild(child);
  await sleep(300);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message, e && e.stack);
  guard.killAll();
  process.exit(1);
});

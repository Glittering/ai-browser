// e2e/readcov_ws.cjs — 读能力不变量套件
//
// 存在理由（2026-10-19 复盘结论）：
// 那天修的每一个洞都是**盯着某一张具体页面**发现的 —— 没有一个是系统性检查
// 发现的。缺的不是修 bug 的能力，是验收机制。这个套件就是那个机制。
//
// 它做一件事：用一组受控页面（每张代表一类地形）钉住一条不变量：
//
//   对任意页面，要么这棵树读到了 ≥90% 的可见文字，
//   要么回执里必须带一句**能照着做**的 hint 说明为什么读不到。
//
// "信号说好"和"事实是好"必须是同一件事。任何一条不满足，就是一个洞。
//
// 另外两条全局不变量（都是踩过的坑）：
//   · over_measured 不许出现 —— 分子大于分母意味着分母漏了一个承载文字的表面
//   · label 里不许出现不可见的东西（display:none 文字、<script> 源码）
//
// 自带 fixture、不依赖外网。退出码非 0 表示失败。
// Run:  npm run readcov
//       AI_BROWSER_PORT=<port> npm run readcov
//
// ⚠️ 已知残留（KNOWN，会单独报出来但不算失败）：
//   position:absolute;left:-9999px 这类"移出视口"的文本仍会进 label ——
//   innerText 认为它是渲染过的。要更强判据，见 /sr-only.html。

const harness = require("./_harness.cjs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const guard = require("./_spawn_guard.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
const LONG_BODY = Array.from({ length: 60 }, (_, i) =>
  `<p>第 ${i + 1} 段。${"这一段用来把正文撑长，验证默认树读长文时会掉多少字。".repeat(3)}</p>`
).join("\n");

const FIXTURES = {
  // 1. 最普通的静态页：应当接近全读
  "/basic.html": `<!doctype html><html><head><meta charset="utf-8"><title>basic</title></head><body>
<h1>一个标题</h1><p>第一段正文，讲的是页面上有什么。</p><p>第二段正文，普通得不能再普通。</p>
<nav><a href="/basic.html">链接一</a><a href="/basic.html">链接二</a></nav>
<button>确定</button><input placeholder="随便填">
</body></html>`,

  // 2. 长文：默认树必然读不全，但必须给出"换 ax:true"的可执行提示
  "/long.html": `<!doctype html><html><head><meta charset="utf-8"><title>long</title></head><body>
<h1>一篇很长的技术文章</h1>${LONG_BODY}</body></html>`,

  // 3. 同源子帧：主文档字少、子帧字多 —— 分母漏掉这块就会谎报 100%
  "/same-frame.html": `<!doctype html><html><head><meta charset="utf-8"><title>same-frame</title></head><body>
<p>主文档只有这一句。</p>
<iframe src="/child.html" width="700" height="300"></iframe>
</body></html>`,
  "/child.html": `<!doctype html><html><head><meta charset="utf-8"><title>child</title></head><body>
<h2>同源子帧</h2><p>${"这是一段位于同源 iframe 里的正文，用来把分母撑大。".repeat(8)}</p></body></html>`,

  // 4. 跨进程子帧：不同端口 = 不同源 = OOPIF，必须被合并进来
  "/xorigin-frame.html": `<!doctype html><html><head><meta charset="utf-8"><title>xorigin</title></head><body>
<p>主文档这一句。</p>
<iframe id="xf" width="700" height="300"></iframe>
<script>
  // 端口在运行时注入（见 startServers 的 __XORIGIN__ 替换）
  document.getElementById('xf').src = '__XORIGIN__/xchild.html';
</script>
</body></html>`,
  "/xchild.html": `<!doctype html><html><head><meta charset="utf-8"><title>xchild</title></head><body>
<h2>跨进程子帧</h2><p>${"这段文字住在另一个进程里，顶层文档的 JS 读不到它。".repeat(8)}</p>
<a href="/xchild.html">跨进程链接</a></body></html>`,

  // 5. 纯 canvas：文字画在画布上，innerText 永远看不到 → 必须说"量不了"
  "/canvas.html": `<!doctype html><html><head><meta charset="utf-8"><title>canvas</title></head><body>
<div id="hud">绘图工具</div><canvas id="cv" width="800" height="400"></canvas>
<script>
var c = document.getElementById('cv').getContext('2d');
c.fillStyle='#fff'; c.fillRect(0,0,800,400); c.fillStyle='#000'; c.font='18px sans-serif';
for (var i=0;i<10;i++) c.fillText('画布上的第 '+(i+1)+' 行文字，DOM 里没有', 20, 40+i*32);
</script></body></html>`,

  // 6. canvas + 大量正文：canvas 只是页面的一部分，正常按文字算
  "/canvas-text.html": `<!doctype html><html><head><meta charset="utf-8"><title>canvas+text</title></head><body>
<h1>带图表的报告</h1><p>${"这是报告正文，图表只是辅助。".repeat(40)}</p>
<canvas width="600" height="300"></canvas></body></html>`,

  // 7. display:none 的文字：绝对不许进 label（那是用户看不见的东西）
  "/hidden.html": `<!doctype html><html><head><meta charset="utf-8"><title>hidden</title></head><body>
<p>页面上真正看得见的一句话。</p>
<div style="display:none">HIDDENMARK 这段文字被藏起来了，人眼看不到。</div>
</body></html>`,

  // 8. 移出视口的 sr-only：KNOWN 残留，只报不判
  "/sr-only.html": `<!doctype html><html><head><meta charset="utf-8"><title>sr-only</title></head><body>
<p>可见的一句。</p>
<span style="position:absolute;left:-9999px">SROMARK 屏幕阅读器专用文本</span>
</body></html>`,

  // 9. open shadow root：内容不在 light DOM 里
  "/shadow.html": `<!doctype html><html><head><meta charset="utf-8"><title>shadow</title></head><body>
<p>宿主外面的正文。</p><div id="host"></div>
<script>
var r = document.getElementById('host').attachShadow({ mode: 'open' });
r.innerHTML = '<h2>影子树里的标题</h2><p>影子树里的正文，一共二十来个字。</p><button>影子按钮</button>';
</script></body></html>`,

  // 10. 虚拟列表：DOM 里只有可视区的几条，页面"看起来"有 500 条
  "/virtual.html": `<!doctype html><html><head><meta charset="utf-8"><title>virtual</title></head><body>
<div id="hud">共 500 条，当前只渲染了 6 条</div>
<div id="list" style="height:240px;overflow:auto"></div>
<script>
var html = '';
for (var i = 1; i <= 6; i++) html += '<div class="row">第 ' + i + ' 行（虚拟列表只渲染可视区）</div>';
document.getElementById('list').innerHTML = html;
</script></body></html>`,

  // 11. 表格：每个 cell 都必须读到
  "/table.html": `<!doctype html><html><head><meta charset="utf-8"><title>table</title></head><body>
<table border="1"><thead><tr><th>课程</th><th>学分</th><th>成绩</th></tr></thead><tbody>
${Array.from({ length: 8 }, (_, i) => `<tr><td>课程${i + 1}</td><td>${i + 2}</td><td>${60 + i * 4}</td></tr>`).join("")}
</tbody></table></body></html>`,

  // 12. 空页：没有可读文字 ≠ 没读到
  "/empty.html": `<!doctype html><html><head><meta charset="utf-8"><title>empty</title></head><body></body></html>`,

  // 13. 晚注入：内容 3 秒后才出现，早期读到算"还在渲染"
  "/late.html": `<!doctype html><html><head><meta charset="utf-8"><title>late</title></head><body>
<div id="root">加载中</div>
<script>setTimeout(function(){
  document.getElementById('root').innerHTML =
    '<h1>终于来了</h1><p>${"延迟注入的正文内容，用来验证等待之后能读到。".repeat(6)}</p>';
}, 3000);</script></body></html>`,

  // 14. 容器里混着 <script>：JS 源码不许进 label
  "/script-text.html": `<!doctype html><html><head><meta charset="utf-8"><title>script</title></head><body>
<div id="wrap">可见的一行字<script>var SECRETMARK = "这段是JS源码不是页面文字";</script></div>
</body></html>`,
};

// 每个 fixture 的预期。band = DOM 树的 ratio 允许区间（null 表示"不按比例判"）
// 这些数字是**要求**，不是实测值的复制；不达标就是洞。
// 每个 fixture 的预期。
//
// band = DOM 树的 ratio 允许区间（null 表示"不按比例判"）。写的是**要求**，
//       不是实测值的复制；调 band 必须能说清"为什么这个数是对的"。
//
// 这套表里最重要的不是 band，是下面两条：
//   · 全局：ratio < 0.9 ⟹ 必须有 hint，**且 AX 树必须 ≥0.9**
//     （DOM 树读不全可以，但那样就必须有一条走得通的路，不能两棵树一起瞎）
//   · mustContain / axMustContain：钉住"某个具体的东西必须出现"，
//     比比例更难糊弄 —— 比例可以靠无关的字凑，关键字凑不出来。
//
// 2026-10-19 第二次跑（改造前 PASS=52 FAIL=9）的实测结论，逐条写进注释：
//   DOM 树对长正文只读到 70%，原因不是漏节点，是**每个 label 被裁到 60 字**；
//   AX 树对同样五张页面全部 100%。所以"读不全"的正确回答是指路，不是把
//   DOM 树改成阅读树。
const EXPECT = [
  { path: "/basic.html", band: [0.9, 1], name: "静态页应当接近全读",
    mustContain: ["一个标题", "第一段正文", "链接一"] },
  { path: "/long.html", band: [0.4, 0.95], name: "长文：DOM 树读不全，必须指路 AX",
    needHint: /ax:true/, axMustContain: ["第 60 段"] },
  { path: "/same-frame.html", band: [0.05, 0.45], name: "同源帧的字必须进分母（不许 100%）",
    needFrameReadable: true },
  { path: "/xorigin-frame.html", band: [0, 0.75], name: "跨进程帧必须被合并",
    needMerged: true, needFrameReadable: true, waitMs: 4500, mustContain: ["跨进程子帧", "跨进程链接"] },
  { path: "/canvas.html", band: null, name: "纯 canvas 必须说量不了", needUnmeasurable: "canvas" },
  // 带 canvas 的页面**不是**"量不了"：文字照样按 innerText 算，只是正文被裁。
  // 这条钉的是历史上那个"canvas 页报 100%"的假读数。
  { path: "/canvas-text.html", band: [0.05, 0.5], name: "canvas + 正文 → 仍按文字算（不是 unmeasurable）",
    mustContain: ["带图表的报告", "报告正文"], axMustContain: ["图表只是辅助"] },
  { path: "/hidden.html", band: [0.9, 1], name: "display:none 的文字不许进 label", forbid: "HIDDENMARK" },
  // 移出视口的 span 没有独立节点，只有 body 级 blob 里带一段 —— DOM 树注定读不全。
  // KNOWN：允许比例低，但必须指路，且 AX 必须读全（AX 里它有名字）。
  { path: "/sr-only.html", band: [0.05, 0.6], name: "移出视口的文本（KNOWN：DOM 树读不到，AX 能）",
    known: "SROMARK", axMustContain: ["SROMARK"] },
  { path: "/shadow.html", band: [0.5, 1], name: "open shadow root 要能读", mustContain: ["影子树里的标题"] },
  // 虚拟列表的行是 <div>，DOM 树不采 div 文字 → 只有 hud 一句。AX 读得到全部 6 行。
  { path: "/virtual.html", band: [0.2, 0.8], name: "虚拟列表：DOM 树只到 hud，AX 要到每一行",
    axMustContain: ["第 6 行"] },
  { path: "/table.html", band: [0.9, 1], name: "表格每个 cell 都要读到", mustContain: ["课程", "成绩"] },
  { path: "/empty.html", band: null, name: "空页给 null 而不是 0", needNull: true },
  { path: "/late.html", band: [0.4, 0.95], name: "晚注入的内容等一会儿要读到", waitMs: 4500,
    mustContain: ["终于来了", "延迟注入"], axMustContain: ["延迟注入"] },
  { path: "/script-text.html", band: [0.5, 1], name: "script 源码不许进 label", forbid: "SECRETMARK" },
];

// ---------------------------------------------------------------- harness
let PASS = 0, FAIL = 0, KNOWN = 0;
const fails = [];
const knowns = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS | ${name}`); }
  else { FAIL++; fails.push(name + (detail ? " — " + detail : "")); console.log(`  FAIL | ${name}${detail ? " — " + detail : ""}`); }
}
function note(name, detail) { KNOWN++; knowns.push(name + (detail ? " — " + detail : "")); console.log(`  KNOWN | ${name}${detail ? " — " + detail : ""}`); }

// 跨源地址只有在两个服务器都 listen 之后才知道。这里用一个闭包变量在**服务时**
// 注入，而不是先起服务再回头改 FIXTURES 表 —— 后者依赖"处理器在请求时才读表"
// 这个隐含假设，一旦有人把 body 提前取出来（或加缓存）就会静默失效，
// 而失效的样子恰好是"帧一片空白、回执却说 100%"（踩过）。
let XORIGIN = '';

function startServers() {
  const make = (routes) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      let body = routes[url];
      if (body === undefined) { res.writeHead(404); return res.end("nf"); }
      if (body.indexOf("__XORIGIN__") >= 0) body = body.replace(/__XORIGIN__/g, XORIGIN);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  return Promise.all([make(FIXTURES), make({ "/xchild.html": FIXTURES["/xchild.html"] })]);
}

async function spawnElectron(port) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), AI_BROWSER_WATCHDOG: "0" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-readcov-${port}`;
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
  guard.track(child);
  await harness.waitPortOpen(port, 30000);
  return child;
}

const unwrap = (r) => (r && r.result !== undefined ? r.result : r);

/** 把树里所有 label 拼起来，用于"某个字符串不许出现"的检查。 */
function allLabels(tree) {
  const out = [];
  (function walk(n) { if (!n) return; if (n.label) out.push(n.label); (n.children || []).forEach(walk); })(tree);
  return out;
}

async function readFixture(b, url, waitMs) {
  const tab = unwrap(await b.call("ui.new_tab", { url })).tab;
  // 首帧可能还在解析；等页面稳定再读，否则测的是"渲染速度"不是"读能力"
  await sleep(waitMs || 1600);
  const dom = unwrap(await b.call("ui.get_tree", { tab }));
  return { tab, dom };
}

async function main() {
  const servers = await startServers();
  const mainPort = servers[0].address().port;
  const xoPort = servers[1].address().port;
  const HOST = `http://127.0.0.1:${mainPort}`;
  XORIGIN = `http://127.0.0.1:${xoPort}`;
  // 自检：fixture 的跨源地址必须真的注进去了。不查这一条的话，注不进去时的
  // 表现是"帧空白 + 回执 100%"，和"页面本来就没内容"长得一模一样。
  console.log(`fixture 跨源地址 = ${XORIGIN}`);

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error("!! port " + WS_PORT + " 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程");
    process.exit(3);
  }

  console.log(`spawn electron port ${WS_PORT}  (fixtures ${mainPort} / cross-origin ${xoPort})`);
  const child = await spawnElectron(WS_PORT);
  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, "readcov");

  // ONLY=/xorigin-frame.html 只跑一条，方便定位单个 fixture
  const only = process.env.ONLY ? String(process.env.ONLY).trim() : "";
  const selected = only ? EXPECT.filter((e) => e.path === only) : EXPECT;
  if (only && !selected.length) { console.error("!! ONLY 没有匹配到 fixture: " + only); process.exit(2); }

  for (const exp of selected) {
    console.log(`\n[${exp.path}] ${exp.name}`);
    const url = HOST + exp.path;
    const { tab, dom } = await readFixture(b, url, exp.waitMs);
    const pc = dom.context && dom.context.page_coverage;
    const labels = allLabels(dom.tree);

    // AX 树按需读一次：全局不变量（读不全就必须有出路）和逐页预期都要用。
    // 用闭包缓存，避免同一页读两次 AX（那会把套件跑成 2 倍时长）。
    let axPc = null, axLabels = [], axRead = false;
    const readAx = async () => {
      if (axRead) return axPc;
      axRead = true;
      const ax = unwrap(await b.call("ui.get_tree", { tab, ax: true }));
      axPc = (ax.context || {}).page_coverage || null;
      axLabels = allLabels(ax.tree);
      return axPc;
    };

    check(`${exp.path} 回执带 page_coverage`, !!pc, JSON.stringify(dom.context && Object.keys(dom.context)));
    if (!pc) { await b.call("ui.close_tab", { tab }); continue; }

    // ---- 全局不变量 1：分子不许大于分母（大于就是分母漏了一个表面）
    check(`${exp.path} 不出现 over_measured`, !pc.over_measured,
      pc.over_measured ? `tree=${pc.tree_chars} page=${pc.page_chars}` : "");

    // ---- 全局不变量 2：读不全就必须给一句**照着能做**的话
    //
    // 原来这里还有一条"读不全时 AX 必须 ≥90%"。实测否掉了它：帧类页面上 AX 树
    // 的帧内容同样走 frame_read_source 的合并通路（/same-frame AX 只有 55%），
    // 那条断言会把"AX 不是这页的出路"当成缺陷。真正要不变量化的是
    // **hint 指向的操作必须真的存在**：ax:true / frame_ref / screenshot / canvas_read。
    // 每个地形究竟哪条路走得通，交给逐页预期单独钉（axMustContain、needFrameReadable）。
    const HAS_ESCAPE = /ax:true|frame_ref|frame_hints|ui\.screenshot|canvas_read|context\.route/;
    const hasText = (pc.page_chars || 0) > 0 && !pc.unmeasurable;
    if (hasText) {
      const low = pc.ratio !== null && pc.ratio < 0.9;
      check(`${exp.path} 覆盖率 ${(pc.percent === null ? "null" : pc.percent + "%")} 低则必须给 hint`,
        !low || !!pc.hint, low ? "ratio<0.9 但 hint 为空" : "");
      if (low) {
        check(`${exp.path} hint 必须指向一个真实存在的读法`, HAS_ESCAPE.test(pc.hint || ""),
          String(pc.hint).slice(0, 140));
      }
    }

    // ---- 逐页预期
    if (exp.band) {
      const [lo, hi] = exp.band;
      check(`${exp.path} ratio 落在 [${lo}, ${hi}]`, pc.ratio !== null && pc.ratio >= lo && pc.ratio <= hi,
        `ratio=${pc.ratio} page_chars=${pc.page_chars} tree_chars=${pc.tree_chars}`);
    }
    if (exp.mustContain) {
      const miss = exp.mustContain.filter((s) => !labels.some((l) => l.indexOf(s) >= 0));
      check(`${exp.path} DOM 树里必须有「${exp.mustContain.join("/")}」`, miss.length === 0,
        "缺: " + miss.join(", ") + ` (labels ${labels.length} 条)`);
    }
    if (exp.needNull) {      check(`${exp.path} 空页给 ratio=null（不是 0）`, pc.ratio === null, `ratio=${pc.ratio}`);
    }
    if (exp.needUnmeasurable) {
      check(`${exp.path} 标注 unmeasurable=${exp.needUnmeasurable}`, pc.unmeasurable === exp.needUnmeasurable,
        `unmeasurable=${pc.unmeasurable} ratio=${pc.ratio}`);
      check(`${exp.path} 且 ratio 为 null（不是 100%）`, pc.ratio === null, `ratio=${pc.ratio}`);
    }
    if (exp.needHint) {
      check(`${exp.path} hint 指路 ${exp.needHint}`, exp.needHint.test(pc.hint || ""), String(pc.hint).slice(0, 120));
    }
    if (exp.needMerged) {
      const fh = dom.context && dom.context.frame_hints;
      const st = (dom.context && dom.context.stats) || {};
      check(`${exp.path} 跨进程帧被合并`, !!fh && fh.auto_ax === "merged" && fh.frames_read >= 1,
        `frame_hints=${JSON.stringify(fh)} iframes=${st.iframes} cpf=${JSON.stringify(dom.context && dom.context.cross_process_frames)} url=${url}`);
      check(`${exp.path} 门节点带绝对 src`,
        !!(fh && fh.frames && fh.frames[0] && /^https?:\/\//.test(fh.frames[0].src || "")),
        JSON.stringify(fh && fh.frames && fh.frames[0]));
    }
    if (exp.forbid) {
      const hit = labels.filter((l) => l.indexOf(exp.forbid) >= 0);
      if (exp.known) {
        // 已知残留：不判失败，但必须出现在报告里，否则"静默放过"和"没有洞"长得一样
        if (hit.length) note(`${exp.path} 「${exp.known}」仍进 label（KNOWN 残留）`, hit[0].slice(0, 60));
      } else {
        check(`${exp.path} label 里没有「${exp.forbid}」`, hit.length === 0, hit[0] ? hit[0].slice(0, 80) : "");
      }
    }

    // ---- 帧类页面：hint 里让调用方"用 frame_ref 直接读帧"，那就必须真的读得动。
    // 这一条比"帧被合并了"更硬：合并只证明我们**碰过**那个帧，读得动才证明
    // 那句 hint 是能照着做的。
    if (exp.needFrameReadable) {
      const fh = (dom.context && dom.context.frame_hints) || {};
      const ref = fh.frames && fh.frames[0] && fh.frames[0].ref;
      const r = unwrap(await b.call("ui.evaluate", {
        tab, frame_ref: ref, js: "document.body.innerText.length",
      }));
      const n = r && typeof r.value === "number" ? r.value : null;
      check(`${exp.path} hint 说的 frame_ref 真的能读（${ref}）`, typeof n === "number" && n > 0,
        `evaluate → ${JSON.stringify(r)}`);
    }

    // ---- 长文额外验一次 AX 读法
    if (exp.axBand || exp.axMustContain) {
      const a = await readAx();
      if (exp.axBand) {
        check(`${exp.path} AX 树 ratio 落在 [${exp.axBand[0]}, ${exp.axBand[1]}]`,
          !!a && a.ratio !== null && a.ratio >= exp.axBand[0] && a.ratio <= exp.axBand[1],
          `ax ratio=${a && a.ratio} chars=${a && a.tree_chars}/${a && a.page_chars}`);
      }
      if (exp.axMustContain) {
        const miss = exp.axMustContain.filter((s) => !axLabels.some((l) => l.indexOf(s) >= 0));
        check(`${exp.path} AX 树里必须有「${exp.axMustContain.join("/")}」`, miss.length === 0,
          "缺: " + miss.join(", ") + ` (ax labels ${axLabels.length} 条)`);
      }
    }

    await b.call("ui.close_tab", { tab });
  }

  console.log(`\n==== PASS=${PASS} FAIL=${FAIL} ====`);
  if (KNOWN) {
    console.log(`\n已知残留（${KNOWN} 项，不计失败，但必须可见）：`);
    for (const k of knowns) console.log("  - " + k);
  }
  if (FAIL) {
    console.log("\n失败明细：");
    for (const f of fails) console.log("  - " + f);
  }
  b.close();
  servers.forEach((s) => s.close());
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { console.error("ERR", e.message, e.stack); process.exit(1); });

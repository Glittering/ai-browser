// e2e/modeldiff_ws.cjs — canvas 应用的数据模型 diff，端到端验证。
//
// 核心命题：**canvas 应用的 DOM 是一张定格照片。** 拖一个节点、改一个 widget 只
// 重绘画布，DOM 一个字节都不动 —— 所以只描述 DOM 的 ui.diff 会对一次确实发生了
// 的写入回答 "unchanged"。那是假绿，而且是本项目唯一职责（"写入必须回读校验"）
// 失效的地方。这个套件证明：当页面把自己的模型挂在 window 上时，默认快照能diff它。
//
// 全部用自建夹具，不碰任何在线工程（有吸附/量化的编辑器上"拖出去再拖回来"不成立）。
// 退出码非 0 表示失败。
//
// Run:  npm run modeldiff
//       AI_BROWSER_PORT=<port> npm run modeldiff

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 夹具一：canvas + 一份纯粹活在 JS 里的数据模型。
// 关键性质：__addNode / __setWidget 只改 window.graph，绝不碰 DOM —— 这就是
// canvas 应用的形态，也是旧实现看不见写入的原因。
const MODEL_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>ModelFixture</title></head><body>
<canvas id="cv" width="400" height="200"></canvas>
<div id="status">idle</div>
<button id="run">Run</button>
<script>
  (function () {
    var c = document.getElementById('cv');
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 400, 200);
    x.fillStyle = '#000000'; x.font = '16px sans-serif';
    x.fillText('graph fixture', 10, 30);
    var nodes = [
      { id: 1, type: 'KSampler', widgets_values: [20, 'fixed'] },
      { id: 2, type: 'VAEDecode', widgets_values: [0] }
    ];
    window.graph = {
      _nodes: nodes,
      serialize: function () {
        return {
          last_node_id: nodes.length,
          nodes: nodes.map(function (n) {
            return { id: n.id, type: n.type, widgets_values: n.widgets_values.slice() };
          }),
          links: []
        };
      }
    };
    window.__addNode = function () {
      nodes.push({ id: nodes.length + 1, type: 'CLIPTextEncode', widgets_values: [0] });
      return nodes.length;
    };
    window.__setWidget = function (i, v) { nodes[i].widgets_values[0] = v; return nodes[i].widgets_values[0]; };
    window.__nodeCount = function () { return nodes.length; };
  })();
</script>
</body></html>`;

// 夹具二：没有应用对象的普通页面。用来证明模型机制不会自己造候选、不会误报。
const PLAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>PlainFixture</title></head><body>
<div id="out">alpha</div>
<button id="go">Go</button>
<script>
  window.__setOut = function (t) { document.getElementById('out').textContent = t; };
  window.__setBtn = function (t) { document.getElementById('go').textContent = t; };
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url.indexOf("/plain") === 0) res.end(PLAIN_PAGE);
      else res.end(MODEL_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.once("connect", () => fin(true));
    s.once("error", () => fin(false));
    setTimeout(() => fin(false), 500);
  });
}

function waitForPort(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const once = async () => {
      if (await checkPort(port)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting port " + port));
      setTimeout(once, 250);
    };
    once();
  });
}

const guard = require("./_spawn_guard.cjs");

let PASS = 0, FAIL = 0;
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`);
};
const note = (text) => console.log(`  NOTE | ${text}`);

async function spawnElectron(port) {
  const electronPath = require("electron");
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${port}`;
  const child = spawn(electronPath, ["."], {
    cwd: ROOT, stdio: "ignore", detached: true, env: childEnv,
  });
  guard.track(child);
  await waitForPort(port, 30000);
  return child;
}

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run modeldiff"
    );
    process.exit(3);
  } catch { /* free */ }

  console.log("spawn electron port", WS_PORT);
  await spawnElectron(WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();

  const snap = async () => (await b.call("ui.snapshot", {})).result;
  const diff = async (id) => (await b.call("ui.diff", { snapshot: id })).result;
  const ev = async (js) => (await b.call("ui.evaluate", { js }))?.result?.value;
  const allPaths = (d) => [...d.added, ...d.removed, ...d.changed_paths].map((x) => x.path);

  try {
    await b.call("ui.new_tab", { url: HOST + "/model" });
    await sleep(2500);

    console.log("\n[MD-A 能力探针与指纹必须指向同一个模型]");
    const cap = (await b.call("ui.capabilities", {})).result;
    const capJson = JSON.stringify(cap);
    check("MD-01 canvas 夹具上推荐 L1_structured_data",
      !!(cap && cap.route && cap.route.recommended.includes("L1_structured_data")),
      cap && cap.route ? cap.route.recommended.join(",") : "no route");
    check("MD-02 探针在 app_globals 里点名 graph",
      capJson.indexOf('"key":"graph"') >= 0,
      (cap && cap.app_globals || []).map((g) => g.key + "=" + g.hint).join(" | "));

    console.log("\n[MD-B 只改模型、DOM 一个字节不动 —— 必须报 changed]");
    const s1 = await snap();
    const before = await ev("window.__nodeCount()");
    await ev("window.__addNode()");
    const after = await ev("window.__nodeCount()");
    const d1 = await diff(s1.snapshot);
    check("MD-03 夹具自证：节点数确实变了（否则后面的断言没有意义）",
      Number(before) === 2 && Number(after) === 3, `${before} -> ${after}`);
    check("MD-04 只加一个节点 → diff 报 changed", d1.verdict === "changed",
      "verdict=" + d1.verdict + " counts=" + JSON.stringify(d1.counts));
    check("MD-05 diff 里出现 model.fp 与 model.count",
      d1.changed_paths.some((c) => c.path === "model.fp") &&
      d1.changed_paths.some((c) => c.path === "model.count"),
      d1.changed_paths.map((c) => c.path).join(","));
    // 这是整条测试的立意所在：证明功劳属于模型指纹，不是 DOM 顺带变了。
    const domPaths = allPaths(d1).filter((p) => p.startsWith("nodes") || p.startsWith("text"));
    check("MD-06 diff 里没有任何 nodes.* / text* 路径（DOM 侧确实没变）",
      domPaths.length === 0, domPaths.join(",") || "(无)");

    console.log("\n[MD-C 阳性对照：什么都不做必须 unchanged]");
    const s2 = await snap();
    const d2 = await diff(s2.snapshot);
    check("MD-07 同一模型反复快照 → unchanged（指纹由内容派生，不是对象身份）",
      d2.verdict === "unchanged" && !allPaths(d2).some((p) => p.startsWith("model")),
      "verdict=" + d2.verdict + " paths=" + allPaths(d2).join(","));

    console.log("\n[MD-D ComfyUI 的文档级写路径：只改 widget 值、节点数不变]");
    const s3 = await snap();
    await ev("window.__setWidget(0, 42)");
    const d3 = await diff(s3.snapshot);
    check("MD-08 只改参数 → 仍报 changed，且只有 fp 变、count 不变",
      d3.verdict === "changed" &&
      d3.changed_paths.some((c) => c.path === "model.fp") &&
      !d3.changed_paths.some((c) => c.path === "model.count"),
      d3.changed_paths.map((c) => c.path).join(","));

    console.log("\n[MD-E 模型指纹不许盖住 DOM 信号]");
    const s4 = await snap();
    await ev("window.__addNode()");
    await ev("document.getElementById('run').textContent='Running'");
    const d4 = await diff(s4.snapshot);
    check("MD-09 DOM 与模型同时变化时，两条信号都出现",
      d4.changed_paths.some((c) => c.path === "model.fp") &&
      allPaths(d4).some((p) => p.startsWith("nodes")),
      allPaths(d4).join(","));

    console.log("\n[MD-F 普通页面：模型机制不许自己造候选]");
    await b.call("ui.new_tab", { url: HOST + "/plain" });
    await sleep(2500);
    const s5 = await snap();
    const d5a = await diff(s5.snapshot);
    check("MD-10 无应用对象的页面 → 自比 unchanged，且不出现 model.* 路径",
      d5a.verdict === "unchanged" && !allPaths(d5a).some((p) => p.startsWith("model")),
      allPaths(d5a).join(",") || "(无)");
    await ev("window.__setBtn('Pressed')");
    const d5b = await diff(s5.snapshot);
    check("MD-11 普通页面纯 DOM 变化照旧报 changed（回归未被破坏）",
      d5b.verdict === "changed" && allPaths(d5b).some((p) => p.startsWith("nodes")),
      allPaths(d5b).join(","));
    check("MD-12 普通页面的 diff 里不出现 model.*（没有误报）",
      !allPaths(d5b).some((p) => p.startsWith("model")), allPaths(d5b).join(","));

    console.log(`\n[modeldiff] PASS=${PASS} FAIL=${FAIL}`);
  } finally {
    b.close();
    server.close();
    guard.killAll();
  }

  process.exit(FAIL > 0 ? 1 : 0);
}

const timer = setTimeout(() => {
  console.error("GLOBAL TIMEOUT after " + GLOBAL_TIMEOUT_MS + "ms");
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);
timer.unref();

main().catch((e) => {
  console.error("modeldiff e2e crashed:", e);
  process.exit(2);
});

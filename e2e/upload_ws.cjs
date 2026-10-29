// e2e/upload_ws.cjs — 文件上传（ui.act upload）的端到端合同测试。
//
// 为什么需要这个套件：
//   1) 上传控件的 target 经常只能给 **CSS 选择器**（含带空格的组合选择器）——
//      B站「本地上传」是纯 div 菜单项，AX 树里没有节点；CSDN 封面区只有
//      `.container-coverimage-box .el-upload__input` 这种写法能定位。曾经这类
//      输入在入口被"你传的是页面文字"的体检误拒（bad-target-shape），
//      真实发布时表现为"封面永远设不上"。
//   2) 控件有三种状态：input 已在 / 点击容器时才挂载 / 点击容器里的按钮才挂载。
//      第三种最容易踩：整条选择器查不到元素，必须退到祖先再"点"出 input。
//   3) 点"祖先"会把**同容器里的其他可见按钮**一起卷入 —— 封面区常驻一个
//      「删除封面」，误点直接毁掉用户已设的封面。这里用陷阱页钉住"不许点它"。
//
// 跑：AI_BROWSER_PORT=9333 node e2e/upload_ws.cjs   （或 npm run upload）

const { windowEnv } = require('./_window_mode.cjs');
const harness = require("./_harness.cjs");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 夹具 ---------------------------------------------------------------
// 上传结果一律落到 #log 的 textContent，测试直接从 DOM 读回执 —— 不看工具
// 自己的返回值自证，而是看"组件到底有没有收到文件"。

const PAGE_HOST = `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<style>.box{width:300px;height:150px;border:2px dashed #999;display:flex;align-items:center;
justify-content:center;cursor:pointer}</style></head><body>
<div class="box" id="box"><span id="t">点击上传</span></div>
<div id="log">empty</div>
<script>
var box=document.getElementById('box');
box.addEventListener('click',function(){
  if(box.querySelector('input[type=file]'))return;
  var i=document.createElement('input'); i.type='file'; i.className='the-input'; i.style.display='none';
  i.addEventListener('change',function(){var f=i.files&&i.files[0];
    document.getElementById('log').textContent='got '+(f?f.name+'/'+f.size+'/'+f.type:'null');});
  box.appendChild(i); i.click();
});
</script></body></html>`;

const PAGE_CHILD = `<!doctype html><html><head><meta charset="utf-8"><title>child</title>
<style>.box{width:300px;height:160px;border:2px dashed #999}
.btn-upload{padding:4px 10px}.btn-remove-coverimg{padding:4px 10px}</style></head><body>
<div class="box" id="box">
  <div>封面预览（容器点了没反应）</div>
  <button class="btn-upload" id="up">从本地上传</button>
  <button class="btn-remove-coverimg" id="rm">删除封面</button>
</div>
<div id="log">intact</div>
<script>
document.getElementById('rm').addEventListener('click',function(e){e.stopPropagation();
  document.getElementById('log').textContent='REMOVED-BY-MISTAKE';
  try{parent.postMessage({from:'child',log:'REMOVED-BY-MISTAKE'},'*');}catch(err){}});
document.getElementById('up').addEventListener('click',function(e){e.stopPropagation();
  var i=document.createElement('input'); i.type='file'; i.className='the-input'; i.style.display='none';
  i.addEventListener('change',function(){var f=i.files&&i.files[0];
    document.getElementById('log').textContent='got '+(f?f.name+'/'+f.size+'/'+f.type:'null');
    try{parent.postMessage({from:'child',log:document.getElementById('log').textContent},'*');}catch(err){}});
  document.body.appendChild(i);   // 刻意不挂在 box 里：模拟"挂到别处"的组件
  i.click();
});
</script></body></html>`;

const PAGE_TRAP = `<!doctype html><html><head><meta charset="utf-8"><title>trap</title></head><body>
<div class="box" id="box">
  <div>（预览，没有上传入口）</div>
  <button class="btn-remove-coverimg" id="rm">删除封面</button>
</div>
<div id="log">intact</div>
<script>
document.getElementById('rm').addEventListener('click',function(){
  document.getElementById('log').textContent='REMOVED-BY-MISTAKE';});
</script></body></html>`;

const PAGE_OUTER = (childUrl) => `<!doctype html><html><head><meta charset="utf-8"><title>outer</title></head><body>
<iframe id="f" src="${childUrl}" width="360" height="300"></iframe>
<div id="fromframe">(no message)</div>
<script>
window.addEventListener('message',function(e){var d=e.data||{};
  if(d.from!=='child')return; document.getElementById('fromframe').textContent=d.log;});
</script></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url || "/").split("?")[0];
      const port = server.address().port;
      const body =
        p === "/host" ? PAGE_HOST
          : p === "/child" ? PAGE_CHILD
            : p === "/trap" ? PAGE_TRAP
              : p === "/outer" ? PAGE_OUTER(`http://localhost:${port}/child`)
                : "<!doctype html><title>404</title>404";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    // 双栈监听：127.0.0.1 与 localhost 会被 Chromium 视为不同站点 → 真的 OOPIF，
    // 只有单栈时 iframe 会退化成同进程 iframe，跨帧上传的难点就测不到了。
    server.listen(0, "::", () => resolve(server));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const net = require("node:net");
    function once() {
      const s = net.connect(port, WS_HOST);
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting port " + port));
        setTimeout(once, 250);
      });
    }
    once();
  });
}

let PASS = 0, FAIL = 0;
const check = (name, cond, detail) => { cond ? PASS++ : FAIL++; console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`); };
const note = (t) => console.log(`  NOTE | ${t}`);
let spawnedChild = null;
function killChild() {
  if (!spawnedChild) return;
  try {
    if (process.platform === "win32") {
      require("node:child_process").spawnSync("taskkill", ["/F", "/T", "/PID", String(spawnedChild.pid)], { stdio: "ignore" });
    } else {
      process.kill(-spawnedChild.pid, "SIGKILL");
    }
  } catch {}
  spawnedChild = null;
}

async function main() {
  const server = await startServer();
  const PORT = server.address().port;
  const HOST = `http://127.0.0.1:${PORT}`;

  // 上传用的真实文件：一句 PNG 头足够 —— 夹具不解码，只看 name/size/type
  const FILE = path.join(os.tmpdir(), "ai-browser-e2e-upload.png");
  fs.writeFileSync(FILE, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const FILE_SIZE = fs.statSync(FILE).size;

  if (!(await harness.waitPortFree(WS_PORT, 15000))) {
    console.error("!! port " + WS_PORT + " 一直被占用 —— 换一个 AI_BROWSER_PORT，或先杀掉占用它的进程");
    process.exit(3);
  }
  const electronPath = require("electron");
  const guard = require("./_spawn_guard.cjs");
  const childEnv = { ...process.env, ...windowEnv('upload'), AI_BROWSER_PORT: String(WS_PORT) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!childEnv.AI_BROWSER_USER_DATA) childEnv.AI_BROWSER_USER_DATA = require('node:path').join(require('node:os').tmpdir(), `ai-browser-e2e-${WS_PORT}`);
  console.log("spawn electron port", WS_PORT, "userData", childEnv.AI_BROWSER_USER_DATA);
  const child = spawn(electronPath, ["."], { cwd: ROOT, stdio: "ignore", detached: true, env: childEnv });
  guard.track(child);
  spawnedChild = child;
  await waitForPort(WS_PORT, 30000);

  const b = new Browser(WS_PORT);
  await b.ready();
  await harness.assertIdentity(b, child, "upload");

  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const act = async (params, tab) => (await b.call("ui.act", { ...params, tab }))?.result || {};
  const logOf = (tab) => ev("document.getElementById('log').textContent", tab);

  // ---- A. 选择器指向"点击容器才挂载"的 input（带空格！）------------------
  console.log("\n[A. 带空格选择器 + input 由容器点击创建]");
  const tA = (await b.call("ui.new_tab", { url: HOST + "/host" })).result?.tab;
  await sleep(1500);
  const preA = await ev(`(function(){return JSON.stringify({full:!!document.querySelector('#box .the-input')});})()`, tA);
  check("U-01 前置：'#box .the-input' 此刻在 DOM 里查不到（不是因为选择器写错）",
    String(preA).indexOf("false") >= 0, preA);

  const rA = await act({ action: "upload", target: "#box .the-input", params: { file: FILE } }, tA);
  check("U-02 upload{target:'#box .the-input'} 不再被当作文案拒掉（没有 bad-target-shape / looks like visible text）",
    String(rA.error || "").indexOf("looks like visible text") < 0, JSON.stringify(rA).slice(0, 200));
  check("U-03 退到祖先 .box 点出 input 并写文件：success + resolved_by=click",
    rA.success === true && rA.resolved_by === "click" && rA.uploaded === path.basename(FILE),
    JSON.stringify({ ok: rA.success, by: rA.resolved_by, up: rA.uploaded }));
  check("U-04 顶层文档上传如实报 in_frame=false", rA.in_frame === false, String(rA.in_frame));
  const logA = await logOf(tA);
  check("U-05 组件真的收到文件（name/size/type 都对）",
    logA === `got ${path.basename(FILE)}/${FILE_SIZE}/image/png`, logA);

  const rA2 = await act({ action: "upload", target: "#box .the-input", params: { file: FILE } }, tA);
  check("U-06 input 已挂载后再传走直写：resolved_by=direct",
    rA2.success === true && rA2.resolved_by === "direct", JSON.stringify({ ok: rA2.success, by: rA2.resolved_by }));
  check("U-07 直写路径也如实给 host_sel（用户能看出命中的是哪段）",
    rA2.host_sel === "#box .the-input", String(rA2.host_sel));

  // ---- B. 跨站 iframe（OOPIF）+ 由容器内的按钮触发 ----------------------
  console.log("\n[B. 跨站 iframe（OOPIF）+ 点击容器内的按钮才挂载]");
  const tB = (await b.call("ui.new_tab", { url: HOST + "/outer" })).result?.tab;
  // 跨站 iframe 走的是独立进程（OOPIF），冷启动 + 全量跑时机器较忙，3s 可能还没就绪，
  // 上传会因帧内目标没挂载而失败（假红）。这里给足 8s；单跑时远用不到。
  await sleep(8000);
  const rB = await act({ action: "upload", target: "body #box .the-input", params: { file: FILE } }, tB);
  check("U-08 帧内上传成功且 in_frame=true（CDP 的 setFileInputFiles 进不去 OOPIF）",
    rB.success === true && rB.in_frame === true, JSON.stringify({ ok: rB.success, in: rB.in_frame }));
  check("U-09 锚点里再往下一层点出 input：resolved_by=click-descendant",
    rB.resolved_by === "click-descendant", String(rB.resolved_by));
  check("U-10 host_sel 是回退到的那段祖先选择器，而不是原始选择器",
    typeof rB.host_sel === "string" && rB.host_sel.indexOf(".the-input") < 0, String(rB.host_sel));
  const msgB = await ev("document.getElementById('fromframe').textContent", tB);
  check("U-11 帧内组件真的收到文件（跨进程页面用 postMessage 把回执递出来）",
    msgB === `got ${path.basename(FILE)}/${FILE_SIZE}/image/png`, msgB);
  const logB = await ev(`(function(){var f=document.getElementById('f');return f?'(oopif)':'';})()`, tB);
  check("U-12 iframe 仍在（上传没有把页面搞崩）", logB === "(oopif)", String(logB));
  // ---- C. 安全边界：不许顺手点掉「删除封面」 ----------------------------
  console.log("\n[C. 安全边界：锚点里的删除类按钮绝不能被点]");
  // 上一步上传成功时，帧内也会把 got 回执递出来 —— 若「删除封面」被误点，
  // postMessage 会把 REMOVED-BY-MISTAKE 覆盖上来。
  const logC = await ev("document.getElementById('fromframe').textContent", tB);
  check("U-13 同容器里的「删除封面」未被误点（帧内最后一条回执仍是 got）",
    String(logC).indexOf("REMOVED") < 0 && String(logC).indexOf("got ") === 0, String(logC));

  const tC = (await b.call("ui.new_tab", { url: HOST + "/trap" })).result?.tab;
  await sleep(1500);
  const rC = await act({ action: "upload", target: ".box .the-input", params: { file: FILE } }, tC);
  const logC2 = await logOf(tC);
  check("U-14 找不到上传入口时明确失败（不假装成功）", rC.success === false, JSON.stringify(rC).slice(0, 160));
  check("U-15 失败原因指向真问题：命中了容器但点不出 input（并列出点过谁）",
    String(rC.error).indexOf("no <input type=file> appeared") >= 0 && Array.isArray(rC.candidates),
    String(rC.error).slice(0, 160));
  check("U-16 陷阱页的「删除封面」没有被点（页面状态仍是 intact）", logC2 === "intact", String(logC2));

  // ---- D. 选择器完全查不到时的说法 ------------------------------------
  console.log("\n[D. 选择器查不到 vs 命中了但点不出 input，是两条不同的错]");
  const rD = await act({ action: "upload", target: ".nope-box .nope-input", params: { file: FILE } }, tA);
  check("U-17 查不到任何元素时明确说 'no element matches'，并回带候选链",
    rD.success === false && String(rD.error).indexOf("no element matches") >= 0 &&
    Array.isArray(rD.candidates) && rD.candidates.length === 2,
    String(rD.error).slice(0, 160));

  // ---- E. 放宽只对 upload 生效 ----------------------------------------
  console.log("\n[E. 选择器放行只限 upload，click 仍然拒]");
  const rE = await act({ action: "click", target: "#box .the-input" }, tA);
  check("U-18 click{#box .the-input} 仍按'传的是文字不是 id'拒绝（校验没有被整体放松）",
    rE.success === false && String(rE.error).indexOf("looks like visible text") >= 0,
    String(rE.error).slice(0, 160));

  note("upload 的 target 允许 ref 或 CSS 选择器；选择器会按由长到短的祖先链回退。"
    + "锚点内只点「可见、且类名带 upload/file/replace 等正向词」的子元素，并排除 "
    + "remove/delete/cancel 一类 —— 封面区常驻的「删除封面」误点一次就是数据损失。");

  console.log("\n==== upload PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { fs.unlinkSync(FILE); } catch {}
  guard.killChild(child);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("upload e2e error:", e && e.stack ? e.stack : e.message); killChild(); process.exit(2); });
setTimeout(() => { console.error("upload e2e TIMEOUT"); killChild(); process.exit(2); }, GLOBAL_TIMEOUT_MS);

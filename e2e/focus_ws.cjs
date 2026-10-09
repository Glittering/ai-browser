// e2e/focus_ws.cjs — "agent 干活时不打断人" 的行为测试。
//
// 背景（用户反馈）：agent 一操作，ai-browser 窗口就被拽到前台，等于 agent 干活
// 期间人几乎没法用电脑。逐项测量后定位到两处：
//   1) page_manager.setActive() 里的 view.webContents.focus() —— ui.new_tab 和
//      ui.set_active_tab 每次都会调它，而它会激活整个窗口。
//   2) 窗口创建时 Electron 默认 show() —— MCP 拉起 app 时也会夺走焦点。
//   其它操作（act / get_tree / evaluate / peek / scroll / canvas / network）实测
//   本来就不抢。
//
// 这个套件从**外部视角**断言：把另一个 app 切到前台后执行 agent 操作，前台应用
// 仍然是那个 app。观测手段是 macOS 的 `lsappinfo`（不需要辅助功能权限）。
//
// ⚠️ 关键是**带对照组**：三组配置里有一组（AI_BROWSER_FOCUS=always）必须观测到
// "确实抢了焦点"。否则一旦观测手段失效（比如应用名变了、lsappinfo 行为变了），
// 所有断言都会变成永远的绿 —— 那就等于没测。对照组就是用来证明"这个测试真的
// 能测出抢焦点这件事"。
//
// 三组：
//   G1  默认 auto + agent 拉起（AI_BROWSER_LAUNCHED_BY_AGENT=1）→ 启动也不抢
//   G2  对照组 always                                        → 启动抢、操作抢
//   G3  人手动启动（不带 agent 标记）+ 默认 auto               → 启动显示在前台（抢），
//                                                              但后续操作不抢
//
// 非 macOS / 无 lsappinfo 时全部记为 NOTE 并正常退出 —— 不假装通过。
//
// Run:  npm run focus
//       AI_BROWSER_PORT=<port> npm run focus

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const guard = require("./_spawn_guard.cjs");

const WS_HOST = "127.0.0.1";
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 300000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;
const check = (name, cond, detail) => {
  if (cond) PASS++; else FAIL++;
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`);
};
const note = (text) => console.log(`  NOTE | ${text}`);

// ---- 外部观测：当前前台应用 -------------------------------------------------
// lsappinfo 是 macOS 自带工具，`lsappinfo front` 给出前台进程的 ASN，再查它的名字。
// 不需要辅助功能权限（osascript + System Events 需要，实测被拒 -10004）。
const CAN_DETECT = (() => {
  if (process.platform !== "darwin") return false;
  try {
    execSync("command -v lsappinfo", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function frontApp() {
  try {
    const out = execSync("lsappinfo info -only name $(lsappinfo front)", { encoding: "utf8" });
    const m = /"([^"]*)"/.exec(out);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// Electron 应用的进程名就是 "Electron"（未打包时）。
const isBrowserApp = (name) => /electron|ai-browser/i.test(name || "");

// 用"计算器"当靶子：它是个普通 GUI app，切到前台后如果被 ai-browser 抢走，
// 前台名字就会从「计算器」变成 Electron —— 这正是我们要断言的。
const TARGET_APP = "Calculator";

function focusTarget() {
  try { execSync(`open -a ${TARGET_APP}`, { stdio: "ignore" }); } catch { /* 没有就算了 */ }
}

function isTargetRunning() {
  try { execSync(`pgrep -x ${TARGET_APP}`, { stdio: "ignore" }); return true; } catch { return false; }
}

// ---- fixture ---------------------------------------------------------------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FocusFixture</title></head>
<body><input id="txt" type="text"><button id="btn" onclick="window.__n=(window.__n||0)+1">b</button></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
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

// ---- 一组配置的完整测量 -----------------------------------------------------

async function runGroup({ label, port, extraEnv, expectStealOnBoot, expectStealOnAction, HOST }) {
  console.log(`\n[${label}]`);

  // 先把前台切给靶子 app，这样"启动窗口"这一步是否抢焦点也能被观测到。
  focusTarget();
  await sleep(1500);
  const bootBefore = frontApp();

  const childEnv = { ...process.env, AI_BROWSER_PORT: String(port), ...(extraEnv || {}) };
  // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动（不起窗口、不监听 WS）。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 独立 profile：~/.ai-browser 存着用户真实登录态，测试不该碰。
  delete childEnv.AI_BROWSER_USER_DATA;
  childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${port}`;

  const child = spawn(require("electron"), ["."], {
    cwd: ROOT, env: childEnv, detached: true, stdio: "ignore",
  });
  guard.track(child);

  await waitForPort(port, 30000);
  await sleep(1800);

  const bootAfter = frontApp();
  const bootStole = isBrowserApp(bootAfter) && !isBrowserApp(bootBefore);
  check(
    `${label} 启动时${expectStealOnBoot ? "会" : "不"}抢焦点`,
    bootStole === expectStealOnBoot,
    `前台 ${bootBefore} -> ${bootAfter}`
  );

  const b = new Browser(port);
  await b.ready();
  const created = (await b.call("ui.new_tab", { url: HOST + "/focus" })).result;
  const tab = created && created.tab;
  await sleep(2500);
  await b.call("ui.get_tree", { tab }); // 写入 data-ai-id，act 才能定位
  await sleep(300);

  const step = async (name, fn, stealOverride) => {
    // stealOverride：个别操作的行为与所在组的默认期望不同 —— 最典型的是只读操作
    // （get_tree），它在**任何**策略下都不碰窗口，所以即使在对照组里也不该抢。
    const want = stealOverride === undefined ? expectStealOnAction : stealOverride;
    focusTarget();
    await sleep(1500);
    const before = frontApp();
    let err = null;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    await sleep(1300);
    const after = frontApp();
    const stole = isBrowserApp(after) && !isBrowserApp(before);
    check(
      `${label} ${name} ${want ? "会" : "不"}抢焦点`,
      stole === want,
      `前台 ${before} -> ${after}${err ? " (调用报错: " + String(err.message).slice(0, 60) + ")" : ""}`
    );
  };

  await step("ui.new_tab", () => b.call("ui.new_tab", { url: HOST + "/focus" }));
  await step("ui.set_active_tab", () => b.call("ui.set_active_tab", { tab }));
  await step("ui.act type", () => b.call("ui.act", { action: "type", target: "txt", params: { text: "x" }, tab }));
  await step("ui.act click", () => b.call("ui.act", { action: "click", target: "btn", tab }));
  // 只读操作从不碰窗口 —— 任何策略下都不抢。
  await step("ui.get_tree（只读）", () => b.call("ui.get_tree", { tab }), false);
  await step("ui.network_list（只读）", () => b.call("ui.network_list", { tab }), false);

  try { b.close(); } catch { /* ignore */ }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
  guard.release(child);
  await sleep(1500);
}

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;
  const calcWasRunning = isTargetRunning();

  if (!CAN_DETECT) {
    note("非 macOS 或没有 lsappinfo —— 无法从外部观测前台应用，本套件全部跳过（不假装通过）");
    console.log(`\n==== focus PASS=${PASS} FAIL=${FAIL} ====`);
    server.close();
    process.exit(0);
  }

  // 端口必须是空闲的（默认 9223 很可能被正在跑的 ai-browser 占着）
  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first, or pick a free port:" +
      " AI_BROWSER_PORT=<port> npm run focus"
    );
    process.exit(3);
  } catch { /* free */ }

  note("观测手段：macOS lsappinfo 查当前前台应用；靶子 app 是「计算器」");
  note("测试期间会反复把「计算器」切到前台，这是测量本身需要，不是被测程序的行为");

  // G1：agent 通过 MCP 拉起 + 默认策略 → 从启动到操作都不该打扰人
  await runGroup({
    label: "G1 agent 拉起(auto)",
    port: WS_PORT,
    extraEnv: { AI_BROWSER_LAUNCHED_BY_AGENT: "1" },
    expectStealOnBoot: false,
    expectStealOnAction: false,
    HOST,
  });

  // G2：对照组。证明"这个测试确实测得出抢焦点" —— 若这里没抢，说明观测手段坏了。
  await runGroup({
    label: "G2 对照组(always)",
    port: WS_PORT + 1,
    extraEnv: { AI_BROWSER_FOCUS: "always" },
    expectStealOnBoot: true,
    expectStealOnAction: true,
    HOST,
  });

  // G3：人手动 `npm start` → 窗口出现在前台是**期望**行为；
  //     但之后的 agent 操作仍不该反复把它拽回来。
  await runGroup({
    label: "G3 人工启动(auto)",
    port: WS_PORT + 2,
    extraEnv: {},
    expectStealOnBoot: true,
    expectStealOnAction: false,
    HOST,
  });

  console.log(`\n==== focus PASS=${PASS} FAIL=${FAIL} ====`);
  if (!calcWasRunning) {
    try { execSync(`pkill -x ${TARGET_APP}`, { stdio: "ignore" }); } catch { /* ignore */ }
  }
  server.close();
  process.exit(FAIL > 0 ? 1 : 0);
}

const globalTimer = setTimeout(() => {
  console.error("FOCUS E2E TIMEOUT");
  guard.killAll();
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref();

main().catch((e) => {
  console.error("focus e2e error:", e && e.message);
  guard.killAll();
  process.exit(1);
});

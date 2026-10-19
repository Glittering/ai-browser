'use strict';
// e2e/_spawn_guard.cjs — e2e 脚本拉起的 Electron 进程统一回收。
//
// 为什么需要它：这些脚本用 `detached: true` 拉起 Electron，一旦运行被中断
// （超时、被 kill、未捕获异常、Ctrl-C），子进程就会变成孤儿继续存活。
// 孤儿会一直占着 WS 端口和 Electron 的单实例锁，后果是**用户之后连
// npm start 都起不来**，只会看到 "another AI Browser instance is already
// running"。真实发生过：一个残留的 smoke 进程占着 9223 两天。
//
// 用法：spawn 之后 `guard.track(child)`；脚本正常收尾时不必手动 release，
// 退出时统一按进程组回收（detached 的子进程自成一个进程组，用 -pid 收割）。

const spawned = new Set();
let installed = false;

// 为什么是 SIGKILL 而不是 SIGTERM（2026-10-20 实测）：
//
// 2026-10-20 跑 readcov 套件时，连续 4 次运行留下了 4 个 Electron 实例，
// 每个都还开着一个窗口 —— 用户看到的是"好几个纯白窗口"。原因不是没发信号，
// 是 **SIGTERM 的语义和 process.on('exit') 冲突**：SIGTERM 是"请求优雅退出"，
// Chromium 收到后要排队走自己的关闭流程，而发送方（本进程）发完信号就
// 立刻 exit 了。没人等，也没人补第二刀；只要 Chromium 那侧在关闭途中卡一下、
// 或者被 window-all-closed 之类的钩子拦住，进程就永远留着。
//
// e2e 实例用的是临时 userData（/tmp/ai-browser-e2e-*），**没有任何需要优雅
// 收尾的状态**（cookie 固化只对真实 profile 有意义）。所以这里直接 SIGKILL
// 整个进程组：同步、不可忽略、包含 renderer / GPU 助手进程。
// 代价是可以忽略的，收益是"跑完测试电脑上不会多出一堆白窗口"。
function killAll() {
  for (const c of Array.from(spawned)) {
    if (!c || !c.pid) continue;
    // 优先按进程组收割（含 renderer / GPU 助手进程）
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(c.pid, 'SIGKILL');
      } catch {}
    }
  }
  spawned.clear();
}

function install() {
  if (installed) return;
  installed = true;

  process.on('exit', () => {
    killAll();
  });

  const bail = (code) => (arg) => {
    try {
      if (arg && arg.message) console.error('e2e abort:', arg.message);
    } catch {}
    killAll();
    process.exit(code);
  };

  process.on('SIGINT', bail(130));
  process.on('SIGTERM', bail(143));
  process.on('uncaughtException', bail(1));
  process.on('unhandledRejection', bail(1));
}

module.exports = {
  /** 登记一个需要被回收的子进程。 */
  track(child) {
    install();
    if (child && child.pid) spawned.add(child);
    return child;
  },
  /** 主动释放（脚本已自行清理时调用，避免重复收割）。 */
  release(child) {
    if (child) spawned.delete(child);
  },
  killAll,
  install,
};

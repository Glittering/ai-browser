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

function killAll() {
  for (const c of Array.from(spawned)) {
    if (!c || !c.pid) continue;
    // 优先按进程组收割（含 renderer / GPU 助手进程）
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(c.pid, 'SIGTERM');
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

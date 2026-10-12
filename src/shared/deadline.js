// shared/deadline.js — 给"会进页面"的调用加超时（纯函数，可无 Electron 单测）
//
// # 为什么需要这个文件
// ws_server 的每个 case 都是 `await pageManager.xxx(...)`，顶层只有 try/catch ——
// 抓得住"抛错"，抓不住"不返回"。而 Chromium 的 CDP 命令**真的会不返回**：
// `Input.dispatchMouseEvent` 要等渲染进程 ack，渲染进程主线程被占住时 ack 永远不来。
//
// 实测（tools/_oneoff/blocked_renderer_probe.cjs，页面加载后 while 循环占住主线程
// 120s，单项上限 45s）：
//
//     ui.get_tree      5006ms  ERR getTree timeout     ← 本来就有超时
//     ui.evaluate     10012ms  ERR evaluate timeout    ← CDP 5s + preload 回落 5s
//     ui.get_focused   5006ms  ERR getTree timeout
//     ui.capabilities 15014ms  ok
//     ui.act          45001ms  **仍无回包**            ← 唯一真挂的一条
//
// 也就是说这不是"慢"，是 agent 的工具调用永久悬挂、整个会话死掉，而且**没有任何错误
// 可看**。比抛错严重得多：抛错至少能让 agent 换策略。
//
// # 为什么超时必须按动作算，而不是一个固定值
// 固定小值会误杀合法长操作。实测这些路径自己就会睡很久：
//   type/setContent 每字 interval_ms（默认 60ms）→ 500 字就是 30s
//   drag            duration_ms（默认 420ms）+ steps×~40ms，上限 5s
//   clear           要走编辑器状态提交，多处 80~150ms 等待 + 回读校验
// 所以预算 = max(基线, 该动作自报的预期耗时 × 2 + 余量)，并留 env / 单次调用的逃生门。

export const DEFAULT_ACTION_DEADLINE_MS = 15000;
export const MAX_ACTION_DEADLINE_MS = 300000;

/**
 * 把一个 promise 套上超时。超时抛出的 error 带 `__deadline` 标记，调用方可以
 * 据此把它翻译成"成功=false + 明确原因"，而不是当成未知异常往上抛。
 *
 * 原 promise 迟到拒绝会被接住（不会变成 unhandled rejection）—— 超时之后它仍可能
 * 完成或失败，那是后台的事，不该把进程吵醒。
 */
export function withDeadline(promise, ms, label) {
  const budget = Math.max(1, Number(ms) || DEFAULT_ACTION_DEADLINE_MS);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timeout after ${budget}ms`);
      err.__deadline = true;
      err.deadline_ms = budget;
      reject(err);
    }, budget);
  });
  // 防止"超时已报错，原 promise 之后才拒绝"变成 unhandled rejection。
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 算一个动作的合理超时预算（毫秒）。
 *
 * 优先级：单次调用 `params.timeout_ms` > env `AI_BROWSER_ACTION_TIMEOUT_MS` >
 * 按动作自报耗时推算。三者都是显式逃生门：agent 知道自己要 type 3000 字时，
 * 不该被一个猜出来的默认值卡死。
 */
export function actionDeadlineMs(action, params = {}) {
  const p = params || {};
  let need = DEFAULT_ACTION_DEADLINE_MS;

  const text = String(p.text || '');
  if (action === 'type' || action === 'setContent') {
    const iv = Number(p.interval_ms) > 0 ? Number(p.interval_ms) : 60;
    need = Math.max(need, text.length * iv + 5000);
  } else if (action === 'drag') {
    const dur = Number(p.duration_ms) > 0 ? Number(p.duration_ms) : 420;
    const steps = Number(p.steps) > 0 ? Number(p.steps) : 14;
    need = Math.max(need, dur + steps * 40 + 5000);
  } else if (action === 'press') {
    const rep = Number(p.repeat) > 0 ? Number(p.repeat) : 1;
    const iv = Number(p.interval_ms) > 0 ? Number(p.interval_ms) : 60;
    need = Math.max(need, rep * iv + 5000);
  } else if (action === 'clear') {
    // clear 要走编辑器状态提交与回读校验（多处 80~150ms 等待）。
    need = Math.max(need, 20000);
  }

  const env = Number(process.env.AI_BROWSER_ACTION_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) need = env;
  const perCall = Number(p.timeout_ms);
  if (Number.isFinite(perCall) && perCall > 0) need = perCall;

  return Math.min(Math.max(need, 1000), MAX_ACTION_DEADLINE_MS);
}

// shared/eval_route.cjs — evaluate 失败原因分类（唯一判据）。
//
// 为什么需要它（2026-10-31 实测，代价最大的一条）：
// `page_manager.evaluate` 原来是 `try { CDP } catch { preload eval }`。这个 catch 把
// **页面脚本自己抛的异常** 和 **CDP 不可用** 当成同一件事，于是：
//
//   Function('return globalThis["pro"+"cess"].version')()   ← 页面世界必抛
//     → CDP 抛 → 回落 preload → preload 有 Node → 返回 "v20.18.3"
//
// 也就是说：任何"会抛错"的 evaluate 都会被拿到宿主作用域重跑一次。
// `guards.js` 的正则只挡字面量 `process.` / `require(`，拆词拼接直接绕过。
//
// 所以：
//   1. 失败原因必须分类，脚本异常就说脚本异常（调用方该改脚本，不是重试）；
//   2. **永不回落到 preload** —— 那里有 Node，不存在"安全地降级"。
//
// 这个模块只做分类与信封，不做 IO，因此能用表驱动单测钉住每种消息。

const HINTS = {
  'cdp-unavailable': 'CDP debugger is not attached to this tab — reload the tab (ui.navigate to the same URL) or open a new one, then retry.',
  'cdp-timeout': 'The page main thread did not answer within the deadline; the script may have partially run. Re-read the page before retrying.',
  'script-error': 'The page threw while running your script. Fix the script (the message above is the page\'s own error), or read the tree instead.',
};

const CODES = ['cdp-unavailable', 'cdp-timeout', 'script-error'];

/**
 * 把一次 evaluate 失败归类。默认落在 'script-error'：宁可说"你的脚本错了"，
 * 也不能把一次真实异常伪装成"环境不可用"——后者会让调用方无脑重试。
 * @param {unknown} err
 * @returns {'cdp-unavailable'|'cdp-timeout'|'script-error'}
 */
function classifyEvalFailure(err) {
  const msg = String((err && err.message) || err || '');
  const low = msg.toLowerCase();
  if (low.includes('timeout')) return 'cdp-timeout';
  // 只有明确的"调试器不可用"才归到环境问题。
  if (low === 'no-cdp' || low.includes('no usable cdp') || low.includes('debugger is not attached')
      || low.includes('no-cdp') || low.includes('debugger not attached')) {
    return 'cdp-unavailable';
  }
  return 'script-error';
}

/**
 * @param {unknown} err
 * @returns {{ok:false, error:{code:string, message:string, retryable:boolean, hint:string}}}
 */
function evalFailureResult(err) {
  const code = classifyEvalFailure(err);
  const message = String((err && err.message) || err || 'evaluate failed').slice(0, 500);
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: code !== 'script-error',
      hint: HINTS[code],
    },
  };
}

module.exports = { classifyEvalFailure, evalFailureResult, CODES };

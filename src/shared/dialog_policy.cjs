// shared/dialog_policy.cjs — JavaScript 对话框（alert / confirm / prompt /
// beforeunload）的处理策略。
//
// # 为什么需要这一层（这是产品缺陷，不是站点适配）
//
// `alert()/confirm()` 不是页面 DOM 的一部分：Chromium 把它们交给 embedder
// 渲染，Electron 就画成**原生 sheet**（屏幕中间那个 Cancel / OK）。由此产生
// 三个后果，全都指向同一个事实——**agent 永远够不到它**：
//
//   1. 语义树里没有它（不在 DOM，也不在 AX 树），get_tree 看不见；
//   2. 截图里它是一层系统 UI，点击坐标不归页面渲染器管；
//   3. **对话框打开期间整个渲染器被阻塞**：Runtime.evaluate / Input.dispatch
//      全部挂住不返回，于是任何 act 都以"超时、主线程可能被阻塞"结束。
//
// 实测（2026-10-24，本地 fixture）：点一个调用 confirm() 的按钮 → act 15s
// 超时，随后 evaluate 8s 超时；屏幕上是一个原生 "确定删除这条评论？ Cancel/OK"。
// 用户侧表现就是"删不掉，还卡住"。
//
// 既然对话框属于**浏览器进程**，处理它的责任也必须在浏览器进程这边：
// 这一类对话框由本模块给出策略、由 page_manager 通过 CDP
// `Page.handleJavaScriptDialog` 直接应答（这条命令走浏览器进程，不需要
// 渲染器，所以对话框阻塞页面时它照样有效）。
//
// # 默认策略（auto）为什么是"接受"
//
// 对话框是对**上一个用户动作**的确认。agent 点"删除评论"时，点击本身就是
// 意图，再让它去点"确定"没有任何信息增量 —— 拒绝反而会让删除永远失败
// （这正是用户报的现象）。所以 auto 接受 alert/confirm/beforeunload；
// prompt 用页面自带的默认值提交（等于人直接按 OK），并把提交的值回报给
// 调用方。策略可整体覆盖：AI_BROWSER_DIALOG_POLICY=auto|accept|dismiss|manual。
//
// manual 只用于诊断：不自动应答，对话框保持打开，由人来点。

'use strict';

const POLICIES = ['auto', 'accept', 'dismiss', 'manual'];

/** 环境变量/参数里的策略值归一化；非法值回落到 auto（不因为配置写错就卡死页面）。 */
function normalizePolicy(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return POLICIES.includes(s) ? s : 'auto';
}

/** 从环境变量读策略。每次读而不是缓存：便于诊断时改环境重启即可。 */
function policyFromEnv(env = process.env) {
  return normalizePolicy(env && env.AI_BROWSER_DIALOG_POLICY);
}

/**
 * 决定一个对话框怎么应答。
 *
 * @param {{type?:string, message?:string, defaultPrompt?:string}} dialog
 *        CDP `Page.javascriptDialogOpening` 的载荷。
 * @param {{policy?:string}} [opts]
 * @returns {{accept:boolean, promptText?:string, auto:boolean, reason:string}}
 *   auto=false 表示"没有人替它做决定"（manual 策略），调用方需要把它暴露出去。
 */
function decideDialog(dialog, opts = {}) {
  const policy = normalizePolicy(opts.policy);
  const type = String((dialog && dialog.type) || 'alert');

  if (policy === 'manual') {
    return { accept: false, auto: false, reason: 'manual: left open for a human/caller' };
  }
  if (policy === 'accept') {
    return { accept: true, auto: true, promptText: promptAnswer(dialog), reason: 'policy=accept' };
  }
  if (policy === 'dismiss') {
    return { accept: false, auto: true, reason: 'policy=dismiss' };
  }

  // auto：按"人看到这个对话框会怎么做"来判断
  switch (type) {
    case 'beforeunload':
      // 触发它的动作（点链接 / navigate / 关标签）本身就是"我要走"，人也是点
      // "离开"。拒绝会让 unload 卡死，页面再也导航不了。
      return { accept: true, auto: true, reason: 'auto: beforeunload → leave (the action asked for it)' };
    case 'alert':
      // 只有一个按钮，没有选择空间。
      return { accept: true, auto: true, reason: 'auto: alert → ok' };
    case 'confirm':
      return { accept: true, auto: true, reason: 'auto: confirm → accepted (the action that raised it was the intent)' };
    case 'prompt':
      // 文本无法猜，用页面给的默认值提交（等价人直接按 OK），并把值回报。
      return { accept: true, auto: true, promptText: promptAnswer(dialog), reason: 'auto: prompt → accepted with default text' };
    default:
      return { accept: true, auto: true, reason: `auto: ${type} → accepted` };
  }
}

function promptAnswer(dialog) {
  const d = dialog && dialog.defaultPrompt;
  return typeof d === 'string' ? d : '';
}

/**
 * 导航时是否放行 beforeunload（Electron 的 will-prevent-unload）。
 * 只有明确要求"别自动通过"的策略才拦：manual / dismiss。
 */
function allowUnload(opts = {}) {
  const policy = normalizePolicy(opts.policy);
  return policy === 'auto' || policy === 'accept';
}

module.exports = {
  POLICIES,
  normalizePolicy,
  policyFromEnv,
  decideDialog,
  allowUnload,
};

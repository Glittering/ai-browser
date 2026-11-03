// shared/input_routing.cjs — "这一页现在收不收得到 CDP 受信输入"的唯一判据。
//
// 为什么需要这一层（2026-11-03 逐杠杆实测）：
//   窗口**从未显示过**时，页面自报 document.visibilityState:'visible' 的**唯一条件**是
//   那一页拿到过 CDP 的 `Emulation.setFocusEmulationEnabled{enabled:true}`；没拿到的页
//   一律 'hidden'。而 Chromium 对 hidden 文档**丢弃** CDP 受信输入 —— 事件发出去不报错、
//   不排队、也不改投给别人（实测：hidden 页收不到时，另一页的计数器一次都没涨，所以
//   不存在跨标签页串台），就是没了。
//   后果是最坏的那一种：ui.act click 依旧回 `{success:true, clicked_via:'cdp-click'}`
//   —— 回执在说谎。agent 以为点过了，页面什么都没发生，只能重试或放弃。
//   产品平时把那一招用在每个活动页上（AI_BROWSER_FOCUS=auto 的本体：只伪造页面内焦点态，
//   不抢真实窗口焦点），所以"顶上去过的那一页"能收输入，其余不能 —— 这就是
//   "多 agent 后台跑，第二个 agent 点不动"的真面目。
//   ⚠️ 同一条实测顺手证伪了 _focusWindow 注释里那句"窗口隐藏时 CDP 输入照样生效"：
//   AI_BROWSER_FOCUS=never 时**连活动页都是 hidden**，模拟输入一样被丢 —— 那种组合下
//   ui.act 结构性地做不到，只能如实失败，不能假装成功。
//
// 修法：动作之前先问页面一句"你现在 visible 吗"（一发极短的 CDP 读），收不到就给那一页
// 补上产品已经在用的那招，再问一次；还是收不到就**不发事件**、如实报错。
//
// 排除掉的几根（都是当场量出来的，不是猜的）：
//   setTopBrowserView（置顶）            → visibility 照旧 hidden，事件照旧没
//   webContents.focus()（原生焦点）      → 同上
//   removeBrowserView + addBrowserView   → 同上
//   setBounds（重排）/ setBackgroundThrottling(false) / invalidate → 同上
//   Page.setWebLifecycleState{active}    → 命令存在，但 visibility 不变
//   Emulation.setPageVisibilityOverride  → Chromium 130 没有这条命令（'wasn't found'）
//   window.showInactive()                → 有效（而且此后一直有效），代价是窗口真的出现在屏幕上
//   Emulation.setFocusEmulationEnabled   → ✅ 一次就翻转，点击与键入都落到位
//
// 判据放这里、执行放 page_manager，理由和 tab_audio / tab_group 一样：纯函数可以表驱动钉死，
// 而"什么时候该伪造、伪造了还不行怎么收场"正是会被写歪的那部分。

'use strict';

/**
 * 会走 CDP 受信输入的动作。
 *
 * 为什么按动作而不是"所有 ui.act"：get_value / reload / repaint 是只读或控制类，
 * 不需要页面在线；upload 走 DOM.setFileInputFiles（JS 路径，hidden 文档照样收）；
 * 而 JS 回退路径（preload 合成事件）本来就不受可见性影响 —— 它只在没有 debugger
 * 会话时被用到，那时这一招也没法用。
 */
const TRUSTED_INPUT_ACTIONS = [
  'click', 'hover', 'drag', 'wheel',
  'type', 'setContent', 'clear',
  'press', 'paste',
];

const ENV_KEY = 'AI_BROWSER_INPUT_FOCUS';

function trustedInputAction(action) {
  return TRUSTED_INPUT_ACTIONS.indexOf(String(action || '')) >= 0;
}

/**
 * 要不要为收不到输入的那一页补一次焦点伪造（默认开，关掉：AI_BROWSER_INPUT_FOCUS=0）。
 *
 * 留开关不是"功能可以关"，是**出事能退回如实报错**：这一招会让页面自认为在前台，
 * 个别站点的"看不见就暂停"逻辑会因此继续跑。关掉之后行为并不回到"谎报成功"——
 * 量到收不到就如实失败。形状沿用 AI_BROWSER_BG_MUTE。
 */
function focusEnabled(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const raw = src[ENV_KEY];
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * 这一页现在收不收得到受信输入。
 *
 * visibility 用**页面自己报的**那份，不用"是不是活动页""窗口可见与否"这类主进程侧的
 * 推断 —— "活动页一定 visible"这一条就是这么被证伪的：AI_BROWSER_FOCUS=never 下
 * 活动页同样 hidden，输入同样被丢。平台行为哪天变了，这里跟着事实走。
 *
 * 'prerender' / 'unloaded' 都不算能收输入 —— 只有 'visible' 放行。
 * null（没量到 / 量不到）放行：观测能力不足不能反过来让动作失败，也不能拦住原本能成的
 * 动作（没有 debugger 会话的旧路径就是这个情形）。
 */
function isReceivable({ visibility } = {}) {
  // 只有量到一个非空字符串才算"量到了"。null / undefined / '' / 非字符串一律当作没量到。
  if (typeof visibility !== 'string' || visibility === '') return true;
  return visibility === 'visible';
}

/** 要不要补那一招焦点伪造。开关关掉时不补，但下面的"如实失败"照旧生效。 */
function needsVisibilityFix({ action, visibility, enabled } = {}) {
  if (!trustedInputAction(action)) return false;
  if (enabled === undefined ? !focusEnabled() : !enabled) return false;
  return !isReceivable({ visibility });
}

/**
 * 发事件之前最后一次判要不要如实失败。
 *
 * 这一条**不看开关**：AI_BROWSER_INPUT_FOCUS=0 关掉的是"那一招"，不是"别说谎"。
 * 退路必须退到"如实报错"，不能退到"假装成功"。
 */
function shouldRefuse({ visibility } = {}) {
  return !isReceivable({ visibility });
}

/**
 * 仍然收不到 —— 如实失败，事件**不发**。
 *
 * 文案要写清三件事：什么都没发生（不是"部分生效"）、为什么（这一页自认不在前台，
 * Chromium 会丢弃模拟输入）、出路在哪（JS 路径，或者把窗口显示出来 / 换焦点策略）。
 * 调用方熟悉的旧回执是 success:true，不写清"什么都没发生"它就会照着旧经验重试，
 * 于是一次点击变成两次。
 */
function notReceivableError({ action, tabId, visibility, focusPolicy, env }) {
  const why = visibility === undefined || visibility === null
    ? 'visibility unknown'
    : `document.visibilityState=${visibility}`;
  const tried = String(focusPolicy || '').toLowerCase() === 'never'
    ? 'AI_BROWSER_FOCUS=never forbids page-focus emulation, so this window state cannot deliver simulated input at all'
    : (focusEnabled(env)
      ? 'page-focus emulation did not make it frontmost'
      : 'page-focus emulation is off (AI_BROWSER_INPUT_FOCUS=0)');
  return `action:${action} was NOT delivered to tab ${tabId} — that page reports ${why} `
    + `and Chromium drops simulated input on such a page; ${tried}. `
    + 'Nothing was clicked or typed, so do not retry blindly. '
    + 'Use ui.evaluate for a JS-side action, or show the window (ui.window {visible:true}) '
    + 'once — after that every tab stays reachable.';
}

module.exports = {
  ENV_KEY,
  TRUSTED_INPUT_ACTIONS,
  trustedInputAction,
  focusEnabled,
  isReceivable,
  needsVisibilityFix,
  shouldRefuse,
  notReceivableError,
};

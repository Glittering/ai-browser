// shared/tab_group.cjs — 标签页归属：人的一组，每个 agent 一组。
//
// 解决的是"多 agent 同时用同一个浏览器"的最后一公里：v2.2.0 已经把**默认目标**
// 从全局 activeTab 改成会话级，但 agent 的页仍然混在人的标签条里，看不出谁是谁的；
// 更麻烦的是没有上限 —— 一个跑长任务的 agent 能开二十个标签页，内存被无声吃掉。
//
// 这里只有纯函数，不碰 Electron：判据能被单测钉住（tests/test_tab_group.js）。
//
// 三个概念分清楚，不要混：
//   group   —— 归属（人的 / 某个 agent 的），决定标签栏怎么归拢、上限算谁的
//   active  —— 人眼前看的是哪一页。**看**不等于**拥有**：人点开 agent 的页看它
//              干活，那一页仍然属于 agent，agent 的目标不受影响
//   目标    —— 某次调用作用在哪一页（shared/tab_route.cjs 的 explicit>session>…）
'use strict';

/** 人的标签页统一归这一组。它不是"某个会话"，而是"没有会话"。 */
const HUMAN_GROUP = 'human';

/** 默认每组上限。8 是权衡：一个正常流程（登录页 + 列表 + 详情 + 后台）留得下，
 *  再多的多半是没关的中间页。环境变量 AI_BROWSER_TAB_LIMIT 可调。 */
const DEFAULT_LIMIT = 8;

/** 组色板。只用于标签栏上那个小圆点，不承载语义。 */
const COLORS = ['#7c6cf0', '#3fb6a8', '#e0a33e', '#e06c75', '#5aa9e6', '#c678dd'];

function groupIdForSession(sessionId) {
  return sessionId ? 'agent:' + sessionId : HUMAN_GROUP;
}

function isAgentGroup(group) {
  return typeof group === 'string' && group.indexOf('agent:') === 0;
}

function isHumanGroup(group) {
  return !isAgentGroup(group);
}

/**
 * 每 agent 的标签页上限。
 *
 * 为什么要上限：这是唯一能**自动**约束 agent 的机制。一个跑长任务的 agent 会
 * 用"再开一个标签页"来回避"这一页怎么办"的决定（人也是这样），几十个标签页在
 * 无头式后台运行里完全不可见，直到内存告急。硬上限把"要不要留这一页"提前变成
 * 一次必须做的决定。
 */
function limitFromEnv(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const raw = Number(src.AI_BROWSER_TAB_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), 64);
}

function colorFor(index) {
  const n = COLORS.length;
  return COLORS[((index % n) + n) % n];
}

/**
 * 还能不能再开一页。
 *
 * 只对 agent 组生效：人的标签页不受任何限制（限制人会让产品变得没法用，而且
 * 人要开多少页是他自己的事）。limit<=0 视为不限。
 */
function decideOpen({ group, count, limit }) {
  if (!isAgentGroup(group)) return { allowed: true, count, limit: null, remaining: null };
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  const used = Number.isFinite(count) && count > 0 ? count : 0;
  return {
    allowed: used < cap,
    count: used,
    limit: cap,
    remaining: Math.max(0, cap - used),
  };
}

/** 哪些动作等于"在这一页留下了还没提交的内容"（草稿保护的置位/清除条件）。
 *  mark：把文字送进页面。clear：把文字清掉 —— 没有内容可丢了，保护跟着解除。
 *  点击/键盘/滚动都不算：它们改的是页面状态，不是"别人写了一半的东西"。 */
const DRAFT_MARK = ['type', 'setContent', 'paste'];
const DRAFT_CLEAR = ['clear'];

/** @returns {'mark'|'clear'|null} 这个动作对草稿状态的影响。 */
function draftEffect(action) {
  const a = String(action || '');
  if (DRAFT_MARK.indexOf(a) >= 0) return 'mark';
  if (DRAFT_CLEAR.indexOf(a) >= 0) return 'clear';
  return null;
}

/**
 * 弹窗（页面里 window.open / target=_blank）把组撑满时，牺牲哪一页。
 *
 * 为什么弹窗不能像 ui.new_tab 一样直接拒绝：这个弹窗是**页面脚本要的**，拒绝
 * 等于让站点的流程断在半路（OAuth 回调、打印预览、编辑器子窗口）。所以这里退一步，
 * 挑一页最不心疼的关掉。排除的条件按 Chrome Memory Saver 那张"不许丢弃"清单裁到
 * 我们模型里真实存在的几条（我们的淘汰比 Chrome 的 discard 更狠 —— 整页关掉、
 * 状态全没，所以保护必须更紧，不是更松）：
 *   - 正在被打开的那个（except，关了自己等于什么都没发生）
 *   - 人眼前那一页（activeTab，人正在看）
 *   - 有对话框挂着的（那是"等人点"的状态，关掉就把人的操作吞了）
 *   - **有没提交的输入的**（draft：填了一半的表单、写了一半的私信。关掉等于把
 *     人或者 agent 几分钟的工作删了，而且 reload 回不去那个草稿）
 *   - **有进行中的下载的**（downloading：关掉标签页会连带取消那条下载）
 * "正在放声音"这一条不在这里判，因为架构已经把它消化掉了：agent 的后台页从出生起
 * 就被按住声音（shared/tab_audio.cjs），能出声的只有人眼前那一页（= activeTab，
 * 上面已经排除）和人自己开的页（不归这个组管）。
 * 剩下的按"最久没用"排序（usedAt 由 page_manager 在导航/动作时刷新）。
 * 没有候选就返回 null，调用方只好允许超限 —— 宁可多一页，不要吞掉正在用的页。
 * 这一条比 Chrome 更松（Chrome 会撑破上限），是有意的：超限只多占一份内存，
 * 选错牺牲品丢的是别人正在做的事。
 */
function pickEvictable({ tabs, except, activeTab }) {
  const list = Array.isArray(tabs) ? tabs : [];
  let best = null;
  for (const t of list) {
    if (!t || t.id === undefined || t.id === null) continue;
    if (t.id === except || t.id === activeTab) continue;
    if (t.dialog || t.draft || t.downloading) continue;
    const at = Number(t.usedAt) || 0;
    if (!best || at < best.usedAt) best = { id: t.id, usedAt: at, url: t.url || '' };
  }
  return best ? best.id : null;
}

module.exports = {
  HUMAN_GROUP,
  DEFAULT_LIMIT,
  COLORS,
  groupIdForSession,
  isAgentGroup,
  isHumanGroup,
  limitFromEnv,
  colorFor,
  decideOpen,
  draftEffect,
  pickEvictable,
};

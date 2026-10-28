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

/**
 * 弹窗（页面里 window.open / target=_blank）把组撑满时，牺牲哪一页。
 *
 * 为什么弹窗不能像 ui.new_tab 一样直接拒绝：这个弹窗是**页面脚本要的**，拒绝
 * 等于让站点的流程断在半路（OAuth 回调、打印预览、编辑器子窗口）。所以这里退一步，
 * 挑一页最不心疼的关掉。三条排除：
 *   - 正在被打开的那个（except，关了自己等于什么都没发生）
 *   - 人眼前那一页（activeTab，人正在看）
 *   - 有对话框挂着的（那是"等人点"的状态，关掉就把人的操作吞了）
 * 剩下的按"最久没用"排序（usedAt 由 page_manager 在导航/动作时刷新）。
 * 没有候选就返回 null，调用方只好允许超限 —— 宁可多一页，不要吞掉正在用的页。
 */
function pickEvictable({ tabs, except, activeTab }) {
  const list = Array.isArray(tabs) ? tabs : [];
  let best = null;
  for (const t of list) {
    if (!t || t.id === undefined || t.id === null) continue;
    if (t.id === except || t.id === activeTab) continue;
    if (t.dialog) continue;
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
  pickEvictable,
};

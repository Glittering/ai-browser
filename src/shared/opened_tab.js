// shared/opened_tab.js — 判断"这条新标签记录是不是本次动作造成的"
//
// 背景（2026-10-19 实测）：_openedTabs 记录"某个 tab 打开了新标签"，供
// executeAction 回报 opened_tab 并自动切换过去。但记录的产生方不止 act：
//   • window.open 垫片 / setWindowOpenHandler 也会写这条记录
//   • 如果那次 window.open 是 ui.evaluate 里 el.click() 触发的，就**没有人消费它**
// 于是陈旧记录会挂在 map 里，被下一次点击或悬停误认为"我刚开了个标签"。
// 实测症状：在课程列表页点过「进入学习」之后，随后的 hover 回执里
// opened_tab 指向那个 about:blank —— 一个与本次操作毫无关系的标签。
//
// 规则：只有**在本次动作开始之后**记录的条目才算数。时间戳由 act 入口打，
// 这里只做纯判定，便于单测。

/**
 * @param {{id:number,url:string,at?:number}|null|undefined} entry 已取出的记录
 * @param {number|undefined} startedAt 本次动作的开始时刻（ms）
 * @returns {object|null} 属于本次动作的记录，否则 null
 */
export function pickOpenedTab(entry, startedAt) {
  if (!entry) return null;
  // startedAt 缺省时保持旧行为（调用方没提供时间基准，不做时间过滤）
  if (startedAt === undefined) return entry;
  // 没有时间戳的旧记录一律视为陈旧：宁可漏报一次，也不要把别的动作的标签
  // 算到这次头上 —— 后者会让 agent 去操作一个它没打开过的页面。
  if (typeof entry.at !== 'number') return null;
  return entry.at >= startedAt ? entry : null;
}

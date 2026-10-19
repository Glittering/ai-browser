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

// ── 「等一下再收」的宽限窗口 ──────────────────────────────────────────────
//
// 2026-10-19 实测（西电专技课程页点「进入学习」，站点代码是
// `var w = window.open("","_blank"); w.location = res.url;`）：
//
//   act 返回      10~15 ms
//   新标签出现   105 / 214 / 236 ms   ← 三轮，**不稳定**
//
// 第一轮测到的 105~119ms（三轮）是热缓存下的假稳定，加了等待之后复测就散到
// 200ms 以上了 —— 站点是先 fetch 拿到地址再 window.open，所以延迟跟着网络走。
// 这条推翻了我最初"固定 100ms 就够"的判断，记在这里免得下次又按那个数设计。
//
// 结论：**单靠一个窗口不可能既覆盖又不拖慢**，所以配两个提前退出条件：
//   1. 已经有记录 → 立刻返回（零等待）；
//   2. 本 tab 开始原地导航（isLoading）→ 立刻返回。站内跳转不会同时开新标签，
//      而这一类点击恰恰是最高频的，于是最常见的情况根本不会付这笔时间。
// 剩下的（点了按钮、页面既没导航也没开标签）才等满窗口。
//
// 为什么是固定窗口而不是"等到页面安静"：没有可靠的"安静"信号 —— 页面自己的
// 定时器、动画、轮询会让它永远不安静（教训见 hover 的收菜单那段注释）。
//
// 代价要说明白：窗口大小直接乘以"无副作用的点击次数"。所以它必须可关：
//   · `opened_tab_wait_ms: 0`  单次调用关掉
//   · `AI_BROWSER_OPENED_TAB_WAIT_MS=0`  全局关掉（跑基准测试时用）
export const DEFAULT_OPENED_TAB_GRACE_MS = 250;
const MAX_GRACE_MS = 2000;

/**
 * 本次点击应该为"新标签记录"等多久。
 *
 * @param {object} [params] act 的参数体
 * @param {NodeJS.ProcessEnv|object} [env] 便于测试注入
 * @returns {number} 毫秒，0 表示不等
 */
export function openedTabGraceMs(params, env) {
  const explicit = params && Number(params.opened_tab_wait_ms);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.min(explicit, MAX_GRACE_MS);
  const e = env || (typeof process !== 'undefined' ? process.env : null);
  const fromEnv = e && Number(e.AI_BROWSER_OPENED_TAB_WAIT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.min(fromEnv, MAX_GRACE_MS);
  return DEFAULT_OPENED_TAB_GRACE_MS;
}


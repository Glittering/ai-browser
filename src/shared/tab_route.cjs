// shared/tab_route.cjs — 「这次调用到底操作哪个标签页」的唯一判据
//
// # 为什么需要它（2026-10-27，多 agent 并用）
//
// 以前默认目标是**全局** `activeTab` —— 也就是"人眼看的那一个"。单 agent 时它
// 恰好等于"agent 正在干的活"，所以看不出问题。多个 agent 同时用的时候它立刻
// 崩掉：
//   - A 开一个标签页 → 所有人的默认目标都变成它；
//   - B 只说了"点一下提交"，结果点在 A 的页面上；
//   - 人切到别的标签页看热闹 → 把所有 agent 的目标一起切走。
// 这三件事的共同点：**动作落在哪个页面，取决于别人做了什么**。这是最难查的
// 一类 bug（回执 success、页面确实变了，但不是该变的那个）。
//
// 所以默认目标的优先级写在这一处，且只有这一处：
//
//   explicit（调用方点名） > session（这个连接自己的标签页） > active（人眼看的） > 第一个
//
// 两条不可退让的约束：
// 1. **点名不存在的 tab 必须报错**，绝不"就近挑一个"。静默改目标 = 在错的页面上
//    执行成功 = 比失败更糟。
// 2. **会话标签页被关掉也要报错**（而不是退回 active）。owner 自己关的会清掉绑定，
//    所以走到这条分支意味着"别人动了你的页面" —— 调用方需要知道，而不是继续
//    在另一个页面上操作。

/**
 * @param {object} o
 * @param {number|null|undefined} o.explicit  调用方显式传的 tab
 * @param {number|null|undefined} o.session   这个连接绑定的标签页
 * @param {number|null|undefined} o.active    人眼看的那一个
 * @param {number[]} o.tabs                   当前存在的标签页
 * @returns {{tab:number|null, source:string, error?:string}}
 *   source: explicit | session | active | first | none | gone | session-gone
 */
function resolveTarget(o) {
  const opts = o || {};
  const known = Array.isArray(opts.tabs) ? opts.tabs : [];
  const has = (id) => id !== undefined && id !== null && known.indexOf(id) >= 0;
  const explicit = opts.explicit;
  const session = opts.session;
  const active = opts.active;

  if (explicit !== undefined && explicit !== null) {
    if (!has(explicit)) {
      return {
        tab: explicit,
        source: 'gone',
        error: 'tab ' + explicit + ' does not exist (open one with ui.new_tab, or check ui.list_tabs)',
      };
    }
    return { tab: explicit, source: 'explicit' };
  }

  if (session !== undefined && session !== null) {
    if (!has(session)) {
      return {
        tab: null,
        source: 'session-gone',
        error: 'your tab ' + session + ' is gone (closed); call ui.new_tab to open a new one, or ui.set_active_tab to pick one that still exists. Refusing to fall back to another tab — that would run this call on someone else\'s page.',
      };
    }
    return { tab: session, source: 'session' };
  }

  if (has(active)) return { tab: active, source: 'active' };
  if (known.length) return { tab: known[0], source: 'first' };
  return { tab: null, source: 'none', error: 'no tabs open' };
}

/**
 * 新建标签页要不要**切到人眼前**。
 *
 * 默认 **否**：人正在看的那一页是人的东西，agent 开一个新页面不该把它顶掉。
 * 三种情况例外：
 *   - 调用方显式要求（show:true）——"这一步需要你看一眼"，比如扫码登录；
 *   - 人自己点的「+」（UI 层用 defaultShow:true 调）；
 *   - 当前根本没有可见标签页，或者可见的还是**启动页** —— 那种时候没有"人的页面"
 *     可保护，不看新页反而像什么都没发生（agent 干活，用户盯着百度首页）。
 */
function shouldShowNewTab(o) {
  const opts = o || {};
  if (opts.requested === true) return true;
  if (opts.requested === false) return false;
  if (opts.defaultShow === true) return true;
  if (!opts.hasVisible) return true;
  return opts.visibleIsStartup === true;
}

/**
 * 站点 window.open / target=_blank 派生出来的标签页要不要显示：
 * **跟着打开它的那一个走**。后台标签页里弹出来的窗口，也不该蹦到人眼前 ——
 * agent 的流程里这种弹窗极多（登录、下载、预览），每弹一个就抢一次视野。
 */
function shouldShowChildTab(o) {
  const opts = o || {};
  if (opts.openerIsVisible === true) return true;
  return false;
}

module.exports = { resolveTarget, shouldShowNewTab, shouldShowChildTab };

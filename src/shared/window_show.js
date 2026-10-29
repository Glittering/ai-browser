// shared/window_show.js — 窗口"显示那一刻"的自述口径。
//
// 为什么单独一个模块：这里连续出过两次同一类问题，都是**记录比事实好看**。
//
//   第一次（2026-10-14）：`waited_for_dom` 恒为 true —— 3s 兜底显示时也报 true，
//   于是"等到了 dom-ready"和"我们主动选择先显示"混成同一种结果，白屏缺陷从
//   记录里看不出来。修法是把"为什么现在显示"记成 show_reason。
//
//   第二次（2026-10-29，就是本模块）：那次修复只区分了 timeout，**漏掉了占位页**。
//   2026-10-24 起新标签页先加载 `loading.html`（把白屏变成"正在打开 <url>"），
//   而这个占位页自己会发 dom-ready —— 于是 `show_reason: 'dom-ready'` +
//   `waited_for_dom: true` 照旧成立，只不过等到的 DOM 是**我们自己的**占位页。
//   实测：起始页是 baidu，外网不通时窗口照样报"等到了 dom-ready"，而此刻页面
//   是我们的占位页（body 578 字符），1.5s 后仍是 578。
//
// 所以口径必须按"谁的 DOM"来分：
//   dom-ready / renderer-ready + 目标文档  → 真等到了，waited_for_dom = true
//   dom-ready / renderer-ready + 占位页    → show_reason = 'placeholder'，
//                                            waited_for_dom = false（我们没等到目标页）
//   timeout                               → false
//   fail-load                             → false（目标文档**失败**了，随后由自绘错误页接手）
//
// ⚠️ 这个模块**不改显示时机**。占位页一就绪就显示，是 2026-10-24 的决定
// （人先看到"正在打开 <url>"比看到白屏好）。这里只负责把那一刻记录成事实。
// 本文件是 ESM（主进程直接 import），占位页判定复用 CJS 模块。
import placeholder from './placeholder.cjs';

/**
 * 调用方（showOnce）能传进来的**事件名**。与输出枚举分开：
 * 'placeholder' 是**折算出来的结论**，不是事件 —— 把它混进输入侧会让"输出在枚举内"
 * 这条不变量变成自证（输入什么就输出什么）。
 */
export const SHOW_EVENT_REASONS = ['dom-ready', 'renderer-ready', 'fail-load', 'timeout'];

/** show_reason 的合法取值（输出侧）。新增一个必须同时改这里和 NV-A3b 的枚举断言。 */
export const SHOW_REASONS = [
  'dom-ready', 'renderer-ready', 'fail-load', 'timeout', 'placeholder',
  // 归因不明时保留原样（调用方传了奇怪的字符串）—— 留在枚举里是为了让
  // "输出一定是枚举之一"这条不变量成立，而不是让读的人去猜。
  'unknown',
];

/** 这两个原因字面上是"文档就绪"，但只有 url 不是占位页时才作数。 */
const READY_REASONS = new Set(['dom-ready', 'renderer-ready']);

/**
 * 把"触发显示的事件 + 当时 webContents 的 URL"折算成可对外播报的自述。
 *
 * 纯函数，无 Electron 依赖 —— 这一层必须能被单测钉死，因为它回答的是
 * "我们说的话算不算数"，而这类错误在 e2e 里只会表现为一个莫名其妙的红。
 *
 * @param {string} reason 触发显示的事件名：dom-ready / renderer-ready / fail-load / timeout
 * @param {string} url    那一刻 webContents.getURL()（可能为空串）
 * @returns {{show_reason: string, waited_for_dom: boolean, on_placeholder: boolean}}
 */
export function classifyShowReason(reason, url) {
  const r = String(reason || 'unknown');
  const ready = READY_REASONS.has(r);
  // 空串也算占位页（导航刚发起时 getURL() 还是空，见 placeholder.cjs 的说明）。
  // 网络页面一律不算 —— 一个恰好叫 loading.html 的站点页面不该被误判。
  let onPlaceholder = false;
  try {
    onPlaceholder = placeholder.isPlaceholderUrl(url);
  } catch (_e) {
    onPlaceholder = false;
  }
  if (ready && onPlaceholder) {
    return { show_reason: 'placeholder', waited_for_dom: false, on_placeholder: true };
  }
  return { show_reason: r, waited_for_dom: ready, on_placeholder: onPlaceholder };
}

/**
 * 记录里额外要带的那句"我当时看到的是哪一页"。
 *
 * 只留 origin+路径太长（占位页 URL 里带着目标地址，那正是最有用的一半），
 * 所以整串保留但截断 —— 一条记录被撑到几千字符会让日志无法目视。
 */
export function describeShowUrl(url, max = 300) {
  const s = String(url || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// shared/tab_hooks.js — 给 pageManager.setActive 挂副作用钩子，且**不吞返回值**。
//
// 为什么要单独抽出来（2026-10-19 实测事故）：
//   index.js 为了「地址栏状态跟随激活 tab」在启动时给 setActive 套了一层包装：
//       const orig = pageManager.setActive.bind(pageManager);
//       pageManager.setActive = function (tabId) { orig(tabId); wireNavState(tabId); };
//   包装里忘了 return。setActive 原本 return true/false，是**协议的一部分**：
//   ws_server.js 里 `const ok = pageManager.setActive(params.tab)` 再回
//   `{ ok }` 给客户端。丢掉返回值 → ok 变 undefined → JSON.stringify 直接把这个
//   键删掉 → agent 收到 `{}`，拿不到"切成功了没"的任何确认。
//
//   这个 bug 极难在端到端里看出来：tab 实际上**切成功了**（list_tabs 显示 active
//   已变），只有回执是空的。所以修法不只是补一个 return，而是把"套钩子"这件事
//   变成一个被测过的函数，以后再有人往上挂副作用，返回值天然被保住。
//
// 契约（tests/test_tab_hooks.js 钉住）：
//   1. 返回值原样透传（true / false / 任何值）；
//   2. 钩子在**原方法之后**执行 —— 它要读 activeTab 这类被原方法改过的状态；
//   3. 原方法抛异常时钩子不执行，异常照常向上抛（不能掩盖真错误）；
//   4. this 绑定到原 pageManager（原方法可能是 class 方法，用到 this）。
export function wrapSetActive(pageManager, onAfter) {
  if (!pageManager || typeof pageManager.setActive !== 'function') {
    throw new TypeError('wrapSetActive: pageManager.setActive is not a function');
  }
  const orig = pageManager.setActive.bind(pageManager);
  const wrapped = function (tabId) {
    const result = orig(tabId);
    if (typeof onAfter === 'function') onAfter(tabId, result);
    return result;
  };
  pageManager.setActive = wrapped;
  return wrapped;
}

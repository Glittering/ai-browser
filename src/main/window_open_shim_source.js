// window_open_shim_source.js — 注入页面主 world 的 window.open 兼容垫片源码
//
// 背景：站点惯用法（超星专技平台等大量老站）是
//     var w = window.open("", "_blank"); // 先开一个新页面
//     w.location = res.url;              // 再把真实地址赋给它
// 主进程的 setWindowOpenHandler 对 window.open 一律 deny（改为自建 tab），
// deny 之后 window.open 返回 null，页面再赋 w.location 直接抛 TypeError ——
// 用户看到的就是一个光秃秃的 about:blank 标签，站点逻辑静默断裂。
// （实测：pxsxzj.xidian.edu.cn「进入学习」，2026-10-19。）
//
// 为什么必须走 CDP 注入而不是 preload：tab 的 BrowserView 是
// contextIsolation:true，preload 里写的 window.open 只作用于 isolated
// world 的 window，页面脚本看到的仍是原生 window.open（第一版就是这么
// 失败的——隔离测试里 window.open() 返回 falsy）。Page.addScriptToEvaluate
// OnNewDocument 注入的脚本跑在主 world，才能真正替换掉页面可见的那个。
//
// 通信：垫片本体没有 ipcRenderer，经 preload 用 contextBridge 暴露的
// window.__ai_browser__.windowOpen / windowOpenNav / windowOpenClose
// （fire-and-forget）把事件送到主进程；主进程建 tab / 导航 / 关 tab。
// 注入脚本通常晚于 preload 完成（Electron 保证 preload 先于页面脚本），
// 桥立即可用；万一拿不到桥，window.open 返回 null，即退化为原生行为。
export const WINDOW_OPEN_SHIM_SOURCE = `(function () {
  if (window.__aiWindowOpenShimV2) return;
  window.__aiWindowOpenShimV2 = true;
  var seq = 0;

  function send(method, token, url) {
    var b = window.__ai_browser__;
    if (!b || typeof b[method] !== 'function') return false;
    try { b[method](token, url); return true; } catch (e) { return false; }
  }

  window.open = function (url, name, _features) {
    var target = (url === undefined || url === null) ? '' : String(url);
    var token = 'wo' + (++seq) + '_' + Date.now();
    var ok = send('windowOpen', token, target, name || '');
    if (!ok) {
      // 没有桥：退回原生语义（deny → null），至少不像成功那样骗站点。
      return null;
    }
    var currentHref = target || 'about:blank';
    var closed = false;
    var loc = {
      get href() { return currentHref; },
      set href(v) { currentHref = String(v); send('windowOpenNav', token, currentHref); },
      assign: function (v) { loc.href = v; },
      replace: function (v) { loc.href = v; },
      toString: function() { return currentHref; }
    };
    return {
      location: loc,
      close: function () {
        if (closed) return;
        closed = true;
        send('windowOpenClose', token);
      },
      focus: function () {},
      blur: function () {},
      get closed() { return closed; },
      name: name || '',
      // 老站偶见 w.document.write(...) 写内容再导航——空实现保不炸，
      // 内容丢失比整条链路断掉好；导航仍走 location。
      document: {
        write: function () {}, writeln: function () {},
        open: function () {}, close: function () {}
      }
    };
  };
})();`;

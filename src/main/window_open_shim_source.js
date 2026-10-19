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
// ⚠️ 第二层根因（同一天发现，比第一层更隐蔽）：光让 window.open 返回一个
// 非 null 的对象还不够。真实 Window 的 location 是 [LegacyUnforgeable] +
// [PutForwards=href]，所以 `w.location = url` 等价于 `w.location.href = url`，
// 会导航。第一版垫片把 location 写成普通数据属性（location: loc），站点
// 这一赋值只是把字符串塞进属性、覆盖掉 loc 对象，**静默不导航**——垫片
// 注入了、window.open 也返回了对象、站点不报错，标签页却永远停在
// about:blank。现在的实现用 Object.defineProperty 装一个带 setter 的
// 访问器来复刻 PutForwards 语义。
//
// 为什么必须走 CDP 注入而不是 preload：tab 的 BrowserView 是
// contextIsolation:true，preload 里写的 window.open 只作用于 isolated
// world 的 window，页面脚本看到的仍是原生 window.open（第一版就是这么
// 失败的——隔离测试里 window.open() 返回 falsy）。Page.addScriptToEvaluate
// OnNewDocument 注入的脚本跑在主 world，才能真正替换掉页面可见的那个。
//
// 通信：垫片本体没有 ipcRenderer，经 preload 用 contextBridge 暴露的
// __ai_browser__.windowOpenBridge(op, token, url, name)（单一入口，
// fire-and-forget）把事件送到主进程；主进程建 tab / 导航 / 关 tab。
// ⚠️ 入口 arity 固定 4：contextBridge 两岸参数数量不一致时调用会抛错
// （实测少传一个 → 抛错被 catch 吞掉 → window.open 静默返回 null，
// 站点看到的就是"弹窗被拦截"的老症状）。垫片所有调用必须传满 4 个参数。
export const WINDOW_OPEN_SHIM_SOURCE = `(function () {
  if (window.__aiWindowOpenShimV2) return;
  window.__aiWindowOpenShimV2 = true;
  var seq = 0;

  function send(op, token, url, name) {
    var b = window.__ai_browser__;
    if (!b || typeof b.windowOpenBridge !== 'function') return false;
    try { b.windowOpenBridge(op, token, url === undefined ? '' : url, name === undefined ? '' : name); return true; } catch (e) { return false; }
  }

  // 相对地址按发起页面的 baseURI 解析（真实 window 的 location 也这么做）。
  function abs(v) {
    var s = String(v);
    try { return new URL(s, document.baseURI).href; } catch (e) { return s; }
  }

  window.open = function (url, name, _features) {
    var target = (url === undefined || url === null) ? '' : String(url);
    var token = 'wo' + (++seq) + '_' + Date.now();
    var ok = send('open', token, target, name || '');
    if (!ok) {
      // 没有桥：退回原生语义（deny → null），至少不像成功那样骗站点。
      return null;
    }
    var currentHref = target ? abs(target) : 'about:blank';
    var closed = false;

    function navigate(v) {
      currentHref = abs(v);
      send('nav', token, currentHref, '');
    }

    var loc = {
      get href() { return currentHref; },
      set href(v) { navigate(v); },
      assign: function (v) { navigate(v); },
      replace: function (v) { navigate(v); },
      reload: function () {},
      toString: function () { return currentHref; }
    };

    var doc = {
      write: function () {}, writeln: function () {},
      open: function () {}, close: function () {},
      get location() { return loc; },
      set location(v) { navigate(v); },
      get URL() { return currentHref; }
    };

    var win = {
      close: function () {
        if (closed) return;
        closed = true;
        send('close', token, '', '');
      },
      focus: function () {},
      blur: function () {},
      get closed() { return closed; },
      name: name || '',
      opener: null,
      document: doc
    };

    // ⚠️ 关键：真实 Window 的 location 是 [LegacyUnforgeable] +
    // [PutForwards=href] 的访问器——w.location = url 会被转发到 href
    // 上变成导航。如果这里写成普通数据属性（location: loc），站点的
    // w.location = res.url 就只是把字符串写进属性、覆盖掉 loc，
    // **静默不导航**，标签页永远停在 about:blank（这正是本 bug 的根因：
    // 垫片注入是成功的，window.open 也返回了对象，站点不报错，
    // 但赋值被吞掉）。所以必须用带 setter 的访问器，并设成不可配置
    // 以贴近 unforgeable 语义。
    try {
      Object.defineProperty(win, 'location', {
        get: function () { return loc; },
        set: function (v) { navigate(v); },
        enumerable: true,
        configurable: false
      });
    } catch (e) {
      win.location = loc;
    }

    return win;
  };
})();`;

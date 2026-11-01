// tests/test_window_open_shim.js — window.open 垫片的行为契约
//
// 为什么要直接跑垫片源码（而不是断言它"包含某段字符串"）：
//
// 这段代码是**以字符串形式注入页面主 world** 的（见 window_open_shim_source.js
// 顶部：contextIsolation 下 preload 改不到页面可见的 window.open，只能走 CDP 的
// Page.addScriptToEvaluateOnNewDocument）。字符串里的语法错误在主进程里不会被
// 发现 —— 它会安静地等到注入那一刻才在页面里炸，而症状是"端口没起来"或者
// "点了没反应"，完全指不到这里。（2026-10-20 我自己就往模板字符串里写了反引号，
// 整个应用起不来，报的却是 waitPortOpen 超时。）
//
// 所以这里做两件事：
//   · 用最小 window/document 桩把源码**真的执行一遍**（顺便验证语法）
//   · 钉住四条曾经静默坏掉的语义：location 必须是访问器、赋值必须导航、
//     相对地址必须在页面侧就绝对化、第三参数（窗口特性串）必须送到主进程
//     —— 最后一条是 2026-11-02 修的：特性串一丢，420×520 的登录浮层就长成整号标签页。

import { describe, it, expect } from 'vitest';
import { WINDOW_OPEN_SHIM_SOURCE } from '../src/main/window_open_shim_source.js';

/** 最小环境：只提供垫片真正用到的东西（window / document.baseURI / URL）。 */
function makeEnv(baseURI = 'https://example.com/dir/page.html') {
  const calls = [];
  const win = {
    __ai_browser__: {
      // args 记的是**桥收到的参数个数**。两岸 arity 必须一致（历史上少传一个
      // 参数 → 桥抛错 → 被 catch 吞掉 → window.open 静默返回 null）。
      // 这里必须是 function 表达式：箭头函数没有自己的 arguments。
      windowOpenBridge: function (op, token, url, name, features) {
        calls.push({ op, url, name, features, args: arguments.length });
      },
    },
  };
  const doc = { baseURI };
  // 源码是一个自执行的 IIFE 文本；包一层函数即可在 Node 里跑。
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'URL', WINDOW_OPEN_SHIM_SOURCE)(win, doc, URL);
  return { win, calls, doc };
}

describe('window.open 垫片：注入源码本身', () => {
  it('SHIM-1: 源码可以被解析并执行（字符串里的语法错会在这里暴露，而不是在用户面前）', () => {
    expect(() => makeEnv()).not.toThrow();
  });

  it('SHIM-2: 执行后标记位就位，且 window.open 已被替换', () => {
    const { win } = makeEnv();
    expect(win.__aiWindowOpenShimV2).toBe(true);
    expect(typeof win.open).toBe('function');
    expect(String(win.open)).not.toMatch(/\[native code\]/);
  });

  it('SHIM-3: 重复执行是幂等的（垫片会跨导航被再次注入）', () => {
    const { win, calls } = makeEnv();
    const before = win.open;
    new Function('window', 'document', 'URL', WINDOW_OPEN_SHIM_SOURCE)(win, { baseURI: 'https://example.com/' }, URL);
    expect(win.open).toBe(before);
    expect(calls.length).toBe(0);
  });
});

describe('window.open 垫片：站点惯用法（window.open("") + location 赋值）', () => {
  it('SHIM-4: window.open("") 返回可用对象，并通知主进程建 tab', () => {
    const { win, calls } = makeEnv();
    const w = win.open('', '_blank');
    expect(w).toBeTruthy();
    expect(calls[0]).toEqual({ op: 'open', url: '', name: '_blank', features: '', args: 5 });
  });

  it('SHIM-5: 返回对象的 location 必须是带 setter 的访问器（写死数据属性会静默不导航）', () => {
    const { win } = makeEnv();
    const w = win.open('', '_blank');
    const d = Object.getOwnPropertyDescriptor(w, 'location');
    expect(d).toBeTruthy();
    expect(typeof d.get).toBe('function');
    expect(typeof d.set).toBe('function');   // ★ 这条就是 56222e7 修的根因
  });

  it('SHIM-6: w.location = url 真的发出导航（不是把字符串塞进属性）', () => {
    const { win, calls } = makeEnv();
    const w = win.open('', '_blank');
    w.location = 'https://pxsxzj.example.com/study/1';
    const nav = calls.filter((c) => c.op === 'nav');
    expect(nav.length).toBe(1);
    expect(nav[0].url).toBe('https://pxsxzj.example.com/study/1');
  });

  it('SHIM-7: 相对地址在页面侧就绝对化（主进程拿到 /foo.html 会报 ERR_INVALID_URL）', () => {
    const { win, calls } = makeEnv('https://example.com/dir/page.html');
    const w = win.open('', '_blank');
    w.location = '/l1.html';
    expect(calls.filter((c) => c.op === 'nav')[0].url).toBe('https://example.com/l1.html');
    w.location.href = 'sub/x.html';
    expect(calls.filter((c) => c.op === 'nav')[1].url).toBe('https://example.com/dir/sub/x.html');
  });

  it('SHIM-8: 带 url 的 window.open 也要绝对化（否则开出错误页）', () => {
    const { win, calls } = makeEnv('http://127.0.0.1:8080/a.html');
    win.open('/l2.html', '_blank');
    expect(calls[0]).toEqual({ op: 'open', url: 'http://127.0.0.1:8080/l2.html', name: '_blank', features: '', args: 5 });
  });

  it('SHIM-9: assign / replace 都走导航；href 的 getter 反映最新地址', () => {
    const { win, calls } = makeEnv();
    const w = win.open('', '_blank');
    w.location.assign('/a.html');
    expect(calls.filter((c) => c.op === 'nav').length).toBe(1);
    w.location.replace('/b.html');
    expect(calls.filter((c) => c.op === 'nav').length).toBe(2);
    expect(String(w.location.href)).toBe('https://example.com/b.html');
  });

  it('SHIM-10: close() 只通知一次（重复调用不重复通知）', () => {
    const { win, calls } = makeEnv();
    const w = win.open('', '_blank');
    w.close();
    w.close();
    expect(calls.filter((c) => c.op === 'close').length).toBe(1);
    expect(w.closed).toBe(true);
  });

  it('SHIM-11: 没有桥时返回 null（退回浏览器拦截语义，而不是假装成功）', () => {
    // 主 world 里 contextBridge 没到位（极端情况）→ 必须让站点看到"被拦截"，
    // 而不是给一个永远不导航的假窗口，让站点以为成功。
    const win = {};
    new Function('window', 'document', 'URL', WINDOW_OPEN_SHIM_SOURCE)(win, { baseURI: 'https://example.com/' }, URL);
    expect(win.open('', '_blank')).toBe(null);
  });
});

describe('window.open 垫片：窗口特性串（第三参数）必须送到主进程', () => {
  // 站点写 window.open(url, name, 'width=420,height=520') 请求的是一个浮层。
  // 以前这个参数接了却不用（形参名就叫 _features），主进程于是无从判断尺寸，
  // 弹窗长成整号标签页 —— 用户看到的"弹窗一片白/整屏换了一页"就是这么来的。
  it('SHIM-12: 特性串原样出现在 open 这一发的第 5 个参数上', () => {
    const { win, calls } = makeEnv();
    win.open('https://example.com/login', 'x', 'width=420,height=520,left=120,top=80');
    expect(calls[0].features).toBe('width=420,height=520,left=120,top=80');
  });

  it('SHIM-13: 缺省/空特性也传满 5 个参数，且值是空串（不是 undefined）', () => {
    const { win, calls } = makeEnv();
    win.open('https://example.com/a');            // 只给 url
    win.open('https://example.com/b', '_blank', ''); // 显式空串
    expect(calls.map((c) => c.args), '少一个参数 = 桥抛错 = window.open 静默 null').toEqual([5, 5]);
    expect(calls.map((c) => c.features)).toEqual(['', '']);
  });

  it('SHIM-14: 特性只在 open 那一发有效 —— nav/close 不带它', () => {
    // 真实浏览器里 features 决定的是"开出来的窗口长什么样"，不是每次导航重设尺寸。
    // 若 nav 也带，主进程会在每次 location 赋值时重算几何（弹窗会被反复挪位置）。
    const { win, calls } = makeEnv();
    const w = win.open('', '_blank', 'width=420,height=520');
    w.location = 'https://example.com/target';
    w.close();
    const nav = calls.filter((c) => c.op === 'nav')[0];
    const close = calls.filter((c) => c.op === 'close')[0];
    expect(nav.features).toBe('');
    expect(close.features).toBe('');
    expect(calls.filter((c) => c.op === 'open')[0].features).toBe('width=420,height=520');
  });

  it('SHIM-15: 非字符串特性（站点传对象/数字）按 DOMString 语义字符串化', () => {
    const { win, calls } = makeEnv();
    win.open('https://example.com/a', '_blank', 42);
    expect(calls[0].features).toBe('42');
    // 主进程侧 wantsPopup('42') 为 false —— 见 shared/popup_geometry.cjs PG-04。
  });
});

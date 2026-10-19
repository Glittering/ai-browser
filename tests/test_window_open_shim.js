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
//   · 钉住三条曾经静默坏掉的语义：location 必须是访问器、赋值必须导航、
//     相对地址必须在页面侧就绝对化

import { describe, it, expect } from 'vitest';
import { WINDOW_OPEN_SHIM_SOURCE } from '../src/main/window_open_shim_source.js';

/** 最小环境：只提供垫片真正用到的东西（window / document.baseURI / URL）。 */
function makeEnv(baseURI = 'https://example.com/dir/page.html') {
  const calls = [];
  const win = {
    __ai_browser__: {
      windowOpenBridge: (op, token, url, name) => { calls.push({ op, url, name }); },
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
    expect(calls[0]).toEqual({ op: 'open', url: '', name: '_blank' });
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
    expect(calls[0]).toEqual({ op: 'open', url: 'http://127.0.0.1:8080/l2.html', name: '_blank' });
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

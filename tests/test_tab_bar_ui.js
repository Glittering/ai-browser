// tests/test_tab_bar_ui.js — 标签栏渲染层的回归测试（src/renderer/tab_bar.html）
//
// 为什么要把 HTML 里的 <script> 拉出来在 jsdom 里跑：
// 标签栏那个「滚不动」的 bug 不是某一行的错，是**三处叠加**的结果
// （overflow:hidden + 没有 flex:none + 每 1.5s 重建 DOM 冲掉 scrollLeft）。
// 只改 CSS 不锁住"重建会重置滚动位置"这条，下次有人为了省事把增量更新
// 改回 innerHTML=''，bug 会静默复活，而且只有在标签很多的时候才看得出来。
//
// 这里锁住四件事：
//   TB-1 结构变化才重建；只有标题/激活态变化时**同一个 DOM 节点**被复用
//   TB-2 重建时保住了 scrollLeft（在右端关标签不会弹回最左）
//   TB-3 垂直滚轮转横向（deltaY → scrollLeft），且不越界
//   TB-4 中键点击关闭标签；tooltip 带完整标题 + 地址（UI 只显示 30 字）
//
// jsdom 没有布局引擎：scrollWidth/clientWidth 恒为 0，滚动相关断言必须先用
// defineProperty 伪造这两个值，否则 wheel 处理器会在第一行就 return。

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'tab_bar.html'), 'utf8');
// 标签栏把分组折叠的判据放在外部脚本里（<script src>）。jsdom 默认不取外部资源，
// 所以这里读进来手动注入 —— 否则 window.TabBarLayout 不存在，整个 renderTabs 抛错，
// 下面所有断言会一起变红，而真正的原因只是"测试环境没加载那个文件"。
const LAYOUT_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'tab_bar_layout.js'), 'utf8');

// 假 ipcRenderer：记录调用，tab:list 返回外部可改的 tabs 数组
function makeHarness(tabs) {
  const sent = [];
  const state = { tabs };
  const ipcRenderer = {
    send: (ch, payload) => sent.push([ch, payload]),
    invoke: async (ch) => {
      if (ch === 'tab:list') return state.tabs;
      if (ch === 'nav:state') return null;
      return null;
    },
    on: () => {},
  };
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    beforeParse(window) {
      // 标签栏在 Electron 里用 require('electron') 拿 ipcRenderer；
      // jsdom 没有 require，这里注入一个，避免脚本走"非 Electron 降级"分支
      // （降级分支本身是另一个用例，见 TB-5）。
      window.require = () => ({ ipcRenderer });
      window.eval(LAYOUT_JS);
    },
  });
  const { window } = dom;
  // 让轮询不要在测试里乱跑
  for (let i = 1; i < 1000; i++) window.clearInterval(i);
  return { dom, window, doc: window.document, sent, state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// 伪造"内容比可视区宽"，让滚动逻辑可测
function fakeOverflow(el, scrollWidth = 4000, clientWidth = 1200) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
}

const mkTabs = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `tab-${i + 1}`,
    url: `https://example.com/${i + 1}`,
    active: i === 0,
    ...extra,
  }));

describe('tab bar 渲染与滚动（jsdom）', () => {
  let h;
  beforeEach(() => { h = makeHarness(mkTabs(5)); });

  it('TB-1: 结构不变时复用 DOM 节点，只改文字（不重建）', async () => {
    const { window, doc, state } = h;
    await window.renderTabs();
    const first = doc.querySelector('#tabs').children[0];
    expect(doc.querySelectorAll('#tabs .tab').length).toBe(5);

    // 只有标题变化
    state.tabs = mkTabs(5).map((t, i) => (i === 0 ? { ...t, title: '新标题' } : t));
    await window.renderTabs();

    const firstAfter = doc.querySelector('#tabs').children[0];
    expect(firstAfter).toBe(first);                       // 同一个节点 = 没重建
    expect(firstAfter.querySelector('.tab-title').textContent).toBe('新标题');
  });

  it('TB-2: 标签增删导致重建时，scrollLeft 被保住', async () => {
    const { window, doc, state } = h;
    await window.renderTabs();
    const tabsEl = doc.querySelector('#tabs');
    tabsEl.scrollLeft = 640;                              // 用户已经滚到中段

    state.tabs = mkTabs(6);                               // 新开一个 → 结构变化
    await window.renderTabs();

    expect(doc.querySelectorAll('#tabs .tab').length).toBe(6);
    expect(tabsEl.scrollLeft).toBe(640);                  // 没有被冲回 0
  });

  it('TB-3: 垂直滚轮转横向滚动，且按 deltaY 前进', async () => {
    const { window, doc } = h;
    await window.renderTabs();
    const tabsEl = doc.querySelector('#tabs');
    fakeOverflow(tabsEl);
    tabsEl.scrollLeft = 100;

    const ev = new window.WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
    tabsEl.dispatchEvent(ev);

    expect(tabsEl.scrollLeft).toBe(340);
    expect(ev.defaultPrevented).toBe(true);               // 否则页面会跟着滚
  });

  it('TB-3b: 内容没超出可视区时不拦截滚轮（避免吃掉页面滚动）', async () => {
    const { window, doc } = h;
    await window.renderTabs();
    const tabsEl = doc.querySelector('#tabs');
    fakeOverflow(tabsEl, 800, 1200);                      // 不溢出

    const ev = new window.WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
    tabsEl.dispatchEvent(ev);

    expect(tabsEl.scrollLeft).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('TB-4: 中键点击关闭对应标签；左键点击激活', async () => {
    const { window, doc, sent } = h;
    await window.renderTabs();
    const tab2 = doc.querySelector('#tabs .tab[data-id="2"]');

    tab2.dispatchEvent(new window.MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(sent).toContainEqual(['tab:close', 2]);

    sent.length = 0;
    tab2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(sent).toContainEqual(['tab:activate', 2]);
  });

  it('TB-5: tooltip 带完整标题与地址（UI 只显示前 30 字）', async () => {
    const long = '一个非常非常长的标题用于验证截断行为以及 tooltip 是否保留了完整文本';
    const { window, doc, state } = h;
    state.tabs = [{ id: 7, title: long, url: 'https://example.com/a', active: true }];
    await window.renderTabs();

    const el = doc.querySelector('#tabs .tab[data-id="7"]');
    expect(el.querySelector('.tab-title').textContent.length).toBe(30);   // 显示被截断
    expect(el.title).toContain(long);                                     // tooltip 是完整的
    expect(el.title).toContain('https://example.com/a');
  });
});

describe('tab bar 在非 Electron 环境下的降级', () => {
  it('TB-6: 没有 require 也不抛错，标签依然渲染（布局/滚动可用）', async () => {
    const errors = [];
    const dom = new JSDOM(HTML, {
      runScripts: 'dangerously',
      beforeParse(window) {
        window.addEventListener('error', (e) => errors.push(e.message));
        window.require = () => { throw new Error("Cannot find module 'electron'"); };
        window.eval(LAYOUT_JS);   // 同上：外部脚本要手动注入
      },
    });
    const { window } = dom;
    for (let i = 1; i < 1000; i++) window.clearInterval(i);
    await flush();

    expect(errors).toEqual([]);                            // 脚本没有整体崩掉
    expect(typeof window.renderTabs).toBe('function');     // 关键函数仍然定义了
    // invoke 被拒 → renderTabs 内部捕获，不产生未处理拒绝
    await expect(window.renderTabs()).resolves.toBeUndefined();
  });
});

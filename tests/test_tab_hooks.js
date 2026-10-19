// tests/test_tab_hooks.js — wrapSetActive 的返回值契约。
//
// 起因是一个真实事故：index.js 给 pageManager.setActive 套包装挂「地址栏跟随」，
// 忘了 return，于是 ws_server 里的 `const ok = pageManager.setActive(...)` 拿到
// undefined，回给 agent 的 ui.set_active_tab 变成 `{}` —— tab 明明切成功了，
// agent 却拿不到任何确认。
//
// 这组测试钉的不是"那一行代码"，而是"以后谁再往上挂钩子都不会吞返回值"。
import { describe, it, expect, vi } from 'vitest';
import { wrapSetActive } from '../src/shared/tab_hooks.js';

// 一个尽量像 PageManager 的对象：setActive 是 class 方法（用到 this）。
function makePageManager(result = true) {
  return {
    activeTab: 1,
    tabs: new Map([[1, {}], [2, {}]]),
    setActive(tabId) {
      if (!this.tabs.has(tabId)) return false;
      this.activeTab = tabId;
      return result;
    },
  };
}

describe('wrapSetActive — 返回值透传', () => {
  it('H-1 原方法返回 true，包装后仍返回 true', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm, () => {});
    expect(pm.setActive(2)).toBe(true);
  });

  it('H-2 原方法返回 false（tab 不存在），包装后仍返回 false —— 不能把失败变成 undefined 或 true', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm, () => {});
    expect(pm.setActive(999)).toBe(false);
  });

  it('H-3 返回任意非布尔值也原样透传（回执里可能会带其他字段）', () => {
    const pm = makePageManager();
    pm.setActive = function () { return { switched: 2 }; };
    wrapSetActive(pm, () => {});
    expect(pm.setActive(2)).toEqual({ switched: 2 });
  });

  it('H-4 回执能过 JSON.stringify，不因值为 undefined 被整键删掉（事故的直接形态）', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm, () => {});
    const payload = JSON.stringify({ ok: pm.setActive(2) });
    expect(payload).toBe('{"ok":true}'); // 事故时这里是 "{}"
  });
});

describe('wrapSetActive — 钩子时序与异常语义', () => {
  it('H-5 钩子在原方法**之后**执行，能读到已被改动的状态', () => {
    const pm = makePageManager(true);
    pm.activeTab = 1;
    let seen = null;
    wrapSetActive(pm, (tabId) => { seen = { tabId, activeTab: pm.activeTab }; });
    pm.setActive(2);
    expect(seen).toEqual({ tabId: 2, activeTab: 2 });
  });

  it('H-6 钩子拿到 tabId，且原方法返回 false 时钩子**仍然**执行（地址栏要跟着认错）', () => {
    const pm = makePageManager(true);
    const hook = vi.fn();
    wrapSetActive(pm, hook);
    pm.setActive(999);
    expect(hook).toHaveBeenCalledWith(999, false);
  });

  it('H-7 原方法抛异常时钩子不执行，异常照常向上抛（不能掩盖真错误）', () => {
    const pm = makePageManager();
    pm.setActive = function () { throw new Error('view destroyed'); };
    const hook = vi.fn();
    wrapSetActive(pm, hook);
    expect(() => pm.setActive(1)).toThrow('view destroyed');
    expect(hook).not.toHaveBeenCalled();
  });

  it('H-8 钩子自己抛错时不吞掉 —— 保持"出错就炸"的原样，便于暴露', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm, () => { throw new Error('hook boom'); });
    expect(() => pm.setActive(2)).toThrow('hook boom');
  });

  it('H-9 this 绑定到原 pageManager —— class 方法里的 this.tabs / this.activeTab 必须还有效', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm, () => {});
    pm.setActive(2);
    expect(pm.activeTab).toBe(2); // 若 this 丢了这行就是 1
  });

  it('H-10 不传钩子也能用（纯直通）', () => {
    const pm = makePageManager(true);
    wrapSetActive(pm);
    expect(pm.setActive(2)).toBe(true);
  });

  it('H-11 传入没有 setActive 的对象要立刻报错，而不是留到调用时才炸', () => {
    expect(() => wrapSetActive({})).toThrow(/setActive is not a function/);
  });
});

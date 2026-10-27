// tests/test_tab_route.js — 「这次调用操作哪个标签页」的判据。
//
// 这一份判据的价值全在**不猜**上：多 agent 并用时，一旦"就近挑一个页面"，
// 就会出现"回执 success、页面真的变了、但不是该变的那个"—— 比直接失败难查得多。
// 所以两类边界必须在同一个文件里钉死：
//   点名了但不存在   → 报错（不是换一个）
//   自己的页面没了   → 报错（不是退回人眼前那一页）
import { describe, it, expect } from 'vitest';
import tabRoute from '../src/shared/tab_route.cjs';

const { resolveTarget, shouldShowNewTab, shouldShowChildTab } = tabRoute;

describe('resolveTarget 的优先级', () => {
  const tabs = [1, 2, 3];

  it('explicit > session > active', () => {
    expect(resolveTarget({ explicit: 3, session: 2, active: 1, tabs }).tab).toBe(3);
    expect(resolveTarget({ session: 2, active: 1, tabs }).tab).toBe(2);
    expect(resolveTarget({ active: 1, tabs }).tab).toBe(1);
  });

  it('什么都没有时取第一个（而不是 null，除非真的没有标签页）', () => {
    expect(resolveTarget({ tabs }).tab).toBe(1);
    const none = resolveTarget({ tabs: [] });
    expect(none.tab).toBe(null);
    expect(none.source).toBe('none');
  });

  it('点名了不存在的 tab → 报错，绝不就近挑一个', () => {
    const r = resolveTarget({ explicit: 999, active: 1, tabs });
    expect(r.tab).toBe(999);            // 保留原值，让方法自己报 no-such-tab / tab-mismatch
    expect(r.source).toBe('gone');
    expect(r.error).toMatch(/does not exist/);
  });

  it('自己的标签页被别人关掉 → 报错，绝不退回到人眼前那一页', () => {
    const r = resolveTarget({ session: 42, active: 1, tabs });
    expect(r.tab).toBe(null);
    expect(r.source).toBe('session-gone');
    expect(r.error).toMatch(/is gone/);
    // 错误信息要给出下一步动作，否则 agent 只会重试
    expect(r.error).toMatch(/ui\.new_tab/);
  });

  it('active 也失效（比如刚关掉可见页）时退回第一个，不报错', () => {
    const r = resolveTarget({ active: 99, tabs });
    expect(r.tab).toBe(1);
    expect(r.source).toBe('first');
  });

  it('入参缺失不抛异常（RPC 边界上什么都可能传进来）', () => {
    expect(() => resolveTarget()).not.toThrow();
    expect(resolveTarget().tab).toBe(null);
    expect(resolveTarget({ tabs: 'not-an-array' }).tab).toBe(null);
  });
});

describe('shouldShowNewTab —— 新标签页要不要顶掉人眼前的页面', () => {
  it('显式 true / false 优先', () => {
    expect(shouldShowNewTab({ requested: true, hasVisible: true })).toBe(true);
    expect(shouldShowNewTab({ requested: false, hasVisible: false })).toBe(false);
  });

  it('人自己点的「+」一定显示', () => {
    expect(shouldShowNewTab({ defaultShow: true, hasVisible: true })).toBe(true);
  });

  it('没有可见页时显示（否则人打开窗口看到空白）', () => {
    expect(shouldShowNewTab({ hasVisible: false })).toBe(true);
  });

  it('可见的只是**没被动过的启动页**时显示（否则用户盯着百度首页看 agent 干活）', () => {
    expect(shouldShowNewTab({ hasVisible: true, visibleIsStartup: true })).toBe(true);
  });

  it('人眼前已经有一个真实的页面 → 不顶掉', () => {
    expect(shouldShowNewTab({ hasVisible: true, visibleIsStartup: false })).toBe(false);
    expect(shouldShowNewTab({ hasVisible: true })).toBe(false);
  });
});

describe('shouldShowChildTab —— 站点弹出来的标签页跟着打开者走', () => {
  it('可见页里弹出来的 → 显示（浏览器惯例）', () => {
    expect(shouldShowChildTab({ openerIsVisible: true })).toBe(true);
  });
  it('后台页里弹出来的 → 留在后台（登录/预览/下载弹窗不该抢视野）', () => {
    expect(shouldShowChildTab({ openerIsVisible: false })).toBe(false);
    expect(shouldShowChildTab()).toBe(false);
  });
});

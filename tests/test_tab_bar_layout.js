// tests/test_tab_bar_layout.js — 标签栏分组布局的判据。
//
// 为什么为这点 UI 逻辑写单测：它决定"哪一页是谁的、点开看谁的、组满了怎么提示"。
// 挂在界面上时，唯一的验证方式是人把鼠标移上去 —— 那种验证不会在 CI 里发生，
// 也不会在改别的代码时提醒你它坏了。把判据抽成纯函数（renderer/tab_bar_layout.js）
// 就能在这里钉死。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 这个文件由标签栏用 <script src> 加载（经典脚本），所以是 UMD 形态、没有 ESM
// 具名导出：require 的返回值是空命名空间，真正的对象挂在全局上。
require('../src/renderer/tab_bar_layout.js');
const L = globalThis.TabBarLayout;

const human = (id, extra = {}) => ({ id, group: 'human', group_label: '我的标签页', title: 'h' + id, ...extra });
const agent = (id, group, extra = {}) => ({
  id, group, group_label: group === 'agent:a' ? 'Claude' : 'Cursor',
  group_color: group === 'agent:a' ? '#7c6cf0' : '#3fb6a8',
  group_limit: 8, title: 'a' + id, ...extra,
});

describe('TBL 归组与顺序', () => {
  it('TBL-1 人的标签页平铺，agent 的组折叠成一个 pill；组内页数/上限/颜色都带上', () => {
    const tabs = [human(1, { active: true }), agent(2, 'agent:a'), agent(3, 'agent:a')];
    const v = L.build(tabs, L.empty());
    expect(v.items.map((i) => i.type)).toEqual(['tab', 'group']);
    const pill = v.items[1];
    expect(pill).toMatchObject({ id: 'agent:a', label: 'Claude', count: 2, limit: 8, color: '#7c6cf0', open: false });
  });

  it('TBL-2 顺序按"每组第一页出现的位置"，不是按组名排序', () => {
    const tabs = [agent(1, 'agent:b'), human(2, { active: true }), agent(3, 'agent:a')];
    const v = L.build(tabs, L.empty());
    expect(v.items.map((i) => (i.type === 'group' ? i.id : 'tab'))).toEqual(['agent:b', 'tab', 'agent:a']);
  });

  it('TBL-3 展开的组把自己的页摊在 pill 后面，并标 inGroup + 组色', () => {
    const tabs = [human(1, { active: true }), agent(2, 'agent:a'), agent(3, 'agent:a')];
    const v = L.build(tabs, { expanded: ['agent:a'], pinned: [] });
    expect(v.items.map((i) => (i.type === 'group' ? 'pill:' + i.open : 'tab:' + i.tab.id)))
      .toEqual(['tab:1', 'pill:true', 'tab:2', 'tab:3']);
    const t = v.items[2];
    expect(t.inGroup).toBe(true);
    expect(t.color).toBe('#7c6cf0');
  });

  it('TBL-4 正在看的那一页属于某个组 → 那个组强制展开（否则人找不到自己在看什么）', () => {
    const tabs = [human(1), agent(2, 'agent:a', { active: true })];
    const v = L.build(tabs, L.empty());
    expect(v.activeGroup).toBe('agent:a');
    expect(v.state.expanded).toContain('agent:a');
    expect(v.items.some((i) => i.type === 'group' && i.open)).toBe(true);
  });
});

describe('TBL 悬停 / 钉住 / 收起', () => {
  it('TBL-5 悬停展开，重复悬停幂等', () => {
    let s = L.hover(L.empty(), 'agent:a');
    expect(s.expanded).toEqual(['agent:a']);
    s = L.hover(s, 'agent:a');
    expect(s.expanded).toEqual(['agent:a']);
  });

  it('TBL-6 悬停人的组没有任何作用（人的页没有可折叠的东西）', () => {
    expect(L.hover(L.empty(), 'human')).toEqual({ expanded: [], pinned: [] });
    expect(L.toggle(L.empty(), 'human')).toEqual({ expanded: [], pinned: [] });
  });

  it('TBL-7 点击 pill = 钉住；再点一次放开并收起', () => {
    let s = L.toggle(L.empty(), 'agent:a');
    expect(s).toEqual({ expanded: ['agent:a'], pinned: ['agent:a'] });
    s = L.toggle(s, 'agent:a');
    expect(s).toEqual({ expanded: [], pinned: [] });
  });

  it('TBL-8 鼠标离开：收起没钉住的；钉住的与"正在看的那组"留着', () => {
    let s = L.hover(L.empty(), 'agent:a');      // 悬停未钉住
    s = L.toggle(s, 'agent:b');                  // 钉住 b
    s = L.hover(s, 'agent:c');                   // 悬停未钉住
    const after = L.leave(s, 'agent:c');         // 人正在看 c
    expect(after.expanded).toEqual(['agent:b', 'agent:c']);
    expect(after.pinned).toEqual(['agent:b']);
  });

  it('TBL-9 离开时如果一个组都不该留，expanded 清空', () => {
    const s = L.hover(L.empty(), 'agent:a');
    expect(L.leave(s, null).expanded).toEqual([]);
  });
});

describe('TBL 结构签名', () => {
  it('TBL-10 标签/归属/展开态任何一项变化都会换签名（否则界面不更新）', () => {
    const tabs = [human(1), agent(2, 'agent:a')];
    const base = L.signature(tabs, { expanded: [] });
    expect(L.signature(tabs, { expanded: [] })).toBe(base);
    expect(L.signature(tabs, { expanded: ['agent:a'] })).not.toBe(base);
    expect(L.signature([...tabs, agent(3, 'agent:a')], { expanded: [] })).not.toBe(base);
    // 只是标题变了不算结构变化（标题走轻量更新，重建会把滚动位置冲掉）
    expect(L.signature([{ ...tabs[0], title: '新标题' }, tabs[1]], { expanded: [] })).toBe(base);
  });
});

import { describe, it, expect } from 'vitest';
import { markAggregatedLabels } from '../src/main/axExtractor.js';

// 为什么钉这个（2026-10-25 知乎私信事故）：
// 知乎私信列表行 `<div class="ChatUserListItem">` 的 AX name 是整段预览文字的拼接：
//   "创作者小助手 10-21 ☄️最新一期「创作打卡挑战赛」活动来喽！「创作打卡挑战赛第五十四期 」将于…"
// 于是"按文字找链接"必然先命中这个行容器 —— 它是 generic + 有 click 动作，点了只
// 选中会话、不跳转；真正的 `<a>创作打卡挑战赛第五十四期</a>` 在会话面板里。
// 用户看到的就是"树里有、点不动"，而且回执没有任何解释。
//
// 修法的读侧一半：容器 label 若是子孙文字拼出来的，就打 agg:1，让读树的人能当场
// 分辨"这段文字是我的"还是"这段文字在我下面"。

const node = (over) => ({
  id: over.id || 'n',
  role: over.role || 'generic',
  label: over.label || '',
  actions: over.actions || [],
  children: over.children || [],
  ...over,
});

describe('markAggregatedLabels — 容器 label 是拼接的就要标出来', () => {
  it('行容器 label 由子孙文字拼成 → agg=1', () => {
    const tree = node({
      id: 'row',
      role: 'generic',
      label: '创作者小助手 10-21 ☄️最新一期「创作打卡挑战赛」活动来喽！',
      actions: ['click'],
      children: [
        node({ id: 'avatar', role: 'image', label: '头像' }),
        node({ id: 'time', role: 'generic', label: '10-21' }),
        node({ id: 'more', role: 'button', label: '更多', actions: ['click'] }),
      ],
    });
    markAggregatedLabels(tree);
    expect(tree.agg).toBe(1);
  });

  it('文字是它自己的（link / 叶子）→ 绝不标 agg', () => {
    const link = node({ id: 'a1', role: 'link', label: '创作打卡挑战赛第五十四期', actions: ['click'] });
    const text = node({ id: 't1', role: 'StaticText', label: '创作打卡挑战赛第五十四期' });
    const tree = node({ id: 'root', role: 'generic', label: '', children: [link, text] });
    markAggregatedLabels(tree);
    expect(link.agg).toBeUndefined();
    expect(text.agg).toBeUndefined();
  });

  it('label 很短或没有子孙 → 不标（不制造噪音）', () => {
    const short = node({ id: 's', role: 'generic', label: '更多', children: [node({ id: 'x', role: 'StaticText', label: '更' })] });
    const empty = node({ id: 'e', role: 'generic', label: '' });
    markAggregatedLabels(short);
    markAggregatedLabels(empty);
    expect(short.agg).toBeUndefined();
    expect(empty.agg).toBeUndefined();
  });

  it('子孙 label 与自己无关（不是子串）→ 不标', () => {
    const tree = node({
      id: 'card',
      role: 'generic',
      label: '这是一段很长的说明文字和别的东西',
      children: [node({ id: 'b', role: 'button', label: '立即报名', actions: ['click'] })],
    });
    markAggregatedLabels(tree);
    expect(tree.agg).toBeUndefined();
  });

  it('深层容器逐层判断，父容器与子容器各算各的', () => {
    const row = node({
      id: 'row',
      role: 'listitem',
      label: '标题一 ' + '详情详情详情',
      children: [node({
        id: 'inner',
        role: 'generic',
        label: '详情详情详情',
        children: [node({ id: 'd1', role: 'StaticText', label: '详情详情详情' })],
      })],
    });
    markAggregatedLabels(row);
    // row: label 里含子孙的整段文字，且 label 更长 → 拼接
    expect(row.agg).toBe(1);
    // inner: 子孙 label 与自身等长，不算"更短" → 它自己是这段文字的归属
    expect(row.children[0].agg).toBeUndefined();
  });

  it('返回同一棵树（便于链式调用），不改角色/动作', () => {
    const tree = node({ id: 'r', role: 'generic', label: 'AAA BBB CCC', actions: ['click'], children: [node({ id: 'k', role: 'StaticText', label: 'AAA BBB' })] });
    const out = markAggregatedLabels(tree);
    expect(out).toBe(tree);
    expect(out.role).toBe('generic');
    expect(out.actions).toEqual(['click']);
  });
});

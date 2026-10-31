// tests/test_tree_focus.js — focused_only 的裁剪语义（此前是空转，参数没人读）。
import { describe, it, expect } from 'vitest';
import treeFocus from '../src/shared/tree_focus.cjs';

const { focusOnly } = treeFocus;

const node = (id, extra = {}) => ({ id, role: 'generic', label: id, children: [], ...extra });

describe('focusOnly：只留焦点子树', () => {
  it('F1 沿祖先链剪枝，兄弟节点消失', () => {
    const tree = node('root', {
      children: [
        node('header', { children: [node('logo')] }),
        node('form', {
          children: [
            node('label'),
            node('input', { states: ['editable', 'focused'], children: [node('caret')] }),
          ],
        }),
        node('footer'),
      ],
    });
    const { tree: out, focus_id } = focusOnly(tree);
    expect(focus_id).toBe('input');
    expect(out.children.map((c) => c.id)).toEqual(['form']);
    expect(out.children[0].children.map((c) => c.id)).toEqual(['input']);
    // 焦点节点自己的子树要完整保留（候选列表/下拉项都在里面）
    expect(out.children[0].children[0].children.map((c) => c.id)).toEqual(['caret']);
    expect(out.focused_element_id).toBe('input');
    expect(out.focused_only).toBe(true);
  });

  it('F2 焦点就是根 → 原样返回（带标记）', () => {
    const { tree: out } = focusOnly(node('root', { states: ['focused'] }));
    expect(out.id).toBe('root');
    expect(out.focused_only).toBe(true);
  });

  it('F3 没有焦点 → null（调用方要能分辨"焦点不在页面上"）', () => {
    const r = focusOnly(node('root', { children: [node('a')] }));
    expect(r.tree).toBe(null);
    expect(r.focus_id).toBe(null);
  });

  it('F4 空输入不抛', () => {
    expect(focusOnly(null).tree).toBe(null);
    expect(focusOnly(undefined).tree).toBe(null);
    expect(focusOnly({}).tree).toBe(null);
  });

  it('F5 多个 focused（异常页面）取文档序第一个，且不炸栈', () => {
    const tree = node('root', { children: [node('a', { states: ['focused'] }), node('b', { states: ['focused'] })] });
    const { focus_id } = focusOnly(tree);
    expect(focus_id).toBe('a');
  });

  it('F6 states 不是数组时不抛', () => {
    const tree = node('root', { states: 'focused', children: [node('x')] });
    const r = focusOnly(tree);
    expect(r.tree).toBe(null);
  });
});

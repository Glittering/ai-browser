// tests/test_ref_epoch.js — "目标找不到"到底是过期还是形状错。
//
// 背景见 src/shared/ref_epoch.js 文件头。这里钉住三件事：
// ① 页面变过 → stale（正确动作是重读树，不是重试同一个 ref）；
// ② 从没出现过 → never_seen（重读树也没用，要改传参）；
// ③ 就在当前版里 → present_in_tree（树里有 DOM 里没有，换读法）。
import { describe, it, expect } from 'vitest';
import {
  newTracker, collectRefs, bumpEpoch, noteTree, diagnoseMissingRef,
  REF_STALE, REF_NEVER_SEEN, REF_PRESENT_IN_TREE,
} from '../src/shared/ref_epoch.js';

// 造一棵最小语义树：id 就是 data-ai-id。
function tree(ids, childrenOf) {
  const root = { id: 'e:root', role: 'document' };
  root.children = ids.map((id) => ({ id, role: 'button' }));
  if (childrenOf) root.children.push(childrenOf);
  return root;
}

describe('collectRefs', () => {
  it('C-1 递归收集所有 id，包含嵌套子节点', () => {
    const t = tree(['e:a', 'e:b'], { id: 'e:group', children: [{ id: 'e:c' }] });
    expect(collectRefs(t)).toEqual(['e:root', 'e:a', 'e:b', 'e:group', 'e:c']);
  });

  it('C-2 缺 id 的容器节点不产生 undefined', () => {
    expect(collectRefs({ role: 'document', children: [{ role: 'x' }, { id: 'e:a' }] })).toEqual(['e:a']);
  });

  it('C-3 空树/怪输入不抛', () => {
    expect(collectRefs(null)).toEqual([]);
    expect(collectRefs({ id: '' })).toEqual([]);
    expect(collectRefs({ id: 'e:a', children: 'not-an-array' })).toEqual(['e:a']);
  });
});

describe('bumpEpoch / noteTree', () => {
  it('B-1 epoch 从 0 开始，每读一次树 +1', () => {
    const t = newTracker();
    expect(t.epoch).toBe(0);
    noteTree(t, tree(['e:a']));
    expect(t.epoch).toBe(1);
    noteTree(t, tree(['e:a']));
    expect(t.epoch).toBe(2);
  });

  it('B-2 同一个 ref 再次出现时，记录更新到最新一版', () => {
    const t = newTracker();
    noteTree(t, tree(['e:a']));
    noteTree(t, tree(['e:a']));
    expect(t.seen.get('e:a')).toBe(2);
  });

  it('B-3 bumpEpoch 能吃裸 ref 数组（内部调用方便）', () => {
    const t = newTracker();
    expect(bumpEpoch(t, ['x', 'y'])).toBe(1);
    expect(t.seen.get('x')).toBe(1);
  });
});

describe('diagnoseMissingRef — 三种处境', () => {
  it('D-1 老 ref 遇上新树 → stale，且明确说"重读树，别重试"', () => {
    const t = newTracker();
    noteTree(t, tree(['e:old']));   // v1：agent 在这里拿到 e:old
    noteTree(t, tree(['e:new']));   // v2：页面重渲染了
    const d = diagnoseMissingRef('e:old', t);
    expect(d.reason).toBe(REF_STALE);
    expect(d.stale_ref).toBe(true);
    expect(d.ref_epoch).toBe(1);
    expect(d.tree_epoch).toBe(2);
    expect(d.hint).toMatch(/Re-run get_tree/);
    expect(d.hint).toMatch(/retrying the same one will keep failing/);
  });

  it('D-2 从来没出现过的 ref → never_seen，且明说"重读树没用"', () => {
    const t = newTracker();
    noteTree(t, tree(['e:a']));
    const d = diagnoseMissingRef('发布', t);
    expect(d.reason).toBe(REF_NEVER_SEEN);
    expect(d.stale_ref).toBe(false);
    expect(d.ref_epoch).toBe(null);
    expect(d.hint).toMatch(/visible text instead of a data-ai-id/);
    expect(d.hint).toMatch(/Reading the tree again will not help/);
  });

  it('D-3 当前版里还有它、DOM 却查不到 → present_in_tree（换读法）', () => {
    const t = newTracker();
    noteTree(t, tree(['e:a']));
    const d = diagnoseMissingRef('e:a', t);
    expect(d.reason).toBe(REF_PRESENT_IN_TREE);
    expect(d.stale_ref).toBe(false);
    expect(d.hint).toMatch(/iframe \/ shadow root/);
  });

  it('D-4 一次树都没读过 → never_seen（不能假装自己知道）', () => {
    const d = diagnoseMissingRef('e:a', newTracker());
    expect(d.reason).toBe(REF_NEVER_SEEN);
    expect(d.tree_epoch).toBe(0);
  });

  it('D-5 stale_ref 是布尔且只在 stale 时为 true —— 它就是给 agent 用的开关', () => {
    const t = newTracker();
    noteTree(t, tree(['e:a']));
    noteTree(t, tree(['e:b']));
    expect(diagnoseMissingRef('e:a', t).stale_ref).toBe(true);
    expect(diagnoseMissingRef('e:b', t).stale_ref).toBe(false);
    expect(diagnoseMissingRef('zzz', t).stale_ref).toBe(false);
  });
});

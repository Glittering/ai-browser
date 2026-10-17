// ui.peek 的差异逻辑（shared/tree_diff.cjs）。
//
// 契约：peek 返回 {revealed, hidden}，每一项都要能直接喂给 ui.act ——
// 也就是 id 必须是 DOM 语义树的 e:xxx-*，并且带上 actions 与 bounds。
// 这两条正是换成 DOM 源的全部理由（AX 源做不到）。
import treeDiff from '../src/shared/tree_diff.cjs';

const { flattenTree, diffTree, toLite } = treeDiff;

const node = (id, extra = {}) => ({
  id,
  role: 'generic',
  label: '',
  actions: [],
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  ...extra,
});

const ids = (arr) => arr.map((n) => n.id);

describe('tree_diff：拍平', () => {
  it('TD-1: 嵌套树拍成一层，保留根节点', () => {
    const tree = { id: 'e:body-0', children: [{ id: 'e:div-1', children: [{ id: 'e:div-2', children: [] }] }] };
    expect(ids(flattenTree(tree))).toEqual(['e:body-0', 'e:div-1', 'e:div-2']);
  });

  it('TD-2: 空树 / null 不炸', () => {
    expect(flattenTree(null)).toEqual([]);
    expect(flattenTree({ id: 'x', children: [] })).toEqual([{ id: 'x', children: [] }]);
  });
});

describe('tree_diff：差异', () => {
  it('TD-3: 新出现的节点进 revealed，且带 actions 与 bounds', () => {
    const before = [node('e:body-0'), node('e:div-1')];
    const after = [node('e:body-0'), node('e:div-1'), node('e:div-2', {
      role: 'generic',
      label: '删除',
      actions: ['click'],
      bounds: { x: 900, y: 300, width: 60, height: 28 },
    })];
    const d = diffTree(before, after);
    expect(ids(d.revealed)).toEqual(['e:div-2']);
    expect(d.revealed[0].label).toBe('删除');
    expect(d.revealed[0].actions).toEqual(['click']);
    expect(d.revealed[0].bounds).toEqual({ x: 900, y: 300, width: 60, height: 28 });
    expect(d.hidden).toEqual([]);
  });

  it('TD-4: 消失的节点进 hidden', () => {
    const before = [node('e:div-1'), node('e:div-2', { label: '展开后的菜单项' })];
    const after = [node('e:div-1')];
    const d = diffTree(before, after);
    expect(ids(d.hidden)).toEqual(['e:div-2']);
    expect(d.revealed).toEqual([]);
  });

  it('TD-5（核心）: id 稳定的节点，即使位置变了也不报 —— 这是换 DOM 源的前提', () => {
    // 抽取层的 id 是稳定的（已有 data-ai-id 沿用、新元素单调递增），
    // 所以同一批元素在两次快照里 id 一致，不会被误报成"新出现"。
    const before = [node('e:div-1'), node('e:div-2'), node('e:div-3')];
    const after = [node('e:div-3'), node('e:div-1'), node('e:div-2')]; // 遍历顺序变了
    const d = diffTree(before, after);
    expect(d.revealed).toEqual([]);
    expect(d.hidden).toEqual([]);
  });

  it('TD-6: 可点的排在不可点的前面', () => {
    const before = [node('e:body-0')];
    const after = [
      node('e:body-0'),
      node('e:div-9', { label: '面板容器', actions: [] }),
      node('e:div-8', { label: '菜单项', actions: ['click'] }),
    ];
    const d = diffTree(before, after);
    expect(ids(d.revealed)).toEqual(['e:div-8', 'e:div-9']);
    expect(d.revealed[0].actions).toEqual(['click']);
  });

  it('TD-7（阴性）: 没有 actions 的项不带 actions 字段，不硬塞空数组', () => {
    const d = diffTree([node('e:a-1')], [node('e:a-1'), node('e:a-2', { actions: [] })]);
    expect(d.revealed[0].actions).toBeUndefined();
  });

  it('TD-8（阴性）: 空快照不产生假结果', () => {
    const d = diffTree([], []);
    expect(d.revealed).toEqual([]);
    expect(d.hidden).toEqual([]);
  });

  it('TD-9（阴性）: before 为空时 after 全部算新增 —— 调用方必须在入口拦掉空基线', () => {
    // 这条把"空基线会怎样"钉死，是为了说明 peek 里那道 snapshot_failed 守卫
    // 不是多余的：拿不到 before 就必须报错，不能拿空数组当基线。
    const d = diffTree([], [node('e:div-1'), node('e:div-2')]);
    expect(ids(d.revealed)).toEqual(['e:div-1', 'e:div-2']);
  });
});

describe('tree_diff：id 重绑', () => {
  // 菜单收起再展开后 DOM 是新节点、id 变了，"探到就能点"要在这一步救回来。
  it('TD-12（核心）: id 变了时，按 role+label+bounds 找回新 id', () => {
    const stale = [{ id: 'e:div-208', role: 'generic', label: '稍后再看12', actions: ['click'], bounds: { x: 683, y: 127, width: 145, height: 46 } }];
    const now = [{ id: 'e:div-999', role: 'generic', label: '稍后再看12', bounds: { x: 683, y: 127, width: 145, height: 46 } }];
    const out = treeDiff.remapIds(stale, now);
    expect(out[0].id).toBe('e:div-999');
    expect(out[0].actions).toEqual(['click']);
  });

  it('TD-13: id 还活着就原样返回，不做多余匹配', () => {
    const stale = [{ id: 'e:div-5', role: 'generic', label: 'A', bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    const now = [
      { id: 'e:div-5', role: 'generic', label: 'A', bounds: { x: 1, y: 2, width: 3, height: 4 } },
      { id: 'e:div-9', role: 'generic', label: 'A', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    ];
    expect(treeDiff.remapIds(stale, now)[0].id).toBe('e:div-5');
  });

  it('TD-14: 位置有 1~2px 抖动照样认得出', () => {
    const stale = [{ id: 'e:div-1', role: 'generic', label: 'X', bounds: { x: 100, y: 200, width: 50, height: 20 } }];
    const now = [{ id: 'e:div-77', role: 'generic', label: 'X', bounds: { x: 101, y: 202, width: 51, height: 21 } }];
    expect(treeDiff.remapIds(stale, now)[0].id).toBe('e:div-77');
  });

  it('TD-15（阴性）: 只有标签一样、位置差很远时不认，保留原 id', () => {
    // 宁可让调用方拿到 target_not_found，也不能悄悄指向另一个元素。
    const stale = [{ id: 'e:div-1', role: 'generic', label: 'X', bounds: { x: 100, y: 200, width: 50, height: 20 } }];
    const now = [{ id: 'e:div-77', role: 'generic', label: 'X', bounds: { x: 500, y: 600, width: 50, height: 20 } }];
    expect(treeDiff.remapIds(stale, now)[0].id).toBe('e:div-1');
  });

  it('TD-16（阴性）: 角色不同也不认', () => {
    const stale = [{ id: 'e:div-1', role: 'generic', label: 'X', bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    const now = [{ id: 'e:a-77', role: 'link', label: 'X', bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    expect(treeDiff.remapIds(stale, now)[0].id).toBe('e:div-1');
  });

  it('TD-17（阴性）: 新快照为空时保留原样，不把 id 抹成 undefined', () => {
    const stale = [{ id: 'e:div-1', role: 'generic', label: 'X', bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    expect(treeDiff.remapIds(stale, [])[0].id).toBe('e:div-1');
  });
});

describe('tree_diff：输出形状', () => {
  it('TD-10: label 为 null 时归一成空串，不输出 null', () => {
    const lite = toLite({ id: 'e:div-1', label: null });
    expect(lite.label).toBe('');
  });

  it('TD-11: 缺 role 时兜底 generic', () => {
    expect(toLite({ id: 'e:div-1' }).role).toBe('generic');
  });
});

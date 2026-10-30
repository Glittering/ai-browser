// tests/test_tab_state_reset.js — 「关掉一个 tab，per-tab 状态必须清齐」的行为判据 + 完整性闸门。
//
// 为什么不是源码 grep（这个文件之前就是那种写法，见 test_bug5_tab_close_cleanup.js）：
//   `expect(body).toMatch(/_refTrackers\.delete\(tabId\)/)` 只能证明**代码在**，
//   不能证明**它真的执行**，更不能发现"第 27 个容器没人清"。
//   历史两轮事故正是这么漏过去的：Bug 5 只补了被点名的 4 个字段，
//   2026-10-30 评估又查出 _openedTabs / _canvasBindings / _paintAuditInflight。
//
// 这里用两种判据，互补：
//   TS-1..TS-9   行为：假 owner 装真 Map/Set，验证"哪类容器怎么清"，
//                        并用假定时器证明 clearTimeout 真的被调到。
//   TS-10..TS-12 闸门：静态解析 page_manager.js 里所有 `this._x = new Map()/Set()`，
//                        断言每个字段要么登记在 PER_TAB，要么在白名单里写明理由。
//                        新增容器忘登记 = 这个测试红，而不是半年后一次泄漏。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tabState from '../src/shared/tab_state.cjs';

const { PER_TAB, NOT_PER_TAB, clearPerTab } = tabState;

/** 造一个"像 PageManager"的假 owner：按表把每个字段都装成真的 Map/Set。 */
function fakeOwner(table = PER_TAB) {
  const o = {};
  for (const row of table) {
    o[row.field] = row.byValue ? new Map() : new Map();
  }
  // Set 型字段单独标注（表里没有 kind 标记，按字段名约定）
  for (const f of ['_windowOpenShimTabs', '_dialogWatched', '_failureGuard']) {
    if (o[f]) o[f] = new Set();
  }
  return o;
}

describe('tab_state — 清理一个 tab 的状态（行为）', () => {
  it('TS-1: Map 以 tabId 为键的条目被删掉', () => {
    const o = fakeOwner();
    o._tabNavState.set(3, 'ready');
    o._tabNavState.set(4, 'loading');
    clearPerTab(o, 3);
    expect(o._tabNavState.has(3), 'tab 3 的条目必须消失').toBe(false);
    expect(o._tabNavState.get(4), '别的 tab 不许被牵连').toBe('loading');
  });

  it('TS-2: Set 成员是 tabId 的条目被删掉（delete 不是 clear）', () => {
    const o = fakeOwner();
    o._dialogWatched.add(3);
    o._dialogWatched.add(4);
    clearPerTab(o, 3);
    expect(o._dialogWatched.has(3)).toBe(false);
    expect(o._dialogWatched.has(4), '别人的条目必须留着').toBe(true);
  });

  it('TS-3: byValue 容器按**值**清，不是按键清（_canvasBindings 键是随机名）', () => {
    const o = fakeOwner();
    // 真实现里键形如 __aiCanvasReport_3_k3f9a1，值才是 tabId
    o._canvasBindings.set('__aiCanvasReport_3_k3f9a1', 3);
    o._canvasBindings.set('__aiCanvasReport_3_zzz', 3);
    o._canvasBindings.set('__aiCanvasReport_4_abc', 4);
    clearPerTab(o, 3);
    expect(o._canvasBindings.size, '指回 tab 3 的两条都要清掉，tab 4 的留着').toBe(1);
    expect(o._canvasBindings.get('__aiCanvasReport_4_abc')).toBe(4);
  });

  it('TS-4: timers 容器必须真的 clearTimeout（不只是删 Map 条目）', () => {
    vi.useFakeTimers();
    try {
      const o = fakeOwner();
      const fired = vi.fn();
      const t = setTimeout(fired, 100);
      o._paintTimers.set(7, t);
      clearPerTab(o, 7);
      expect(o._paintTimers.has(7)).toBe(false);
      vi.advanceTimersByTime(500);
      expect(fired, '清掉的定时器不许在 500ms 后还去敲一次已关闭的 tab').not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TS-5: 定时器已被触发过也不许抛（真实现里 timer 可能早就 settle 了）', () => {
    vi.useFakeTimers();
    try {
      const o = fakeOwner();
      const t = setTimeout(() => {}, 10);
      o._paintTimers.set(7, t);
      vi.advanceTimersByTime(50); // 已触发
      expect(() => clearPerTab(o, 7)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TS-6: 懒初始化字段此刻不存在也不许抛', () => {
    const o = {};
    expect(() => clearPerTab(o, 1)).not.toThrow();
  });

  it('TS-7: 字段被误写成数组/字符串也不许抛，且不改动它', () => {
    const o = { _tabGroup: ['x'], _tabUsedAt: 'oops' };
    expect(() => clearPerTab(o, 1)).not.toThrow();
    expect(o._tabGroup).toEqual(['x']);
    expect(o._tabUsedAt).toBe('oops');
  });

  it('TS-8: tabId 为 undefined/null 时什么都不做（不许把整张表清空）', () => {
    const o = fakeOwner();
    o._tabNavState.set(0, 'a');
    clearPerTab(o, undefined);
    clearPerTab(o, null);
    expect(o._tabNavState.get(0)).toBe('a');
  });

  it('TS-9: 返回真正执行过清理的字段名（调用方/测试可观测）', () => {
    const table = [{ field: '_tabGroup' }, { field: '_notExist' }];
    const o = { _tabGroup: new Map() };
    expect(clearPerTab(o, 1, table)).toEqual(['_tabGroup']);
  });
});

describe('tab_state — 完整性闸门：新增 per-tab 容器必须登记', () => {
  const pmSrc = readFileSync(join(process.cwd(), 'src/main/page_manager.js'), 'utf8');

  // 只认字面量 `new Map()` / `new Set()` —— 这正是"新增一个 per-tab 容器"
  // 最常见的写法；把它抓全，闸门才有意义。
  const declared = [...new Set(
    [...pmSrc.matchAll(/this\.(_[A-Za-z0-9]+)\s*=\s*new\s+(?:Map|Set)\(\)/g)].map((m) => m[1])
  )];

  it('TS-10: 解析到了容器字段（阳性对照：抓不到就说明正则失效，闸门是假的）', () => {
    expect(declared.length, '一个都没解析到 → 闸门的正则已经不匹配当前写法').toBeGreaterThan(20);
    // 这几个是必须被看见的样本，否则"没解析到所以全绿"就成立了
    expect(declared).toContain('_tabGroup');
    expect(declared).toContain('_refTrackers');
    expect(declared).toContain('_canvasBindings');
  });

  it('TS-11: 每个容器字段要么在 PER_TAB 里，要么在 NOT_PER_TAB 白名单里（且写了理由）', () => {
    const registered = new Set(PER_TAB.map((r) => r.field));
    const unregistered = declared.filter(
      (f) => !registered.has(f) && !(f in NOT_PER_TAB)
    );
    expect(
      unregistered,
      '这些 per-tab 容器没有登记：\n' +
        unregistered.map((f) => '  · ' + f).join('\n') +
        '\n要么加进 shared/tab_state.cjs 的 PER_TAB（关 tab 时清），' +
        '\n要么加进 NOT_PER_TAB 并写清"为什么不归这里清"。'
    ).toEqual([]);
  });

  it('TS-12: 白名单里的每条都写了理由（空字符串/占位符不算）', () => {
    for (const [field, why] of Object.entries(NOT_PER_TAB)) {
      expect(typeof why, field + ' 的理由必须是字符串').toBe('string');
      expect(why.length, field + ' 的理由太短，等于没写').toBeGreaterThan(10);
    }
  });

  it('TS-13: 表里的字段确实存在于 page_manager（防止改名后表变成僵尸）', () => {
    const missing = PER_TAB.map((r) => r.field).filter((f) => !pmSrc.includes('this.' + f));
    expect(missing, '表里登记了但源码里不存在（大概改名了）').toEqual([]);
  });
});

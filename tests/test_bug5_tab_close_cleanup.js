// tests/test_bug5_tab_close_cleanup.js — Bug 5 的**接线**判据（逐字段行为已迁走）。
//
// 这个文件原来是"源码 grep"：`expect(body).toMatch(/_refTrackers\.delete\(tabId\)/)`。
// 它只能证明"代码在"，不能证明"真执行"，更看不见第 27 个容器。
// 2026-10-30 评估（docs/AUDIT-2026-10-30.md P1-2）正是靠逐字段核对又抓出 3 个漏网
// （_openedTabs / _canvasBindings / _paintAuditInflight）。
//
// 现在分成两半：
//   · 清理**行为**由 shared/tab_state.cjs 承担，判据在 tests/test_tab_state_reset.js
//     （假 owner + 假定时器，验证每类容器怎么清、且"新增容器忘登记"会红）；
//   · 本文件只留**接线**：page_manager 是否真的调了那张表、调用顺序对不对、
//     有没有人又回到"逐行手写 delete"的老路。逻辑可测在模块里，接线在入口，
//     两者分开 —— 与 Bug 7 的处理方式一致（见 test_bug7_nav_state_cleanup.js）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tabState from '../src/shared/tab_state.cjs';

const ROOT = process.cwd();
const pmSrc = readFileSync(join(ROOT, 'src/main/page_manager.js'), 'utf8');

function bodyOf(sig) {
  const start = pmSrc.indexOf(sig);
  expect(start, `src/main/page_manager.js 找不到 ${sig}`).toBeGreaterThanOrEqual(0);
  const end = pmSrc.indexOf('\n  }\n', start);
  expect(end, `${sig} 的结束边界没找到（可能改名/缩进变了）`).toBeGreaterThan(start);
  return pmSrc.slice(start, end);
}

const body = bodyOf('_cleanupTabResources(tabId) {');

describe('Bug 5 — 关 tab 的清理必须走那张登记表，不许再退回手写列举', () => {
  it('BUG5-1: _cleanupTabResources 必须调用 tabState.clearPerTab（唯一清单入口）', () => {
    expect(body, [
      'BUG5-RED: _cleanupTabResources 没有调用 tabState.clearPerTab ——',
      '清理又回到逐行 delete，新增 per-tab 容器时会静默漏清。',
      '修复：在 shared/tab_state.cjs 的 PER_TAB 登记，并在这里调用 clearPerTab(this, tabId)。',
    ].join('\n')).toMatch(/tabState\s*\.\s*clearPerTab\(\s*this\s*,\s*tabId\s*\)/);
  });

  it('BUG5-2: 必须**先**清纯数据，再碰有副作用的步骤（detach 可能抛）', () => {
    const clearAt = body.indexOf('clearPerTab');
    const detachAt = body.indexOf('debugger.detach');
    expect(clearAt, '没有 clearPerTab').toBeGreaterThanOrEqual(0);
    expect(detachAt, '没有 debugger.detach（结构变了？）').toBeGreaterThanOrEqual(0);
    expect(
      clearAt,
      '先 detach 再清纯数据：一旦 detach 抛异常，tabId 会带着上一任的状态被复用'
    ).toBeLessThan(detachAt);
  });

  it('BUG5-3: 函数体里不许再出现逐字段的 this._xxx.delete(tabId)（两处清单必然分叉）', () => {
    // 白名单里的字段本来就不归那张表管（例如 _cdpTabs 必须先 debugger.detach，
    // 有副作用，不能塞进纯函数），所以它们手写清理是**对的**。
    const allowed = new Set(Object.keys(tabState.NOT_PER_TAB));
    const handWritten = [...body.matchAll(/this\.(_[A-Za-z0-9]+)\s*\.\s*delete\(\s*tabId\s*\)/g)]
      .map((m) => m[1])
      .filter((f) => !allowed.has(f));
    expect(
      handWritten,
      '这些字段又变成手写清理了：' + handWritten.join(', ') +
        '\n改法：登记到 shared/tab_state.cjs 的 PER_TAB，删掉这里的逐行 delete。'
    ).toEqual([]);
  });

  it('BUG5-4: canvas 抓取状态必须显式 forget（它有独立账本，且必须连空壳一起删）', () => {
    expect(body, [
      'BUG5-RED: 没有 canvasMonitor.forget(tabId) ——',
      'canvas 的配额账本与 hook 句柄不在 PER_TAB 里，必须显式清；',
      '而且要用 forget 而不是 clear（clear 保留 mode/hook，只用于 canvas_configure{clear:true}），',
      '否则 tabs Map 每关一页多一条、无界累积（没有淘汰上限）。',
    ].join('\n')).toMatch(/canvasMonitor\s*\.\s*forget\(\s*tabId\s*\)/);
  });

  it('BUG5-5: closeTab 必须走到 _cleanupTabResources（否则整张表都不会被用上）', () => {
    const closeBody = bodyOf('closeTab(tabId) {');
    expect(closeBody).toMatch(/_cleanupTabResources\(\s*tabId\s*\)/);
  });
});

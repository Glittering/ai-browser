// tests/test_bug5_tab_close_cleanup.js — Bug 5：关闭 tab 后，per-tab 状态必须清齐。
//
// 背景（2026-10-30 内存只读深挖结论）：
//   · PageManager 有若干 per-tab Map / Set（_refTrackers / _axDiffCache /
//     _failureGuard / canvasMonitor.tabs …），设计上都应该跟随 tab 的生死。
//   · 但 `_cleanupTabResources`（closeTab 调用的收尾路径）只清了 CDP /
//     network / snapshot / download / media / paint 状态，**没有**清：
//       - _refTrackers（ref 追踪器，create/get 后从不 delete）；
//       - _axDiffCache（增量 diff 快照，只在 navigate 清，关 tab 不清）；
//       - _failureGuard（错误页守卫 Set）。
//       - canvasMonitor.tabs（clear(tabId) 存在却从不被调）。
//   · tabId 是会被**复用**的（Electron 语义），关掉的 tab 留下这些状态，
//     新 tab 一开就带着上一任的 tracker / snapshot / canvas 抓取活着 →
//     长会话下内存（以及状态正确性）持续泄漏。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const pmSrc = read('src/main/page_manager.js');

function extractCleanupTabResourcesBody() {
  const marker = '_cleanupTabResources(tabId) {';
  const start = pmSrc.indexOf(marker);
  expect(
    start,
    'src/main/page_manager.js 找不到 _cleanupTabResources'
  ).toBeGreaterThanOrEqual(0);
  const end = pmSrc.indexOf('\n  }\n', start);
  expect(
    end,
    '_cleanupTabResources 的结束边界没找到（可能是改名/缩进变了）'
  ).toBeGreaterThan(start);
  return pmSrc.slice(start, end);
}

describe('Bug 5 — 关闭 tab 后 must clean per-tab bookkeeping', () => {
  const body = extractCleanupTabResourcesBody();

  it('BUG5-1: _cleanupTabResources 必须清掉该 tab 的 ref tracker（_refTrackers.delete）', () => {
    expect(body, [
      'BUG5-RED: _cleanupTabResources 没有清 _refTrackers —— ref tracker 会随着 tabId 复用无限累积。',
      '修复：在关 tab 收尾处加 `if (this._refTrackers) this._refTrackers.delete(tabId);`。',
    ].join('\n')).toMatch(/_refTrackers\s*\.delete\(tabId\)/);
  });

  it('BUG5-2: _cleanupTabResources 必须清掉该 tab 的增量 diff 快照（_axDiffCache.delete）', () => {
    expect(body, [
      'BUG5-RED: _cleanupTabResources 没有清 _axDiffCache —— 关掉的 tab 的 lite snapshot 一直占着。',
      '修复：在关 tab 收尾处加 `this._axDiffCache.delete(tabId);`。',
    ].join('\n')).toMatch(/_axDiffCache\s*\.delete\(tabId\)/);
  });

  it('BUG5-3: _cleanupTabResources 必须清掉该 tab 的错误页守卫（_failureGuard.delete）', () => {
    expect(body, [
      'BUG5-RED: _cleanupTabResources 没有清 _failureGuard —— 关掉的 tab 的守卫会残留。',
      '修复：在关 tab 收尾处加 `if (this._failureGuard) this._failureGuard.delete(tabId);`。',
    ].join('\n')).toMatch(/_failureGuard\s*\.delete\(tabId\)/);
  });

  it('BUG5-4: _cleanupTabResources 必须清掉该 tab 的 canvas 抓取状态（canvasMonitor.clear）', () => {
    expect(body, [
      'BUG5-RED: _cleanupTabResources 没有清 canvasMonitor —— 关掉的 tab 的 canvas 抓取状态会累积。',
      '修复：在关 tab 收尾处加 `this.canvasMonitor.clear(tabId);`。',
    ].join('\n')).toMatch(/canvasMonitor\s*\.clear\(tabId\)/);
  });
});

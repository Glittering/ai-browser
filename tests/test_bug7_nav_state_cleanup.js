// tests/test_bug7_nav_state_cleanup.js — Bug 7 的"接线"判据。
//
// ⚠️ 这个文件原来是**源码 grep**（`expect(region).toMatch(/removeListener/)`），
// 而那段代码真实行为是错的：实测 A→B→A 切 5 次后监听累加到 3 个，两条断言全绿。
// 行为判据已搬到 tests/test_nav_follow.js（数 listenerCount / 数 push 次数），
// 这里只保留"index.js 不许再自己写一套"的接线断言 —— 逻辑在模块里可测，
// 接线在入口，两者分开，避免又退化成"grep 到关键字就算过"。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import navFollow from '../src/shared/nav_follow.cjs';

const { NAV_EVENTS } = navFollow;
const ROOT = process.cwd();
const idxSrc = readFileSync(join(ROOT, 'src/main/index.js'), 'utf8');

describe('Bug 7 — 地址栏跟随必须走可测的模块，不在入口里重写一遍', () => {
  it('BUG7-1: index.js 必须用 shared/nav_follow.cjs 的 createNavFollower', () => {
    expect(idxSrc, [
      'BUG7-RED: index.js 没有引入 nav_follow —— 幂等挂载逻辑又回到闭包里，',
      '只能靠 grep 源码判对错（历史上就是这样让"监听累加到 3"跑绿的）。',
    ].join('\n')).toMatch(/createNavFollower/);
  });

  it('BUG7-2: index.js 不得自己再逐个 wc.on 挂导航事件（重复实现 = 重复挂载风险）', () => {
    for (const ev of NAV_EVENTS) {
      const re = new RegExp(`wc\\.on\\(\\s*['"]${ev}['"]`);
      expect(idxSrc, `BUG7-RED: index.js 里还在自己挂 "${ev}"，应交给 nav_follow。`).not.toMatch(re);
    }
  });

  it('BUG7-3: 事件契约（5 个，顺序无关但集合固定）', () => {
    expect(NAV_EVENTS).toEqual([
      'did-start-loading', 'did-stop-loading', 'did-navigate',
      'did-navigate-in-page', 'page-title-updated',
    ]);
  });
});

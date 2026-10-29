// e2e 套件的窗口策略。
//
// 为什么值得单测：这条策略决定了"跑测试时用户的桌面会不会被窗口糊一脸"，
// 而它只在 spawn 那一刻生效 —— 光看代码很难确认某个套件到底落在哪一档。
// 2026-10-28 之前 27 处 spawn 全都没设，等于 22 次抢前台，没人发现，
// 因为没有一处能把"默认值"读出来看。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('e2e 窗口策略', () => {
  let saved;
  beforeEach(() => {
    saved = {
      v: process.env.AI_BROWSER_E2E_VISIBLE,
      h: process.env.AI_BROWSER_E2E_HIDDEN,
    };
    delete process.env.AI_BROWSER_E2E_VISIBLE;
    delete process.env.AI_BROWSER_E2E_HIDDEN;
    // 每次都要拿新的模块实例：模块在 require 时就读了 env
    delete require.cache[require.resolve('../e2e/_window_mode.cjs')];
  });
  afterEach(() => {
    if (saved.v === undefined) delete process.env.AI_BROWSER_E2E_VISIBLE;
    else process.env.AI_BROWSER_E2E_VISIBLE = saved.v;
    if (saved.h === undefined) delete process.env.AI_BROWSER_E2E_HIDDEN;
    else process.env.AI_BROWSER_E2E_HIDDEN = saved.h;
  });

  const load = () => require('../e2e/_window_mode.cjs');

  it('WM-1 默认：普通套件必须完全不出窗口（hidden + 不激活）', () => {
    const env = load().windowEnv('multiagent');
    expect(env.AI_BROWSER_START_HIDDEN).toBe('1');
    expect(env.AI_BROWSER_LAUNCHED_BY_AGENT).toBe('1');
  });

  it('WM-2 白名单：focus / flicker / layout / paint / nav 要真实窗口，但不许激活', () => {
    const { windowEnv, VISIBLE } = load();
    for (const suite of ['focus', 'flicker', 'layout', 'paint', 'nav']) {
      expect(VISIBLE.has(suite)).toBe(true);
      const env = windowEnv(suite);
      expect(env.AI_BROWSER_START_HIDDEN).toBe('0');
      // 关键：可见 ≠ 抢。只有 showInactive 才不会把用户的 app 顶下去。
      expect(env.AI_BROWSER_LAUNCHED_BY_AGENT).toBe('1');
    }
  });

  it('WM-3 文件名带 _ws.cjs 也能认出来', () => {
    expect(load().windowEnv('focus_ws.cjs').AI_BROWSER_START_HIDDEN).toBe('0');
    expect(load().windowEnv('smoke_ws.cjs').AI_BROWSER_START_HIDDEN).toBe('1');
  });

  it('WM-4 逃生口：E2E_VISIBLE=1 让任意套件可见，E2E_HIDDEN=1 强制全部隐藏', () => {
    process.env.AI_BROWSER_E2E_VISIBLE = '1';
    delete require.cache[require.resolve('../e2e/_window_mode.cjs')];
    expect(load().windowEnv('multiagent').AI_BROWSER_START_HIDDEN).toBe('0');

    process.env.AI_BROWSER_E2E_HIDDEN = '1';
    delete require.cache[require.resolve('../e2e/_window_mode.cjs')];
    // HIDDEN 优先于 VISIBLE：允许"我就想确认隐藏下还行不行"
    expect(load().windowEnv('focus').AI_BROWSER_START_HIDDEN).toBe('1');
  });

  it('WM-5 所有套件都真的用上了这条策略（没有漏网的 spawn）', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(process.cwd(), 'e2e');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.cjs') || f.startsWith('_')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // run_all 只是起套件进程（子进程会自己设），不算
      if (f === 'run_all.cjs') continue;
      if (!src.includes('...process.env')) continue;
      if (src.includes('windowEnv(')) continue;
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

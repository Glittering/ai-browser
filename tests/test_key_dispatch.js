// tests/test_key_dispatch.js — 「按了等于没按」：Enter 的默认动作要靠 keypress 才会触发。
//
// 背景（2026-10-17 真实站点 + 隔离实验）：把焦点放在一个 <button> 上，
// ui.act {action:'press', key:'Enter'} 返回 success，页面也确实收到了 keydown
// （e.key==='Enter'、isTrusted=true），但 onclick **一次都没触发**；同一元素
// 用 click 正常。根因：CDP 的 rawKeyDown 刻意不带 text，浏览器只派 keydown、
// 不产生 keypress，而 Enter 激活聚焦元素走的是默认动作（keypress）。
//
// 这里钉住决策本身（纯函数），另有一条真实 CDP 的端到端证据在
// tools/_oneoff/probe_press_enter.cjs 里跑。

import { describe, it, expect } from 'vitest';
import keyDispatchUtil from '../src/shared/key_dispatch.cjs';

const { keyDispatchPlan } = keyDispatchUtil;

describe('KP 按键派发决策', () => {
  it('KP-1: press Enter → 带 text 的 keyDown（唯一能触发默认动作的形态）', () => {
    const plan = keyDispatchPlan({ key: 'Enter', code: 'Enter', vk: 13 }, { activate: true });
    expect(plan.type).toBe('keyDown');
    expect(plan.text).toBe('\r');
  });

  it('KP-2: type 里的段间换行保持 rawKeyDown（不能被上面那条改坏）', () => {
    // type 的策略是"先发不带 text 的 Enter，看编辑器有没有自己分段，没分才补 char"。
    // 一旦这里也变成 keyDown+text，会先插一个 \r 再补一个 → 多出空行。
    const plan = keyDispatchPlan({ key: 'Enter', code: 'Enter', vk: 13 }, undefined);
    expect(plan.type).toBe('rawKeyDown');
    expect(plan.text).toBe('');
  });

  it('KP-3: rawKeyDown 且带字符的键要补 char 事件（换行才落得下去）', () => {
    const plan = keyDispatchPlan({ key: '\r', code: 'Enter', vk: 13, text: '\r' }, undefined);
    expect(plan.type).toBe('rawKeyDown');
    expect(plan.charText).toBe('\r');
  });

  it('KP-4: Tab / Delete 这类默认动作在 keydown 上的键，仍然走 rawKeyDown', () => {
    for (const spec of [{ key: 'Tab', code: 'Tab', vk: 9 }, { key: 'Delete', code: 'Delete', vk: 46 }]) {
      const plan = keyDispatchPlan(spec, { activate: true });
      expect(plan.type, `${spec.key} 不该被塞 text`).toBe('rawKeyDown');
      expect(plan.text).toBe('');
    }
  });

  it('KP-5: Space 用键表自带的 text，不改写', () => {
    const plan = keyDispatchPlan({ key: ' ', code: 'Space', vk: 32, text: ' ' }, { activate: true });
    expect(plan.type).toBe('keyDown');
    expect(plan.text).toBe(' ');
  });

  it('KP-6: 空参数不崩（缺 key/text 时给 rawKeyDown）', () => {
    expect(keyDispatchPlan(undefined, undefined).type).toBe('rawKeyDown');
    expect(keyDispatchPlan({}, undefined).type).toBe('rawKeyDown');
    expect(keyDispatchPlan({}, { activate: true }).type).toBe('rawKeyDown');
  });
});

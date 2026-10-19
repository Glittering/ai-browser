// tests/test_effect_state.js — 动作回执的 effect_state 三态分类。
//
// 这组测试的价值不在覆盖率，而在**词表**：E-2 那一组把 page_manager.js 里真实
// 出现过的 error 文案逐条钉住分类。以后谁改了一句错误文案的措辞，导致一个"没点到"
// 被误判成"不知道"，这里的断言会先红 —— 而不是等 agent 在生产上盲目重试。
import { describe, it, expect } from 'vitest';
import {
  classifyEffect, retryAdvice, withEffectState,
  EFFECT_NONE, EFFECT_COMMITTED, EFFECT_UNKNOWN,
  RETRY_SAFE, RETRY_NO, RETRY_VERIFY_FIRST,
} from '../src/shared/effect_state.js';

describe('classifyEffect — committed', () => {
  it('E-1 成功派发即 committed', () => {
    expect(classifyEffect({ success: true })).toBe(EFFECT_COMMITTED);
  });

  it('E-1b hover/peek 用 revealed 表达成功（没有 success 字段）', () => {
    expect(classifyEffect({ revealed: [], hidden: [], mode: 'hover' })).toBe(EFFECT_COMMITTED);
    expect(classifyEffect({ revealed: [{ id: 'e:a' }] })).toBe(EFFECT_COMMITTED);
  });

  it('E-1c 成功且带 warning 也仍是 committed —— 输入已经出去了', () => {
    expect(classifyEffect({ success: true, warning: 'value not verified' })).toBe(EFFECT_COMMITTED);
  });
});

describe('classifyEffect — none（真实错误文案逐条钉住）', () => {
  const NOTHING_HAPPENED = {
    'target_not_found': 'target_not_found: no element with data-ai-id=e:button-12',
    // 下面这条是真机跑出来的原文（src/preload/actions.cjs:34），跟上面那条
    // 前缀完全不同。之前只按 page_manager 里的文案建词表，实测漏判 ——
    // 这是"词表必须来自真实输出而不是来自源码印象"的证据，留着当标本。
    'Target not found for ref': 'Target not found for ref: e:body-0',
    'ref shape guard': 'target looks like visible text, not a data-ai-id: "发布" — pass the id from get_tree',
    'no target': 'No target',
    'no url provided': 'no url provided',
    'no link matches url': 'no link matches url: https://example.com/a',
    'tab not found': 'Tab not found',
    'no-such-tab': 'no-such-tab',
    'target_has_no_value': 'target_has_no_value',
    'sensitive_value_not_readable': 'sensitive_value_not_readable: input[type=password] is never exposed',
    'unsupported action': 'unsupported action: teleport',
    'missing-snapshot': 'missing-snapshot',
    'unknown-snapshot': 'unknown-snapshot',
    'cdp-unavailable': 'cdp-unavailable',
    'requires CDP': 'wheel requires CDP — the debugger is not attached to this tab',
    'wheel need dx/dy': 'wheel: need dx or dy (e.g. dy:-600 zooms/pans up)',
    'drag start not found': 'drag: start element not found: e:div-3',
    'drag to_target not found': 'drag: to_target not found: e:div-9',
    'drag need target': 'drag: need one of params.to / to_target / dx,dy',
    'upload target not found': 'upload target not found: no element matches input[type=file]',
    'cannot read file': 'cannot read file: ENOENT',
    'type empty text': 'type called with empty text — nothing was typed.',
    'paste no payload': 'paste called with neither html nor text — nothing to paste.',
    'snapshot_failed': 'snapshot_failed: 拿不到悬停时的语义树',
  };

  for (const [label, error] of Object.entries(NOTHING_HAPPENED)) {
    it(`E-2 ${label} → none（重试安全）`, () => {
      const r = { success: false, error };
      expect(classifyEffect(r)).toBe(EFFECT_NONE);
      expect(retryAdvice(classifyEffect(r))).toBe(RETRY_SAFE);
    });
  }
});

describe('classifyEffect — unknown（不确定就必须承认不确定）', () => {
  it('E-3 超时永远不是 none —— 指针可能已经按下', () => {
    expect(classifyEffect({ success: false, timed_out: true, error: 'deadline exceeded after 15000ms' }))
      .toBe(EFFECT_UNKNOWN);
  });

  it('E-3b 超时文案里即使同时出现 target_not_found 也判 unknown（超时优先）', () => {
    expect(classifyEffect({ success: false, timed_out: true, error: 'target_not_found' }))
      .toBe(EFFECT_UNKNOWN);
  });

  it('E-4 粘贴事件派发了但页面没消费 → unknown', () => {
    expect(classifyEffect({
      success: false,
      error: 'paste event was not consumed by the page (defaultPrevented=false) — this editor likely listens on a different surface',
    })).toBe(EFFECT_UNKNOWN);
  });

  it('E-4b 粘贴被消费但内容没落地 → unknown', () => {
    expect(classifyEffect({
      success: false,
      error: 'paste was consumed but nothing landed — the editor may have rejected the payload',
    })).toBe(EFFECT_UNKNOWN);
  });

  it('E-5 按到一半的键 → unknown（已按下的那部分已经生效）', () => {
    expect(classifyEffect({ success: false, error: 'press: unsupported key: F13', pressed: ['Meta', 'a'] }))
      .toBe(EFFECT_UNKNOWN);
  });

  it('E-6 失败但没有任何可信征兆 → 默认 unknown，不能默认 none', () => {
    // 这条是整套设计的立场：分不清时承认不知道，比猜"应该没点到"安全。
    expect(classifyEffect({ success: false, error: 'something unexpected happened' }))
      .toBe(EFFECT_UNKNOWN);
    expect(classifyEffect({})).toBe(EFFECT_UNKNOWN);
    expect(classifyEffect(null)).toBe(EFFECT_UNKNOWN);
  });

  it('E-7 部分生效的显式说明 → unknown', () => {
    expect(classifyEffect({ success: false, error: 'the action may have partially applied' })).toBe(EFFECT_UNKNOWN);
    expect(classifyEffect({ success: false, error: 'debugger detached mid-action' })).toBe(EFFECT_UNKNOWN);
  });
});

describe('retryAdvice', () => {
  it('R-1 三态各有唯一策略', () => {
    expect(retryAdvice(EFFECT_NONE)).toBe(RETRY_SAFE);
    expect(retryAdvice(EFFECT_COMMITTED)).toBe(RETRY_NO);
    expect(retryAdvice(EFFECT_UNKNOWN)).toBe(RETRY_VERIFY_FIRST);
    expect(retryAdvice('随便什么')).toBe(RETRY_VERIFY_FIRST); // 未知输入按最保守处理
  });
});

describe('withEffectState', () => {
  it('W-1 写入三态与策略，且不原地修改入参', () => {
    const src = { success: true };
    const out = withEffectState(src);
    expect(out).toEqual({ success: true, effect_state: 'committed', retry: 'no' });
    expect(src.effect_state).toBeUndefined();
  });

  it('W-2 unknown 时附一句自解释的提示（模型第一次见到也知道该干什么）', () => {
    const out = withEffectState({ success: false, timed_out: true, error: 'deadline' });
    expect(out.effect_state).toBe(EFFECT_UNKNOWN);
    expect(out.retry).toBe(RETRY_VERIFY_FIRST);
    expect(out.effect_hint).toMatch(/Read the page/);
    expect(out.effect_hint).toMatch(/blind retry can submit twice/);
  });

  it('W-3 none / committed 不塞提示 —— 别在正常回执里加噪音', () => {
    expect(withEffectState({ success: true }).effect_hint).toBeUndefined();
    expect(withEffectState({ success: false, error: 'target_not_found: x' }).effect_hint).toBeUndefined();
  });

  it('W-4 调用方已有更具体的 effect_hint 时不覆盖', () => {
    const out = withEffectState({ success: false, timed_out: true, error: 'x', effect_hint: '先看弹窗' });
    expect(out.effect_hint).toBe('先看弹窗');
  });

  it('W-5 extras 会合并进回执（stale_ref 诊断走这条路）', () => {
    const out = withEffectState({ success: false, error: 'target_not_found: x' }, { stale_ref: true, tree_epoch: 7 });
    expect(out.stale_ref).toBe(true);
    expect(out.tree_epoch).toBe(7);
    expect(out.effect_state).toBe(EFFECT_NONE);
  });

  it('W-5b extras 可以覆盖 retry —— ref 类失败必须盖成 verify_first', () => {
    // 实测发现的语义分叉：ref 过期时 effect_state=none（确实没副作用），
    // 但"原样重试"必然再失败。给 safe 就是骗调用方。
    const out = withEffectState(
      { success: false, error: 'Target not found for ref: e:a-23' },
      { stale_ref: true, retry: RETRY_VERIFY_FIRST }
    );
    expect(out.effect_state).toBe(EFFECT_NONE);
    expect(out.stale_ref).toBe(true);
    expect(out.retry).toBe(RETRY_VERIFY_FIRST);
  });

  it('W-6 非对象原样返回（防御性）', () => {
    expect(withEffectState(null)).toBe(null);
    expect(withEffectState('x')).toBe('x');
  });
});

// tests/test_ref_guard.js — ui.act target 形状体检（纯函数）
// 坑的来源：target 传了可见文字（"发布"）而不是 data-ai-id，最终以
// `[data-ai-id="发布"]` 查空，回一句不带方向的 "Target not found"。
import { describe, it, expect } from 'vitest';
import { refShapeError, MAX_REF_LEN } from '../src/shared/ref_guard.cjs';

describe('refShapeError — reject shapes that cannot be ids', () => {
  it('RG-1: whitespace inside means it is a label, not an id', () => {
    const e = refShapeError('点击 发布按钮');
    expect(e).toContain('looks like visible text');
    expect(e).toContain('data-ai-id');
  });

  it('RG-1b: a pure-CJK string with no ASCII structure is a label, not an id (no space needed)', () => {
    // 真实站点上 agent 就是直接传 "发布" / "点击发布"，没有空格。树里的 ref
    // 要么带结构前缀（e:button-12 / axf-3-1）要么是 ASCII 原生 id，纯 CJK
    // 无 ASCII 的 id 实际不存在 —— 放行只会退化成无方向的 Target not found。
    for (const label of ['发布', '点击发布', '编辑器', '保存草稿']) {
      const e = refShapeError(label);
      expect(e, label).toContain('looks like visible text');
    }
    // 错误必须是可操作的：给出 id 形状 + 万一真是原生 id 的绕过方式
    expect(refShapeError('发布')).toContain('e:button-12');
    expect(refShapeError('发布')).toContain('ui.evaluate');
  });

  it('RG-2: over-long target is text, not an id', () => {
    const e = refShapeError('x'.repeat(MAX_REF_LEN + 1));
    expect(e).toContain('data-ai-id values are short');
  });

  it('RG-3: selector-ish input gets a pointed error', () => {
    expect(refShapeError('[data-ai-id="e:button-1"]')).toContain('starts with a quote/bracket');
    expect(refShapeError('#submit')).toBeNull(); // # 开头不是引号/括号，放行
  });

  it('RG-4: legitimate refs pass untouched', () => {
    for (const ok of ['e:button-12', 'axf-3-1', 'submit-btn', 'e:input-7', 'e:按钮-1', 'app', 'title-input__inner']) {
      expect(refShapeError(ok), ok + ' must pass').toBeNull();
    }
  });

  it('RG-5: empty/undefined is not this guard\'s business', () => {
    expect(refShapeError('')).toBeNull();
    expect(refShapeError(undefined)).toBeNull();
    expect(refShapeError(null)).toBeNull();
  });
});

// ---- deadline：paste 已在 P1-2 覆盖；这里回归 actionDeadlineMs 对 paste 的缩放 ----
import { actionDeadlineMs } from '../src/shared/deadline.js';

describe('actionDeadlineMs — paste still scales (regression)', () => {
  it('RG-DL-1: bigger payload → bigger budget', () => {
    const small = actionDeadlineMs('paste', { html: '<p>x</p>' });
    const big = actionDeadlineMs('paste', { html: '<p>' + 'y'.repeat(50000) + '</p>' });
    expect(big).toBeGreaterThan(small);
  });
});

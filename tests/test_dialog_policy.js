// tests/test_dialog_policy.js — 浏览器级对话框的应答策略（src/shared/dialog_policy.cjs）
//
// 背景：alert/confirm 是 Electron 画的原生 sheet，不在 DOM/AX 树里，而且**打开
// 期间渲染器被阻塞**（evaluate 都不返回）。所以策略必须由主进程给出，且不能
// 依赖页面里的任何东西。这里锁住的是"遇到哪种对话框、默认怎么点"，
// 因为点错方向的后果是不对称的：
//   · confirm 被 dismiss → 删除/提交永远失败（用户报的就是这个）
//   · beforeunload 被 dismiss → 导航永久卡住，页面再也走不了
//
// 真正的应答动作（CDP Page.handleJavaScriptDialog）在 page_manager 里，
// 由 e2e 验证；这里只测决策本身，因为它必须能在没有 Electron 的环境里被断言。

import { describe, it, expect } from 'vitest';
import policy from '../src/shared/dialog_policy.cjs';

const {
  POLICIES, normalizePolicy, policyFromEnv, decideDialog, allowUnload,
} = policy;

describe('对话策略：归一化与来源', () => {
  it('DP-1: 非法/空值回落到 auto（配置写错不该把页面卡死）', () => {
    for (const v of [undefined, null, '', 'AUTO', 'accept ', 'yes', 42]) {
      const n = normalizePolicy(v);
      expect(POLICIES).toContain(n);
      if (!['accept', 'dismiss', 'manual'].includes(String(v).trim().toLowerCase())) {
        expect(n).toBe('auto');
      }
    }
  });

  it('DP-2: 从环境变量读，大小写与空白不敏感', () => {
    expect(policyFromEnv({ AI_BROWSER_DIALOG_POLICY: ' Dismiss ' })).toBe('dismiss');
    expect(policyFromEnv({})).toBe('auto');
    expect(policyFromEnv(undefined)).toBe('auto');
  });
});

describe('对话策略：auto（默认）', () => {
  it('DP-3: confirm 必须被接受 —— 点它的那个动作就是意图', () => {
    const d = decideDialog({ type: 'confirm', message: '确定删除这条评论？' });
    expect(d.accept).toBe(true);
    expect(d.auto).toBe(true);
  });

  it('DP-4: alert 只可能接受（没有第二个选择）', () => {
    expect(decideDialog({ type: 'alert', message: 'hi' }).accept).toBe(true);
  });

  it('DP-5: beforeunload 必须放行，否则导航/关标签永久卡住', () => {
    const d = decideDialog({ type: 'beforeunload', message: '离开此网站？' });
    expect(d.accept).toBe(true);
  });

  it('DP-6: prompt 用页面默认值提交，并把提交值回报（人按 OK 也是这样）', () => {
    const d = decideDialog({ type: 'prompt', message: '名称？', defaultPrompt: '未命名' });
    expect(d.accept).toBe(true);
    expect(d.promptText).toBe('未命名');
    // 没有默认值时提交空串，而不是 undefined（CDP 要求 promptText 是 string）
    expect(decideDialog({ type: 'prompt' }).promptText).toBe('');
  });

  it('DP-7: 未知类型也接受 —— 卡住页面的代价远大于多点一次 OK', () => {
    expect(decideDialog({ type: 'weird' }).accept).toBe(true);
    expect(decideDialog({}).accept).toBe(true);
  });
});

describe('对话策略：覆盖', () => {
  it('DP-8: dismiss 全部拒绝（诊断用：想看"取消后页面怎么走"）', () => {
    for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
      const d = decideDialog({ type }, { policy: 'dismiss' });
      expect(d.accept).toBe(false);
      expect(d.auto).toBe(true);
    }
  });

  it('DP-9: manual 不替调用方决定（auto=false，交给外面暴露成状态）', () => {
    const d = decideDialog({ type: 'confirm' }, { policy: 'manual' });
    expect(d.auto).toBe(false);
  });
});

describe('beforeunload 的 Electron 侧放行', () => {
  it('DP-10: 只有 A/dismiss/manual 才拦（默认必须放行，否则导航静默失败）', () => {
    expect(allowUnload({ policy: 'auto' })).toBe(true);
    expect(allowUnload({ policy: 'accept' })).toBe(true);
    expect(allowUnload({ policy: 'dismiss' })).toBe(false);
    expect(allowUnload({ policy: 'manual' })).toBe(false);
    expect(allowUnload({})).toBe(true);
  });
});

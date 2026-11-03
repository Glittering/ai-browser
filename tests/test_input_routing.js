// tests/test_input_routing.js — 这一页收不收得到 CDP 受信输入（shared/input_routing.cjs）
//
// 为什么值得单独钉：这道闸写错的两种坏结果是**相反的**，而且都静默：
//   判得太松 → 事件发给 hidden 文档被 Chromium 丢弃，回执照写 success:true（就是本次要修的谎）；
//   判得太紧 → 一个本来能成的动作被"量不到可见性"这类观测故障拦死，产品直接不能用。
// 所以除了正常形状，每条降级路径（量不到、开关关掉、焦点策略不许）都各有断言。
import { describe, it, expect } from 'vitest';
import routing from '../src/shared/input_routing.cjs';

const { trustedInputAction, isReceivable, needsVisibilityFix, shouldRefuse, notReceivableError, focusEnabled } = routing;
const ENV = 'AI_BROWSER_INPUT_FOCUS';

describe('IR 动作名单', () => {
  it('IR-1 走 CDP 受信输入的那九种才要问；只读与控制类不要', () => {
    for (const a of ['click', 'hover', 'drag', 'wheel', 'type', 'setContent', 'clear', 'press', 'paste']) {
      expect(trustedInputAction(a), a + ' 应当要问').toBe(true);
    }
    for (const a of ['get_value', 'reload', 'repaint', 'upload', 'none', 'scroll', '', null, undefined]) {
      expect(trustedInputAction(a), String(a) + ' 不应当要问').toBe(false);
    }
  });
  it('IR-2 upload 特意不在名单里：它走 DOM.setFileInputFiles，hidden 文档照样收', () => {
    expect(routing.TRUSTED_INPUT_ACTIONS.indexOf('upload')).toBe(-1);
  });
});

describe('IR 可见性判据', () => {
  it('IR-3 只有页面自报 visible 才算收得到', () => {
    expect(isReceivable({ visibility: 'visible' })).toBe(true);
    for (const v of ['hidden', 'prerender', 'unloaded', 'VISIBLE']) {
      expect(isReceivable({ visibility: v }), v + ' 不算收得到').toBe(false);
    }
  });
  it('IR-4 量不到 = 放行（观测能力不足不许反过来让动作失败）', () => {
    for (const v of [null, undefined, '', false]) {
      expect(isReceivable({ visibility: v }), JSON.stringify(v) + ' 应当放行').toBe(true);
    }
    expect(isReceivable({})).toBe(true);
  });
  it('IR-5 该补救的形状：输入动作 + 量到收不到', () => {
    expect(needsVisibilityFix({ action: 'click', visibility: 'hidden' })).toBe(true);
    expect(needsVisibilityFix({ action: 'type', visibility: 'prerender' })).toBe(true);
    // 已经收得到 → 一次都不补（常规路径不多做事）
    expect(needsVisibilityFix({ action: 'click', visibility: 'visible' })).toBe(false);
    // 量不到 → 不补，也不拦（见 IR-8）
    expect(needsVisibilityFix({ action: 'click', visibility: null })).toBe(false);
    // 非输入动作 → 不补，哪怕它 hidden
    expect(needsVisibilityFix({ action: 'get_value', visibility: 'hidden' })).toBe(false);
  });
});

describe('IR 开关与诚实的分界', () => {
  it('IR-6 AI_BROWSER_INPUT_FOCUS：0/false/off/no 关，其余（含未设）开', () => {
    expect(focusEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(focusEnabled({ [ENV]: off }), off + ' 应当关掉').toBe(false);
    }
    for (const on of ['', '1', 'on', 'true', 'yes', 'whatever']) {
      expect(focusEnabled({ [ENV]: on }), JSON.stringify(on) + ' 应当照旧开着').toBe(true);
    }
  });
  it('IR-7 enabled:false 只关掉补救', () => {
    expect(needsVisibilityFix({ action: 'click', visibility: 'hidden', enabled: false })).toBe(false);
  });
  it('IR-8 最后一道判断**不看开关**：退路退到如实报错，不是退到假装成功', () => {
    expect(shouldRefuse({ visibility: 'hidden' })).toBe(true);
    expect(shouldRefuse({ visibility: 'visible' })).toBe(false);
    expect(shouldRefuse({ visibility: null })).toBe(false);
    // 开关关掉时依然拦 —— 这一条是整个修复的底线
    const env = { [ENV]: '0' };
    expect(needsVisibilityFix({ action: 'click', visibility: 'hidden', enabled: focusEnabled(env) })).toBe(false);
    expect(shouldRefuse({ visibility: 'hidden' })).toBe(true);
  });
});

describe('IR 失败回执的措辞（agent 唯一能读到的证据）', () => {
  const base = { action: 'click', tabId: 7, visibility: 'hidden' };
  it('IR-9 明说"什么都没发生"并点名 tab —— 不点破就会照着旧经验重试，一次点击变两次', () => {
    const msg = notReceivableError(base);
    expect(msg).toContain('was NOT delivered');
    expect(msg).toContain('tab 7');
    expect(msg).toContain('Nothing was clicked or typed');
    expect(msg).toContain('do not retry blindly');
    expect(msg).toContain('document.visibilityState=hidden');
  });
  it('IR-10 三种原因各说各的：默认 / 开关关掉 / 焦点策略不许', () => {
    expect(notReceivableError(base)).toContain('page-focus emulation did not make it frontmost');
    expect(notReceivableError({ ...base, env: { [ENV]: '0' } })).toContain('AI_BROWSER_INPUT_FOCUS=0');
    expect(notReceivableError({ ...base, focusPolicy: 'never' })).toContain('AI_BROWSER_FOCUS=never');
  });
  it('IR-11 量不到不许写成 hidden（那是把观测故障说成页面状态）', () => {
    expect(notReceivableError({ ...base, visibility: null })).toContain('visibility unknown');
  });
  it('IR-12 出路要一起给：JS 路径，以及把窗口显示出来一次', () => {
    const msg = notReceivableError(base);
    expect(msg).toContain('ui.evaluate');
    expect(msg).toContain('ui.window');
  });
});

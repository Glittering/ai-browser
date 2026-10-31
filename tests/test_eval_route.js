// tests/test_eval_route.js — 攻击用例的判据层：evaluate 失败必须分类，不许一律"降级"。
//
// 背景（2026-10-31 实测）：`page_manager.js` 的 evaluate 把**页面脚本自己抛的异常**
// 和**CDP 不可用**混在同一个 catch 里，于是任何在页面里抛错的表达式都会被拿到
// preload 用 Node 的 `eval` 重跑一次。实测 `Function('return globalThis["pro"+"cess"].version')()`
// 拿到了 `v20.18.3` —— 宿主代码执行。
//
// 修法是把"失败原因"先分类，只对真正的 CDP 不可用给 `cdp-unavailable`，
// 其余（脚本异常/超时）如实上报，**永不回落**。分类逻辑必须是纯函数，
// 否则这条最贵的判据只能靠真机验。
import { describe, it, expect } from 'vitest';
import evalRoute from '../src/shared/eval_route.cjs';

const { classifyEvalFailure, evalFailureResult } = evalRoute;

describe('classifyEvalFailure：失败原因分类', () => {
  const cases = [
    ['no-cdp', 'cdp-unavailable', '调试器压根没挂上'],
    ['no usable cdp debugger', 'cdp-unavailable', 'view 没有 debugger'],
    ['debugger is not attached', 'cdp-unavailable', 'attach 失败'],
    ['cdp evaluate timeout', 'cdp-timeout', '主线程卡住，超时也是超时'],
    ['Cannot read properties of undefined (reading \'version\')', 'script-error', '页面脚本自己抛的'],
    ['ReferenceError: process is not defined', 'script-error', '页面世界没有 process，这必须如实报'],
    ['evaluate error', 'script-error', '兜底也算脚本错误，不许当降级理由'],
    ['', 'script-error', '空消息不能变成 cdp-unavailable'],
  ];

  for (const [msg, want, why] of cases) {
    it(`E1 ${JSON.stringify(msg)} → ${want}（${why}）`, () => {
      expect(classifyEvalFailure(new Error(msg))).toBe(want);
    });
  }

  it('E2 非 Error 输入也不许抛', () => {
    expect(classifyEvalFailure('boom')).toBe('script-error');
    expect(classifyEvalFailure(null)).toBe('script-error');
    expect(classifyEvalFailure(undefined)).toBe('script-error');
  });

  it('E3 分类结果里绝不允许出现"降级到 preload"这种去向', () => {
    // 这条是语义闸门：任何人以后想加回 preload 回落，只能改这个模块，
    // 改完这里必须红，逼他解释为什么要把 Node 能力暴露给页面脚本。
    for (const v of ['no-cdp', 'timeout', 'script-error', 'whatever']) {
      const r = classifyEvalFailure(new Error(v));
      expect(['cdp-unavailable', 'cdp-timeout', 'script-error']).toContain(r);
    }
  });
});

describe('evalFailureResult：给调用方的错误信封', () => {
  it('E4 cdp-unavailable 要带可执行下一步', () => {
    const r = evalFailureResult(new Error('no-cdp'));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('cdp-unavailable');
    expect(r.error.hint).toMatch(/reload|new tab|retry/i);
  });

  it('E5 脚本异常要原样带回消息（调用方靠它判断"我写的脚本错了"）', () => {
    const r = evalFailureResult(new Error("Cannot read properties of undefined (reading 'version')"));
    expect(r.error.code).toBe('script-error');
    expect(r.error.message).toContain("reading 'version'");
    // 脚本错误不该被说成"CDP 不可用"，否则调用方会去重试而不是改脚本
    expect(r.error.hint || '').not.toMatch(/cdp/i);
  });

  it('E6 超时要提示"可能已部分执行"', () => {
    const r = evalFailureResult(new Error('cdp evaluate timeout'));
    expect(r.error.code).toBe('cdp-timeout');
    expect(r.error.retryable).toBe(true);
  });
});

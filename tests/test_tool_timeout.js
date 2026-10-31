// tests/test_tool_timeout.js — MCP 传输超时必须 ≥ 工具自己的预算（此前固定 15s）。
import { describe, it, expect } from 'vitest';
import { timeoutForTool, DEFAULT_CALL_TIMEOUT_MS, SERVER_WAIT_MAX_MS, SERVER_ACT_MAX_MS } from '../src/shared/tool_timeout.js';

describe('timeoutForTool', () => {
  it('T1 未声明预算的工具仍用 15s（一个坏工具不该拖住整轮）', () => {
    for (const t of ['browse_get_tree', 'browse_evaluate', 'browse_screenshot', 'browse_tabs']) {
      expect(timeoutForTool(t, {})).toBe(DEFAULT_CALL_TIMEOUT_MS);
    }
  });

  it('T2 browse_wait 60s → 客户端必须等得比 60s 久（此前 15s 就放弃）', () => {
    const ms = timeoutForTool('browse_wait', { timeout_ms: 60000 });
    expect(ms).toBeGreaterThan(60000);
    expect(ms).toBeLessThanOrEqual(SERVER_WAIT_MAX_MS + 5000);
  });

  it('T3 browse_act 120s → 同上', () => {
    expect(timeoutForTool('browse_act', { timeout_ms: 120000 })).toBeGreaterThan(120000);
  });

  it('T4 超过服务端上限时按上限算（两边不打架）', () => {
    expect(timeoutForTool('browse_wait', { timeout_ms: 999999 })).toBeLessThanOrEqual(SERVER_WAIT_MAX_MS + 5000);
    expect(timeoutForTool('browse_act', { timeout_ms: 999999 })).toBeLessThanOrEqual(SERVER_ACT_MAX_MS + 5000);
  });

  it('T5 不传 timeout_ms 时用工具默认值 + 余量，但不低于 15s', () => {
    expect(timeoutForTool('browse_wait', {})).toBeGreaterThanOrEqual(DEFAULT_CALL_TIMEOUT_MS);
    expect(timeoutForTool('browse_navigate', {})).toBeGreaterThanOrEqual(DEFAULT_CALL_TIMEOUT_MS);
  });

  it('T6 非法 timeout_ms（字符串/负数/NaN）不产生荒谬值', () => {
    for (const v of ['abc', -1, 0, NaN, null, undefined]) {
      const ms = timeoutForTool('browse_act', { timeout_ms: v });
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_CALL_TIMEOUT_MS);
    }
  });
});

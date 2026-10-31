// shared/tool_timeout.js — MCP 每次调用的传输超时必须 ≥ 工具自己的预算。
//
// 事故（2026-10-31 复核）：`mcp_ws.js` 把传输超时固定成 15s（`timeout = 15000`），
// 而 tool schema 对调用方承诺的是：
//   · `browse_act.timeout_ms`  → 1s..300s
//   · `browse_wait.timeout_ms` → 服务端上限 120s
// 于是 `browse_wait {timeout_ms:60000}` 在第 15 秒必然失败，而服务端还在轮询；
// 调用方拿到的是 `WS timeout`，看起来像"服务端卡住"，实际是我们自己的传输层
// 提前投降。这是「声明 ≠ 实现」里最容易让 agent 误判的一类。
//
// 约定：
//   1. 客户端预算 = 工具预算 + 一点余量（服务端还要序列化、跨进程回传）；
//   2. 其余工具仍用 15s —— 「一个坏工具不该拖住整轮」这条不能丢；
//   3. 上限不超过服务端钳制值（act 300s / wait 120s），两边不打架。
//
// 纯函数，表驱动单测见 tests/test_tool_timeout.js。

export const DEFAULT_CALL_TIMEOUT_MS = 15000;

/** 余量：服务端回执 + IPC + JSON 序列化。给 5s 足够，且不改变"谁先到期谁报"。 */
const MARGIN_MS = 5000;

/** 与 ws_server 的钳制保持一致（改了那边要同步改这里，反之亦然）。 */
export const SERVER_ACT_MAX_MS = 300000;
export const SERVER_WAIT_MAX_MS = 120000;

/** 工具自身预算的默认值（与 tool schema 的 default 对齐）。 */
const DEFAULTS = {
  browse_act: 15000,
  browse_wait: 10000,
  browse_navigate: 30000,
};

/**
 * @param {string} tool MCP 工具名（browse_*）
 * @param {object} [args] 调用参数（读 timeout_ms）
 * @returns {number} 传输层该等的毫秒数
 */
export function timeoutForTool(tool, args = {}) {
  const dflt = DEFAULTS[tool];
  if (!dflt) return DEFAULT_CALL_TIMEOUT_MS;

  const raw = Number(args && args.timeout_ms);
  const declared = Number.isFinite(raw) && raw > 0 ? raw : dflt;

  // 服务端会钳制，客户端不要比它更宽，否则"客户端还在等、服务端早已放弃"。
  const cap = tool === 'browse_wait' ? SERVER_WAIT_MAX_MS
    : tool === 'browse_act' ? SERVER_ACT_MAX_MS
      : SERVER_ACT_MAX_MS;
  const capped = Math.min(declared, cap);

  // 至少保留默认值：调用方没传 timeout_ms 时不该比今天更严格。
  return Math.max(DEFAULT_CALL_TIMEOUT_MS, capped + MARGIN_MS);
}

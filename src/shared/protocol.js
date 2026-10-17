// shared/protocol.js — JSON-RPC 2.0 subset for AI Browser
// Used by both main process (WS server) and preload (IPC bridge)

/**
 * Create a JSON-RPC request string
 */
export function createRequest(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/**
 * Create a JSON-RPC success response string
 */
export function createResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/**
 * Create a JSON-RPC error response string
 */
export function createError(id, code, message, data = null) {
  const error = { code, message };
  if (data) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

/**
 * Create a server-pushed event (no id — notification per JSON-RPC)
 */
export function createEvent(event, data) {
  return JSON.stringify({ jsonrpc: '2.0', method: event, params: data });
}

/**
 * Parse a JSON-RPC message string into object
 */
export function parseMessage(msg) {
  try {
    const obj = JSON.parse(msg);
    if (obj.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC version');
    }
    return obj;
  } catch (e) {
    throw new Error(`Failed to parse JSON-RPC message: ${e.message}`);
  }
}

/**
 * Every ui.* method the WebSocket server actually dispatches.
 *
 * This list had drifted badly: it named 7 methods while the server served 28,
 * so anyone reading it would conclude most of the API did not exist. A
 * machine-readable contract that lies is worse than no contract — so
 * `tests/test_protocol.js` now derives the real set from the `case 'ui.x':`
 * labels in `src/main/ws_server.js` and fails if the two diverge. Add a method
 * to the server and this list must follow, or the suite breaks.
 */
export const VALID_METHODS = [
  'ui.get_tree',
  'ui.act',
  'ui.auth_state',
  // 视口截图（P0-1）：操作失败时的第一诊断手段，弥补元素树看不见的
  // 浮层/canvas/遮挡/渲染错位。返回 base64，默认 png。
  'ui.screenshot',
  'ui.navigate',
  'ui.repaint',
  'ui.snapshot',
  'ui.diff',
  'ui.capabilities',
  'ui.evaluate',
  'ui.subscribe',
  'ui.unsubscribe',
  'ui.downloads',
  // 主进程错误日志（只读）。界面弹过"js 崩溃"原生框、或某个动作莫名失败时，
  // 这里是唯一能查到 stack 与"出错那一刻在调什么"的地方 —— 此前这类异常只活在
  // 那个框里，点掉即永久丢失。
  'ui.errors',
  'ui.get_focused',
  'ui.peek',
  'ui.wait',
  'ui.scroll',
  'ui.new_tab',
  'ui.close_tab',
  'ui.list_tabs',
  'ui.set_active_tab',
  // 窗口首次显示的时刻与当时页面状态。白屏类缺陷的根因是"窗口显示了但渲染器
  // 还没画出第一帧"，而这只能从窗口侧观测（WS 端口比 showInitialWindow 早开），
  // 所以留一个查询口；见 e2e/nav_ws.cjs NV-A。
  'ui.window_shown',
  // 服务端进程身份（pid + 启动时刻）。调用方据此核对"我连上的是不是我拉起的
  // 那个实例" —— 连错实例时结果毫无意义但不会报错，是最难查的一类。
  'ui.server_info',
  'ui.canvas_configure',
  'ui.canvas_list',
  'ui.canvas_read',
  'ui.canvas_capture',
  'ui.network_list',
  'ui.network_get',
  'ui.network_clear',
  'ui.network_configure',
  'ui.network_body',
  'ui.quit',
];

/**
 * Standard JSON-RPC error codes
 */
export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  ACTION_FAILED: -32001,
  TARGET_NOT_FOUND: -32002,
  INVALID_ACTION: -32003,
};

// For CJS compatibility in Electron preload
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createRequest,
    createResponse,
    createError,
    createEvent,
    parseMessage,
    VALID_METHODS,
    ERROR_CODES,
  };
}
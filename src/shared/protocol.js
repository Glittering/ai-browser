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
 * Valid method names supported by AI Browser
 */
export const VALID_METHODS = [
  'ui.get_tree',
  'ui.act',
  'ui.subscribe',
  'ui.unsubscribe',
  'ui.navigate',
  'ui.screenshot',
  'ui.get_focused',
  'ui.evaluate',
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
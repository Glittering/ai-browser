// shared/guards.js — Centralized eval-safety guard, single source of truth.
// Used by BOTH the raw WebSocket path (ws_server.js `ui.evaluate`) and the MCP
// path (mcp_server.js `browse_evaluate`). Keeping the limits + blocklist in one
// place prevents one entry being hardened and the other silently left open.

export const EVAL_MAX_LENGTH = 5000;
const NODE_IDENTIFIER_RE = /\bprocess\.\b|\brequire\s*\(|\bchild_process\b|\bglobalThis\.process\b/;

// Returns null when the script is safe to run, or the error message that
// should be returned to the caller. Message text is part of the contract —
// external ws/mcp clients may match on it, so keep it stable.
export function evaluateGuardError(js) {
  if (typeof js !== 'string') return 'script must be a string';
  if (js.length > EVAL_MAX_LENGTH) return `script exceeds ${EVAL_MAX_LENGTH} char limit`;
  if (NODE_IDENTIFIER_RE.test(js)) return 'script contains disallowed Node-specific identifier';
  return null;
}
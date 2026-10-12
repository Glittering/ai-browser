// shared/config.js — Centralized runtime configuration, single source of truth.
// Replaces hardcoded port 9223 / User-Agent / userData dir scattered across
// main/. Each value respects an AI_BROWSER_* env override, with defaults that
// are byte-identical to the previous hardcoded values (no behavior change by
// default).
import path from 'node:path';
import os from 'node:os';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const config = {
  // WebSocket JSON-RPC server + MCP auto-launch probe port
  wsPort: Number(process.env.AI_BROWSER_PORT) || 9223,
  // Electron userData dir — session/cookie persistence survives restart
  userDataDir: process.env.AI_BROWSER_USER_DATA || path.join(os.homedir(), '.ai-browser'),
  // Spoofed UA to mask the automation fingerprint
  userAgent: process.env.AI_BROWSER_UA || DEFAULT_UA,
  // Height of the in-app tab strip below the window title bar
  tabBarHeight: 36,
  // The session every tab's BrowserView uses. **Must stay a single source of
  // truth**: session-level hooks (will-download, permission requests) are
  // installed on `session.fromPartition(viewPartition)`. Hooking
  // `session.defaultSession` instead silently does nothing — the views are not
  // in that session. Measured 2026-10-12: a download was requested by the page,
  // no will-download ever fired, and no file landed.
  viewPartition: process.env.AI_BROWSER_VIEW_PARTITION || 'persist:ai-browser',
};

export function wsUrl(port = config.wsPort) {
  return `ws://localhost:${port}`;
}
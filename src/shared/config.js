// shared/config.js — Centralized runtime configuration, single source of truth.
// Replaces hardcoded port 9223 / User-Agent / userData dir scattered across
// main/. Each value respects an AI_BROWSER_* env override. The User-Agent is
// the one value that is NOT a fixed string any more: it is derived from the
// real platform + engine version so that it cannot contradict the client hints
// (see browser_identity.cjs).
import path from 'node:path';
import os from 'node:os';
import identityUtil from './browser_identity.cjs';

// 身份（UA + UA-CH 元数据）按**真实运行时**算：平台取自 process.platform，
// 版本取自内核的 Chromium 版本。以前这里写死一条 macOS 的 Chrome/130，
// 而 Windows 上 navigator.platform / sec-ch-ua-platform / GPU 后端全是 Windows
// —— 自相矛盾的 UA 正是百度滑块和 Google "此浏览器可能不安全" 的头号证据。
// 完整推导与规矩见 shared/browser_identity.cjs 顶部。
const identity = identityUtil.buildIdentity(
  process.env.AI_BROWSER_UA ? { userAgent: process.env.AI_BROWSER_UA } : {}
);

export const config = {
  // WebSocket JSON-RPC server + MCP auto-launch probe port
  wsPort: Number(process.env.AI_BROWSER_PORT) || 9223,
  // Loopback-only by default: the JSON-RPC port has NO authentication, so
  // binding 0.0.0.0 would let every host on the local network drive the
  // browser and its logged-in sessions. Set AI_BROWSER_WS_HOST=0.0.0.0 only
  // behind a firewall you trust, and know that the protocol itself is open.
  wsBindHost: process.env.AI_BROWSER_WS_HOST || '127.0.0.1',
  // Electron userData dir — session/cookie persistence survives restart
  userDataDir: process.env.AI_BROWSER_USER_DATA || path.join(os.homedir(), '.ai-browser'),
  // 浏览器身份：UA 字符串 + 与之同源的 UA-CH 元数据（brands/platform/...）。
  // 主进程用 CDP 把它们一起交给内核（Network.setUserAgentOverride），
  // 这样 header、navigator.userAgent、navigator.userAgentData 三处永远一致。
  identity,
  userAgent: identity.userAgent,
  // Height of the in-app tab strip below the window title bar.
  // 36px = tab row, 38px = toolbar row (address bar + back/forward/reload/stop).
  tabBarHeight: 36 + 38,
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
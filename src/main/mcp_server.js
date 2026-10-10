// main/mcp_server.js — MCP server for AI Browser
// Exposes browse_web tool so Claude Code/Cursor/Codex can navigate, read, act on web pages
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS } from './mcp_tools.js';
import { evaluateGuardError } from '../shared/guards.js';
import { config, wsUrl } from '../shared/config.js';
import { VERSION } from '../shared/version.js';
import { createWsClient } from './mcp_ws.js';

const WS_URL = wsUrl();
const WS_TIMEOUT = 15000;
const ELECTRON_PORT = config.wsPort;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent WS client — one reused connection with incrementing ids.
// Lazy launch: no Electron is started at boot. The first browse_* call that
// fails to connect triggers `ensureRunning`, which spawns Electron on demand
// (ensureElectronRunning is idempotent). `ensureElectronRunning` is a hoisted
// function declaration, so referencing it here is safe.
const wsClient = createWsClient({
  url: WS_URL,
  timeout: WS_TIMEOUT,
  ensureRunning: ensureElectronRunning,
});

// Probe whether the Electron WS server is already listening on the port.
function checkPort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise(async (resolve) => {
    while (Date.now() - start < timeoutMs) {
      if (await checkPort(port)) return resolve(true);
      await new Promise(r => setTimeout(r, 500));
    }
    resolve(false);
  });
}

// Spawn Electron detached so it survives this MCP subprocess.
async function ensureElectronRunning() {
  if (await checkPort(ELECTRON_PORT)) return true;
  console.error('[mcp] port 9223 not listening — spawning Electron via npm start');
  // Run `npm start` (which runs `electron .`) from project root.
  // AI_BROWSER_LAUNCHED_BY_AGENT：告诉 Electron 它是被 agent 拉起来的，因此
  // 窗口出现时**不要**抢焦点（showInactive）—— 否则 agent 第一次连上来就会把
  // 用户正在做的事打断。人手动 `npm start` 时没有这个变量，窗口正常显示在前台。
  const child = spawn('npm', ['start'], {
    cwd: path.resolve(__dirname, '..', '..'),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AI_BROWSER_LAUNCHED_BY_AGENT: '1' },
  });
  child.unref();
  // Give Electron up to 30s to start the WS server.
  const ok = await waitForPort(ELECTRON_PORT, 30000);
  if (!ok) {
    console.error('[mcp] Electron did not come up within 30s');
    return false;
  }
  return true;
}

const server = new Server(
  { name: 'ai-browser-mcp', version: VERSION },
  { capabilities: { tools: {} } }
);

// Tool definitions — curated minimal MCP_TOOLS (see mcp_tools.js). Kept small
// to reduce per-message token cost; low-frequency/flow capabilities live in
// skills/ (read-webpage, web-network-monitor).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: MCP_TOOLS
}));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'browse_navigate': {
      const result = await wsClient.call('ui.navigate', { url: args.url, tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_get_tree': {
      const result = await wsClient.call('ui.get_tree', {
        focusedOnly: args.focused_only || false,
        ax: args.ax === true ? true : undefined,
        subset: args.subset || undefined,
        mode: args.mode || undefined,
        tab: args.tab
      });
      // Don't truncate mid-JSON — a sliced JSON string is unparseable and
      // worse than no data. Return the full tree; MCP transport handles
      // large messages fine.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
    }

    case 'browse_act': {
      const result = await wsClient.call('ui.act', {
        action: args.action,
        target: args.target,
        params: {
          text: args.text,
          value: args.value,
          url: args.url,
          keep_tab: args.keep_tab,
          file: args.file,
          offset: args.offset,
          limit: args.limit,
          // drag：终点与端点锚点。to_x/to_y 是绝对视口坐标（用于拖到空白处，
          // 例如平移画布）；to_target 是落到另一个元素上（例如连线）。
          // 这些名字与 raw WS 层完全一致 —— 归一由 page_manager._cdpDrag 单点负责，
          // 这里不再做第二套映射（两套名字 = 迟早有一层不认识）。
          to_target: args.to_target,
          dx: args.dx,
          dy: args.dy,
          to_x: args.to_x,
          to_y: args.to_y,
          from_anchor: args.from_anchor,
          from: (args.from_x !== undefined && args.from_y !== undefined)
            ? { x: args.from_x, y: args.from_y }
            : undefined,
          to_anchor: args.to_anchor,
          hold: args.hold,
          button: args.button,
          // press：单个键或按键序列
          key: args.key,
          keys: args.keys,
          dx: args.delta_x,
          dy: args.delta_y,
        },
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_evaluate': {
      const js = String(args.js || '');
      // Defense-in-depth via the shared single-source guard: contextIsolation
      // already blocks Node access, but reject obvious Node exfil patterns + cap
      // length before forwarding. Same contract as the raw WS ui.evaluate path.
      const guardErr = evaluateGuardError(js);
      if (guardErr) {
        return { content: [{ type: 'text', text: `Error: ${guardErr}` }] };
      }
      const result = await wsClient.call('ui.evaluate', { js, tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_scroll': {
      const result = await wsClient.call('ui.scroll', {
        direction: args.direction || 'down',
        amount: args.amount,
        target: args.target,
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_wait': {
      const result = await wsClient.call('ui.wait', {
        condition: args.condition,
        target: args.target,
        text: args.text,
        timeout_ms: args.timeout_ms,
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_list_tabs': {
      const result = await wsClient.call('ui.list_tabs', {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_new_tab': {
      const result = await wsClient.call('ui.new_tab', { url: args.url || null });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_close_tab': {
      const result = await wsClient.call('ui.close_tab', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_set_active_tab': {
      const result = await wsClient.call('ui.set_active_tab', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_network': {
      const result = args.operation === 'list' || args.operation === 'configure' || args.operation === 'clear'
        ? await wsClient.call('ui.network_' + args.operation, {
            tab: args.tab,
            method: args.method,
            url_contains: args.url_contains,
            status: (args.status_min !== undefined || args.status_max !== undefined)
              ? { min: args.status_min, max: args.status_max } : undefined,
            resource_type: args.resource_type,
            state: args.state,
            started_after: args.started_after,
            started_before: args.started_before,
            limit: args.limit,
            before_seq: args.before_seq,
            enabled: args.enabled,
            capture_bodies: args.capture_bodies,
          })
        : await wsClient.call('ui.network_get', {
            tab: args.tab,
            network_id: args.network_id,
            include_request_headers: args.include_request_headers,
            include_request_body: args.include_request_body,
            include_response_headers: args.include_response_headers,
            include_response_body: args.include_response_body,
            include_sensitive_headers: args.include_sensitive_headers,
            request_body_offset: args.request_body_offset,
            response_body_offset: args.response_body_offset,
            body_limit: args.body_limit,
          });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_canvas': {
      const op = args.operation;
      if (op === 'list') {
        const result = await wsClient.call('ui.canvas_list', { tab: args.tab });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'read') {
        const result = await wsClient.call('ui.canvas_read', {
          tab: args.tab,
          canvas_id: args.canvas_id,
          view: args.view,
          since_seq: args.since_seq,
          limit: args.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'configure') {
        const result = await wsClient.call('ui.canvas_configure', {
          tab: args.tab, mode: args.mode, clear: args.clear,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'capture') {
        // 视觉兜底：会消耗调用方的视觉 token，因此只在语义层读不懂时用。
        const result = await wsClient.call('ui.canvas_capture', { tab: args.tab, canvas_id: args.canvas_id });
        const data = result && result.data_base64;
        if (!data) {
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...result, data_base64: undefined }) },
            { type: 'image', data, mimeType: result.mime_type || 'image/png' },
          ],
        };
      }
      throw new Error('browse_canvas: unknown operation ' + String(op));
    }

    case 'browse_quit': {
      // Fire and forget — the WS server closes before we'd get the response.
      try { await wsClient.call('ui.quit', {}); } catch (e) {}
      return { content: [{ type: 'text', text: 'AI Browser shutting down' }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  // Lazy loading: do NOT spawn Electron here. It used to start at MCP-server
  // boot via ensureElectronRunning(), which made every MCP client launch pull up
  // ai-browser even before any browse_* tool was called. Now Electron is brought
  // up on first use, inside wsClient's connection-retry loop (via ensureRunning).
  const listening = await checkPort(ELECTRON_PORT);
  if (!listening) console.error('[mcp] ai-browser not running — will auto-start on first browse_* call');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is for logging only; stdout is the MCP protocol
  console.error('AI Browser MCP server started (stdio, lazy Electron)');
}

main().catch((e) => {
  console.error('MCP server fatal:', e.message);
  process.exit(1);
});
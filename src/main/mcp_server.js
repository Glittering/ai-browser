// main/mcp_server.js — MCP server for AI Browser
// Exposes browse_web tool so Claude Code/Cursor/Codex can navigate, read, act on web pages
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared Electron-binary resolver. npm >= 11 blocks dependency install scripts
// by default (so plain `npx` leaves electron without its engine); the resolver
// self-heals by running electron's bundled installer on first launch.
import electronResolve from '../../scripts/electron_resolve.cjs';
import { MCP_TOOLS } from './mcp_tools.js';
import { evaluateGuardError } from '../shared/guards.js';
// 截图体积上限（与 WS 侧共用同一把尺）：超过就不把图塞进上下文。
import screenshotOpts from '../shared/screenshot_opts.cjs';
import { config, wsUrl } from '../shared/config.js';
import { VERSION } from '../shared/version.js';
import { createWsClient } from './mcp_ws.js';

const WS_URL = wsUrl();
const WS_TIMEOUT = 15000;
const ELECTRON_PORT = config.wsPort;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App/package root — identical layout in a git checkout and inside
// node_modules/@glittering0717/ai-browser: src/main/ → up two levels.
const APP_ROOT = path.resolve(__dirname, '..', '..');
const { resolveElectronBinary } = electronResolve;

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
//
// 两个坑都是实测踩出来的（2026-10-12）：
//
// ① `ELECTRON_RUN_AS_NODE` 必须删掉。本机 shell 就带着它，此时 `electron .` 会
//    被当作普通 Node 运行，拿 Node 加载 ESM 入口直接崩，端口永不监听，而报错是
//    一串 Node 的 ESM 栈 —— 完全不提 Electron。e2e 脚本都删了它，只有这里漏了。
//    详见 scripts/start.cjs 顶部。
//
// ② 启动失败必须**说出来**。此前这里 return false，而 mcp_ws.js 又把它 catch 掉
//    吞了，于是 agent 先重试 120 秒，最后只拿到 "WS reconnect timeout:
//    connection refused" —— 没有任何线索表明浏览器根本没起来，更别说为什么。
//    现在抛一个带原因的 Error，由 mcp_ws 并进最终错误信息。
async function ensureElectronRunning() {
  if (await checkPort(ELECTRON_PORT)) return true;
  console.error('[mcp] port 9223 not listening — spawning the ai-browser Electron app');
  // Spawn the electron binary directly (resolved from this package's
  // dependencies), pointed at the app root. Do NOT shell out to `npm start`:
  // npm is not guaranteed on PATH for MCP clients, and on Windows the
  // executable is npm.cmd — direct spawn avoids both classes of failure.
  // AI_BROWSER_LAUNCHED_BY_AGENT：告诉 Electron 它是被 agent 拉起来的，因此
  // 窗口出现时**不要**抢焦点（showInactive）—— 否则 agent 第一次连上来就会把
  // 用户正在做的事打断。人手动 `ai-browser` / `npm start` 时没有这个变量。
  const childEnv = { ...process.env, AI_BROWSER_LAUNCHED_BY_AGENT: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = spawn(resolveElectronBinary(), [APP_ROOT], {
      cwd: APP_ROOT,
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    });
  } catch (e) {
    throw new Error(`could not start the browser: ${e.message}`);
  }
  child.unref();
  // 子进程自己提前退出（例如上面那个 Node ESM 崩溃）时，等满 30 秒是纯浪费 ——
  // 而且会掩盖真实原因。这里挂一个 exit 监听，把退出码留给下面的诊断。
  let earlyExit = null;
  child.on('exit', (code, signal) => { earlyExit = { code, signal }; });
  // Give Electron up to 30s to start the WS server.
  const ok = await waitForPort(ELECTRON_PORT, 30000);
  if (!ok) {
    const why = earlyExit
      ? `Electron exited early (code=${earlyExit.code}, signal=${earlyExit.signal}) — a common cause is ELECTRON_RUN_AS_NODE being set in the environment, or the electron binary being missing (check node_modules/electron/dist)`
      : 'Electron did not come up within 30s (slow first-run binary download? try ELECTRON_MIRROR for users behind a slow network)';
    console.error('[mcp] ' + why);
    throw new Error(`could not start the browser: ${why}`);
  }
  return true;
}

const server = new Server(
  { name: 'ai-browser-mcp', version: VERSION },
  // resources/prompts 声明为空能力：协议要求即使一个都没有也要正常应答这两个
  // list 请求（部分目录扫描器，如 Smithery，会把 "Method not found" 记为健康
  // 检查失败）。能力清单保留声明，客户端据此知道服务端支持该方法族。
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// Tool definitions — curated minimal MCP_TOOLS (see mcp_tools.js). Kept small
// to reduce per-message token cost; low-frequency/flow capabilities live in
// skills/ (read-webpage, web-network-monitor).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: MCP_TOOLS
}));

// 无资源 / 无提示词模板 —— 返回空集合而不是 protocol error。
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'browse_navigate': {
      const result = await wsClient.call('ui.navigate', {
        url: args.url,
        tab: args.tab,
        wait_until: args.wait_until || undefined,
      });
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
          // paste：富文本 HTML。schema 里声明了这个字段，之前这里漏了转发 ——
          // MCP 调用方传 html 会被静默丢弃，回执 "paste called with neither
          // html nor text"。B站图文只能发纯文本版就是这个原因。
          html: args.html,
          value: args.value,
          url: args.url,
          keep_tab: args.keep_tab,
          file: args.file,
          offset: args.offset,
          limit: args.limit,
          timeout_ms: args.timeout_ms,
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
        // 工具结果形式的错误（isError:true），而不是 -32603：目录审核与客户端
        // 都会实际调用一次工具，不透明的 internal error 会被当成"坏了"。
        return { content: [{ type: 'text', text: `Error: ${guardErr}` }], isError: true };
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

    case 'browse_auth_state': {
      const result = await wsClient.call('ui.auth_state', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_screenshot': {
      // 图片走 MCP 原生 image content（客户端能直接渲染），摘要走 text。
      // 超大图（默认 >512KB base64）只回摘要：塞进上下文会挤爆调用方的
      // token 预算，而"这张图太大"本身就该让它换 jpeg/换 clip。
      const result = await wsClient.call('ui.screenshot', args);
      if (result.ok && typeof result.data === 'string' && (result.bytes || 0) <= screenshotOpts.MAX_DATA_URL_CHARS) {
        const meta = { ...result };
        delete meta.data;
        return {
          content: [
            { type: 'image', data: result.data, mimeType: result.mime },
            { type: 'text', text: JSON.stringify(meta) },
          ],
        };
      }
      const slim = result.ok ? { ...result, data: undefined, truncated: true } : result;
      return { content: [{ type: 'text', text: JSON.stringify(slim) }] };
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

    case 'browse_diff': {
      const op = args.operation;
      if (op === 'snapshot') {
        const result = await wsClient.call('ui.snapshot', {
          tab: args.tab, js: args.js, label: args.label,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'diff') {
        const result = await wsClient.call('ui.diff', {
          tab: args.tab, snapshot: args.snapshot, js: args.js,
          rearm: args.rearm, forget: args.forget,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      throw new Error('browse_diff: unknown operation ' + String(op));
    }

    case 'browse_capabilities': {
      const result = await wsClient.call('ui.capabilities', {
        tab: args.tab, include_network: args.include_network, network_limit: args.network_limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_repaint': {
      // "The window shows a stale page" has no observable state to detect (the
      // DOM tree and evaluate already report the NEW page while the screen shows
      // the OLD one), so the agent's only handle on it is an explicit request.
      // Until now this was reachable over the raw WS only, which left MCP-only
      // agents — the common case — with no fallback for the exact symptom this
      // was built for.
      const result = await wsClient.call('ui.repaint', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_downloads': {
      const result = await wsClient.call('ui.downloads', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_errors': {
      // 只读：读主进程错误日志（本次进程的内存记录 + 落盘文件路径）。
      // 用途是"事后自查"——界面里弹过框、或者某个动作莫名其妙失败时，
      // 这里能看到 stack 与出错那一刻最近的调用上下文。
      const result = await wsClient.call('ui.errors', { limit: args.limit, kind: args.kind });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
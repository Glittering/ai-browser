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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 启动逻辑与 CLI 共用一份（scripts/ensure_running.cjs）。曾经这里有一份私有实现，
// 结果 MCP 能自动拉起浏览器、CLI 不能 —— 同一件事两个行为。
import ensureMod from '../../scripts/ensure_running.cjs';
import { MCP_TOOLS } from './mcp_tools.js';
import { actParams, networkParams } from './mcp_args.js';
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

const { ensureRunning, checkPort } = ensureMod;

// Persistent WS client — one reused connection with incrementing ids.
// Lazy launch: no Electron is started at boot. The first browse_* call that
// fails to connect triggers `ensureRunning`, which starts Electron on demand.
//
// 2026-10-20: the launch logic moved to scripts/ensure_running.cjs so the CLI
// (`ai-browser call` / `ai-browser ensure`) shares ONE implementation with this
// server. Duplicating it here is what made "install and use" a two-step dance
// for CLI callers: MCP auto-started the browser, the CLI did not.
const wsClient = createWsClient({
  url: WS_URL,
  timeout: WS_TIMEOUT,
  ensureRunning: () => ensureBrowser(),
  // 自报家门：告诉浏览器"我是一个 agent"，于是它会给我一块自己的标签组
  // （默认目标永远是组里我自己的页，绝不开在人眼前那一页上）。
  // 名字只用于标签栏上那个小圆点旁边的文字，猜不出来就留空让服务端编号。
  hello: { label: agentLabel(), auto_workspace: true },
});

/** 从环境推断是哪个客户端在驱动我。猜不出来就返回空串（服务端会编 "Agent N"）。 */
function agentLabel() {
  const env = process.env;
  const explicit = String(env.AI_BROWSER_AGENT_NAME || '').trim();
  if (explicit) return explicit.slice(0, 24);
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'Claude';
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return 'Cursor';
  if (env.TRAE_ENV || env.TRAE_AGENT) return 'Trae';
  if (env.CODEX_HOME || env.OPENAI_CODEX) return 'Codex';
  if (env.CLINE_ACTIVE) return 'Cline';
  return '';
}

/** 拉起浏览器（幂等）。失败时抛带原因的 Error，由 mcp_ws 并进最终错误信息。 */
async function ensureBrowser() {
  const info = await ensureRunning({
    port: ELECTRON_PORT,
    log: (m) => console.error('[mcp] ' + m),
  });
  return info.running;
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
      // 参数映射收在 mcp_args.js 单点完成：schema 对 agent 暴露分组，
      // page_manager 只认扁平。旧扁平参数继续被接受（向后兼容）。
      const result = await wsClient.call('ui.act', {
        action: args.action,
        target: args.target,
        params: actParams(args),
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

    case 'browse_tabs': {
      // 4 个单动词工具（list/new/close/set_active）合并为一个。
      // 理由：它们操作同一个实体（标签页），每个只承载一个动词，是工具数量
      // 膨胀里最没有道理的一种。合并后参数只有 op/tab/url 三个。
      const op = args.op;
      if (op === 'list') {
        const result = await wsClient.call('ui.list_tabs', {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'new') {
        // show 不传 = 后台新建：agent 开页面不该把人正在看的那一页顶掉。
        // 这是"多 agent / 无头式运行"的默认语义，见 shared/tab_route.cjs。
        const params = { url: args.url || null };
        if (args.show !== undefined) params.show = args.show === true;
        try {
          const result = await wsClient.call('ui.new_tab', params);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          // group-full 这类执行期错误必须回到 agent 为止，以 isError 工具结果
          // 呈现（tool-result-form），而不是逃成 JSON-RPC protocol error。
          return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
      }
      if (op === 'close') {
        const result = await wsClient.call('ui.close_tab', { tab: args.tab });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'switch') {
        // 只换目标、不抢视野：agent 说"切到这个标签页"通常只是想说
        // "接下来都在这页上干活",不该把人的窗口内容换掉。但 agent 自己主动
        // 要看（比如交代"请在浏览器里看这个"）时,可以传 show:true —— 这正是
        // tasks.md 里 "switch tab show:true" 的用法:同时把这一页顶到用户眼前
        // 并设为默认目标。
        const result = await wsClient.call('ui.set_active_tab', {
          tab: args.tab,
          show: args.show === true,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (op === 'window') {
        const params = args.visible === undefined ? {} : { visible: args.visible === true };
        const result = await wsClient.call('ui.window', params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: `Error: unknown op "${op}" — use list / new / close / switch / window` }],
        isError: true
      };
    }

    case 'browse_network': {
      const p = networkParams(args);
      const isListLike =
        args.operation === 'list' || args.operation === 'configure' || args.operation === 'clear';
      const result = isListLike
        ? await wsClient.call('ui.network_' + args.operation, {
            tab: p.tab,
            method: p.method,
            url_contains: p.url_contains,
            status: p.status,
            resource_type: p.resource_type,
            state: p.state,
            started_after: p.started_after,
            started_before: p.started_before,
            limit: p.limit,
            before_seq: p.before_seq,
            enabled: p.enabled,
            capture_bodies: p.capture_bodies
          })
        : await wsClient.call('ui.network_get', {
            tab: p.tab,
            network_id: p.network_id,
            include_request_headers: p.include_request_headers,
            include_request_body: p.include_request_body,
            include_response_headers: p.include_response_headers,
            include_response_body: p.include_response_body,
            include_sensitive_headers: p.include_sensitive_headers,
            request_body_offset: p.request_body_offset,
            response_body_offset: p.response_body_offset,
            body_limit: p.body_limit
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
        // deep: 「实例在闭包里」那一类。作为参数而不是独立工具 —— capability
        // 探测本来就是一件事，拆成两个工具等于让 agent 多付一次往返，
        // 还会让它在「no app object on window」之后不知道该不该再问一句。
        deep: args.deep,
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
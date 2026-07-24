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

const WS_URL = 'ws://localhost:9223';
const WS_TIMEOUT = 15000;
const ELECTRON_PORT = 9223;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

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
  const child = spawn('npm', ['start'], {
    cwd: path.resolve(__dirname, '..', '..'),
    detached: true,
    stdio: 'ignore',
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

function wsCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let resolved = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });

    ws.on('message', (data) => {
      if (resolved) return;
      resolved = true;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) reject(new Error(msg.error.message || 'RPC error'));
        else resolve(msg.result);
      } catch (e) {
        reject(e);
      }
      ws.close();
    });

    ws.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('WS timeout')); } }, WS_TIMEOUT);
  });
}

const server = new Server(
  { name: 'ai-browser-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'browse_navigate',
      description: 'Navigate the AI Browser to a URL. Opens the page in the embedded Chromium browser.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          tab: { type: 'integer', description: 'Optional tab id to navigate in (defaults to active tab)' }
        },
        required: ['url']
      }
    },
    {
      name: 'browse_get_tree',
      description: 'Get the semantic UI tree of the current page. Returns structured elements with roles, labels, actions, and bounds — Agent can read the page without screenshots or OCR.',
      inputSchema: {
        type: 'object',
        properties: {
          focused_only: { type: 'boolean', description: 'Return only the currently focused element subtree', default: false },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        }
      }
    },
    {
      name: 'browse_act',
      description: 'Perform an action on a page element: click, type, clear, select, focus, hover, scroll_to.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'clear', 'focus', 'hover', 'scroll_to'], description: 'Action to perform' },
          target: { type: 'string', description: 'Element id from the semantic tree (data-ai-id)' },
          text: { type: 'string', description: 'Text to type (only for type action)' },
          value: { type: 'string', description: 'Value for select action' },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        },
        required: ['action', 'target']
      }
    },
    {
      name: 'browse_evaluate',
      description: 'Execute a JavaScript expression in the active page context and return the result. Runs in the renderer main world (contextIsolation: true, no Node access). Rejects scripts longer than 5000 chars or containing Node-specific identifiers (process/require/child_process) as defense-in-depth.',
      inputSchema: {
        type: 'object',
        properties: {
          js: { type: 'string', description: 'JavaScript expression to evaluate in the page context. Must be an expression, not statements.' },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        },
        required: ['js']
      }
    },
    {
      name: 'browse_read_article',
      description: 'Extract the main article content from the current page. Returns title and paragraph text. Handles common news site selectors automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        }
      }
    },
    {
      name: 'browse_scroll',
      description: 'Scroll the page or a specific element into view. Direction defaults to "down".',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
          amount: { type: 'integer', default: 500, description: 'Pixels to scroll (ignored if target is set)' },
          target: { type: 'string', description: 'Optional data-ai-id to scroll into view' },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        }
      }
    },
    {
      name: 'browse_wait',
      description: 'Poll the page until a condition is met or timeout. Conditions: button_enabled, modal_appeared, text_contains, url_contains.',
      inputSchema: {
        type: 'object',
        properties: {
          condition: { type: 'string', enum: ['button_enabled', 'modal_appeared', 'text_contains', 'url_contains'] },
          target: { type: 'string', description: 'Button label (button_enabled)' },
          text: { type: 'string', description: 'Text or URL fragment to look for (text_contains / url_contains)' },
          timeout_ms: { type: 'integer', default: 10000 },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        },
        required: ['condition']
      }
    },
    {
      name: 'browse_list_tabs',
      description: 'List all open browser tabs with their id, url, title, and active state.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'browse_new_tab',
      description: 'Open a new tab. Optionally navigate it to a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL to navigate the new tab to' }
        }
      }
    },
    {
      name: 'browse_close_tab',
      description: 'Close a tab by id.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'integer', description: 'Tab id to close' }
        },
        required: ['tab']
      }
    },
    {
      name: 'browse_set_active_tab',
      description: 'Switch the active tab.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'integer', description: 'Tab id to activate' }
        },
        required: ['tab']
      }
    },
    {
      name: 'browse_network_body',
      description: 'Retrieve the response body of a previously-completed network request whose URL contains the given pattern. Requires network subscription to be active (Agent subscribes via browse_subscribe first, or this returns null).',
      inputSchema: {
        type: 'object',
        properties: {
          url_pattern: { type: 'string', description: 'Substring to match in the request URL' },
          tab: { type: 'integer', description: 'Optional tab id (defaults to active tab)' }
        },
        required: ['url_pattern']
      }
    },
    {
      name: 'browse_subscribe',
      description: 'Subscribe to page events (dom_change, network_response, captcha_appeared, message_appeared, js_error, state_changed). Events arrive as MCP notifications.',
      inputSchema: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            items: { type: 'string' },
            description: 'Event names to subscribe to. Use "*" for all.'
          }
        },
        required: ['events']
      }
    },
    {
      name: 'browse_quit',
      description: 'Gracefully shut down the AI Browser Electron process. Call this when the agent is done with the browser to release resources. After this call, subsequent browse_* calls will fail until the browser is restarted (e.g. by calling browse_navigate, which auto-launches Electron).',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'browse_navigate': {
      const result = await wsCall('ui.navigate', { url: args.url, tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_get_tree': {
      const result = await wsCall('ui.get_tree', { focusedOnly: args.focused_only || false, tab: args.tab });
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
      const result = await wsCall('ui.act', {
        action: args.action,
        target: args.target,
        params: { text: args.text, value: args.value },
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_evaluate': {
      const js = String(args.js || '');
      // Defense-in-depth: contextIsolation already blocks Node access, but
      // reject obvious Node exfil patterns and cap length.
      if (js.length > 5000) {
        return { content: [{ type: 'text', text: 'Error: script exceeds 5000 char limit' }] };
      }
      if (/\bprocess\.\b|\brequire\s*\(|\bchild_process\b|\bglobalThis\.process\b/.test(js)) {
        return { content: [{ type: 'text', text: 'Error: script contains disallowed Node-specific identifier' }] };
      }
      const result = await wsCall('ui.evaluate', { js, tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_read_article': {
      const result = await wsCall('ui.evaluate', { js: `
        (function(){
          var h1 = document.querySelector('h1');
          var title = h1 ? h1.textContent.trim() : document.title;
          var article = document.querySelector('.article-body, .article-content, .main-content, .rich_media_content, article, .txt-article, .Body');
          var ps = article ? article.querySelectorAll('p') : document.querySelectorAll('p');
          var paras = [];
          for (var i=0; i<Math.min(ps.length, 30); i++) {
            var t = ps[i].textContent.trim();
            if (t.length > 25) paras.push(t.slice(0,400));
          }
          return JSON.stringify({title:title, pCount:paras.length, paras:paras.slice(0,15)});
        })()
      `, tab: args.tab });
      const article = JSON.parse(result?.value || '{}');
      const text = ((article.title ? article.title + '\n\n' : '') + (article.paras || []).join('\n\n')).slice(0, 6000);
      return { content: [{ type: 'text', text }] };
    }

    case 'browse_scroll': {
      const result = await wsCall('ui.scroll', {
        direction: args.direction || 'down',
        amount: args.amount,
        target: args.target,
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_wait': {
      const result = await wsCall('ui.wait', {
        condition: args.condition,
        target: args.target,
        text: args.text,
        timeout_ms: args.timeout_ms,
        tab: args.tab
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_list_tabs': {
      const result = await wsCall('ui.list_tabs', {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_new_tab': {
      const result = await wsCall('ui.new_tab', { url: args.url || null });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_close_tab': {
      const result = await wsCall('ui.close_tab', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_set_active_tab': {
      const result = await wsCall('ui.set_active_tab', { tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_network_body': {
      const result = await wsCall('ui.network_body', { url_pattern: args.url_pattern, tab: args.tab });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_subscribe': {
      const result = await wsCall('ui.subscribe', { events: args.events || [] });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_quit': {
      // Fire and forget — the WS server closes before we'd get the response.
      try { await wsCall('ui.quit', {}); } catch (e) {}
      return { content: [{ type: 'text', text: 'AI Browser shutting down' }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start via stdio (Claude Code/Cursor/Codex launch this as a subprocess)
async function main() {
  // Auto-launch Electron if the WS server isn't already running.
  const ok = await ensureElectronRunning();
  if (!ok) {
    console.error('[mcp] ERROR: could not connect to AI Browser WS server on port 9223');
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is for logging only; stdout is the MCP protocol
  console.error('AI Browser MCP server started (stdio)');
}

main().catch((e) => {
  console.error('MCP server fatal:', e.message);
  process.exit(1);
});
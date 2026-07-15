// main/mcp_server.js — MCP server for AI Browser
// Exposes browse_web tool so Claude Code/Cursor/Codex can navigate, read, act on web pages
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const WS_URL = 'ws://localhost:9223';
const WS_TIMEOUT = 15000;

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

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
          url: { type: 'string', description: 'URL to navigate to' }
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
          focused_only: { type: 'boolean', description: 'Return only the currently focused element subtree', default: false }
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
          value: { type: 'string', description: 'Value for select action' }
        },
        required: ['action', 'target']
      }
    },
    {
      name: 'browse_evaluate',
      description: 'Execute JavaScript in the page context and return the result. Use for reading page content, extracting data, or probing page state.',
      inputSchema: {
        type: 'object',
        properties: {
          js: { type: 'string', description: 'JavaScript expression to evaluate in the page context' }
        },
        required: ['js']
      }
    },
    {
      name: 'browse_read_article',
      description: 'Extract the main article content from the current page. Returns title and paragraph text. Handles common news site selectors automatically.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'browse_navigate': {
      const result = await wsCall('ui.navigate', { url: args.url });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_get_tree': {
      const result = await wsCall('ui.get_tree', { focusedOnly: args.focused_only || false });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2).slice(0, 8000) // limit output size
        }]
      };
    }

    case 'browse_act': {
      const result = await wsCall('ui.act', {
        action: args.action,
        target: args.target,
        params: { text: args.text, value: args.value }
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'browse_evaluate': {
      const result = await wsCall('ui.evaluate', { js: args.js });
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
      `});
      const article = JSON.parse(result?.value || '{}');
      const text = ((article.title ? article.title + '\n\n' : '') + (article.paras || []).join('\n\n')).slice(0, 6000);
      return { content: [{ type: 'text', text }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start via stdio (Claude Code/Cursor/Codex launch this as a subprocess)
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is for logging only; stdout is the MCP protocol
  console.error('AI Browser MCP server started (stdio)');
}

main().catch((e) => {
  console.error('MCP server fatal:', e.message);
  process.exit(1);
});
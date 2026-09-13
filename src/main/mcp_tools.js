// main/mcp_tools.js — the curated MCP tool list.
// Exported separately so tests can assert on it without triggering the
// mcp_server's main() side effects (spawning Electron / opening stdio).
// Tool count and descriptions are kept minimal to reduce per-message token
// cost in MCP clients that inject the full tool list on every turn.
export const MCP_TOOLS = [
  {
    name: 'browse_navigate',
    description: 'Navigate the active/focused tab to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['url']
    }
  },
  {
    name: 'browse_get_tree',
    description: 'Return the page semantic UI tree (roles, labels, actions, bounds).',
    inputSchema: {
      type: 'object',
      properties: {
        focused_only: { type: 'boolean', description: 'Return only the focused element subtree.', default: false },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_act',
    description: 'Perform an action on an element by its data-ai-id: click, type, clear, select, focus, hover, scroll_to.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'clear', 'focus', 'hover', 'scroll_to'], description: 'Action.' },
        target: { type: 'string', description: 'Element data-ai-id from the semantic tree.' },
        text: { type: 'string', description: 'Text to type (type only).' },
        value: { type: 'string', description: 'Value for select.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['action', 'target']
    }
  },
  {
    name: 'browse_evaluate',
    description: 'Run a JS expression in the page context and return its value.',
    inputSchema: {
      type: 'object',
      properties: {
        js: { type: 'string', description: 'Page-context JS expression (not statements). Max 5000 chars.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['js']
    }
  },
  {
    name: 'browse_scroll',
    description: 'Scroll the page or an element into view.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
        amount: { type: 'integer', default: 500, description: 'Pixels (ignored if target set).' },
        target: { type: 'string', description: 'data-ai-id to scroll into view.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_wait',
    description: 'Poll the page until a condition holds or timeout. Conditions: button_enabled, modal_appeared, text_contains, url_contains.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', enum: ['button_enabled', 'modal_appeared', 'text_contains', 'url_contains'] },
        target: { type: 'string', description: 'Button label (button_enabled).' },
        text: { type: 'string', description: 'Text/URL fragment (text_contains / url_contains).' },
        timeout_ms: { type: 'integer', default: 10000 },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['condition']
    }
  },
  {
    name: 'browse_list_tabs',
    description: 'List open tabs (id, url, title, active).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browse_new_tab',
    description: 'Open a new tab, optionally at a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL.' }
      }
    }
  },
  {
    name: 'browse_close_tab',
    description: 'Close a tab by id.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab id.' }
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
        tab: { type: 'integer', description: 'Tab id.' }
      },
      required: ['tab']
    }
  },
  {
    name: 'browse_network_body',
    description: 'Return the response body of a completed request whose URL contains the pattern (requires prior subscription).',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Substring to match in the request URL.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['url_pattern']
    }
  },
  {
    name: 'browse_subscribe',
    description: 'Subscribe to page events (dom_change, network_response, captcha_appeared, message_appeared, js_error, state_changed). "*" for all.',
    inputSchema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event names to subscribe to.'
        }
      },
      required: ['events']
    }
  },
  {
    name: 'browse_quit',
    description: 'Gracefully shut down the AI Browser (releases resources).',
    inputSchema: { type: 'object', properties: {} }
  }
];
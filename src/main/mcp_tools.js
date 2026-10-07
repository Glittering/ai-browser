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
    description: 'Return the page semantic UI tree (roles, labels, actions, bounds, urls).',
    inputSchema: {
      type: 'object',
      properties: {
        focused_only: { type: 'boolean', description: 'Return only the focused element subtree.', default: false },
        ax: { type: 'boolean', description: 'Use the AX read layer (links carry url).', default: false },
        subset: { type: 'string', enum: ['interactive', 'full'], description: 'Prune layout-only branches (token saver).' },
        mode: { type: 'string', enum: ['diff', 'full'], description: 'Return only new/hidden interactive nodes since last read.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_act',
    description: 'Perform an action on an element by its data-ai-id: click, type, clear, select, focus, hover, scroll_to, upload.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'clear', 'focus', 'hover', 'scroll_to', 'upload'], description: 'Action.' },
        target: { type: 'string', description: 'Element data-ai-id from the semantic tree.' },
        text: { type: 'string', description: 'Text to type (type only).' },
        value: { type: 'string', description: 'Value for select.' },
        url: { type: 'string', description: 'For click: click the link whose href matches this URL instead of guessing the target label.' },
        keep_tab: { type: 'boolean', description: 'For click: keep the current tab active instead of auto-following a newly opened tab.' },
        file: { type: 'string', description: 'Absolute path to upload (upload only, target must be a file input).' },
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
    name: 'browse_network',
    description: 'Query captured HTTP requests (Chrome Network panel): list/get/clear/configure. Captures method, headers and POST bodies; sensitive headers redacted by default.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get', 'clear', 'configure'], description: 'Operation.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' },
        network_id: { type: 'string', description: 'get: id from list.' },
        method: { type: 'array', items: { type: 'string' }, description: 'list: filter by HTTP method.' },
        url_contains: { type: 'string', description: 'list: URL substring filter.' },
        status_min: { type: 'integer', description: 'list: minimum status.' },
        status_max: { type: 'integer', description: 'list: maximum status.' },
        resource_type: { type: 'array', items: { type: 'string' }, description: 'list: XHR/Fetch/Document/...' },
        state: { type: 'array', items: { type: 'string' }, description: 'list: pending/finished/failed.' },
        started_after: { type: 'string', description: 'list: ISO timestamp.' },
        started_before: { type: 'string', description: 'list: ISO timestamp.' },
        limit: { type: 'integer', description: 'list: page size (default 50, max 200).' },
        before_seq: { type: 'integer', description: 'list: cursor from pagination.next_before_seq.' },
        include_request_headers: { type: 'boolean' },
        include_request_body: { type: 'boolean' },
        include_response_headers: { type: 'boolean' },
        include_response_body: { type: 'boolean' },
        include_sensitive_headers: { type: 'boolean', description: 'Requires AI_BROWSER_NETWORK_SENSITIVE=1.' },
        request_body_offset: { type: 'integer' },
        response_body_offset: { type: 'integer' },
        body_limit: { type: 'integer', description: 'Body page size (default 65536, max 262144).' },
        enabled: { type: 'boolean', description: 'configure: turn capture on/off.' },
        capture_bodies: { type: 'string', enum: ['none', 'api', 'all'], description: 'configure.' }
      },
      required: ['operation']
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
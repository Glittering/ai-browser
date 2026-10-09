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
    description: 'Act on an element by data-ai-id: click, type (append at caret), setContent (replace all), clear, focus, hover, scroll_to, upload, get_value (read-only), drag, press, wheel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'clear', 'focus', 'hover', 'scroll_to', 'upload', 'get_value', 'drag', 'press', 'wheel'], description: 'Action.' },
        target: { type: 'string', description: 'Element data-ai-id from the semantic tree. Omit for press (keys go to the current focus); for drag you may also omit it and pass from_x/from_y to start from a bare point.' },
        text: { type: 'string', description: 'Text to type (type only).' },
        value: { type: 'string', description: 'Value for select.' },
        offset: { type: 'integer', description: 'get_value: start offset in Unicode code points (default 0).' },
        limit: { type: 'integer', description: 'get_value: max code points to return (default 20000, hard cap 1000000).' },
        url: { type: 'string', description: 'For click: click the link whose href matches this URL instead of guessing the target label.' },
        keep_tab: { type: 'boolean', description: 'For click: keep the current tab active instead of auto-following a newly opened tab.' },
        file: { type: 'string', description: 'Absolute path to upload (upload only, target must be a file input).' },
        to_target: { type: 'string', description: 'drag: data-ai-id to drop onto (e.g. drag from one node\'s output to another node to connect them).' },
        dx: { type: 'number', description: 'drag: horizontal distance to move (use with dy instead of to_target).' },
        dy: { type: 'number', description: 'drag: vertical distance to move.' },
        to_x: { type: 'number', description: 'drag: absolute viewport x to end at (overrides dx).' },
        to_y: { type: 'number', description: 'drag: absolute viewport y to end at.' },
        from_x: { type: 'number', description: 'drag: explicit viewport x to start the drag at (no target needed — e.g. panning empty canvas).' },
        from_y: { type: 'number', description: 'drag: explicit viewport y to start the drag at.' },
        from_anchor: { type: 'string', enum: ['center', 'left', 'right', 'top', 'bottom'], description: 'drag: which point of target to grab; a side prefers that node\'s connection handle (default center).' },
        to_anchor: { type: 'string', enum: ['center', 'left', 'right', 'top', 'bottom'], description: 'drag: which point of to_target to drop on.' },
        hold: { type: 'array', items: { type: 'string' }, description: 'drag: modifier keys held during the drag (e.g. ["Shift"]).' },
        key: { type: 'string', description: 'press: a key name such as Delete, Escape, ArrowRight, Enter, or a combo like "Meta+a".' },
        delta_x: { type: 'number', description: 'wheel: horizontal scroll amount (positive scrolls right).' },
        delta_y: { type: 'number', description: 'wheel: vertical scroll amount. Negative scrolls up / zooms out; add hold:["Control"] for canvas zoom.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'press: sequence of keys to press in order.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['action']
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
    name: 'browse_canvas',
    description: 'Read <canvas> through captured draw calls (not pixels): list canvases, read texts/regions, configure, or capture a PNG fallback. 2D canvas text comes from fillText, so no OCR needed; WebGL is opaque.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'read', 'configure', 'capture'], description: 'Operation.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' },
        canvas_id: { type: 'string', description: 'read/capture: id from list.' },
        view: { type: 'string', enum: ['summary', 'calls'], description: 'read: summary (default) or raw draw calls.' },
        since_seq: { type: 'integer', description: 'read: cursor from pagination.next_seq.' },
        limit: { type: 'integer', description: 'read: page size (default 200, max 1000).' },
        mode: { type: 'string', enum: ['off', 'semantic', 'trace'], description: 'configure: recording mode.' },
        clear: { type: 'boolean', description: 'configure: drop retained calls.' }
      },
      required: ['operation']
    }
  },
  {
    name: 'browse_quit',
    description: 'Gracefully shut down the AI Browser (releases resources).',
    inputSchema: { type: 'object', properties: {} }
  }
];
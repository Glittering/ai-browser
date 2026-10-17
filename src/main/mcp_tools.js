// main/mcp_tools.js — the curated MCP tool list.
// Exported separately so tests can assert on it without triggering the
// mcp_server's main() side effects (spawning Electron / opening stdio).
// Tool count and descriptions are kept minimal to reduce per-message token
// cost in MCP clients that inject the full tool list on every turn.
//
// annotations 遵循 MCP Tool annotation 约定（title / readOnlyHint /
// destructiveHint / openWorldHint），Smithery / Cursor / Claude 等目录与客户端
// 会读取并渲染成徽标。只放布尔结论、不放长句，把额外 token 压到最低。
export const MCP_TOOLS = [
  {
    name: 'browse_navigate',
    title: 'Navigate tab',
    description: 'Navigate the active/focused tab to a URL. Returns as soon as the requested milestone is reached (default: DOM ready) — it does not wait for the load event, which SPAs often never fire.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' },
        wait_until: { type: 'string', enum: ['commit', 'domcontentloaded', 'load'], description: 'How far to wait. commit = navigation committed (fastest, content may not be painted); domcontentloaded = DOM ready (default, safe for SPAs); load = also subresources (can hang forever on pages that never fire load).' }
      },
      required: ['url']
    }
  },
  {
    name: 'browse_get_tree',
    title: 'Read semantic tree',
    description: 'Return the page semantic UI tree (roles, labels, actions, bounds, urls).',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    title: 'Act on element',
    description: 'Act on an element by data-ai-id: click, type (append at caret), setContent (replace all), clear, focus, hover, scroll_to, upload, get_value (read-only), drag, press, wheel, paste.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'clear', 'focus', 'hover', 'scroll_to', 'upload', 'get_value', 'drag', 'press', 'wheel', 'paste'], description: 'Action.' },
        html: { type: 'string', description: 'paste: HTML to inject (preferred). Editors convert it through their own paste pipeline (Draft.js/ProseMirror/Quill), so headings/code blocks/bold/lists survive. Plain text loses all formatting.' },
        text: { type: 'string', description: 'paste: plain-text fallback when html is absent.' },
        target: { type: 'string', description: 'Element data-ai-id from the semantic tree (e.g. e:button-12, axf-3-1) — NOT the visible label. Omit for press (keys go to the current focus); for drag you may also omit it and pass from_x/from_y to start from a bare point.' },
        text: { type: 'string', description: 'Text to type (type only).' },
        value: { type: 'string', description: 'Value for select.' },
        offset: { type: 'integer', description: 'get_value: start offset in Unicode code points (default 0).' },
        limit: { type: 'integer', description: 'get_value: max code points to return (default 20000, hard cap 1000000).' },
        url: { type: 'string', description: 'For click: click the link whose href matches this URL instead of guessing the target label.' },
        keep_tab: { type: 'boolean', description: 'For click: keep the current tab active instead of auto-following a newly opened tab.' },
        file: { type: 'string', description: 'Absolute path to upload (upload only, target must be a file input).' },
        timeout_ms: { type: 'integer', description: 'Override the action deadline in ms (default 15000; type/setContent/drag/press scale with text length / duration / repeat; 1s floor, 300s cap). A timeout returns success=false, timed_out=true and warns the action may have partially applied.' },
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
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'drag: mouse button (default left). Canvas apps often pan on middle/right drag.' },
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
    title: 'Run page JavaScript',
    description: 'Run a JS expression in the page context and return its value. Promises are awaited (async IIFEs return their resolved value, not {}).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        js: { type: 'string', description: 'Page-context JS expression (not statements). Max 5000 chars. Promises are awaited.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' },
        frame_ref: { type: 'string', description: 'Run inside this cross-process frame (an axf-... id from the tree). Pass it explicitly when touching iframe content: building the selector by string concatenation defeats the automatic route and the top-frame run returns null.' }
      },
      required: ['js']
    }
  },
  {
    name: 'browse_scroll',
    title: 'Scroll page',
    description: 'Scroll the page or an element into view.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    title: 'Wait for condition',
    description: 'Poll the page until a condition holds or timeout. Conditions: button_enabled, modal_appeared, text_contains, url_contains.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    name: 'browse_auth_state',
    title: 'Check login / auth-wall state',
    description: 'Is this tab still logged in, or bounced to a login wall? auth_wall.detected=true means stop debugging and re-authenticate first. logged_in is heuristic; auth_wall is the signal to trust.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_screenshot',
    title: 'Screenshot the viewport',
    description: 'Screenshot the viewport (base64 in data). Use FIRST when an action misbehaves: the element tree cannot show overlays, canvas, occlusion or glitches. Warns if a visible password input is on screen.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab id (default: active tab).' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format. Default png. jpeg at quality 85 is ~5x smaller — prefer it for long pages.' },
        quality: { type: 'number', description: '0-100, jpeg/webp only (ignored for png). Default 85 for jpeg.' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport. Cannot be combined with clip.' },
        clip: {
          type: 'object',
          description: 'Capture a rectangle in CSS pixels: {x, y, width, height, scale?}. Use to zoom into one element when the viewport shot is too small to read.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            scale: { type: 'number', description: 'Device scale factor, 0-4. Default 1.' }
          }
        }
      }
    }
  },
  {
    name: 'browse_list_tabs',
    title: 'List tabs',
    description: 'List open tabs (id, url, title, active).',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browse_new_tab',
    title: 'New tab',
    description: 'Open a new tab, optionally at a URL.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL.' }
      }
    }
  },
  {
    name: 'browse_close_tab',
    title: 'Close tab',
    description: 'Close a tab by id.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
    title: 'Switch active tab',
    description: 'Switch the active tab.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    title: 'Inspect network',
    description: 'Query captured HTTP requests (Chrome Network panel): list/get/clear/configure. Captures method, headers and POST bodies; sensitive headers redacted by default.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    title: 'Read canvas',
    description: 'Read <canvas> through captured draw calls (not pixels): list canvases, read texts/regions, configure, or capture a PNG fallback. 2D canvas text comes from fillText, so no OCR needed; WebGL is opaque.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    name: 'browse_diff',
    title: 'Snapshot and diff',
    description: 'Prove an action changed the page: snapshot a baseline, then diff to get added/removed/changed paths with before/after values. Success is not evidence.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['snapshot', 'diff'], description: 'Operation.' },
        js: { type: 'string', description: 'JSON-serializable expression to capture. Omit for a site-agnostic DOM summary (role/label/value/disabled/size per element).' },
        label: { type: 'string', description: 'snapshot: a note for your own bookkeeping.' },
        snapshot: { type: 'string', description: 'diff: the id returned by snapshot.' },
        rearm: { type: 'boolean', description: 'diff: make the current state the new baseline, so you can loop "assert no change" over many steps.' },
        forget: { type: 'boolean', description: 'diff: drop the stored baseline when done.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      },
      required: ['operation']
    }
  },
  {
    name: 'browse_capabilities',
    title: 'Probe capabilities',
    description: 'Probe what a page affords and which route to take: DOM vs canvas, same-origin iframes, app objects on window, JSON endpoints, plus a recommended plan with evidence.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        include_network: { type: 'boolean', description: 'Include observed JSON-ish endpoints (default true).' },
        network_limit: { type: 'integer', description: 'How many captured requests to scan.' },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_repaint',
    title: 'Force repaint',
    description: "Force the compositor to redraw a tab's BrowserView when the window shows a stale page; returns repaint_count so the repaint is provable.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
      }
    }
  },
  {
    name: 'browse_downloads',
    title: 'List downloads',
    description: 'List downloads for a tab with their on-disk paths. Use after clicking an export/download button — downloads are asynchronous, so poll this rather than expecting the path in the click response.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab ID (defaults to the active tab).' },
      },
    },
  },
  {
    name: 'browse_quit',
    title: 'Quit browser',
    description: 'Gracefully shut down the AI Browser (releases resources).',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} }
  }
];
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
    description: 'Act on a data-ai-id element. type appends at caret, setContent replaces all. Verb-specific params live in the group of the same name (click/read/press/wheel/drag).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'setContent', 'clear', 'focus', 'hover', 'scroll_to', 'upload', 'get_value', 'drag', 'press', 'wheel', 'paste'], description: 'Verb. Verb-specific params live in the group of the same name.' },
        target: { type: 'string', description: 'data-ai-id from the tree (e.g. e:button-12, axf-3-1) — NOT the visible label. Optional for press; for drag you may give drag.from instead. upload also accepts a CSS selector.' },
        text: { type: 'string', description: 'type: appended at the caret. setContent: replaces all. paste: plain fallback when html is absent.' },
        html: { type: 'string', description: 'paste: HTML, preferred — editors keep headings/lists/bold. Plain text loses formatting.' },
        value: { type: 'string', description: 'Option value for a <select>.' },
        file: { type: 'string', description: 'upload: absolute path. target may be the input, the trigger, or a CSS selector.' },
        timeout_ms: { type: 'integer', description: 'Action deadline (default 15000; scales with work; 1s..300s). Timeout → success=false, timed_out=true, action may have partially applied.' },
        click: {
          type: 'object',
          description: 'click only.',
          properties: {
            url: { type: 'string', description: 'Click the link whose href matches this URL instead of guessing which node in a composite card to hit.' },
            keep_tab: { type: 'boolean', description: 'Keep the current tab active instead of auto-following a newly opened tab.' }
          }
        },
        read: {
          type: 'object',
          description: 'get_value only — read-only: does not focus the element or fire input events.',
          properties: {
            offset: { type: 'integer', description: 'Start offset in Unicode code points (default 0).' },
            limit: { type: 'integer', description: 'Max code points to return (default 20000, hard cap 1000000).' }
          }
        },
        press: {
          type: 'object',
          description: 'press only. Keys go to the current focus, so target is optional.',
          properties: {
            key: { type: 'string', description: 'Delete, Escape, ArrowRight, Enter, or a combo like "Meta+a".' },
            keys: { type: 'array', items: { type: 'string' }, description: 'Sequence to press in order.' }
          }
        },
        wheel: {
          type: 'object',
          description: 'wheel only. Lands on target, or the viewport centre when target is omitted.',
          properties: {
            dx: { type: 'number', description: 'Horizontal delta (positive scrolls right).' },
            dy: { type: 'number', description: 'Vertical delta. Negative scrolls up / zooms out.' },
            hold: { type: 'array', items: { type: 'string' }, description: 'Modifiers held, e.g. ["Control"] to zoom a canvas.' }
          }
        },
        drag: {
          type: 'object',
          description: 'drag only. Give from/to for absolute points, dx/dy for a relative move, or target_to to drop onto another element.',
          properties: {
            from: {
              type: 'object',
              description: 'Start point. Omit to start from target.',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                anchor: { type: 'string', enum: ['center', 'left', 'right', 'top', 'bottom'], description: 'A side prefers that node\'s connection handle.' }
              }
            },
            to: {
              type: 'object',
              description: 'End point in viewport coords.',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                anchor: { type: 'string', enum: ['center', 'left', 'right', 'top', 'bottom'] }
              }
            },
            dx: { type: 'number', description: 'Horizontal distance instead of to.x.' },
            dy: { type: 'number', description: 'Vertical distance instead of to.y.' },
            target_to: { type: 'string', description: 'data-ai-id to drop onto (e.g. connect one node\'s output to another).' },
            hold: { type: 'array', items: { type: 'string' }, description: 'Modifiers held during the drag, e.g. ["Shift"].' },
            button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Canvas apps often pan on middle/right drag.' }
          }
        },
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
    name: 'browse_tabs',
    title: 'Tabs',
    description: 'Tabs: op=list / new / close / switch. switch makes a tab the default target for later calls, so you rarely pass tab explicitly.',
    // 合并前是 4 个工具（list / new / close / set_active），每个只承载一个动词。
    // 合并后 destructiveHint 只能是 false —— 否则 op=list 也会被标成破坏性操作；
    // close 的破坏性写在 description 里。这是合并的唯一语义代价，接受。
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'new', 'close', 'switch'], description: 'list = id/url/title/active for every tab. switch = make `tab` the default target.' },
        tab: { type: 'integer', description: 'close / switch: the target tab id.' },
        url: { type: 'string', description: 'new: open at this URL (default about:blank).' }
      },
      required: ['op']
    }
  },
  {
    name: 'browse_network',
    title: 'Inspect network',
    description: 'Query captured HTTP requests: list/get/clear/configure. Captures headers and POST bodies; sensitive headers redacted. Each op reads its own group: filters / include / body_offset / configure.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get', 'clear', 'configure'], description: 'Operation.' },
        network_id: { type: 'string', description: 'get: id from list.' },
        filters: {
          type: 'object',
          description: 'list only.',
          properties: {
            method: { type: 'array', items: { type: 'string' }, description: 'HTTP methods.' },
            url_contains: { type: 'string', description: 'URL substring.' },
            status_min: { type: 'integer' },
            status_max: { type: 'integer' },
            resource_type: { type: 'array', items: { type: 'string' }, description: 'XHR / Fetch / Document / …' },
            state: { type: 'array', items: { type: 'string' }, description: 'pending / finished / failed.' },
            started_after: { type: 'string', description: 'ISO timestamp.' },
            started_before: { type: 'string', description: 'ISO timestamp.' },
            limit: { type: 'integer', description: 'Page size (default 50, max 200).' },
            before_seq: { type: 'integer', description: 'Cursor from pagination.next_before_seq.' }
          }
        },
        include: {
          type: 'object',
          description: 'get only — what to bring back.',
          properties: {
            request_headers: { type: 'boolean' },
            response_headers: { type: 'boolean' },
            request_body: { type: 'boolean' },
            response_body: { type: 'boolean' },
            sensitive_headers: { type: 'boolean', description: 'Requires AI_BROWSER_NETWORK_SENSITIVE=1.' },
            body_limit: { type: 'integer', description: 'Body page size (default 65536, max 262144).' }
          }
        },
        body_offset: {
          type: 'object',
          description: 'get only — paginate a large body.',
          properties: {
            request: { type: 'integer' },
            response: { type: 'integer' }
          }
        },
        configure: {
          type: 'object',
          description: 'configure only.',
          properties: {
            enabled: { type: 'boolean', description: 'Turn capture on/off.' },
            capture_bodies: { type: 'string', enum: ['none', 'api', 'all'] }
          }
        },
        tab: { type: 'integer', description: 'Tab id (default: active tab).' }
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
    name: 'browse_errors',
    title: 'Read error log',
    description: 'Read the main-process error log: uncaught exceptions, crashes, failed navigations, RPC errors. Each entry includes recent calls as context. Returns the on-disk JSONL path.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max entries to return (default 50).' },
        kind: { type: 'string', description: 'Filter by kind: uncaught_exception / unhandled_rejection / render_process_gone / child_process_gone / nav_fail / ws_error.' },
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
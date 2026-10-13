# Release v1.1.10 — draft（待人工确认后用 `gh release create v1.1.10` 发布）

> 发布前检查：
> 1. `git tag v1.1.10`（当前 HEAD 还没有该 tag，package.json 已是 1.1.10）
> 2. `git push origin main --tags`
> 3. `gh release create v1.1.10 --title "v1.1.10 — verification primitives, pointer gestures, no focus stealing" --notes-file docs/marketing/RELEASE_v1.1.10.md`

---

## AI Browser v1.1.10

A release about three things: **proving an action actually happened**, **driving
canvas/board UIs with real pointer gestures**, and **never interrupting the human
sitting next to the browser**.

### Install — now on npm

```bash
npx -y @glittering0717/ai-browser start      # visible browser, WS on :9223
```

MCP clients (Claude Desktop / Cursor / Codex / Cline), no clone or paths needed:

```json
{"mcpServers":{"ai-browser":{"command":"npx","args":["-y","@glittering0717/ai-browser","mcp"]}}}
```

The first launch prepares the ~100 MB Electron engine itself. npm ≥ 11 blocks
dependency install scripts by default and Electron's extractor can truncate on
newer Node — the launcher detects both and self-heals (verified end-to-end on a
clean npx install). Node ≥ 18. Slow network: prefix
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
Package: <https://www.npmjs.com/package/@glittering0717/ai-browser>

### Verification is now a primitive

A tool returning `success` is not evidence that anything changed — overlays eat
clicks, apps revert edits, canvas UIs repaint without touching the DOM.

- **`browse_diff` (MCP) / `ui.snapshot`+`ui.diff` (WS):** snapshot a baseline,
  diff after the write, get an explicit `changed` / `unchanged` verdict with
  before/after values and JSON paths. Arrays compare element-wise by index; float
  noise tolerated. Errors and missing ids return explicitly — never an empty
  snapshot that would make every later diff false green.
- **Model fingerprinting:** omitting `js` also fingerprints the page's own data
  model, so canvas-app writes that move the DOM by zero bytes (ComfyUI's
  `node.widgets[].value`) are correctly reported as changed. Model and DOM
  signals are both reported when both move.
- **`browse_capabilities`:** one call reports tree histogram, canvases, iframes,
  app objects on `window`, observed endpoints, and a recommended route
  (L1 structured data / L2 semantic tree / L3 pointer gestures) with evidence.

### Real pointer gestures for canvas and board apps

- `browse_act` gains **`drag`** (dx/dy, absolute points, drop targets, side
  anchors, modifier keys, left/middle/right button), **`press`** (single key,
  combos, sequences) and **`wheel`** (incl. Ctrl-zoom). All go through trusted
  CDP input — synthetic PointerEvents move nothing under Pointer Capture.
- Drag results report the element actually hit at each endpoint and warn on
  mismatch; connection handles that are `pointer-events:none` honestly fall back
  to the edge midpoint.
- Same-origin iframe elements are routed and driven through real mouse events.

### The window never steals focus

- Agent-launched windows appear via `showInactive()`; `new_tab` /
  `set_active_tab` no longer call `webContents.focus()`. Focus emulation keeps
  `document.hasFocus()` and lazy-loading working while the keyboard stays with
  the human.
- Default `AI_BROWSER_FOCUS=auto` keeps the window visible without ever coming
  forward; `always` / `never` override.
- A new **focus suite** asserts from outside the app (macOS `lsappinfo`) that the
  full API slice works while another app holds the foreground, with a deliberate
  focus-stealing control group so the measurement can't pass vacuously.

### Reading the page more truthfully

- Same-origin iframes enter the semantic tree; `data-ai-id` is stable across
  reads (generated ids no longer renumber when nodes are inserted above).
- Repeat reads no longer perturb the page (attribute writes guarded; measured
  4001 MutationObserver records per read on a 4k-element page before).
- Field-level errors (incl. ARIA `aria-describedby` / `aria-errormessage`),
  required hints and form-adjacent helper text surface at top level of
  `context` instead of being pruned by container class names.
- File inputs and ARIA controls advertise correct actions; the tree no longer
  steers the agent toward actions an element can't take.
- `type` now **appends at caret**; `setContent` replaces all — they used to be
  identical, making incremental editing impossible.

### Canvas, downloads, networking

- **Canvas read through draw calls, not pixels:** a main-world tee wraps the 2D
  Canvas API — `fillText` yields literal strings (no OCR), regions and styles
  included. Native calls always run first; recording can't alter rendering.
  WebGL is marked `opaque`; PNG capture is explicit and off by default.
- **Downloads actually land on disk**, with a permission allowlist;
  `browse_downloads` reports on-disk paths (poll after clicking export).
- Network inspection captures from tab open including POST bodies, with
  pagination and default redaction of `authorization` / `cookie`.

### Robustness

- Every path into the page is deadline-bounded (5–15 s budgets, scaling per
  action) — a main thread blocked for 120 s can no longer hang a tool call;
  timeouts warn the action may have partially applied.
- Fixed silent launch failure when `ELECTRON_RUN_AS_NODE` is set in the
  environment; the MCP server now reports why Electron never came up.
- Stale-window fix: every navigation signal (incl. in-page SPA routes and
  late iframe loads) triggers a repaint; `browse_repaint` forces one and
  returns a provable counter.
- Watchdog probes multiple targets (example.com + baidu.com) before restarting,
  is configurable (`AI_BROWSER_WATCHDOG_URLS`) and disableable
  (`AI_BROWSER_WATCHDOG=0`).

### MCP surface

17 `browse_*` tools. Since earlier versions: added `browse_diff`,
`browse_capabilities`, `browse_repaint`, `browse_downloads`; real-time
`subscribe`/`network_body` remain raw-WebSocket only (MCP stdio can't deliver
server→client notifications). Every tool now carries MCP annotations
(`readOnlyHint` / `destructiveHint` / `openWorldHint`); `resources/list` and
`prompts/list` answer with empty collections; guard rejections return as tool
results (`isError: true`).

### Tests

411 unit tests (27 files) and 11 Electron e2e suites / 409 assertions booting a
real browser against offline fixtures — smoke, capabilities, richtext, network,
value, canvas, modeldiff, audit, focus, interact, view.

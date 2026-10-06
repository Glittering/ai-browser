<h1 align="center">AI Browser</h1>

<p align="center">
  <b>A real browser whose only operator is your agent.</b><br>
  It reads pages as a semantic tree instead of screenshots, acts through trusted browser input —
  and because it is a normal, visible Electron window, a human can reach for the mouse at any time.
</p>

<p align="center">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Electron" src="https://img.shields.io/badge/built%20with-Electron%2033-9cf">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%E2%80%A2%20Linux-blueviolet">
  <img alt="Tests" src="https://img.shields.io/badge/tests-174%20passing%20%2F%2019%20files-2ea043">
  <img alt="MCP" src="https://img.shields.io/badge/spec-MCP%20(stdio)-f5b23b">
</p>

**What it is.** An Electron app that exposes its tabs over two equivalent interfaces — an MCP server
(13 `browse_*` tools) and a raw WebSocket JSON-RPC API (`ws://localhost:9223`, methods `ui.*`). Your
agent navigates, reads a structured semantic tree (`role` / `label` / `value` / `states` / `actions`),
and clicks or types by `data-ai-id`. There is no screenshot step and no OCR: `src/` contains no
capture call at all.

**What it is not.** It is not headless. The window really opens, really renders, and stays interactive —
see [Letting a human step in](#letting-a-human-step-in). Nor does it "co-drive" with you: the hand-off
is a conversation between the agent and the user, not a browser API.

> **Security note.** The WebSocket server has no authentication — it listens on localhost and trusts
> whoever connects. Do not expose port 9223 beyond loopback, and avoid untrusted networks.

---

## Install

Requires **Node ≥ 18** and a desktop session (this is a GUI app).

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser
npm install
```

`npm install` also downloads the Electron binary (~100 MB) from GitHub releases. If that download is
slow, blocked, or fails outright — common from mainland China — point it at a mirror:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

Or make it sticky by creating a `.npmrc` in the project root:

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
```

Confirm the binary actually landed before blaming anything else — a missing binary still leaves you
with an "install that succeeded":

```bash
ls node_modules/electron/dist
```

To check the install end to end:

```bash
npm start
```

A 1280×800 window opens and the terminal prints `AI Browser WS server listening on ws://localhost:9223`.
(The first tab opens on the default start page; ignore it and navigate away.)

---

## Connect your agent

Add this to your MCP client's config file — Claude Desktop's config, `~/.cursor/mcp.json`, or a
project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["/absolute/path/to/ai-browser/src/main/mcp_server.js"]
    }
  }
}
```

Replace the path with **your** absolute path to `src/main/mcp_server.js`. It has to be absolute: the
MCP client's working directory is not necessarily the project root. A ready-made copy sits in
[`examples/mcp-config.json`](examples/mcp-config.json).

**You do not need to start the browser yourself.** On the first `browse_*` call the MCP server probes
port 9223; if nothing is listening it spawns Electron (detached, from the project root) and waits up
to 30 seconds for the WebSocket server. If you would rather keep one long-lived window shared by
every client, run `npm start` manually in a terminal — a second launch just focuses the existing window.

`examples/AGENT_INSTRUCTIONS.md` has a copy-paste prompt you can drop into a `CLAUDE.md`, Cursor Rule,
or any system prompt; it teaches the tool loop, the token-saving params, and when to ask a human.

---

## The 13 tools

Source of truth: [`src/main/mcp_tools.js`](src/main/mcp_tools.js).

| Tool | One line |
|---|---|
| `browse_navigate` | Load a URL in the active (or given) tab. |
| `browse_get_tree` | Read the page as a semantic tree + page context (modals, messages, stats). |
| `browse_act` | `click` / `type` / `clear` / `focus` / `hover` / `scroll_to` / `upload` on a `data-ai-id`. |
| `browse_evaluate` | Run a JS *expression* in page context (5000-char cap, Node identifiers rejected). |
| `browse_scroll` | Scroll the page, or scroll an element into view. |
| `browse_wait` | Poll until `button_enabled` / `modal_appeared` / `text_contains` / `url_contains`. |
| `browse_list_tabs` | List open tabs (id, url, title, active). |
| `browse_new_tab` | Open a new tab, optionally at a URL. |
| `browse_close_tab` | Close a tab by id. |
| `browse_set_active_tab` | Switch which tab subsequent calls act on. |
| `browse_network_body` | Get the response body of a completed request matching a URL substring. |
| `browse_subscribe` | Subscribe to `dom_change` / `network_response` / `captcha_appeared` / `message_appeared` / `js_error` / `state_changed`; `"*"` for all. |
| `browse_quit` | Shut the whole browser down and release the process. |

Notes that save round-trips:

- `browse_get_tree` accepts `subset: "interactive"` to drop layout-only branches, `mode: "diff"` to
  return only nodes that appeared/disappeared since the last read, and `ax: true` to read through the
  accessibility layer (links then carry `url`).
- `browse_network_body` needs a prior `browse_subscribe` — bodies are only retained while subscribed.
- Most tools take an optional `tab` for multi-tab work; without it they target the active tab.

---

## Letting a human step in

This is the part most easily misunderstood, so plainly: **the agent drives the browser, and the human
can always take over the window.**

Because it is a real Electron window, a person can click, type, scroll, and log in exactly as they
would in Chrome — with the mouse and keyboard, at any moment, with no permission to request. That
covers the things an agent genuinely cannot do:

- **Login / SSO** and anything behind a password the agent shouldn't have
- **QR-code scans** (app-to-web authorization)
- **Slider and image CAPTCHAs**, SMS or email codes
- **Payment confirmation**, risk-control interstitials, OTP screens
- Anything where continuing would mean fabricating credentials

**How the hand-off works: there isn't one — in the browser.** Nothing coordinates it on AI Browser's
side, and nothing needs to. It is a conversation between the agent and its user:

1. The agent hits something it cannot do.
2. It says so in chat, plainly: *"Please scan the QR code in the browser window, then reply 'done'."*
3. It stops and waits for the reply — no retry loops on clicks that cannot work.
4. After "done" it re-reads with `browse_get_tree` to confirm the new state, then continues.

See [`examples/with-human.mjs`](examples/with-human.mjs) for the scripted equivalent: it prints a
prompt and waits for Enter over `readline`. The browser has no idea any of that happened.

Two practical consequences for the agent:

- **Never call `browse_quit` while a human is working in the window.** It tears down the window and
  exits the process — anything half-solved is lost. Quit when the task is finished, not before.
- **Login state persists.** Tabs live in the `persist:ai-browser` session partition, so cookies and
  sessions survive a restart; usually a human only has to step in once per site per machine.

---

## Raw WebSocket API

MCP is a thin stdio adapter. Anything MCP can do is reachable directly over JSON-RPC 2.0 at
`ws://localhost:9223` from any language. Source of truth: the method switch in
[`src/main/ws_server.js`](src/main/ws_server.js).

| Method | Purpose | Maps to |
|---|---|---|
| `ui.get_tree` | Semantic tree (+ context). Params: `focusedOnly`, `ax`, `subset`, `mode`, `tab` | `browse_get_tree` |
| `ui.act` | `params.action` + `params.target`; per-action args nested under `params.params` | `browse_act` |
| `ui.navigate` | Load a URL (`params.url`, optional `tab`) | `browse_navigate` |
| `ui.evaluate` | Run JS in page context, same guard as MCP | `browse_evaluate` |
| `ui.scroll` | Scroll page or element (`direction`, `amount`, `target`) | `browse_scroll` |
| `ui.wait` | Poll until a condition or timeout | `browse_wait` |
| `ui.new_tab` / `ui.close_tab` / `ui.list_tabs` / `ui.set_active_tab` | Tab management | `browse_*_tab` |
| `ui.subscribe` / `ui.unsubscribe` | Event subscription; `params.events`, `"*"` for all | `browse_subscribe` |
| `ui.get_focused` | The focused element subtree | — |
| `ui.peek` | Hover a folded/hover-only affordance and return the diff, without committing | — |
| `ui.network_body` | Response body by URL substring (`url_pattern`) | `browse_network_body` |
| `ui.quit` | Graceful shutdown | `browse_quit` |

Note two differences from the MCP spelling, both visible in the switch above: it is `focusedOnly`
(camelCase), not `focused_only`; and `ui.act` nests its per-action arguments under `params.params`.
`ui.subscribe` / `ui.unsubscribe` are also valid as notifications with no `id`.

```js
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:9223');
let id = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const myId = ++id;
  const onMsg = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === myId) { ws.off('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
});

ws.on('open', async () => {
  await call('ui.navigate', { url: 'https://example.com' });
  const { tree } = await call('ui.get_tree', { subset: 'interactive' });
  console.log(tree.role, tree.children?.length);
  ws.close();
});
```

Error codes follow JSON-RPC: `-32700` parse error, `-32601` unknown method, `-32602` invalid params
(the `ui.evaluate` guard returns this), `-32603` internal error.

---

## How it works

```
   agent ── MCP stdio (13 browse_*) ──┐
   agent ── WS JSON-RPC :9223 (ui.*) ─┤
                                      ▼
 ┌──────────────────────────────────────────────────┐
 │ Electron main                                    │
 │   index.js        window · tab strip · watchdog  │
 │   ws_server.js    JSON-RPC routing, event stream │
 │   page_manager.js tabs · id-matched IPC · CDP    │
 └───────────────┬──────────────────────────────────┘
                 │ IPC (request-id matched)
 ┌───────────────▼──────────────────────────────────┐
 │ preload (contextIsolation:true, nodeIntegration:false)
 │   bridge.cjs · extractor.cjs · actions.cjs ·     │
 │   watcher.cjs  (captcha / message / state scan)  │
 └───────────────┬──────────────────────────────────┘
                 ▼
              live DOM → semantic tree
```

**Reading.** Each node in the returned tree carries a `data-ai-id` — the element's own DOM `id` when it
has one, otherwise a generated `e:tag-N` that is only good for the read it came from. Alongside it come
`role`, `label`, `value`, `states`, and `actions`, plus a `context` block — open modals, transient
messages, required-field hints, coarse stats. Two read paths exist: the default preload extractor, and
the accessibility layer behind `ax: true` (which additionally gives links their `url`).

**Writing.** Actions are **trusted browser input**, not synthesized JS. The main process drives the
page over the Chrome DevTools Protocol — `Input.dispatchMouseEvent` for clicks, and per-character
`Input.dispatchKeyEvent` (`rawKeyDown → char → keyUp`) for typing — then validates that the click
actually landed via `elementFromPoint`. Because the events arrive as real keyboard and mouse input,
Draft.js, ProseMirror, CKEditor, Quill, and plain `<textarea>` all work through the same path without
per-framework branches.

**Where it is thin.** `extractor.cjs` is a heuristic over the DOM, not a clean-room specification: it
handles ordinary pages well and will mislabel exotic ones. The window runs with hardware acceleration
off plus three Chromium switches
(`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
`--disable-background-timer-throttling`) so that an IDE window on top of the browser doesn't cause
injected input to be silently dropped.

---

## Examples

Runnable scripts live in [`examples/`](examples/) and connect straight to `ws://localhost:9223`:

| File | What it shows |
|---|---|
| [`mcp-config.json`](examples/mcp-config.json) | Minimal MCP client config; replace the placeholder path. |
| [`AGENT_INSTRUCTIONS.md`](examples/AGENT_INSTRUCTIONS.md) | Copy-paste instructions for your agent, incl. the human hand-off protocol. |
| [`raw-ws.mjs`](examples/raw-ws.mjs) | Smallest possible raw WebSocket client. |
| [`read-page.mjs`](examples/read-page.mjs) | Load one page, print its interactive elements. |
| [`with-human.mjs`](examples/with-human.mjs) | Full flow for when a human has to step in. |

```bash
node examples/read-page.mjs
```

---

## Troubleshooting

**The app restarts itself.** Electron's NetworkService can wedge as a whole: the port still listens,
every navigation fails with `ERR_FAILED`, and `curl` works fine. A watchdog probes from the main
process every 30s; after 5 consecutive failed sweeps it broadcasts `network_wedged` and relaunches
(the MCP client reconnects on its own). With a 5s per-request deadline that puts a genuine wedge at
roughly two minutes.

- Change what it probes: `AI_BROWSER_WATCHDOG_URLS=https://www.baidu.com/,https://example.com/`
  (comma-separated). The default is `example.com` **plus** `www.baidu.com`, and that plurality is
  deliberate — the network counts as alive if *any* target answers, so one flaky or geo-blocked host
  can't trigger a reboot loop. Never set a single target that your network can't reach.
- Turn it off entirely: `AI_BROWSER_WATCHDOG=0` (also accepts `off` / `false` / `no`).

**Port 9223 is already busy.** Another instance — often a stale one from an earlier session — owns the
port, or something else does. Either quit that instance, or move AI Browser off it:

```bash
AI_BROWSER_PORT=9224 npm start
```

Keep the port consistent across every client; both the app and the MCP server read
`AI_BROWSER_PORT` from `src/shared/config.js`.

**Electron is missing or `npm start` fails immediately.** Almost always the post-install download
never completed: check `ls node_modules/electron/dist`, then re-run `npm install` with the mirror in
[Install](#install). Setting `AI_BROWSER_PORT` will not help here — this is a missing binary, not a
port conflict.

**Input is accepted but nothing happens.** Usually the window is occluded. The three
`disable-*-backgrounding` switches above exist to prevent it, but if you still see clicks that report
success while nothing moves, bring the AI Browser window to the front and try again.

**Login state keeps getting lost.** Sessions persist under `~/.ai-browser`. If you override it, note
that separate `AI_BROWSER_USER_DATA` directories are separate session stores — "logged in" in one is
not "logged in" in another:

```bash
AI_BROWSER_USER_DATA=~/.ai-browser-work npm start
```

---

## Test & dev

```bash
npm test             # vitest — 174 tests across 19 files, all passing
npm run smoke        # Electron contract layer, offline fixture — 31 checks, all passing
npm run capabilities # text input / canvas / page source / network capture / DOM editing — 53 checks
npm run realsites    # navigate/read/act against a matrix of real sites
```

`npm run smoke` boots a genuine Electron against offline fixtures and exits non-zero on failure; it
covers things jsdom structurally cannot (preload integrity, `ui.evaluate` under a strict CSP, CDP
click hit-testing and off-screen scroll, multi-tab lifecycle, event fan-out to multiple clients, and
the `evaluate` guard rails).

`npm run capabilities` is the user-facing capability matrix: typing into every kind of text field
(plain inputs, `password`, `number`, `textarea`, `contenteditable`, plus `readonly` / `disabled` /
`maxlength` behaviour — including **CJK input** and 1000-character text), what a `canvas` does and
does not expose, reading page source, capturing response bodies, and editing the page through
`ui.evaluate`.

Both need the WS port free — stop a running `npm start` first, or point them somewhere else:

```bash
AI_BROWSER_PORT=9333 npm run smoke
AI_BROWSER_PORT=9333 npm run capabilities
```

They boot their own Electron in an isolated profile (`/tmp/ai-browser-e2e-<port>` by default), so
they never touch your real `~/.ai-browser` profile — the one holding your logged-in sessions.

### What `npm run capabilities` proved about `canvas`

A `canvas` is a node in the semantic tree (`role: canvas`) and nothing more — no value, no text, no
pixels. You can read dimensions and raw pixels yourself via `ui.evaluate`
(`getContext('2d').getImageData(...)`), but AI Browser does not screenshot or OCR, so it cannot tell
you what a canvas *shows*. That is a deliberate boundary, not a bug.

`npm run realsites` is table-driven from `e2e/realsites/sites.cjs`, currently 17 sites across 8 buckets
(search, finance, media, dev, ecommerce, spa, editor, marketplace). Sites that require login or
answer with an anti-bot wall are counted as passing when the login wall / bot wall is detected rather
than bypassed, so this asserts "the browser reaches and reads them", not "the flows succeed".

Layout:

```
src/main/      Electron main — ws_server · page_manager (tabs, CDP) · mcp_server · mcp_tools · axExtractor
src/preload/   bridge · extractor (semantic tree, data-ai-id) · actions · watcher
src/renderer/  tab bar UI
src/shared/    config (AI_BROWSER_* env) · guards (evaluate safety) · protocol · watchdog
e2e/           smoke_ws.cjs · realsites/
tests/         vitest unit suites
skills/        optional higher-level recipes built on the tools
```

`src/shared/config.js` is the single source for port, user-data dir, and UA overrides; `guards.js` is
the single source for `evaluate` limits, enforced identically on both transports.

---

## Compatibility

| Dimension | Support |
|---|---|
| Agents | Any MCP stdio client; alternatively raw WS from any language |
| Node | ≥ 18 |
| OS | **macOS** and **Linux** — developed and tested on these. **Windows: experimental and untested.** It is plain Electron plus CDP, so it ought to build, but no one has run it; expect to debug `npm install` and the window layer yourself. Please report back either way. |
| Page frameworks | React / Vue / Angular / vanilla DOM — element locating is DOM-based, not framework-based |
| Editors | Rich editors driven through trusted input rather than per-framework code paths |
| Page types | Static and SPA; dynamic updates observable via the tree, `dom_change` / `state_changed` events |

---

## Contributing

Issues and PRs are welcome, especially reproduction cases where the semantic tree gets a page wrong —
those are the most useful bug reports this project can get.

What we try to hold the line on:

- **Keep the core generic.** Site-specific knowledge belongs outside `src/main` and `src/preload`.
- **IPC stays request-id matched**, and CDP sessions stay reference-counted — tabs leak otherwise.
- **No screenshots.** If a change needs pixels to work, the design question is upstream of it.
- **`evaluate` stays guarded** (length cap, no Node identifiers), on both transports at once.
- **Agent instructions change when behaviour changes.** The MCP tool list, `ws_server.js` methods,
  and `examples/AGENT_INSTRUCTIONS.md` must agree; a doc that drifts from `mcp_tools.js` is a bug.

---

## License

MIT © Glittering

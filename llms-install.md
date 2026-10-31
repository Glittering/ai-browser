# llms-install.md — agent-oriented install guide for AI Browser

This file is written for AI coding agents installing or configuring **AI Browser**
on a user's machine. The human-facing guide is [README.md](README.md); this file is
the short, exact path. Do not invent flags or tool names not listed here.

## What it is

A real, visible Electron browser driven by an agent. Pages are returned as a
semantic tree (roles / labels / values / actions, stable `data-ai-id` per element),
not screenshots. Input is trusted CDP keyboard/mouse events. A human can use the
window's mouse and keyboard at any time (login, QR scan, CAPTCHA, payment).

Two equivalent interfaces: **MCP stdio** (17 `browse_*` tools) and a raw WebSocket
JSON-RPC API at `ws://localhost:9223` (`ui.*` methods). A CLI (`ai-browser call ui.xxx`) speaks
the same JSON-RPC and needs **no registration at all** — see "Fastest path" below.

## Requirements

- Node.js **≥ 18**
- A desktop session (GUI app): macOS or Linux. Windows is experimental/untested.
- ~110 MB download for the Electron engine (prepared on first launch / `npm install`, from GitHub
  releases); it expands to ~245 MB on disk. Do not judge the install by the download size alone.

> **Installation priority.** The prebuilt macOS `.dmg` (README "Option A") is the recommended
> install for humans: one file, no Node.js, no dependency tree. The npx path below is for agents
> and for machines that already have Node — it is also how the MCP server gets registered, so it
> stays necessary even when the packaged app is installed. The two cooperate: if the packaged app
> is already running, the MCP server reuses it on port 9223 instead of downloading a second
> Electron. Source install is the fallback — only when no package fits, the package misbehaves,
> or the code itself needs changes; it pulls ~276 MB of dependencies plus the engine.

## Install

For agents (this is also the MCP bridge) — npm package
[`@glittering0717/ai-browser`](https://www.npmjs.com/package/@glittering0717/ai-browser),
no clone needed:

```bash
npx -y @glittering0717/ai-browser start
```

The first launch prepares the Electron engine once (~100 MB). npm ≥ 11 skips dependency install
scripts by default; the launcher detects the missing engine and runs Electron's downloader itself.
If the download is slow/fails (common on mainland-China networks), set a mirror in the environment
of the launch command:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx -y @glittering0717/ai-browser start
```

Alternative — from source:

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser
npm install   # prefix ELECTRON_MIRROR=... if the Electron download is slow
```

Verify the binary exists before anything else:

```bash
ls node_modules/electron/dist   # must contain Electron.app (macOS)
```

Optional end-to-end check: `npx -y @glittering0717/ai-browser start` (or `npm start` from source) opens
a 1280×800 window and logs `AI Browser WS server listening on ws://localhost:9223`.

## Fastest path — works with zero registration

If you just need to drive the browser now, skip the MCP section entirely. The CLI reaches the
same engine, and **starts the browser itself if it is not running** (idempotent; no separate
`start` step):

```bash
npm i -g @glittering0717/ai-browser     # or: npm link  (from a source checkout)
ai-browser call ui.navigate '{"url":"https://example.com"}'
ai-browser call ui.get_tree '{"subset":"interactive"}'
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'
```

No global install? Prefix every command with `npx -y @glittering0717/ai-browser`.

Why this matters more than it looks: registering an MCP server passes through **three gates the
agent does not control** — the config file, a one-time trust/approval for executing a local
program, and the client's tool snapshot taken at session start. If any one of them has not
completed, `browse_*` simply does not exist in the tool list, and the symptom is identical to
"the capability is not installed". A weaker model then spends a long time concluding it is
misconfigured. The CLI has none of those gates: it only needs the command to run.

## Register as an MCP server

Add this to the client config (Claude Desktop config, `~/.cursor/mcp.json`, project `.mcp.json`,
Cline, etc.):

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "npx",
      "args": ["-y", "@glittering0717/ai-browser", "mcp"]
    }
  }
}
```

From-source alternative: `"command": "node"` with the absolute path to
`src/main/mcp_server.js`.

> **Match the version, or nothing lines up.** The skill shipped in this package documents the
> tool surface of the *same* version. Before pasting `npx` above, compare
> `npm view @glittering0717/ai-browser version` with this repo's `package.json`. If they differ
> (they have: npm 1.3.1 vs repo 2.0.0), use the from-source form with the source path — a 1.x
> server behind a 2.x skill means every tool name and parameter in the skill is wrong, and a
> small model cannot tell that apart from "the MCP server is down". A concrete field report:
> a 35B local model spent a long session concluding "the skill is installed but the MCP server
> is not mounted", correctly diagnosing a missing config entry while the real trap was that
> nothing had been registered at all — see the `ai-browser` entry in the client's `mcp.json`.
>
> **No MCP at all?** The CLI speaks the same JSON-RPC and needs no registration:
> `ai-browser status`, `ai-browser call ui.navigate '{"url":"..."}'`. Installing the package
> globally (`npm i -g @glittering0717/ai-browser`) puts that binary on PATH; from a source
> checkout, `npm link` does the same.

Do **not** launch the browser yourself first: on the first `browse_*` call the MCP server probes
port 9223, spawns Electron detached if nothing is listening, and waits up to 30 s (the very first
call can take longer if the engine download hasn't happened yet — the progress goes to stderr).
A long-lived shared window is also fine — run the `start` command manually; a second launch only
focuses the existing window (single instance lock).

## The 17 tools

- `browse_navigate` — load a URL in your tab or the given tab.
- `browse_get_tree` — semantic tree + context (modals, toasts, required-field
  hints, login state, stats). Params: `subset: "interactive"` (token saver, use by
  default), `ax: true` (links carry urls), `mode: "diff"` (only new/hidden nodes).
- `browse_act` — act on a `data-ai-id`: `click`, `type` (append at caret),
  `setContent` (replace all), `clear`, `focus`, `hover`, `scroll_to`, `upload`,
  `get_value` (read-only full value; tree truncates at 200 chars), `drag`,
  `press`, `wheel`.
  Every result carries `effect_state: "committed" | "none" | "unknown"` plus a
  `retry` verdict (`no` / `safe` / `verify_first`). Treat `unknown` as "read the
  page before touching it again" — a blind retry can submit twice. A missing
  target adds `stale_ref` + `ref_diagnosis` (`stale` → re-read the tree;
  `never_seen` → the ref itself is wrong; `present_in_tree` → iframe/shadow DOM).
- `browse_diff` — `snapshot` a baseline, then `diff`; returns an explicit
  `verdict: "changed" | "unchanged"` with before/after JSON paths. Wrap every
  write with this — a success return is not evidence the write worked.
- `browse_capabilities` — probe a page and recommend a route:
  L1 structured data / L2 semantic tree / L3 pointer gestures.
- `browse_evaluate` — JS **expression** in page context; 5000-char cap;
  `process.` / `require` / `child_process` are rejected.
- `browse_scroll` — document scrolling only; use `act {action:"wheel"}` on
  infinite-canvas apps.
- `browse_wait` — poll until `button_enabled` / `modal_appeared` /
  `text_contains` / `url_contains`.
- `browse_network` — captured requests (`list` / `get` / `clear` / `configure`),
  including POST bodies; auth/cookie headers redacted by default.
- `browse_canvas` — `list` / `read` (2D draw calls, text from `fillText`, no OCR) /
  `configure` / `capture` (PNG fallback for opaque WebGL only).
- `browse_repaint` — force compositor redraw when the window shows a stale page.
- `browse_downloads` — list downloads with on-disk paths (poll after clicking
  export/download; downloads are asynchronous).
- `browse_tabs` — tab management: `{op: "list" | "new" | "close" | "switch" | "window"}`.
  `switch` = default; add `show:true`; `new` never steals the view unless `show:true`.
- `browse_quit` — shut the whole browser down and release the process.

**Which door should you use?** Prefer the **CLI** unless the tool list already contains
`browse_*`. MCP is a nicer interface (schemas are self-describing) but it is not under your
control; the CLI is. Both hit one implementation (`page_manager`) — there is no capability that
only exists over MCP.

```bash
ai-browser status                                   # is it running? pid / port / tabs
ai-browser ensure                                   # start it if needed, then exit
ai-browser call ui.list_tabs
ai-browser call ui.navigate '{"url":"..."}'
```

CLI method names are the tool names with `browse_` → `ui.` (`get_tree`, `act`, `navigate`,
`evaluate`, `scroll`, `wait`, `screenshot`, `errors`, `capabilities`, `downloads`, `quit`,
`auth_state`, `repaint`). The four that do not map one-to-one: `tabs` → `ui.list_tabs` /
`ui.new_tab` / `ui.close_tab` / `ui.set_active_tab`; `network` → `ui.network_list` /
`ui.network_get`; `canvas` → `ui.canvas_list` / `ui.canvas_read` / `ui.canvas_capture` /
`ui.canvas_configure`; `diff` → `ui.snapshot` / `ui.diff`.

There is no `browse_subscribe` and no `browse_network_body`: real-time events are
raw-WebSocket only (`ui.subscribe`), because MCP stdio drops server→client
notifications. Use `browse_network` for pull-based inspection.

## Standard agent loop

1. `browse_navigate { url }`
2. `browse_get_tree { subset: "interactive" }` → find the target's `id`
3. `browse_act { action, target }`
4. `browse_diff { operation: "diff", snapshot }` → confirm `verdict: "changed"`
5. `browse_wait` when the page must transition
6. `browse_quit` only when the whole task is finished — never while a human is
   working in the window (it tears down the window and loses half-done state).

## Human hand-off

When blocked by login, SSO, QR code, slider/image CAPTCHA, SMS/email code, or
payment confirmation: stop and ask the user **in your own reply** (plain text —
there is no `chat`/`message` tool here, and no side-conversation feature) to do
it in the visible browser window and reply "done", wait for that reply, then
re-read with `browse_get_tree` and continue. Never fabricate credentials or retry
clicks that cannot succeed. Logins persist in the `persist:ai-browser` session
partition (on disk under `~/.ai-browser`), so intervention is usually needed once
per site. While the user is typing or scanning, do **not** call `browse_quit` —
it closes the window and takes any half-finished work with it.

## Troubleshooting (common cases)

- **Port 9223 busy:** quit the stale instance, or set `AI_BROWSER_PORT=9224`
  consistently for the app and every client.
- **`npm start` fails immediately:** the Electron binary did not download —
  check `ls node_modules/electron/dist`, reinstall with `ELECTRON_MIRROR`.
- **Action reported success but nothing changed:** use `browse_diff`; an overlay
  may have eaten the click or the app reverted it. Raw WS nests action args
  under `params.params`.
- **Window shows a stale page:** call `browse_repaint`.
- **Slow mainland-China network / reboot loops:** watchdog targets are
  configurable; `AI_BROWSER_WATCHDOG=0` disables it. See README for details.

## Raw WebSocket alternative (no MCP)

`ws://localhost:9223`, JSON-RPC 2.0. Methods `ui.navigate`, `ui.get_tree`,
`ui.act`, `ui.snapshot` / `ui.diff`, `ui.capabilities`, `ui.evaluate`,
`ui.scroll`, `ui.wait`, `ui.new_tab` / `ui.close_tab` / `ui.list_tabs` /
`ui.set_active_tab`, `ui.network_*`, `ui.canvas_*`, `ui.repaint`,
`ui.downloads`, `ui.subscribe`, `ui.quit`. Minimal client:
[`examples/raw-ws.mjs`](examples/raw-ws.mjs).

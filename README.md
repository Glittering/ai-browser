<h1 align="center">AI Browser</h1>

<p align="center">
  <b>The browser that swaps pixels for a semantic tree.</b><br>
  Give your agent the same structured view of any webpage that you'd get from reading the DOM — <b>no screenshots, no OCR, no brittle selectors.</b>
</p>

<p align="center">
  <a href="#-one-liner-for-your-agent"><strong>⚡ One-liner for your agent</strong></a> ·
  <a href="#quickstart"><strong>Quickstart</strong></a> ·
  <a href="#why-not-screenshots"><strong>Why not screenshots?</strong></a> ·
  <a href="#compatibility"><strong>Compatibility</strong></a>
</p>

<p align="center">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Electron" src="https://img.shields.io/badge/built%20with-Electron%2033-9cf">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%E2%80%A2%20Linux-blueviolet">
  <img alt="Tests" src="https://img.shields.io/badge/tests-100%20unit%20%2B%2031%20smoke-2ea043">
  <img alt="MCP" src="https://img.shields.io/badge/spec-MCP%20(stdio)-f5b23b">
  <img alt="Stars" src="https://img.shields.io/github/stars/Glittering/ai-browser?style=social">
</p>

---

## 🚀 One-liner for your agent

The whole thing is designed around **one copy-paste**. Pick your agent, drop this into its memory/instructions, and it can drive a real browser on its own—even launching it from nothing.

> **Claude Code / Cursor / Codex / any MCP agent:**
> I can browse the web with **AI Browser**. It exposes an MCP server (13 `browse_*` tools). It auto-starts the Electron browser on first call and auto-shuts it down when I'm done—no human needs to start or stop it.
> Use `browse_navigate` to load a URL, `browse_get_tree` to read the page (a structured DOM tree, not an image), `browse_act` to click/type/clear like a human, `browse_evaluate` to run JS, and `browse_wait` to block until something appears.

**Under the hood**, the same power is a raw WebSocket JSON-RPC API on `:9223`, so you're never locked into MCP.

---

## Quickstart

### Option A — register the MCP server (recommended)

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser && npm install
```

Then register the stdio server against your MCP client:

```jsonc
// .mcp.json  (Claude Desktop / Cursor / Codex)
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["/absolute/path/to/ai-browser/src/main/mcp_server.js"]
    }
  }
}
```

> The MCP server probes port `9223`; if nothing is listening it spawns Electron from the project root (detached) and waits for the WS server to come up, then delegates every call over WebSocket. The agent owns the full process lifecycle via `browse_quit`.

### Option B — raw WebSocket, no MCP

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser && npm install && npm start   # WS server on :9223

# talk to it from anywhere
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:9223');
ws.on('open', () => ws.send(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'ui.navigate',
  params: { url: 'https://www.zhihu.com' }
})));
"
```

### Raw WS ↔ MCP mapping

| Raw WS method | MCP tool | Notes |
|---|---|---|
| `ui.navigate` | `browse_navigate` | load any URL, `tab?` |
| `ui.get_tree` | `browse_get_tree` | semantic tree + context (modals, required marks, toasts) |
| `ui.act` | `browse_act` | click / type / clear / focus / hover / scroll_to |
| `ui.evaluate` | `browse_evaluate` | run JS in page (5000-char + Node-blocklist guards) |
| `ui.scroll` | `browse_scroll` | scroll page or element |
| `ui.wait` | `browse_wait` | block until button enabled / modal / URL change |
| `ui.subscribe` | `browse_subscribe` | live events: toast, captcha, state, network, dom, js_error |
| `ui.network_body` | `browse_network_body` | fetch HTTP response body via CDP cache |
| tabs | `browse_*_tab` | new/close/set_active/list |
| `ui.quit` | `browse_quit` | graceful shutdown of Electron |

---

## Why not screenshots?

Most browser agents are built on a **broken big picture**: "give the model a PNG and let it guess." That approach works at the demo level and dies at production scale.

| Capability | Screenshot + vision | Hard-coded selectors (Selenium/Puppeteer) | **AI Browser (DOM-first)** |
|---|---|---|---|
| Page structure | **guess** from pixels | fragile-by-id | **semantic tree** — every element typed & labeled |
| Transient toasts / errors | **missed** if they blink | missed | **pushed live** (`message_appeared`) |
| Red `*` required marks | maybe (if pixels are clear) | no | **read as data** (CSS `::before`) |
| Char limits "0/256" | maybe | no | **extracted into context** |
| Draft.js / ProseMirror / CKEditor | no | many fail | **trusted-keyboard input**, editor-agnostic |
| Network 403/404/500 | invisible | no | **CDP Network.enable**, bodies queryable |
| iframe editors | can't pierce | brittle | **recurses same-origin iframes** |
| Login persistence | re-login forever | re-login | **`persist:` partition**, survives restarts |
| Cost per step | vision tokens — expensive | cheap | **pure text tokens** |
| Latency | screenshot + OCR per step | fast | **IPC DOM tree, tens of ms** |

**The core insight:** a human "reads" a page with their eyes. An agent should read it with the **DOM**. Screenshots are an OCR problem in disguise; the semantic tree *is* the answer, and it's free to produce.

---

## How it feels like a human

It's not just reading—**actions are trusted browser input**, not JS hacks. Clicks and keystrokes go through the Chrome DevTools Protocol as if typed by a real user, so they work on any framework without special-casing:

- **Click** — scrolls the element into view, dispatches trusted `mousedown/up/click`, then *validates* the hit actually landed via `elementFromPoint`.
- **Type / setContent** — focuses, selects-all (with a native-Range fallback for sites that strip the select-all shortcut, like the Zhihu editor), clears via trusted Delete, then types char-by-char through **trusted `rawKeyDown→char→keyUp`**. Draft.js, ProseMirror, Quill, CKEditor, and plain `<textarea>` all just work—no per-editor code paths.
- **Window occlusion handled** — switches disable backgrounding so input isn't dropped when an IDE window sits on top.

This philosophy keeps the browser's core *generic* and pushes site-specific behavior into optional, on-demand **skills**—so the default tool list stays small (13 tools) and cheap on tokens.

---

## What it sees that others don't

`browse_get_tree` returns a semantic tree **plus** page context in one shot:

```json
{
  "tree": {
    "role": "textbox",
    "label": "请输入文章标题（5～100个字）",
    "value": "AI Browser test title",
    "states": ["visible", "focused"],
    "actions": ["type", "clear", "focus"]
  },
  "context": {
    "modals": [{ "header": "博主不存在", "buttons": ["确定"] }],
    "required_hints": ["0/256", "请选择", "*"],
    "messages": [{ "text": "发布成功", "type": "success" }],
    "session": { "logged_in": true },
    "stats": { "inputs": 20, "buttons": 35, "links": 94, "iframes": 2 }
  }
}
```

---

## Real sites, real flows, verified

| Site | Flow | Result |
|---|---|---|
| **Zhihu (知乎)** | Draft.js editor: bold, multi-paragraph body, clear, publish popup | **PASS** ✅ |
| **CSDN** | Full publish: title + CKEditor body + tags + summary + publish | **Published** ✅ |
| **Baidu (百度)** | Search → result page, 65 nodes, click | **PASS** ✅ |
| **East Money (东方财富)** | Stock lookup | **2,458 nodes** ✅ |
| **RoyalFlush (同花顺)** | Complex financial page, crash-resistant | **PASS** ✅ |
| **ModelScope (魔塔)** | Search + scroll | **508 nodes** ✅ |

---

## Architecture

```
                 External agent
        (Claude / Cursor / Codex / any MCP client)
          │  MCP stdio · 13 browse_*   │   WS JSON-RPC :9223 · ui.*
          ▼                             ▼
 ┌───────────────────────────────────────────────┐
 │ Electron main process                          │
 │  index.js         entry / tab strip            │
 │  ws_server.js      RPC routing / event stream  │
 │  page_manager.js   tabs · id-matched IPC       │
 │    CDP shared session (one attach/tab)         │
 │      Network.enable → network_response         │
 │      Runtime.enable → js_error (main world)    │
 └──────────────┬────────────────────────────────┘
                │ IPC (request-id matched)
 ┌──────────────▼────────────────────────────────┐
 │ preload (contextIsolation:true, sandbox)       │
 │  bridge.cjs    IPC wiring / dispatch           │
 │  extractor.cjs semantic tree / data-ai-id      │
 │  actions.cjs   click / setContent / submit...  │
 │  watcher.cjs   captcha / message scan timers   │
 └──────────────┬────────────────────────────────┘
                │ live DOM (data-ai-id)
 ┌──────────────▼────────────────────────────────┐
 │           WebPage → semantic tree              │
 │         (no screenshots anywhere)              │
 └────────────────────────────────────────────────┘
```

**One Electron process. One WebSocket port. One preload bridge.** No microservices, no Kubernetes, no screenshot pipeline, no vision-model bill.

Key engineering bets:

- **DOM-first extraction** — a semantic tree (typed, labeled, with live events) is radically cheaper and more reliable than pixel analysis.
- **Trusted CDP input** — real keyboard/mouse event streams, so complex editors need no framework-specific shims.
- **One plaintext transport** — WebSocket JSON-RPC; MCP is a thin stdio adapter over it, never a requirement.
- **Agent-owned lifecycle** — MCP probes the port, spawns Electron on demand, `browse_quit` releases it.
- **Security defaults** — `contextIsolation:true` + `nodeIntegration:false`; `evaluate` enforces a 5000-char cap and rejects `process.`/`require`/`child_process`.

---

## Compatibility

| Dimension | Support |
|---|---|
| **Agents** | Any MCP stdio client → Claude Code, Cursor, Codex, etc. Or raw WS from any language |
| **OS** | macOS · Linux (Electron; Windows expected to work, primary CI on macOS/Linux) |
| **Editors** | Draft.js · ProseMirror · Quill · CKEditor · plain `<textarea>/<input>` — via trusted input, no per-framework code |
| **Frameworks** | React / Vue / Angular / vanilla DOM — element locating is framework-agnostic |
| **Sites** | Any web page; SPA dynamic DOM supported via live tree + `dom_changed` events |
| **Node** | ≥ 18 (ESM) |

---

## Testing

```
vitest   100 passed · 5 skipped   (jsdom unit: extractor/actions/watcher)
smoke    31 PASS                  (real WebContents contract layer)
  ├─ evaluate under CSP / data-ai-id resolution / act hit-checking
  ├─ multi-tab: new → set_active → close
  ├─ rich editors setContent ×3 + submit/toggle
  ├─ observe: captcha / message / js_error (via CDP)
  ├─ network monitoring NF-1..5 (multi-client / unsub / tab-cleanup)
  └─ evaluate security guards SEC-1..3
```

`npm run smoke` boots a real Electron + HTTP fixture — offline, repeatable, non-zero exit on failure. It's the honest guardrail behind the "it just works" claim (it has caught regressions jsdom can't: preload ESM crashes, CSP-blocked `eval`, shared-debugger leaks).

---

## Contributing

This project is young and hungry. PRs that keep the core generic (not site-specific), harden reliability, or add verified site flows are very welcome.

- **Want it to blow up?** Star it, wire it into your agent, and open an issue with a site it *can't* do yet — that's the fastest way to grow the verified-flow table.
- **Style** — like it or not, engineering code must stay rigorous: id-matched IPC, guarded `evaluate`, reference-counted CDP sessions, no screenshots, no per-site hacks in the core.

---

## License

MIT © Glittering
# AI Browser

**An Electron browser that AI agents can use — without screenshots, without OCR, without guessing coordinates.**

Human sees a normal web page. AI gets a structured semantic tree via WebSocket JSON-RPC:

- Read any page: `ui.get_tree` → full semantic UI tree (roles, labels, actions, bounds)
- Click any button: `ui.act("click", "chat-submit-button")`
- Type in any input: `ui.act("type", "code_suggest", {text:"贵州茅台"})`
- Execute JavaScript: `ui.evaluate("document.title")`
- Extract articles: `browse_read_article` → title + all paragraphs

**No computer vision. No coordinate guessing. No brittle selectors.** Agent talks to the browser through a stable API, same API every website.

## Why

AI agents today interact with web pages by:
1. Taking screenshots and hoping a vision model guesses the right button
2. Hard-coding CSS selectors that break when the site redesigns
3. Injecting JavaScript hacks per-site

Every site works differently. Every approach breaks when the page changes.

**AI Browser solves this with one simple abstraction:** the browser itself extracts a semantic tree of interactive elements from the DOM. Labeled. Typed. Actionable. Agent reads the tree and acts on element IDs — works on Baidu, East Money, JD, 36kr, GitHub, any website, first try.

## What makes it different

| Other AI browser tools | AI Browser |
|---|---|
| Screenshot → vision model guesses | DOM → semantic tree. Exact, deterministic |
| CSS selectors (brittle) | Element IDs from tree (stable per session) |
| No action validation | `ui.act` returns `{success: true/false}` |
| Single-page hacks | Works on every page. 54 unit tests prove it |
| No captcha awareness | `captcha_appeared` event pushes to agent |

## Quick Start

```bash
git clone https://github.com/yourusername/ai-browser.git
cd ai-browser
npm install

# Start the browser (Electron window opens)
npm start

# In another terminal, test the API
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:9223');
ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'ui.navigate',
    params: { url: 'https://www.baidu.com' }
  }));
});
"
```

## API (WebSocket JSON-RPC 2.0, port 9223)

| Method | Params | Returns |
|---|---|---|
| `ui.navigate` | `{url}` | `{ok: true}` |
| `ui.get_tree` | `{focusedOnly?}` | `{tree: {id,role,label,actions,bounds,children}}` |
| `ui.act` | `{action, target, params?}` | `{success, error?}` |
| `ui.evaluate` | `{js}` | `{value}` |
| `ui.subscribe` | `{events: ["captcha_appeared"]}` | `{ok: true}` |
| `ui.get_focused` | `{}` | `{focused_element_id}` |

**Actions:** `click`, `type`, `clear`, `select`, `focus`, `hover`, `scroll_to`

**Events (push):** `captcha_appeared`, `dom_change`

## MCP Server (Claude Code / Cursor / Codex integration)

AI Browser exposes 5 MCP tools via stdio. Any MCP-compatible agent can browse the web.

```bash
npm run mcp
```

Exposed tools: `browse_navigate`, `browse_get_tree`, `browse_act`, `browse_evaluate`, `browse_read_article`

**Claude Code config (`.mcp.json`):**
```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["src/main/mcp_server.js"],
      "cwd": "/path/to/ai-browser"
    }
  }
}
```

## Real websites verified

| Website | Nodes extracted | Actions verified |
|---|---|---|
| Baidu | 65 (1 textbox, 1 button, 31 links) | Search "AI浏览器" → result page ✅ |
| East Money | 2,458 (992 links, 9 inputs) | Ty 股票代码 → stock page ✅ |
| JD.com | 37 semantic nodes | Login → captcha detected ✅ |
| 36kr.com | 30+ article links | Click article → full body extracted ✅ |
| 12306.cn | Slide captcha detected | `captcha_appeared` push verified ✅ |
| GitHub Trending | 14 repos parsed | `innerText` extraction ✅ |

## Architecture

```
┌─────────────────────────────┐
│  Electron (Chromium)         │
│  ┌─────────────────────────┐ │
│  │ Web Page (any site)     │ │
│  │   ↓ extractTree()       │ │
│  │   ↓ executeAction()     │ │
│  │ preload/bridge.js (CJS) │ │
│  └─────────────────────────┘ │
│         ↕ IPC                │
│  main/page_manager.js        │
│         ↕                    │
│  main/ws_server.js (9223)   │  ← Agent connects here
│  main/mcp_server.js (stdio) │  ← Claude Code/Cursor via MCP
└─────────────────────────────┘
```

## Test Coverage

```
54 passed · 4 skipped (need Electron running) · 0 failed
├── Protocol: 14 tests (JSON-RPC parsing, error codes)
├── Semantic Extractor: 16 tests (DOM→tree, hidden elements, containers)
├── Action Binder: 10 tests (click, type, scroll, dialog)
├── State Tracker: 9 tests (MutationObserver, text swaps, batch)
└── WS Protocol: 5 tests (real Electron RPC round-trip)
```

## Roadmap

- [x] Core semantic extraction + action binding
- [x] WebSocket JSON-RPC server
- [x] Captcha detection with push notification
- [x] MCP server (Claude Code integration)
- [ ] CDP (Chrome DevTools Protocol) bridge — attach to existing browsers
- [ ] Mobile browser via Android WebView
- [ ] Agent Skills open standard submission (`browse_web` skill)

## License

MIT
# AI Browser

**An Electron browser for AI agents. No screenshots. No OCR. Just the DOM.**

A human sees a normal page. An AI Agent gets a structured semantic tree — with element values, error toasts, red asterisks, character limits, iframe content, and real-time events — all pushed through a single WebSocket JSON-RPC port.

## Why AI Browser exists

Current AI browser tools try one of two approaches — both broken:

1. **Screenshot + vision model** (Playwright + GPT-4V, OpenAI Operator) — expensive, slow, misses transient toasts, can't read iframes, can't distinguish disabled buttons.
2. **Hard-coded selectors** (Selenium, Puppeteer) — break on every site redesign.

**AI Browser takes the DOM tree directly** and converts it into a semantic tree that an Agent can read. No image guessing. No brittle selectors. Works on any website, first try.

## What AI Browser sees that others don't

| Capability | Playwright + screenshots | OpenAI Operator | **AI Browser** |
|---|---|---|---|
| Page structure | Guess from image | Guess from image | **Semantic tree: 100+ nodes, typed, labeled** |
| Toast errors | Missed if transient | Missed if transient | **Real-time `message_appeared` push** |
| Red `*` required marks | Maybe (if screenshot clear) | Maybe | **CSS `::before` pseudo-element detection** |
| Character limits "0/256" | Maybe | Maybe | **Pattern extraction in context** |
| Draft.js / CKEditor | No | No | **`editor_type` detection + execCommand insertText** |
| Network API errors (403/404/500) | No | No | **CDP Network.enable, response bodies queryable** |
| Vue/React input | Type events may fail | Unreliable | **Native value setter + input/change events** |
| iframe editors (CKEditor) | Screenshot can't pierce | Can't see inside | **Recurse into same-origin iframes, extract body text** |
| Login persistence | Re-login every time | Re-login every time | **Electron `persist:` partition, survives restart** |
| Speed | Slow (screenshot + OCR per step) | Slow | **Fast (IPC DOM tree, tens of ms)** |
| Cost | Vision tokens every step | Expensive | **Pure text tokens, no vision overhead** |

## Real websites, real flows — verified

| Website | What we did | Result |
|---|---|---|
| **CSDN** | Full publish flow: title + CKEditor body + tags + summary + click publish | Published successfully ✅ |
| **Zhihu (知乎)** | Write page: Draft.js editor identified, execCommand insertText verified, all toolbar buttons (30) extracted | Full article ready to publish ✅ |
| **Baidu (百度)** | Search "AI Browser" → result page | 65 nodes, clicked ✅ |
| **East Money (东方财富)** | Stock code lookup | 2,458 nodes parsed ✅ |
| **Hithink RoyalFlush (同花顺)** | Complex financial page | 124 nodes after crash fix ✅ |
| **ModelScope (魔塔社区)** | Deepseek search + scroll | 508 result nodes ✅ |

## API (WebSocket JSON-RPC 2.0, port 9223)

```bash
npm start   # Electron window opens with WS server on :9223
```

### Core methods

| Method | What it does |
|---|---|
| `ui.navigate {url}` | Load any URL |
| `ui.get_tree {}` | Full semantic DOM tree + context (modals, required hints, stats) |
| `ui.act {action, target}` | Click, type, focus, scroll_to, set_content, clear |
| `ui.evaluate {js}` | Run arbitrary JS, return value |
| `ui.subscribe {events}` | Listen: `message_appeared`, `captcha_appeared`, `state_changed`, `network_response`, `dom_changed`, `js_error` |
| `ui.wait {condition}` | Wait until button becomes enabled / modal appears / URL changes |
| `ui.network_body {url_pattern}` | Fetch HTTP response body from CDP cache |

### Multi-tab API

| Method | What it does |
|---|---|
| `ui.new_tab {url}` | Open new tab, returns tab ID |
| `ui.close_tab {tab}` | Close tab, auto-switch to first remaining |
| `ui.set_active_tab {tab}` | Switch tabs |
| `ui.list_tabs {}` | List all tabs with titles and URLs |

### What `get_tree` returns

```json
{
  "tree": {
    "role": "textbox",
    "label": "请输入文章标题（5～100个字）",
    "value": "AI Browser 测试标题",
    "states": ["visible", "focused"],
    "actions": ["type", "clear", "focus"]
  },
  "context": {
    "modals": [{"header": "博主不存在", "buttons": ["确定"]}],
    "required_hints": ["0/256", "请选择", "*"],
    "messages": [{"text": "发布成功", "type": "success"}],
    "session": {"logged_in": true},
    "stats": {"inputs": 20, "buttons": 35, "links": 94, "iframes": 2}
  }
}
```

## Quick start

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser
npm install
npm start

# Test the API
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

## Architecture

```
┌─────────────────────────────────┐
│  Electron (Chromium)             │
│                                  │
│  any website DOM                 │
│       ↓                          │
│  preload/bridge.js (744 lines)   │
│    extractTree() → semantic tree │
│    extractPageContext() → modals │
│    executeAction() → type/click  │
│    bindObserver() → live events  │
│       ↕ IPC                      │
│  main/page_manager.js            │
│    multi-tab BrowserView         │
│    persist: session/cookies      │
│    CDP Network monitor           │
│       ↕                          │
│  main/ws_server.js (:9223)       │ ← Agent connects here via WebSocket
└─────────────────────────────────┘
```

**One Electron process. One WebSocket port. One preload bridge.** No microservices. No K8s. No screenshot pipeline.

## Test coverage

```
54 passed · 0 failed · 4 skipped (Electron-only)
├── Protocol: 14 tests (JSON-RPC parsing, error codes)
├── Semantic Extractor: 16 tests (DOM→tree, hidden, containers)
├── Action Binder: 10 tests (click, type, scroll, dialog)
├── State Tracker: 9 tests (MutationObserver, observer)
└── WS Protocol: 5 tests (real Electron RPC round-trip)
```

## Key improvements (v6 series)

- **v6.0**: Unified bridge.js — 1 file replaces semantic_extractor + action_binder + state_tracker
- **v6.1-v6.2**: Draft.js detection, state_changed events (MutationObserver attributeFilter)
- **v6.3**: Network monitoring via CDP (`network_response` event + `ui.network_body` API)
- **v6.4**: iframe recursion into same-origin contentDocument
- **v6.5-v6.7**: IPC routing fix, EXCLUDED_TAGS, critical var tag fix for complex pages
- **v6.8**: Field-level error association + JS error capture (`window.onerror` → `js_error` event)
- **v6.9**: iframe fallback scan + input `value` in tree nodes + clearCache on startup

## License

MIT
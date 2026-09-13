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
| `ui.navigate {url, tab?}` | Load any URL |
| `ui.get_tree {focusedOnly?, tab?}` | Full semantic DOM tree + context (modals, required hints, stats) |
| `ui.act {action, target, params?, tab?}` | Click, type, focus, scroll_to, set_content, clear |
| `ui.evaluate {js, tab?}` | Run arbitrary JS, return value |
| `ui.subscribe {events}` | Listen: `message_appeared`, `captcha_appeared`, `state_changed`, `network_response`, `dom_changed`, `js_error` |
| `ui.wait {condition, tab?}` | Wait until button becomes enabled / modal appears / URL changes |
| `ui.scroll {direction, amount?, target?, tab?}` | Scroll page or scroll element into view |
| `ui.network_body {url_pattern, tab?}` | Fetch HTTP response body from CDP cache |
| `ui.quit {}` | Gracefully shut down the Electron process |

### Multi-tab API

| Method | What it does |
|---|---|
| `ui.new_tab {url?}` | Open new tab, returns tab ID |
| `ui.close_tab {tab}` | Close tab, auto-switch to first remaining |
| `ui.set_active_tab {tab}` | Switch tabs |
| `ui.list_tabs {}` | List all tabs with titles and URLs |

## MCP server (Model Context Protocol)

AI Browser ships with an MCP server so any MCP-compatible agent (Claude Code,
Cursor, Codex) can drive the browser as a tool — **including owning the full
process lifecycle** (auto-launch on first call, auto-shutdown when done).

```bash
npm run mcp   # starts stdio MCP server; auto-spawns Electron if not running
```

### MCP tools (13)

> Kept intentionally small so the always-injected tool list stays cheap in
> per-message tokens. Low-frequency/flow capabilities live in `skills/` and
> are loaded on demand — see the two bundled skills at the end of this section.

| Tool | Description |
|---|---|
| `browse_navigate {url, tab?}` | Navigate active or specified tab to a URL |
| `browse_get_tree {focused_only?, tab?}` | Get the semantic tree of the page |
| `browse_act {action, target, text?, value?, tab?}` | Click / type / clear / focus / hover / scroll_to |
| `browse_evaluate {js, tab?}` | Run JS in page context (length + Node-identifier guard) |
| `browse_scroll {direction, amount?, target?, tab?}` | Scroll page or element |
| `browse_wait {condition, target?, text?, timeout_ms?, tab?}` | Wait until condition met |
| `browse_list_tabs {}` | List all open tabs |
| `browse_new_tab {url?}` | Open a new tab |
| `browse_close_tab {tab}` | Close a tab by id |
| `browse_set_active_tab {tab}` | Switch active tab |
| `browse_network_body {url_pattern, tab?}` | Fetch HTTP response body |
| `browse_subscribe {events}` | Subscribe to page events |
| `browse_quit {}` | Shut down the Electron process |

### Skills (on-demand)

Load only when the matching intent arises, keeping the default tool set lean:

- `skills/read-webpage/` — extract a page's main article (title + paragraphs)
  via `browse_evaluate`. Replaces the former `browse_read_article` tool.
- `skills/web-network-monitor/` — subscribe to page events and fetch API
  response bodies for request troubleshooting / forensics.

### Agent-driven lifecycle

The MCP server probes port 9223 on startup; if not listening, it spawns
`npm start` (detached) and waits up to 30s for the WS server to come up. The
agent can call `browse_quit` when done to release the Electron process. No
human needs to start or stop the browser — the agent owns the full lifecycle.

**Security:** `contextIsolation:true` + `nodeIntegration:false` block renderer
access to Node; `browse_evaluate` additionally enforces a 5000-char limit and
rejects Node-specific identifiers (`process.`, `require(`, `child_process`,
`globalThis.process`) as defense-in-depth.

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
┌───────────────────────────────────────┐
│ External agent (Claude/Cursor/Codex)   │
│   ├─ MCP stdio · 13 browse_* tools    │
│   └─ WS JSON-RPC · :9223 · ui.*       │
└──────────┬────────────────────────────┘
           ↕
┌──────────▼────────────────────────────┐
│ Electron main process                 │
│   index.js         entry / tab strip  │
│   ws_server.js     RPC route / events │
│   page_manager.js  tabs · IPC id match│
│     CDP shared session (one attach)   │
│       Network.enable → network_response│
│       Runtime.enable → js_error (main)│
└──────────┬────────────────────────────┘
           ↕ IPC (request-id matched)
┌──────────▼────────────────────────────┐
│ preload (contextIsolation:true)       │
│   bridge.cjs     IPC wiring / dispatch│
│   extractor.cjs  semantic tree / ai-id│
│   actions.cjs    click/setContent/... │
│   watcher.cjs    captcha/message scan │
└──────────┬────────────────────────────┘
           ↕ DOM data-ai-id (live)
┌──────────▼────────────────────────────┐
│ DOM → semantic tree (no screenshots)  │
└───────────────────────────────────────┘
```

**One Electron process. One WebSocket port. One preload bridge.** No microservices. No K8s. No screenshot pipeline.

- **preload 分层（dev）**：单文件 `bridge.js` 已拆为 `bridge.cjs`（IPC 接线）+ `extractor.cjs`（语义树/`data-ai-id`）+ `actions.cjs`（click/setContent·富编辑器/toggle/submit）+ `watcher.cjs`（captcha/message 扫描）。
- **CDP 统一会话（dev）**：`page_manager.js` 的 `_cdpTabs` 让每个 tab 只 `attach('1.3')` 一次，共享 Network 与 Runtime 两个 domain；会话级引用计数，末位才 teardown，订阅后新建 tab 自动继承。
- **`js_error` 归位（dev）**：preload 的 `window.onerror` 受 `contextIsolation` 隔离看不到页面主 world 异常（实际失效）——已改为主进程 CDP `Runtime.exceptionThrown` 广播 `js_error`，能捕获主 world 抛错。

## Test coverage

```
vitest  51 passed · 0 failed · 9 skipped   (jsdom 单测：extractor/actions/watcher 纯逻辑)
e2e smoke 27 PASS                          (真实 WebContents 契约层)
  ├─ evaluate under CSP / data-ai-id 回溯 / act 命中
  ├─ 多标签：new_tab → set_active_tab → close_tab
  ├─ 富编辑器 setContent ×3 + submit/toggle（AC-1..4）
  ├─ 观测：captcha/message + js_error（CDP）
  ├─ 网络监控 NF-1..5（多客户端 / 退订 / 关 tab 清理）
  └─ evaluate 安全护栏 SEC-1..3
```

`npm run smoke` 起本地 Electron + HTTP fixture，离线、可复跑、失败即非零退出；是"稳定"承诺的真实校验层（历史上 preload ESM 崩溃、CSP 禁 `eval` 两次回归都由它而非 jsdom 抓到）。完整黑盒/白盒用例与覆盖评估见 `docs/test_plan_blackbox_whitebox.md`。

## Key improvements (v6 series)

- **v6.0**: Unified bridge.js — 1 file replaces semantic_extractor + action_binder + state_tracker
- **v6.1-v6.2**: Draft.js detection, state_changed events (MutationObserver attributeFilter)
- **v6.3**: Network monitoring via CDP (`network_response` event + `ui.network_body` API)
- **v6.4**: iframe recursion into same-origin contentDocument
- **v6.5-v6.7**: IPC routing fix, EXCLUDED_TAGS, critical var tag fix for complex pages
- **v6.8**: Field-level error association + JS error capture (`window.onerror` → `js_error` event)
- **v6.9**: iframe fallback scan + input `value` in tree nodes + clearCache on startup
- **v6.10**: MCP server with 14 tools + auto-launch Electron + `browse_quit` lifecycle
- **v6.10.1**: IPC request id routing (replaces fragile FIFO matching under concurrent calls)
- **v6.10.2**: Process hardening — single-instance lock, `render-process-gone` logging, `no-sandbox` switch, `cleanupAndQuit` rejects pending IPC
- **v6.10.3**: `ui.scroll` argument escaping (no JS injection from `target`), `browse_evaluate` Node-identifier blocklist
- **dev (v6.11+)**: preload split into `bridge.cjs`+`extractor.cjs`+`actions.cjs`+`watcher.cjs`; `js_error` re-routed via CDP `Runtime.exceptionThrown` (preload `onerror` is dead under `contextIsolation`); MCP tool face cut 14→13 with lean schemas; shared per-tab CDP session `_cdpTabs`; real-WebContents smoke (27) + CSP-safe `evaluate` via CDP; click double-fire fixed; closeTab shared-debugger leak fixed

## License

MIT
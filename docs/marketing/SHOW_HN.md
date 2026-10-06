Show HN: AI Browser — the browser that swaps pixels for a semantic tree

Every AI agent that browses the web today does it the 2024 way:
1. Take a screenshot
2. OCR it to find text positions
3. Guess click coordinates from bounding boxes

Slow. Expensive. Brittle — one pixel of layout shift and every coordinate is wrong. Screenshots are an OCR problem in disguise.

AI Browser takes a different route: humans read pixels, agents read the DOM.

It's an Electron browser that renders a normal page for you AND exposes a structured semantic tree to agents over WebSocket JSON-RPC (port 9223) — or as an MCP server, so any MCP agent can drive it.

The agent asks "what's on the page?" and gets back not a PNG, but typed, labeled data:

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

Every element carries a stable `data-ai-id`. Click `e:div-60`, type into it, wait for a toast — all without ever touching a screenshot.

ACTIONS ARE TRUSTED INPUT, NOT JS HACKS

Clicks and keystrokes go through Chrome DevTools Protocol as if typed by a real user, so complex editors just work with no per-framework shims:

- Click scrolls the element into view, dispatches trusted mousedown/up/click, then validates the hit via elementFromPoint.
- setContent focuses, selects-all (with a native-Range fallback for sites that strip the select-all shortcut — Zhihu's editor drops Cmd+A), clears via trusted Delete, then types char-by-char through trusted rawKeyDown→char→keyUp.
- Draft.js, ProseMirror, Quill, CKEditor, plain <textarea> — all pass through the same path, framework-agnostic.

VERIFIED ON REAL SITES

- Zhihu: full article flow — Draft.js bold, multi-paragraph body, clear, publish popup ✅
- CSDN: title + CKEditor body + tags + summary + publish ✅
- Baidu: search → result page, 65 nodes, clicked ✅
- East Money: stock lookup, 2,458 nodes ✅
- RoyalFlush: complex financial page, crash-resistant ✅
- ModelScope: search + scroll, 508 nodes ✅

MCP BUILT-IN — ONE COPY-PASTE FOR YOUR AGENT

Claude Code / Cursor / Codex can drive it directly. Pick your agent, hand it this one-liner:

> I can browse the web with AI Browser (13 browse_* MCP tools). It auto-launches the Electron browser on first call and auto-shuts it down when done. Use browse_navigate to load a URL, browse_get_tree to read a page as a DOM tree, browse_act to click/type like a human, browse_evaluate to run JS, browse_wait to block until something appears.

Register it:

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["/abs/path/to/ai-browser/src/main/mcp_server.js"]
    }
  }
}
```

The MCP server probes port 9223, spawns Electron on demand, and releases it via browse_quit — the agent owns the full process lifecycle.

WHY NOT PLAYWRIGHT / PUPPETEER?

Playwright is Chrome, but headless and selector-brittle — it breaks on every site redesign. AI Browser is dual-output:
- Humans see normal pixels.
- Agents get a live semantic tree + event stream.

Human and agent share one browser instance. You browse; the agent reads.

ARCHITECTURE

```
External agent (MCP stdio · 13 tools │ WS JSON-RPC :9223)
        │
Electron main: index.js · ws_server.js · page_manager.js
        │  CDP shared session (Network + Runtime, one attach/tab)
        │  IPC, request-id matched
preload (contextIsolation): bridge.cjs · extractor.cjs · actions.cjs · watcher.cjs
        │  live DOM, data-ai-id
WebPage -> semantic tree   (no screenshots anywhere)
```

One process. One port. One preload bridge. No microservices, no screenshot pipeline, no vision-model bill. Pure text tokens — so it's cheap per step, too.

Guards: contextIsolation + nodeIntegration:false; browse_evaluate caps at 5000 chars and rejects process./require/child_process.

WHY THIS MATTERS NOW

Agents are becoming workers, not toys — this week's GitHub Trending is stacked with agent tooling. But most of it still feeds the agent screenshots + OCR, an approach from before agents were real.

AI Browser gives agents actual web senses at DOM fidelity. MIT license. 100 unit tests + 31 Electron smoke tests, all green.

URL: https://github.com/Glittering/ai-browser
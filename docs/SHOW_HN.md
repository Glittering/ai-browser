Show HN: AI Browser — a browser that AI agents can use without screenshots or OCR

Right now, every AI agent that needs to interact with the web does it by:
1. Taking a screenshot
2. Running OCR to find text positions
3. Guessing click coordinates from bounding boxes

Slow, expensive, brittle. When the page changes by 1 pixel, the coordinates are wrong.

AI Browser takes a different approach.

It's an Electron browser that renders a normal web page for humans AND exposes a structured semantic tree API for AI agents via WebSocket JSON-RPC.

The agent asks "what's on the page?" and gets back:

```json
{
  "role": "link",
  "name": "Stepfun releases Agent-native OS",
  "ref": "@e42",
  "rect": {"x": 100, "y": 200, "w": 300, "h": 24}
}
```

Then: click("@e42"). Done. No screenshot needed. No OCR. Pixel-precise but without CV.

VERIFIED ON REAL SITES

- Baidu: full search pipeline (type → click → results page) ✅
- Eastmoney: 2,458 semantic nodes, 283 news headlines extracted ✅
- 36Kr: article reading (Stepfun, Tencent ADP, Meta layoffs) ✅
- JD.com / 12306: captcha detection + real-time push notification ✅
- GitHub Trending: weekly top repos scraped ✅
- 54 unit tests, all green

MCP (MODEL CONTEXT PROTOCOL) BUILT-IN

Claude Code / Cursor / Codex can use it directly:

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["src/main/mcp_server.js"]
    }
  }
}
```

5 MCP tools exposed: navigate, get_tree, act, evaluate, read_article.
The agent just says "read this article for me" — AI Browser does it and returns structured data.

WHY NOT PLAYWRIGHT?

Playwright is Chrome. But headless-only — made for machines.

AI Browser is dual-output:
- Humans see normal pixels
- Agents get semantic tree + ActionMap + WS event stream

Human and agent share the same browser instance. You browse, the agent reads.

ARCHITECTURE

```
Electron (Chromium)
  Web Page (normal rendering)
    Preload Bridge (CJS)
      extractTree() → structured DOM → IPC → WS server (port 9223)
      executeAction() → click, type, focus, scroll
      scanCaptcha() → MutationObserver → captcha push notification
  Main Process
    page_manager (async IPC)
    ws_server (JSON-RPC)
    mcp_server (stdio)
```

QUICK START

```
git clone https://github.com/Glittering/ai-browser
cd ai-browser
npm install
npm start
```

WHY THIS MATTERS NOW

This week's GitHub Trending top 6 are ALL Agent tooling:
- AI job search framework (13k stars/week)
- Agent-native Office suite (7k stars/week)
- Parallel agent fleet manager (5.7k stars/week)
- Free AI Gateway with 231+ providers (4.3k stars/week)

Agents are becoming workers, not toys. But they're all still using screenshot+OCR from 2024.

AI Browser gives them real web senses.

MIT license. 1,249 lines of core code. 54 tests. MCP-native.

URL: https://github.com/Glittering/ai-browser
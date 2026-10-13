Show HN: AI Browser — a persistent co-pilot browser your agent drives over MCP

Hi HN. I built an Electron browser where the agent is the only driver, but the
window is a normal, visible browser that a human stays logged into and can grab
the mouse from at any second. It exposes pages as a semantic tree over MCP
(17 tools) or raw WebSocket JSON-RPC — no screenshots, no OCR, no coordinate
guessing.

THE PROBLEM I ACTUALLY HAD

Playwright MCP is great and I use it — it reads the accessibility tree and can
run headed. But it is an *automation instance*: a fresh browser per run,
ephemeral profile, built for scripts and tests. My use case was different: I
wanted Claude Code/Cursor to work in the same browser I do — the one already
logged into my accounts, sitting open on my desktop — and when it hits a QR
login, a slider CAPTCHA, or a payment confirmation, I just do that bit myself
and tell it "done".

That hand-off is not an API. It's a sentence in the conversation. The browser
doesn't coordinate anything; it just never gets in my way.

WHAT THE AGENT SEES

Instead of a PNG, the agent gets typed, labeled data. Every element carries a
stable data-ai-id:

```json
{
  "tree": {
    "role": "textbox",
    "label": "请输入文章标题（5～100个字）",
    "value": "AI Browser test title",
    "states": ["visible", "focused"],
    "actions": ["type", "setContent", "clear", "focus"]
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

ACTIONS ARE TRUSTED INPUT, NOT SYNTHESIZED JS

Clicks and keystrokes go through CDP (Input.dispatchMouseEvent /
dispatchKeyEvent, char-by-char rawKeyDown→char→keyUp), then the click is
validated with elementFromPoint. Draft.js, ProseMirror, Quill, CKEditor and
plain textareas all work through the same path — no per-framework shims.
Pointer gestures (drag, wheel, key press) are first-class too, because
synthetic PointerEvents move exactly nothing in frameworks that use Pointer
Capture (measured: 0,0 on a React Flow canvas).

THE THREE THINGS THAT ARE GENUINELY DIFFERENT

1. Persistent and human-shared. Sessions live in a persist: partition; logins
   survive restarts, so a human usually steps in once per site, ever. The
   window never steals focus while the agent drives (showInactive on
   agent launch, focus emulation keeps lazy-loading working). I test this from
   the outside with macOS lsappinfo — a full API slice runs while another app
   holds the foreground, and a deliberate focus-stealing control group keeps
   the suite honest.

2. Verification is a primitive. A tool returning success is not evidence —
   overlays eat clicks, apps revert edits, canvas UIs repaint without touching
   the DOM. browse_diff snapshots a baseline and returns an explicit
   changed/unchanged verdict with before/after values and JSON paths. It also
   fingerprints the page's own data model, so writing node.widgets[].value in
   ComfyUI (which moves the DOM by zero bytes) is caught as changed — while a
   throwing expression or empty snapshot returns an explicit error instead of
   silently making every later diff report false green.

3. Canvas without pixels. A recorder tees the 2D Canvas API, so fillText hands
   us the literal strings drawn — text inside canvas needs no OCR. It never
   takes over the native call, so a recording failure can't change rendering.
   WebGL is marked opaque; only there does an explicit capture return a PNG,
   and it costs your vision tokens, off by default.

VERIFIED ON REAL SITES

- Zhihu: full article flow in Draft.js — bold, multi-paragraph body, clear
  (it strips Cmd+A; we fall back to a native Range select), publish popup
- CSDN: title + CKEditor body + tags + summary + publish
- Baidu search; Bing search end-to-end (type → Enter → results URL)
- East Money stock pages (2,458 semantic nodes), RoyalFlush, ModelScope

PRACTICAL DETAILS

- MCP server auto-launches Electron on first call; browse_quit releases it.
  Or run `npx -y @glittering0717/ai-browser start` once and every client shares
  the window.
- Network inspection captures from tab open, including POST bodies, no
  subscription; auth/cookie headers redacted by default.
- Safety: contextIsolation + nodeIntegration:false; evaluate is capped at 5000
  chars and rejects process./require/child_process, identically on both
  transports.
- macOS and Linux; Windows is untested (plain Electron + CDP, ought to work).
- 411 unit tests (27 files) plus 11 Electron e2e suites / 409 assertions that
  boot a real browser against offline fixtures — focus behavior, trusted
  gestures, rich-text editors, canvas, network, diff false-greens. All green.

INSTALL (Node ≥ 18)

npx -y @glittering0717/ai-browser mcp   # MCP clients: command "npx", args ["-y","@glittering0717/ai-browser","mcp"]

First run prepares the Electron engine once (~100 MB). npm >= 11 blocks
dependency install scripts by default; the launcher self-heals that. China
network: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ helps with
the binary download. git clone still works too.

Happy to answer anything — especially "how is this different from Playwright
MCP" (short version: ephemeral test instance vs persistent human-shared
browser; selectors/AX tree vs semantic tree with a verification contract;
nothing vs human hand-off). MIT licensed.

URL: https://github.com/Glittering/ai-browser

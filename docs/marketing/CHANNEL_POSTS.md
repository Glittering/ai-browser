# D+1~D+3 渠道发帖包（即取即用）

> 纪律：每篇都是可直接粘贴的终稿；标题给 2 个候选；发帖时间为北京时间。
> 发帖后把真实链接回填到文末"投放记录"。

---

## 1. Reddit · r/ModelContextProtocol（D+1 周二 22:00 = 美东周二 10:00）

**Flair:** Show / Project（如可选）

**Title A:** I built a visible, persistent browser an agent drives via MCP — semantic tree, no screenshots
**Title B:** Show HN-ish: co-pilot browser for MCP agents — you keep the logged-in window, it never steals focus

**Body:**

I kept hitting the same wall: browser MCP servers give my agent an ephemeral automation instance, but my real logins, 2FA prompts and slider CAPTChAs live in the persistent browser on my desktop. So I built the opposite shape: a normal visible Electron browser that stays open and logged in, exposes pages as a semantic accessibility tree over 17 `browse_*` MCP tools (plus raw WebSocket JSON-RPC), and lets a human grab the mouse at any second.

- Agent gets typed/labeled nodes with stable IDs — no PNG, no OCR, no coordinate guessing
- Clicks/keys go through CDP as trusted input (Draft.js, ProseMirror, Quill, CKEditor all use the same path); gestures validated with elementFromPoint
- `browse_diff` is a verification primitive: explicit changed/unchanged verdict + page-data fingerprints, so canvas apps that move zero DOM bytes are still caught
- Canvas text is tee'd at the 2D draw-call layer (fillText strings, no OCR); WebGL stays the only pixel path, off by default
- Window launches with showInactive + focus emulation — a full API slice runs while another macOS app holds the foreground (verified externally via lsappinfo)
- Control port is loopback-only; 428 unit tests + 428 Electron e2e assertions, all green

Install: `npx -y @glittering0717/ai-browser mcp`
Registry: `io.github.Glittering/ai-browser` · repo: https://github.com/Glittering/ai-browser

Honest caveats: macOS/Linux today (Windows untested), and if your target is literally stock-Chrome DevTools automation, chrome-devtools-mcp overlaps a lot — I wrote the comparison in the README. Happy to take questions here.

---

## 2. Reddit · r/ClaudeAI（D+2 周三 22:00）

**Title A:** Letting Claude Code use my real logged-in browser (without taking it over)
**Title B:** My MCP browser for Claude Code: visible window, semantic tree, human can grab the wheel mid-task

**Body:**

I wanted Claude Code to work in the same browser I do — already logged into everything, sitting open on my desktop — and when it hits a QR login / slider / payment step, I just do that part myself and say "done". No handoff API, no permission popup, it just waits.

Released it as an MCP server (17 `browse_*` tools):

- `browse_navigate` / `browse_get_tree` — page as semantic nodes, not screenshots (way cheaper tokens, no vision needed)
- `browse_act` — trusted CDP clicks and char-by-char keystrokes; works in rich text editors without per-site hacks
- `browse_diff` — snapshots before/after and returns an explicit changed/unchanged verdict with JSON paths; this killed most of my "Claude said it clicked but nothing happened" loops
- `browse_wait`, network capture with bodies (auth headers redacted), 12 more
- First call auto-launches Electron; `browse_quit` releases it. It never steals focus while driving.

Config:

```json
{ "mcpServers": { "ai-browser": { "command": "npx",
  "args": ["-y", "@glittering0717/ai-browser", "mcp"] } } }
```

Or just tell Claude: "You may use AI Browser (17 browse_* MCP tools). It auto-launches a visible Electron browser; call browse_quit when done."

Repo + demo GIF: https://github.com/Glittering/ai-browser · MIT
Verified flows: Zhihu article publishing in Draft.js, CSDN + CKEditor, Baidu/Bing search, finance portals. macOS/Linux; Windows untested. Feedback very welcome.

---

## 3. V2EX · 分享创造（D+1 周二 12:30 午休流量峰）

**标题 A：** [开源] 给 AI Agent 用的"副驾浏览器"：不截图，直接读语义树
**标题 B：** 做了个 Electron 浏览器：Agent 走 MCP 驱动，人随时能接管鼠标

**正文：**

做 Agent 工具时发现一个别扭：Playwright MCP 这类方案每次起一个干净的临时浏览器，跑完即弃；但我的登录态、扫码、滑块都在桌面上那个常驻浏览器里。

于是换了个形态做了个开源项目——AI Browser：

- 一个正常可见的 Electron 窗口，常驻、持久登录，通过 17 个 browse_* MCP 工具或原始 WS JSON-RPC 驱动
- Agent 看到的不是截图，是带 role/label/稳定 ID 的语义树，不花视觉 token
- 点击输入走 CDP 受信输入，Draft.js / ProseMirror / Quill / CKEditor 同一条通道，不做网站特判
- browse_diff 把"验证操作生效"做成原语：显式 changed/unchanged + 页面数据模型指纹，ComfyUI 那种只改 canvas 数据不动 DOM 的也能抓到
- Agent 后台操作不抢焦点（showInactive，用 macOS lsappinfo 外部测过）；遇到扫码/支付，人直接动鼠标接管即可
- canvas 文字在 2D 绘制层直接截 fillText，不用 OCR

真实站点验证过知乎文章全流程（Draft.js）、CSDN（CKEditor）、百度/Bing、东方财富（2458 节点）。428 单测 + 428 个 Electron e2e 断言全绿。

安装：`npx -y @glittering0717/ai-browser mcp`（Node ≥ 18，首次约 100MB 引擎准备；国内网络可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）

项目：https://github.com/Glittering/ai-browser
已收录官方 MCP Registry：io.github.Glittering/ai-browser

macOS/Linux 已测，Windows 还没测。欢迎拍砖，也特别想听听你们"Agent + 浏览器"实际卡在哪。

---

## 4. linux.do（D+2 周三 21:00 晚高峰）

**分类：** 开发调优（没有合适的就放 资源荟萃，标题不加【引流】等标签）

**标题：** [开源] 一个不截图、用语义树驱动的常驻浏览器，给 MCP Agent 当"副驾"

**正文：**

各位好，分享一个自用转开源的项目，先说清楚它解决什么问题，不做夸大宣传。

**痛点**：用 Claude Code / Cursor 配浏览器类 MCP 时，现成方案（Playwright MCP 等）起的是临时干净实例，登录态、人机验证都得重来；而纯截图+坐标的方案又慢又脆。

**AI Browser 的做法**：

1. Electron 常驻可见窗口，独立持久分区，扫码登录一次长期有效
2. Agent 侧拿语义树（role/label/states/稳定元素 ID），全程不需要截图和 OCR
3. 操作走 CDP 受信输入，富文本编辑器不做框架适配
4. browse_diff 原语返回显式的变更判定，避免"返回 success 但实际没点上"
5. 人随时可以接管鼠标，agent 操作时窗口不抢焦点
6. 端口只绑 127.0.0.1（无鉴权，安全上别转发该端口）

**接入**（stdio）：

```json
{ "mcpServers": { "ai-browser": { "command": "npx",
  "args": ["-y", "@glittering0717/ai-browser", "mcp"] } } }
```

Node ≥ 18；Linux 已在 e2e 覆盖（X11/Wayland 下 Electron 常规要求）。也可以走 `ws://127.0.0.1:9223` 原始 JSON-RPC，不用 SDK。

仓库：https://github.com/Glittering/ai-browser （MIT，428 单测 + 12 套 Electron e2e 全绿，已收录 MCP 官方 Registry）

不确定的地方也如实说：Windows 未测；和 chrome-devtools-mcp 定位有重叠，README 里写了对比和各自适用场景。欢迎试用反馈。

---

## 5. NodeSeek（D+3 周四 21:30）

**标题：** 开源个 Electron 浏览器：AI Agent 走 MCP/WS 驱动，不截图直接读 DOM 语义树

**正文：**

给折腾 Agent 的哥们分享个工具，MIT 开源。

一句话：桌面上常驻一个可见浏览器，Agent（Claude Code/Cursor/Codex）通过 17 个 MCP 工具或裸 WebSocket JSON-RPC 操作它，读的是语义树不是截图，扫码/人机验证时你自己伸手接管就行。

几个实用点：

- npx 一条命令接入，首次自动准备 Electron 引擎（国内可 ELECTRON_MIRROR 走 npmmirror）
- 持久登录分区，不用每次重新扫码
- CDP 受信输入，知乎 Draft.js / CSDN 的 CKEditor 都实测过发布全流程
- 网络抓包自带 POST body，authorization/cookie 默认打码
- browse_diff 能证明操作真的生效，不会"假装成功"
- 控制端口默认只听 127.0.0.1，注意别把 9223 转发出去（协议没鉴权）

`npx -y @glittering0717/ai-browser mcp`

https://github.com/Glittering/ai-browser

macOS/Linux 可跑，Windows 未测。有问题直接 issue。

---

## 投放记录

| 渠道 | 计划时间 | 实际链接 | 备注 |
|---|---|---|---|
| r/ModelContextProtocol | D+1 22:00 | | |
| r/ClaudeAI | D+2 22:00 | | 注意账号 karma 门槛 |
| V2EX 分享创造 | D+1 12:30 | | |
| linux.do | D+2 21:00 | | 需 trust level 1 |
| NodeSeek | D+3 21:30 | | |

# D+1~D+3 渠道发帖包（即取即用）

> 纪律：每篇都是可直接粘贴的终稿；标题给 2 个候选；发帖时间为北京时间。
> 发帖后把真实链接回填到文末"投放记录"。
> 渠道变更（2026-10-16）：**linux.do / NodeSeek 放弃**（均需推荐码，本人没有）——原第 4、5 节作废，火力并入知乎/掘金技术长文（见 PR_ZHIHU.md / PR_JUEJIN.md）；B 站视频与头条稿见 PR_BILIBILI.md / PR_TOUTIAO.md。

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

## 4. ~~linux.do~~ —— ❌ 已放弃（2026-10-16）

注册需推荐码/邀请制，本人没有。原帖文已删除，火力并入掘金技术长文（PR_JUEJIN.md）与知乎稿（PR_ZHIHU.md）。

---

## 5. ~~NodeSeek~~ —— ❌ 已放弃（2026-10-16）

注册需推荐码，本人没有。原帖文已删除，火力并入掘金技术长文（PR_JUEJIN.md）。

---

## 6. 国内平台（终稿见各自文件）

| 平台 | 终稿 | 物料 | 计划 |
|---|---|---|---|
| 知乎 | PR_ZHIHU.md | img_cover_zhihu.jpg | D+1～D+2 |
| B 站 | PR_BILIBILI.md | demo_vertical.mp4（46s 竖屏）+ img_cover_bilibili.jpg | D+2 |
| 掘金 | PR_JUEJIN.md（技术长文） | 语义树 JSON 片段 | D+2（中文长尾主件） |
| 头条 | PR_TOUTIAO.md | img_cover_toutiao.jpg | D+3 |

---

## 投放记录

| 渠道 | 计划时间 | 实际链接 | 备注 |
|---|---|---|---|
| r/ModelContextProtocol | D+1 22:00 | | showcase flair + 披露作者身份 |
| r/ClaudeAI | D+2 22:00 | | 注意账号 karma 门槛 |
| V2EX 分享创造 | D+1 12:30 | | 老账号 No.20622 |
| 知乎文章 | D+1～D+2 | https://zhuanlan.zhihu.com/p/2094594014632793355 | ✅ 2026-10-17 00:20 已发布；踩坑：CMD+V 合成键不触发 Chromium 原生粘贴（CDP 直达渲染器、不过浏览器进程加速键），最终用合成 ClipboardEvent+DataTransfer(text/html) 派发 paste，Draft.js DraftPasteProcessor 全格式转换（6 h2/6 代码块/48 加粗 span/7 列表项） |
| 掘金长文 | D+2 | https://juejin.cn/post/7697024318929633320 | ✅ 2026-10-16 21:00 已发布（分类"人工智能"+标签"人工智能"）；草稿箱已无该文；踩坑：发布弹窗"添加标签"为必填（红*），缺标签时前端静默失败、仅弹行内错误"至少添加一个标签"，曾误判"发布成功" |
| B 站视频 | D+2 | | 46s 竖屏已就绪 |
| 头条 | D+3 | | 账号已登录 |
| CSDN 博客 | D+1 | （未发布） | ❌ **2026-10-17 03:00 复核：此前记录的原因(草稿已存/发布按钮无响应/401)全部作废 —— 真相是登录态已丢失**。`editor.csdn.net/md/` 与 `mp.csdn.net` 均 302 到 `passport.csdn.net/login?code=applets`，`www.csdn.net` 顶部明写"未登录"；cookie 里只剩 `uuid_tt_dd`/`fid`/`UN` 等埋点 cookie，无 `UserName`/`UserInfo`/`UserToken`；`localStorage` 中也没有任何草稿残留 —— 所谓"5086 字已写入并自动存草稿"从未真正落到服务器，且当时未验证就写入记录。**发布按钮无响应的真因大概率是会话中途失效，而非 bizapi 401**（401 只是会话失效后同一现象的上游表现）。另有：高频自动化触发了 CSDN 滑块人机验证。**需本人重新登录一次，登录后由 agent 重新注入正文发布** |
| 头条文章 | D+3 | https://www.toutiao.com/article/7697326423064773160/ | ✅ 2026-10-17 01:59 已提交，**02:40 已过审变为"已发布"**（pgc_id=7697326423064773160，首发标记）；走通「预览并发布→确认发布」两段式流程；ProseMirror 合成 paste（text/html）注入成功 |
| B 站视频 | D+2 | https://www.bilibili.com/video/BV15RJb6oERJ/ | ✅ 2026-10-17 02:30 已投递成功（demo_vertical.mp4 + img_cover_bilibili.jpg 封面 + 标题/简介/6 标签/创作声明"内容无需标注"）；BV15RJb6oERJ 已分配、页面已上线（转码中，标题待同步）；提示"个人空间封面 16:9 未修"（4:3 已确认，可后续编辑修补） |
| ~~linux.do~~ | — | — | ❌ 放弃（需推荐码） |
| ~~NodeSeek~~ | — | — | ❌ 放弃（需推荐码） |
| B 站图文（专栏） | D+2 | https://www.bilibili.com/opus/1259878383752314888 | ✅ 2026-10-17 03:00 已发布（标题《给 AI 装了一个"浏览器"，它自己会写稿发稿了》，正文 2589 字）。**关键纠正**：此前判定"B站文章编辑器 SPA 挂空、不可用"是错的 —— 真正入口是 `/platform/upload/text/edit`（会 302 到 `/text/new-edit`），正文编辑器在**跨进程 iframe** `member.bilibili.com/york/read-editor` 里，`ui.get_tree` 必须带 `ax:true` 才会做 OOPIF 合并并暴露 `editor=richtext` 节点，同时要等足 ~25s。走 image=封面非必填；话题弹窗搜索无候选已跳过。发布后出现"点击查看"按钮，随后自动跳转 `upload-manager/opus` |

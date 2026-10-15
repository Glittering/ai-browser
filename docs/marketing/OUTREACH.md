# 定向邀请包（10+ 个高匹配触点，全部附即用话术）

> 原则：每条评论必须**本身就有信息价值**、第一句披露作者身份、只在痛点高度相关时发。
> 时机：D-Day Show HN 发出后 24h 内执行（带着 HN 讨论帖链接，观感是"相关工作"而非裸推销）。
> 执行方式：你说"发"，我用 Glittering 账号逐条评论；也可以你自己改后发。

---

## A 类：GitHub 竞品仓库痛点 issue（4 个，匹配度最高）

### A1. browserbase/stagehand #2148 — "headed mode steals window focus on every command"
URL: https://github.com/browserbase/stagehand/issues/2148
同主题：#2918（Windows 下 daemon 闪窗抢焦点）

**评论草稿：**

> Hit the same wall building another MCP-driven browser. What ended up working: launch the window with `showInactive: true` so it never activates on launch, and for actions that need layout/lazy-loading to behave (focus-driven IntersectionObserver, autofocus side effects), emulate focus state in-page rather than calling `BrowserWindow.focus()`. The click path still goes through trusted CDP Input events. We verify it externally on macOS with `lsappinfo` — run a full action slice while Calculator holds the foreground, assert foreground never changes, plus a deliberate focus-stealing control group so the test can't fake-green. Details + the focus suite are here if useful: https://github.com/Glittering/ai-browser (disclaimer: I'm the author; not a Stagehand patch, just a reference approach).

### A2. ChromeDevTools/chrome-devtools-mcp #2856 — "Server-level default for new_page background, for agents sharing one visible browser"
URL: https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2856

**评论草稿：**

> +1 to the "one visible browser shared by agents" model — it's the same architecture I ended up with after trying per-agent instances. Sharing one persistent window here: a tiny launcher probes the control port and, if nothing listens, starts the visible browser once; every MCP client (Claude Code, Cursor, CLI over raw JSON-RPC) then attaches to the same window, and `browse_quit` releases it. New navigations reuse the active tab or open background tabs without raising the window. It's MIT-licensed at https://github.com/Glittering/ai-browser in case the design is useful as a reference for this feature. (Author here — happy to answer questions about the lifecycle handling.)

### A3. ChromeDevTools/chrome-devtools-mcp #3020 — "Concurrent sessions lose auth state with --isolated"
URL: https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3020

**评论草稿：**

> FWIW, the persistent-shared-profile direction solves this class of issue by construction, at the cost of explicit human hand-off: I built a browser where sessions live in one persistent `persist:` partition shared by all clients, so logins survive restarts and concurrent agents never fight over profile locks — and when auth needs a human (QR, slider, SSO), the person just uses the same visible window mid-task. The trade-off vs isolated copies is worth stating: you give up per-session isolation. Reference implementation: https://github.com/Glittering/ai-browser (I'm the author).

### A4. browserbase/stagehand #1250 — "Storage state persistence broken in v3: userDataDir doesn't work, storageState() missing"
URL: https://github.com/browserbase/stagehand/issues/1250
状态（D-4 核查）：OPEN，8 条评论，2026-09-08 仍活跃。与 A3 主题相近但受众不同（Stagehand 用户），角度聚焦"不做 storageState 存取的另一种活法"。
> 注：原 A4 目标 playwright-mcp #1773 已于 2026-09-25 被以 NOT_PLANNED 关闭，关闭 issue 下发自荐观感差，已替换为本条（D-4 核查，2026-10-16）。

**评论草稿：**

> Author of a neighboring project here — hit the same class of problem and ended up with a different shape. Instead of snapshotting/restoring storage state, the browser just runs against one persistent `persist:` partition (Electron's session API) for its whole lifetime: every client attaches to the same window and profile, so cookies / IndexedDB / localStorage accumulate in place and there is no save-or-restore step that can break. When a site needs an interactive login (2FA, slider, SSO), the human does it once in the visible window and it sticks across restarts. Honest trade-offs: no per-session isolation, you can't ship the profile into CI, and it assumes a single-user desktop — for ephemeral parallel runs, storageState is still the right model. MIT reference implementation: https://github.com/Glittering/ai-browser (I'm the author; happy to share the session-lifecycle code if useful).

---

## B 类：Hacker News 相关旧帖（D+1 留 1 条相关评论即可，勿群发）

按优先级（评论数 = 受众量）：

1. https://news.ycombinator.com/item?id=46901233 — Smooth CLI（74 评）：差异点是"可见常驻+人工接管+语义树原语"，不要在评论里争论 token 效率
2. https://news.ycombinator.com/item?id=47890841 — Browser Harness（66 评）
3. https://news.ycombinator.com/item?id=47336171 — Open-source browser for AI agents（55 评）
4. https://news.ycombinator.com/item?id=47358970 — Auto-Browser "with human takeover"（先读其方案，评论时精确说清差异，避免被当成撞车营销）

**评论通用结构（80–120 词英文）：**
1. 对楼主具体设计点的真实评价/问题（证明读过）
2. 一句"We took a different trade"：常驻可见窗口 / 显式验证原语 / canvas 绘制层文本
3. 链接 + 披露 "I'm the author"
4. 绝不在一个帖子刷多条，绝不对零评论帖灌水

---

## C 类：中文 KOL / 社群（你来选熟人渠道，我备话术）

不做陌生账号群发（举报风险高、转化差）。建议触点类型与执行：

| 触点类型 | 找谁 | 怎么触达 |
|---|---|---|
| 知乎 | 答过"Claude Code 实测""MCP 是什么""AI 浏览器"的千赞答主（3–5 位） | 评论区先提供有信息量的补充，再私信发中文话术 |
| 即刻 | "AI 探索站""独立开发者"圈子里发过 Agent 工作流的创作者 | 发一条自己的动态 @ 1–2 位有过互动的，不群发 |
| B 站 | 做 Claude Code / Cursor 工作流视频的 UP（已有 PR_BILIBILI.md 评论稿） | 评论区置顶作者留言 + 私信求试用 |
| 微信/飞书群 | 你所在的 Agent/独立开发者群（2–3 个） | 群里发中文短介绍 + 一条 demo GIF，不要同一文案多群刷 |

**中文私信话术（复制即用）：**

> 你好，我做了个开源项目 AI Browser，看你之前写过 Claude Code/MCP 实操内容觉得你会感兴趣：它是一个常驻可见的浏览器，Agent 通过 17 个 MCP 工具读语义树操作（不截图、不 OCR），扫码支付时人能随时接管。知乎/CSDN 的富文本发布流程都实测过。刚上了 npm 和 MCP 官方 Registry，npx 一条命令能跑。方便的话想请你试用拍砖，任何吐槽都欢迎。https://github.com/Glittering/ai-browser

---

## D 类：直接受益用户（npm/GitHub 数据驱动，D+7 执行）

发布后 1 周，从以下来源筛真实使用者并回复感谢+求反馈：

- npm 周下载量出现后的下载者无法直接看到，改为：GitHub 上 star / issue / discussion 的用户
- awesome-mcp-servers PR 下互动的维护者
- mcpservers.org 审核通过后页面上的 early reviewer

话术：感谢 + 一个具体问题（"你最想让 agent 在哪个网站干活？"），不要直接求 star。

---

## 执行记录

> D-4（2026-10-16）触点核查：A1 #2148 OPEN（1 评，7 月后沉寂）；A1b #2918 OPEN；A2 #2856 OPEN（10-14 仍活跃）；A3 #3020 OPEN（10-09 活跃）；A4 已从关闭的 playwright-mcp #1773 换为 stagehand #1250（OPEN，8 评）。punkpeye PR #16354 仍 OPEN（10-13 更新）。周刊三 issue 均 OPEN 无回复（ruanyf/weekly #12388、HelloGitHub #3978、GitHubDaily #1213）。

| 触点 | 计划 | 状态/链接 |
|---|---|---|
| A1 stagehand #2148 | D+1 | OPEN 已核查，草稿就绪 |
| A2 cdp-mcp #2856 | D+1 | OPEN 已核查，草稿就绪 |
| A3 cdp-mcp #3020 | D+1 | OPEN 已核查，草稿就绪 |
| A4 stagehand #1250（替换 #1773） | D+1 | OPEN 已核查，草稿就绪 |
| B HN 旧帖×1 | D+1 | |
| C 中文 KOL | D-3 ~ D+3（你定名单） | |

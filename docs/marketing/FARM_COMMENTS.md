# 养号评论草稿（HN / Reddit，D-3 ~ D-1 执行）

> 纪律：**只建立技术可信度，不提项目、不放链接**。Show HN 发帖前在多个 thread 留同一条链接是典型自荐模式，HN 反垃圾会关联。项目角度的评论（OUTREACH.md B 类）按原计划 D+1 执行，且每个 thread 只留一条。
> 用法：你审过 → 我经 ai-browser 用 glittering0717 会话发，或你复制手动发。发完把链接回填到文末记录表。

---

## HN 草稿 1 → Show HN: Webctl（#46616481，134pts / 38 评论）

**回复目标**：desireco42 的 "How are you holding session if every command is issued through cli? I assume this is essential for automation."

> The session question is the crux, I think. If every command spawns a fresh context, you re-solve auth and state on every invocation — cookies, localStorage, in-flight uploads, the works. The alternative is one long-lived browser process that commands attach to: the session becomes a property of the browser, not of the command. The trade is that you now own lifecycle management (who starts it, who kills it, what happens on crash), and you can't fan out across isolated profiles without extra machinery.
>
> For multi-step workflows against sites where you're logged in, the persistent model wins almost every time; for stateless fan-out scraping, ephemeral is simpler. The CLI-vs-MCP axis is actually orthogonal to the session model — you can put a persistent browser behind either interface. What changes is ergonomics: CLI strings compose easily for agents but are a poor channel for returning structured state; MCP gives typed results at the cost of a protocol layer. And most of the cost delta people attribute to "LLM-driven automation" is really the perception step (screenshots vs DOM), not the transport.

## HN 草稿 2 → Show HN: Magnitude（#44390005，145pts / 40 评论）

**回复目标**：axlee 的 "Using this for testing instead of regular playwright must 10000x the cost and speed, doesn't it? At which points do the benefits outweigh the costs?"

> Depends what you're comparing against. Classical Playwright scripts are deterministic and nearly free per run — the cost is all in authoring and maintenance, paid in engineer-hours, and every UI change is a potential break. LLM-driven flows invert that: cheap to author, expensive per run (each step is inference over page state), and failures are soft — wrong element, plausible-looking mistake — rather than loud.
>
> Break-even, roughly: LLM-driven when the workflow is short, the UI is unstable or unfamiliar, or maintaining selectors would cost more than the runs' tokens; Playwright when the flow is long-running, high-volume, or in CI where determinism is the point.
>
> One underrated factor is the perception layer: screenshot-based steps cost roughly an order of magnitude more tokens than DOM/AX-based ones, so "LLM automation is expensive" is often really "vision-based automation is expensive."

---

## Reddit 草稿（待检索目标 thread，D-3 经 ai-browser 找）

目标版：r/LocalLLaMA / r/ClaudeAI / r/ModelContextProtocol。选题方向（避开项目）：
- MCP 生态里"工具太多 vs 上下文预算"的讨论 → 分享结构化返回 vs 文本 blob 的实测体会
- 本地模型跑 agent 的上下文管理 → 语义树 token 成本的量级对比（截图 vs DOM）

找到具体 thread 后按 HN 同标准草拟，仍不提项目。

---

## 执行记录

| 日期 | 平台 | Thread | 状态 |
|---|---|---|---|
| D-3（10/17） | HN | #46616481 草稿 1 | 待审 |
| D-3（10/17） | HN | #44390005 草稿 2 | 待审 |
| D-3 ~ D-1 | Reddit | 待检索 | 待草拟 |

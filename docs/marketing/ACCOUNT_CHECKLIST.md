# D-Day 账号自查清单（约 10 分钟，D-3 前完成）

> 每项给出**怎么验证**而不是空泛要求。打勾后在 LAUNCH_PLAN 标注。

## 巡检结果（2026-10-16 17:50，经 ai-browser ws://127.0.0.1:9223 实测）

| 站点 | 账号 | 登录态 | 关键事实 | 风险 |
|---|---|---|---|---|
| Hacker News | glittering0717 | ✅ 已登录 | **账号创建于巡检前 1 小时，karma 1，未设置邮箱**（profile 页有邮箱设置提示） | 🔴 高：<1 天新号发 Show HN 会被反垃圾降权，距 D-Day 仅 4 天，需立即养号 |
| Reddit | u/glittering0717 | ✅ 已登录（已过 JS 挑战） | karma 1（0 评论 + 1 帖子）；r/mcp 规则实测："Self-promotion is allowed with proper disclosure" + rule 4 "Use showcase" flair | 🟡 中：评论 karma 为 0，需在 r/ClaudeAI / r/ModelContextProtocol / r/LocalLLaMA 真实互动攒 karma |
| V2EX | Glittering（No.20622） | ✅ 已登录 | 老账号（会员号 20622，约 2013 年注册）；/go/create 打开发帖表单正常 | 🟢 低 |
| linux.do | — | ❌ 未登录 | 登录页已在 ai-browser 打开，等本人登录后复检 trust level 1 | 待用户 |
| NodeSeek | — | ⚠️ 无法检查 | **全站维护中**（2026-10-16 访问返回维护页），D+3 发帖计划需复检站点恢复情况 | 站点侧 |

**养号行动项（D-Day 前必须）**：
1. HN：立刻在 profile 设置有效邮箱；随后 4 天在 HN 真实评论 5–10 条技术内容攒 karma（账号年龄本身就是信号）
2. Reddit：每天在 r/ClaudeAI / r/ModelContextProtocol / r/LocalLLaMA 留 3–5 条与产品无关的真实技术评论（checklist 第 2 节原计划，现升级为必做）
3. linux.do：本人在 ai-browser 窗口完成登录，我复检 trust level
4. NodeSeek：D+1 复检维护是否结束

---

## 1. Hacker News（主战场，账号状态决定成败）

- [x] 能登录 https://news.cc/login （news.ycombinator.com）—— 2026-10-16 实测已登录（glittering0717）
- [ ] 查看账号 karma 与年龄：点自己用户名；Show HN 对新号无硬门槛但 **<1 天的账号帖子会被反垃圾系统降权**，D-3 前务必登录一次并保留会话
  → 实测：**created 1 hour ago / karma 1**，见上方养号行动项，这是当前 D-Day 最大单点风险
- [ ] 在 https://news.ycombinator.com/submit 提前把标题粘进去预览（不要提交）：
  `Show HN: AI Browser — a persistent co-pilot browser your agent drives over MCP`
  （标题以 SHOW_HN.md 第 1 行为准；≤60 词左右的正文从 SHOW_HN.md 复制；URL 填 GitHub 仓库；首评从 SHOW_HN.md 末尾的"对比"段发）
- [ ] 不做投票交换、不在同一网络环境多账号；发帖后别自己刷榜

## 2. Reddit（两个子版，账号年龄/karma 是硬门槛）

- [x] 登录账号，访问 https://www.reddit.com/r/ClaudeAI/ 看右侧规则中是否有 "account age/karma requirement"（常见要求 10+ comment karma）
  → 2026-10-16 实测：已登录 u/glittering0717；r/mcp 规则含 "Self-promotion is allowed with proper disclosure"（rule 4: Use showcase flair）；r/ClaudeAI 侧栏未见明确 karma 数字门槛。评论 karma 0，按下方行动项养号
- [ ] 不达标就在 D-3 起每天在 r/ClaudeAI / r/ModelContextProtocol / r/LocalLLaMA 留 **3–5 条与产品无关的真实技术评论**（回别人问题最有效）
- [x] 已 Join：r/ClaudeAI、r/ModelContextProtocol、r/mcp、r/LocalLLaMA
- [ ] 发帖时正文第一行不要放链接（Reddit 反垃圾会压），链接放中段
- [ ] 备选账号：若只有新号，r/MachineLearning 等大版先不碰

## 3. V2EX

- [x] 登录后打开 https://www.v2ex.com/go/create 确认能看到"发布新主题"按钮（"分享创造"节点）
  → 2026-10-16 实测：已登录 Glittering（No.20622，老账号），/go/create 打开发帖表单正常
- [x] 新注册账号：完成邮箱验证；账号 <10 天或无发帖记录时带链接主题可能进回收站——先用老号
  → No.20622 为老账号，无此风险
- [x] 标题用 CHANNEL_POSTS.md 的候选 A（[开源] 前缀在 V2EX 是惯例不是硬格式）
- [ ] 每日主题数有限（通常 3 个），D 日只发这 1 个

## 4. linux.do

- [ ] 登录后点头像 → 徽章，确认有 **"基本用户"（trust level 1）** 徽章
  没有的话：浏览 ≥10 个主题、总阅读 ≥5 分钟、点开若干帖子滚动到底，系统自动升级（通常几分钟～1 小时）
  → 2026-10-16 实测：**未登录**，登录页已在 ai-browser 窗口打开，等本人登录后复检
- [ ] 新注册 24 小时内不能在部分分类发主题/带外链——D-3 前注册并挂机阅读
- [ ] 发"开发调优"或"资源荟萃"分类，不要用任何引流标签
- [ ] 正文里链接保留 1 个（GitHub）即可，多链接触发审核

## 5. NodeSeek

- [ ] 登录后能在 https://www.nodeseek.com/post-create 选择分类
- [ ] 完成邮箱验证；新号首帖带外链会进人工审核（正常现象，不要重复发）
- [ ] 分类选"技术交流"或"资源分享"
  → 2026-10-16 实测：**全站维护中**（返回"我们正在维护中"维护页），D+1 复检

## 6. 知乎 / B 站（PR_ZHIHU.md / PR_BILIBILI.md 已备好）

- [ ] 知乎：用已有内容账号发"文章"而不是"想法"（文章可带引用链接）；新号先答 2 个相关问题养盐值
- [ ] B 站：demo.gif 可转成 30–50 秒竖屏短视频（ffmpeg 一条命令，需要时我做）；标题里带 Claude Code / MCP 关键词

## 7. 统一收口

- [ ] 所有平台昵称/头像尽量一致，bio 里放 GitHub
- [ ] 各帖评论区有人回复 → **1 小时内回**（D-Day 预留 8 小时在线时间块）
- [ ] 发布顺序：HN（D 日 08:30）→ V2EX（12:30）→ Reddit（22:00）→ linux.do/NodeSeek 次日，避免同一 URL 同时段多平台铺被判营销

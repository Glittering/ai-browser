# ai-browser 发布运营方案（v1，2026-10-13）

> 基于对 browser-use（3 个月 50k stars）、AFFiNE（4 年 28 次 Trending）、note-gen（独立开发者 8 个月 5k stars）的公开复盘，以及 GitHub Trending、Hacker News、MCP 生态目录站、Reddit、国内社区的规则调研。每条关键结论后附来源编号，置信度单独标注。

## 一、结论：置信度最高的三条打法

1. **Show HN 是唯一被反复验证的"冷启动放大器"。** browser-use 在正式发布前先被 HN 自然流量打爆（到 23k stars 后才申请 YC）[cite:1]；note-gen 作者实测"上榜一天几百 star，随后因涨幅自动上 GitHub Trending，短期涨两千多"[cite:2]；AFFiNE 28 次 Trending 中 11 次（39%）的前置触发是 HN 首页[cite:3]。
2. **Trending 奖励的是"star 速度 + 多渠道同时点火"，不是总量。** 算法按近期 star 速度（对新库基本等同于每日新增）排序，单一渠道脉冲会被识别，需要 24 小时内跨 HN/Reddit/中文社区多源点火[cite:4][cite:5][cite:3]。
3. **发布不是一天的事，是一波节奏。** browser-use 的打法是 Product Hunt 与 Launch HN 错峰 12 天[cite:1]；AFFiNE 的节奏是每季度 2–3 次 Trending，靠发版 + 工程长文反复触发[cite:3]。本方案按 **D-7 准备 → D-Day Show HN → 48h 多渠道点火 → 两周刊/长文承接 → 30 天内第二次触发**编排。

**现实预期（诚实锚点）**：仓库 2026-07-15 创建，当前 1 star、0 fork。统计上约 10% 的 HN 帖子能进首页[cite:6]，打磨良好的开发者工具 Show HN  breakout 概率约 10–25%（多源区间，非精确值）。方案目标不是复制 browser-use 的 50k（其关键 tail event 是成为 Manus、Perplexity 的依赖，不可规划[cite:1]），而是：

| 情形 | 首月预期 | 触发条件 |
|---|---|---|
| 保守（执行完渠道清单，HN 没爆） | 80–250 stars | 高置信，投入即可得 |
| 中性（HN 进 /show 前两屏 或 中文帖出圈） | 300–1000 stars | 中置信 |
| 理想（HN 首页停留 6h+） | 1000–3000+ stars，大概率上 Trending | 低概率高赔率，值得认真赌 |

## 二、爆款项目实际做对了什么

### 2.1 browser-use：仓库即漏斗，HN 是原点，工程长文是燃料

- **HN 先于一切官方动作**：2024 年末开源后先在 HN 自然走红，2025-01-26 到 23k stars，02-13 Product Hunt（4 分钟 60+ upvotes），02-25 Launch HN 259 分/100 评论，两次发布错峰 12 天[cite:1]。
- **创始人个人账号 build-in-public，而非品牌官号**：两位创始人个人 X 合计 3.4 万关注；最大一条爆款（26.9 万阅读）不是发布帖，而是把 Perplexity 的一个 bug 追溯到自己代码里硬编码字符串的"侦探帖"[cite:1]。
- **每月一篇工程深度文投 HN**：发布后一年多里投了至少 8 篇技术文（"为什么放弃 Playwright 直接用 CDP"、Firecracker VM 启动优化等），2026-06 还靠一篇 322 分的文章再次上首页——HN 是持续渠道，不是一次性发布会[cite:1]。
- **零付费投放**：没有广告、没有联盟营销，流量结构 Direct 41.8% + 自然搜索 36.1%，搜索词几乎全是品牌词——先靠 HN 打出品牌名，再靠品牌词和目录站承接[cite:1]。

### 2.2 AFFiNE：Trending 是可以重复工程化的

- 推断的 Trending 信号：**24h star 数相对前 7 天的增速**为主，star 账号多样性、地域多样性、HN/Reddit 来源流量加权；榜单约每 4–6 小时重算[cite:3]。
- 最佳入场窗口：**周一 09:00–11:00 UTC、周二 14:00–17:00 UTC、周六 22:00–01:00 UTC**；28 次上榜平均停留 36 小时、中位每次 +1200 stars（该数据为单一来源的自述样本，作方向性参考）[cite:3]。
- 五个确定杀速度的错误：周五下午发帖、泛泛标题（描述性标题点击高约 3 倍）、主贴没有演示 GIF、作者不在评论区（静默帖互动损失约 50%）、组织刷 star（6 小时内被标记）[cite:3]。

### 2.3 独立开发者中文实战：100–1000 阶段靠论坛 + 周刊 +"噱头"标题

note-gen（8 个月 5k stars）作者的一手经验[cite:2]：

- **0–100**：找朋友 + 发帖，项目有亮点就不难；**100–1000 最难**，频繁重复发帖反而招黑；1000+ 是信任飞轮，时间问题。
- 实测有效渠道：**Hacker News（英文项目，一天几百 star）、V2EX（首发`分享创造`节点，之后走`推广`节点）、linux.do（`资源荟萃`+公益推广标签，氛围最友好）、NodeSeek、Reddit（控制频率防封）**；掘金/知乎软文效果已明显变差[cite:2]。
- 周刊/月刊投稿（GitHub issue 形式，零成本）：**阮一峰周刊（ruanyf/weekly）、HelloGitHub、GithubDaily**[cite:2]。
- 发帖文案不要重复介绍项目（各平台查重会判灌水）；用"技术总结文顺带项目"或真实"噱头"（如《突然被一群老外 star，一看原来是上了 HN 首页》）；对冷嘲热讽在评论里正面讲差异点，这类评论串反而引流[cite:2]。
- 另一独立项目的"活水"经验：持续做内容（订阅制日报）形成内容→项目→star→热度的飞轮，比单次发布耐久[cite:7]。

### 2.4 Show HN 的成败因素（多源一致）

- 上首页的帖子三个共性：**一句话讲清做什么和为什么自己做、诚实承认取舍与局限、作者在评论区持续讨论技术细节**；失败帖共性：营销腔、价值主张模糊、作者发完消失[cite:8]。
- 时间统计：安静时段优于拥挤时段——周一 00:00 UTC 过 50 分概率约 10.8%，周四 06:00 UTC 仅 2.6%；但时间差异远小于"前 3 小时在线互动"[cite:9]。周末（尤其周日）breakout 概率高 20–30%（Myriade 数据，转引）[cite:6]。
- 格式纪律：标题 `Show HN: ` 开头 + 平实说功能；首条评论讲问题、技术决策、方案新意；至少前 8 小时守在评论区[cite:10]。
- Product Hunt 与 Show HN 错峰而非同日；有 50+ 真实预热互动的制作者 PH 平均 420 upvotes vs 不足 10 个的 87[cite:11]。

## 三、当前仓库审计：发布前必须处理的阻塞项

| 项 | 现状 | 动作 |
|---|---|---|
| **npm 包名被占** | npm 上 `ai-browser`（0.3.1，2026-02 注册，描述近似）不是本项目；本项目从未发布 npm | **P0**：改发 scoped 包 **`@glittering0717/ai-browser`**（先例 `@playwright/mcp`），bin 名仍叫 `ai-browser`；已确认可用的备选：`ai-browser-mcp`、`semantic-browser-mcp`、`mcp-browser`。同时给现占位包维护者发邮件/提 issue 协商，作为数周后的备选 |
| package.json 无 `bin`/`files` | MCP 客户端无法 `npx` 拉起 | 补 `bin: { "ai-browser": "bin/cli.js" }`、`files` 白名单；**在干净环境实测 `npx -y @glittering0717/ai-browser --help` 与三类客户端（Claude Code、Claude Desktop、Cursor）真实装一遍** |
| Electron 分发体积 | npx 首次需下载 Electron（百 MB 级） | README 显式写明首次启动耗时；评估 electron 改为 optionalDependencies 或在启动文案里提示 |
| 仓库元信息 | description/topics/MIT/Discussions 已就绪；homepage 指回仓库 | 补独立官网或 GitHub Pages 落地页（可选，提升信任）；确认仓库 Settings 里的 social preview 图（1280×640）已上传 |
| 平台支持 | README 徽章 macOS • Linux | Show HN 首评主动声明"Windows 未测试"，管理预期，避免评论区被 Windows 问题淹没 |
| 初始信任 | 1 star、0 fork | 发布前定向邀请 10–20 位真实目标用户（MCP/agent 开发者）试用拿第一批真实 star 与 issue；**严禁买 star** |
| 物料 | demo.gif（Bing 搜索→翻页→开 GitHub 全链）、SHOW_HN 稿、RELEASE v1.2.0、中文稿/知乎稿/B 站稿已备 | 再补 2 个短 GIF：① WS 原始 JSON-RPC 往返（给想看协议的工程师）② 人机共驾：agent 操作中途人接管鼠标 |
| 安全声明 | WS 9223 无鉴权仅监听 localhost，README 已声明 | Show HN 首评再次主动说明——主动披露是 HN 文化加分项[cite:8] |

## 四、渠道地图（按点火顺序）

| 渠道 | 规则/时间 | 动作要点 | 置信度 |
|---|---|---|---|
| **Show HN** | 标题 `Show HN:` + 平实功能；5 分钟内发自评；守 8h；不刷票（投票环舞弊检测会惩罚） | 主推周二 21:00 北京（=09:00 EDT，AFFiNE 最佳窗之一[cite:3]）或周日上午北京（对应美东周六晚，周末概率 +20–30%[cite:6]）；作者能熬夜守评论是硬约束，二选一 | 高（赔率最高） |
| **Reddit r/mcp** | 规则允许自荐但必须打 `[showcase]` 并披露作者身份，伪装路人永久封禁[cite:12] | HN 发帖后 12 小时内发，标题与 HN 不同文案；逐楼回复 2h | 中高 |
| **Reddit r/ClaudeAI** | 规则允许自荐[cite:13]；r/claude **禁止自荐不要发**[cite:13] | 角度："给 Claude Code/Cursor 配一个看得见、能接管的持久浏览器" | 中 |
| **Product Hunt** | 与 HN 错峰；00:01 PT 上线，需猎手/朋友首日真实互动 | HN 后第 5–7 天上线，用 HN/Reddit 收集的反馈打磨 landing；找 maker 社区互支持（PH 亚太时间劣势：准备好凌晨跟进） | 中 |
| **V2EX** | 首发`分享创造`（首次友好），后续`推广`节点[cite:2] | HN 当晚或次晚发，技术向噱头标题；评论区亲自答 | 中（中文流量最大） |
| **linux.do** | `资源荟萃`板块 + 公益推广标签，对开源最友好[cite:2] | 与 V2EX 不同文案；可连载"上 HN 实况"后续帖 | 中 |
| **NodeSeek** | 推广容忍度高[cite:2] | 简短技术帖，避免营销腔 | 低中 |
| **周刊投稿（issue）** | 阮一峰周刊、HelloGitHub、GithubDaily[cite:2] | D+2 起投；HelloGitHub 需中文项目介绍；被任意一家收录 = 长期长尾 | 中（零成本高杠杆） |
| **MCP 官方 Registry** | 只存元数据，npm 上的 stdio 包可发布，`mcp-publisher publish`[cite:14][cite:15] | npm 发布当天同步注册：Claude/Cursor 生态内可被搜索安装 | 高（长期长尾） |
| **mcp.so** | 表单自助注册，无需审核，受众含 Claude/Cursor 用户[cite:16] | 发布当天登记 | 高 |
| **Smithery** | 需 MCPB 打包或 HTTPS endpoint[cite:17] | stdio 本地服务用 MCPB 方式提交；若打包成本高可放第二周 | 中 |
| **awesome 列表 PR** | punkpeye/awesome-mcp-servers、wong2/awesome-mcp-servers（Cline 文档直接推荐前者[cite:18]） | 按各表格式提 PR 到 browser automation 分类；PR 描述写清差异 | 中高（持久反链） |
| **掘金/知乎/B 站/头条** | 已有 PR 草稿在库；掘金算法流量已倾向合作内容，自然量有限[cite:2] | 发**技术长文**（"不用截图/OCR：给 Agent 喂语义树的浏览器怎么设计"），非通稿；B 站用录屏配音 3–5 分钟 | 中 |
| **X / 即刻** | browser-use 证实人个账号 > 品牌号[cite:1] | 0 粉丝基线不押注；发 build-in-public 记录（star 里程碑、HN 实况、踩坑），@ MCP/agent 生态账号，作为其他渠道的放大器而非主战场 | 低（基线弱时） |
| **GitHub Blog 官方建议** | 官方鼓励自荐到 HN/Reddit/PH，并主动到有该痛点的帖子下回复[cite:19] | 在 Reddit/Stack Overflow/V2EX 搜"browser automation for AI agent""MCP browser"类问题，有用回答中提及（不硬广） | 中 |

## 五、作战日历（以 D-Day = 2026-10-20 周二为例）

### D-7 ~ D-1（10/13–10/19）准备周

- [x] **npm 发布**：包名 `@glittering0717/ai-browser`，bin/files 齐备，干净环境真实 npx 实测通过（1.1.10 首版已发；首发 Release 版本为 1.2.0）
- [ ] 打 tag 发 **GitHub Release v1.2.0**（用 RELEASE_v1.2.0.md），确认 CI 绿徽章
- [x] README 安装命令全部指向新包名；确认 About/Topics（social preview 图仍待补）
- [ ] 上传 **MCP 官方 Registry、mcp.so**；提 awesome-mcp-servers 两个 PR
- [ ] 补 2 个 GIF；SHOW_HN.md 终稿（首评含：为什么做、与 Playwright MCP/chrome-devtools-mcp 的差异、Windows 未测、localhost 无鉴权声明）
- [ ] 定向邀请 10–20 位真实用户试用（MCP 群、身边 agent 开发者），收集 issue 与第一批 star
- [ ] 注册/养号：Reddit 主账号提前在 r/mcp 正常互动几条；确认 V2EX/linux.do 账号可发帖
- [ ] 准备好 D-Day 当晚 8 小时不被打断的整块时间

### D-Day（10/20 周二）

- **20:50 北京**：发 Show HN（标题与首评定稿见第六节）；5 分钟内贴自评；前 3 小时秒回所有评论，8 小时内不断档
- **22:00**：朋友圈/即刻/X 发"正在 Show HN"实况（只陈述，不喊票；HN 投票环禁止拉票，直接求 upvote 有反效果，分享链接给朋友看评论即可）
- **次日早晨**：无论分数多少，继续回复欧美早高峰评论（HN 帖子 24–48h 仍有二次爬坡机会）

### D+1 ~ D+3（10/21–10/23）多源点火

- 周二晚北京 = 美东周二早：**r/mcp 发 [showcase] 帖**（披露作者身份），2 小时逐楼回复；**r/ClaudeAI** 不同文案第二弹
- 周三晚：**V2EX `分享创造`**、**linux.do `资源荟萃`**（两篇文案不同；可埋"HN 实况"角度）
- NodeSeek 简版；B 站视频上传（用录屏 + 配音）
- 投**阮一峰周刊、HelloGitHub、GithubDaily** 三个 issue
- 掘金技术长文（以架构设计为主，项目作为载体）；知乎回答 2–3 个"AI 如何操作网页/MCP browser 选型"类已有问题

### D+5 ~ D+7（10/25–10/27）第二波

- **Product Hunt 上线**（建议 10/27 周二），用首周真实反馈写 maker comment；提前约好首日互动的 maker 朋友
- 知乎/头条稿发；X 长 thread（10 条左右：语义树设计、CDP 受信输入、与截图派对比，1 GIF + 1 张架构图）[cite:3]
- Smithery MCPB 打包提交

### D+8 ~ D+30 续航（第二次触发）

- 每周一篇技术深度文候选：① 为什么 Agent 看网页不该用截图（语义树 vs 视觉模型的实测对比）② 受信 CDP 事件如何驯服 Draft.js/ProseMirror/知乎编辑器 ③ 1280×800 持久窗口的人机共驾设计。月底挑最强的一篇投 HN（browser-use 月更节奏[cite:1]）
- v1.2 选一个有传播性的能力（如 Windows 支持、录制回放、多标签编排），用发版再触发一次 Trending 节奏
- 把每个平台评论里的高频问题转成 README/FAQ 与 issue；star 里程碑在即刻/X 如实记录

## 六、话术模板（定稿方向，发布前再润色）

**Show HN 标题**（平实、一句话功能，参照 [SHOW_HN.md](SHOW_HN.md)）：

> Show HN: A persistent, visible browser for AI agents – semantic tree API instead of screenshots

**Show HN 首评骨架**（5 分钟内发）：

1. 问题：Agent 操作网页的主流路径是截图→OCR/视觉模型→猜坐标，慢、贵、脆。
2. 做法：Electron 真实窗口，页面正常渲染给人看；同时输出 role/label/value/states/actions 语义树，操作走 CDP 受信输入（真实键鼠，不是 `.click()`）。
3. 差异（诚实对标）：Playwright MCP / chrome-devtools-mcp 给的是临时测试实例；本项目是**持久、可见、人可随时接管**的副驾浏览器——定位不同，不是替代。
4. 接口：17 个 MCP 工具（stdio，`npx @glittering0717/ai-browser`）+ 原始 WS JSON-RPC。
5. 主动交代局限：WS 仅 localhost 无鉴权（不要暴露端口）；macOS/Linux，Windows 未测；非 headless；一个人维护。
6. 求反馈：哪些网站语义树读错、哪些编辑器输入失败（issue 模板已备"页面误读"类）。

**Reddit r/mcp**：`[showcase] I built a visible, persistent MCP browser (17 stdio tools) – the human can grab the mouse mid-task`，正文披露"I'm the author"，侧重技术与 demo。

**V2EX 标题方向**：《给 AI Agent 做了个不用截图的浏览器，刚上了 Show HN》/《Agent 操作网页为什么不该靠截图：一个语义树浏览器的设计取舍》。

**linux.do**：角度偏开源共建 + 公益（MIT、本地运行、数据不出本机），可写 HN 实况连载。

## 七、指标与决策门

- **D+2 检查**：HN 帖 < 10 分且无讨论 → 不删帖（Show HN 不可重复提交同一项目），把火力转到 Reddit/中文渠道与周刊，复盘标题/首评，3–4 周后靠**工程长文**（非项目帖）再打 HN。
- **D+7 检查**：全渠道合计 < 50 star → 判定为产品/信息层问题而非渠道问题，优先修：npx 安装体验、README 30 秒理解度、demo GIF 前 3 秒钩子，再谈下一波。
- **任一渠道出圈信号**（HN 进前 30 / 某帖 100+ 互动）：24h 内把其他未发渠道全部点火（Trending 需要多源速度[cite:3]），并立刻准备第二篇承接内容。
- 全程记录每日 star、各帖分数/评论、referrer，发布后复盘归档（这是下一次发版触发的基线数据）。

## 八、红线纪律

- **不买 star、不互刷**：新号 star 被大幅折扣，协同作弊 6 小时内可被标记[cite:3]；GitHub 对操纵行为有封禁政策，一次中招毁掉项目信誉。
- **不拉 HN 票**：不在群里发"求 upvote"，HN 反投票环机制会检测同质来源流量；可以分享"我写了篇东西"，让人自然点开。
- **不重复通稿**：每个平台独立成稿，角度/标题/开头不同[cite:2]。
- **不碰禁自荐板块**（r/claude 等），发前逐版读规则[cite:13]。
- **不吹不存在的数字**：README/官网所有数字与仓库一致（17 工具、411 单测 + 409 e2e），对比竞品只讲可验证事实。
- **不在周五下午点火**（周末流量衰减，等周一重算时速度已泄）[cite:3]。

## Sources

[cite:1] [Browser Use — Revenue & Growth Teardown, Systemaic](https://www.systemaic.com/teardowns/browser-use)
[cite:2] [分享我是如何用 8 个月的时间获得 5000 star 的，掘金](https://juejin.cn/post/7520379793888542720)
[cite:3] [How AFFiNE Hit GitHub Trending 28 Times: The Repeatable Playbook (2026)](https://gingiris.github.io/growth-tools/blog/2026/05/01/affine-github-trending-playbook/)
[cite:4] [About — GitHub Trending（star velocity 权重模型）, TrendingRepos](https://trendingrepos.com/about)
[cite:5] [How to Get Your Project on GitHub Trending, Magikaru](https://trending.magikaru.com/how-to-trend)
[cite:6] [How to Get on Hacker News Front Page: Show HN Strategy, Awesome Directories](https://awesome-directories.com/blog/hacker-news-front-page-guide/)
[cite:7] [没啥名气，俩月搞到 1k Star，聊聊我那个开源项目的折腾史，掘金](https://juejin.cn/post/7549553534321803310)
[cite:8] [How to Write a Show HN Post That Gets Traction, Pristren](https://www.pristren.com/blog/hacker-news-show-hn-guide/)
[cite:9] [How to launch on Hacker News with Show HN, makers.page](https://makers.page/blog/launch-on-hacker-news-show-hn)
[cite:10] [The best Product Hunt alternatives for developers, daily.dev](https://daily.dev/blog/best-product-hunt-alternatives-for-developers/)
[cite:11] [HackerNews and Product Hunt: The Developer Community Marketing Playbook, Hashmeta](https://hashmeta.com/blog/hackernews-and-product-hunt-the-developer-community-marketing-playbook/)
[cite:12] [r/mcp subreddit rules analysis, Reddifier](https://reddifier.com/free-subreddit-analysis-tool/r/mcp)
[cite:13] [r/ClaudeAI / r/claude self-promotion rules, LeadsRover](https://leadsrover.io/subreddits/r/claudeai)
[cite:14] [Quickstart: Publish an MCP Server to the MCP Registry, modelcontextprotocol.io](https://modelcontextprotocol.io/registry/quickstart)
[cite:15] [How to find, install, and manage MCP servers with the GitHub MCP Registry, GitHub Blog](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/)
[cite:16] [MCP Registries in 2026: Where to List Your Server, RoxyAPI](https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server-2026)
[cite:17] [Publish — Smithery Documentation](https://smithery.ai/docs/build/publish)
[cite:18] [Adding and Configuring MCP Servers, Cline Docs](https://docs.cline.bot/mcp/adding-and-configuring-servers.md)
[cite:19] [5 tips for promoting your open source project, GitHub Blog](https://github.blog/open-source/maintainers/5-tips-for-promoting-your-open-source-project/)

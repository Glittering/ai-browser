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
| V2EX 分享创造 | D+1 12:30 | | 老账号 No.20622；❌ **2026-10-19 08:30 发布失败**：本机到 www.v2ex.com 连接超时（浏览器自报 ERR_CONNECTION_TIMED_OUT / -118，curl -4/-6 及三个 DNS 返回的 IP 全部 connect timeout，github.com 同样不可达，baidu/zhihu 正常 → 出口国际链路被拦，无可用代理），卡在网络连通这一步，未进入登录态校验与填表。稿件已就绪于 `ops-audit/v2ex_publish.mjs`，网络恢复后重跑原命令即可 |
| 知乎文章 | D+1～D+2 | https://zhuanlan.zhihu.com/p/2094594014632793355 | ✅ 2026-10-17 00:20 已发布；踩坑：CMD+V 合成键不触发 Chromium 原生粘贴（CDP 直达渲染器、不过浏览器进程加速键），最终用合成 ClipboardEvent+DataTransfer(text/html) 派发 paste，Draft.js DraftPasteProcessor 全格式转换（6 h2/6 代码块/48 加粗 span/7 列表项） |
| 掘金长文 | D+2 | https://juejin.cn/post/7697024318929633320 | ✅ 2026-10-16 21:00 已发布（分类"人工智能"+标签"人工智能"）；草稿箱已无该文；踩坑：发布弹窗"添加标签"为必填（红*），缺标签时前端静默失败、仅弹行内错误"至少添加一个标签"，曾误判"发布成功" |
| 掘金长文（三方案实测） | 10-19 20:30 | https://juejin.cn/post/7698058565157896218 | ✅ 2026-10-19 20:51 已发布并验证（文章页 200、标题正确、正文 2177 字可读、结尾 CTA 在位）。分类「人工智能」已选（chip 变 `item active`）；**话题「AI 编程」已挂载**（文章页可见，4.7m 阅读池）；标签只落地 `Agent`（必填项已满足，"人工智能/MCP" 两次 ArrowDown+Enter 未选中，事后补标签时「编辑」入口点不开，未做二次改动）；**创作声明：本次发布弹窗没有该控件**（页面内搜不到"创作声明/AI 辅助生成"），故未勾选。新踩坑：① `browse_navigate` 会落在默认百度 tab 上，必须 `browse_tabs op=new` + `op=switch` 且后续每个调用都显式传 `tab`；② 编辑器页 `browse_auth_state` 恒 false（该页无头像节点），必须在 `/creator/home` 验登录并轮询 ≥6 次；③ 语义树没有 class/tag 字段，只能按 role+label 定位（正文 = 无 label 的 multiline textbox = CodeMirror 隐藏 textarea）；④ `browse_act paste` 会自报 `landed_chars:0` 但实际已写入，必须用 `CodeMirror.getValue()` 独立校验（本次 2244/2244）；⑤ `press` 参数在 `press:{key}` 分组里，不是顶层 `key`；⑥ 分类是 chips 直接点，不是下拉；⑦ `/published` 不是成功页（会回落首页），判定只看「创作中心 → 近期发布」+ 文章页 200。遗留：草稿箱现有 6 篇（调试过程产生），待人工清理 |
| B 站视频 | D+2 | | 46s 竖屏已就绪 |
| 头条 | D+3 | | 账号已登录 |
| CSDN 博客 | D+1 | https://blog.csdn.net/weixin_39287419/article/details/168241019 | ✅ **2026-10-17 13:40 已发布并验证**（标题正确、正文 13933 字、文章页可访问）。此前记录作废：登录态曾丢失导致误判，本次会话登录态恢复后重走全流程成功。**关键经验**：① 每步先 `ui.auth_state` 验登录态（本次新加的能力）；② 标签为 el-autocomplete，合成 `click()` 不吃，须 `ui.act press ArrowDown` + `Enter` 受信选中；③ `ui.evaluate` 不等 Promise，含 `await` 的 IIFE 会返回 `{}`，必须拆成"触发→等待→点选"两段式；④ 发布结果以 URL 跳到 `mp.csdn.net/mp_blog/creation/success/<id>` + 文章页 200 + 正文可读为准，不轻信 toast；⑤ 创作声明如实选"部分内容由AI辅助生成" |
| 头条文章 | D+3 | https://www.toutiao.com/article/7697326423064773160/ | ✅ 2026-10-17 01:59 已提交，**02:40 已过审变为"已发布"**（pgc_id=7697326423064773160，首发标记）；走通「预览并发布→确认发布」两段式流程；ProseMirror 合成 paste（text/html）注入成功 |
| B 站视频 | D+2 | https://www.bilibili.com/video/BV15RJb6oERJ/ | ✅ 2026-10-17 02:30 已投递成功（demo_vertical.mp4 + img_cover_bilibili.jpg 封面 + 标题/简介/6 标签/创作声明"内容无需标注"）；BV15RJb6oERJ 已分配、页面已上线。**2026-10-19 04:00 封面 16:9 已补齐**：此前发布时提示"个人空间封面 16:9 未修"（4:3 已确认）——本次用 ai-browser 全自动修补：稿件管理→编辑→点封面预览打开「封面制作」弹窗→`browse_act upload`（target 用 CSS 选择器 `.cover-upload input[type=file]`，file 传封面图绝对路径，走 frame-file-inject 注入弹窗内 file input，实测可跨进程 iframe）→4:3/16:9 双画布均出现封面图→滚「完成」按钮进视口后点击→「立即投稿」（必须精确点 SPAN.submit-add，点外层 submit-container 无效）→「稿件投递成功」→公开页 og:image 已变为新封面（i1.hdslb.com/bfs/archive/55938c68…，2560x1440 = 16:9 渲染版）。标题修复记录见第二轮（`demo_vertical`→「给 AI 装上"手和眼睛"：不截图不猜坐标，它自己写稿发稿（开源）」，公开页 h1 已复核生效） |
| ~~linux.do~~ | — | — | ❌ 放弃（需推荐码） |
| ~~NodeSeek~~ | — | — | ❌ 放弃（需推荐码） |
| B 站图文（专栏） | D+2 | https://www.bilibili.com/opus/1259878383752314888 | ✅ 2026-10-17 03:00 已发布（标题《给 AI 装了一个"浏览器"，它自己会写稿发稿了》，正文 2589 字）。**关键纠正**：此前判定"B站文章编辑器 SPA 挂空、不可用"是错的 —— 真正入口是 `/platform/upload/text/edit`（会 302 到 `/text/new-edit`），正文编辑器在**跨进程 iframe** `member.bilibili.com/york/read-editor` 里，`ui.get_tree` 必须带 `ax:true` 才会做 OOPIF 合并并暴露 `editor=richtext` 节点，同时要等足 ~25s。走 image=封面非必填；话题弹窗搜索无候选已跳过。发布后出现"点击查看"按钮，随后自动跳转 `upload-manager/opus` |
| 简书文章 | 10-19 凌晨 | https://www.jianshu.com/p/33cb803a5555 | ✅ 2026-10-19 02:00 已发布（《我不再让 AI 看截图了》2276 字，ai-browser 填写+发布全流程自动）；经验：①简书编辑器是 `.kalamu-area` contenteditable + `input._24i7u` 标题框；②paste 需要语义树 target（`browse_act paste target=ax-xxx`）；③type 也需要 target；④正文可直接 type Markdown 源文本，简书原样保留 |
| 51CTO 博客 | 10-19 凌晨 | https://blog.51cto.com/u_17804217/15012466 | ✅ 2026-10-19 03:32 已发布（《不用截图也能让 Agent 操作网页：语义树方案的一次落地实践》约 1400 字，分类「人工智能-机器学习」，标签 AI Agent/浏览器自动化/MCP，原创声明）。**当前状态：待审核**（51CTO 人工审核流程，文章页已返回 200）。踩坑：①发布弹窗分类是单选 radio 组——`.select_item` 列出的是全部一级分类，点二级项会抢走一级的 check class，真正的二级分类只在选中一级后渲染到 `.second-types-content`；②动画期间坐标会漂移，须重新取坐标+check class 校验+重试；③**顺带修了一个产品 bug**：`src/main/mcp_server.js` 的 `browse_act` case 声明了 `html` 参数却没转发给 params，导致 paste 永远报 "paste called with neither html nor text"（这也是此前 B 站图文只能发纯文本的根因），已修复并验证 `synthetic-clipboard-event` 路径 landed_chars 正常 |
| 知乎回答（原理向） | 10-20 08:30 | https://www.zhihu.com/question/2094580952446015206/answer/2095796636308063190 | ✅ 2026-10-20 08:40 已发布并验证（回答页 200、正文 1234 字可读、代码块 4 个与小标题/加粗格式均保留、结尾 CTA 在位）。落点 = 首选问题《为什么 Coding Agent 已经这么强了，手机 Agent 却迟迟没有出现真正好用的产品？》。**如实记录：该问题热度低于 playbook 建议线**（关注者 6→7、浏览 407→429、已有 5 个回答；playbook 建议「关注 20–200、回答 < 15」），备选问题（问"AI 还是 AI Agent 的使用心得"）与本篇机制拆解主题不匹配，故仍投首选；现有回答多为观点短答（最长 971 字），本文为机制拆解，不构成重复。新踩坑：① 语义树中顶部搜索框与正文编辑器**都带 editable 状态**，必须按 `role=textbox` + `editable=richtext` 过滤，否则会粘进搜索框（首轮即误中 ax-17048，靠字数校验拦截、未提交）；② 字数校验只量 `.public-DraftEditor-content`，不要量全部 contenteditable；③ paste 成功标志是 `consumed=true` + `landed_chars`（本次 1234）；④ 发布判定以 URL 跳到 `/question/<qid>/answer/<aid>` + **刷新后**正文可读为准，不看 toast |
| CSDN 长文（SEO·语义树方案） | 10-20 20:30 |
| CSDN 长文（SEO·选型对比） | 10-24 20:30 → **提前至 10-22 01:26** | https://blog.csdn.net/weixin_39287419/article/details/168664143 | ✅ **2026-10-22 01:26 已发布并验证**（URL 跳 mp.csdn.net/mp_blog/creation/success/168664143；文章页 200、标题正确、正文 2312 字、6 小标题 + 三方案对比表 + 代码块 + FAQ + 小结全保留）。分类专栏「人工智能」、摘要 132 字、创作声明如实选「部分内容由AI辅助生成」、标签落地 `前端` `javascript` `开发语言` `人工智能`；**封面未加**（10-20 三次尝试均失败，链路已判定不可用，不重复踩坑）。**标题经 10-22 CTR 数据改写**：「登录态每次重登？」→「**每次都要重新登录？**」（口语痛点词，匹配真实搜索意图）。执行脚本 ops-audit/csdn3_publish.mjs + csdn3_dlg2/3.mjs + csdn3_submit.mjs；新踩坑：摘要/标签/分类/创作声明全在**发布弹窗**内（编辑器页拿不到），声明下拉须 evaluate 点 `.el-select-dropdown__item` 真实选项（语义树里的 StaticText 点了无效） |
| CSDN 长文（MCP 排障清单） | **10-25 12:00**（自动化 4e3acea0） | 待发 | 终稿 `COPY_CSDN5.md`。选题理由：10-22 04:50 诊断出漏斗断在「阅读→点仓库」，前几稿面向泛人群，这篇面向**已经在配 MCP 的人**（装 MCP server 是他们的日常动作），转化率高一个量级。标题过 §0 公式：痛点词「看不到工具」+ 冒号 + 真实数字「6 步」+ 搜索词（Cursor/Claude Code/MCP）。**发布范围严格限定** `<!-- ===== 正文开始 ===== -->` ~ `--- 正文结束 ---`，文件首尾的内部笔记不得粘进编辑器。评审记录（子 agent 7/10→9/10）已附在文件末尾 |
 https://blog.csdn.net/weixin_39287419/article/details/168559996 | ✅ 2026-10-20 20:52 已发布并验证（URL 跳 `mp.csdn.net/mp_blog/creation/success/168559996`；文章页 HTTP 200、标题正确、正文 2377 字可读、4 个代码块 + 2 张表格 + 8 个小标题均保留、结尾仓库链接在位）。分类专栏「人工智能」已建并选中；**创作声明如实选「部分内容由AI辅助生成」**；摘要 129 字已填；**封面未加**（3 次尝试均失败，见下）。标签最终落地 4 个：`ocr` `electron` `自动化` `人工智能`。新踩坑：① 走 `editor.csdn.net/md`（点「使用 MD 编辑器」会新开 tab），Markdown 正文用 **隐藏 file input `#import-markdown-file-input` + `browse_act upload`** 注入 `.md` 文件最稳（比 paste/setContent 可靠，原样保真 3045 字符）；② 该编辑器正文是 `pre.editor__inner`，标题 `input.article-bar__title--input` 默认 `display:none`（w/h=0），语义树里取不到，只能用 `ui.evaluate` 设值 + 派发 input/change；③ **本次发布弹窗的标签 el-autocomplete 报错「博客等级不满足三级，无法创建自定义标签」**——自定义标签一律加不上，`MCP`/`Agent` 试了 evaluate 设值、逐字符 press、setContent+Enter、setContent+ArrowDown+Enter 四种方式全部失败；`ArrowDown+Enter` 还会误选第一条无关建议（曾误加 `c++`/`Imagen`，已逐个点 `.el-tag__close` 删掉），只有存在于推荐池里的标签（如 `人工智能`）能靠 setContent+Enter 落地；④ 分类专栏没有下拉，只有「新建分类专栏」按钮，点了会插入 `span.tag__name[contenteditable]` 空 chip，填完按 Enter 才会写进 `input[name=categories]`；**注意 Enter 后会再多出一个空 chip，不要去点 `.tag__btn-tag-delete` 清理**（我第一次点错把「人工智能」删掉了，只能清空重建）；⑤ 封面走 `.cover-upload-box input.el-upload__input` 的 upload 回执 success 但 `input.files` 恒为 0，图片其实进了 `vue-image-crop-upload` 的「图片编辑/封面图预览/确认上传」弹窗，点 `.vicp-operate-btn`（确认上传）后 `.cover-upload-box` 仍无 img——3 次尝试（png/jpg 各一、含点确认）全部未落地，判定为该站点封面链路当前不可用，未重复发布 |
| OSChina 博客 | 10-19 凌晨 | https://my.oschina.net/u/5041974/blog/19779200 | ✅ 2026-10-19 05:50 已发布并提交人工复审（《给 Agent 的浏览器为什么要"可见"：一个 Electron + MCP 的实现》约 1700 字，分类自建「技术实践」，原创+公开）。**当前状态：自动审核未通过 → 已提交人工复审**（系统检测"可能包含违规或敏感信息"——疑为滑块/验证码/支付等自动化相关词触发误判，内容本身无违规；复审工作日 2 小时内完成）。新 OSChina 写博客入口：my.oschina.net 仪表盘→右侧「智写平台」（`/blog/ai-write`），老 `/blog/write` 地址已废弃；编辑器是 Tiptap ProseMirror，paste 富文本全格式落地（9 个 h2 全部保留）；发布弹窗可新建分类 |
| 微博（Excalidraw canvas demo 短内容） | 10-21 20:30 → **提前至 19:52 执行** | https://weibo.com/6267387281/RnIYmlKLE | ✅ **2026-10-21 19:52 已发布并双点核验**（终稿 COPY_OTHERS.md §6，174 字，话题 #AI Agent# #MCP#；发布后 composer 清空、首页信息流刷新后 + 个人主页"1分钟前"均可见完整正文）。新踩坑：**微博 composer 不吃合成 paste**（synthetic ClipboardEvent 对 textarea 无效，consumed=false/effect_state unknown）→ 改用 `browse_act type` 分块输入（cdp-input，60 字/块，effect_state=committed）174/174 全量落地；composer = 页面唯一 textarea（placeholder「有什么新鲜事想分享给大家？」，语义树 id ax-5133，editable=plaintext），发送按钮 = `button.woo-button-primary`（ax-5212）；首页信息流卡片不带 permalink，链接要去个人主页 `weibo.com/u/6267387281` 抓。脚本：`ops-audit/weibo_publish.mjs`（含清空+打字兜底+双点核验，可直接复用） |
| GitHub Discussions（Q&A 种子帖 ×3） | 10-21 20:10 | discussions/1、/2、/3 | ✅ 2026-10-21 20:10 已发（引擎下载/方案对比/端口安全，每条带 1 条维护者跟帖补充；终稿 DISCUSSIONS_SEED.md，路径细节已按源码核实修正）。README Contributing 节同步加入口——修复掘金两篇文章 CTA「把日志贴到 GitHub Discussions」的落地断点。作用：让从掘金/CSDN 点进仓库的读者有可去的反馈地，paths 数据显示此前已有 1 人点进 discussions 页又离开 |

## 数据回填 · 2026-10-21 全平台复盘（ai-browser 实测）

> 复盘全文：`OPS_WEEKLY_2026-10-21.md`。以下为各渠道最新真实数据（后台真值优先）。

| 渠道 | 最新数据（10-21 采集） | 较上期 | 状态 |
|---|---|---|---|
| 掘金文章1 | 8 展现 / 42 阅读 / 0 互动 | 展现持平、阅读 26→42 | 从未进推荐池；阅读全部来自搜索（Bing 已收录） |
| 掘金文章2 | 1380 展现 / 34 阅读 / 1 赞 / 0 评 / 0 藏 | 展现 0→1380 | ✅ 话题挂载验证有效（分发开关）；**CTR 2.46%（低）**——10-22 判定：**曝光已给足，瓶颈在标题不在分发**，见 PLAYBOOK §0 标题公式 |
| 掘金账号 | 0 粉丝 / 35 掘力值 / 创作第 5 天 | 掘力值 10→35 | 新号成长期 |
| 知乎文章 | 0 赞（按钮无数值） | — | 营销腔旧稿，零互动符合预期 |
| 知乎回答（10-20） | **0 赞同 / 0 评论 / 0 感谢**（API 真值） | — | 落点问题仅 429 浏览/7 关注，低于筛选线；下次严格 ≥20 关注 |
| CSDN 文章1 | 297 阅读 | 261→297 | 搜索长尾持续 |
| CSDN 文章2 | **301 阅读** / 18 赞 / 21 收藏 | 300→301（3.4h） | 全平台互动之王，收藏率 11%；**长尾增速见顶**（前 7h +116，近 3.4h 仅 +1） |
| 头条（10-17 稿） | 369 展现 / 13 阅读 / 1 赞 | 237→369 | CTR 3.5%，低于健康线；同标题旧稿 950 展现/34 阅读仍在跑 |
| 头条账号 | 6 粉丝 / 总阅读 5,532 / 收益 ¥0.07 | 总阅读 +7 | 标签混杂，投放暂停待账号决策 |
| 微博 | **1 阅读 / 0 互动**（19:52 刚发布） | 新 | ✅ 已上线并双点核验；互动数据 10-22 早回采 |
| B站视频 | 15 播放 / 2 赞 / 0 评 | 13→15 | 标题/封面事故已修复生效 |
| B站专栏 | 4 浏览 | 1→4 | 与视频同内容，暂停 |
| 简书 | 7 阅读 / 0 赞 | 新 | 归档渠道，达成定位 |
| 51CTO | **已过审上线**，阅读 8 | 待审核→已上线 | ✅ 审核风险解除 |
| OSChina | **人工复审已过、公开可访问**，约 30 阅读 / 0 赞 / 无评论 | 复审中→已上线 | ✅ 页面无审核标记 |
| GitHub | 4 stars / 14 天 48 views(28 uniques) / **referrers 空** / clones 873(272) | views 26→48→**48（冻结）** | ⚠️ 10-22 04:50 修正结论：referrers 空确属计量盲区（外链走平台中转、不带 referrer），但 **views 连续 48h 为 0 是硬数据**——近两天全平台有新增阅读，仓库访问却是 0。**漏斗断在第三段「阅读→点仓库」**，不是顶部触达。对策已写进掘金#3：CTA 从文末裸链接前移到第三节、改成「让 agent 点 star」的实操作业。判定线：掘金#3 发后 24h views14 ≥60 |
| GitHub Discussions | 3 条 Q&A 种子帖（各带 1 条维护者跟帖） | 0→3 | ✅ 已发：discussions/1 引擎下载、/2 方案对比、/3 端口安全；README Contributing 已加入口 |
| CSDN 文章3（选型 SEO） | **9 阅读**（01:26 发布，3.4h） | 0→9 | ✅ 已上线并可读（标题/正文/分类/声明全部落地）；CSDN 是慢热型，#2 用了 3 天才到 300，48h 后回采，判定线：阅读 ≥100 / 收藏 ≥5 |
| npm / Registry | latest 2.1.1 / 周下载 410（10-20 起持平） | 47→410 | 下载潮与 2.1.0 发布吻合，归因（脉冲 vs 采用）观察一周；✅ MCP Registry 已同步 2.1.1（10-21 20:18 发布，isLatest=true，此前落后 5 版；操作手册 REGISTRY_SYNC_RUNBOOK.md） |

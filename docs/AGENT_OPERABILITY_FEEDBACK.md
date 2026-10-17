# Agent 可观测性复盘与改进方案

> 素材来源：2026-10-16 ~ 10-17 一次真实的跨 6 个平台投放（掘金、知乎、头条、B 站视频、B 站图文、CSDN）。
> 全部结论都有当时的命令输出、DOM/AX 快照或 git 提交留痕，不是事后推测。
> 一句话结论：**大部分"失败"是我的操作问题；但其中相当一部分操作问题，是 ai-browser 的 API 设计没能拦住、也没能给出线索造成的。** 两者都要改。

---

## 0. 结论摘要

| 类别 | 数量 | 是否已处理 |
|---|---|---|
| 操作侧失误（我自己的锅） | 4 | 3 个已纠正，1 个（CSDN）需你登录后再补发 |
| 产品侧缺口（ai-browser 的锅） | 7 | **1 个已修并补单测**（P0-2），其余按优先级列了方案 |
| API 设计得好的地方 | 4 | 记录成"别改坏了"的清单 |

---

## 1. 操作侧失误：确实是我没操作对

### 1.1 B 站图文 —— 误判"编辑器不可用"，直接放弃转去做视频

- **我的结论**：`member.bilibili.com/platform/upload/text/new-article` 打开后只有导航壳，"SPA 挂空"，于是判定 B 站图文发不了，转投视频。
- **真相**：入口用错了（正确入口 `/platform/upload/text/edit` → 302 到 `/text/new-edit`），而且**没有用 `ui.get_tree {ax: true}`**，等待也不足（需要 ~25s）。
- **证据**：`ui.get_tree {ax:true}` 在该页返回 187 个节点，含
  `textbox#axf-3-1 editor=richtext actions=click|focus|type|setContent|clear`（正文编辑器）、
  `textbox#axf-3-0 "请输入标题（建议30字以内）"`、`button#axf-3-6 "发布"`。
  `axf-3-*` 的 id 前缀说明它来自被合并的第 3 号子帧 —— 而默认 `get_tree` 路径完全看不到它。
- **代价**：白绕一圈，还让运营计划里"图文"这条腿晚了一个回合。
- **教训**：**"没找到控件"必须先怀疑自己的读取方式，再怀疑目标。** "树里没有" ≠ "页面上没有"。

### 1.2 掘金 —— 漏填必填标签，且把 toast 当成功信号

- 发布弹窗的"添加标签"是红\*必填项，我没填。前端静默失败，只在行内弹"至少添加一个标签"；
  我却因为看到 toast "发布成功"就下了结论。
- **教训**：**成功信号的判定权不能交给 UI 自己的提示。** 必须以"结果对象的状态"为准（草稿箱是否清空、文章页是否 200、作者主页列表是否可见）。

### 1.3 CSDN —— 把"登录态失效"误判成"环境级 API 故障"

- 我的记录原文："发布按钮无响应，根因 bizapi.csdn.net 返回 401 X-Ca-Key is not exist，控制台 API 签名失败"。
- **复核真相（2026-10-17 03:00）**：登录态早就没了。
  - `editor.csdn.net/md/` 与 `mp.csdn.net` 均 302 到 `passport.csdn.net/login?code=applets`
  - `www.csdn.net` 顶部明写 **"未登录 登录领取最高￥30算力币"**
  - cookie 只剩 `uuid_tt_dd`/`fid`/`UN`/`BT`/`p_uid`/`csrfToken` 等埋点项，**没有** `UserName`/`UserInfo`/`UserToken`
  - `localStorage` 里也**没有任何草稿**
- 那条 401 很可能是会话失效的上游表现，我却把它当成了根因，还据此给出了"建议本人手动发布草稿"的建议 —— 而草稿根本不存在。
- **教训**：**排查顺序错了。** 最基础的先验（我还登着吗）没验，就去验 API、`ui.network_get`、Vue error handler，越查越深，离真相越远。也正是因为你这次点破，我才回头把它验干净。

### 1.4 知乎 / 头条 —— 绕过而非解决

- 两边都用"手搓合成 ClipboardEvent + DataTransfer(text/html)"注入正文，成功了，
  但我从未回头确认"这个能力是不是应该由工具提供"。答案是应该（见 2.4）。

---

## 2. 产品侧缺口：ai-browser 给了 agent 错误或不完整的世界视图

> 排序按"它让我犯错的严重程度"，不是按实现难度。

### P0-1 · 没有任何视口截图通道 —— "先看一眼截图"在当前 API 下做不到

- 现状：18 个 `browse_*` MCP 工具 + ~22 个 WS 方法里，**唯一能出图的是 `browse_canvas` / `ui.canvas_capture`**，
  它只能截 `<canvas>` 元素（给 ComfyUI 这类 canvas 应用兜底用的），源码里还带着自我免责注释：
  `warning: 'visual fallback; consumes caller visual tokens'`。**没有 `ui.screenshot` 可以抓视口 / DOM。**
- 影响：这是**最硬的一条**。你要求"操作失败第一反应结合截图看"是完全正确的排查直觉，
  但当前工具面把这个动作挡死了 —— 于是 agent 只能在"树里没有?"、"超时了?"、"报错了?"之间空转，
  而这几条恰好都容易指向错误结论（见 1.1、1.3）。**挖 1.1 那一天，一张截图能省掉两小时。**
- 建议：
  1. 新增 `ui.screenshot` / `browse_screenshot`，参数 `{ clip?: {x,y,width,height}, scale?, format?: 'jpeg'|'png', quality? }`，返回 `{ mime_type, data_base64, width, height }`；
  2. **opt-in**：默认不返回图，避免污染不想烧视觉 token 的调用方；在 `browse_capabilities` 里显式声明这个能力存在；
  3. 配套在 `ui.wait` 加一条 `condition: 'element_visible'`，让"等某个东西真的画出来了"成为一等公民。

### P0-2 · `setContent` 的假阴性：内容写进去了，却回 `cdp-input-failed`（**已修**）

- 现象：`setContent` 往 contenteditable 里写带换行的文本，回执
  `{success:false, error:'Input not verified — please re-read the tree and retry', method:'cdp-input-failed'}`，
  但 `get_value` 读回来内容**完整且正确**。实测 6 次，5 次报假失败。
- 根因：校验用的归一化保留了每一个 `\n`（注释里的初衷是对的 —— 怕把 `a\nb` 和 `ab` 判等价），
  但 contenteditable 编辑器普遍把一个语义换行渲染成**多个** `\n`。实测矩阵：
  - 输入 `"AA\nBB"` → 页面实际 `"AA\n\nBB"`
  - 输入 `"第一段。\n\n第二段。"` → 页面实际 `"第一段。\n\n\n\n\n第二段。"`
  - `got.includes(want)` 因此必然失配。
- 危害：比"误报成功"更隐蔽地误导 —— agent 会以为自己失败了，要么重试（可能重复输入），要么放弃（像 1.3 那样开始编原因）。
- **已落地**：
  - 抽出独立纯函数模块 `src/shared/input_verify.js`（`normalizeInputText` / `skeletalInputText` / `verifyInputText`），无 Electron 依赖、可单测；
  - 归一化口径改为：**`\r\n` 归一 → 压排版空白 → 连续换行压成一个**（仍然保留"有没有分段"这一层信息，所以不会退化成另一种谎报）；
  - 失败回执新增可诊断字段：`expected_chars` / `actual_chars` / `content_landed_ignoring_whitespace` / `hint`，
    明确区分"内容其实到位了、只是排版不同（该继续）"和"压根没落上去（该重来）"；
  - 新增 `tests/test_input_verify.js`（12 个用例，全部来自上述真实数据）；
  - **全量回归 29 个文件 / 441 个测试全绿，无破坏。**

### P1-1 · `ui.get_tree {ax: true}` 的存在感太弱 —— iframe 里的页面对 agent 是隐形的

- 现状：默认 `get_tree` 走 preload 提取路径，**跳过所有跨进程子帧**；
  只有 `ax: true` 才会走 AX 路径并做 OOPIF 合并（`page_manager._readOopifFrames`）。
  源码注释里甚至明确写了"editors rendered in cross-process iframes (B站 write-article: york/read-draft)"——
  **功能是专门为了这个场景做的，但我作为调用方从头到尾不知道这个开关存在，只能靠读源码发现。**
- 影响：直接导致 1.1。任何把编辑器放在 iframe 里的站点（B 站图文就是）在默认读取下都"没有编辑器"。
- 建议（按性价比排序）：
  1. **自动路由**：`get_tree` 内部若能探测到 ≥1 个跨进程 / 无法 siteswap 的子帧，自动走 AX 合并路径 —— 调用方不该为这件事操心；
  2. 退一步也要做**可发现性**：默认路径返回值里加 `context.frame_hints: { cross_frame_count: N, hint: 'N editor element(s) are inside cross-process iframes — call ui.get_tree {ax:true} to include them' }`；
  3. MCP `browse_get_tree` 的 tool description / schema 里把 `ax` 讲清楚。
  4. 顺带：`ui.evaluate` 到不了 OOPIF（这是 Chromium 的约束），文档里应明说，并指向 `ui.act` 作为跨帧写入的唯一通道。

### P1-2 · 没有 `paste` 动作：富文本格式只能靠绕过，且在 iframe 场景下完全无解

- 现状：动作全集只有 `get_value / click / hover / type / setContent / clear / upload / drag / wheel / press`。
  没有任何一个动作能带 HTML 语义落进去 —— `type`/`setContent` 是逐字符受信键入，纯文本，没有标题/代码块/加粗。
- 我怎么绕的：在每个平台都手写 `ui.evaluate` 派发合成 `ClipboardEvent('paste', {clipboardData: DataTransfer})`，
  知乎（Draft.js）和头条（ProseMirror）都吃这套，格式保留完整。
- **但在 B 站这种 OOPIF 编辑器里，这条绕路也断了** —— `ui.evaluate` 跑在主帧，`contentDocument` 返回 null。
  结果就是：B 站图文这次发出去的其实是**纯文本版**（我把 markdown 全剥掉、用"一、二、"中文序号做小标题，
  就是为了让纯文本状态下也不难看）。能用，但不是我想要的效果。
- 建议：新增 `ui.act {action:'paste', target, params:{ html?, text? }}`，在目标帧上下文里派发合成 `ClipboardEvent`。
  通路是现成的 —— `click` 已经能做到 `clicked_via:'oopif-click'`，把同一套 frame 定位复用到 paste 上即可。

### P1-3 · 没有"登录态"信号 —— 会话掉了，工具一声不吭

- 现状：从 `editor.csdn.net/md/` 被 302 到 `passport.csdn.net/login` 时，
  `get_tree` / `evaluate` / `act` 全部照常返回，没有任何"你被踢到登录页了"的提示。
  我在这个状态下继续操作了很久，直到把失败归因到 `bizapi` 的 401 上。
- 建议：
  1. `get_tree` 的 `context` 里加 `auth_wall`：当**当前 URL 命中已知登录域**（`passport|login|signin|sign-in|oauth|auth`），
     或**发生了跨站登录跳转**时返回 `{ from, to, detected_by: 'url'|'redirect_chain' }`；
  2. 新增轻量原语 `ui.auth_state`（"这个 tab 现在看着像登录态吗"），让 agent 能在长任务里低成本地自查；
  3. 这条成本很低、价值极高 —— 本次 CSDN 的全部误判都会在这一步行止步。

### P2-1 · 列表行的标题文本没进树

- B 站 opus 管理列表里，每行只剩 `[button] 编辑`，**该行的标题 `StaticText` 被剪掉了**，
  我无法从管理页定位哪条是新发的那篇，最后绕去公开空间页 `space.bilibili.com/<uid>/article` 才拿到链接。
- 建议：`filterInteractive` / prune 逻辑对 `listitem` / `row` / 表格行**保留首个 StaticText 作为 row label**。

### P2-2 · 必填态和远端校验错误不可见

- 掘金的红\*必填标签、`aria-required`、`invalid` 都不在 `node.states`；
  掘金返回的行内错误"至少添加一个标签"也不在 `context.modals` 里。
  这两件事同时缺，正是 1.2 能发生的全部条件。
- 建议：`states` 增加 `required` / `invalid`；`context` 增加 `validation_errors: [{ text, near }]`，
  从 `[aria-invalid]`、`.error`、form 下的提示文案里聚合。

### P2-3 · `ui.navigate` 死等 `load`

- SPA（尤其带 markdown 高亮的编辑器）永远不 fire load 时就挂死，还会把整个 tab 拖到无响应，
  之后所有 `act`/`evaluate` 都超时，进一步污染判断。
- 建议：`navigate` 增加 `{ wait_until: 'commit'|'domcontentloaded'|'load' }`，默认不用 `load`；
  超时返回里带上建议（"可换 `new_tab` 或 `close_tab` 重建"）。

---

## 3. 别改坏了：这几处的当前设计是正确的

诚实起见，以下 4 点在本次实战中帮了大忙，任何重构都应保住：

1. **`clicked_via` 区分路径**（`'cdp-click'` vs `'preload-click'` vs `'oopif-click'`）：
   我能立刻知道这一下到底走了受信链路还是合成事件。这种"把不确定性显式暴露给调用方"的做法非常对。
2. **`cdp-input-unchanged` 幂等短路**：相同内容重打会返回 `changes:0`，不会把草稿反复标脏。方向正确（本次只修了它的比较口径）。
3. **超时回执里明说"the action may have partially applied"**：避免盲目重试造成双倍输入。
4. **`_ensureAxHandles` + `data-ai-id` 按需 stamp**：目标定位稳定，跨帧也能 working。

---

## 4. 沉淀成纪律：操作失败时的排查顺序

这次最大的教训不是某个技术点，是**顺序**。以后按这个来：

```
1. 先验：这个 tab 还是登录态吗？（P1-3 落地后 → 看 context.auth_wall）
2. 先验：我真的读全了吗？→ ui.get_tree {ax: true}，等待 20~25s 再读一次
3. 先验：我说"成功"的证据是什么？→ 必须是结果对象状态（列表可见 / URL 200 / 草稿箱是否清空），
                                    不能是页面自己弹的 toast
4. 再看：目标控件的 states（disabled? required? invalid?）
5. 再看：context.validation_errors / modals
6. 最后才轮到：network body、页面 JS error、API 401 —— 这些是证据，不是原因，
   而且它们几乎总是第 1 步问题的下游表现
7. 全程：任何一步都不要在没有验证的情况下写进记录（"草稿已存"那次就是这么错的）
```

---

## 5. 待办清单

- [x] P0-2 输入校验假阴性 —— 已修，含单测，全量回归通过
- [x] P1-3 登录态信号 —— 已修（`src/shared/auth_wall.cjs` + `context.auth_wall` + `ui.auth_state` + MCP `browse_auth_state`），真实站点 15/15 通过
- [x] P0-1 `ui.screenshot` / `browse_screenshot` 视口截图 —— 已修，21 单测 + 26 项真实站点验收全过（支持 path 落盘；未知参数不再静默忽略）
- [x] P1-1 `get_tree` 跨帧自动路由 —— 已修，11 单测 + 14 项真实站点验收全过
- [x] P1-2 `ui.act {action:'paste', html}`（含 OOPIF 支持）—— 已修，10 单测 + 13 项真实站点验收全过
- [x] P2-1 列表行标题保留 —— 已修，7 单测 + 4 项真实验收（ignored 包裹层透传 + 行角色补 label）
- [x] P2-2 `states.required` / `states.invalid` / `context.validation_errors` —— 已修，12 单测 + 2 AX 单测 + 12 项真实验收（含子帧内的 required_hints / validation_errors）
- [x] P2-3 `ui.navigate { wait_until }` —— 已修，默认 domcontentloaded，6 单测 + 6 项真实验收
- [x] CSDN：登录态恢复后重新注入正文并发布 —— 已于 2026-10-17 13:40 完成

### 5.1 P1-3 落地时新发现的两个调用侧坑（2026-10-17，修 CSDN 发布时实测）

这两个不在原清单里，但都是这次真实撞上的，记下来避免重复踩：

1. **`ui.evaluate` 不等 Promise。** 页面里写 `(async () => { await ...; return 'x' })()` 会原样返回一个 Promise 对象，序列化后是 `{}`。
   任何"点了之后等一会儿再读"的逻辑都必须拆成两次调用（触发 → sleep → 点选），
   或者改用支持等待的原语。这是本次 CSDN 标签/声明两次设置"看起来成功了其实没动"的直接原因。
2. **`ui.act` 的 `target` 是 ref，不是 label。** 传 `target: '发布'` 会得到
   `Target not found for ref: 发布` —— 调用方必须先 `ui.get_tree` 拿节点 id。
   错误信息其实说清了（"for ref"），但第一次见到很容易以为支持文本标签。

---

## 6. 通用能力 vs 站点特化：先量，再改（2026-10-17）

### 6.1 问题

处理 B 站 / CSDN 时写了一批站点特化脚本（全仓库 256 个临时脚本里 142 个是站点特化、
731 处硬编码 `querySelector`）。要判断这到底是"每个网站单独适配"的必然，还是
"浏览器的通用能力不够"。标准是：**让 agent 像人一样看懂网页**，除非实在做不到。

### 6.2 第一版测量是错的 —— 分母被放大了 3 倍

第一版用「所有 `cursor:pointer` 元素」当分母，得出百度 43% / B站 33% / CSDN 61%，
看起来"一半可点目标看不见"，很像是抽取层的锅。

**这个结论是错的。** 根因：`cursor` 是**可继承**的 CSS 属性。给一张卡片设
`cursor:pointer`，卡片里每个 `div/span/svg/path` 计算出来全是 `pointer`。按元素数当分母，
CSDN 的 `.layout-menu-item / _info / _icon / _name` 被算成 4 个目标，而人看着只有 1 个
可点区块（点哪个位置效果一样）。B站 nav 的 `svg + path` 同理。

修正后的计量单位是**手型边界**：自己的 `cursor` 是 `pointer`、而父元素的 `cursor` 不是。
同样三个站，分母从 88/400/840 降到 38/88/254 —— **差 2~3.3 倍**。

同一批页面、同一时刻，两种口径的对比：

| 站点 | 元素口径（旧） | 边界口径（新） | 分母缩水 |
|---|---|---|---|
| 百度 | 88 → 43% | 38 → 82% | 2.3× |
| B站 | 400 → 33% | 88 → 97% | 4.5× |
| CSDN | 840 → 61% | 254 → 88% | 3.3× |

**教训：先确认分母的定义和人的直觉一致，再谈覆盖率。** 差 3 倍的分母足以让结论反转一次。

### 6.3 修的是什么（`src/preload/extractor.cjs`）

修正分母后仍有真缺口，且根因很具体：`isSemantic()` 判可点性用的是
`typeof el.onclick === "function"`。**Vue / React 一律走 `addEventListener`，元素上的
`onclick` 属性恒为 `null`** —— 这条判据在框架站上等于永远为假。加上 `isPureLayout()`
对裸 `div/span` 一律剪掉，于是这类元素两条路都走不通。

补的是一条判据、两个约束：

- 判据：`cursor:pointer` 是**浏览器自己算出来的**可点性（人手看到手型就知道能点，
  浏览器也照这个画）。读它等于读"浏览器怎么理解这个元素"，比猜 `.btn` 这类私有类名通用。
- 约束一：只收**手型边界**（父元素不是 `pointer`），否则语义树会按继承关系膨胀 3 倍，
  agent 还得从一堆同义节点里挑。
- 约束二：必须能读出名字（`aria-label` / `title` / 自身文本 / 内含图标任一），
  否则 agent 拿到无名节点照样没法选。

还补了一条判重：外层只是**单个交互元素外壳**时不重复收节点。CSDN 每个导航项都是
`<div class="layout-menu-item"><a class="layout-menu-item_inner">首页</a></div>`，
div 是手型边界、`<a>` 本来就在树里。不加这条，树里会出现两个同名「首页」——
这不是能力，是噪声。判据是"内层盖满外层 ≥90%"（大卡片里放一个小链接时两者是不同目标，
那条通路要保留）。

### 6.4 改完的实测（同批次、同探针、顺序对照）

`node tools/coverage_probe.cjs <url> [waitMs]`（覆盖率低于 80% 时 exit 1，可进 CI）

| 站点 | 树节点 | 可点目标 | 直接可操作 | 真缺口 | 可用率 |
|---|---|---|---|---|---|
| 百度 | 64 → 70 | 38 → 38 | 31 → 37 | 6 → **0** | 84% → **100%** |
| B站 | 215 → 218 | 88 → 88 | 85 → 88 | 2 → **0** | 98% → **100%** |
| CSDN | 658 → 694 | 254 → 257 | 224 → 257 | 12 → **0** | 95% → **100%** |

代价：`get_tree` 平均 38~41ms（改前同量级，无感）；节点数只涨 3~36 个（判重规则把它们压住了）。

新出现的都是**真入口**，不是凑数：B站 `nav-search-btn`（搜索按钮）、
`header-avatar-wrap--container`（个人中心）、`watchlater-pip-button`（稍后再看）；
百度「下载」「辅助」、语音输入按钮；CSDN 33 个。

判重规则的取舍也验证过一次：CSDN 节点数在"只验内层在外层里"时是 672，加上
"内层还要盖满外层"后升到 694 —— 多出来的正是「大卡片里放小链接」那种情形，
点卡片和点链接是两回事，必须两条通路都留（`tests/test_click_boundary.js` CB-5 钉住）。

回归钉在 `tests/test_click_boundary.js`（10 条，CB-1..CB-10），刻意配了阴性对照
（没有 pointer 的 div 不进树、3×3 的点不进树、无名字无图标的进不去）和阳性对照
（大卡片里的小链接不吞掉外层），避免以后"优化"成"什么 div 都收"或"什么壳子都删"。
全量 585 单测 / smoke 31/31 / audit 35/35 通过。

### 6.5 结论

1. **"看不懂网页"不是主要瓶颈。** 三个真实站点改前已覆盖 84~98%，改后 100%。
   特化脚本不是被"看不见元素"逼出来的。
2. **真正的瓶颈在动作层，不在理解层。** 这次 B站/CSDN 的硬骨头都是动作问题：
   跨进程（OOPIF）上传 —— `DOM.setFileInputFiles` 只能写顶层文档；富文本块级编辑；
   需要受信输入的画布。这些要靠 CDP 补，不是靠加站点选择器。
3. **判据要读渲染结果，不要读作者写法。** `onclick` 属性、类名都是"作者怎么写"，
   `cursor`、尺寸、命中区是"浏览器怎么渲染"。后者对框架无关，是通用能力的来源。
4. **特化脚本降级为兜底。** 顺序应该是：读树看不清 → 先查是不是抽取层漏了（跑
   `coverage_probe`）→ 再查是不是动作层不够 → 最后才写特化脚本。反过来先写脚本，
   等于把通用层的缺口用 142 份复制粘贴盖住。

### 6.6 明确留下的缺口（这几条暂时靠通用层做不到）

| 缺口 | 实测 | 为什么通用层做不到 |
|---|---|---|
| 可点节点没有可读名字 | B站 75/141（53%）、CSDN 205/545（38%） | 页面自己没给名字：纯图片链接、无 `alt`、无 `aria-label`、无文本。其中只有 24/75 能从后代属性里补。**凭空造名字就是猜**，宁可留空 |
| 跨进程上传 | B站图文 / CSDN 封面上传 | 文件输入在 OOPIF 里，`DOM.setFileInputFiles` 只作用于顶层文档。通用解是 `frame.executeJavaScript` + `DataTransfer`，已落地；但组件"有封面时 input 未挂载"这类行为限制无法绕过 |
| 富文本块级编辑 | B站图文正文 | 需要按段落定位、跨块选区。已在读层给出 `editor_blocks`，动作层仍只有整段 `setContent` |
| 画布类交互 | ComfyUI 等 | 元素不是 DOM 节点，只能靠坐标 + 受信输入，没有"读树"这条路 |

### 6.7 一个调用侧坑（延续 5.1）

`ui.act` 的目标参数名是 `target`，不是 `ref`。传 `ref` 会得到
`{"success":false,"error":"No target"}` —— 这个报错**没提参数名**，很容易被误判成
"元素不在页面里"。验证点击可用性时踩了一次，记下来。

## 7. B站 全流程实测：通用能力到底够不够（2026-10-17）

### 7.1 测法与纪律

用户的要求是：**打开帖子、发评论、回复评论、发新动态，能不能全靠通用能力完成，
不截图、不为 B站 写任何专用选择器。**

驱动脚本 `tools/_oneoff/gb.cjs` 只有五个函数：连 WS、等、拍平树、按
`role`/`label`/`actions` 找人、归一化标签（去零宽字符）。**文件内不含任何
站点 CSS 选择器**——一旦出现 `querySelector('.bili-xxx')`，这次验证就失去意义。

判定"真的成功了"一律用**独立回读**：重新 `ui.navigate` 到同一 URL，再从新树里找文本。
DOM 内存里的残留不算证据。

### 7.2 四段结果

| 任务 | 怎么找到的 | 怎么做的 | 独立回读 |
|---|---|---|---|
| 打开帖子 | 动态卡片上的 `link`（有 label） | `click` → `opened_tab` 指向 `/opus/1260131520487620616` | 新标签页 URL 正确 |
| 发新动态 | `textbox`（label 是 `\u200B`）→ 「发布」→ 二次确认「确认并发送」 | `type` → `click` → `click` | 正文框清空、弹窗消失；个人空间动态页读回原文 |
| 发评论 | 评论区 `textbox`（shadow DOM 内）→ 「发布」 | `type` → `click` | 页面出现评论文本、草稿清空 |
| 回复评论 | 「回复」`button` → 新出现的 `textbox` + 就近配对的「发布」 | `click` → `type` → `click` | 回读层级：文本落在 `bili-comment-thread-renderer → bili-comment-replies-renderer → bili-comment-reply-renderer` 之下，确认是"评论的回复"而非并列评论 |

四段全部完成，**没有用到截图，没有写任何站点选择器**。

### 7.3 过程中必须先修的两个通用缺口（已修）

B站 opus 详情页整块评论区装在 `<bili-comments>` 的 **shadow root** 里。

- **读层**：`el.children` 看不到 `el.shadowRoot`，DOM 通路只读出 45 个节点、
  评论面板是个空 `tabpanel`（AX 通路能读 190 个，但 `ax-{id}` 在动作层解析不了）。
  修法是 `childrenOf()` 同时返回 shadowRoot 的子元素。同一页 45 → 72 节点。
- **写层**：`document.querySelector('[data-ai-id=...]')` **不跨 shadow 边界**，
  于是树里看得见、点不到。修法是 `findRef()` / `findRefExpr()` 递归穿透 shadow root。
  回归在 `tests/test_shadow_dom.js`（SD-1..SD-9，含三层嵌套与 closed root 不抛错）。

这两条都不是 B站 专用写法：YouTube 的 `<ytd-*>`、各家设计系统的 `<ui-*>` 一样。

### 7.4 本轮发现的三条缺口（**全部已修复**）

先把现象写清楚，再说修法。三条都是"不报错、只是给错答案"的类型，比崩溃难查得多。

| 缺口 | 实测现象 | 根因 |
|---|---|---|
| `type` 在 shadow 内报假阴性 | `{"success":false,"error":"Input not verified","actual_chars":0}`，但回读 `value` 是完整文本 | 输入校验用 `document.activeElement` 读回内容，而它在 Web Component 里**只到宿主**为止，宿主里没有文本 → 读到空串。**这是最危险的一类：会让调用方以为没打进去而再打一次，造成重复输入** |
| `press Enter` 激活不了聚焦元素 | 先 `focus` 一个按钮再 `press Enter`，页面收到 keydown（`isTrusted=true`），但 `onclick` 一次都没触发；同元素 `click` 正常 | CDP 的 `rawKeyDown` **刻意不带 text**，浏览器只派 keydown、不产生 keypress，而 Enter 的默认动作（按钮 click / 链接跳转 / 表单隐式提交）挂在 keypress 上。Puppeteer 有效，是因为它的键表给 Enter 配了 `text='\r'` |
| 无 role 的自绘菜单项被并进触发按钮 | 动态卡片的「置顶/删除」在树里只剩一个 `label="取消置顶  删除"` 的节点 —— 看着像拿到了入口，实际**点不了**；只能靠坐标点击兜底 | 菜单项是纯 `div`，`cursor:pointer` 从触发按钮**一路继承**下来，"父元素 pointer 就抑制"的边界规则把整张菜单并成了触发按钮。那条规则本意是防"卡片里每个装饰都收一遍"（CSDN 会涨 3 倍），但它分不清"卡片里的标题"和"浮层里的菜单项" |

修法与回归：

1. **校验读回穿透 shadow** —— 新增 `src/shared/deep_active.cjs`，沿
   `shadowRoot.activeElement` 下钻取最里层；`type` 的四处读回（幂等短路、段间快照、
   最终校验、paste 落盘校验）与 extractor 的 `focused` 状态 / `focused_element_id`
   全部换成这个口径。同时把 `type` 里三处"往下找可编辑元素"的 `querySelector`
   换成 `findDescExpr`（shadow 感知）。
   回归：`tests/test_deep_active.js` DA-1..DA-5。
   端到端（`file://` 自建 Web Component，不碰任何真实数据）：改为
   `{"success":true,"method":"cdp-input","chars":33}`。

2. **按键默认动作** —— 新增 `src/shared/key_dispatch.cjs`（纯函数，
   `keyDispatchPlan`），`ui.act press` 走"带 text 的 keyDown"，`type` 的段间换行
   仍走 `rawKeyDown`（不能全局改：type 的策略是"先发不带 text 的 Enter，看编辑器
   有没有自己分段，没分才补 char"，全局改会变成先插 `\r` 再补一个，多出空行）。
   回归：`tests/test_key_dispatch.js` KP-1..KP-6。
   端到端（`tools/_oneoff/probe_press_enter.cjs`）：Enter 让 `onclick` 从 0 → 1，
   Space 也能激活。

3. **脱流浮层内的菜单项** —— extractor 增加浮层识别：`position:fixed` 直接算浮层，
   `position:absolute` 且**盒子溢出父块**才算（用"溢出"而不是"脱流"本身，是为了
   不把整页绝对定位的布局当成浮层）；浮层内只收**最内层**可点元素，绕开
   "父元素 pointer 就抑制"的合并。实测 B站 那张菜单：
   `取消置顶 e:div-371 (840,393,52×18)`、`删除 e:div-372 (840,433,26×18)`
   各自是可点节点，点击后正常弹出二次确认（验证时点「取消」，未改动任何数据）。
   回归：`tests/test_floating_layer.js` FL-1..FL-7（含两条阴性：卡片里的小链接不吞
   外层、整页绝对定位不按浮层处理）。
   膨胀实测（`tools/coverage_probe.cjs`）：百度 70/37 → 70/37、B站 218/88 → 226/95、
   CSDN 694/257 → 698/258 —— 只是多收了几个菜单项，没有回到 3 倍。

回归总账：**624 单测 / smoke 31/31 / audit 35/35** 全过。

### 7.5 结论

**"能不能不做站点定制"的答案是：能，条件是先把这三处通用缺口补上。**

- 四个任务的主角（输入框、发布按钮、回复按钮、开关型二次确认）在语义树里
  都**本来就看得见**，靠 `role` + `label` + 几何就近配对就能定位，零站点知识。
- 卡住的地方**从来不是"认不出控件"**，而是三件事：内容在 shadow DOM 里、
  按键的默认动作没被触发、浮层里的菜单项没有语义。三者都是通用机制，
  修一次对所有站点生效 —— 这正是"通用能力"该有的形状。
- 顺带一条纪律：**删除/清理这类"事后动作"也要按同一套通用通路走**。
  修好之后，动态卡片的「删除」走的是正常节点点击 → 二次确认，不再需要坐标兜底。
  坐标点击仍应保留为最后手段（`ui.act {action:'drag', params:{from:{x,y},to:{x,y}}}`
  同点即点击），但它是**降级**，不是常规路径。


## 8. 富文本与发送流程实测（B站 / CSDN，2026-10-17）

问的是同一个问题：**不截图、不做站点定制，能不能把"写 → 格式化 → 发送 → 清理"全程走通。**
判断一律只用 `role` + `label` + `states` + `bounds`；截图只作为给人看的证据
（`outputs/verify-2026-10-17/`）。驱动脚本 `tools/_oneoff/*.cjs` 内**零站点选择器**。

### 8.1 结果总表

| 站点 | 动作 | 靠什么定位 | 独立回读 |
|---|---|---|---|
| B站 | 写正文（含换行） | `textbox`（label 是零宽字符 `\u200B`），按"无名字 + 宽度"选中 | 重载后 `label` 里带 `\n`，服务端持久化 |
| B站 | 插表情（富文本） | 点工具栏第一个图标 → 弹层 `tooltip` + 网格图片单元 → 点一个 | 正文出现 `<img alt="[doge_金箍]">`，字数 54→63 |
| B站 | 发布 | `label="发布"` 的可点节点（role 是 `generic`，不是 `button`） | toast「发布成功」+ 首页卡片出现 + 重载仍在 |
| B站 | 删除 | 卡片右上 24×24 → 菜单项 `删除` → `dialog` 里 `确认删除` | 重载后命中 0 处 |
| CSDN | 写标题/正文 | `textbox` 带 placeholder + iframe 里的 `textbox` | 21 字 / 38 字，`type` 直报 success |
| CSDN | 加粗（富文本） | 工具条 `link "加粗 (⌘+B)"` → 输入 | 编辑器 HTML 出现 `<strong>…</strong>`，工具栏 B 按下 |
| CSDN | 存草稿 | `button "保存草稿"` | toast + 状态行；重载后顶部「草稿…继续编辑」→ 点进去内容与 `<strong>` 完整 |
| CSDN | 发布 | 表单（`文章标签*` / `摘要` / `可见范围` radio 组）→ `button "发布博客"` | 跳 `/creation/success/168250444`「发布成功！正在审核中」 |
| CSDN | 删除 | 行尾 `…`（无名节点）→ `li "删除"` → `dialog` 确定 → `彻底删除` | 重载后命中 0 处 |

### 8.2 两个站点暴露的是**两类完全不同**的问题

**CSDN（CKEditor）几乎满分**：37 个工具按钮全有名字（`加粗 (⌘+B)`、`代码`、`表格`、`图像`、
`公式`、`链接`、`模版`…），发布表单是标准控件，`radio` 组还有 `radiogroup` 语义。
唯一别扭的地方是**同名不同粒度**：树里同时存在 `link "加粗 (⌘+B)"`（36px 宽，真按钮）
和一个 `presentation` 容器 `span`，后者的 label 是"加粗快捷键 Command+B 颜色 背景"（138px 宽）。
按名字取第一个就点进了「颜色」。**判据要加上盒子宽度/是否真按钮**，这是调用侧的事，
不是树的问题（树把两种粒度都给了，反而够用）。

**B站几乎全靠"行为"而不是"名字"**：动态发布框的工具栏 5 个图标
（`div.…tools__item`）没有 `aria-label`、没有 `title`、没有 `alt`，AX 层也不给名字 ——
树里就是 5 个 `24×24` 的空名可点节点，**无法从任何元数据判断哪个是表情、哪个是图片、哪个是投票**。
可行的通用办法只有"点开看面板"：投票面板一开就是完整语义（`radio 文字投票/图片投票`、
带 placeholder 的选项框、`button 添加选项`），表情面板是网格图片单元 —— 面板内部很好读，
代价是**入口本身要靠试**。这类入口的盲点来自站点没写可访问信息，通用层无法凭空补出来。

### 8.3 本轮顺带修掉的两条通用读法（都是标准，不是站点特例）

| 缺口 | 实测现象 | 修法 |
|---|---|---|
| 图片 `alt` 没进名字 | B站正文里插的表情是 `<img alt="[doge_金箍]">`，树里 `role=image` 但 `label` 是空串 ——"插进去的是哪个表情"读不出来 | `extractLabel` / `elementName` 按 HTML-AAM 读 `alt`（`alt=""` 的装饰图不制造假名字）；顺带读 `input[type=submit/button/reset]` 的 `value` |
| 自绘单选没有选中态 | CSDN「可见范围」可点的是 `<label>`，真控件是 `opacity:0` 的 `<input type=radio>`；四个选项在树里**长得一模一样**，只有 `visible`，选中了哪个只能看截图 | `states` 增补：`label.control` / `label[for]` 关联控件的 `checked`、`aria-checked`、`aria-selected` |

修完实测：CSDN 四个选项变成 `仅我可见 ["checked","visible"]`，其余三个只有 `visible`；
B站首页 52 个 `image` 里 12 个有了名字（百度 3 个图全是 `alt=""`，仍然 0 个，说明没有造假名）。
回归：`tests/test_a11y_names.js` 8 条（含 1 条阴性），全量 **632 单测 / smoke 31/31 / audit 35/35**。
节点数没有膨胀：百度 70/37、B站 216/89（前值 226/95）、CSDN 690/254（前值 698/258），可用率均 100%。

### 8.4 结论

**"不截图、不做站点定制"在主路径上是成立的**：两个站点的写、格式化、存/发、确认、清理
全部只用了 `type` / `click` / `press` 与语义树，没有任何站点选择器，也没有一次靠截图做判断。

**仍然不成立的是三类"入口本身没名字"的情形**（都是站点侧的 a11y 缺失，通用层补不出来）：

1. B站 动态工具栏 5 个图标：只有 CSS class（`…tools__item emoji`），没有任何可访问名。
2. CSDN 列表行尾的 `…`：空名节点，点开之后菜单项才有名字（`li "删除"`）。
3. 按需渲染的入口（上一轮 B站 评论「更多」）：要先 hover/Tab 才进树。

对这三类的通用降级手段是**行为探测**：先点/悬停，再看新出现的节点（`tooltip` 面板、
`dialog`、`menu` 里的 `li` 都是有名字的），必要时 `Escape` 撤回。这比"猜坐标"稳，
但要求调用方接受"点一下看看"这种交互代价。

## 9. ui.peek 的修复：从"报不出来"到"报出来就能点"（2026-10-17）

`ui.peek` 的定位是"悬停一下，把因此冒出来的东西报出来，不提交"。它此前基于 AX 树做
差异比较，实测在 B站 上一无所获。修完之后，B站 头部「收藏」的下拉能稳定报出
`默认收藏夹` / `稍后再看` / `生活小技巧` 等项，且报出的 id 可以直接 `ui.act click`。

### 9.1 先隔离：它到底是坏了，还是站点不响应悬停

用一个自建对照页（两个结构完全相同的菜单，区别只在菜单项有没有 `role="menuitem"`）：

| 菜单 | 旧的 peek（AX 源） |
|---|---|
| `role=menuitem` 的 | 报出 2 项 ✅ |
| **纯 `div` 的** | **报空** ❌ |

**peek 本身没坏，是数据源错了。** 我之前在清单里把它写成"真 bug"，是被隔离实验推翻的。

### 9.2 根因：自绘菜单在 AX 里是"无名的 generic"

实测DOM 确实展开了（`m1` 140×74），AX 也看到了 7 个新节点，但两个菜单项长这样：

```
generic ""                 ← 名字是空的，文字跑到子节点去了
StaticText "普通选项一"     ← 名字在这
```

而 AX 侧"可交互"的判据是 role 名单 / editable / focusable，`generic` 一条都不占 → 整片滤掉。

顺带一个更要命的：**AX 的 id 形如 `ax-20`，动作层解析不了**（实测
`Target not found for ref: ax-291`）。也就是说以前就算探到了，报出去的 id 也点不了。

### 9.3 修法：换成 DOM 语义树，并在"'探到'到'能点'"之间补一环

`src/shared/tree_diff.cjs`（纯函数，可单测）。DOM 读层有 `isHumanClickable` +
`floatingLayerOf` + `elementName`，正好能认出自绘菜单项 —— 同一页实测，DOM 侧报出
2 项，都带 `actions:["click"]` 和坐标。

换源之后又暴露出三个必须处理的问题，都是实测逼出来的：

**① 快照顺序。** 原先是"先挪开鼠标落基线 → 再悬停"，要求基线是干净的，也就是鼠标必须
真的已经离开、菜单已经收完。这条做不到：B站 那个下拉鼠标挪开后要 **491 / 496 / 522ms**
（轮询实测 3 轮）才从 DOM 消失。写死等待 150ms 只有 2/4 命中，550ms 也照样漏。
改成**先悬停拍 A、再挪开拍 B**，`revealed = A \ B` —— 两张快照都是自己亲手造成的，
与调用前的鼠标位置无关。改完连续 8 次全中。

**② 自适应等待没用。** 试过"轮询元素总数直到不再减少"，行不通：页面自己一直在抖
（B站 首页有轮播与懒加载，元素总数常态波动），"稳定"永远达不到，每回都跑满 12 次
（1080ms）。改回固定 600ms —— 但这是量出来的，不是拍的。

**③ 菜单重开后 id 全变。** `revertMs:0` 要把鼠标移回目标让菜单重新展开，而重开时 DOM
是新造的节点：实测原先报出的 `e:div-208` / `e:div-209` / `e:a-229` 全部消失。
加了 `remapIds()`：移回后重新拍照，按 `(role, label, bounds)` 三元组把 id 重新绑到
新节点上，只换 id、其余信息沿用。三元组全中才认，对不上就保留原 id（调用方拿到
`target_not_found`，比悄悄点到别的东西上安全）。

### 9.4 闭环验证（真实站点，B站 首页）

```
ui.peek { target: 收藏, hoverMs:600, revertMs:0 }
  → revealed: e:div-208 "默认收藏夹809" ["click"] {x:683,y:81,145×46}
ui.act { action:'click', target:'e:div-208' }
  → 页签状态从 ["稍后再看12[选中]"] 变成 ["默认收藏夹809[选中]"]
```

不只是"接口说成功"，是真的切了页签。

另有两条**报空是对的**，记下来免得以后当成 bug 修：
- B站 视频卡片：卡片上的浮层按钮（`添加至稍后再看`）本来就渲染在 DOM 里，只是视觉
  隐藏，悬停不改变 DOM → 报空是正确的，没有假阳性。
- `e:div-209 "稍后再看12"` 点了不跳转：它是**收藏面板内部的页签**，不是导航链接
  （里面没有 `<a href>`）。是我一开始的预期错了。

### 9.5 回归

| 项 | 结果 |
|---|---|
| 单测 | **646 通过**（+17 条 `test_tree_diff.js`，-3 条随 `diffAx` 删除） |
| smoke / audit | 31/31、35/35 |

删掉的 3 条（AX-009/010/011）里，AX-011 断言"非交互的新节点必须被省略" ——
**这条语义正是 peek 看不见自绘菜单的元凶**，翻转后的行为由 TD-3 守住了。

### 9.6 回过头验原始场景：B站 评论「更多」（旧清单里的第 2 条）

旧清单第 2 条写的是「评论右侧的『更多』按钮悬停不出来，Tab 能聚焦、click 才打得开」。
在 B站 视频页（BV1GJ411x7h7）用修好的 peek 重跑这个场景：

```
ui.peek { target: 评论行容器, hoverMs:800, revertMs:0 }
  → revealed: button "" e:button-1292 {x:753,y:391,24×24} ["click","focus","hover"]
ui.act { action:'click', target:'e:button-1292' }
  → 菜单展开：li "复制评论链接" / li "举报"
```

**结论：能探出来了。** 关键在于找对悬停对象 —— 要悬停**整条评论行**，不是那个按钮本身
（按钮是行被悬停之后才渲染出来的，悬停按钮自己是先有鸡还是先有蛋）。

两点如实记下：

1. 探出来的按钮**名字是空的**（24×24 的 `button ""`），B站 没给它任何可访问名。
   所以调用方只能从"悬停评论行后多出来一个 24×24 可点按钮"来推断它是「更多」，
   无法从 label 确认。这正是 §8.4 说的"入口本身没名字"，属于站点侧缺失，
   通用层补不出来 —— 但至少现在**能找到它、能点开它**，不再需要靠 Tab 碰运气。
2. 点击走的是 `preload-click`（CDP 坐标命中的前置校验没过，回退到原生 click）。
   当时我猜是"坐标有偏差"，**这个猜测是错的** —— 实测坐标 dx=0 dy=0，一点不偏。
   真实原因见 §10：命中探测用的 `document.elementFromPoint` 不穿透 shadow boundary，
   而这个按钮（以及整块评论区）都在 `<bili-comments>` 的 shadow root 里。
   §10 已修复并验证，现在同一按钮报 `cdp-click`。

过程中还顺带看到：悬停评论里的用户名会浮出 `bili-user-profile` 名片，
peek 也把它报出来了 —— 悬停带来的东西它都报，不只是菜单。

## 10. 由 §9.6 牵出的真问题：命中探测不穿透 shadow（2026-10-18）

§9.6 第 2 点我原本写的是"坐标有偏差，值得单独看一眼"。**这个猜测是错的**，
实测把坐标打出来一比，dx=0 dy=0，一点不偏。真实原因更严重。

### 10.1 现象

在 B站 视频页那条评论的「更多」按钮上（`e:button-2368`，bounds 733,377,24×24，
中心 745,389），同一时刻、同一元素，两种口径给出相反答案：

```
document.elementFromPoint(745,389)  =>  BILI-COMMENTS e:bili-comments-81   ← 宿主
旧判定 h===el || el.contains(h)     =>  false
新判定（含 shadow 祖先）            =>  true
```

整块评论区装在 `<bili-comments>` 的 shadow root 里，而 `elementFromPoint` 和
`querySelector` 一样**不跨 shadow boundary** —— 它返回的是宿主。

### 10.2 后果：点击被静默降级

`_cdpPointerTarget` 在派发点击**之前**要证明"这个坐标会落在目标上"，过不了就
`return null`，于是 `executeAction` 回退到 preload 的 `focus()+click()`（合成事件）。
这道校验对影子内部的元素**恒为假**，所以：

- 每次点击都走非受信路径，而"降级"这件事**不报错** —— 回执仍是 `success:true`；
- 对只认真实指针序列的编辑器（CKEditor / ProseMirror / Draft.js）会直接失效；
- 唯一的线索是回执里的 `clicked_via`，不看它的人永远发现不了。

判据就是它：修复前 `clicked_via:"preload-click"`，修复后 `"cdp-click"`。

### 10.3 修法（`src/shared/hit_point.cjs`，新增）

1. **下钻**：`ShadowRoot` 实现了 `DocumentOrShadowRoot`，`shadowRoot.elementFromPoint(x,y)`
   是标准 API（不是 hack），坐标同为视口坐标。命中后逐级钻到没有 `shadowRoot` 为止
   （带 32 层上限，防页面套娃时转不出来）。
2. **上溯判定必须换成含 shadow 的版本**：`Node.contains()` **不是**
   shadow-including 的 —— 影子树是独立的 node tree，隔一层 shadow 照样返回 false。
   所以要沿 `parentNode || ShadowRoot.host` 上溯。
3. 连带把拖拽那两处的 `e.closest('[data-ai-id]')` 也换了：closest 走到影子树顶就停，
   影子内部的元素永远得到 `id:null` → `is_target` 恒为 true → **"抓错节点"的检测被
   静默跳过**，而那正是它存在的意义。

### 10.4 先隔离，再下结论（这次没再靠猜）

`tools/_oneoff/shadow_hittest.html` 造了 4 种情形（结构相同、只差隔了几层 shadow），
`shadow_hittest_probe.cjs` 实测：

| 情形 | flat（旧） | deep（新） | 旧判定 | 新判定 |
|---|---|---|---|---|
| A 裸元素（对照） | A-plain | A-plain | true | true |
| B 一层 shadow | DIV（宿主） | B-inner | **false** | true |
| C 两层 shadow | DIV（宿主） | C-deep | **false** | true |
| D shadow 内被浮层盖住 | DIV | DIV | false | **false** |

最后一行是关键的阴性对照：换算法没有把"真的没命中"也放行。
新判定是旧判定的严格超集 —— 命中链就是目标的祖先链，原本为真的情形仍为真。

### 10.5 真实站点闭环（B站 视频页评论区）

```
ui.peek { target: 评论行, hoverMs:400, revertMs:0 }
  → revealed: button "" e:button-2368 {x:733,y:377,24×24} ["click","focus","hover"]
        （实测 in_shadow=true, host=BILI-COMMENT-ACTION-BUTTONS-RENDERER）
ui.act { action:'click', target:'e:button-2368' }
  → {"success":true,"clicked_via":"cdp-click"}
  → 菜单真的展开：li "复制评论链接" / li "举报"
```

只打开读了内容，没点任何破坏性项，随后 Escape 收起。

### 10.6 回归

| 项 | 结果 |
|---|---|
| 单测 | **658 通过**（+12 条 `test_hit_point.js`） |
| `e2e:all` | **13 套件 / 447 断言 / 0 失败**（含 richtext 117/117、upload 18/18） |

（smoke 31/31 与 audit 35/35 已包含在上一条里；先跑这两套时曾漏掉两条红，
见 10.7/10.8 —— 只跑它们是不够的。）

### 10.7 顺带发现：上一轮改 peek 时漏跑 richtext，B-13 一直红着

跑 richtext 时冒出 1 条失败：B-13「peek(revertMs=5000) → 2.2s 后菜单仍展开」。
查下来是**上一轮重写 peek 时改了契约、却没重跑这套 e2e**：

- 旧契约：peek 立刻返回，另起 per-tab 定时器在 `revertMs` 之后把鼠标挪开，
  于是 `revertMs=5000` 意味着"菜单还会开 5 秒，agent 趁这段时间去点"。
- 新契约：peek 是**同步**的 —— 悬停拍一张、挪开拍一张、差分、返回，返回时鼠标
  已经挪开、页面回到基线；**只有 `revertMs:0`** 会再把鼠标移回目标并保持展开。

砍掉延迟窗口的理由：那个"菜单还开着"的窗口是与 agent 下一步动作的**竞态**，
而 `revertMs:0` 是确定的。已把 B-13 翻面并写明原因（不是把测试拧向实现），
同时改掉 B 段里两处已经过时的结论说明（"revertMs 传 0 无效""定位不到静默返回空"）。

教训：改了语义就要跑全量 e2e，不能只跑 smoke/audit —— 那两套覆盖不到 peek。

### 10.8 同一轮里另一条红：view 套件的 D-01（也是契约变了没同步）

`e2e:all` 里 view 套件 D-01「传错参数层级 → 明确报错」红着，报
`{"success":true,"method":"cdp-input","error":""}`。与 10.7 同一类成因：

前一个 commit「stop swallowing params」把 `shared/act_params.cjs` 的
`hoistActParams` 加进 WS 边界 —— **顶层平铺的已知动作参数不再被静默丢弃**，
而是被提升进 `params.params`，回执里带 `params_hoisted` 说明"这两个是被提升的"。
所以"扁平 text 必须报错"这个断言已经过时：现在扁平 text 是**故意支持**的
（MCP 就是扁平形状，之前那种"照 MCP 写法就静默变空文本"才是 bug）。

已把 D-01 翻面成"扁平参数真的生效 + 回执明确告知被提升"（实测
`hoisted:["text"]`，输入框值 `"flat params"`），并补 **D-01b** 守住真正该守的
阴性：压根没给 text 时必须报 `type called with empty text`（实测
`method:"cdp-input-empty-text"`）。

顺带量到一条边界事实：空文本守卫只在"目标为空**且**当前内容也为空"时触发；
字段非空时 `type` 不带 text 走的是输入校验分支，报 `cdp-input-failed`
「Input not verified」。同样不谎报成功，只是信息不同 —— 测这条守卫要先 clear。

### 10.9 同一个坑的其余入口：全部按 ref 定位的地方（已修）

命中探测只是"不穿透 shadow"这个坑的**一个**入口。把 `src/` 全扫一遍，
凡是用 `document.querySelector('[data-ai-id=...]')` 定位的地方都有同一个毛病
——影子内部的目标拿不到 el，各自的表现不同，但**都报成功或都像"元素不存在"**：

| 位置 | 够不着时的表现 |
|---|---|
| `_cdpWheel` 落点元素 | 落点静默退化成**视口中心**，滚轮打在完全无关的地方还报 success |
| `_cdpPress` 的 focus | focus 被跳过，按键发给"当前焦点"（多半是 body）→ 快捷键毫无效果 |
| `stripEmptyShells`（输入前） | 与同函数里的 `prep`（已穿透）口径不一致 → 清干净了还被判成没清掉 |
| `ui.scroll {target}` | 返回 `{ok:false, error:'target not found'}`，元素其实就在那儿 |
| `_uploadViaFrameJs` | 按 ref 找宿主、找后代 `input[type=file]` 都不穿透 → `no-el` |

全部换成 `findRefExpr` / `findDescExpr`（后者穿透找后代）。上传那条路里
"找后代"原本是 `root.querySelector('input[type=file]')`，宿主若是 `<bili-*>`
就永远找不到 —— 换成 `findDescExpr` 会下钻 `el.shadowRoot`。

### 10.10 真实站点验收（B站 视频页评论区，靶子在 BILI-COMMENTS 的 shadow 里）

每条都做**新旧对照**，只报"新路径通过"不足以证明修了什么：

```
[对照0] {"flat_query":false,"pierced":true,"shadow_host":"BILI-COMMENTS"}
        ↑ 顶层 querySelector 确实够不着，穿透版拿得到 —— 前提成立

[ui.scroll   {target}] {"ok":true}                     旧：target not found
[ui.act wheel{target}] {"success":true,"at":{"x":450,"y":349}}
                       靶子中心 {"cx":450,"cy":349}     旧：落点退化成视口中心
[ui.act press{target}] {"success":true,"pressed_via":"cdp-key","pressed":["Escape"]}
                                                        旧：focus 被跳过
[ui.act click{target}] {"success":true,"clicked_via":"cdp-click"}   （见 10.5）
                                                        旧：preload-click
```

诚实边界：`_uploadViaFrameJs` 与 `stripEmptyShells` 这两处只有 e2e 覆盖
（upload 18/18、richtext 117/117），**没有**在真实站点上找到影子内部的
file input / contenteditable 做端到端验证 —— 改法与上面三条同源，但证据强度低一档。

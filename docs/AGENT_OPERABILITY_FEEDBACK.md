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
- [ ] P0-1 `ui.screenshot` / `browse_screenshot` 视口截图
- [ ] P1-1 `get_tree` 跨帧自动路由（或至少给出 `frame_hints` 提示）
- [ ] P1-2 `ui.act {action:'paste', html}`（含 OOPIF 支持）
- [ ] P2-1 列表行标题保留
- [ ] P2-2 `states.required` / `states.invalid` / `context.validation_errors`
- [ ] P2-3 `ui.navigate { wait_until }`
- [x] CSDN：登录态恢复后重新注入正文并发布 —— 已于 2026-10-17 13:40 完成

### 5.1 P1-3 落地时新发现的两个调用侧坑（2026-10-17，修 CSDN 发布时实测）

这两个不在原清单里，但都是这次真实撞上的，记下来避免重复踩：

1. **`ui.evaluate` 不等 Promise。** 页面里写 `(async () => { await ...; return 'x' })()` 会原样返回一个 Promise 对象，序列化后是 `{}`。
   任何"点了之后等一会儿再读"的逻辑都必须拆成两次调用（触发 → sleep → 点选），
   或者改用支持等待的原语。这是本次 CSDN 标签/声明两次设置"看起来成功了其实没动"的直接原因。
2. **`ui.act` 的 `target` 是 ref，不是 label。** 传 `target: '发布'` 会得到
   `Target not found for ref: 发布` —— 调用方必须先 `ui.get_tree` 拿节点 id。
   错误信息其实说清了（"for ref"），但第一次见到很容易以为支持文本标签。

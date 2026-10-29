# Figma / Miro / Notion 这类站点：从「读不到」到「读到并能验证」

> 状态：方案 + 待做的关键实验。所有标注「待实测」的结论都还没有被验证过，
> 不要当成已知事实使用。

## 0. 先把问题问对

「这些站点只能截图吗」这个问法把三件不同的事揉成了一件：

1. **读结构** —— 页面上有哪些对象、它们是什么、怎么组织
2. **写** —— 改内容、移动、新建
3. **证明写生效了** —— 本产品唯一的赌注

截图能勉强干第 1 件（而且很差），第 2 件只能靠猜坐标，第 3 件**根本做不到**
（截图只能证明"画面不同了"，证明不了"是我改的、改对没改对"）。
所以「截图 + 代码控制」不是一条路线的起点，而是**兜底**。

## 1. 我们和外部 agent 的结构性差别

外部 agent（靠截图 + 视觉模型的那种）只看见一张图。我们**在浏览器里面，
用的是用户自己的 session**，因此多出三扇门：

| 门 | 是什么 | 外部 agent |
|---|---|---|
| ① 页面自己的 JS 堆 | `ui.evaluate` 直接读内存里的 store / graph / editor | ❌ 完全看不到 |
| ② 页面自己发的 HTTP | network monitor 能录到它"做这件事时调了什么接口"，然后我们带 session 重放 | ❌ 只能自己猜接口 |
| ③ 页面的非视觉 DOM | Figma 的 Mirror DOM、Notion 的 `data-block-id`、各家的 `data-testid` | ❌ 看不到 DOM |

截图是**第四扇门**，而且是最弱的一扇。把它当兜底，不当主路径。

## 2. 四个层次，按「能不能证明」排序

沿用 `PLAN_CANVAS_MEANING.md` 的 A/B/C/D 分层，这里补上「怎么进去」：

| 层 | 内容 | 能证明写入吗 | 本方案的用法 |
|---|---|---|---|
| **B 应用模型** | 内存里的文档对象 / 页面自己的 API | ✅ 读回来逐字段比对 | **主路径** |
| **A 语义树** | 非视觉 DOM（含 Mirror DOM、block id） | ✅ 选中态与画布双向同步时可证 | **主路径（读 + 定位）** |
| **C 绘制记录** | 帧指纹 | 只证明"画面变了"，不证明"变成了什么" | **二次确认（已有）** |
| **D 像素** | 截图 / 视觉模型 | ❌ | **只用于取坐标 + 人工核验** |

注意 C 和 D 的分工别搞反：C 比 D 强，因为 C 能**归因到我的动作前后**，而 D 连归因都做不到。

## 3. 三个站点，三条具体路径

### Notion —— 最容易，读写都能验证

它压根不是 canvas 应用：正文是真实 DOM，每个块带 `data-block-id`，文本就是文本。

```
读：ui.get_tree 拿块结构 + data-block-id      （不需要 API，不需要 token）
写：PATCH /v1/blocks/{id}/children（追加）
    PATCH /v1/blocks/{id}（改内容）
    DELETE /v1/blocks/{id}（删，危险动作需确认）
验：写完立刻 GET /v1/blocks/{id}，逐字段比对；再 get_tree 看 DOM 是否同步
```

阻塞点：官方 API 要 integration token（用户在里面点一次授权，或把页面 share 给
integration）。也可以走它前端自己用的内部端点（带 cookie），但那是私有的、会变，
**必须在适配器里标注"非官方"并留降级路径**。

难点不在 API，在**块级操作**：拖拽排序、斜杠菜单、嵌套 toggle、跨块选区。
这类动作没有干净的 API 语义（`position.after_block` 能表达插入位置，但表达不了
"把三个块拖进一个 toggle 里"），所以是 DOM + 键盘为主、API 为辅。

### Miro —— 有完整可写 REST，缺的是授权

`api.miro.com/v2` 对 board items 是**全量 CRUD**：sticky_notes / shapes / texts /
cards / frames / connectors 都能建、能改、能删，`GET /v2/boards/{id}/items`
还能按 frame 过滤。这是我们最想要的东西：**读和写都是结构，不是像素。**

```
读：GET /v2/boards/{id}/items?limit=50        → 全部对象的 id/type/position/content
写：POST /v2/boards/{id}/sticky_notes          → 201 返回新 item（含 id）
    PATCH /v2/boards/{id}/sticky_notes/{id}    → 改文本/颜色/位置
验：写返回的 item 直接拿来比对；再 GET 一次做二次确认
    + 画布帧指纹确认"界面真的刷新了"（防止 API 写了但前端没同步）
```

阻塞点：OAuth Bearer token，**不认 cookie** —— 所以没法"借用户登录态"直接调，
必须走一次授权拿 token。这一步正好是本产品形态擅长的：窗口是真实可见的，
人可以随时介入点一下授权。

⚠️ 不要为了绕开授权去逆它的内部接口：那不是不能做，而是做出来就绑死在
一个私有协议上，会在某次改版后全坏，而且坏的方式是"静默返回 403"。

### Figma —— 读有路，写只有插件桥

**读**有两条：

1. **Mirror DOM**（官方工程博客确认存在）：画布背后渲染了一棵镜像 scenegraph 的
   真实 DOM，每个图层有 role / label / 层级，且**选中与画布双向同步**。
   如果它默认渲染（而不是只在检测到屏幕阅读器时才出现），那我们**不用额外做任何事**，
   `ui.get_tree` 就能看见图层树。⚠️ **这是本方案最关键、也最未验证的一个前提。**
2. **REST API**（`GET /v1/files/{key}`、`/nodes?ids=`）读完整文件树，但**对设计内容只读**
   （官方明确：REST 可写的只有 comments / variables / webhooks / dev resources）。

**写**只有一个办法：**Plugin API**（`figma.*` 全局对象，读写当前打开的文件）。
REST 没有任何改设计内容的端点。

插件桥的形态（已被社区实测可行，不是猜想）：插件 UI 跑在 iframe 里，
**可以连 `ws://127.0.0.1:<port>`**。于是：

```
我们的主进程开一个本地 WS server
  → 用户在 Figma 里装一次我们的插件（一次性）
  → 插件连上来，插件里执行 figma.* 操作
  → 主进程收到结果，回读 Mirror DOM / REST 做验证
```

阻塞点：必须用户手动装一次插件、每次会话手动打开（Figma 的安全模型就是这样）。
**这不可以绕过，也不该绕过** —— 绕过的意思就是往它的私有 WS 协议里灌二进制更新，
那是往用户的共享文件里写裸数据，风险与「往共享房间写裸 Yjs 更新」同级。

## 4. 要建的东西：三件与站点无关的基础件 + 每个站点一个薄适配器

### P0（决定性实验，先做这三个，否则后面全是猜）

| 编号 | 实验 | 结果（2026-10-30 实测，用户已登录的真实会话） |
|---|---|---|
| **P0-3 Notion** | `data-block-id` 是否稳定、是否与 API block id 一致 | ✅ **确认对齐**。13 个 `[data-block-id]`，全是标准 UUID；第一个是 `143577fc-cb06-80b0-9824-e994473b9754`，而 URL 的页面 id 是 `143577fccb0680b09824e994473b9754` —— **同一个 id**（去横线后逐字符相同）。页面 0 个 canvas、3 个 contenteditable。`ui.get_tree` 给出真实角色树（link/generic/button/tablist/tab/tabpanel/tree） |
| **P0-2 Miro** | 有没有可用的（非 OAuth）读写通道 | ✅ **比预期好得多：`window.miro.board` 是活的 Web SDK**。`getInfo()` 返回 `{id:"uXjVETk2bVU="}`，与 URL 的 board id 一致；`get()` / `getSelection()` 可用（该 board 为空，返回 `[]`）；写方法齐全（createStickyNote / createShape / createText / remove / sync / viewport），还多一个 `getAiContext`。**用的是用户自己的 session，不需要 OAuth token** |
| **P0-1 Figma** | 不启用屏幕阅读器时 Mirror DOM 是否默认渲染 | ⏳ **未验证 —— 被卡住**：该账号是新建 Free 团队，recents 里**一个文件都没有**，页面里也提取不到任何 `/design/<key>`。没有文件就没有画布，也就没有 Mirror DOM 可看 |

### 实测中的两个附带发现

- **Miro 还有一条纯读路径**：画布上有 `aria-label="Accessible Board Overview"` 的层，
  但它的文案是「点击 'Enhance accessibility support' 以启用**只读**的 board 大纲」——
  **需要一次点击**。这条比 SDK 弱（只读、要人点），可以作为没有 SDK 权限时的降级。
- **Notion 内部端点确认存在**（cookie 鉴权）：`POST app.notion.com/api/v3/loadCachedPageChunkV2`、
  `syncRecordValuesSpaceInitial` 等 —— 这就是它前端自己加载块树的接口。
  ⚠️ 私有接口，会在改版时静默失效，只能当**降级**，不能当主路径。

### 我自己的一个失误（记下来，免得复现）

探 `getAiContext` 时脚本报 `Cannot read properties of undefined (reading 'slice')`。
那是**我的错**：`getAiContext()` 返回 `undefined`，而我写了 `JSON.stringify(ai).slice(0,400)`，
`JSON.stringify(undefined)` 是 `undefined`，`.slice` 当场抛。不是 Miro 的问题。
教训还是那条：**测试脚本自己的异常，不能被读成被测对象的行为**。

### 随后（P1）：三件基础件

1. **`ui.model_probe`（升级现有 capability_probe）**
   从「按 window 名字猜」改成「按**结构签名**找」：扫 React fiber 的 provider 链、
   Yjs/MobX/Redux store、以及"有 `serialize()` 且 `serialize()` 返回带 children 的对象"
   这类形状特征。**排名与读取必须分开**（只看"拥有哪个访问器"排名，读取才真调 `serialize()`），
   否则候选会全部同分 —— 这个坑 SD-048 已经踩过。
2. **`ui.api_probe`（新）**
   从 network monitor 的历史里聚类出 JSON 端点：`{method, url, path, response_shape}`，
   并**只做只读试跑**（同源 GET，带 credentials）。写端点一律不试跑，只报"存在"，
   由 agent 显式选择。这是把「看它自己怎么做」变成能力，而不是靠人去读文档。
3. **`ui.a11y_mirror`（新）**
   找出页面里的非视觉 DOM 层（`aria-hidden`、屏幕外定位、`role` + `aria-label` 的密集区），
   并**验证它与画布是否双向同步**：在 mirror 里选中一个节点，看画布帧指纹是否变、
   看应用状态里 selected 是否变。这一步把「有棵树」升级成「这棵树可信」。

### 然后（P2）：每个站点一个薄适配器

适配器只声明三件事：**用哪扇门读、用哪扇门写、用什么验证**。它不含逻辑复用
（逻辑在 P1 的三件基础件里），所以加站点是加一个文件，不是改主流程。

## 5. 验证纪律（这一层最容易做成自欺）

1. **写入必须「操作 → 回读 → diff」**，回读走**与写入不同的通道**：
   API 写 → DOM 读；DOM 写 → API 读。同一条通道回读等于自证。
2. **id 要用页面自带的**（`data-block-id`、Miro item id、Figma layerId），
   不要用我们抽出来的 `data-ai-id` 当长期标识 —— 那个只保证跨抽取稳定，不保证跨会话。
3. **API 写了但界面没变**是一种真实故障（多人协作冲突、离线队列）。所以
   C 层帧指纹在这里不是冗余，它是「API 说成了，界面到底刷没刷」的唯一独立证据。
4. **危险动作分级**：`DELETE`、批量改、动 schema（Notion 删属性会丢数据）
   一律先列清单 + 等人确认。这条已写进发布说明，不能再退。

## 6. 明确承认做不到的

- **浏览器内的远程桌面 / VM 控制台**：帧流，无 DOM、无模型、无 API。
  只能坐标点击 + 帧指纹，而帧指纹只能回答"画面变了"，**无法回答"点了什么"**。
  这是唯一必须承认"我们做不到可验证"的场景。写在这里，免得以后有人把它
  当成"再努力一下就行"。
- **Figma 的私有 WS 协议**：不做。理由同「不往共享房间写裸 Yjs 更新」。
- **用视觉模型读截图当主路径**：不做。它会把"看起来像"当成"是"，
  与「可验证」的赌注相反。

## 7. 一句话结论

Figma / Miro / Notion 不是同一类问题：**Notion 是 DOM 应用（最易）、Miro 有全量
可写 REST（次易）、Figma 读靠 Mirror DOM、写必须插件桥**。三个都不需要截图当主路径。
真正决定成败的是 P0 那三个只读实验 —— 先跑它们，再决定投多少人天。

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
| **P0-1 Figma** | 不启用屏幕阅读器时 Mirror DOM 是否默认渲染 | ✅ **答案是否**（这是坏消息里最有用的一个）。编辑器里有一条常驻 status：`Screenreader support for the board is currently disabled. To enable it via Accessibility settings, press ⌘K, type Accessibility Settings, and press Enter.` 也就是说 **Mirror DOM 不默认渲染，要显式开启**。⚠️ 开启之后能不能当真结构用，**仍未验证**（见下） |

### Figma 另外三个决定性事实（都是实测）

1. **画布是 WebGPU，我们的绘制 hook 完全看不见它。**
   实测：`canvas.getContext` 返回 `webgpu`；hook 已装上但 `{n:32, frames:0}` 且这 32 条
   不是画布的。**后果**：Figma 里的写入无法用帧指纹验证 —— 这比 Excalidraw 更糟
   （Excalidraw 至少是 2D canvas，能看见"画了东西"）。这是必须写进产品说明的能力边界。
2. **编辑器的界面是真 DOM，而且很规整。** 178 个节点 / 45 个带名字的 button：
   `Main menu`、`File`、`Layers`、`Pages`、`Rectangle`、`Text`、`Export`、`Share`、
   `100%, zoom and view options`，画布本身是 `role=canvas`。所以「按名字选工具、开菜单、
   点导出」这类操作**不需要坐标**，和普通网页一样。已实测点开主菜单并读到
   `Preferences`、`Actions… ⌘K` 等项。
3. **新建账号的首次引导会挡住画布**（5 步向导，第 1 步要求填姓名与角色）。
   这期间点画布**什么都没发生，而探针如实报 `page_changed:false`** —— 工具是对的。

### ⚠️ 我自己的一个错判（必须记下来）

我一度写下"矩形创建成功" —— 依据是 `get_tree` 里出现了两个 `Rectangle`。
复查发现那两个节点是**工具栏的矩形工具按钮**（`e:div-90` group / `e:button-91` button），
不是图层。文件里 `Rectangle \d+` 一次都没匹配到，图层数是 0。
这正是我记忆里那条判据的反面教材：**用字符串匹配代替观测**。
（同时它反证了另一件事：探针报 `page_changed:false` 是对的 —— 引导弹窗挡住画布，
点击真的没有产生任何变化。）

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
5. **「有绘制记录」≠「看得见」**（2026-10-30 付了代价）。Figma 页面上我们的
   canvas 钩子记到 41 帧、125 次绘制，看起来证据充足 —— 实际全部来自页面自己建的
   **离屏** 2D 画布（缩略图/排版缓存），可见画布是 WebGPU，钩子一个像素都没碰到。
   于是"宽度 100→200"这种真实改动报 `canvas_changed:false`：一个**看起来有证据**
   的假阴性。判据：比较前先问"我观测的这张画布，和用户看的是同一张吗"。

## 5.1 Figma 第二轮实测（2026-10-30，用户登录态，全部实测）

第一轮的结论是「Figma 读有路（Mirror DOM，但默认关）、写只有插件桥、
连验证手段都没有」。打开无障碍支持后**后半句被推翻了**：验证手段是有的，
而且比帧指纹更强 —— 是应用**自己的 DOM 在自述**。

### 怎么打开（这一步不写下来，后面全部不成立）

`⌘K` / 主菜单 → `Actions… ⌘K` → 输入 `Accessibility` → 勾上
**"Adapt content for screen readers"**。Figma 会在编辑器里常驻一条 status 提示
（"Screenreader support for the board is currently disabled…"），勾上后它消失 ——
这条提示本身就是最可靠的开关状态回读。

### 打开之后，画布背后真的有一棵 Mirror DOM

每个场景节点是一个真实 DIV，自述三件我们最需要的东西：

```
id="3:1858"                       ← 元素自己带 id，就是 Figma 的节点 id
data-nodeid="3:1858"
data-parentid="0:1"               ← 场景层级！不用靠 DOM 嵌套去猜
aria-label="Rectangle 1, Rectangle"   ← 名字 + 类型
子节点文本 "Dimensions 100 100"        ← 尺寸自述
```

它在页面上是**屏幕外**的（实测 rect `y≈-1083`），所以按坐标点它没有意义；
它的价值是**读**：名字、类型、层级、尺寸都有，且不需要 token、不需要 REST。

### 图层面板是标准 treegrid，可以按名字选中

`role=grid`（Pages）+ `role=treegrid`（Layers），每行 4 个 `gridcell`。
行节点在语义树里是 `role=row` + `actions=["click"]`。**踩过的坑**：同一片区域里
外层容器也叫 "Rectangle 1" 但 bounds 是整个列表（280×512），点它的中心落在空白处，
`success:true` 而什么都没选中。**判据：按 bounds 选那个 280×32 的行，不按文本匹配
第一个命中。**

### 写入闭环（实测，可逆）

```
选中行 → 右侧栏出现 Position/Dimensions/Fill
Width 输入框 100 → setContent "200" → Enter
回读①  同一输入框 = 200
回读②  Mirror DOM 自述 = "Dimensions 200 100"     ← 应用自己认的
还原 100 → 回到 "Dimensions 100 100"
```

**这是 Figma 上第一次拿到"写进去 → 应用自己承认"的证据**，而且两路回读互不依赖
（一路是我读输入框，一路是 Figma 渲染的镜像文本）。没有像素、没有 OCR、没有 token。

### 这一轮抓到并修掉的两个缺陷

1. **两个 id 空间互相作废**：Mirror DOM 元素同时有 `id="3:1858"` 和
   `data-ai-id="ax-4293"`，抽取器按元素 id 覆盖了后者，AX 路径下一趟又改回去 ——
   `get_tree` 给的 id 拿去 `act` 会得到 `Target not found for ref`。已改为
   `existingAiId || nativeId`（SE-ID-003/004）。
2. **GPU 画布上的假阴性**（见上一节第 5 条）。已改为钩子自述 `g=1`、
   上层把 `canvas_changed` / `canvas_idle` 一律降级为 `null`（PP-39/39b/40、
   PE-01..03、CF-17/18/19）。

### 操作手册（全部实测通过，2026-10-30）

| 目标 | 怎么做 | 回读（必须做） |
|---|---|---|
| 读结构 | Mirror DOM：`[data-nodeid]` 的 `aria-label`="名字, 类型"、`data-parentid` 给层级、子节点文本 `Dimensions W H` | — |
| 列出图层 | 图层面板 `role=treegrid` 下的 `role=row` | row 文本 |
| 选中某层 | 点那一行（**按 bounds 挑 `height≈32` 的 row**） | 右侧栏从 Page 变成该节点的属性 |
| 改尺寸/位置 | 右侧栏 `Width`/`Height`/`X-position`/`Y-position` 输入框 `setContent` → `Enter` | ①输入框值 ②Mirror 的 `Dimensions` 自述 |
| 新建形状 | 点工具栏同名按钮（`Rectangle` 等）→ 点画布 | 图层行 +1、Mirror 节点 +1 |
| 删除 | `Delete` | 图层行 −1 |
| 重命名 | `⌘R` → 出现内联 textbox → `setContent` → `Enter` | 图层行文本 + Mirror `aria-label` |
| 撤销 | `⌘Z` | 行数复原 |

**两个新踩的坑：**

1. **`R` 这类画布快捷键会失效**。开了无障碍后，Figma 给每个镜像节点加了
   `class="focus-target"`，焦点很容易停在某个镜像节点上（实测
   `document.activeElement` = `DIV#3:1858.focus-target`），于是键盘事件被它吃掉，
   工具根本没切；而**点画布并不会把焦点挪开**（点完 focus 仍是那个镜像节点）。
   判据：读工具栏按钮的 `aria-pressed`（`Rectangle` 按钮选中时是 `"true"`，
   class 含 `selectedButton`），不要靠"按了 R 就当切好了"。
   → **用工具栏按钮，不用快捷键。**

2. **浮层挡住画布，点击静默落空**。实测画布中心被一个
   `role=dialog`（"Code, now on canvas … Got it"，545,346 处 256×288）挡住，
   点击 `success:true` 但什么都没发生。判据：动手前先
   `document.elementFromPoint(画布中心)`，看到 `role=dialog` 就先关掉它。

### 还剩什么

- **新建节点**仍要画布手势（`R` + 点击，实测可行，但需要坐标：画布 rect 已知、
  缩放 478% 可见，可以算）或插件桥。改属性已经不必碰坐标了。
- **重命名、层级调整、约束/自动布局**还没验。
- 无障碍开关是**用户级偏好**，不是文件属性 —— 意味着这棵树在用户关掉它之后会消失。
  产品上必须：检测到"开了才有效"时**如实告诉 agent**，而不是让 agent 在关掉的
  状态下以为"这页没有图层"。

## 5.2 三站一次性联调（2026-10-30，同一实例 pid 76947，全部实测）

三个站点各自的形态差异极大，这里把"能不能读、能不能写、能不能证明"放在一张表里：

| | Notion | Miro | Figma |
|---|---|---|---|
| 画布 | **0 张**，纯 DOM | **7 张**（1 全屏 WebGL + 1 全屏 2D + 5 个离屏） | **1 张 WebGPU** |
| 结构来源 | 真 DOM，块带 `data-block-id`（UUID，首个=页面 id） | `window.miro.board`（活的 Web SDK） | Mirror DOM（需开无障碍）+ 图层 treegrid |
| 读 | `ui.get_tree` 角色树；块 id 与 API 对齐 | `board.get()` / `getById` | Mirror 的 `data-nodeid`/`data-parentid`/`Dimensions` |
| 写 | 点块 → `type` | `createStickyNote` / `sync` / `remove` | 右侧栏属性框、工具栏按钮、`⌘R`、`Delete` |
| 回读 | 块 `innerText` | `board.get()` 二次读 | 输入框值 + Mirror 自述 |
| `canvas_changed` | 无画布，不给该字段 | **`true`（可信）** | **`null`（GPU 致盲，已修）** |

### 这一轮抓到的三个缺陷（都修了）

1. **句柄来自元素原生 id，查找却只认 `data-ai-id`**（`find_ref.cjs` / `actions.cjs`）。
   抽取器在没有 `data-ai-id` 时用元素自己的 `id` 当句柄（`existingAiId || nativeId`），
   而 `data-ai-id` 只是页面里的一个普通属性 —— React 重渲染子树时会被一起抹掉，
   元素却还在。实测 Notion：空段落 `id=":r6:"`、`data-ai-id` 刚写就被抹空，
   于是 `get_tree` 报 `:r6:`、`type` 报 `Target not found for ref: :r6:`（读得到、打不进）。
   修法：属性查不到时按 `getElementById` 兜底（穿透 shadow 的同一递归里做，ShadowRoot 也有这个方法）。
   判据 SD-10/11/12（含"不会把不存在变成乱命中"的阴性对照）。

2. **`focus()` 不等于"可输入"**（`page_manager._inputViaCdp`）。
   contenteditable 调 `focus()` 之后 `document.activeElement` **确实等于它** ——
   所以"焦点坐上没有"这个判据看不出任何问题 —— 但 Notion 的块编辑器没进编辑态，
   受信按键全部落空，校验读到空。真人点一下之后 activeElement 会交给编辑器自己的容器。
   修法：contenteditable 一律先来一次真实指针点击（input/textarea 不加，避免把光标挪到中段）。
   ⚠️ 踩过第二次：点完又补了个 `ed.focus()`，把焦点从编辑器容器抢回叶子，编辑态当场打断，
   症状与"没点"一模一样。

3. **校验读错了对象 → 假阴性**（同上）。清空空段落之后 Notion 把焦点交还页面
   （`activeElement` 变 BODY），`deepActive` 读到的成了整页文本，于是明明成功却报
   `Input not verified`。这是**危险方向**：agent 会重试，对 `type` 就是写两份重复内容。
   修法：失败时再按"解析出来的那个可编辑元素"复核一次，命中就如实给成功并标
   `verified_by: 'target-element'`。它不会掩盖真错位 —— 文字若落进别的输入框，目标元素里就没有它。

### 顺带确认的两件事

- **Miro 的指纹是可信的**：SDK 造一张便签让 `fp` 从 793187922 → 96237963、`frames` 8→12，
  删除后又变 —— 那张全屏 2D canvas 确实跟着板面重绘。所以 Miro 保留 `g=0`，
  不像 Figma 那样降级成 `null`。这条不是推断，是 A/B 测出来的。
- **Figma 的开关键在"Adapt content for screen readers"**，而且是用户级偏好：
  重启实例后它仍然是开的（状态栏那句 disabled 没有再出现），Mirror DOM 直接可用。

## 5.3 国内六个画图站实测（2026-10-30，同一实例 pid 76947）

用户给的三个站，其中迅捷画图下面要拆成四个功能分别测：

| 站点 / 功能 | 渲染 | 结构在哪 | 读 | 写 | 回读（独立通道） |
|---|---|---|---|---|---|
| draw.yunser.com | 4 张 2D canvas（`mycanvas-0/1/9/10`）+ 2 张图层预览 | **没有模型**（Vue 根 `$data` 为空；引擎不挂 window） | 工具栏语义树 + 图层 id | CDP 手势 | **只有帧指纹**（绘制计数 4→130） |
| suxieban.com | 2 张 2D canvas（1036×612，2x DPR） | 无全局模型 | 37 个带 id 的按钮（`btnRect`/`btnUndo`…） | CDP 手势 | 帧指纹 + **按钮态** |
| 迅捷白板 | 2 canvas（**Excalidraw 内核**） | `window.excalidraw.$excalidraw` | `getSceneElements()` | `updateScene({elements})` | 再 `getSceneElements()` |
| 迅捷思维导图 | **0 canvas / 70 svg**（DOM 渲染） | `window.editor.minder`（**KityMinder**） | `getRoot()` / `exportJson()` | `execCommand('appendchildnode')` | 模型 + **界面「节点：N」计数器** |
| 迅捷流程图 | **0 canvas / 335 svg**（**drawio 内核**） | `window.drawApp.editor.graph` | `getModel().getDescendants()` | `insertVertex` | 模型 + **SVG 里出现该文字** |
| 迅捷 Markdown | **0 canvas**（CodeMirror） | `window.editor`（CM 实例） | `getValue()` | `setValue()` | 源码 + **右侧预览渲染出 `<h1>`/`<li>`** |

### 实测数据（每条都可逆，已还原）

- 白板：`0` → `updateScene` 加一个 160×100 矩形 → 回读 `{n:1, type:'rectangle', x:120, w:160}` → 还原 `0`
- 思维导图：`kids 3 / nodes 4 / 节点：4` → `appendchildnode` → `kids 4 / nodes 5 / 节点：5` → `importJson(备份)` 回到 `3/4/4`
- 流程图：`total 2` → `insertVertex('probe-flow')` → `total 3` 且 **DOM 里出现这段文字** → `removeCells` 回到 2
- Markdown：`setValue('# probe-md\n\n- alpha\n- beta')` → 源码 26 字符 + **预览渲染出 H1 与 2 个 `<li>`** → `setValue('')` 清空

### 五个必须记下的细节

1. **同一个内核，读不读得到取决于站点是否暴露模型。** Excalidraw 官方站 `window` 上没有模型（只能靠帧指纹），
   而迅捷白板把它放在 `window.excalidraw.$excalidraw` 上 —— 结论不是"Excalidraw 读不了"，而是**"这个站的 Excalidraw 有没有被包一层并暴露出来"**。
   判路子的顺序应该是：先按结构签名扫 `window`，再谈内核。
2. **模型挂载点四站四个名字**：`excalidraw`（还隔一层 `.$excalidraw`）、`editor.minder`、`drawApp.editor.graph`、`editor`（CodeMirror）。
   按名字猜一定漏，必须按能力签名找（`getSceneElements` / `getModel`+`getDefaultParent` / `getValue`+`setValue`）。
3. **迅捷白板/流程图都先落一个占位页**：`opened_tab.url` 最初是
   `file://…/loading.html?url=https%3A%2F%2F…`，随后才换成真地址。这正是 P1 里 `show_url` 存在的价值。
4. **drawio 的 `removeCells` 不能自己套 `beginUpdate/endUpdate`**。`insertVertex` 必须套，删除套了就**静默不生效**
   （回执拿到 `cell-gone`/`removed`，模型里却还在）。而且 `editor.undoManager.undo()` 对我们用 API 做的改动**不记录**，
   所以还原只能显式 `removeCells`。
5. **yunser 与速写板都没有"撤销形状"**：yunser 连撤销按钮都没有（只有 `eraserWidth` 一个 localStorage 键，无持久化）；
   速写板的 `btnUndo` 对**画笔笔画**有效（`n 207→221` 重绘、笔画消失），但对**形状工具画的矩形无效**。
   → 这类站的写入**默认不可逆**，除非先证明撤销真的覆盖该操作。

### 顺带验证到的两件事（不是推断）

- **重绘页的判据在真实 Excalidraw 上成立**：白板一直 60fps 重绘（700ms 内绘制计数 6246→6288），
  一次手势绘制得到 `canvas_changed:true, canvas_idle:false, canvas_repeat:true` —— 正是第 4.6 节那套四态模型。
- **`drag` 传 `from` = `to` 等价于一次真实坐标点击**（用它点掉了迅捷白板那个没有 `data-ai-id` 的引导浮层，
  三层 `.wan` 元素里两层是 0×0）。这类"没有 ref 的浮层关不掉"从此有解。

## 6. 明确承认做不到的

- **浏览器内的远程桌面 / VM 控制台**：帧流，无 DOM、无模型、无 API。
  只能坐标点击 + 帧指纹，而帧指纹只能回答"画面变了"，**无法回答"点了什么"**。
  这是唯一必须承认"我们做不到可验证"的场景。写在这里，免得以后有人把它
  当成"再努力一下就行"。
- **Figma 的私有 WS 协议**：不做。理由同「不往共享房间写裸 Yjs 更新」。
- **用视觉模型读截图当主路径**：不做。它会把"看起来像"当成"是"，
  与「可验证」的赌注相反。

## 7. 一句话结论

Figma / Miro / Notion 不是同一类问题：**Notion 是 DOM 应用（最易）、Miro 有活的
Web SDK（已实测 create→get→remove 全通，不需要 OAuth）、Figma 打开无障碍后有
Mirror DOM 可读、属性写入可回读验证**。三个都不需要截图当主路径。

第一轮我写过"Figma 写只有插件桥、连验证手段都没有"，第二轮实测推翻了这个结论：
`⌘K → Accessibility Settings → Adapt content for screen readers` 之后，画布背后
有真实 DOM 自述名字/类型/层级/尺寸，右侧栏属性面板可以改并回读，Mirror DOM 自己
认了（"Dimensions 200 100"）。**插件桥仍然需要**——新建节点、改名称、调层级这些
还没有 DOM 入口——但"无法验证"这件事已经不成立了。

两个被这轮实测抓出来的缺陷（两个 id 空间互相作废、GPU 画布上的假阴性）证明：
这条路上真正的风险不是"读不到"，而是**读到了假证据还当成证据**。

## 8. 推翻上一版：「纯 canvas 没有模型」是错的（2026-10-30 复测）

第 5.3 节把 yunser 与速写板归为"无应用模型"。**这个判断是错的**，错因不是站点，是找法：
它们把实例关在闭包里，`window` 上只留了库本身（`window.fabric`）或构造器（`window.DrawBoard`），
按"扫 window 上的对象"扫不到，就误以为不存在。这是第 4 条"同一个概念在两层形状不同"的第 5 次复发。

### 抓闭包实例的通用三步

1. **看库指纹**：DOM class 里有 `lower-canvas` / `canvas-container` → fabric（`window.fabric.version` 印证）。
   `window` 上有大写构造器（`DrawBoard`）且带 `prototype.fn/plugins` → jQuery 插件风格。
2. **hook 原型方法，只记 `this`**：`fabric.Canvas.prototype` 上取 `__onMouseMove` / `_onMouseMove` /
   `renderAll` / `requestRenderAll` / `renderTopLayer` / `add`，包一层 `window.__fc = this`。
   ⚠️ fabric 5 的事件入口是**双下划线**的 `__onMouseMove`，只 hook `_onMouseMove` 抓不到（实测无效）。
3. **轻触发一次**：向目标 canvas 派发一条合成的 `mousemove`。fabric 的原型方法没被 bind 成实例属性，
   所以合成事件也能走到 hook。抓不到时再升格为真实 CDP 鼠标。

实测两个站各一次就拿到了：`__fc`（fabric.Canvas）、`__db`（DrawBoard）。

### 结果：速写板是完整 A 档，yunser 是位图层

| | 读 | 写 | 回读 | 可逆 |
|---|---|---|---|---|
| suxieban（fabric 5.2.1） | `getObjects()` | `add()` / `loadFromJSON()` | `toJSON()` / `toSVG()` | ✅ 实测 |
| yunser（DrawBoard） | 无矢量对象，只有 `layers[]` 的 canvas/ctx | 只能 CDP 手势或 `loadDataUrl()` 贴图 | 位图快照 | 位图级 |

速写板往返实测：`add(rect) + add(textbox)` → `toJSON()` 拿到
`{version, objects:[{type:'rect',left:60,top:60,width:100,height:60},{type:'textbox',text:'hello'}]}`
→ `clear()` 归 0 → `loadFromJSON(snap)` → `getObjects()` 回到 2 个、`types:['rect','textbox']`、
文本 "hello" 读回。`toSVG()` 另给一份完整 SVG（1036×612）。
**"导出得到完整结构"不需要点站点按钮，库自带 `toJSON` / `toSVG`。**

yunser 的 `getDataUrl()` 把每层 `toDataURL('image/png')` 塞进 localStorage，`loadStorage` 反过来
`drawImage` 解码，`history[t].data` 也是 dataURL；`log` 只记工具状态（`type` / `lineWidth` / `eraserWidth`），
**不含笔画坐标**。所以 yunser 的边界是"完整的位图快照可导出、可恢复"，不是"完全不可读"——
但也确实**读不出"哪几个形状"**，不能编辑已有元素。

### 附带钉住的一条帧指纹特性

fabric 的 `renderAll` 是**一次性同步绘制**（clearRect + 整屏画完就结束，没有下一帧）：
`frames 19→21`、`fp 0→2113470169`，而 **`last` 停在空画布的 `2546269777` 不动**。
这就是"`last` 滞后一帧"在同步绘制上的极端形态——**静态页、以及事件驱动的一次性重绘都不能用
`last` 判变化**，只有持续 rAF 循环的重绘页才有意义（CF 系列需补一条这个形态）。

### 8.1 已落地：`ui.app_model` / `capabilities{deep:true}`

上面的三步不再靠手写。`src/main/app_model_source.js` 把它固化成表 + 页面内探针：

| 库 | 认法 | 实例从哪来 |
|---|---|---|
| fabric | `canvas.lower-canvas` + `window.fabric.Canvas` | hook `Canvas.prototype.__onMouseMove` 等（**双下划线**）+ 一条合成 mousemove |
| Konva | `Konva.stages.length` | 全局注册表，**不碰原型** |
| paper.js | `paper.projects.length` | 全局注册表，**不碰原型** |
| Excalidraw | `window.excalidraw.$excalidraw.getSceneElements` | 现成对象，**不碰原型** |
| CodeMirror 5 | `.CodeMirror` 宿主属性 | 官方约定，**不碰原型** |
| Monaco | `monaco.editor.getModels` | 全局 API，**不碰原型** |

只有 1/6 需要 hook。能用注册表/DOM 属性/全局 API 的一律不包装原型 —— 没有副作用，
也不需要卸载。

实测（真 Electron）：

- suxieban：空板 `count=0` → 加 160×100 矩形 → `count=1` 且回读
  `{type:'rect', x:200, y:150, w:160, h:100, fill:'#22c55e'}` → 删除 → `count=0`
- 迅捷白板：`L2_semantic_tree` → `L1_app_object_model`（`window` 扫描认不出
  `window.excalidraw`，因为 `APP_KEY_RE` 里没有这个 key —— deep 补上了这个洞）
- yunser：`no known library matched`，如实给出两条可执行下一步，不假装成功

两条落地时才暴露的坑，都已成为判据：

1. **`read_expr` 必须是能在页面顶层求值的完整表达式。** 最初 hook 类只给了后缀
   `.getObjects()`，交出去就是这 14 个字符 —— 喂给 `ui.evaluate` 时 `this` 是
   `undefined`，当场 TypeError，而探针一路 PASS。e2e `AM-E13` 真的把 `read_expr`
   喂给 `ui.evaluate`，单测 `AM-21` 真的 `eval` 它。
2. **"可卸载"不能只是删账本。** 原写法 `delete window.__aiAppModel` 丢掉了 hits，
   但 tee 仍挂在原型上。现在 `window.__aiAppModel.restore()` 逐个还原原函数，
   `AM-09` / `AM-22` 钉住"卸载后 read_expr 返回 null 而不是抛错"。

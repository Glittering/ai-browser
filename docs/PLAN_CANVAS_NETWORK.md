# Canvas 语义化与 Network 抓包方案

> 适用分支：`dev`  
> 目标：让 agent 继续以结构化语义为主读取和操作真实可见网页，同时补齐 Canvas 与网络请求可观测性。  
> 不变量：AI 是唯一操作者；窗口真实可见且人可随时手动介入；不把截图/OCR 变成默认读层；所有高体积数据都必须有上限、游标和明确的截断元信息。

## 0. 总体结论

1. Canvas 默认走“页面脚本执行前注入、旁路记录绘制调用”的语义层：2D Canvas 可读文本、几何、图片来源和坐标；WebGL/Worker 只能提供部分结构并必须诚实标记不透明。
2. Network 不能再依赖订阅后才缓存响应；应在每个 tab 的首个真实导航前启用 CDP Network，形成“列表查询 + 单条详情 + 分页 body”的有界内存日志。
3. `node.value` 的 200 字符限制是本项目行为，不是 CDP 限制；两条读层必须共享同一截断契约，并提供无需新 MCP 工具的 `browse_act(action="get_value")` 取全量路径。
4. MCP 推荐新增两个聚合工具 `browse_canvas`、`browse_network`；兼容期工具数从 13 到 15，下一主版本用它们替换 `browse_subscribe`、`browse_network_body` 后回到 13。
5. 最大风险不是“CDP 能否监听”，而是过度承诺：绘制调用不等于业务语义、最终 POST body 不等于构建过程、CDP body 也可能被 Chromium 淘汰；接口必须把 `partial`、`opaque`、`truncated`、`evicted` 明确返回。

---

# 第一章：让 agent 读懂并操作 Canvas

## 1.1 现状

- legacy 读层把 `<canvas>` 识别为 `role: "canvas"`，但只返回 DOM label/bounds，没有画布内部内容（`src/preload/extractor.cjs:56-60`、`src/preload/extractor.cjs:96-98`）。
- AX 读层依赖 Chromium Accessibility Tree；没有无障碍子树的 Canvas 通常仍是一个不可展开节点，无法看到 `fillText`、路径或贴图内容（`src/main/axExtractor.js:17-21`、`src/main/axExtractor.js:82-102`）。
- 当前每 tab 的 CDP 仅在有 Network/Runtime 订阅时才附着，且 `newTab()` 可能立即 `loadURL()`；不存在在站点脚本之前安装 Canvas hook 的阶段（`src/main/page_manager.js:903-945`、`src/main/page_manager.js:925-929`）。
- `contextIsolation: true` 意味着 preload 所在 isolated world 不能通过修改自身 world 的原型来截获页面 main world 的调用。要拦截页面代码，脚本必须注入 main world。
- 不应把“截图识别”作为缺省解法；它会把本项目从结构化语义接口退化成视觉猜测，并把视觉 token 成本转嫁给调用方。

## 1.2 可选方案与取舍

| 方案 | 能拿到什么 | 优点 | 代价 / 不能做到什么 | 结论 |
|---|---|---|---|---|
| AX/DOM 可访问性信息 | Canvas 元素本身及站点主动提供的 ARIA/隐藏 DOM | 零注入、语义可信 | 绝大多数 Canvas 内部为空 | 保留为最高优先级；不能单独解决问题 |
| **2D 绘制调用拦截** | `fillText` 文本、矩形、路径指令、图片来源、样式、变换矩阵、调用时坐标 | 结构化、零视觉 token；`fillText` 直接得到原文 | 原型被包装会有性能和可探测性；绘制命令不天然等于“按钮”等业务角色 | **主方案** |
| 自建/模拟绘制 | 将序列化命令回放到 shadow canvas 或向量场景 | 可调试、可辅助算 bounds | 图片、视频、渐变、pattern、clip、滤镜、混合模式、`putImageData`、Path2D、WebGL 都可能不可完整重放；替换页面 canvas 会破坏站点 | 只允许离线“近似回放”，绝不接管页面真实绘制 |
| WebGL 调用跟踪 | draw 次数、shader 源、buffer/texture 尺寸、uniform 摘要 | 能识别技术栈和复杂度 | 顶点/纹理/shader 到业务语义不可逆；文字常是 glyph atlas | 诊断层，结果标记 `partial/opaque` |
| OffscreenCanvas/Worker 跟踪 | 主线程 OffscreenCanvas 可覆盖；自动附着 worker 后可看到 worker 内调用 | 扩大覆盖 | worker canvas 与页面可见 DOM canvas 的映射不总是可证明；OOPIF/worker 是独立 target | 分阶段支持并显式报告 coverage |
| CDP 局部截图 | Canvas 当前像素 | 对 raster/WebGL 最通用 | 与“不截图”定位冲突；消耗视觉 token；无法保证业务语义；可能截到覆盖层 | 仅作为**待用户拍板**的显式兜底 |

### 1.2.1 为什么不“接管并自己画”

正确方式是 **tee**：原调用仍由原生 Canvas API 执行，记录器只复制可序列化的参数。包装函数必须先用 `Reflect.apply(original, this, args)` 保持网页行为，再在独立 `try/catch` 中记录；记录失败不得改变返回值、异常、`this` 或绘制顺序。

完整接管/替换绘制不可取：Canvas 是有状态的立即模式 API，同一像素可能经历 clip、composite、filter、阴影、多次覆盖和像素写入；WebGL 更是 GPU 程序执行结果。可选的 shadow replay 只能标成 `approximate: true`，不能作为操作依据或“已读懂”的证明。

## 1.3 推荐方案

### 1.3.1 注入时机与 target 覆盖

新增 `canvas_monitor.js`（主进程状态与聚合）和一份可序列化的 main-world 注入脚本，启动顺序必须是：

1. 创建 BrowserView，但先停留在 `about:blank`；为 tab 分配稳定 `tabId` 和 `readyPromise`。
2. CDP attach 后启用 `Page`、`Runtime`；调用 `Runtime.addBinding` 安装每 tab 随机名称的上报 binding。
3. 调用 `Page.addScriptToEvaluateOnNewDocument`，**不传 `worldName`**，从而进入页面 main world，并保存返回的 script identifier。
4. 上述步骤完成后才导航真实 URL。`newTab()` 可继续同步返回 id，但所有后续 tab 操作必须先 await `readyPromise`；初始化失败时继续导航并把 Canvas capability 标成 `unavailable`，不能卡死 tab。
5. 同一 target 内的新 document/frame 由该脚本覆盖。OOPIF、dedicated/shared worker 使用 `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:true})`；在 `Target.attachedToTarget` 后通过 Electron `debugger.sendCommand(method, params, sessionId)` 操作子 session：OOPIF 启用 Page/Runtime 后安装 binding 与 new-document 脚本，worker（没有 Page domain）则启用 Runtime、安装 binding，并在恢复执行前用 `Runtime.evaluate` 安装 hook，最后调用 `Runtime.runIfWaitingForDebugger`。
6. 当前 `_onCdpMessage` 只接收三个参数；实现时必须把 Electron `message` 事件的第四个 `sessionId` 一并传入分发器，否则无法区分 OOPIF/worker（现监听位置 `src/main/page_manager.js:1108-1112`）。

不能假设所有环境都支持相同的实验性 CDP 参数。Canvas monitor 初始化要逐项 feature-detect；子 target 自动附着失败时，主 frame 仍工作，并在 `coverage.warnings` 中报告。

### 1.3.2 包装范围

**2D `semantic` 模式（推荐默认）**：

- 文本：`fillText`、`strokeText`。记录完整文本（单条最多 4,096 Unicode code point，超出带截断元信息）、`font`、`textAlign`、`textBaseline`、`direction`、alpha/composite、`measureText()` 可得的近似 bounds。
- 几何：`fillRect`、`strokeRect`、`clearRect`；记录四角经当前 transform 变换后的 canvas 坐标和 AABB。
- 图片：`drawImage`；记录各重载的 source/destination rect、来源类型、图片 `currentSrc`（data URL 只记类型和长度）、源尺寸；不复制像素。
- 路径：包装 `beginPath`、`moveTo`、`lineTo`、`bezierCurveTo`、`quadraticCurveTo`、`arc`、`ellipse`、`rect`、`closePath`，但默认只在 `fill`/`stroke` 时产出路径摘要（segment 数、bounds、fill rule、样式）；显式 `Path2D` 参数无法反射其内部指令，返回 `opaque_path: true`。
- 像素：`putImageData` 只记目标位置和 ImageData 尺寸，明确 `pixels_captured:false`。
- 状态：`save`/`restore`、transform 系列、clip、fill/stroke style、line width 等只为解释 draw call 服务；不得调用会改变上下文状态的探针（例如 WebGL `getError()`）。
- Canvas resize/全量 clear 生成新的 `scene_epoch`；接口返回的是“有界的近期绘制历史/近似当前场景”，不是声称存在浏览器原生 scene graph。

**2D `trace` 模式（显式开启）**：在 `semantic` 基础上保留原始 path segment、更多状态变更与调用参数，用于疑难页；高频动画下成本明显更高，不做默认。

**WebGL/WebGL2**：包装 `getContext` 识别类型，并记录：

- `drawArrays`/`drawElements` 的 mode/count/type/offset 和次数；
- `shaderSource`（每 shader 最多 16 KiB，带 hash、原长、截断标志）、compile/link 结果；
- uniform 名称与小型标量/数组摘要；buffer/texture 的 byteLength、格式、尺寸、图片 URL 元数据；
- 不读取 framebuffer、不复制纹理、不宣称识别出文字或控件。`readability` 固定为 `partial` 或 `opaque`。

检测到 `webgpu` 时只返回技术类型、surface 尺寸和 `opaque_reason:"webgpu_not_instrumented"`，第一版不包装 WebGPU。

**OffscreenCanvas**：

- 主线程中的 `OffscreenCanvasRenderingContext2D` 可按 2D 方案包装。
- worker 必须经自动附着单独注入；记录以 `worker_target_id` 区分。
- `transferControlToOffscreen()` 可在主线程记录“DOM canvas 已转移”，但 transferable 对象跨 realm 后的自定义身份不能作为可靠关联协议。只有能由 target/frame/transfer 事件确定映射时才给 `dom_canvas_id`；否则返回 `mapping:"unknown"`，不提供基于 DOM bounds 的点击。

### 1.3.3 防污染、开关和体积

配置分两层：

- 启动级：`AI_BROWSER_CANVAS_HOOK=0|1`，推荐默认 `1`。为 `0` 时完全不安装 binding、不包装原型；之后开启必须 reload 才能覆盖先前绘制。
- tab 运行级：`off | semantic | trace`，推荐默认 `semantic`。`off` 立即停止记录但已安装 wrapper 仍存在；彻底恢复原型只能在当前 wrapper 仍是本项目 wrapper 时进行，最可靠的“完全无 hook”方式仍是启动级关闭后重载。

注入状态仅保存在闭包和一个随机、不可枚举的 main-world bridge key 中；binding 名也每 tab 随机。不要修改 `Function.prototype.toString` 来伪装 wrapper——这比暴露 wrapper 更危险。必须承认 main-world wrapper 对页面是可观察的，且恶意页面可以伪造 binding 消息；主进程应把所有 payload 当不可信输入，限制单批 256 KiB、每批 200 calls，并校验字段/类型。

默认保留策略：

- 每 canvas 最多 2,000 calls 或 512 KiB；每 tab 最多 4 MiB；两者取先到者，淘汰最旧记录。
- `semantic` 模式把同一批次内签名相同的高频调用合并为 `repeat_count`；路径最多保留 512 segments，超出只保留计数和 bounds。
- 每 canvas 维护单调 `seq`、`first_retained_seq`、`last_seq`、`dropped_calls`。任何查询截断都返回 `next_seq`；历史已淘汰则返回 `history_gap:true`。
- Canvas 元素用 `canvas:{navigation_id}:{frame_id}:{local_seq}` 区分；导航时换 `navigation_id`，防止旧 id 命中新文档。元素引用放 WeakMap，不能因监控阻止 DOM GC。

### 1.3.4 Canvas 作为 UI 时如何点击

绘制日志可提供 `bounds_canvas`，读取时再取当前 DOM canvas content box/`getBoxQuads()`，映射到 CDP `Input.dispatchMouseEvent` 使用的 viewport CSS 坐标：

- 无 CSS transform：按 `contentBoxWidth / canvas.width`、`contentBoxHeight / canvas.height` 缩放，并加 content box 左上角；不要再乘 devicePixelRatio。
- 有 2D CSS transform：使用当前四边形对归一化 canvas 坐标做仿射/双线性映射，并返回 `mapping_accuracy:"approximate"`。
- OOPIF：再叠加 frame offset；worker OffscreenCanvas 在 DOM 映射未知时禁止按 draw call 点击。

扩展现有 `ui.act`，不另造一个操作系统：

```jsonc
// 按 draw call 近似 bounds 中心点击
{"jsonrpc":"2.0","id":11,"method":"ui.act","params":{
  "tab":1,
  "action":"canvas_click",
  "target":"canvas:nav-7:frame-main:2",
  "params":{"draw_seq":341,"position":"center"}
}}

// 或 agent 明确给 canvas backing-store 坐标
{"jsonrpc":"2.0","id":12,"method":"ui.act","params":{
  "tab":1,
  "action":"canvas_click",
  "target":"canvas:nav-7:frame-main:2",
  "params":{"point":{"x":420,"y":180,"space":"canvas"}}
}}
```

响应必须回显实际点击点和映射置信度：

```json
{"success":true,"canvas_id":"canvas:nav-7:frame-main:2","viewport_point":{"x":611,"y":344},"mapping_accuracy":"exact","warning":"draw bounds is not a proven hit region"}
```

这可以支撑大量 2D Canvas 菜单/按钮，但 draw rect/text **不是命中区域证明**：事件代理、透明 hit area、重叠、clip、旋转、动画都可能让中心点无效。agent 点击后仍要通过新 draw seq、网络变化或页面语义树验证结果。

## 1.4 分层与触发条件

| 层 | 默认 | 触发条件 | 返回 |
|---|---:|---|---|
| 默认层：AX/DOM + 2D `semantic` draw log | 是 | 检测到 2D Canvas | 文本、粗粒度几何、图片元数据、当前坐标；`readability:"semantic"|"partial"` |
| 降级层：`trace` / WebGL / Worker 诊断 | 否 | 默认层没有足够信息，或检测到 WebGL/OffscreenCanvas | 更细调用日志；WebGL/映射不明时明确 `opaque_reason`，不伪造语义 |
| 兜底层：Canvas 局部截图 | 否 | draw hook 未安装/安装过晚、raster/视频/像素 API、WebGL 且调用方具备视觉能力 | PNG；视觉 token 与隐私成本由调用方承担 |

## 1.5 具体 WS 接口

### `ui.canvas_configure`

```jsonc
// request
{"method":"ui.canvas_configure","params":{
  "tab":1,
  "mode":"semantic",             // off | semantic | trace
  "clear":false,
  "reload":false
}}

// result
{
  "mode":"semantic",
  "hook_installed":true,
  "effective":"immediate_future_calls",
  "past_content_recovered":false,
  "reload_required_for_complete_history":false,
  "coverage":{"main_frame":true,"same_process_frames":true,"oopif":true,"workers":"partial"},
  "warnings":[]
}
```

若启动时 `AI_BROWSER_CANVAS_HOOK=0`，设置 mode 只能返回 `reload_required:true`；只有调用方同时传 `reload:true` 才允许刷新页面，不能静默刷新并丢掉用户状态。

### `ui.canvas_list`

```jsonc
{"method":"ui.canvas_list","params":{"tab":1}}
```

```json
{
  "canvases":[{
    "canvas_id":"canvas:nav-7:frame-main:2",
    "kind":"2d",
    "frame_id":"frame-main",
    "dom":{"id":"game","aria_label":"棋盘","visible":true},
    "bitmap_size":{"width":1200,"height":800},
    "viewport_bounds":{"x":40,"y":100,"width":900,"height":600},
    "readability":"semantic",
    "calls_retained":482,
    "first_retained_seq":120,
    "last_seq":601,
    "dropped_calls":119
  }],
  "retention":{"bytes":218430,"max_bytes":4194304}
}
```

### `ui.canvas_read`

```jsonc
{"method":"ui.canvas_read","params":{
  "tab":1,
  "canvas_id":"canvas:nav-7:frame-main:2",
  "view":"summary",              // summary | calls
  "since_seq":500,
  "limit":100
}}
```

```jsonc
{
  "canvas_id":"canvas:nav-7:frame-main:2",
  "kind":"2d",
  "readability":"semantic",
  "scene_epoch":8,
  "texts":[{
    "seq":534,"method":"fillText","text":"确认支付",
    "bounds_canvas":{"x":380,"y":150,"width":120,"height":30},
    "bounds_viewport":{"x":325,"y":212,"width":90,"height":23},
    "style":{"font":"20px sans-serif","fill_style":"#fff"}
  }],
  "regions":[
    {"seq":532,"kind":"fillRect","bounds_canvas":{"x":360,"y":120,"width":160,"height":60}},
    {"seq":540,"kind":"image","source":{"kind":"image","url":"https://…","width":64,"height":64}}
  ],
  "calls":null,
  "pagination":{"returned":41,"next_seq":541,"has_more":true,"history_gap":false},
  "warnings":["regions are draw bounds, not proven interactive hit regions"]
}
```

`view:"calls"` 返回规范化 `method/args/transform/style/path`；绝不在默认 summary 中倾倒全部 path/shader。

### 截图候选接口：`ui.canvas_capture`（**待用户拍板，未裁决**）

若选择保留截图兜底，接口建议为：

```jsonc
{"method":"ui.canvas_capture","params":{
  "tab":1,"canvas_id":"canvas:nav-7:frame-main:2","format":"png"
}}
// result
{"mime_type":"image/png","data_base64":"…","width":900,"height":600,"bytes":182344,"warning":"visual fallback; consumes caller visual tokens"}
```

实现使用 `Page.captureScreenshot` + 当前 canvas clip，只截 Canvas 区域；限制最大边长/总像素与响应大小。它截到的是合成后的可见区域，可能包含压在 Canvas 上方的 DOM overlay；CSS 旋转时只能截外接矩形。

**需要用户拍板的三个选项：**

- **A. 完全不提供截图**：最符合“不截图”原则，但 WebGL/raster 页面会明确不可读。
- **B. 只提供 raw WS 的显式 opt-in `ui.canvas_capture`，默认关闭**：不污染 13/15 个 MCP schema，调用方需自己处理 base64；与定位冲突最小但 MCP agent 不便使用。
- **C. `browse_canvas(operation:"capture")` 也返回 MCP image content，默认关闭、每次显式调用**：兜底能力最好，但正式引入视觉 token 路径，容易被 agent 滥用为默认读法。

无论选择 B/C，都建议只在 `ui.canvas_read.readability` 为 `opaque/partial` 且结构化层不足时由 agent 主动调用；**本方案不替用户选择 A/B/C。**

## 1.6 MCP 暴露建议

新增一个聚合工具而不是三个细工具：

```text
browse_canvas(operation: "list" | "read" | "configure" [| "capture"，待拍板], ...)
```

`list/read/configure` 映射上述 WS 方法；`canvas_click` 继续复用 `browse_act`。这样 Canvas 只增加一个工具 schema。

## 1.7 能力边界

以下场景仍可能读不懂，接口必须如实返回原因：

- WebGL/WebGL2/WebGPU 的 shader/texture/顶点只能描述“怎么渲染”，不能还原“这是登录按钮/地图道路/角色血条”。
- 使用 `drawImage`、视频帧、glyph atlas、`putImageData` 或预渲染位图绘制的文字，没有可恢复的原始字符串。
- `Path2D` 从 SVG path/另一 Path2D 构造后再传入 `fill/stroke`，内部几何不可由标准 API 反射。
- hook 开启晚于绘制且页面不再重绘，过去内容不可恢复；必须提示 reload，不能假装完整。
- OOPIF/worker 自动附着失败、worker OffscreenCanvas 无法映射回 DOM canvas 时，能读日志也不一定能点。
- 页面可检测原型 wrapper，也可伪造 main-world binding 消息；日志是“不可信网页输入”，不是安全审计证据。
- 调用记录是近期历史，不是 Chromium 内建 scene graph；复杂 clip/composite/filter/覆盖下的“当前可见对象”只能近似。

---

# 第二章：把网络抓包做成可查询的 Chrome Network 面板

## 2.1 现状

- CDP 分发只处理 `Network.responseReceived`、`Network.loadingFinished`、`Network.loadingFailed`（`src/main/page_manager.js:1141-1167`）；没有 `requestWillBeSent`，因此 method、请求头、POST data、initiator 都缺失。
- `_networkRequestMap` 只有 `{url, tabId, finished}`（`src/main/page_manager.js:1057`）。
- `getNetworkBody()` 只能按 URL 子串从 Map 正向找到一个已完成请求，调用 `Network.getResponseBody` 后静默截成 5,000 字符（`src/main/page_manager.js:1059-1078`）。Map 的正向遍历还意味着同 URL 多次请求时通常拿到最旧匹配，不是最近一次。
- 网络域只在 `browse_subscribe` 间接触发后启用（`src/main/page_manager.js:1049-1054`、`src/main/page_manager.js:1129-1133`），订阅前的请求无法补录。
- raw WS 可收无 id 事件，但 MCP client 明确丢弃所有 notification（`src/main/mcp_ws.js:54-60`）。因此 MCP 必须以查询/拉取为主，不能把“Network 面板”建立在实时推送之上。

## 2.2 可选方案与取舍

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 扩展现有 URL 模糊查 body | 改动小 | 无列表、同 URL 歧义、无请求侧、无分页/截断状态 | 仅保留兼容层 |
| CDP Network 事件 + 有界内存索引 | 与 DevTools 同源；覆盖 Document/XHR/Fetch/静态资源；无页面注入 | body 可能被 Chromium 淘汰；ExtraInfo 乱序；大 body 占内存 | **主方案** |
| Electron `webRequest` | 可观察请求生命周期 | 请求/响应 body 能力弱，和 CDP 双轨关联复杂 | 不采用 |
| `Fetch.enable` 拦截请求 | 可暂停/修改/重放 | 改变页面时序，失败会卡请求；被动抓包不需要 | 不采用 |
| 页面注入包装 fetch/XHR/FormData | 可看到调用点和 JS 对象 | 污染 main world，漏掉资源/导航/worker，仍无法追踪普通对象字段来源 | 仅作为未来显式 provenance trace，不进首版 |

## 2.3 推荐架构

### 2.3.1 启用时机

网络元数据应默认开启，并和 Canvas hook 一样在首个真实导航前完成：

```js
Network.enable({
  maxPostDataSize: 4 * 1024 * 1024,
  maxTotalBufferSize: 32 * 1024 * 1024,
  maxResourceBufferSize: 8 * 1024 * 1024,
  enableDurableMessages: true
})
```

这些数值是初始默认值，不是无限承诺：

- `maxPostDataSize` 控制 `requestWillBeSent.request.postData` 内联上限；它应足够覆盖常见 JSON/form，但仍需 `Network.getRequestPostData` 补充。
- durable message 与 buffer 参数在目标 Chromium/CDP 中可能是实验能力；初始化应先尝试完整参数，失败则降级为不带实验参数的 `Network.enable`，并在 capability 中返回 `durable_response_bodies:false`。
- 不应等第一次 `ui.network_list` 或 `ui.subscribe` 才启用，否则初始 HTML/API 已经丢失。`ui.subscribe` 只控制 raw WS 推送，不再控制是否采集。
- 启动级提供 `AI_BROWSER_NETWORK_CAPTURE=0|1`，推荐默认 `1`。关闭后查询接口明确返回 `capture_disabled`；重新开启只能记录未来请求，若要首屏完整必须由调用方显式 reload。

### 2.3.2 事件与合并规则

新增独立 `network_monitor.js`；不要继续膨胀 `page_manager.js`。每个 CDP 事件处理如下：

1. `Network.requestWillBeSent`
   - 建记录：url、method、初始 headers、`hasPostData/postData/postDataEntries`、resource type、timestamp/wallTime、documentURL、frameId、loaderId、initiator。
   - `initiator.stack.callFrames` 原样规范化为 `{function,url,line,column}`，用于 agent 去 HTML/JS/其他接口中分析构建来源。
   - redirect 时同一个 CDP requestId 会复用：先用 `redirectResponse` 完成上一 hop，再创建 `redirect_index + 1`；公共 id 用不透明 `network_id = tabId:requestId:redirectIndex`，调用方不得只靠 requestId 定位。
2. `Network.requestWillBeSentExtraInfo`
   - 合并浏览器实际发送的 headers、associated cookies、client security state；以大小写不敏感键覆盖初始 headers，并记 `headers_source:"extraInfo"`。
   - ExtraInfo 可能先于或后于 request event，且并非每次都有；按 `requestId` 维护有界 pending queue，并按 redirect hop 顺序消费，不能假设事件固定先后。
3. 请求体
   - 有 `postData` 时立即复制到自己的 body store；`hasPostData=true` 但内联缺失/疑似到达上限时尽快调用 `Network.getRequestPostData`。
   - 优先保存 `postDataEntries.bytes`（如目标版本提供）；`getRequestPostData` 对 multipart 文件内容可能省略，必须返回 `complete:false` 和 `omissions:["multipart_file_bytes"]`。
4. `Network.responseReceived` / `responseReceivedExtraInfo`
   - 合并 status/statusText、mimeType、protocol、response headers、raw headers text（若有）、timing、remote IP、cache/service-worker/security 信息。
5. `Network.dataReceived`
   - 累积 decoded/encoded byte count，不存每个 chunk。
6. `Network.loadingFinished`
   - 完成状态、duration、encodedDataLength。对 `Document/XHR/Fetch` 且 JSON/XML/text/form 等 API 类型，在单体上限内立即 `Network.getResponseBody` 缓存；其他资源保持 lazy，详情首次读取时再尝试。
7. `Network.loadingFailed`
   - 记录 errorText、canceled、blockedReason，状态为 `failed`，不得伪造成 HTTP status 0 的正常响应。
8. 可选 raw WS 推送 `network_request` / `network_finished`；MCP 路径不依赖推送，使用 `browse_network(operation:"list")` 轮询。

### 2.3.3 记录模型

```ts
type NetworkRecord = {
  seq: number;
  network_id: string;             // opaque，redirect hop 唯一
  request_id: string;             // CDP 原值，仅诊断
  redirect_index: number;
  tab_id: number;
  frame_id?: string;
  loader_id?: string;
  url: string;
  method: string;
  resource_type: string;          // Document | XHR | Fetch | Script | ...
  started_at: string;             // wallTime 转 ISO
  started_monotonic: number;
  finished_at?: string;
  duration_ms?: number;
  state: 'pending'|'finished'|'failed'|'stale';
  status?: number;
  status_text?: string;
  mime_type?: string;
  encoded_data_length?: number;
  decoded_data_length?: number;
  has_request_body: boolean;
  request_body_state: 'none'|'captured'|'partial'|'evicted'|'unavailable';
  response_body_state: 'pending'|'lazy'|'captured'|'partial'|'evicted'|'unavailable';
  initiator?: object;
  error?: { text:string; canceled?:boolean; blocked_reason?:string };
}
```

列表项只返回轻量字段；headers/body/stack 详情按 id 拉取，避免每次列表把敏感/大数据灌进上下文。

### 2.3.4 保留、轮转与隐私

建议默认值：

- metadata：每 tab 2,000 条、全局 10,000 条、完成后 TTL 30 分钟，任一先到即淘汰最旧完成项；pending 项不因普通轮转删除，但超过 2 分钟仍无终态时标成 `stale` 后可轮转，防止异常连接永久占位。
- body store：每 tab 32 MiB、全局 128 MiB；单 request body 8 MiB、单 response body 8 MiB。优先淘汰最旧 response body，再淘汰最旧 request body，最后只保留 metadata。
- API 单次正文默认 64 KiB、最大 256 KiB，通过 offset 分页；这只是**输出分页**，不等同于 capture 截断。
- metadata 被轮转时返回全局 `dropped_records`；body 被淘汰时记录仍存在但 state=`evicted`。不要像当前实现一样返回 `null` 让 agent 猜是空 body、未完成还是已丢失。
- 所有日志只在内存中，不落盘。Cookie、Authorization、Proxy-Authorization、Set-Cookie 默认在详情返回中遮盖；只有启动时显式 `AI_BROWSER_NETWORK_SENSITIVE=1` 且调用传 `include_sensitive_headers:true` 才返回。请求 body 本身也可能含口令/token，响应需带 `sensitive_data_warning`。

正文统一返回：

```jsonc
{
  "state":"captured",            // captured | partial | evicted | unavailable
  "source":"requestWillBeSent.postData",
  "kind":"json",                // json | form_urlencoded | multipart | text | binary | unknown
  "mime_type":"application/json",
  "raw":{
    "encoding":"utf8",          // utf8 | base64
    "data":"{\"title\":\"…\"}",
    "offset":0,
    "returned_bytes":65536,
    "captured_bytes":180233,
    "total_bytes":180233,
    "truncated":true,             // 本次输出后还有内容
    "next_offset":65536,
    "complete_available":true     // 可继续分页拿完
  },
  "parsed":{"title":"…"},     // 仅完整且可安全解析时提供
  "complete":true,
  "omissions":[]
}
```

必须区分：

- `raw.truncated:true + complete_available:true`：只是本次输出分页，继续请求即可拿全。
- `state:"partial" + complete:false`：采集源本身不完整，继续分页也拿不到缺失部分。
- `state:"evicted"`：曾采集但因内存策略淘汰。
- `state:"unavailable"`：CDP 不提供、请求未完成、流未终止或读取失败；附 `reason`。

JSON 只在完整 body 时解析；urlencoded 保留有序且允许重复 key；multipart 返回 part 的 name/filename/content-type/size 和可用文本，文件字节缺失必须列入 omissions；binary 不强行转文本。

## 2.4 具体 WS 接口

### `ui.network_list`

```jsonc
{"method":"ui.network_list","params":{
  "tab":1,
  "method":["POST","PUT"],
  "url_contains":"/api/",
  "status":{"min":200,"max":499},
  "resource_type":["XHR","Fetch"],
  "started_after":"2026-10-07T09:00:00.000Z",
  "started_before":"2026-10-07T09:10:00.000Z",
  "state":["finished","failed"],
  "limit":50,
  "before_seq":812
}}
```

```jsonc
{
  "requests":[{
    "seq":811,
    "network_id":"1:9271.42:0",
    "request_id":"9271.42",
    "tab_id":1,
    "url":"https://example.test/api/article",
    "method":"POST",
    "status":201,
    "mime_type":"application/json",
    "resource_type":"Fetch",
    "started_at":"2026-10-07T09:03:18.143Z",
    "duration_ms":284,
    "encoded_data_length":1384,
    "has_request_body":true,
    "request_body_state":"captured",
    "response_body_state":"captured",
    "state":"finished"
  }],
  "pagination":{"next_before_seq":761,"has_more":true},
  "retention":{"first_seq":114,"last_seq":844,"dropped_records":113,"body_bytes":12003211,"max_body_bytes":33554432},
  "capture":{"enabled":true,"since":"2026-10-07T08:58:00.000Z"}
}
```

过滤在服务端执行；`limit` 默认 50、最大 200，按 seq 倒序。空过滤不是错误，等价于当前 tab 最近请求。

### `ui.network_get`

```jsonc
{"method":"ui.network_get","params":{
  "tab":1,
  "network_id":"1:9271.42:0",
  "include_request_headers":true,
  "include_request_body":true,
  "include_response_headers":true,
  "include_response_body":true,
  "include_sensitive_headers":false,
  "request_body_offset":0,
  "response_body_offset":0,
  "body_limit":65536
}}
```

```jsonc
{
  "record":{"network_id":"1:9271.42:0","url":"https://example.test/api/article","method":"POST","status":201,"resource_type":"Fetch","state":"finished"},
  "request":{
    "headers":[
      {"name":"content-type","value":"application/json"},
      {"name":"authorization","value":"[REDACTED]","redacted":true}
    ],
    "headers_source":"extraInfo",
    "body":{"state":"captured","kind":"json","raw":{"encoding":"utf8","data":"…","offset":0,"returned_bytes":1234,"captured_bytes":1234,"total_bytes":1234,"truncated":false,"next_offset":null,"complete_available":true},"parsed":{"title":"示例"},"complete":true,"omissions":[]},
    "initiator":{"type":"script","stack":{"callFrames":[{"function":"submit","url":"https://example.test/app.js","line":431,"column":18}]}},
    "document_url":"https://example.test/editor"
  },
  "response":{
    "headers":[{"name":"content-type","value":"application/json"}],
    "headers_text":null,
    "mime_type":"application/json",
    "protocol":"h2",
    "from_disk_cache":false,
    "from_service_worker":false,
    "body":{"state":"captured","kind":"json","raw":{"encoding":"utf8","data":"…","offset":0,"returned_bytes":832,"captured_bytes":832,"total_bytes":832,"truncated":false,"next_offset":null,"complete_available":true},"parsed":{"id":123},"complete":true,"omissions":[]}
  },
  "sensitive_data_warning":"request/response data may contain credentials or personal data"
}
```

不存在/已轮转用稳定错误码，而不是 `null`：

- `-32020 NETWORK_NOT_FOUND`
- `-32021 NETWORK_BODY_EVICTED`
- `-32022 NETWORK_BODY_UNAVAILABLE`
- `-32023 SENSITIVE_HEADERS_DISABLED`

`evicted/unavailable` 也可作为成功详情中的 body state 返回；只有调用明确要求“必须有 body”时才使用错误码。

### `ui.network_clear`

```jsonc
{"method":"ui.network_clear","params":{"tab":1}}
// => {"ok":true,"cleared_records":381,"cleared_body_bytes":12003211}
```

只清内存日志，不清浏览器 cache/cookie；命名和响应必须避免 agent 误以为清了会话。

### `ui.network_configure`

```jsonc
{"method":"ui.network_configure","params":{
  "tab":1,
  "enabled":true,
  "capture_bodies":"api"         // none | api | all
}}
```

返回 `{enabled, capture_bodies, effective, reload_required_for_initial_navigation, capabilities, limits}`。调用方不能通过 WS 把硬上限设成无限；上限仅由受控 env/config 改。

### 兼容 `ui.network_body`

保留一个版本：按 `url_pattern` 选择**最近完成**的匹配项，内部转 `network_get`，响应仍保持旧 `{body:string|null}`，同时可加 `deprecated:true`/warning。下一主版本删除，避免长期维护两个网络模型。

## 2.5 MCP 暴露与工具数

新增一个聚合工具：

```text
browse_network(operation: "list" | "get" | "clear" | "configure", ...)
```

- `list/get` 是核心能力，值得进入 MCP；否则主要使用 MCP 的 agent 仍无法完成用户所述任务。
- `clear/configure` 合并为 operation，避免再加两个 schema。
- 不依赖 notification；`browse_network(list)` 可按 `after_seq`/时间轮询。

与第一章合计新增 `browse_canvas`、`browse_network` 两个工具：

| 发布策略 | 工具数 | 代价 | 推荐场景 |
|---|---:|---|---|
| 兼容发布：保留 13 个旧工具并新增 2 个 | 15 | 每轮都会注入两个 schema；预计增加数千字符、约数百到一千余 token，实际须用目标 MCP client 序列化结果测量 | 当前 minor 版本，避免破坏调用方 |
| breaking 发布：删除 `browse_subscribe`、`browse_network_body`，加入两个聚合工具 | 13 | 需要迁移说明；旧工具调用失败 | **下一主版本推荐** |
| 不增加 MCP，只开放 raw WS | 13 | 最省 token，但 MCP agent 实际得不到核心新能力 | 不推荐 |

`browse_subscribe` 是合适的换出项：它在 MCP 路径不能收到实时推送（`src/main/mcp_ws.js:54-60`）；采集改为默认后，其“启动网络缓存”的副作用也不再需要。`browse_network_body` 被严格超集替代。验收时应比较 `JSON.stringify(MCP_TOOLS)` 的真实字符/token 数，保持两个聚合 schema 简短，不在 description 复制整份协议。

## 2.6 “POST 数据构建过程”能做到什么

首版可以提供：最终发出的 body、实际请求头、initiator call stack、发起 document/frame、redirect 链、前后相关接口与 JS URL/行列。agent 因而可以：

1. 按时间/URL/initiator 找到 POST；
2. 解析 JSON/form/multipart 字段；
3. 查询此前响应和 HTML/脚本；
4. 沿 call frame 查 bundle/source map（若站点提供）并推断字段来源；
5. 显式构造自己的请求。

但 CDP Network 观察的是**最终请求**，不会记录普通 JS 对象从创建到 `JSON.stringify()` 的逐字段数据流。即使未来包装 fetch/XHR/FormData，也最多看到发送点对象和部分 append 历史，无法普遍证明“每个字段由哪段代码/哪个接口计算而来”。首版不要给出 `construction_complete:true` 一类虚假承诺。

也不新增“一键 replay POST”：重复提交、下单、发布等请求有外部副作用。日志提供分析材料，是否模拟和发送必须由上层 agent 显式决定。

## 2.7 能力边界

- 只能看到已附着 tab/相关 target 且在 `Network.enable` 之后发生的请求；其他 Electron main process、其他应用、附着前请求不可见。
- `Network.getResponseBody` 可能因导航、CDP buffer 淘汰、下载、缓存、stream/SSE 未结束而失败；durable messages 也不是无限存储。
- multipart 文件字节、流式上传、浏览器内部生成/禁止脚本设置的 headers、HTTP/2 pseudo-header 顺序不保证能精确复现。
- ExtraInfo 可能缺失或乱序；此时只能返回普通 event headers，并明确 `headers_source`。
- WebSocket 握手可进入 HTTP 日志，但 frame 内容需另接 `webSocketFrameSent/Received` 并单独限流；首版不承诺 frame/SSE/WebTransport 全量历史。
- Service Worker 命中可由 `from_service_worker` 标识，但 worker 自身独立发起且未自动附着的请求可能缺失。
- initiator stack、source map 和最终 body 只能辅助分析构建过程，不能替代通用动态数据流追踪。
- 请求/响应日志来自不可信网页且可能包含秘密；不落盘、默认遮盖敏感 header、WS 鉴权问题未解决前不得把 9223 暴露到非 localhost。

---

# 第三章：`node.value` 截断必须可发现、可取全

## 3.1 现状

- legacy 路径直接执行 `v.slice(0, 200)` / `innerText.slice(0, 200)`，未告诉 agent 是否还有内容（`src/preload/extractor.cjs:253-260`）。
- AX 路径同样执行 `String(v).slice(0, 200)`（`src/main/axExtractor.js:98-102`）。
- 这是项目自己的截断，不是 CDP Accessibility 限制。当前契约把“原值恰好 200 字符”和“更长但被截断”变成同一个结果，agent 无法判断是否需要补读。
- JS `String.prototype.slice` 按 UTF-16 code unit，边界可能切断 emoji 等 surrogate pair；统一方案应顺手定义长度单位。

## 3.2 可选方案与取舍

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 不截断 | 最完整 | 树体积不可控，每次读树重复消耗 token | 不采用 |
| 只加 `value_truncated` | 很小 | 不知道全长，也不知道如何取全 | 不足 |
| 加 flag/full length/直接调用提示 | 快路径仍只有 200 字符；按需可取全 | 截断节点多几个字段 | **采用** |
| 给每个 value 新增 MCP tool | 语义干净 | 为一个窄能力永久增加 tool schema | 不采用 |
| 复用 `browse_evaluate` | 无协议改动 | AX id 未必已 stamp 到 DOM；OOPIF 与 selector 转义不可靠 | 不作为统一路径 |
| 扩展 `ui.act`/`browse_act` 的 `get_value` | 复用既有 target 解析，可覆盖 AX/legacy/OOPIF，不新增 MCP 工具 | `act` 中混入只读操作，命名不完美 | 最小且可靠 |

## 3.3 推荐统一契约

长度统一按 **Unicode code point** 计数和截取，避免把 surrogate pair 切半；字段语义写入共享契约测试。非截断值保持现状，只返回 `value`，不为每个短输入增加 token。只有确实截断时附加：

```jsonc
{
  "id":"ax-418",
  "role":"textbox",
  "value":"前 200 个 Unicode code point……",
  "value_truncated":true,
  "value_full_length":1837,
  "value_length_unit":"unicode_code_point",
  "value_fetch":{
    "mcp":{"tool":"browse_act","args":{"action":"get_value","target":"ax-418","tab":2}},
    "ws":{"method":"ui.act","params":{"action":"get_value","target":"ax-418","tab":2}}
  }
}
```

约束：

- `value_truncated` 只在 `full_length > 200` 时出现并为 `true`；不得出现 `false` 增加普通节点体积。
- `value_full_length` 是未截断 Unicode code point 数，不是 UTF-16 `.length`，也不是字节数。
- `value` 永远是原值前缀，不添加 `...`，避免调用方误把省略号当真实内容。
- `value_fetch` 在最终 Tree response 组装时补 `tab`，保证查询非 active tab 时提示仍可直接执行。
- `input[type=password]` 不返回值、长度或 fetch hint；只返回 `value_sensitive:true`。`input[type=file]` 不把本地路径当普通 value 暴露。

### 共享实现边界

新增一个 CJS/ESM 都能使用的纯 helper（例如 `src/shared/value_contract.cjs`）：

```ts
truncateNodeValue(raw, target, limit = 200) =>
  | { value: string }
  | { value: string, value_truncated: true,
      value_full_length: number,
      value_length_unit: 'unicode_code_point',
      value_fetch_ref: { action:'get_value', target:string } }
```

- legacy 的 input/textarea/select/contenteditable 统一调用 helper，替换两处直接 slice。
- AX 的 textbox/combobox/listbox/searchbox 统一调用同一 helper，替换当前 slice。
- 主进程 `tree_contract`/响应组装器把内部 `value_fetch_ref` 展开成包含实际 tab 的 `value_fetch`，再删除内部字段。
- OOPIF 归一化和以后任何新增 `TreeNode.value` 生产者都必须走 helper；不得仅修两行后让新路径再次漂移。

如果不希望引入 CJS 共享模块，最低可接受方案是两处实现同名纯函数并用同一组 contract fixtures 测试；但单一 helper 更不容易漂移。

## 3.4 具体接口

扩展现有 WS `ui.act`：

```jsonc
{"method":"ui.act","params":{
  "tab":2,
  "action":"get_value",
  "target":"ax-418",
  "params":{"offset":0,"limit":20000}
}}
```

```jsonc
{
  "success":true,
  "target":"ax-418",
  "value":"完整或当前分页内容……",
  "offset":0,
  "returned_length":1837,
  "value_full_length":1837,
  "value_length_unit":"unicode_code_point",
  "value_truncated":false,
  "next_offset":null
}
```

行为：

- 默认 `offset=0`，`limit` 默认 20,000、硬上限 1,000,000 code points；普通值一次即可拿全，极端值分页。
- 若仍有后续，返回 `value_truncated:true` 和 `next_offset`；错误明确区分 target 不存在、target 无 value、敏感字段拒绝读取。
- legacy 通过已存在的 `data-ai-id` 解析；AX 通过 backendDOMNodeId/现有 handle 解析；OOPIF 复用现有 owning-frame 路由，不能退回 label 猜测。
- `get_value` 是只读分支，不聚焦、不触发 input/change、不修改页面。虽复用 `act` 外壳，但不走输入动作 fallback。

MCP 只扩展 `browse_act` 的 action enum 加 `get_value`，并增加可选 `offset/limit`，工具数不增加。最终树中的默认提示可省略 offset/limit，直接拿常规全量；若响应仍截断，按 `next_offset` 继续。

## 3.5 测试与验收

两条读层必须共享以下 fixtures：

1. 199/200/201 code points：仅 201 出现截断字段。
2. emoji/组合字符边界：不得产生孤立 surrogate；长度单位固定为 code point（不宣称 grapheme 数）。
3. textarea、select、contenteditable、AX fallback value 形状一致。
4. active tab 与非 active tab：`value_fetch` 中 tab 正确。
5. main frame、同源 iframe、OOPIF 的 `get_value` 返回正确节点。
6. 1,000,001 code points：按 offset/limit 分页，`next_offset` 和全长正确。
7. password/file input：不泄露 value、长度或 fetch hint。
8. contract test 断言两条路径对同一值产出完全相同的截断字段。

## 3.6 能力边界

- `value` 仅表示控件当前可读值，不是编辑历史；网站内部 model 若未同步到 DOM/AX，读不到。
- Unicode code point 不是用户感知 grapheme；例如带组合音标的字符可能计为多个，但不会切断 UTF-16 surrogate pair。
- 页面在树读取后可能立刻修改值；`value_fetch` 是按 target 读取**调用当下**的值，不保证和 preview 属于同一时刻。响应可附 `tree_revision`/`read_at` 供调用方判断。
- 密码、文件路径等敏感值不会因“取全量”需求而自动暴露。
- 极端超长值仍要分页；`value_truncated` 必须继续准确表达“本次返回后是否还有”。

---

# 第四章：实施顺序与共同验收

## 4.1 建议实施顺序

1. **先做 value 契约**：范围小，建立统一的 `truncated/full_length/next` 表达方式；后续 Canvas/Network body 复用相同原则。
2. **抽出 CDP session/target 路由**：现有 debugger listener 和 domain 管理在 `page_manager.js` 内（`src/main/page_manager.js:1092-1118`），Canvas worker/OOPIF 与 Network 都依赖 sessionId-aware 分发。
3. **Network metadata + list**：先保证首导航前启用、事件合并、redirect 与轮转正确。
4. **Network request/response detail + body store**：再加入 body 分页、解析、遮盖和淘汰状态。
5. **Canvas 2D semantic**：先 main frame + same-process frame；通过性能 gate 后再默认开启。
6. **Canvas OOPIF/worker/WebGL trace**：作为部分能力增量，不阻塞 2D 主能力发布。
7. **最后按用户裁决实现或删除截图候选接口**；未裁决前不得把 `ui.canvas_capture` 写进正式 protocol/MCP tools。

## 4.2 共同验收门槛

- 首导航 fixture：页面第一行脚本立即 `fillText` 和 POST，两个事件都能捕获，证明不是 `dom-ready` 后补装。
- 有界性：持续动画 + 每秒请求压测 30 分钟，主进程/renderer 日志内存稳定在配置上限附近，且 dropped/evicted 元信息正确。
- 透明性：关闭 hook 后业务行为不变；开启 hook 的 Canvas API 返回值/异常与原生一致；监控序列化异常不影响页面。
- 多 tab/redirect/OOPIF：id 不串 tab、不串导航、不串 redirect hop；关闭 tab 会释放对应 canvas/network/target 状态。
- MCP 拉模式：不依赖 notification，`browse_network list/get` 与 `browse_canvas list/read` 可独立工作。
- Token：列表/summary 默认不含 headers/body/raw paths/shader；所有大字段都有 limit、游标、`truncated/has_more/complete_available`。
- 安全：binding payload 按不可信输入校验；网络秘密默认遮盖且不落盘；截图若获批也必须显式调用且有限尺寸。

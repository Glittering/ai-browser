# AI Browser — 技术规格

> 本文件描述**当前实现**。规格与代码漂移就是 bug —— 若两者不一致，以代码为准，
> 并请把这里改回来（README 末节写明同一条纪律）。

## 定位

**AI 是唯一操作者。** agent 通过 MCP（stdio）或 WebSocket（JSON-RPC 2.0）驱动浏览器；
窗口是一个**真实、可见、可用鼠标键盘手动操作的普通 Electron 窗口** —— 人的介入
（登录、扫码、滑块、纠偏）发生在那里，但浏览器侧没有为"人机协作"设计任何机制，
也没有控制权仲裁层。

渲染像素给人看，结构化 API 给 agent 用。**不截图、不做 OCR**：读页面走语义树 /
CDP / 应用自己的数据模型。

## 技术栈

| 组件 | 选择 | 说明 |
|---|---|---|
| 浏览器内核 | Electron 33（Chromium 130+） | BrowserView 承载每个标签页 |
| 运行时 | Node.js 22+（Electron 自带） | 主进程为 ESM，preload 为 CommonJS |
| 传输 | `ws` — JSON-RPC 2.0 子集，`ws://localhost:9223` | 见 `src/shared/protocol.js` |
| agent 接入 | `@modelcontextprotocol/sdk`（stdio） | `src/main/mcp_server.js` |
| 测试 | Vitest（单测）+ 自建 Electron e2e 套件 | jsdom 用于无头 DOM 断言 |

依赖以 `package.json` 为准（`electron` / `ws` / `jsdom` / `@modelcontextprotocol/sdk`）。

## 进程与数据流

```
agent ──MCP stdio──┐
                   ├──► main 进程 ──► PageManager ──► BrowserView（每标签一个）
agent ──WS JSON-RPC┘        │                        └── preload (bridge.cjs)
                            └──► CDP（附加在 webContents.debugger 上）
```

- **preload**（`bridge.cjs` + 三个 `.cjs`）负责"读 DOM / 执行动作 / 观察变更"，
  经 `contextBridge` 暴露 `__ai_browser__`，与主进程走 `ai:*` IPC。
  ⚠️ BrowserView 必须 `sandbox:false`（`page_manager.newTab`），否则 preload 只能
  require Electron 白名单，拿不到本地 `.cjs` 模块。`nodeIntegration:false` +
  `contextIsolation:true` 不变，页面代码始终没有 Node 权限。
- **CDP** 是主进程侧的能力通道（`webContents.debugger`）：`Runtime.evaluate`、
  受信输入（`Input.dispatchMouseEvent` / `dispatchKeyEvent`）、网络抓包、canvas 记录。

## 模块

| 路径 | 职责 |
|---|---|
| `src/main/index.js` | 应用入口：窗口、看门狗、窗口级重绘钩子、生命周期 |
| `src/main/page_manager.js` | 标签页生命周期、语义树、动作执行、CDP、快照/重绘 |
| `src/main/ws_server.js` | WebSocket JSON-RPC 分发（`ui.*` 的唯一权威清单） |
| `src/main/mcp_server.js` / `mcp_tools.js` / `mcp_ws.js` | MCP 适配层与工具清单 |
| `src/main/network_monitor.js` | 请求/响应捕获（Chrome Network 面板等价物） |
| `src/main/canvas_monitor.js` + `canvas_hook_source.js` | canvas 绘制调用记录（非像素） |
| `src/main/axExtractor.js` | AX（无障碍树）读取层，链接带 url |
| `src/main/snapshot_diff.js` | 结构化 diff、默认快照表达式（含 canvas 应用的模型指纹）、基线回收 |
| `src/main/capability_probe.js` | "这一页该怎么操作"的决策探针；导出应用模型识别表（`APP_KEY_RE` / `MODEL_PROBES` / `GRAPH_RANK` / `MODEL_PROBE_ORDER`），供探针与默认快照共用同一份定义 |
| `src/preload/bridge.cjs` | preload 入口：IPC 接线 |
| `src/preload/extractor.cjs` | DOM → 语义树 + 页面上下文 |
| `src/preload/actions.cjs` | 页内动作执行（部分场景的兜底路径） |
| `src/preload/watcher.cjs` | MutationObserver → 变更事件 |
| `src/shared/*` | `config` / `guards` / `protocol` / `watchdog` / `value_contract` |

## WS 协议

请求 / 响应 / 错误均为 JSON-RPC 2.0 子集（`src/shared/protocol.js`）：

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"ui.act",
   "params":{"action":"type","target":"e:input-3","params":{"text":"hi"},"tab":0}}
← {"jsonrpc":"2.0","id":1,"result":{"success":true,"method":"cdp-input","chars":2}}
← {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"script exceeds 5000 char limit"}}
← {"jsonrpc":"2.0","method":"dom_change","params":{"changes":[…]}}   // 无 id = 推送
```

两个容易踩的形状约定：

1. **动作参数嵌在 `params.params` 里**，不是顶层。写成 `{action,target,text}` 会让
   `text` 变 undefined → 空文本 → 曾命中幂等短路而"什么都没打却报 success"。
   现在空文本会**明确报错**。
2. `tab` 可选，缺省作用在活动标签上。

方法清单以 `VALID_METHODS`（`src/shared/protocol.js`）为准，并由
`tests/test_protocol.js` 从 `ws_server.js` 的 `case 'ui.*':` 反推比对 —— 两边漂移即测试红。

## 语义树与元素定位

`ui.get_tree` 返回节点树 + 页面上下文（模态框、消息、表单、统计）。每个节点：
`id / role / label / states / actions / bounds`（输入类附 `value`，超长时走
`value_truncate` 契约，敏感控件给 `value_sensitive`）。根节点另带
`focused_element_id`（当前焦点元素的 `data-ai-id`，无对应语义节点时为 `null`）。

**`actions` 是自述契约，不是装饰**：树里广告的每个动作都必须在执行器里真有对应
case。曾出现 `role=dialog` 广告 `["open","close"]` 而两个执行器都没有这两个 case
（照着做必拿到 `Unknown action`），现由 `audit` 套件的「反虚假广告」检查逐条验。

**页面上下文的读路径一律落顶层、扫整文档**，不依赖容器 class 里有没有
`modal`/`dialog`/`popup` 关键词（那是猜语义，实测同一份错误汇总换个容器就读不到）：

| 字段 | 内容 |
|---|---|
| `errors` / `field_errors` | 全文档可见错误文案；后者能按 `{field, text}` 对应到具体输入框 |
| `hints` | 辅助文案：class 提示、N/M 型计数、**紧贴表单控件的裸 span/div 短文本** |
| `required_hints` | 必填标记（红星所在行的文案、CSS 标记、「请填写」类），**启发式补充**；权威判定看 `forms[].fields[].required` |
| `forms[].fields[]` / `modals[].fields[]` | 形状完全一致（`id/type/placeholder/required`，命中时加 `error`），`id` 可对应到具体元素 |

字段级错误只认两条路，都没有就空着：`aria-describedby` / `aria-errormessage`
（值可以是空格分隔的多个 id），或同一父容器内恰好一个输入控件。**不做"找最近的
input"这类位置猜测** —— 猜出来的对应关系比没有更糟。

**定位约定（踩过，务必守）**：

- 节点 `id` 即页面元素上的 `data-ai-id` 属性值。取值优先级：
  元素原生 `id` → 已有的 `data-ai-id` → `e:<tag>-<只增不减的序号>`。
  这样 id 跨"读树 → 操作"稳定，顶部插入一个元素不会让后面所有 id 漂移
  （旧实现每次抽取归零编号，实测插入 1 个元素后 4/4 个 id 全变，操作会静默打错元素）。
- **跨页面导航后 id 会重来**，不要跨导航复用。
- 需要长期稳定定位时，用**页面自己的属性**（`[data-node-id]`、`.react-flow__node[data-id]`）
  或坐标。
- 同源 iframe 的内容会被递归抽取并进树。

## 动作执行

| action | 实现 |
|---|---|
| `click` / `hover` / `drag` / `press` / `wheel` | **CDP 受信输入**（`Input.*`），必要时先解析元素中心点 |
| `type` / `clear` | CDP 输入（全选走页内程序化选区，**不发受信 Cmd+A** —— 那会弹出 macOS 原生 About 面板） |
| `setContent` | 整篇替换（与 `type` 的追加语义区分） |
| `scroll_to` / `focus` / `get_value` | 页内执行 |
| `upload` | 帧内注入 `File`（`DOM.setFileInputFiles` 只够得着顶层文档的 input，跨进程 iframe 进不去；见下） |

**upload 的 target**：可以是 ref，也可以是**CSS 选择器**（含带空格的组合选择器，
`.container-coverimage-box .el-upload__input`）。上传控件常常既没有语义节点、
也没有原生 id（B站「本地上传」是纯 `div` 菜单项，AX 树里根本没有），只能靠选择器。

控件有**三种状态**，工具都处理：

1. target 就是 `input[type=file]` —— 直接写；
2. target 是容器，input 预挂在里面 —— 取容器里的第一个 file input；
3. 容器里**一个 input 都没有**（组件在"已有文件"状态下把上传区整个卸载了，
   CSDN 的封面就是这样）—— 拿选择器的祖先当锚点，临时接管
   `HTMLInputElement.prototype.click` 把 input"点"出来再写。回执 `resolved_by`
   如实标明走了哪条路：`direct` / `click` / `click-descendant`。

三种都不成时返回**具体**原因（"选择器没命中任何元素" vs "命中了容器但点不出 input"），
不要笼统报 `no file input found`。点击探测只点可见的、类名带 upload/file/replace
等正向词的子元素，并显式排除 remove/delete/cancel 一类 —— 封面区常驻一个
「删除封面」按钮，误点会直接删掉用户的封面（`npm run upload` 用陷阱页钉住这一点）。

**为什么必须走 CDP**：合成事件（`el.click()`、`dispatchEvent(new MouseEvent(...))`）
对画布类应用无效。实测：React Flow 的节点拖拽在合成事件下位移恒为 0；`Fit View`
用 `el.click()` 有效而 `Zoom In` 无效，改用受信鼠标事件后两者都生效。拖拽、按键、
滚轮是画布类应用的核心操作，**没有替代品**。

**手势必须自证**：解析出的点要用 `elementFromPoint` 证明"指针真的会命中它"；
命中判定只接受"命中即目标或其子孙"，不接受 `hit.contains(target)`（父元素当然包含
子元素，等于放行失败情形）。拖拽回执要报出起点/落点上的实际元素与 id。

**`ui.scroll` 只做 `window.scrollBy`**，对画布无效 —— 画布要用
`ui.act{action:'wheel'}`（`ctrl+滚轮`=缩放，`Meta+0`=复位）。

## 验收：写入必须 diff 证明

`success` 不等于做成了。三档路线（由 `ui.capabilities` 给出建议）：

1. **L1 结构化数据 / API** —— 应用挂在 window 上的数据模型（ComfyUI 的
   `iframe[0].graph`）、或页面已在调用的 JSON 接口。读整张图、写完回读比对。
   模型**不在 window 上**时（画布应用常把实例关在闭包里）用
   `ui.capabilities{deep:true}`：它按库指纹认出 fabric / Konva / paper /
   Excalidraw / CodeMirror / Monaco，在原型某个方法上挂一个只记 `this` 的 tee，
   再派发一条合成 mousemove 让页面自己走一趟 —— 实例就回来了。返回的
   `app_model.libs[].read_expr` 可直接喂 `ui.evaluate`，但只在**当前文档**有效
   （导航后失效，那时它返回 `null` 而不是抛错）。
2. **L2 语义树** —— 按 role/label 找目标，用 `data-ai-id` 操作，**不用坐标**。
   懒渲染的面板要先点开才进树里（两段式：先点选 → 再 `get_tree` → 再操作其控件）。
3. **L3 坐标手势** —— 只在没有结构化通路时用（拖节点、拖连线、滚轮平移缩放），
   且**必须"手势 → 回读 → 比对"**：位移会被站点自己的阈值/吸附/自动平移改写。

`ui.snapshot` / `ui.diff` 把第 3 步变成一行调用。两条不变量（均由单测钉住）：

- **元素 key 由身份派生，不由位置派生。** 旧 key 是 `tag#index`，顶部插入 1 个元素
  就会把下面所有元素重新编号 —— 实测一次插入被报成 `4 added + 3 removed + 3 changed`，
  真正的信号被噪声埋掉。
- **整页文本要按全文取指纹。** 旧实现只截前 4000 字符 + 记长度，等长变化落在 4000
  之后时两者都不变 → 把"变了"报成 `unchanged`（假绿）。现在 `textHash` 覆盖全文，
  `textSegs` 只用来定位变化发生在哪一段。
- **canvas 应用的数据模型也要取指纹。** 上面两条都只描述 DOM，而 canvas 渲染页面的 DOM
  是一张定格照片：拖一个节点、改一个 widget 只重绘画布，DOM 一个字节都不动 —— 于是
  只比 DOM 的 `ui.diff` 会对一次确实发生了的写入回答 `unchanged`。ComfyUI 的文档级写路径
  `node.widgets[].value` 移动的 DOM 恰好是 0 字节。现在默认快照在页面把模型挂在 window 上时
  一并指纹化，diff 路径形如 `model.fp` / `model.count`。三条约束：
  - **只读。** `serialize()` 是应用专门暴露出来供状态往返的入口；`loadGraphData` 是加载器，
    调用它会改页面，绝不调用。抛异常或 `_nodes` 循环引用都只导致"没有指纹"，不会崩。
  - **按"能读回什么"选候选，不按名字好不好看。** 库命名空间名字得分很高却没有模型可交，
    所以 `amFp` 返回 null 就是它的落选原因。
  - **排名与读取分开。** 排名看对象**拥有**哪个访问器，读取才走 `serialize()`（它返回 JSON
    安全数据，而活的集合通常是循环的）。两者混为一谈会让每个候选都报 `serialize`、全部同分，
    于是一个单纯的序列化器就能排在真正的模型前面 —— 这个缺陷是 SD-048 抓到的，不是 review 抓到的。

## 页面刷新（窗口显示陈旧）

"窗口显示的是旧画面"**没有可观测状态**：DOM 与 `evaluate` 早就报新页面，只有屏幕是旧的。
**导航路径不重绘**（2026-10-25 改，v2.1.16）。此前 `dom-ready` / `did-finish-load` /
`did-navigate` / `did-navigate-in-page` / `did-frame-finish-load` 都挂着重绘，`navigate()`
结束也调一次 —— 结果每次刷新/开页都会强制整页重栅格化，而那一刻图层的尺寸还是初始值，
合成器先把画面按小尺寸画一遍再缩放：用户看到"先缩成左上角一小块，闪一下，然后正常"。

现在只在窗口 `show` / `restore` / `focus` 时重绘当前标签；`ui.repaint` 供调用方显式兜底，
回执带累计 `repaint_count`（`soft`/`hard` 分开计）—— 这是"重绘真的发生了"的唯一可证伪判据。
真出现旧画面时有定向兜底：白屏/缩放自检判 `scale-mismatch` → 定点重绘；几何变化走
`afterGeometryChange` 收敛。回归：`npm run layout` 的 G5 断言"两次导航 soft/hard 增量都为 0"。

### 两档重绘：soft / hard（2026-10-25 用户的"一闪一闪"教的）

| 档 | 做什么 | 用在哪 | 可见性 |
|---|---|---|---|
| `soft`（默认） | 只 `webContents.invalidate()` | 导航事件、焦点、show/restore、resize | 不可见 |
| `hard` | 额外 1px 微调（`width+1` → `width`） | 白屏阶梯、`scale-mismatch`、resize 收敛失败 | **会重排两次** |

背景：1px 微调是唯一能让 **surface 重新栅格化**的手段（尺寸不变时 `setBounds`
被 Chromium 直接忽略），但它必然触发两次重排。把 hard 放在"每次导航完成"这种高频
路径上，就是 v2.1.14 用户看到的抽搐。所以高频路径一律 soft，hard 只在"确认 surface
真的脱节"时付代价。

也不再 `removeBrowserView + addBrowserView`：那是没有 invalidate 时代唯一的手段，
代价是闪一帧白。

`ui.window_bounds` 回执带 `repaints:{soft,hard}`；`npm run layout` 的 G4 断言
"导航期间几何恒定 + hard 增量为 0"——hard 一旦漏进高频路径，回归先红。

### resize 收敛（afterGeometryChange）

窗口缩放后实测会出现 **视图 800 而页面 `innerWidth` 还是 1280**（渲染器没应用尺寸变化），
合成器于是把 1280 宽的内容画进 800 的框 —— 内容整体缩小，等它追上又是一次跳变，
即"大一下小一下"。所以几何变化后不止重排：160ms 后回读 `innerWidth` 与视图宽度比对，
不等就记 `layout_mismatch` 并 hard 重绘一次。

## 白屏自检（加载成功但屏幕是白的）

上一节的重绘解决"画面old"，这一节解决"画面空的"。两者都没有事件可听，但性质不同：
重绘只能靠外面的人喊"窗口不对"；白屏可以**自己看一眼**——这正是本节存在的理由。

"加载成功但屏幕纯白"是唯一一种**所有回调都成功**的失败形态：`did-finish-load` 到了、
`readyState=complete`、`ui.evaluate` 读得到正文、`capturePage`/截图也有内容，只有用户
看到的是白的。工具侧在这个场景下集体失明，双方都拿不出证据（2026-10-25 用户报
"打开了百度有时候是纯白屏"）。

判定（`src/shared/blank_page.cjs`，纯函数）用三个信号一起看，缺一个就会误报：

| 信号 | 作用 | 实测（1280×800 @2x） |
|---|---|---|
| 白度 | 像素 ≥250/255 的占比 | 百度首页 90–93% —— **单看它必然误报** |
| 唯一色数 | 区分"白底有内容"和"真白" | 内容页 3.9k–6.1k；故障帧 3–25；深色加载页 400+ |
| DOM 事实 | 白得对不对 | 空文档白是正确结果；有 397 字还白才是缺陷 |

阈值：`white ≥ 99% 且 unique ≤ 32` 才算"像素纯白"，再看 DOM 决定是不是故障。
判据是 `verdict` 七态：`ok / empty-legit / not-ready / collapsed / blank-with-text /
blank-with-dom / no-frame`；只有两个 `blank-*` 算缺陷，`no-frame`（我们没看到画面）
明确**不**算 —— 把诊断失败说成页面故障是最坏的一种谎。

**取帧两条铁律**（2026-10-25 用肉眼可见的闪烁换来的）：

1. **绝不用 `clip.scale` 让 Chromium 帮你缩小**。带 `clip.scale` 的 captureScreenshot
   会让 Chromium 按该比例**临时重建 surface**；自检恰好在 `did-finish-load+450ms` 跑，
   那几十毫秒里窗口往往正在重新合成 —— 于是把那张 1/4 的图贴上 1–3 帧，用户看到
   "每次加载先小一下再恢复"。实测抓到的那一帧内容宽度正好 25%，与 `clip.scale=0.25`
   一致。缩放只能自己用 `nativeImage.resize()` 做。
2. 优先 `webContents.capturePage()`（不碰 CDP Page 域、无 capture 模式），拿不到
   （窗口被遮挡会返回空图）再用**无 clip** 的 captureScreenshot 兜底；两者都拿不到
   就是 `no-frame`，**不判**缺陷。

历史注记：早期用 `capturePage()` 会因遮挡失明，于是换成 CDP + `clip.scale` ——
方向对了，参数错了。单次自检 20–160ms。

`ui.screenshot` 同理：`clip.scale < 1` 现在按 `scale=1` 抓、本地 `nativeImage.resize()`
缩，输出尺寸与语义不变。**`clip.scale > 1` 仍交给 Chromium** —— 本地放大得不到像素，
糊掉的放大图比"偶尔一帧"更糟；且它只在调用方显式要放大值时发生，不在任何自动路径上。

自救阶梯**有上限**：`repaint`（soft：只 `invalidate()`）→ `reload`（丢页面临时状态，
所以排第二）→ `give-up`（落 `error.jsonl` 的 `paint_blank` + 广播，不再折腾）。
到了最后一步才允许 `hard` 重绘（1px 微调，见「三条重绘铁律」）。
上限是硬要求：CSS 把文字刷成白的页面 reload 一万次也还是白，无上限重试会变成一个
看不见的死循环。自己发起的 reload 不清零步数（否则又是无限重载）。

触发：`did-finish-load` 后 450ms + `dom-ready` 后 900ms，**只对活动 tab**（后台 tab
不在屏幕上，为它反复取帧只是烧 CPU）；事件按 tab 合并，并发 `paint_check` 共享同一个
Promise（不返回 null）。`ui.paint_check {tab, heal?}` 供调用方按需观测；`ui.list_tabs`
只在**有问题**时带 `paint` 字段，正常页不带（不给调用方制造"每次都要判"的噪音）。

顺带补的两处：
- `ui.navigate` 现在维护 `_tabNavState`（`loading`→`ready`）。此前只有 `new_tab` 的
  占位流程会写它，于是导航期间 `list_tabs` 一直报 `ready`，agent 看到 ready 就去读树。
- 地址栏 `nav:go` 改走 `pageManager.navigate`。原先裸 `loadURL` 没有状态机、没有失败
  错误页、没有完成后重绘 —— 地址栏是最常用的一条路，缺这三样的代价就是"有时白屏"。

`render-process-gone` 也从"只打一行日志"改成**自己重载一次**（15 秒内只救一次）：
渲染进程崩溃后 Chromium 留一块白 surface，事件不再来，DOM 读不到，用户看到的是
永久白屏，而日志里只有一行。

`AI_BROWSER_PAINT_AUDIT=0` 可关闭自检（唯一用途：精确测量导航时延）。

## 几何脱节（内容缩成左上角一小块）

窗口约 1300×807，页面却只画进左上角约 325×260 的一块，其余全白、标签栏整条空白
（2026-10-25 用户截图）。DOM、`evaluate`、CDP 截图**全都正常** —— 只有窗口像素是错的。

成因：**窗口几何变了，合成器手里的 surface 还是旧尺寸**，于是它把那张大图缩进新的
bounds。`setBounds` 只改几何、不改 surface；`removeBrowserView + addBrowserView`
同样不保证重栅格化。真正的重栅格化只有 `webContents.invalidate()`（再叠一次 1px
微调，因为尺寸没变时 `setBounds` 会被直接忽略，不会重算 surface）。

三条可判定等式（`e2e/layout_ws.cjs`，`npm run layout`，25 断言）：

```
view.bounds            == 窗口内容区 - 标签栏
window.innerWidth      == view.bounds.width      ← 这条一红就是被缩放渲染了
window.devicePixelRatio ∈ {1,2}
```

`innerWidth ≠ view.width` 有两种来源，用 `webContents.getZoomFactor()` 分开：
页面缩放（合法，zoom≠1）vs surface 脱节（zoom=1）。后者判 `scale-mismatch`，
进自检的同一套阶梯（repaint → reload → give-up）。

触发点全部挂了重绘（去抖）：窗口 `resize`、`enter/leave-full-screen`、
`screen.display-metrics-changed / display-added / display-removed`、
`powerMonitor.resume`（睡眠唤醒后 DSF 失效是已知问题）、以及 `show / restore / focus`。
另外每次自检都跑一遍**布局看门狗** `_auditLayout`：视图几何不等于内容区就当场纠正，
并落一条 `layout_mismatch`（带 expected / actual 两个数字）—— 下次再出现有据可查。

`ui.window_bounds`：读窗口 bounds / content bounds / 每个视图实际 bounds；
带 `set` 可改尺寸（布局类缺陷此前无法复现也无法回归，就是因为没有这个入口）。

## 渲染路径：硬件合成 vs 软件合成

窗口内容"整体被缩放一帧""缩成左上角一小块""刷新时先小再恢复"这一类异常，几乎都长在
**软件合成**上：合成器手里的 surface 尺寸和图层几何脱节时，软件路径会把那张图**缩放**着
贴出来，而 GPU 路径会按图层几何重新栅格化。

历史：2026-10 为了规避 GPU 崩溃（`exit_code=6`）无条件调用了
`app.disableHardwareAcceleration()`，于是所有页面长期跑在软件合成上。

现在的策略（v2.1.17）：

- 默认**开**硬件加速（Apple Silicon 上更快，也不出这类缩放异常）；
- 连续两次 GPU 进程崩溃（2 分钟内）→ 写 `~/.ai-browser/.gpu-off` + `app.relaunch()`，
  之后一直走软件合成（删掉标记可恢复）。一次偶发崩溃不会把所有人降级；
- `AI_BROWSER_GPU=on|off` 可强制；
- `ui.server_info` 回执带 `render_path: {gpu, reason}`（`default` / `env` / `fallback`）——
  排查绘制类问题时，第一件事就是确认跑在哪条路上。

### 应用图标：两条渲染路径必须同尺寸

macOS 26 起，系统给 bundle 里的 icns 套了一层统一图标网格：内容缩到约 **86.7%**
再套 squircle。而 `app.dock.setIcon()` 拿到的是裸 `NSImage`，**不套**这层网格 ——
直接塞满出血的图，Dock 里就比旁边所有图标大一圈。

结果是同一个应用出现两个尺寸：从 `/Applications` 启动（bundle icns）正常，`npm start`
启动（`dock.setIcon`）偏大 16%。用户看到的正是"图标一会大一会小"。

现在的约定：

| 产物 | 用途 | 内容占比 |
|---|---|---|
| `build/icon.svg` | 母版 | — |
| `build/icon.png`（1024，满出血） | icns 的源、Windows/Linux 窗口图标 | 100% |
| `build/icon-dock.png`（1024） | `dock.setIcon` 专用，预先按网格缩好 | 86.7% ±1.5% |

`npm run icons` 重建整条链；`npm run icon:check` 量这三个数字（`tests/test_icon_geometry.js`
同口径钉住）。`ui.server_info` 带 `icon: {source, file, content_ratio}` —— `source` 是
`bundle`（打包版，用 Info.plist）还是 `dock.setIcon`（源码启动），`content_ratio` 是
实际设进去那张图的实测占比。两个数字对不上，就是又跑偏了，不用靠肉眼比。

打包侧另有两个约束：`Resources` 里**只留一份 icns**（packager 自己拷的
`electron.icns` 要删掉，否则 IconServices 建出重复表示）；构建目录里的 `.app` 打包后
从 LaunchServices 注销，安装脚本的旧版备份用 `.app.bak` 结尾 —— 同一个 bundle id
在 LS 里留多份记录时，Dock / Finder 可能解析到旧的那份图标。

## 帧级回归（`npm run flicker`）

白屏有判据、几何有等式，但"闪一下"这两类**只有在窗口像素里才存在**：DOM 正常、
`evaluate` 正常、CDP 截图正常，人眼却看得见。所以需要一个真正看屏幕的套件。

`e2e/flicker_ws.cjs` + `e2e/_win_capture.py`：起 App → 加载一个**铺满视口、上下各一条
每次换颜色的通栏色带**的 fixture → 触发 `location.reload()` → 用 macOS `avfoundation`
**固定 60fps** 录内容区 → 逐帧判定。

两道断言：

1. **采集有效**：帧间差异峰值 > 1.0。整段画面一帧没变 = 根本没拍到目标窗口，
   此时的"通过"是假的（这条比结果本身更重要 —— 假绿比红危险）。
2. **零缩小帧**：任意一帧的内容宽度 ≥ 60%（正常约 97–100%，故障约 24–25%）。

### 五个坑，每个都制造过假阴性

| 坑 | 真相 |
|---|---|
| `screencapture -v` 录 | **变帧率**（实测 ~28.7fps），50ms 的闪现被整段丢掉 —— 连续四轮"录不到" |
| 裁切坐标写死 | 窗口一动就拍到隔壁窗口，得到静态画面 = 假阴性 |
| `CGDisplayPixelsWide` 当 backing scale | 它返回**逻辑点**（1470），avfoundation 实际录 2940×1912。按 1 倍算，裁切偏到左上角 1/4 |
| 只等固定时长就 reload | ffmpeg 起播抖动几百毫秒，reload 可能落在开录之前 → 整段恒定，看起来像"没拍到" |
| 量"非白像素 bbox" | 编码器在裁剪边缘留暗线、窗口圆角透出桌面，最后一行撒几十个暗点，一量就是 100% —— 缩到 24% 的帧照样"通过" |

最终做法：裁切区域由 App 自己的 `ui.window_bounds`（`view.getBounds()` +
`contentBounds.y - bounds.y`）给出，不猜标题栏高度；坐标按**录制文件的真实尺寸**换算
（`ffprobe` 出来的宽度 ÷ 屏幕逻辑宽）；reload 等到**录制文件真的在增长**后再触发；
宽度取 `lum<200` 掩码在切掉外圈 8px 后 x 坐标的 0.5%–99.5% 分位。

负向验证（把 `clip.scale: 0.25` 加回去）实测：3 轮全部 FAIL，`tiny` 命中 24.3%，
帧号连续 3–4 帧；恢复后 3/3 全绿且每轮恰好 1 帧可见变化（色带换色）。
**没有通过这一步的回归不算回归** —— 一个永远绿的套件只是心理安慰。

## 并发：多 agent 并用，各干各的

事故模型（2026-10-28 用户提出）：默认目标以前是**全局** `activeTab` —— 也就是
"人眼看的那一页"。单 agent 时它恰好等于"agent 正在干的活"，看不出问题。多个 agent
同时用时立刻崩：

- A 开一个标签页 → **所有人**的默认目标都变成它；
- B 只说"点一下提交"，点在了 A 的页面上；
- 人切一下标签页看热闹 → 把所有 agent 的目标一起切走。

共同点：**动作落在哪个页面，取决于别人做了什么**。回执 `success`、页面真的变了，
但不是该变的那个 —— 比直接失败难查得多。

### 判据只有一处：`shared/tab_route.cjs`

```
explicit（调用方点名） > session（这个 WS 连接自己的标签页） > active（人眼看的） > 第一个
```

两条**不可退让**的约束：

1. **点名了不存在的 tab → 报错**，绝不"就近挑一个"。静默改目标 = 在错的页面上执行成功。
   （这一层不拦，交给各方法用更准的词汇报：`ui.repaint` 报 `no-such-tab`、
   `ui.diff` 报 `tab-mismatch`。）
2. **自己的标签页被**别人**关掉 → 报错**（`-32001`），绝不退回 `active`。
   自己关自己的（`ui.close_tab` 关的就是绑定那一个）则解绑、按浏览器惯例落回可见页。

绑定发生的时机只有两个：`ui.new_tab` 建出来的、`ui.set_active_tab` 明确指定的。
**传一次 `tab` 参数不算**（那只是"这一次操作这一页"，不代表"以后都在这页"）——
否则 agent 随手读一下别人的页面，就把自己的目标粘在那儿了。

`ui.list_tabs` 只在自己那条上带 `mine: true`（省 token，也避免"每条都标"的噪音）。

### 新标签页要不要顶掉人眼前的页面

`shouldShowNewTab`：显式 `show` 优先；否则**不顶**，三种例外：

- 人自己点的「+」（UI 层 `defaultShow`）；
- 当前没有可见标签页；
- 可见的还是**没被动过的启动页**（否则用户盯着百度首页看 agent 干活）。
  一旦发生过导航/动作/切标签页，这个"启动页特权"就一次性用掉。

站点 `window.open` / `target=_blank` 派生的标签页**跟着打开者走**：可见页里弹的
照旧显示（浏览器惯例），后台页里弹的留在后台 —— agent 流程里登录/预览/下载弹窗极多，
每弹一个抢一次视野等于人没法用电脑。

**自动跟随**（点链接开新标签）改的是**目标**不是**视野**：`opened_tab` 回执让 ws 层
把会话目标挪过去，人眼前的页面只有在 opener 就是可见页时才跟着切。

### 标签组：每个 agent 一块自己的地方（v2.3.0）

会话级目标解决了"动作落在哪一页"，但标签条上仍是一锅粥：人看不出哪些页是自己的、
哪些是哪个 agent 的；也没有任何东西**约束** agent 开页面的数量。归属模型补上这两块：

```
group = 'human' | 'agent:<sessionId>'
```

`shared/tab_group.cjs` 是唯一判据（纯函数，`tests/test_tab_group.js` 钉住）。

**自动工作区**。MCP/CLI 建连后立刻发 `ui.hello {label, auto_workspace}`（通知或请求都认）。
声明自己是 agent 的连接，**第一次要动页面而还没指定目标**时，浏览器给它开一页空白标签、
归进它自己的组，并在这次结果里附一次 `workspace` 提示：

```json
{"workspace": {"tab": 7, "group": "Claude", "created": true, "hint": "…"}}
```

这是"agent 永远不会默认开在人眼前那一页上"的地基。四条**不**触发，缺一不可：
① 没发 `ui.hello`（裸 WS：e2e / 脚本 / 调试保持老行为，否则所有回归会突然对着空白）；
② 方法本身在管标签页（`new_tab` / `list_tabs` / `window` …）；
③ 调用方显式点了 `tab`，或本连接已有绑定；④ `AI_BROWSER_AUTO_WORKSPACE=0`。
CLI 发 `auto_workspace:false` —— 人坐在终端前敲命令时，"不传 tab 就打当前页"才是他要的。

**上限**。每组默认 8 页（`AI_BROWSER_TAB_LIMIT`）。`ui.new_tab` 撞上限时**拒绝**，不回
"静默挤掉一页"：挤掉是破坏性的（agent 可能正在那一页跑流程），而拒绝是一次必须做的决定 ——
这正是上限存在的理由（后台运行时没人看得见它的标签页，不设限就会开到内存告急）。回执带
`data.reason='group-full'`、`limit`、以及可关闭清单 `data.tabs`。

MCP 层（`src/main/mcp_server.js` 的 tool handler）必须把这个执行期失败翻译成**工具结果**
形式（`isError: true` + `Error: <message>`），不能让它逃成 JSON-RPC error —— 否则 agent
收不到"请关掉一个"的提示，目录审核 / 客户端实际调用都把它当成 protocol failure 处理。

页面自己弹的窗口（`window.open` / `target=_blank`）**不能拒绝**（站点脚本在等它），
只能牺牲：本组里"最久没用、不在人眼前、没有挂着对话框"的那一页，并记进
`ui.list_tabs` 的 `evicted`（回采一次即清空）—— 不说的话 agent 会以为那页自己消失了。
没有候选就允许超限：宁可多一页，不吞正在用的页。

**看 ≠ 拥有**。人点开 agent 的页只是"看"（`activeTab` 变了，会话目标不变）；用户的标签页
也不因为有 agent 在跑而变得只读。要让用户接管（登录/扫码/支付），agent 用
`ui.set_active_tab {show:true}` 把页面顶到人眼前。

**标签栏**。人的页平铺；每个 agent 组折叠成一个 pill（组色 + 名字 + 页数，满额变暖色），
悬停展开、点击钉住；**正在看的那一组强制展开**，否则人切过去就找不到自己在看什么。
判据在 `renderer/tab_bar_layout.js`（纯函数，`tests/test_tab_bar_layout.js` 钉住）——
靠人肉悬停验证交互等于没验证。这里**不做**竖向下拉菜单：标签栏是固定高度的 BrowserView，
往下弹会被裁掉，要能弹就得每次悬停把标签栏长高、把页面下推，那正是本文件另一头
"渲染三宗罪"的来源。

回归：`npm run multiagent`（46 断言，M7–M9 覆盖自动工作区 / 上限 / 组间隔离）。

---

## 后台：窗口不显示时照样把活干完

用户的要求：*"跟无头浏览器一样无感知运行，并且随时可以点开，使用它，还不影响 agent
进行任何任务"*。这以前**做不到**，三处硬伤都在这一节里。

### 1. 隐藏必须是稳定状态

`_focusWindow` 的 `auto` 分支以前会"窗口被最小化/隐藏就 `showInactive` 回来"——
依据是当时的产品不变量"窗口必须真实可见"。多 agent 之后它反过来咬人：agent 每操作
一次，隐藏的窗口就自己爬出来一次。

现在可见性只由两件事决定：**人**（Dock 图标 → `app.on('activate')`）和**显式调用**
（`ui.window`）。`_focusWindow` 在 `auto` 下不碰窗口任何状态（`always` 保留旧行为）。

| 入口 | 作用 |
|---|---|
| `AI_BROWSER_START_HIDDEN=1` | 进程起来但不出窗口（无人值守的常态） |
| `ui.window {visible:true\|false, focus?}` | 读/改可见性。`focus` 不给就走 `showInactive`，不夺键盘焦点 |
| `ui.window {minimized:true\|false}` | 最小化/恢复（macOS 有动画，回执等 280ms 再读，否则报 false） |
| Dock 图标 / 二次启动 | `activate` 事件 → 显示窗口（人把浏览器叫回来的唯一约定入口） |
| `ui.server_info` | 回执里带 `window: {visible, minimized, focused}`，否则"到底是不是隐藏的"只能靠猜 |

### 2. 没有合成表面 = 截不到图（最隐蔽的一条）

没挂进窗口的 `BrowserView` **没有合成表面**：读树 / 点击 / 输入 / 导航全部正常
（走渲染进程和 CDP 输入），但 `ui.screenshot` 拿 **0 字节**、`ui.paint_check` 直接
`no-frame`。而截图正是 agent 判断"这一页到底画出什么"的唯一手段 —— 于是"后台标签页"
会变成一个看不见也拍不到的黑盒。

现在：**所有标签页都挂进窗口，用 z 序决定谁在上面**（`setTopBrowserView`，
不再 `removeBrowserView` 全部再 add 一个）。代价是每个标签页都占一份合成资源
（和 Chrome 的多标签一样），换来后台标签页可截图、可自检、可录制 canvas。

另外每个标签页**从出生起** `setBackgroundThrottling(false)`（以前只在 `setActive`
里设，于是"从没被显示过"的标签页永远带着节流：定时器拉长到 1s、rAF 停摆）。

### 3. 窗口不可见时不做白屏判定

`_schedulePaintAudit` 在窗口隐藏/最小化时直接返回：这时"屏幕上画出来没有"没有观测
意义，取帧要么空要么陈旧，而阶梯会据此 `reload` —— 后台无人值守时等于自己制造一场
重载风暴。人把窗口点开时（`ui.window visible:true`）反过来补一次自检（700ms 后），
兜住"agent 在后台把页面搞白了、人一打开正好看到"。

### 已知边界（写下来，免得被当 bug 修）

- **同一个标签页上的并发动作不协调**：两个 agent 同时往同一个输入框里打字，值校验会
  如实报 `input not verified`（append 语义 + 并发写本来就互相踩）。不同标签页之间
  完全并行，这一条有 `npm run multiagent` 钉住。
- **标签页都是有表面的**：开 50 个标签页的显存/合成开销和 Chrome 同量级，不是"免费"。
- 窗口隐藏时 `capturePage()` 仍会返回空（遮挡），截图走的是 CDP
  `captureScreenshot({fromSurface:true})` 那条路 —— 见「取帧两条铁律」。

回归：`npm run multiagent`（32 断言）、`npm run background`（37 断言），两个都在 `e2e:all` 里。

## 下载：显示还是存下来（"点证书下载卡在正在打开…"）

事故（2026-10-27）：用户点沧州教师继续教育网的「证书下载」，标签页停在一句
**「正在打开…」** 加一长串 png 地址上，永远不动。文件其实下载成功了，落在
`~/.ai-browser/downloads/<tab>/` 里 —— 界面上零回执，人只能判断成"卡住了"。

根因是两个独立的东西叠在一起：

1. 那个地址回的是 `Content-Type: image/png` + `Content-Disposition: attachment`。
   浏览器的语义是"这是文件，存下来"，而站点用**新标签**打开它 ——
   **导航永远不会提交**，标签页于是停在 `loading.html` 占位页上。
2. 整条下载路径只有落盘、没有界面表达（`will-download` 是被 agent 需求加上的，
   原本的设计里没有"人"）。

### 判据：能不能看，由 Content-Type 决定

`src/shared/media_doc.cjs`（纯函数）+ `src/main/media_inline.js`（接线）。

`session.webRequest.onHeadersReceived`（**只对 `resourceType === 'mainFrame'`**）：
主框架响应若满足 `可渲染的 Content-Type` **且** 声明了 `attachment`，就把
`Content-Disposition` 摘掉，让 Chromium 按内容类型正常显示。

- 可渲染白名单只有四类：`image/*`、`video/*`、`audio/*`、`application/pdf`。
  **刻意不含** `text/plain` / `application/json` / `text/csv` —— 它们技术上能内联，
  但"点导出"的语义就是"给我文件"，把 CSV 铺满一屏是帮倒忙。
- **不改 Content-Type**：站点把 png 说成 `application/octet-stream` 时，改类型去
  强行渲染，坏了就是一片碎图；那种情况让它下载才可靠。
- 其余一切（zip / dmg / exe / docx / xlsx…）保持浏览器的默认语义：下载。

> 为什么在 `onHeadersReceived` 而不是 `will-download` 里拦：`will-download` 触发的
> 时候下载**已经决定了**，只能整体取消再自己重取一遍（多一次往返，还要自己兜住
> Cookie / Referer / 临时签名）。而 Content-Disposition 正是在响应头之后才参与
> 下载判定的 —— 在这里摘掉，走的是浏览器原本的路径。

### 三个界面出口（缺一个都会回到"看起来卡住了"）

| 场景 | 行为 |
|---|---|
| 可显示的类型（图片/视频/PDF） | **直接显示**；工具条出现「↓」按钮，点一下就把当前页存进下载目录（`ui.download` 是同一个实现） |
| 不可显示的类型，且那个标签页是**为它而开**的 | 标签页换成**下载结果页** `renderer/download.html`：文件名 / 大小 / 类型 / 图片缩略图 / 进度条 /「打开」「在 Finder 中显示」「复制路径」 |
| 页面里点导出（页面不会被顶掉） | 页面保持不动；工具条出现 **「↓ 已下载 xxx」** 回执（8 秒），点一下在 Finder 中显示 |

判据是"这个标签页还停在占位页吗"（`mediaDoc.isPlaceholderUrl`）：停在占位页说明它
从没加载成功过，接管它没有任何代价；而页面里点"导出 CSV"时标签页上是真实页面，
**绝不能**动它。

### `dl:*` 通道的边界

下载结果页要「打开文件」「在 Finder 中显示」，但标签页的 `preload` 挂在**每个**
页面的 window 上（包括任意站点）。所以：

- `dl:record` / `dl:open` / `dl:reveal` 在 `main/index.js` 里校验 `sender.getURL()`
  是**我们自己的 renderer 页面**（`mediaDoc.isChromePageUrl`），站点页面调用一律返回
  `{found:false}`；
- 路径还必须落在下载目录之内（`insideDownloads`）—— 否则任意站点都能让浏览器
  "打开/高亮"用户下载过的文件。

回归：`npm run download`（23 断言，自带 fixture）：图片带 attachment 必须显示且不产生
下载记录、zip 必须下载且标签页变成结果页、就地下载不许顶掉页面、本来就 inline 的
图片照旧显示、`ui.download` 能把正在显示的图片存成文件。**负向验证做过**：
`AI_BROWSER_MEDIA_INLINE=0` 跑同一套件，D1 四条全红（`cert.png` 变成下载、导航不提交）。

## 错误日志（崩溃了要查得到）

**曾经的坑**：主进程一处错误处理都没有。任何未捕获异常都走 Electron 默认路径 ——
弹一个原生框（标题就是 `A JavaScript error occurred in the main process`），栈只活在
框里，点掉即永久丢失，进程随即退出。用户看到"弹了个框说 js 崩溃"，事后却**无法证明**
刚才发生过什么。事故的核心不是"日志不够细"，而是根本没有日志。

现在：`~/.ai-browser/logs/error.jsonl`，每行一条 JSON，**同步写**（`appendFileSync`）——
异步写等到 flush 时进程可能已经没了，而崩溃现场最需要的恰恰是最后一刻那几行。

记录的事件（`kind` 字段）：

| kind | 何时 |
|---|---|
| `boot` / `shutdown` | 进程边界。**没有 shutdown 行 = 上次是硬退**，这是"到底有没有崩过"最直接的判据 |
| `uncaught_exception` | 主进程未捕获异常（会触发窗口内红色横幅的那类） |
| `unhandled_rejection` | 没接住的 Promise（默认会让 Node 直接终止进程） |
| `render_process_gone` / `child_process_gone` | 网页渲染进程崩溃（"Aw, Snap!"）、Chromium 子进程崩溃（网络服务 / GPU） |
| `nav_fail` | 导航失败（界面已显示错误页），带 tab / url / error_code |
| `ws_error` | RPC 层异常（原本只回一句 JSON-RPC error，现场永久丢失） |
| `error_banner` | 窗口内红色横幅已显示（**非阻塞**，主进程照常处理 RPC） |
| `error_dialog` | 原生模态框已弹出（**主进程进入模态、WS 暂停响应**）—— 只在 `AI_BROWSER_ERROR_DIALOG=1` 时出现 |
| `error_dialog_fallback` | 想显示横幅但窗口还不存在（启动即崩），退回到原生框。诊断"应用静默不动"时先看这条 |

两条设计约束：

1. **日志本身绝不能再抛**。所有磁盘操作 try/catch 吞掉 —— 为记录崩溃而制造新崩溃，
   是最难查的那种 bug。写不下去时 `dropped_writes` 如实上报。
2. **条目自带最近的 WS 调用**（`recent_calls`，环形缓冲 40 条）。只有栈说不清
   "是哪个调用在什么 target 上触发的"。`text`/`html` 压成长度，`js` 保留前 200 字符。

读取：`ui.errors {limit, kind}`（MCP：`browse_errors`）返回本次进程的内存记录 +
落盘路径；跨进程历史直接读文件。单文件 2MB、保留 4 份滚动。

**提示方式：窗口内横幅，不是模态框。** 原生 `dialog.showMessageBox` 虽然返回 Promise，
macOS 底层仍是 `NSAlert` 模态循环，**会阻塞主进程**（实测对照：不弹框时 WS 4ms 返回，
弹框期间 8 秒无响应 —— 一个能自愈的 JS 异常被放大成"所有 RPC 超时"）。
现在改成窗口底部 34px 的红色横幅（独立的 `BrowserView`，页面视图用
`PageManager._bottomInset` 让出这条空间）：日志同步落盘 → 横幅显示异常消息 + 日志路径 →
主进程继续跑。横幅可点 × 关闭，连续异常只更新内容不叠加（角标显示次数）。
只有一种情况仍用原生框：**启动阶段就崩、连窗口都建不出来**，8 秒后记一条
`error_dialog_fallback` 再弹一次 —— 否则用户看到的是应用静默不动。

自检：`AI_BROWSER_SELFTEST=crash` 在窗口就绪后主动抛一个未捕获异常，用来验证
"日志 + 横幅"这条链路真的通 —— 否则它只能等真事故发生才能验证，而那时候恰恰最
不适合做实验。

## 浏览器级对话框（alert / confirm / beforeunload）

`alert()` / `confirm()` 不是页面 DOM：Chromium 交给 embedder，Electron 画成**原生
sheet**，因此它既不在语义树里，也不受页面点击控制；**而且对话框打开期间整个渲染器
被阻塞** —— `Runtime.evaluate` 不返回，任何动作都以"超时、主线程可能被阻塞"结束。
2026-10-24 用户在掘金删重复评论时撞上的就是这个：屏幕上有个"确定/取消"，agent 和
自动点击都够不到它。

处理责任在浏览器进程这一侧（`src/shared/dialog_policy.cjs` +
`PageManager._handleDialogOpening`）：主进程订阅 CDP `Page.javascriptDialogOpening`，
按策略用 `Page.handleJavaScriptDialog` 应答（该命令由浏览器进程执行，不需要渲染器，
所以对话框冻结页面时它照样有效）。

- 默认策略 `auto`：`alert` 确认；`confirm` **接受**（点它的那个动作就是意图，拒绝会
  让删除/提交永远失败）；`beforeunload` 放行（否则导航/关标签永久卡住）；`prompt`
  用页面默认值提交（Electron 实际不支持 `prompt()`，会抛 `prompt() is not supported.`）。
- 覆盖：`AI_BROWSER_DIALOG_POLICY=auto|accept|dismiss|manual`。`manual` 不自动应答，
  对话框保持打开，`ui.list_tabs` 的该 tab 上出现 `dialog:{type,message}`，由人点。
- 回执：动作期间被应答的对话框会写进 `browse_act` 结果的 `dialog:{type,message,accept,auto}`，
  否则 agent 不知道"点击中间弹过确认框、被替它按了确定"。
- 兜底：动作超时时还会主动探测一次（`PageManager.recoverBlockedTab`）—— 事件监听
  依赖 `Page.enable` 成功，漏掉时不能让那条 tab 永久卡死。
- Electron 侧的等价物是 `will-prevent-unload`（默认不处理会**静默**拦住导航），
  策略共用同一套。
- 回归：`e2e/dialog_ws.cjs`（`npm run dialog`）—— confirm / alert / beforeunload 三条
  路径，断言"不超时、回执有 dialog、处理完页面立即能评估"。

## 配置（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_BROWSER_PORT` | 9223 | WS / MCP 探测端口 |
| `AI_BROWSER_USER_DATA` | `~/.ai-browser` | 会话与 Cookie 持久化目录（错误日志在其下 `logs/`） |
| `AI_BROWSER_ERROR_BANNER` | 开 | `0` 关闭主进程异常的窗口内横幅（日志照记；e2e 截图对比用，它会改变窗口布局） |
| `AI_BROWSER_ERROR_DIALOG` | 关 | `1` 强制改用原生模态框（阻塞主进程 8 秒，只用于人工盯着看启动崩溃） |
| `AI_BROWSER_SELFTEST` | 关 | `crash` 在就绪后注入一次未捕获异常，用于自检错误链路 |
| `AI_BROWSER_UA` | Chrome 130 UA | 伪装 UA，去掉 Electron 指纹 |
| `AI_BROWSER_FOCUS` | `auto` | `auto`=只伪造页面内焦点态，不抢真实窗口焦点；`always`=旧行为；`never`=都不做。**不决定窗口是否显示** |
| `AI_BROWSER_WATCHDOG` | 开 | `0`/`off`/`false`/`no` 关闭网络看门狗 |
| `AI_BROWSER_WATCHDOG_URLS` | `example.com, baidu.com` | 看门狗探测目标（任一可达即算存活） |
| `AI_BROWSER_NETWORK_CAPTURE` | 开 | `0` 关闭默认抓包 |
| `AI_BROWSER_CANVAS_HOOK` | 开 | `0` 关闭 canvas 绘制记录注入 |
| `AI_BROWSER_DIALOG_POLICY` | `auto` | `alert/confirm/beforeunload` 的应答策略：`auto` / `accept` / `dismiss` / `manual`（不自动应答，交给人） |
| `AI_BROWSER_PAINT_AUDIT` | 开 | `0` 关闭"加载成功但屏幕纯白"的自检与自救（唯一用途：精确测量导航时延） |
| `AI_BROWSER_GPU` | `auto` | `on`/`off` 强制硬件或软件合成。`auto` = 默认硬件加速；连续两次 GPU 进程崩溃（2 分钟内）写 `~/.ai-browser/.gpu-off` 并自动重启到软件合成 |
| `AI_BROWSER_MEDIA_INLINE` | 开 | `0` 关闭"图片/音视频/PDF 即使带 `Content-Disposition: attachment` 也按内容类型显示"，回到"一律当下载"。用于二分"某站点的显示问题是不是这条钩子造成的" |
| `AI_BROWSER_START_HIDDEN` | 关 | `1` = 后台模式：进程起来但**不出窗口**（无人值守）。Dock 图标点击或 `ui.window{visible:true}` 随时把窗口叫回来；所有页面能力不受影响 |
| `AI_BROWSER_DOWNLOAD_DIR` | `<userData>/downloads` | 下载落盘根目录（每 tab 一个子目录） |

**窗口必须显示**（人可随时介入），但 agent 操作不得夺走键盘焦点 —— 这是产品不变量，
由 `e2e/focus_ws.cjs` 专门验证（含"不应发生"的阳性对照组）。

## 测试基线

- 单元：`npm test` —— Vitest，82 文件 / 1152 条，0 skip。
- 端到端：各 `npm run <suite>` 自起 Electron（隔离 profile）：
  `smoke` / `capabilities` / `richtext` / `network` / `value` / `canvas` / `modeldiff` /
  `audit` / `focus` / `interact` / `view` / `readcov` / `window_open` /
  `dialog` / `wrapper` / `paint` / `layout` / `download` / `multiagent` / `background` /
  `app_model`。
  **改动不得破坏任何一项。** 一次跑全部：`npm run e2e:all`（24 套件 / 805 断言）。
  另外两个**不进全量**：`npm run flicker`（要屏幕录制权限 + 窗口真的在屏幕上）、
  `npm run realsites`（依赖外网）。
  测试客户端（`tools/browser.cjs`）**不许永久等**：连接断开/回包超时都要把挂起的
  调用唤醒成一条错误。没有这一条，一次中途掉线会让套件挂到看门狗（150s）且没有任何线索
  —— 排查时唯一能看到的是"卡在某一步"，而真正的原因（连上了正在退出的实例）被吞掉了。
  新建套件必须同时加进 `e2e/run_all.cjs` 的 `SUITES` —— 加了但没进全量等于没加
  （`dialog`/`wrapper`/`paint`/`layout` 就这样在 v2.1.16–v2.1.19 期间从没被跑过）。
- **跑测试不许抢用户的电脑**（2026-10-28 修）：所有套件必须经 `e2e/_window_mode.cjs`
  的 `windowEnv(suite)` 取窗口策略 —— 默认 `AI_BROWSER_START_HIDDEN=1`，进程起来但
  **不出窗口**（读树/点击/输入/截图/导航全部照常，`background` 套件 37 条钉住）。
  只有 `focus` / `flicker` / `layout` / `paint` 四档可见，且走 `showInactive`
  （窗口出现但**不夺焦点**）—— 这四个套件测的正是"看得见/几何/白屏"，隐藏就没得测。
  以前 27 处 spawn 没一处设策略，`showInitialWindow` 里 `byAgent=false` →
  `show()` → 每跑一个套件就把窗口拍在用户脸上（跑一次全量 = 22 次）。
  `tests/test_e2e_window_mode.js` 的 WM-5 扫全目录，漏掉任何一个 spawn 都会红。
  想临时看窗口：`AI_BROWSER_E2E_VISIBLE=1 npm run <suite>`。
- `ui.wait` 的 `target` 先按元素 id 精确匹配、再退化为 label 子串匹配；
  新增动作或角色时必须同步核对执行器里真有对应 case（`audit` 套件逐条验）。
- 测量类断言必须先验前提：锁屏时前台恒为 `loginwindow`，会造成假绿/假红；
  不可测时打印 `SKIPPED`，不伪装成通过。

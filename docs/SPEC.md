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

### 活动标签页必须是一张不透明表面（2026-11-02 根因修复）

"每个标签页互相独立"这句话在渲染层**并不自动成立**：所有标签页的视图都常驻窗口、
叠在**同一块 bounds** 上（为什么不"不显示就不挂"见 `page_manager.js` 里 2026-10-28
那段 —— 没挂进窗口的视图没有合成表面，截图直接 0 字节），谁可见只由 `setTopBrowserView`
的 z 序决定。而 **z 序只决定"谁在上面"，不保证"上面那张不透"**。

实测现场（xiaofu.eduyun.cn 点登录"背景错乱"）：登录页 `auth.smartedu.cn/uias/login`
是按 iframe 浮层设计的，`html`/`body` 都是 `rgba(0,0,0,0)`；它被当成顶层文档打开时，
自己那张帧是 RGBA、**86.3% 的像素 alpha<255**，于是把 z 序里紧挨在它下面的那个
**百度标签页**（它自己的帧是 RGB，0% 透明）整个照了出来。也就是说漏进画面的不是
"这一页的旧画面"，而是**另一个标签页** —— 这正是"给某个网站打补丁"永远治不好它的原因。

修复只有一句：视图创建时 `setBackgroundColor('#FFFFFF')`，把真实浏览器的语义补回来
（顶层页面背景透明时显示画布白）。透明像素由这一张自己填白，下面那张永远不参与成像。

判据：`npm run paint` 的 **P6** —— 本地 fixture 一个根背景透明的页面，让它当活动标签页，
截帧里**不许有一个 alpha<255 的像素**（解 PNG 用 `e2e/_png_alpha.cjs`；抽掉那行底色，
P6 立刻报 `transparent:775504`）。单元侧 **PM-21** 钉"每个新建标签页都拿到不透明底色"。

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
判据是 `verdict` 八态：`ok / empty-legit / not-ready / collapsed / blank-with-text /
blank-with-dom / view-dead / no-frame`；`blank-*` 与 `view-dead` 算缺陷（要救），
`no-frame`（拿不到位图、但视图**还活着**，只是被遮挡/隐藏）明确**不**算 —— 把诊断失败
说成页面故障是最坏的一种谎。`view-dead` 与 `no-frame` 的分界就是"视图还在不在"，
见下面的「视图生命周期」。

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

### 截图取帧的两种档位（2026-11-02）

事故：agent 在百度 / dumate 的**后台**标签页上截图，各拿到一句
`captureScreenshot timeout after 20000ms — the page main thread is likely blocked`，
而屏幕上是一张正常画面。那句错误文案是**误诊** —— 对照实测四种组合：

| 组合 | `webContents.capturePage()` | CDP `Page.captureScreenshot` |
| --- | --- | --- |
| 屏幕上是这一页 + 空闲 | 20ms ✓ | 61ms ✓ |
| 被兄弟视图盖住 + 空闲 | 9ms ✓ | >12s ✗（页面没忙，照样不返回） |
| 屏幕上是这一页 + 主线程占死 | >20s ✗ | 等主线程松手才答（e2e S1 实测 13.4s） |
| 被兄弟视图盖住 + 主线程占死 | 18ms ✓ | >12s ✗ |

`Page.captureScreenshot` 带 `fromSurface:true` 只改变"像素从哪来"，**接单仍然在渲染进程
主线程**；它答不出两种情况：视图被同窗口另一张视图整个盖住（永远等不到帧）、屏幕上那一页
的主线程被脚本占死（要等松手）。`capturePage()` 拷的是那张视图自己的合成表面，被盖住时
十几毫秒就回，而且是**活帧**（每 300ms 换底色的页面，隔 1.5s 再取颜色跟着变）。

于是规则是：

1. **档位由「它是不是屏幕上那一张」决定**（`_isCoveredByOtherTab`：窗口可见 且 不是
   activeTab）：被盖住 → `surface` 优先、CDP 兜底；否则 CDP 优先、surface 兜底。
   问不到窗口可见性就维持 CDP 优先（无头/隐藏窗口路径行为不变，`e2e/background_ws` 钉着）。
2. **`clip` / `fullPage` / `webp` 只能由 CDP 应答**（要视口外的布局、文档坐标或额外编码器），
   见 `screenshot_opts.canUseSurface` —— 那一发就真的会继续等，这是语义要求不是缺陷。
3. **点名单一档不许偷偷换档**：`source=surface` 拿不到位图就如实报 `no-surface-frame`，
   `source=cdp` 等不到帧就报超时。换档等于给调用方一张他没要的图。回执带 `source` 字段。
4. **附属请求不许把已经到手的帧拖成挂住**：探密码框 / 读 dpr 的那次 `evaluate` 和
   `Page.getLayoutMetrics` 都要排主线程的队，所以两者都有短预算（1.5s / 3s，
   `AI_BROWSER_SURFACE_SHOT_MS`、`AI_BROWSER_SHOT_METRICS_MS` 可调），并且**放在截图之后**。
   探不到就如实标 `password_probe=skipped` + "这一帧可能含已输入的密码"，尺寸/dpr 改用
   几何算（视图边界 = CSS 尺寸，位图宽 / 视图宽 = dpr）。没探成 ≠ 没有密码框。

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
- **两条发起导航的路径都有三个出口**：`did-finish-load` / `did-fail-load` / 超时兜底。
  少后两个的话，一次失败（域名解析不了、连接超时、被我们的错误页接管）就让 state
  永久停在 `loading`，`pending_url` 跟着挂在一个永远不会 commit 的地址上（2026-11-02
  补的正是 `new_tab` 占位流程这个洞）。出口写回前先判"这一发还是不是我的导航"——
  被别的导航接管时那发会带 `-3 ERR_ABORTED` 失败，不许替后来者改状态。
- 加载窗口期地址栏显示的是**目标**地址（`pageManager.pendingNavUrl(tab)`），而
  `ui.list_tabs` 的 `url` 仍是已 commit 的旧页：Chromium 的 `getURL()` 只认已提交的，
  直接把 pending 覆盖上去会让 agent 把"正在请求"当成"已经到达"。目标另走一列
  `pending_url`，且只在 `state === 'loading'` 时出现。回归：`npm run nav` 的 NV-D3/D4
  （加载中目标另报一列）与 NV-D5a/b（新建标签页导航失败后必须放开 loading ——
  前置那条先证明"确实发出过导航并失败"，否则"没卡在 loading"可能只是空过）。
- 地址栏 `nav:go` 改走 `pageManager.navigate`。原先裸 `loadURL` 没有状态机、没有失败
  错误页、没有完成后重绘 —— 地址栏是最常用的一条路，缺这三样的代价就是"有时白屏"。

`render-process-gone` 也从"只打一行日志"改成**自己重载一次**（15 秒内只救一次）：
渲染进程崩溃后 Chromium 留一块白 surface，事件不再来，DOM 读不到，用户看到的是
永久白屏，而日志里只有一行。

`AI_BROWSER_PAINT_AUDIT=0` 可关闭自检（唯一用途：精确测量导航时延）。

### 视图生命周期（2026-10-30 白屏事故：22 次崩溃 + 标签栏消失 + 横幅挂死）

「视图对象还在」≠「它还能碰」。真 Electron 探针实测三事实：

1. **`webContents.close()` / `destroy()` 之后，BrowserView 对象还在，但 `view.webContents`
   变成 `undefined`** —— 裸写 `view.webContents.isDestroyed()` 当场抛
   `Cannot read properties of undefined (reading 'isDestroyed')`。
2. **渲染进程崩溃（`forcefullyCrashRenderer` / `render-process-gone`）后 webContents 还在、
   `isDestroyed()` 为 false，但内容不再渲染**、视图区域空白，`reload()` 能救。
3. **`BrowserWindow.capturePage()` 对含 BrowserView 的窗口返回 `empty`** —— 抓不到 view 的
   合成结果，所以"窗口层像素自检"在 Electron 内置 API 上走不通（Quartz 需录屏权限）。

这次事故的链条：某个视图 webContents 悬空 → `setInterval(pushNavState, 1500)` 每 1.5s 崩一次
→ `uncaughtException → reportFatal → showErrorBanner → layoutWithBanner` 又碰悬空视图二次崩溃
→ 进程半死（端口 listen 但 WS 握不上手）；`tabBarView` 无 `render-process-gone` 监听、无重建
→ 标签栏永久空白；横幅挂上只能人点 × 收起，底部深红条占掉 34px。约定：

- `src/shared/view_liveness.cjs` 的 `isAlive(view)` / `liveness(view)` 是**唯一判定口径**，
  覆盖四种失效形态（`null` / `.webContents` 悬空 / `isDestroyed` / getter 抛异常），**任何情况
  都不抛**。所有判定型裸访问收敛到它。⚠️ `.cjs` 共享模块一律**默认导入**：`tests/test_imports.js`
  只识别 ESM `export`，对 `module.exports` 做具名导入会被静态检查判红（运行时虽可用）。
- chrome 视图（标签栏、横幅）是**我们自己的**、可安全重建：`pushNavState` 推送前先
  `ensureTabBarAlive` 体检（死了就重建，节流 ≥1.5s、上限 8 次防 GPU 连崩死循环）；另挂
  `render-process-gone` 主动触发，不必等 1.5s 轮询。
- **页面 tab 的 webContents 悬空不盲目重建**（会丢导航历史/分组/登录态），只 `reload` 一次或
  如实上报 `paint_blank` —— 用户的页面不是重建试验场。阶梯仅 `reload → give-up`，有上限不循环。
- 主进程兜底 `reportFatal` 跑在 `uncaughtException` 里，**自己绝不能抛**（整段 try/catch）；
  横幅挂上后 `BANNER_AUTO_HIDE_MS`（默认 15s，可用 `AI_BROWSER_BANNER_AUTOHIDE_MS` 调）自动收敛，
  stack 永久保留在 `ui.errors`。

回归：`e2e/lifecycle_ws.cjs`（`AI_BROWSER_SELFTEST=chrome-gone` 主动置悬空）——断言无
`uncaught_exception`、有 `tabbar_rebuilt`（真重建，不是"恰好没崩"）、WS 仍可握、横幅自动收敛
（`error_banner_autohide`）。这些在 jsdom 里写不出来，只有真 Electron 能证伪"视图失效后主进程还活不活"。

## 几何脱节（内容缩成左上角一小块）

窗口约 1300×807，页面却只画进左上角约 325×260 的一块，其余全白、标签栏整条空白
（2026-10-25 用户截图）。DOM、`evaluate`、CDP 截图**全都正常** —— 只有窗口像素是错的。

成因：**窗口几何变了，合成器手里的 surface 还是旧尺寸**，于是它把那张大图缩进新的
bounds。`setBounds` 只改几何、不改 surface；`removeBrowserView + addBrowserView`
同样不保证重栅格化。真正的重栅格化只有 `webContents.invalidate()`（再叠一次 1px
微调，因为尺寸没变时 `setBounds` 会被直接忽略，不会重算 surface）。

三条可判定等式（`e2e/layout_ws.cjs`，`npm run layout`，25 断言；下面的"内容区"对**整号**
标签页成立，弹窗见下一节）：

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

### 弹窗请求的几何：写了尺寸才叫浮层（2026-11-02）

站点写 `window.open(url, name, 'width=420,height=520,left=120,top=80')` 请求的是**一个盖在
父页上的 420×520 浮层**（登录框、支付二维码、选择器都这么写）。本项目的模型里没有独立窗口
（`setWindowOpenHandler` 一律 deny → 自建 tab），而这条请求里的几何**以前被整份丢掉**：
handler 只解构了 `url`，页面侧垫片把第三参数接了却不用（形参名就叫 `_features`）。
于是每个 420×520 的登录框都长成整号标签页 —— 用户看到的"弹窗一片白 / 整屏换了一页"就是这么来的。
丢掉的不只是观感：弹窗页自己会读 `window.innerWidth` 排版（实测修复前 1280、修复后 420）。

判据在 `shared/popup_geometry.cjs`（纯函数，`tests/test_popup_geometry.js` 31 条钉住），照 Chrome，
不自创：

- 只有**显式请求尺寸**（`width`/`height`）或 `popup=yes|1` 才算弹窗。`noopener` / `noreferrer` /
  `_blank` 不是尺寸，Chrome 也照样开新标签页 —— 把它们当弹窗会把所有外链弹成小窗，那是另一种错。
  e2e `[GEO]` 因此把"没写尺寸仍铺满"的负对照放在**同一次运行**里跑：只测缩小的那个，
  "把所有弹窗都缩成小窗"这种过头修法照样能绿。
- 下限 100（Chrome 不允许弹窗小于此，站点写 `width=50` 多半是笔误），上限就是能给出的内容区；
  `left/top` 缺省时居中（Chrome 用级联偏移，我们只有一个窗口，居中更稳定也可复现）。
- 特性串现在一路送到主进程：垫片第 5 个参数 → 桥（arity 4→5）→ `ai:window_open` 的
  `payload.features`。`tests/test_bridge_surface.js` 的 B8 是**跨文件**用例 —— 真的把垫片源码
  跑起来、调 bridge.cjs 暴露的那个函数、再看落到 IPC 上的 payload。两岸各自单测都能绿，
  而少一个参数 / 键名写错 / features 没丢给主进程只有串起来才看得见（历史上就是这么静默的）。

**几何判据只有一个出口**：`_expectedBounds(tabId)`。布局（`_layoutAllViews` / `_layoutView`）、
`_auditLayout`、白屏自检的"该占多大"全都问这里。以前它们各抄一份"整号内容区"，于是弹窗一定
会被布局看门狗判成 `layout_mismatch` 并被"纠正"回整屏 —— **判据分叉才是这个 bug 修不掉的机制**，
所以补代码的地方不是加一处判据，而是把三处抄的合并成一处。方向也因此相反：整号页允许"至少铺满"
（宽度略大不算错，历史 bug 是缩成一小块），浮层必须**正好**那么大（变宽就是被人纠正回去了）。

窗口缩小浮层跟着夹（否则跑到窗口外，用户看到一个"打不开的弹窗"），放大**不**把它撑回去 ——
它请求的就是那个尺寸。`ui.list_tabs` 对浮层多带一个 `popup` 矩形：agent 按整屏去点/截图会打空，
不告诉它这一页占哪一块，等于让它对一个可见的东西反复失败。

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

**牺牲品的两条排除条件**（2026-11-03 补）。上面那句清单里再加两样：**这一页有没提交的
输入**、**这一页有进行中的下载**。理由不是"Chrome 有"，是我们淘汰的方式比它狠 —— Chrome
的 discard 之后表单还在、回来能填，我们一关是全没。判据在 `tab_group.pickEvictable`
（`t.dialog || t.draft || t.downloading` 三条都不进候选）。
草稿的账只记在主进程，不需要探 DOM：人能打字的只有置顶那一页（它本来就不进候选），而
agent 的打字全部经过 `executeAction` —— 所以账是全的。`type`/`setContent`/`paste` 记上，
`clear` 和**主框架** `did-navigate` 清掉；页内导航（pushState / hash）**不清**，SPA 发评论、
发私信走的正是后者，跟着清等于这条保护从来没生效过。下载只认 `progressing`，`interrupted`
不算保护 —— 否则一次失败的下载把那页永久钉住。
拒绝清单同样带上这两样（`data.tabs[].draft` / `.downloading`）：agent 自己挑页关掉时，
这是它唯一能用的信息。

**声音**。所有标签页挂在同一个窗口上，"谁在人眼前"是 z 序决定的，而**音频没有 z 序**：
agent 在后台开的视频页会一路响，人找不到那个喇叭去关它。所以除两种情况之外一律按住
（`webContents.setAudioMuted(true)`）：

```
① 人眼前那一页（activeTab）   ② 人的组（人开几页是他的事，Chrome 也只按住别人的后台）
其余 = agent 的后台页 → 从出生就按住；上限、组、会话都无关
```

判据在 `shared/tab_audio.cjs`（纯函数，`tests/test_tab_audio.js` 钉住），`AI_BROWSER_BG_MUTE=0`
整体关掉，`ui.list_tabs` 里被按住的页多带 `muted: true`（不带 = 没按住）。

按住的是**输出，不是播放**：Chromium 只改增益，`currentTime` 照旧前进。写成 pause 就把
"听不见"变成了"这一页没在播"，而后者是站点故障 —— agent 会照着它去判断页面坏了。这一条
由 M10 钉住：agent 的音频页出生即 muted → 顶到人眼前点开播放 → 回后台 → 断言仍然 muted
且 `currentTime` 仍在走（顺带钉住"静音 ≠ 暂停"和"手势真的进了那一页"）。

**受信输入的路由**。窗口从未显示过时，一份文档自报 `document.visibilityState:'visible'`
的**唯一条件**是它拿到过 CDP 的 `Emulation.setFocusEmulationEnabled` —— 产品平时只给
"人眼前那一页"（那就是 `AI_BROWSER_FOCUS=auto` 的本体）。其余页一律 hidden，而 Chromium
对 hidden 文档**丢弃**模拟输入：不报错、不排队、也不改投给别的标签页，事件就是没了。
旧形态最坏的地方不是丢，是丢完 `ui.act` 还回 `{success:true, clicked_via:'cdp-click'}`
—— 回执在说谎，agent 只能原地重试。

所以受信输入动作（`click`/`hover`/`drag`/`wheel`/`type`/`setContent`/`clear`/`press`/`paste`）
投递之前多一道闸：**问一句 → 收不到就把那一招补给这一页 → 再问一句 → 还不行就如实失败**。

```
量到 visible      → 直接投递（活动页走的还是这一条，一次往返都不多）
量到 hidden       → 补一发焦点伪造，再量一次；翻成 visible 就投递
补完还是 hidden    → 事件一发都不投，回 success:false + input_blocked:true + visibility
量不到（无 CDP 会话 / 探针超时 800ms）→ 放行：观测能力不足不许反过来让一个动作失败
```

补的那一招**不是新机制**，是产品每天都在用的 `_focusWebContents`，这里给到"要操作但收不到"
的那一页。它不动 z 序、不显示窗口、不改 `activeTab`、不改声音归属，也**不做恢复** —— 那一招
是粘的，来回开关会让每个动作都把页面推一遍 visible→hidden→visible，而站点正拿它决定要不要
暂停视频。`upload` 不在名单里（走 `DOM.setFileInputFiles`，JS 路径收得到），只读与控制类
动作也不问。

判据在 `shared/input_routing.cjs`（纯函数，`tests/test_input_routing.js` 钉），执行侧是
`page_manager._inputGate`（PM-51..59），真实 Chromium 上的正反两面各有套件：`npm run
multiagent` 的 **M11**（没顶到人眼前的一页点得动、键得进，而对照页与 `activeTab` 一动不动）、
`npm run input_routing`（关掉补救 / `AI_BROWSER_FOCUS=never` 时**如实失败**，页面也说没发生）。

同一次实测顺手证伪了两条一直被当成常识的推断，都写进了代码注释：
① 置顶（`setTopBrowserView`）、`webContents.focus()`、摘了重挂、`setBounds`、
`setBackgroundThrottling(false)`、`Page.setWebLifecycleState{active}` 全都**不能**让一份
hidden 文档收到输入（`Emulation.setPageVisibilityOverride` 在 Chromium 130 里根本不存在）；
② **"活动页一定 visible"是假的** —— `AI_BROWSER_FOCUS=never` 下活动页自己也是 hidden，
那种组合里 `ui.act` 的受信输入结构性地送不进去，只能失败，不能假装成功。因此这道闸对
**每一个**受信输入动作都要问一次（包括自己那一页），代价是一发 800ms 上限的 CDP 读。

**看 ≠ 拥有**。人点开 agent 的页只是"看"（`activeTab` 变了，会话目标不变）；用户的标签页
也不因为有 agent 在跑而变得只读。要让用户接管（登录/扫码/支付），agent 用
`ui.set_active_tab {show:true}` 把页面顶到人眼前。

**标签栏**。人的页平铺；每个 agent 组折叠成一个 pill（组色 + 名字 + 页数，满额变暖色），
悬停展开、点击钉住；**正在看的那一组强制展开**，否则人切过去就找不到自己在看什么。
判据在 `renderer/tab_bar_layout.js`（纯函数，`tests/test_tab_bar_layout.js` 钉住）——
靠人肉悬停验证交互等于没验证。这里**不做**竖向下拉菜单：标签栏是固定高度的 BrowserView，
往下弹会被裁掉，要能弹就得每次悬停把标签栏长高、把页面下推，那正是本文件另一头
"渲染三宗罪"的来源。

回归：`npm run multiagent`（80 断言，M7–M11 覆盖自动工作区 / 上限 / 组间隔离 / 弹窗挤位时
牺牲谁 / 声音只跟人眼前那一页 / 后台那一页也收得到受信输入）。

---

## 后台：窗口不显示时照样把活干完

用户的要求：*"跟无头浏览器一样无感知运行，并且随时可以点开，使用它，还不影响 agent
进行任何任务"*。这以前**做不到**，四处硬伤都在这一节里（第四条 2026-11-03 才量出来）。

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

没挂进窗口的 `BrowserView` **没有合成表面**：读树 / 导航全部正常（走渲染进程和 CDP），
但 `ui.screenshot` 拿 **0 字节**、`ui.paint_check` 直接
`no-frame`。而截图正是 agent 判断"这一页到底画出什么"的唯一手段 —— 于是"后台标签页"
会变成一个看不见也拍不到的黑盒。

⚠️ 这句话原先还包含"点击 / 输入也正常"，2026-11-03 逐杠杆实测**证伪**：挂进窗口只解决了
**表面**，而模拟输入丢不丢取决于那一份文档自报 `visibilityState` 是不是 `visible` ——
没拿到过页面焦点伪造的页一律 hidden，事件发出去就没了，回执却仍是 `success:true`。
现在这一条由"受信输入的路由"那道闸负责（见上面标签页那一节），和表面无关。

现在：**所有标签页都挂进窗口，用 z 序决定谁在上面**（`setTopBrowserView`，
不再 `removeBrowserView` 全部再 add 一个）。代价是每个标签页都占一份合成资源
（和 Chrome 的多标签一样），换来后台标签页可截图、可自检、可录制 canvas。

另外每个标签页**从出生起** `setBackgroundThrottling(false)`（以前只在 `setActive`
里设，于是"从没被显示过"的标签页永远带着节流：定时器拉长到 1s、rAF 停摆）。

对称的另一半在**窗口可见**时：被兄弟视图整个盖住的那一张，CDP 截图同样永远等不到帧
（不是 0 字节，是不返回），得走 `capturePage()` —— 判据与档位见上面「截图取帧的两种档位」。

### 3. 窗口不可见时不做白屏判定

`_schedulePaintAudit` 在窗口隐藏/最小化时直接返回：这时"屏幕上画出来没有"没有观测
意义，取帧要么空要么陈旧，而阶梯会据此 `reload` —— 后台无人值守时等于自己制造一场
重载风暴。人把窗口点开时（`ui.window visible:true`）反过来补一次自检（700ms 后），
兜住"agent 在后台把页面搞白了、人一打开正好看到"。

### 4. 隐藏窗口里，收不到输入的那一页会**吞掉事件**

第四条和"表面"无关，是同一节里最隐蔽的一条：**Chromium 会丢弃发往
`document.visibilityState = 'hidden'` 那份文档的 CDP 模拟输入**。窗口从未显示过时，一份文档
自报 visible 的唯一条件是它拿到过 `Emulation.setFocusEmulationEnabled`，而产品平时只给活动页 ——
于是"agent 在后台开的第二、第三页点不动"不是我们的实现坏了，是内核按规格办事。最坏的是旧形态
下事件没了还回 `success:true`。

那轮逐杠杆实测（结论记在 `shared/input_routing.cjs` 顶部）：置顶、
`webContents.focus()`、摘了重挂、`setBounds`、`setBackgroundThrottling(false)`、`invalidate`、
`Page.setWebLifecycleState{active}` 一律无效；`Emulation.setPageVisibilityOverride` 在
Chromium 130 里不存在；`window.showInactive()` 有效但窗口真的出来。能用的只有产品本来就在用的
那一招，所以修法是**把它给到要操作的那一页**，而不是发明新机制 —— 判据、补救与如实失败的完整
说明在上面的"受信输入的路由"。

顺带被证伪的还有"活动页一定 visible"：`AI_BROWSER_FOCUS=never` 下它自己也是 hidden。这一条
是那条 env 的**已知边界** —— 那种组合里窗口隐藏时模拟输入做不到，`ui.act` 一律如实失败，
而不是假装成功。

### 已知边界（写下来，免得被当 bug 修）

- **同一个标签页上的并发动作不协调**：两个 agent 同时往同一个输入框里打字，值校验会
  如实报 `input not verified`（append 语义 + 并发写本来就互相踩）。不同标签页之间
  完全并行，这一条有 `npm run multiagent` 钉住。
- **标签页都是有表面的**：开 50 个标签页的显存/合成开销和 Chrome 同量级，不是"免费"。
- 窗口隐藏时 `capturePage()` 仍会返回空（遮挡），截图走的是 CDP
  `captureScreenshot({fromSurface:true})` 那条路 —— 见「取帧两条铁律」。

回归：`npm run multiagent`（80 断言）、`npm run background`（37 断言），两个都在 `e2e:all` 里。

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

### 浏览器身份（UA / client hints）

身份的**唯一来源**是 `src/shared/browser_identity.cjs`：UA 字符串、UA-CH 元数据
（brands / platform / platformVersion / architecture）、Accept-Language 全部由
`buildIdentity()` 按**真实运行时**算出来。规矩只有一条 —— 任何两个字段不许互相打脸。

事故（2026-11-01）：UA 曾经写死成 macOS 的 `Chrome/130`，而 `navigator.platform`
是 Win32、`sec-ch-ua-platform` 是 Windows、WebGL 报 Windows 的 D3D11。风控看到的
不是"这是个 Mac 浏览器"，而是"这个浏览器的 UA 被改过"—— 藏指纹的操作自己成了
最响的指纹，表现为百度频繁弹滑块验证、Google 登录页报"此浏览器可能不安全"。

三层，各补各的，缺一不可：

| 层 | 走哪条 API | 覆盖什么 | 实测 |
|---|---|---|---|
| UA 字符串 + UA-CH 元数据 | CDP `Network.setUserAgentOverride`（带 `userAgentMetadata`） | `navigator.userAgent`、`navigator.userAgentData.*`、XHR/fetch 的 `sec-ch-ua*` | 生效（`override_applied_tabs`） |
| Accept-Language | 同一条 CDP 命令的 `acceptLanguage` | 请求头**和** `navigator.languages`（同一个字符串喂两处） | ⚠️ 不许带 `;q=0.9`：带了会产出 `zh;q=0.9` 这种假 BCP47 标签，且 header 叠成 `…;q=0.9;q=0.9`。首选列表只写 `zh-CN,zh`，q 值由内核补 |
| 文档导航的 critical hints | `session.webRequest.onBeforeSendHeaders`（只在缺失时补，只挂 https/wss） | 导航请求的 `sec-ch-ua` / `-mobile` / `-platform` | **必须**在这一层补：Electron 33 的导航请求根本不发这三个头，而同页 fetch 会发。CDP 覆盖、`Emulation.setUserAgentOverride`、先 `Network.enable` 三条路都试过都无效；同机 Chrome 156 无头访问同一 echo 服务三个头齐全 |

`ui.server_info` 的 `identity` 字段把这几层的结果原样报出来（含
`navigation_hints_bridge` / `navigation_hints_added`），"补没补上"是查询出来的，
不是猜的。

还没修的已知差距（不影响一致性，影响的是"像不像新 Chrome"）：内核版本仍落后
（130 vs 156，要靠升 Electron）、`window.chrome.loadTimes/csi` 仍为空、
读树时写进真实 DOM 的 `data-ai-id` 属性站点可见。

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_BROWSER_PORT` | 9223 | WS / MCP 探测端口 |
| `AI_BROWSER_USER_DATA` | `~/.ai-browser` | 会话与 Cookie 持久化目录（错误日志在其下 `logs/`） |
| `AI_BROWSER_ERROR_BANNER` | 开 | `0` 关闭主进程异常的窗口内横幅（日志照记；e2e 截图对比用，它会改变窗口布局） |
| `AI_BROWSER_ERROR_DIALOG` | 关 | `1` 强制改用原生模态框（阻塞主进程 8 秒，只用于人工盯着看启动崩溃） |
| `AI_BROWSER_SELFTEST` | 关 | `crash` 在就绪后注入一次未捕获异常，用于自检错误链路 |
| `AI_BROWSER_UA` | 按真实平台生成 | 覆盖 UA 字符串。UA-CH 的 `platform` 会**跟着 UA 里写的平台**走，不留矛盾；UA 里认不出的平台仍用真实平台 |
| `AI_BROWSER_FOCUS` | `auto` | `auto`=只伪造页面内焦点态，不抢真实窗口焦点；`always`=旧行为；`never`=窗口与页面焦点都不碰。**不决定窗口是否显示**。⚠️ `never` 的代价实测过（2026-11-03）：隐藏窗口里每一页都自报 hidden，`ui.act` 的受信输入会被 Chromium 整条丢弃 —— 那种组合下动作只能如实失败（见 `AI_BROWSER_INPUT_FOCUS` 那行的判据） |
| `AI_BROWSER_WATCHDOG` | 开 | `0`/`off`/`false`/`no` 关闭网络看门狗 |
| `AI_BROWSER_WATCHDOG_URLS` | `example.com, baidu.com` | 看门狗探测目标（任一可达即算存活） |
| `AI_BROWSER_NETWORK_CAPTURE` | 开 | `0` 关闭默认抓包 |
| `AI_BROWSER_CANVAS_HOOK` | **关** | 站点能一眼看见我们改过 `getContext`，所以默认不开。`on`/`1`/`all`=全站开；`a.com,b.chaoxing.com`=只在这些域（含子域）开；`0`/`off`=关。agent 临时需要就在 tab 上 `ui.canvas_configure{reload:true}` |
| `AI_BROWSER_POPUP_SHIM` | **关** | `window.open("")` 兼容垫片的开关，形状同上（`on` / 域名列表 / `0`）。它替换页面可见的原生 `window.open`，代价由全站付；老站模式在原生路径下回到"返回 null"。同时决定 preload 桥要不要暴露给这个域 |
| `AI_BROWSER_CLIENT_HINTS` | 开 | `0` 关闭"给文档导航补 `sec-ch-ua*`"的出口钩子。只用于二分定位（关掉后导航请求回到内核那套：没有这三个头） |
| `AI_BROWSER_DIALOG_POLICY` | `auto` | `alert/confirm/beforeunload` 的应答策略：`auto` / `accept` / `dismiss` / `manual`（不自动应答，交给人） |
| `AI_BROWSER_PAINT_AUDIT` | 开 | `0` 关闭"加载成功但屏幕纯白"的自检与自救（唯一用途：精确测量导航时延） |
| `AI_BROWSER_HOT_REPAINT` | **关** | `hard` 把"导航完成 / 切标签页 / 窗口回到前台"三条热路径的重绘升级为 1px 微调（唯一能强制合成表面重新栅格化的手段）。用它的情形：**切回一页或导航后屏幕上是上一页的像素**（透明背景的登录浮层透出旧页面）。代价：1px 微调必然触发两次重排，就是用户报过的"一闪一闪、大一下小一下"——所以默认关，`e2e/layout_ws` 的 G4/G5 把默认档钉成不变量 |
| `AI_BROWSER_GPU` | `auto` | `on`/`off` 强制硬件或软件合成。`auto` = 默认硬件加速；连续两次 GPU 进程崩溃（2 分钟内）写 `~/.ai-browser/.gpu-off` 并自动重启到软件合成 |
| `AI_BROWSER_MEDIA_INLINE` | 开 | `0` 关闭"图片/音视频/PDF 即使带 `Content-Disposition: attachment` 也按内容类型显示"，回到"一律当下载"。用于二分"某站点的显示问题是不是这条钩子造成的" |
| `AI_BROWSER_START_HIDDEN` | 关 | `1` = 后台模式：进程起来但**不出窗口**（无人值守）。Dock 图标点击或 `ui.window{visible:true}` 随时把窗口叫回来；所有页面能力不受影响 |
| `AI_BROWSER_DOWNLOAD_DIR` | `<userData>/downloads` | 下载落盘根目录（每 tab 一个子目录） |
| `AI_BROWSER_TAB_LIMIT` | 8 | 每个 agent 组的标签页上限（人的组不限）。`ui.new_tab` 超了**拒绝**并给可关清单；页面自己弹窗超了则牺牲一页，没有可牺牲的就允许超限 |
| `AI_BROWSER_BG_MUTE` | 开 | `0`/`off` 关掉"agent 的后台页不出声"。开着时除"人眼前那一页"和"人的组"一律 `setAudioMuted(true)` —— 按住的是**输出增益**，不是播放，`currentTime` 照旧前进，所以这条规则不会把 agent 眼里的页面变成"卡住" |
| `AI_BROWSER_INPUT_FOCUS` | 开 | `0`/`off` 只关掉"给收不到输入的那一页补一发焦点伪造"，**不**关掉"别说谎"：量到 hidden 而没补救时照样回 `success:false` + `input_blocked:true`，而不是旧的 `success:true`。留着它的唯一用途是二分定位（怀疑焦点伪造本身把某一站点的前后台逻辑带偏时）。判据、实测过的杠杆清单与失败形状见"受信输入的路由"一节 |

**窗口必须显示**（人可随时介入），但 agent 操作不得夺走键盘焦点 —— 这是产品不变量，
由 `e2e/focus_ws.cjs` 专门验证（含"不应发生"的阳性对照组）。

## 测试基线

> 数字**每次发版后按实测更新**（`npm test` / `npm run e2e:all` 的最终摘要）。
> 2026-11-01 v2.5.1 基线：单测 **100 文件 / 1324 条**、e2e **27 套件 / 831 断言**。
> 下面的清单是 29 项（v2.5.1 之后进了 `shot` 与 `input_routing`），那两个数字还没重测 —— 发版时按实测覆盖。

- 单元：`npm test` —— Vitest，100 文件 / 1324 条，0 skip。
- 端到端：各 `npm run <suite>` 自起 Electron（隔离 profile）：
  `smoke` / `capabilities` / `richtext` / `network` / `value` / `canvas` / `modeldiff` /
  `audit` / `nav` / `focus` / `interact` / `upload` / `view` / `readcov` / `window_open` /
  `dialog` / `wrapper` / `paint` / `layout` / `shot` / `download` / `multiagent` / `background` /
  `input_routing` / `icon` / `app_model` / `security` / `contract` / `lifecycle`。
  **改动不得破坏任何一项。** 一次跑全部：`npm run e2e:all`（27 套件 / 831 断言）。
  - `security`：页面 → 控制面、页面 → 宿主 两条攻击链的回归。它会起**两个**实例
    （第二个带 `AI_BROWSER_WS_ALLOW_ORIGIN=1` 做阳性对照），断言"拦住"而不是"服务没起来"。
  - `input_routing`：收不到输入时**不许说成功**。同样起**两个**实例，因为要测的两种配置
    （`AI_BROWSER_INPUT_FOCUS=0` / `AI_BROWSER_FOCUS=never`）都是 spawn 时定的 env。
    端口走自己的 `AI_BROWSER_INPUT_ROUTING_PORT`，不占 `AI_BROWSER_PORT` 那个连续段。
  - `contract`：声明 = 实现（`subset` / `focused_only` / `mode` / `wait` condition / `id:null`）。
  另外两个**不进全量**：`npm run flicker`（要屏幕录制权限 + 窗口真的在屏幕上）、
  `npm run realsites`（依赖外网）。
  `e2e/zhihu_full.cjs` 是**手工脚本**（附着已运行的 9223 实例 + 需登录态），
  不属于套件、也没有 npm script —— 别把它当"漏进全量的套件"。
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

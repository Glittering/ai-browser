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
因此：重绘钩子挂在 `dom-ready` / `did-finish-load` / `did-navigate` /
`did-navigate-in-page` / `did-frame-finish-load`（120ms 去抖合并），并在窗口
`show` / `restore` / `focus` 时重绘当前标签；`ui.repaint` 供 agent 显式兜底，
回执带累计 `repaint_count` —— 这是"重绘真的发生了"的唯一可证伪判据。

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

**窗口必须显示**（人可随时介入），但 agent 操作不得夺走键盘焦点 —— 这是产品不变量，
由 `e2e/focus_ws.cjs` 专门验证（含"不应发生"的阳性对照组）。

## 测试基线

- 单元：`npm test` —— Vitest，27 文件 / 404 条，0 skip。
- 端到端：各 `npm run <suite>` 自起 Electron（隔离 profile）：
  `smoke` / `capabilities` / `richtext` / `network` / `value` / `canvas` / `modeldiff` /
  `audit` / `focus` / `interact` / `view`。**改动不得破坏任何一项。**
- `ui.wait` 的 `target` 先按元素 id 精确匹配、再退化为 label 子串匹配；
  新增动作或角色时必须同步核对执行器里真有对应 case（`audit` 套件逐条验）。
- 测量类断言必须先验前提：锁屏时前台恒为 `loginwindow`，会造成假绿/假红；
  不可测时打印 `SKIPPED`，不伪装成通过。

# AI Browser 中文入口

> 这是给中文读者的 3 分钟速读版。完整版在 [README.md](README.md)。

## 一句话

一个**正常可见、常驻登录**的 Electron 浏览器，但驾驶员是 AI Agent。

Agent 拿到的不是截图，而是**语义树**（每个元素的角色、标签、值、状态、可执行动作，外加一个稳定 ID）；点击输入走 CDP 受信事件，和你亲手敲键盘是一个级别；遇到扫码、滑块、支付，你随时把鼠标抢回来——不用设计任何交接接口。

## 30 秒装好

```bash
npx -y @glittering0717/ai-browser mcp
```

然后把 MCP server 注册进你的客户端（Claude Code / Cursor / Codex 同理）：

```json
{ "mcpServers": { "ai-browser": {
  "command": "npx",
  "args": ["-y", "@glittering0717/ai-browser", "mcp"]
} } }
```

国内网络下载 Electron 慢的话，加镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

macOS 用户也可以直接用打包好的 `.dmg`（Release 里），不用装 Node.js——但 MCP 的 npx 桥接依然需要，它负责把服务器注册进客户端。

## 5 分钟跑第一个任务

把这段话发给你的 Agent：

> 打开 excalidraw.com，选文本工具，在画布上写句话，然后把你写的字读回来。

它会：

1. `browse_navigate` 打开页面
2. `browse_act` 按键选工具、落点、打字
3. `browse_canvas` 把画布内容读回来——**不是截图，不是 OCR**

你会看到它拿回的是这样的结构化数据：

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

这个场景之所以值得看：**纯 Canvas 应用里没有任何 DOM 节点**，所以基于 DOM / accessibility tree 的方案在这里是全瞎的；而截图方案要烧视觉 token，还不知道坐标和字体。打开 `AI_BROWSER_CANVAS_HOOK=1` 后，AI Browser 直接在 2D 绘制调用层把 `fillText` 的字符串截获下来。

> canvas 捕获默认关闭，用环境变量 `AI_BROWSER_CANVAS_HOOK=1` 启动才会装上——这是取舍，不是遗漏。
> 更准的用法是按域开（`AI_BROWSER_CANVAS_HOOK=b.chaoxing.com,excalidraw.com`）或在需要的那一页
> 现场装：`browse_canvas {operation:"configure", reload:true}`。包一层 `getContext` 是站点
> 一次 `toString` 就能看见的痕迹，不能让全站替几页白板买单。

## 17 个 MCP 工具（常用的就这几个）

| 工具 | 干什么 |
|---|---|
| `browse_navigate` | 打开页面 |
| `browse_get_tree` | 把页面读成语义树（含弹窗、必填提示、成功消息、登录态） |
| `browse_act` | 点击 / 打字 / 清空 / 拖拽 / 粘贴 / 上传 / 按键（`type` 到 textbox 或弥合到当前焦点） |
| `browse_diff` | **验证操作到底有没有生效**，返回显式 changed/unchanged |
| `browse_wait` | 等某个条件成立（按钮可用、弹窗出现、网络空闲…） |
| `browse_canvas` | 读 canvas：文字、区域、绘制调用（需上面那个开关） |
| `browse_auth_state` | 这个标签页还登录着吗？是不是被踢到登录页了 |
| `browse_network` | 像 Chrome Network 面板一样查请求（含响应体、敏感头自动脱敏） |

还有 WebSocket JSON-RPC 原生接口（`ws://localhost:9223`，方法 `ui.*`），不想走 MCP 也可以用。
握手带 `Origin` 的连接会被拒（浏览器必发、脚本不发），所以网页驱动不了它。

> **沙箱默认关闭，是有意的。** 受限 shell（IDE 终端、部分 CI）里 Chromium 的 OS 沙箱起不来，
> 报 `sandbox initialization failed: Operation not permitted` 后**在我们的代码跑起来之前**就退出 ——
> 于是你只会看到一个静默的启动失败，没有任何错误可看。`AI_BROWSER_SANDBOX=1` 可以打开它；
> **如果打开后启动即退、一点输出都没有，就是这个原因，去掉这个变量即可**。
> 页面与 Node 之间无论如何都是隔开的（`contextIsolation:true` + `nodeIntegration:false`），
> 这个开关管的是它们下面那层 OS 沙箱。

## 为什么不用截图

| | 截图 + 视觉模型 | AI Browser |
|---|---|---|
| 上下文成本 | 每一步一张图，视觉 token 是文本的几十倍 | 纯文本树 |
| 页面一动 | 坐标全废 | 语义节点有稳定 ID |
| 富文本编辑器 | 光标都进不去 | Draft.js / ProseMirror / Quill / CKEditor 同一条 CDP 通道，无特判 |
| Canvas 内容 | OCR 猜 | 绘制层直接取字符串 |
| 时效性 | toast 一闪就没了 | 消息、弹窗、验证状态都在树的 context 里 |
| 登录态 | 每次临时实例 | 常驻会话，扫一次码长期有效 |

## 几个 Agent 同时用同一个浏览器

每条 WS 连接（每个 MCP 进程）有**自己的工作标签页**。调用省略 `tab` 时，目标按
`点名的 > 你自己的 > 人正在看的 > 第一个` 解析，于是：

- `browse_tabs {"op":"new"}` 开新页**不顶掉用户正在看的那一页**（要让人看就 `show:true`）。
  唯一例外：人眼前还是没被动过的启动页——否则用户会盯着百度首页看 agent 干活。
- `browse_tabs {"op":"list"}` 在你自己那条上标 `mine: true`。
- 你的页被**别人**关掉，下一次调用明确报错（`-32001`），不会静默落到别人的页面上；
  自己关自己的页则照浏览器惯例落回可见页。
- 点链接弹出的新页只把**目标**挪过去；只有打开者本身是可见页时，才会挪**视野**。

不同标签页之间完全并行。两个 agent 往同一个输入框里同时打字不做协调——值校验会如实报
`input not verified`，而不是假装都写进去了。

## 标签组：每个 agent 一块自己的地方

目标按连接分了，但标签条上原本是一锅粥——看不出哪页是谁的，也没东西拦住 agent 开二十个页。
现在按**归属**管：

```
group = 'human' | 'agent:<会话>'
```

agent 建连后自报家门（MCP 和 CLI 都会发 `ui.hello`）。此后它**第一次**要动页面、又还没有目标时，
浏览器会开一页空白标签归到它自己的组里，并在结果里附一次提示：

```json
{"workspace": {"tab": 7, "group": "Claude", "created": true, "hint": "..."}}
```

于是 agent **永远不会**默认开在你正在看的那一页上。想看你的页面也便宜：`browse_tabs
{"op":"list"}` 里 `group: "human"` 的那条，显式传 `tab` —— 读一下不会把它抢走。

标签条上，你的标签页照旧平铺；每个 agent 组折叠成一个 pill（组色 + 名字 + 页数），悬停展开、
点击钉住，正在看的那一组强制展开。**点开组里的页只是"你看"，不改 agent 的目标。**

每个组有上限（默认 8，`AI_BROWSER_TAB_LIMIT` 可调）。超了是**拒绝**，不是"悄悄挤掉一页"，
并且告诉你关哪个：

```
-32001 your tab group is full (8/8) — close one before opening another
data: { reason: "group-full", limit: 8, tabs: [{tab, url}, ...] }
```

过 MCP 这一层，它会以**工具结果** `isError: true` + `Error: your tab group is full (8/8) — close one before opening another`
回到 agent —— 是 agent 该照着处理的正常工具失败，不是 JSON-RPC protocol error。上面的 `data` 是裸 WS 的细节。

只有一种例外：页面自己弹的窗口（`window.open` / `target=_blank`）没法拒绝（站点脚本在等它），
这时会关掉本组里"最久没用、不在人眼前、没有挂着对话框"的那一页，并在 `list` 的 `evicted`
里告诉你。

## 后台运行（跟无头一样无感知）

```bash
AI_BROWSER_START_HIDDEN=1 npx -y @glittering0717/ai-browser   # 起来但不出窗口
```

窗口隐藏/最小化时，读树、点击、输入、滚动、上传、下载、应答对话框、抓包、截图、白屏自检
**全部照旧**（`npm run background` 用 37 条断言钉住）。点 Dock 图标（或 `browse_tabs
{"op":"window","visible":true}`）随时把窗口叫回来，显示的是**你**上次在看的那一页，
agent 的任务一点不受影响。

之所以能做到，是因为三处硬伤都修了：动作不再把隐藏的窗口自己弹回来；每个标签页都挂着
合成表面（所以后台也能截图，不再是黑盒）；窗口不可见时不做白屏判定（否则会自己制造
重载风暴）。代价是每个标签页都占一份合成资源——和 Chrome 的多标签一个量级。

## 诚实边界（请先看这里）

- **macOS / Linux 已测，Windows 未测**（不是不支持，是没测过，不想让你以为我们测了）
- 首次启动要准备 ~110MB Electron 引擎
- WebSocket 控制端口只绑 `127.0.0.1`，**且没有鉴权**——不要转发这个端口，不要在不可信网络里暴露
- canvas 捕获默认关闭（见上）
- 它不是无头浏览器：**页面真的会渲染**（这正是后台也能截图的原因），只是窗口可以不显示；
  "随时能看一眼"是被保留的特性，不是缺陷
- **需要人时（登录/扫码/滑块/支付）没有"交接工具"**：agent 在自己这一轮回复里说一句、停下等回话
  就够了。没有 `chat` 工具、也没有"一次性会话"，浏览器侧零改动——窗口一直开着，人随时能抢鼠标
- **MCP 不会"用完自动关闭"**：首次调用会自动拉起 Electron，关闭只由 `browse_quit` 触发。
  你不关它就一直在（登录态长期保留）。人正在窗口里操作时**不要**调 `browse_quit`，会把做到一半的
  一起带走

## 出问题了？

最想要的输入不是 star，是**日志**。

跑不通的时候，别急着关掉——把 `browse_errors` 的输出或贴到 [GitHub Discussions](https://github.com/Glittering/ai-browser/discussions)，那才是让这个项目变好的地方。

### 站点弹滑块验证 / "此浏览器可能不安全"

风控不检测"自动化"这个概念，它检测的是**一个浏览器自己的字段互相打脸**。
我们踩过（2026-11-01 与同机 Chrome 156 对照实测）：UA 写死 `Macintosh … Chrome/130`，
而 `navigator.platform=Win32`、`sec-ch-ua-platform="Windows"`、WebGL 报 Windows 的
D3D11 显卡。这个组合读起来的不是"这是个 Mac 浏览器"，而是"这个浏览器被人改过"——
于是百度几乎每次搜索都弹滑块、Google 直接给异常页。

现在身份由**一个函数**按**真实运行时**算（`src/shared/browser_identity.cjs`），分三层交付：
UA + UA-CH 元数据走 CDP；Accept-Language 只给干净的首选列表（不能带 `;q=0.9`，那个值会
一并进 `navigator.languages`）；文档导航请求的 `sec-ch-ua*` 由请求出口补——Electron 内核
在导航请求上**根本不发**这三个头（页面里的 `fetch` 却发），试过 CDP 覆盖、
`Emulation.setUserAgentOverride`、先 `Network.enable` 三条路都不行。

别猜，直接问：

```bash
node bin/ai-browser.cjs call ui.server_info
# → identity: {user_agent, chrome_version, platform, platform_version, brands[],
#              navigation_hints_bridge, override_applied_tabs[]}
```

还没消掉的真实差距：

- **内核落后 26 个大版本**（`Chrome/130` vs 现在的 `Chrome/156`）。自洽，但本身就是
  "浏览器太旧"的信号；唯一的解法是升 Electron，那是发版级动作，不是补丁。
- **`window.chrome.loadTimes` / `.csi` 仍为空**（老 Chrome 的遥测桩），权重低，还没补。
- **读树时会往真实 DOM 写 `data-ai-id`**（百度首页实测 70 个）。它是 CDP 选择器路径的
  承重墙，拆它是一次重构而不是一个开关——站点脚本看得见它，这是目前最响的痕迹。
- **canvas 记录与 `window.open` 垫片会改页面可见的原生方法**：两者现在都**默认关**
  （`AI_BROWSER_CANVAS_HOOK` / `AI_BROWSER_POPUP_SHIM`，支持 `on` / 域名列表），
  `__ai_browser__` 也不再暴露给站点页面。

### 屏幕上还是上一页的画面 / 地址栏闪回

两件事，一类症状。

**画面**：`BrowserView` 的合成表面只在有人逼它时才重新栅格化，所以窗口在 `show` /
`restore` / `focus` 时会补一次重绘（这个窗口设计上不抢焦点，常常在你编辑器后面待几分钟）。
默认那一档是 **soft**（`webContents.invalidate()`），不改几何、不会跳。它故意不更狠：
唯一能重建"像素本身就是错的"那张表面的是 1px 尺寸微调，而它必然触发两次重排——
把这条放在高频路径上的结果就是用户报过的"一闪一闪、大一下小一下"，现在由
`e2e/layout_ws` 的 G4/G5 钉住（导航与切标签页默认一次重绘都不挂）。
真的看到**上一页的像素**（透明背景登录浮层透出旧站点），就设 `AI_BROWSER_HOT_REPAINT=hard`，
代价是跳。别去关 bfcache：bfcache 存的是你**离开**的那一页，解释不了前进导航后的旧画面，
关掉它只会让前进/后退重新跑一遍页面 JS。

**地址栏**：敲回车到新文档 commit 之间那几百毫秒，`webContents.getURL()` 返回的还是**上一页**，
所以栏会闪回。现在加载中显示请求中的地址；`ui.list_tabs` 把同一件事放在
**`pending_url`** 字段而不是 `url`——写进 `url` 会让 agent 以为已经到达，转头去读上一页的 DOM。

仓库：https://github.com/Glittering/ai-browser · MIT

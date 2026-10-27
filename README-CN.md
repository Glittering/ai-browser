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

## 出问题了？

最想要的输入不是 star，是**日志**。

跑不通的时候，别急着关掉——把 `browse_errors` 的输出或贴到 [GitHub Discussions](https://github.com/Glittering/ai-browser/discussions)，那才是让这个项目变好的地方。

仓库：https://github.com/Glittering/ai-browser · MIT

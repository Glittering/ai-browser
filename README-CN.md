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

## 20 个 MCP 工具（常用的就这几个）

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

## 诚实边界（请先看这里）

- **macOS / Linux 已测，Windows 未测**（不是不支持，是没测过，不想让你以为我们测了）
- 首次启动要准备 ~110MB Electron 引擎
- WebSocket 控制端口只绑 `127.0.0.1`，**且没有鉴权**——不要转发这个端口，不要在不可信网络里暴露
- canvas 捕获默认关闭（见上）
- 它不是无头浏览器：窗口真的会打开、真的会渲染，"看得见"是被保留的特性，不是缺陷

## 出问题了？

最想要的输入不是 star，是**日志**。

跑不通的时候，别急着关掉——把 `browse_errors` 的输出或贴到 [GitHub Discussions](https://github.com/Glittering/ai-browser/discussions)，那才是让这个项目变好的地方。

仓库：https://github.com/Glittering/ai-browser · MIT

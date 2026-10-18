# CSDN 正稿（SEO 长尾向 · 可直接发）

> 分类：人工智能 · 文章标签：人工智能 / MCP / Agent / Electron / 自动化
> 创作声明：**如实勾选「部分内容由 AI 辅助生成」**
> 目标字数：1800–2200（CSDN 是搜索流量，可以比掘金长，但必须有目录和小标题）

---

**标题：**
`不截图、不 OCR、不猜坐标：基于 Electron + CDP 的 MCP 浏览器自动化方案与完整实战`

---

## 一、先说问题：截图这条路到底错在哪

让 AI 去操作网页，现在最主流的方式是：

> 截图 → 视觉模型读图 → 猜坐标 → 点击

这条路的问题不是"准确率不够高"，而是**抽象层选错了**：

| 维度 | 问题 |
|---|---|
| 成本 | 每步一张图进上下文。10 步任务 = 10 张图，视觉 token 是纯文本的几十倍 |
| 稳定性 | 坐标绑在像素上。滚动 100px、弹个 toast、响应式切一档，坐标全废 |
| 时效性 | toast 提示"发布成功"一秒消失，截图根本来不及 |
| 富文本编辑器 | 光标都进不去，更别说排版加粗 |
| Canvas | DOM 层是空的，截图只能靠 OCR 猜 |

一句话：**把"读结构化页面"降级成了"图像识别"。**

## 二、三条技术路线的对比

| | 截图 + 视觉模型 | Playwright / chrome-devtools-mcp | 语义树（AI Browser） |
|---|---|---|---|
| 感知方式 | 像素 | DOM / accessibility tree | 语义树（role/label/value/states/actions + 稳定 ID） |
| 登录态 | 临时实例，每次重登 | 临时实例，每次重登 | 常驻窗口，持久会话 |
| 富文本编辑器 | 不可行 | 视站点而定 | CDP 受信输入，无特判 |
| Canvas | OCR 猜 | 读不到 | 绘制层直接取字符串 |
| 上下文成本 | 高 | 中 | 低（纯文本） |
| 人机验证 | 完全卡死 | 完全卡死 | 人随时接管鼠标 |
| 是否可见 | 无头或独立实例 | 无头或独立实例 | 桌面上真实可见窗口 |

## 三、AI Browser 是什么

一个 **Electron 浏览器**，但驾驶员是 AI Agent：

- 窗口正常可见、常驻、登录态持久
- 两套等价接口：**MCP stdio**（20 个 `browse_*` 工具）和 **WebSocket JSON-RPC**（`ws://localhost:9223`，方法 `ui.*`）
- 页面返回为语义树，输入走 CDP 受信事件
- 遇到扫码、滑块、支付，人随时可以接管鼠标——**没有交接 API，也没有权限弹窗**

## 四、安装

**方式一：npx（推荐，也是 MCP 桥接所必需）**

```bash
npx -y @glittering0717/ai-browser mcp
```

首次启动会准备 Electron 引擎（约 110MB，解压后约 245MB）。国内网络慢可加镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx -y @glittering0717/ai-browser mcp
```

**方式二：macOS 打包版**
Release 里的 `.dmg`，无需 Node.js。但如果要用 MCP，仍需 npx 桥接（它会复用已运行的实例，不会重复下载 Electron）。

**方式三：源码**

```bash
git clone https://github.com/Glittering/ai-browser.git
cd ai-browser && npm install
```

要求：Node.js ≥ 18，桌面会话（macOS / Linux）。Windows 未测试。

## 五、接入客户端

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "npx",
      "args": ["-y", "@glittering0717/ai-browser", "mcp"]
    }
  }
}
```

或者直接告诉你的 Agent：

> You may use AI Browser (20 browse_* MCP tools). It auto-launches a visible Electron browser; call browse_quit when done.

## 六、实战示例

**示例 1：把页面读成语义树**

```
browse_navigate { "url": "https://example.com/feed" }
browse_get_tree { "ax": true }
```

返回：

```json
{
  "role": "textbox",
  "label": "请输入文章标题（5～100 个字）",
  "value": "AI Browser 测试标题",
  "states": ["visible", "focused"],
  "actions": ["type", "clear", "focus"]
}
```

外加 context：当前弹窗、必填提示、成功消息、登录态。

**示例 2：富文本编辑器里打字**
`browse_act` 的 `type` / `setContent` 走 CDP 的 `Input.dispatchKeyEvent`，Draft.js、ProseMirror、Quill、CKEditor 同一条通道，不需要任何网站特判。点击后还会用 `elementFromPoint` 校验命中。

**示例 3：不 OCR 读 canvas 文字**
2D canvas 的文字是在 `ctx.fillText()` 里画出来的，在绘制调用层截获：

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

需要开启：

```bash
AI_BROWSER_CANVAS_HOOK=1 npx -y @glittering0717/ai-browser start
```

## 七、常见问题

**Q：支持 Windows 吗？**
A：未测试。不打算含糊其辞——没测过就是没测过。

**Q：为什么不用无头模式？**
A：因为"可见"是被保留的特性：登录态、扫码、人机验证都依赖真实会话。

**Q：WebSocket 有鉴权吗？**
A：没有。只绑 `127.0.0.1`。不要转发这个端口，不要在不可信网络暴露。

## 八、小结

截图 + OCR 不是"不够好"，而是把结构化问题降维成了像素问题。换成语义树之后，成本、稳定性、可验证性三件事同时改善——但代价是你必须放弃无头，接受一个真实可见的窗口。

仓库：https://github.com/Glittering/ai-browser · MIT

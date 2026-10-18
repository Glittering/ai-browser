做 Agent 工具时反复撞同一个问题：让 AI 去知乎、CSDN 后台发一篇带排版的文章，它要么卡在登录，要么读不懂弹窗，要么富文本编辑器里根本打不出字。

我把同一个任务在三条路线上各跑了一遍，记录真实数据。

## 一、三条路线，三种抽象层

**路线 1：截图 + 视觉模型**

流程是：截图 → 视觉模型读图 → 输出坐标 → 点击。

问题不在准确率，在抽象层选错了：

- 每次交互都是一张图进上下文。10 步的任务就是 10 张图，视觉 token 的消耗是纯文本的几十倍
- 坐标绑定的是像素。页面滚动 100px、弹一个 toast、响应式布局切一档，所有坐标全废
- toast 提示"发布成功"一秒钟就消失，截图根本来不及

**路线 2：Playwright / chrome-devtools-mcp**

比截图稳得多，但有个硬前提：**它给你的 Agent 一个临时浏览器实例**。

我的登录态、扫码记录、2FA 都不在这个实例里。每次都要重新登录——而这恰好是自动化里最贵的一段。

另一个问题：canvas 应用在 DOM 层是空的，accessibility tree 什么都读不到。

**路线 3：语义树（AI Browser 的做法）**

窗口是你桌面上那个常驻的 Electron 浏览器，登录态持久。Agent 通过 MCP 或 WebSocket 驱动它，读到的不是像素：

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

## 二、三个关键实现点

**1）输入必须走 CDP 受信事件**

`Input.dispatchKeyEvent` / `dispatchMouseEvent`，不是合成 JS 事件。

差别是真实的：Draft.js、ProseMirror、Quill、CKEditor 都吃这一条通道，**不需要任何网站特判**。
点击后还要用 `elementFromPoint` 校验确实命中，避免"点到隔壁元素"。

**2）canvas 不需要 OCR**

2D canvas 的文字是在 `ctx.fillText()` 里画出来的——那就在绘制调用层把字符串截下来：

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

字体、坐标、颜色全在，零 OCR。只有 WebGL 才保留截图路径，且默认关闭。

> 需要显式开启：`AI_BROWSER_CANVAS_HOOK=1 npx -y @glittering0717/ai-browser start`

**3）"操作生效了没有"应该是工具原语，不是事后自查**

我踩得最狠的坑：工具返回 success，但页面上什么都没发生。Agent 信了，继续走，错误在第三步之后才暴露——这时候已经被放大了。

所以做了 `browse_diff`：快照前后对比，返回显式 changed/unchanged 判定 + 前后值 + JSON path，并对页面数据模型做指纹。
ComfyUI 这类只改 canvas 数据、DOM 零变动的操作，也能被识别。

## 三、结果

同一个任务（登录已就绪的前提下）：

| | 截图流 | Playwright MCP | 语义树 |
|---|---|---|---|
| 进入登录态 | 需重新登录 | 需重新登录 | 复用常驻会话 |
| 富文本编辑器 | 光标进不去 | 视站点而定 | CDP 通道，无特判 |
| canvas 内容 | OCR 猜 | 读不到 | 直接取字符串 |
| 上下文成本 | 高（视觉 token） | 中 | 低（纯文本） |

## 四、踩坑清单

1. Cmd+V 走 CDP 直达渲染器、不过浏览器进程加速键，合成键不触发原生粘贴 → 用 ClipboardEvent + DataTransfer(text/html) 派发 paste
2. `browse_evaluate` 不等 Promise，含 `await` 的 IIFE 返回 `{}` → 拆成"触发 → 等待 → 取结果"两段
3. 标签是 el-autocomplete，合成 `click()` 不吃 → `press ArrowDown` + `Enter` 受信选中
4. 发布结果别信 toast，以 URL 跳转 + 文章页 200 + 正文可读为准

## 五、真实一幕

写这篇稿之前，我先让 Agent 去 B站创作中心，把一条标题挂了两天的源文件名改成了正常标题——它复用常驻登录态进了后台，改完提交，最后用公开 API 复核生效。全程我没碰鼠标。

这也是我判断"Agent + 浏览器"是否可用的标准：不是能不能点，而是**点完能不能证明它真的生效了**。

仓库：https://github.com/Glittering/ai-browser · MIT · macOS/Linux 已测，Windows 未测。

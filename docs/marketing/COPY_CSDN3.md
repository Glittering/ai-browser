# COPY_CSDN3 — CSDN 第三篇（SEO 长尾 · 方案对比与选型）

> 用途：2026-10-24 20:30 自动发布。分类专栏「人工智能」，创作声明如实勾选「部分内容由AI辅助生成」，摘要 100–130 字，标签走推荐池（如"人工智能/自动化/electron"）。
> 目标搜索词：`Playwright MCP 替代方案` / `MCP 浏览器 登录态` / `Agent 操作网页 方案对比` / `浏览器自动化 不用截图`。
> 结构硬要求：小标题 + 自动目录 + 代码块 + FAQ + 小结。SEO 是复利，每周一篇不能断（前两篇：261→297 阅读、184 阅读/21 收藏）。

---

## 标题

`Playwright MCP 登录态每次重登？三种 Agent 浏览器方案对比与选型`

## 摘要（129 字）

用 Playwright MCP 让 Agent 操作网页，每次都要重新登录？本文对比截图流、Playwright MCP、常驻语义树浏览器三种方案在登录态、富文本编辑器、canvas 读取、上下文成本四个维度的真实差异，给出按场景选型的决策树和可运行的配置示例。

## 正文（约 2300 字）

## 一、问题：临时浏览器实例的身份断点

让 Agent 操作网页的主流方案（Playwright MCP、chrome-devtools-mcp 等）工作流是这样的：Agent 调用工具 → 服务端起一个干净的浏览器实例 → 跑完即弃。

这个形态有一个结构性断点：**你的登录态不在那个实例里。**

短信验证码、扫码记录、2FA、公司 SSO——全在你桌面上那个常驻浏览器里。于是每次自动化都卡在同一个地方：登录。而这恰好是整个流程里最贵、最不可自动化的部分（滑块、验证码就是设计来拦程序的）。

更糟的是 canvas 类应用（Excalidraw、ComfyUI、各类数据大屏）在 DOM 层是空的，基于 DOM 快照的方案在这里什么都读不到。

## 二、三种方案对比

| 维度 | 截图流 | Playwright MCP | 常驻语义树浏览器 |
|---|---|---|---|
| 感知输入 | 截图 + 视觉模型 | DOM 快照 | 带 role/label/稳定 ID 的语义树 |
| 上下文成本 | 高（每步一张图，视觉 token） | 中 | 低（纯文本） |
| 登录态 | 需重新登录 | 需重新登录 | **复用常驻会话** |
| 富文本编辑器 | 光标进不去 | 视站点而定 | CDP 受信输入，无网站特判 |
| canvas 内容 | OCR 猜 | 读不到 | 绘制调用层直接取字符串 |
| 操作验证 | 无（toast 一闪而过） | 无 | 前后快照 diff，显式 changed/unchanged |
| 人工接管 | 不可 | 不可 | 随时抢鼠标，Agent 等待 |

三个关键差异展开说：

**1）登录态。** 常驻方案的窗口就是你平时用的那个浏览器，登录一次长期有效。遇到人机验证，人直接动鼠标完成，Agent 在对话里等着——没有交接 API，也没有权限弹窗。

**2）canvas 不需要 OCR。** 2D canvas 的文字是在 `ctx.fillText()` 里画出来的，在绘制调用层把字符串截下来即可：

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

字体、坐标、颜色全在。只有 WebGL 保留截图路径，且默认关闭。

**3）验证必须是原语。** 工具返回 success 但页面没变，是这类自动化里最高频也最贵的一类故障。把"操作生效了没有"做成前后快照对比（显式判定 + 前后值 + JSON path），错误在第一步就被拦住，不会被放大到第三步。

## 三、选型决策树

按三个问题选：

1. **是否需要真实登录态？**（扫码/2FA/SSO 场景）
   - 是 → 临时实例方案全部出局，选常驻方案
   - 否 → 继续
2. **目标是否涉及 canvas 渲染的应用？**
   - 是 → DOM 快照方案出局；截图方案要看 token 预算
   - 否 → 继续
3. **是否需要"操作已生效"的可验证判据？**
   - 是 → 必须选带 diff 原语的方案
   - 否 → 三者皆可，按 token 成本选

## 四、可运行示例（常驻语义树方案）

安装与启动：

```bash
npx -y @glittering0717/ai-browser mcp
```

MCP 配置：

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

语义树读取返回的节点示例：

```json
{
  "role": "textbox",
  "label": "请输入文章标题（5～100 个字）",
  "value": "",
  "states": ["visible", "focused"],
  "actions": ["type", "clear", "focus"]
}
```

已验证的真实站点：知乎（Draft.js 全流程发稿）、CSDN（CKEditor + Markdown 导入）、百度/Bing 搜索、东方财富（2458 节点）、Excalidraw（canvas 文本读取）。

## 五、FAQ

**Q1：常驻浏览器会不会被 Agent 乱点？**
A：点击输入全部走 CDP 受信事件，且窗口支持后台操作不抢焦点；人随时可以动鼠标接管。控制端口只绑 127.0.0.1 且无鉴权，不要转发该端口。

**Q2：和 chrome-devtools-mcp 什么关系？**
A：如果目标就是 Chrome DevTools 协议本身的自动化，两者重叠较多；差异在"常驻可见窗口 + 登录态复用 + canvas 读取 + diff 验证"这四件事，README 里有完整对比。

**Q3：支持 Windows 吗？**
A：macOS/Linux 已测，Windows 未测。首次启动需拉约 110MB Electron 引擎，国内可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

**Q4：为什么不用截图 + 视觉模型，看起来更通用？**
A：成本结构不可持续——每步一张图，视觉 token 是纯文本的几十倍；坐标绑像素，滚动/弹窗/响应式变化全部失效；toast 一秒消失，截图来不及。

## 六、小结

Agent 浏览器的分歧点不在"能不能点"，在"用什么当输入、身份从哪来、怎么确认生效"。三个问题问完，选型自然清晰：要登录态选常驻，要 canvas 选绘制层读取，要确定性选带验证原语的方案。

本文所有对比数据来自真实发稿任务的逐平台记录，项目开源（MIT）：https://github.com/Glittering/ai-browser

跑不通欢迎评论区贴日志，那比 star 更有价值。

# 周刊/日报投稿 issue 终稿（已按各刊真实模板）

提交后把 issue URL 回填。

---

## A. 阮一峰《科技爱好者周刊》→ ruanyf/weekly

标题：`【开源自荐】AI Browser：给 AI Agent 用的常驻"副驾浏览器"，读语义树而非截图`

正文：

```
开源地址：https://github.com/Glittering/ai-browser
npm：https://www.npmjs.com/package/@glittering0717/ai-browser
官方 MCP Registry：io.github.Glittering/ai-browser

AI Browser 是一个 Electron 浏览器，但"驾驶员"是 AI Agent：窗口正常可见、持久登录、常驻桌面，Agent 通过 17 个 MCP 工具（browse_*）或原始 WebSocket JSON-RPC 驱动它；遇到扫码、滑块、支付确认时，人随时可以接管鼠标，没有交接 API，也没有权限弹窗。

它和现有"截图 + OCR + 坐标"式 Agent 浏览器最大的区别是感知方式：Agent 拿到的是带 role/label/稳定元素 ID 的语义树（无障碍树基础上的结构化页面），不花视觉 token，也不怕页面位移。

- 点击与按键走 Chrome DevTools Protocol 受信输入（不是合成 JS 事件），Draft.js / ProseMirror / Quill / CKEditor 走同一条通道，无框架特判；点击后用 elementFromPoint 校验确实命中
- browse_diff 把"验证操作生效"做成工具原语：返回显式 changed/unchanged 判定、前后值与 JSON path，并对页面数据模型指纹化——ComfyUI 这类只改 canvas 数据、DOM 零变动的操作也能被识别
- 2D Canvas 文字在绘制层直接截获 fillText 字符串，无需 OCR；仅 WebGL 保留截图路径且默认关闭
- Agent 后台操作时窗口不抢焦点（showInactive + 焦点模拟），并用 macOS lsappinfo 从外部做焦点测试
- 控制端口仅绑定 127.0.0.1；428 个单元测试（28 个文件）+ 428 个 Electron 端到端断言（12 个套件）全绿

已实测的真实网站流程：知乎文章发布（Draft.js 加粗/多段落/清空/发布弹层）、CSDN（CKEditor 正文/标签/摘要/发布）、百度与 Bing 搜索、东方财富（2458 语义节点）等。

安装：npx -y @glittering0717/ai-browser mcp（Node ≥ 18，已收录 MCP 官方 Registry，可直接被 Claude Code / Cursor / Codex 发现）。

利益关系说明：本人为项目作者，MIT 开源，无商业付费版本。当前已验证平台为 macOS 与 Linux，Windows 未测试，README 中如实标注；与 chrome-devtools-mcp、Playwright MCP 的定位差异也在 README 中做了对比说明。
```

---

## B. HelloGitHub → 521xueweihan/HelloGitHub

标题：`[开源推荐] AI Browser：Agent 用语义树驱动的常驻浏览器（MCP + WebSocket）`

正文：

```
### 项目地址
https://github.com/Glittering/ai-browser

### 类别
人工智能

### 项目标题
给 AI Agent 用的"副驾浏览器"：可见、常驻、可随时人工接管

### 项目描述
AI Browser 是一个 Electron 浏览器，AI Agent 是它的驾驶员。它把网页呈现为带类型与标签的语义树，通过 17 个 MCP 工具或原始 WebSocket JSON-RPC 暴露给 Claude Code、Cursor、Codex 等客户端；不需要截图、OCR 和坐标猜测。浏览器窗口正常可见、会话持久化、扫码登录一次长期有效；Agent 操作时窗口不抢焦点，遇到人机验证或支付时，人可以直接动鼠标接管，Agent 在对话里等待即可。点击与输入走 CDP 受信输入，富文本编辑器无需框架适配；内建 browse_diff 变更验证原语与 Canvas 文字绘制层截获。Node ≥ 18，一条 npx 命令接入，已收录官方 MCP Registry。MIT 开源，支持 macOS 与 Linux。

### 亮点

**1. Agent 看语义树，不看像素**
Agent 每次拿到的是 role/label/value/states 和稳定元素 ID 的结构化树，还有模态框、必填提示、成功消息、登录态等上下文。全程纯文本，没有视觉模型开销，页面位移也不会让坐标失效。

**2. 人和 Agent 共享同一个浏览器**
与 Playwright 类"每次一个干净临时实例"不同，它是桌面上常驻、登录态持久的可见窗口。Agent 在后台操作不抢焦点；扫码、滑块、SSO、支付由人随时接管，无需设计交接接口。

**3. 验证是工具原语，不是事后自查**
browse_diff 对前后快照给出显式 changed/unchanged 判定与 JSON path，并指纹化页面自身的数据模型——覆盖"工具返回成功但实际什么都没发生"以及 canvas 类应用 DOM 零变动两种高频故障。

**4. 受信输入 + Canvas 无 OCR**
点击/按键走 CDP 的 Input 事件，先滚入视口再用 elementFromPoint 校验；2D Canvas 的 fillText 文字在绘制层直接截获，仅 WebGL 才使用截图且默认关闭。

**5. 测试与安全**
428 个单元测试 + 12 套真实 Electron 端到端套件共 428 个断言；contextIsolation、evaluate 长度与危险 API 限制、控制端口仅绑 127.0.0.1。
```

---

## C. GitHubDaily → GitHubDaily/GitHubDaily

标题：`【开源自荐】AI Browser：不截图的 Agent 浏览器，语义树 + MCP 驱动`

正文：

```
开源地址：https://github.com/Glittering/ai-browser

一个 Electron 浏览器，让 AI Agent 当驾驶员、人类当副驾：

- Agent 通过 17 个 browse_* MCP 工具或裸 WebSocket JSON-RPC 操作浏览器，拿到的是语义树（role/label/稳定 ID）而不是截图，不用视觉 token、不猜坐标
- 窗口常驻可见、登录态持久；Agent 操作不抢焦点，扫码/支付/滑块时人直接接管鼠标
- 点击输入走 CDP 受信输入，知乎 Draft.js、CSDN CKEditor 等富文本编辑器无特判适配，已实测完整发布流程
- browse_diff 显式判定操作是否真的生效，canvas 数据模型变更也能识别；2D Canvas 文字在绘制层直接截获
- npx -y @glittering0717/ai-browser mcp 即装即用，已收录官方 MCP Registry（io.github.Glittering/ai-browser）
- 428 单测 + 428 个 Electron e2e 断言全绿，MIT，macOS/Linux（Windows 未测，已如实标注）

利益关系：项目作者自荐，无付费版。
```

---

## 提交记录

| 目标 | 时间 | issue URL |
|---|---|---|
| ruanyf/weekly | 2026-10-15 | https://github.com/ruanyf/weekly/issues/12388 |
| HelloGitHub | 2026-10-15 | https://github.com/521xueweihan/HelloGitHub/issues/3978 |
| GitHubDaily | 2026-10-15 | https://github.com/GitHubDaily/GitHubDaily/issues/1213 |

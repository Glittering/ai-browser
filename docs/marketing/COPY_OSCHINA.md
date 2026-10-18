# 给 Agent 的浏览器为什么要"可见"：一个 Electron + MCP 的实现

## 结论先行

我要的不是一个无头浏览器，而是一个**我也能看见、也能随时插手的浏览器**。这个区别不是产品情怀，是被真实断点逼出来的设计选择。

## 自动化真正的断点是"身份"，不是"不会点"

写浏览器自动化的人都遇到过同一条曲线：前 80% 的流程顺得惊人，最后 20% 能把人耗死。卡住脚本的从来不是"找不到按钮"，而是**身份**——登录态要维持、扫码要掏手机、2FA 要等验证码、滑块要拖、支付要确认。这些环节的共同特征是：**人类必须在回路里，但又必须能随时接手**。

所以常见方案各有各的痛：

- **每次起一个干净的临时实例**：跑完即弃，登录态不共享。于是脚本每天的第一项工作是"重新登录"，遇到 2FA 直接死局。
- **复制一份用户 profile 给自动化用**：能带上登录态，但两个浏览器实例并发占用同一 profile 会撞锁；Chrome 一升级，profile 数据结构跟着变，复制来的副本时不时就起不来。
- **远程无头集群**：身份问题一个没少，只是把"掏手机"变成了"登不上去"。

## 我的形态：常驻可见窗口 + 两套等价接口

AI Browser 是一个正常的 Electron 窗口：**常驻、可见、持久登录**。它同时暴露两套完全等价的接口：

- **MCP stdio**：20 个 `browse_*` 工具（`browse_navigate`、`browse_get_tree`、`browse_act`、`browse_diff`……），任何 MCP 客户端即插即用；
- **WebSocket JSON-RPC**：`ws://localhost:9223` 上的 `ui.*` 方法，给需要精细控制或自己写客户端的场景。

两套接口走同一套页面管理内核，不存在"MCP 是二等公民"的问题。

## 感知：语义树，不是截图

Agent 拿到的页面表示是带 role/label/稳定 ID 的**语义可访问性树**，还附带 context：哪个弹窗开着、哪个字段必填、刚才弹出的成功消息是什么、当前是不是登录态。不花视觉 token，不需要 OCR，也不会因为 CSS 改版就集体失明。

## 输入：CDP 受信事件，富文本编辑器零适配

点击和键盘输入走 Chrome DevTools Protocol 的受信事件通道——和真人点击在浏览器眼里是同一条路径。Draft.js、ProseMirror、Quill、CKEditor 全都走这条通道，**不用为任何编辑器写特判代码**。

## canvas 也能读：从绘制层直接拿字符串

画布应用（白板、图表、设计工具）是自动化重灾区。AI Browser 在 2D 绘制层截获 `fillText()` 调用，直接拿到字符串和坐标，**零 OCR**。开启方式是环境变量 `AI_BROWSER_CANVAS_HOOK=1`。WebGL 是唯一的像素路径，默认关闭。

## 验证做成原语：browse_diff

"我以为点掉了但其实没掉"是自动化调试最费时间的一类问题。`browse_diff` 对操作前后各取一份快照，给出**显式的 changed/unchanged 判定**加页面数据模型指纹——连"只改 canvas 数据、一个 DOM 字节都没动"的应用也能抓到变化。

## 诚实的边界

- **平台**：macOS / Linux 已实测，Windows 未测，不打包票；
- **安全**：控制端口只绑 localhost 且当前没有鉴权——别把它暴露到局域网，更别暴露到公网；
- **窗口策略**：被 Agent 拉起时不抢焦点（showInactive），人在前台做事不会被打断；遇到扫码/支付，人直接动鼠标接管即可，没有交接 API，也不需要。

## 开源

MIT 协议，仓库在 [github.com/Glittering/ai-browser](https://github.com/Glittering/ai-browser)，已收录官方 MCP Registry（`io.github.Glittering/ai-browser`）。一行安装：`npx -y @glittering0717/ai-browser mcp`。

如果你也在做"Agent + 浏览器"，特别想听听你实际卡在哪——身份、感知、验证，还是别的？欢迎提 issue。

# DISCUSSIONS_SEED — GitHub Discussions 自问自答种子（3 条）

> 用途：Discussions 已开但无人发帖（paths 数据显示 1 人点进 discussions 页又离开）。以下 3 条覆盖最高频的预期问题，**自问自答**搭建"有人在用"的氛围。
> 状态：**待用户过目后发布**（以用户名义的公开内容）。发布后把链接回填本文档。
> 分类建议：Q&A。语气：维护者直接回答，不营销。

---

## Seed 1：安装与引擎下载

**标题：** 首次调用卡住 / Electron 引擎下载失败怎么办？

**正文：**
首次启动会拉取约 110MB 的 Electron 引擎，国内网络直接连下载源可能很慢或失败。两个办法：

1. 设置镜像再启动：
```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx -y @glittering0717/ai-browser mcp
```
2. 如果之前卡在一半，清理后重试：删除 `~/.ai-browser` 下的缓存目录再启动（登录态在 profile 里，不会丢，但首次未完成时还没有登录态）。

启动成功的标志：端口 9223 开始监听，第一次 `browse_*` 调用会自动拉起窗口。如果窗口起来了但调用无响应，看 `~/.ai-browser/error.jsonl` 有没有更新——那是指令日志，停了说明主进程卡死了。

**（自答）** 补充：Windows 目前未测试，引擎路径可能有差异，欢迎在本帖反馈。

---

## Seed 2：与 Playwright MCP / chrome-devtools-mcp 怎么选

**标题：** 和 Playwright MCP、chrome-devtools-mcp 相比该怎么选？

**正文：**
按三个问题分：

1. **需要复用你桌面浏览器的登录态吗？**（扫码/2FA/SSO）
   - 需要 → 只有常驻方案满足。Playwright MCP / chrome-devtools-mcp 给 Agent 的是临时实例，每次重新登录。
2. **目标应用是 canvas 渲染的吗？**（白板/可视化/ComfyUI 类）
   - 是 → DOM 快照方案读不到；本项目在 2D 绘制调用层截字符串（WebGL 仍走截图，默认关）。
3. **需要"操作已生效"的确定判据吗？**
   - 需要 → 本项目的 `browse_diff` 给显式 changed/unchanged + JSON path。

如果三个问题的答案都是"否"、且你本来就在用 chrome-devtools-mcp 用得顺，那没必要换——README 里有完整的对比章节，重叠的部分写清楚了。

**（自答）** 补一个边界：本项目控制端口只绑 127.0.0.1 且无鉴权，**不要转发这个端口**；macOS/Linux 已测，Windows 未测。

---

## Seed 3：端口与安全

**标题：** 9223 端口没有鉴权，安全吗？

**正文：**
设计约束：控制端口（默认 9223）只绑定 127.0.0.1，不对外暴露。这意味着本机上的任何进程都可以调用它——所以：

- **不要在容器/远程环境里把 9223 转发出去**，那等于把浏览器控制权交出去；
- 多用户共享的机器上，注意同账户的其他进程；
- 端口号可以通过配置改，但"仅 loopback"这个约束不建议放开。

调用链路本身：MCP 通过 stdio 与服务器进程通信，浏览器操作走本地 WebSocket JSON-RPC，不出本机。

**（自答）** 如果以后有远程驱动的真实需求，会考虑加 token 鉴权，但不是当前版本的范围——先把这个边界说清楚，避免误用。

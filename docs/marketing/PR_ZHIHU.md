# 给 Agent 装一个"眼睛"：一个 2 线 Star 的宝藏项目，让 AI 从"睁眼瞎"变成"无所不能"

最近在折腾 AI Agent 干活，我发现一个卡了所有人很久的瓶颈——

**你的 Agent 其实是个"瞎子"。**

你可能已经有这个体验：让 Claude 或 Cursor 去知乎写一篇文章、去 CSDN 后台发布、去金融网站查数据，它要么反复卡在登录，要么读不懂弹窗，要么富文本编辑器打字发不出去。你气得要命，它跟你装傻。

不是你菜，是**工具错了**。

## 主流方案为什么都在裸奔

现在的浏览器 Agent，绝大多数走的是"截图 + 想"的路子：

- 截一张图 → 用视觉模型猜位置 → 猜坐标点击。

听起来科幻，做起来翻车。**一个像素的布局偏移，所有坐标全废**。网页弹出个 toast 提示"发布成功"，一秒钟就消失，截图根本来不及。更别提 Draft.js、ProseMirror 这类富文本编辑器——光标都进不去，更别说排版加粗。

说白了，**截图就是换了个马甲的 OCR 问题**。人类用眼睛读网页，AI 应该读的是 DOM——这是两码事。

## 一个"反着来"的项目

我最近找到一个小众宝藏项目，叫 **AI Browser**（GitHub 上搜 `Glittering/ai-browser`）。它的思路是"反着来"：

> **人类看像素，AI 看语义树。**

什么意思？它是个 Electron 浏览器，正常渲染网页给你看；同时把页面结构转成**结构化语义树**推给 Agent。Agent 再也不用猜坐标，直接拿到带类型、带标签的数据：

```json
{
  "tree": {
    "role": "textbox",
    "label": "请输入文章标题（5～100个字）",
    "value": "AI Browser 测试标题",
    "states": ["visible", "focused"],
    "actions": ["type", "clear", "focus"]
  },
  "context": {
    "modals": [{ "header": "博主不存在", "buttons": ["确定"] }],
    "messages": [{ "text": "发布成功", "type": "success" }],
    "session": { "logged_in": true }
  }
}
```

`get_tree` 一次返回整棵语义树 + 模态框 + 提示信息，Agent 一目了然——**真正的"读懂了网页"。**

每个元素都带稳定的 `data-ai-id`。点 `e:div-60`、往里输入、等待提示出现——**全程不碰一张截图。**

## 为什么说它是"跨时代"的浏览器

我要重点给你看它在富文本上的表现——这是所有截图方案的死穴。

官方实测：在**知乎的 Draft.js 编辑器**里，从标题、正文多段落、加粗、清空到发布弹层，**全流程通过**。甚至知乎故意屏蔽了 Cmd+A 全选快捷键，它也能自动回退到原生选区 API 原生清空——**框架无关，不需要给任何编辑器写特判**。

凭什么？因为它的操作不是 JS 模拟，而是走 Chrome DevTools Protocol 派发**受信键鼠事件**，等价真人输入：

- 点击：先把元素滚进视野 → 派发受信点击 → 用 `elementFromPoint` 校验真的点中了。
- 输入：focus → 全选 → 受信 Delete 清空 → 逐字符 `rawKeyDown→char→keyUp`。

**Draft.js、ProseMirror、Quill、CKEditor、普通 `<textarea>`，全走同一条通道。** 这是技术路线上的根本不同——别人在为一个个框架打补丁，它直接给浏览器一个通用的"真手"。

## 它到底能帮你干什么

- **写稿发稿**：知乎、CSDN 等平台，从登录到富文本编辑到发布，全自动。
- **查数据**：金融、股票、财经站点（东方财富实测拉了 2458 个节点）。
- **验证流程**：让 Agent 自己测试你自己的网页，还能编程式读网络请求（403/404/500 一目了然）。
- **一个浏览器，人机共用**：你在看，Agent 在操作，共享一个实例。

## 怎么装？10 秒上车

它是标准 MCP server，兼容你手上几乎所有 Agent（Claude Code / Cursor / Codex…）。

```bash
git clone https://github.com/Glittering/ai-browser
cd ai-browser && npm install
```

然后往 `.mcp.json` 里注册一句：

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["/绝对路径/ai-browser/src/main/mcp_server.js"]
    }
  }
}
```

**不用手动开浏览器**——MCP 服务会自动从项目根拉起 Electron，用完 `browse_quit` 自动关，生命周期全托管。

## 最后，为什么值得你点个 Star

这是我在 Star 数极少的**宝藏项目**里挖到的——`Glittering/ai-browser`，MIT 开源，100 个单元测试 + 31 个 Electron smoke 测试全绿。**Star 现在还不多，趁它还没火，先藏好。**

一句话形容它：**这可能是 Agent 第一次真正"看懂"网页。** 装了它，你的助手从一个"睁眼瞎"，变成几乎"无所不能"。

[→ 项目地址 https://github.com/Glittering/ai-browser · 顺手点个 Star 支持]
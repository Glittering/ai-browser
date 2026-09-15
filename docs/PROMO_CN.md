# AI Browser — 人类看像素，AI 看语义树

## 一句话说清楚

现在 AI Agent 操作网页只有一条路：截图 → OCR → 猜坐标。慢、贵、还不准——页面动一个像素，坐标就全错。截图本质是一个换了个马甲的 OCR 问题。

AI Browser 换了个思路：**人类看像素，AI 看语义树。**

它是 Electron 内核的浏览器，正常渲染网页给你看，同时把页面结构转成结构化语义树，通过 WebSocket JSON-RPC（端口 9223）推给 Agent，也原生支持 MCP。

## 怎么用

```
Agent → WS JSON-RPC / MCP → AI Browser → Web 页面
```

Agent 不需要截图，它直接问浏览器"页面上有什么？"。浏览器回答的不是一张 PNG，而是带类型、带标签的结构化数据：

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
    "required_hints": ["0/256", "请选择", "*"],
    "messages": [{ "text": "发布成功", "type": "success" }],
    "session": { "logged_in": true },
    "stats": { "inputs": 20, "buttons": 35, "links": 94, "iframes": 2 }
  }
}
```

每个元素都有稳定的 `data-ai-id`。点 `e:div-60`、往里输入、等待 toast 出现——整个过程不碰一张截图。

## 操作像真人，不是 JS 技巧

点击和按键都走 Chrome DevTools Protocol，等价真实键盘鼠标输入，所以复杂编辑器无需任何框架特判：

- **点击**：先把元素滚进视野 → 派发受信 `mousedown/up/click` → 用 `elementFromPoint` 校验真的点中了。
- **输入/清空**：聚焦 → 全选（对移除了全选快捷键的网站会回退到原生 Range 全选，知乎编辑器就把 Cmd+A 屏蔽了）→ 受信 Delete 清空 → 逐字符 `rawKeyDown→char→keyUp`。
- Draft.js、ProseMirror、Quill、CKEditor、普通 `<textarea>` —— 全部走同一条通道，框架无关。

## 已验证（真实网站）

| 网站 | 流程 | 结果 |
|---|---|---|
| **知乎** | 文章全流程：Draft.js 加粗、多段落正文、清空、发布弹层 | ✅ |
| **CSDN** | 标题 + CKEditor 正文 + 标签 + 摘要 + 发布 | ✅ 已发布 |
| **百度** | 搜索 → 结果页，65 节点，点击 | ✅ |
| **东方财富** | 股票查询 | 2458 节点 ✅ |
| **同花顺** | 复杂金融页，崩溃修复后 | ✅ |
| **魔塔社区** | 搜索 + 滚动 | 508 节点 ✅ |

## MCP 集成——复制给 Agent 一句话就用

不只是独立使用。可以作为 MCP server，让 Claude Code / Cursor / Codex 直接调用。把下面这句话丢进 Agent 的指令，它就能自己驱动真实浏览器，甚至自己拉起、自己关闭：

> 我可以使用 AI Browser 浏览网页（13 个 browse_* 的 MCP 工具）。第一次调用会自动启动 Electron 浏览器，用完自动关闭。用 browse_navigate 打开网页，用 browse_get_tree 把页面读成 DOM 树，用 browse_act 像人一样点击/输入，用 browse_evaluate 执行 JS，用 browse_wait 等待目标出现。

注册配置：

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

MCP 服务启动时会探测 9223 端口：没人监听就自动从项目根拉起 Electron，用完用 `browse_quit` 释放。**Agent 全程拥有浏览器生命周期，不需要人手动启停。**

## 为什么不是 Playwright / Puppeteer？

Playwright 也是 Chrome，但它是 headless 的、靠选择器——网站一改版就全断。

AI Browser 是双输出：
- **人类**看到正常网页（像素渲染）
- **AI** 拿到语义树 + 事件流（结构化 API）

人和 Agent 共享同一个浏览器实例。你看你的网页，Agent 操作它的 API，互不干扰。

## 架构

```
外部 Agent（MCP stdio · 13 工具 │ WS JSON-RPC :9223）
        │
Electron 主进程：index.js · ws_server.js · page_manager.js
        │  CDP 共享会话（Network + Runtime，每 tab 只 attach 一次）
        │  IPC，按请求 id 精确匹配
preload（contextIsolation）：bridge.cjs · extractor.cjs · actions.cjs · watcher.cjs
        │  实时 DOM，data-ai-id
WebPage → 语义树（全程无一张截图）
```

**一个进程、一个端口、一条 preload 桥。** 无微服务、无截图管线、无视觉模型账单。每步都是纯文本 token，便宜。

安全防护：`contextIsolation` + `nodeIntegration:false`；`browse_evaluate` 限 5000 字符并拒绝 `process.`/`require`/`child_process`。

## 快速开始

```bash
git clone https://github.com/Glittering/ai-browser
cd ai-browser
npm install
npm start   # WS 服务起在 :9223
```

## 为什么开源

Agent 已经不再是"玩具"，而是"劳动者"。但这一周 GitHub Trending 上堆满的 Agent 工具，绝大多数还在用截图 + OCR——那还是 2024 年的方案，超前于 Agent 真的能干活之前。

AI Browser 给 Agent 真正的 Web 感官：**DOM 精度的感知，像人一样的受信操作。** MIT 开源，随便用。

---

**项目地址：https://github.com/Glittering/ai-browser**
**100 单测 + 31 Electron smoke 全绿 · 13 个 MCP 工具 · MCP/WS 双原生**
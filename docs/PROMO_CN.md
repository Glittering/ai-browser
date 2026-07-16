# AI Browser — 让 AI Agent 像人一样"看"网页

## 一句话说清楚

现在的 AI Agent 操作网页只有一个办法：截图 → OCR → 猜坐标。慢、贵、不准。

AI Browser 换了个思路：**人类看像素，AI 看语义树。**

它是 Electron 内核的浏览器，渲染正常的网页给你看，同时把页面结构转成结构化 API 推给 AI Agent。

## 怎么用

```
Agent → WS JSON-RPC → AI Browser → Web 页面
         ↑
     get_tree(path, role, rect)
     act(ref, action)
     navigate(url)
     evaluate(js)
     subscribe(event)
```

Agent 不需要截图。它直接问浏览器："页面有什么？"浏览器回答：

```json
{
  "role": "link",
  "name": "阶跃星辰发布 Agent-native OS",
  "ref": "@e42",
  "rect": {"x": 100, "y": 200, "w": 300, "h": 24}
}
```

"好，点它。" `act(ref="@e42", action="click")`。**像素级别的精度，不需要 CV。**

## 已验证

| 网站 | 效果 |
|---|---|
| 百度 | 搜索全链路：输入关键词 → 点搜索 → 读结果 ✅ |
| 东方财富 | 首页 2458 语义节点 → 搜"贵州茅台" → 283 条新闻提取 ✅ |
| 36氪 | 20 条文章标题 → 正文提取（阶跃星辰/腾讯ADP/Meta裁员） ✅ |
| 果壳 | 科学文章深度阅读 ✅ |
| 京东/12306 | 验证码检测 push 通知 ✅ |
| InfoQ | AICon 主题提取 ✅ |
| GitHub Trending | 每周最火项目抓取 ✅ |

**54 个单测全绿，6 个网站实战验证。**

## MCP 集成

不只是独立使用。可以作为 MCP server，让 Claude Code/Cursor/Codex 直接调用：

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      "args": ["src/main/mcp_server.js"]
    }
  }
}
```

Agent 在 Claude Code 里说"帮我读一下这个网页"，AI Browser 在 Electron 里渲染、提取、返回结构化数据。**Agent 真的有了眼睛。**

## 为什么不是 Playwright/Puppeteer？

Playwright 也是 Chrome。但它是 headless 的——专门给机器用的。

AI Browser 是双输出的：
- **人类**看到正常网页（像素渲染）
- **AI** 拿到语义树 + ActionMap + WS 事件流（结构化 API）

人和 Agent 共享同一个浏览器实例。你看你的网页，Agent 操作它的 API。互不干扰。

## 架构

```
┌─────────────────────────────────────┐
│  Electron (Chromium)                │
│  ┌───────────────────────────────┐  │
│  │  Web Page (正常渲染)          │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │ Preload Bridge (CJS)    │  │  │
│  │  │ • extractTree()         │  │  │
│  │  │ • executeAction()       │  │  │
│  │  │ • scanCaptcha()         │  │  │
│  │  │ • MutationObserver      │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
│              ↕ IPC                   │
│  ┌───────────────────────────────┐  │
│  │ Main Process                  │  │
│  │ • page_manager (异步IPC)      │  │
│  │ • ws_server (9223)            │  │
│  │ • mcp_server (stdio)          │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
         ↑                  ↑
    WS JSON-RPC         MCP stdio
    (独立Agent)    (Claude Code/Cursor/Codex)
```

## 快速开始

```bash
git clone https://github.com/Glittering/ai-browser
cd ai-browser
npm install
npm start

# 另一个终端
node tools/browser.cjs  # inspect → fillForm → clickButton
```

## 为什么开源

本周 GitHub Trending 前 6 名全是 Agent 项目：
- AI 自动求职框架（13k stars/week）
- Agent 专属 Office 套件（7k stars/week）
- 并行 Agent 舰队管理器（5.7k stars/week）
- 免费 AI Gateway 231+ providers（4.3k stars/week）

Agent 已经不是"玩具"，是"劳动者"。但所有 Agent 都在用截图+OCR——这是 2024 年的方案。

AI Browser 给 Agent 真正的 Web 感官。MIT 开源，随便用。

---

**项目地址：https://github.com/Glittering/ai-browser**
**54 测试 · 1249 行核心代码 · MCP 原生支持**
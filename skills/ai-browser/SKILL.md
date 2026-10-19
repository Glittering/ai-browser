---
name: ai-browser
description: >-
  Drive a real, visible browser: open pages, read the page as a semantic tree (not screenshots),
  click/type/fill, read canvas text, inspect network requests. Use when a task must actually DO
  something on a website (log in, fill a form, publish, scrape, verify a flow) or read a page whose
  content is rendered by JS. 触发词：打开网页、点击、填表、登录、抓取、网页操作、browse。
---

# ai-browser

窗口是真的、可见的，人能随时抢鼠标键盘接管。页面以语义树返回，**不是截图**。

## 最小循环

1. `browse_navigate { url }`
2. `browse_get_tree { subset: "interactive" }` → 从节点里取 `id`
3. `browse_act { action: "click" | "type", target: "<id>", text? }`

`success: true` **只代表动作发出去了，不代表页面变了**。

## 卡住时的第一反应

| 现象 | 先做什么 |
|---|---|
| 树里没有目标 | `browse_wait` 等渲染，再重读树（SPA 常见） |
| 有节点但操作失败 | 动作层问题，写选择器解决不了 → `references/hard-pages.md` |
| 点了没反应 | 视觉问题 `browse_screenshot`；请求没发 `browse_network {operation:"list"}` |
| 怀疑被踢登录 | `browse_auth_state` |
| 以上都不对 | `browse_errors` |

## 要人帮忙时

登录、扫码、滑块、支付：**在对话里直接请用户在窗口里操作**，收到"好了"再 `browse_get_tree` 确认。
不要编造凭据，不要反复重试注定失败的点击。

浏览器侧没有"交接"接口——人机协作发生在你们的对话里，不在 API 里。

## 按需深挖

- `references/troubleshooting.md` — 失败排查顺序 + 四条别做
- `references/hard-pages.md` — canvas / 富文本编辑器 / 跨进程 iframe / 上传
- `references/network.md` — 抓请求、从页面取结构化数据
- `references/tasks.md` — 发布文章 / 读正文 / 盯网络 的配方

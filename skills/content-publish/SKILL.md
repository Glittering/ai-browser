---
name: content-publish
description: >-
  适用于用户要求"把内容/文章发布到某个平台（CSDN、知乎、掘金、其他博客/社区等）"、或用编辑器录入并提交内容的自动化发布/提交流程任务。触发词：发布到、发博客、发文章、submit/publish this post、发布内容。
  注意边界：若用户只是想编辑某个已有页面而非提交发布，用 browse_navigate / browse_act 直接处理即可，不需本 skill 的发布校验步骤。
---

# 内容发布 / 提交流程（content-publish）

## 目标
用 AI Browser 把标题 + 正文内容发布到目标平台的编辑器并确认提交成功。完全用已保留的 MCP 原语（`browse_navigate`/`browse_get_tree`/`browse_act`/`browse_evaluate`/`browse_wait`），不引入额外脚本或运行环境。

## 前置
- 已在目标平台登录（登录态未过期）。未登录时先引导用户完成登录/验证。
- 已知"编辑器入口 URL"或当前已在可编辑的页面。

## 核心步骤（通用，按平台微调）

1. 导航到目标平台的文章/编辑器页面：
   `browse_navigate({ url: "<编辑器URL>" })`；必要时
   `browse_wait({ condition: "url_contains", text: "<编辑器路径特征>" })`。

2. 读取页面结构，定位标题框与正文框：
   `browse_get_tree({})`，用返回元素的 `label`/`role` 找到标题输入框与正文编辑区（编辑器可能是 `contenteditable`，role 为 textbox 或 div）。

3. 录入标题：
   `browse_act({ action: "type", target: "<标题框 data-ai-id>", text: "<标题>" })`。

4. 录入正文：
   - 普通 `<textarea>`：`browse_act({ action: "type", target: "...", text: "<正文>" })`。
   - 富文本/contenteditable 编辑器：`browse_act` 的 `type` 已支持 contenteditable / Draft / ProseMirror / CodeMirror，直接复用即可；若失效，用
     `browse_evaluate` 手动设置 `textContent` 并派发 `input` 事件兜底。

5. 可选：若需先预览或勾选多平台发布，按 `browse_get_tree` 找到对应控件并 `browse_act`。

6. **订阅消息**，以捕获发布后的成功/报错 toast：
   `browse_subscribe({ events: ["message_appeared", "js_error"] })`。

7. 点击发布按钮：用 `browse_get_tree` 找到 label 为"发布/发布博客/提交"的按钮，再
   `browse_act({ action: "click", target: "<发布按钮 data-ai-id>" })`。

8. 等待并校验结果：
   - `browse_wait({ condition: "text_contains", text: "发布成功" })` 或"多平台发布"；
   - 用 `browse_evaluate` 读取 `document.body.innerText`，检查是否出现：
     "发布成功"（成功）、"多平台发布"（多平台已推）、"审核"（进入审核）、或报错提示（失败）。
   - 按结果把状态反馈给用户，失败时给出页面提示原文。

## 校验信号（常见平台）
| 信号 | 含义 |
|---|---|
| 发布成功 / 保存成功 | 已发布 |
| 多平台发布 | 已同步分发到多个平台 |
| 审核 / 待审核 | 进入人工/系统审核 |
| 报错 toast / message_appeared 事件体 | 失败，需读取提示原文 |

## 边界与替代
- skill 不保存账号/密码，登录与验证码需用户配合。
- 若某平台按钮文案不同，用 `browse_get_tree` 的 label 动态定位，不要硬编码选择器。
- 发布属于不可逆操作：点击前可用 `browse_get_tree` 确认拿到的确实是发布按钮（label 含"发布/提交"），避免误点。
- 本 skill 是操作指南，依赖的仍是 MCP 常驻原语，不额外启动脚本/进程。
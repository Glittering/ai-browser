---
name: web-network-monitor
description: >-
  适用于监控页面发出的网络请求、抓取指定 API 的响应体、验证请求参数/返回值、或捕获页面 JS 错误的排查/取证任务。触发词：抓包、网络请求、接口响应、request/response body、看下这个接口返回了啥、js error、请求参数。
  仅当任务依赖"页面网络层信息"时使用；普通点击/读取/输入请直接用 browse_get_tree / browse_act / browse_evaluate，不要用本 skill。运行时实现依赖 browse_subscribe + browse_network_body，这两个工具已常驻保留。
---

# 网络 / 接口监控（web-network-monitor）

## 目标
订阅页面事件（尤其 `network_response`、`js_error`），捕获满足 URL 条件的请求响应体，或定位页面 JS 报错，支持接口返参排查与取证。

## 前置
- 浏览器已打开目标页，页面在活动标签。
- 本 skill 依赖后端 CDP 网络监控（ws_server 已实现），工具本体保留，无需额外能力。

## 步骤
1. **订阅网络/错误事件**：调用
   `browse_subscribe({ events: ["network_response", "js_error", "dom_change"] })`
   （可按需增删；也可传 `"*"` 订阅全部。注意订阅从此刻起捕获后续请求，历史请求需先触发。）
2. **触发目标请求**：用 `browse_navigate` / `browse_act` 执行操作，让页面真正发出感兴趣的网络请求。
3. **读取响应体**：对感兴趣的请求，调用
   `browse_network_body({ url_pattern: "<URL 子串>" })`
   返回已完成请求的 body。`url_pattern` 是 URL 子串匹配（如 `/api/user`、`search?q=`）。
4. **解读事件**：
   - `js_error` 事件体含错误信息 → 用于定位 JS 异常来源。
   - `network_response` 事件可确认请求发生及其概要。
5. **清监控（如支持）**：任务结束视可通过重新订阅/关闭标签释放；无需显式清理时忽略。

## 示例（Claude Code 风格）
用户："看我提交评论后调了哪个接口、返回了什么"
- `browse_subscribe({events:["network_response"]})`
- `browse_act({action:'click', target:'<评论提交按钮 data-ai-id>'})`
- `browse_network_body({url_pattern:'comment'})` → 读返回 JSON，解读给用户。

## 验证
- 订阅后触发操作能观察到对应 `network_response` / `js_error` 通知。
- `browse_network_body` 对已订阅且已完成的请求返回 body；未订阅或未发生则返回空/null（不算错误）。
- 多标签下按 tab 隔离；取 body 时确认目标 tab（默认活动 tab）。

## 边界与替代
- 只订阅"之后"的事件，历史请求不可见；如需历史，刷新页面后重订阅。
- 无法用 `browse_evaluate` 替代（网络监控由后端 CDP 提供，页面上下文拿不到）。
- 响应体可能较大；先靠 `url_pattern` 收窄，避免取回无关数据。
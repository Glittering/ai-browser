---
name: web-network-monitor
description: >-
  适用于监控页面发出的网络请求、抓取指定 API 的响应体、验证请求参数/返回值、或查看页面 JS 错误的排查任务。触发词：抓包、网络请求、接口响应、接口返回了什么、response body、看下这个接口、js error、请求参数。
  仅当任务需要"网络层信息"时使用；普通点击/读写页面请直接用 browse_act / browse_get_tree。
---

# 网络 / 接口监控（web-network-monitor）

用**两个**工具就够，不需要订阅、不需要写脚本：

| 想做什么 | 调用 |
|---|---|
| 看页面发了哪些请求 | `browse_network {operation:"list"}` |
| 按 URL 找某个请求 | `browse_network {operation:"list", filters:{url_contains:"/api/user"}}` |
| 看某条请求的详情 + 响应体 | `browse_network {operation:"get", network_id:"<从 list 拿>", include:{response_body:true}}` |
| 清空已记录请求 | `browse_network {operation:"clear"}` |
| 看页面 JS 报错 | `browse_errors` |

## 标准四步

1. `browse_network {operation:"clear"}` —— 先清，避免混进旧请求。
2. 触发请求：`browse_act {action:"click", target:"<按钮 data-ai-id>"}`。
3. `browse_network {operation:"list", filters:{url_contains:"<关键字>"}}`
   → 每条带 `id`、`method`、`url`、`status`、`state`。
4. `browse_network {operation:"get", network_id:"<id>", include:{response_body:true, request_body:true}}`
   → 拿 headers 与 body。大 body 用 `body_offset` 翻页。

## 关键事实（不按这个来会白等）

- **网络记录是按"从现在起"累积的**，`clear` 只清当前 tab 的记录。
- `list` 默认返回 50 条（最多 200）；更多用 `filters.before_seq` 翻页。
- `response_body` 只在请求**已完成**后才有；`state:"pending"` 时先 `browse_wait {condition:"text_contains"}` 或稍等再 `get`。
- 敏感 header（Cookie/Authorization）默认打码，需要时由人设置 `AI_BROWSER_NETWORK_SENSITIVE=1` 并重启。
- 请求体/响应体可能很大：先用 `filters` 收窄，再 `include.body_limit` 控制。

## 示例

用户："我点提交之后到底调了哪个接口、返回了什么？"

```
browse_network {operation:"clear"}
browse_act     {action:"click", target:"e:button-7"}
browse_network {operation:"list", filters:{method:["POST"]}}
browse_network {operation:"get", network_id:"<上一步的 id>", include:{response_body:true}}
```

## 边界

- 页面关闭后该 tab 的记录一起没了；跨 tab 各自独立。
- `browse_evaluate` 不能替代：它只看得到页面 JS 上下文，看不到网络层。
- 拿不到 body 时先确认 `state` 是否为 `finished`，再确认请求是否真的发生过（`list` 里有没有它）。

# 网络与接口（抓请求 / 取数据）

抓包**从 tab 打开那一刻就开始**，不需要订阅、不需要写脚本，POST 请求体也在。
**登录后才看得到的接口正是它的用武之地** —— 浏览器的登录态就是请求的登录态。

## 什么时候该看网络，而不是看树

- 点了提交没反应，想知道到底发了什么、返回了什么
- 想知道某个列表页背后的 API（比解析 DOM 稳一个数量级）
- 排查 4xx / 5xx、怀疑"页面没数据"是接口没回
- 需要结构化数据，而 DOM 只是渲染后的残缺版本

## 标准四步

```
browse_network { operation:"clear" }                                  # 1 先清，别混进旧请求
browse_act     { action:"click", target:"e:button-7" }                # 2 触发请求
browse_network { operation:"list", filters:{ method:["POST"] } }      # 3 找到 id
browse_network { operation:"get", network_id:"<id>",
                 include:{ response_body:true, request_body:true } }  # 4 取 headers 与 body
```

## 参数形态（按 op 分组，不是拍平的）

| op | 参数 |
|---|---|
| `list` | `filters:{ method[], url_contains, status_min, status_max, resource_type[], state[], started_after, started_before, limit(默认 50 / 最多 200), before_seq }` |
| `get` | `network_id` + `include:{ request_headers, response_headers, request_body, response_body, sensitive_headers, body_limit }` + `body_offset:{ request, response }` |
| `clear` | 无需参数（只清当前 tab） |
| `configure` | `configure:{ enabled, capture_bodies:"none"｜"api"｜"all" }` |

## 关键事实（不按这个来会白等）

- 记录**只从现在起累积**；`clear` 只清当前 tab，tab 一关记录就没了，跨 tab 各自独立
- `response_body` 要请求**已完成**才有；`state:"pending"` 时先 `browse_wait` 或稍等再 `get`
- 敏感头（`cookie` / `authorization`）默认打码；要看真值需启动时 `AI_BROWSER_NETWORK_SENSITIVE=1`
- body 很大：先用 `filters` 收窄，再用 `include.body_limit` + `body_offset` 分页取
- 省内存可关抓包：`browse_network { operation:"configure", configure:{ enabled:false } }`
- `browse_evaluate` 替代不了它：evaluate 只看页面 JS 上下文，看不到网络层
- 页面自身 JS 报错（不是接口）看 `browse_errors`

## 从页面取结构化数据

优先级从高到低 —— **顺着这个顺序试，越靠前越稳、越省**：

1. **页面自己的数据模型**。很多 SPA 把数据挂在全局对象上：
   `browse_evaluate { js: "JSON.stringify(window.__NUXT__?.data ?? null)" }`
   拿到的是原始结构，比从 DOM 反推可靠一个数量级。
2. **背后的 API**。用 `browse_network` 抓到接口，再在 `browse_evaluate` 里 `fetch` 同一接口
   （注意带凭据：`credentials:'include'`）。
3. **语义树**。`browse_get_tree {subset:"interactive"}` 逐节点取 `label`/`value`。
   适合表格、列表这类结构规整的页面。
4. **截图 + 视觉**。只在上面全都不通时用，且要接受 token 成本。

`browse_evaluate` 的上限：5000 字符表达式（不是语句块），禁用 `process` / `require`。
要返回大对象就先在页面里 `JSON.stringify` 再切片取。

## 产出交付物

- 表格类结果直接给 Markdown 表或 JSON，不要贴截图。
- 需要下载文件：点下载后 `browse_downloads` 轮询拿落盘路径（下载是异步的）。

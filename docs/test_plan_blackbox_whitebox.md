# AI-Browser 黑盒 + 白盒测试文档

> 目标：对 AI-Browser ——"给人看的浏览器 + 给 Agent 看懂并稳定操作网页的结构化 API（不靠截图/OCR）"——建立一套**体系化**的测试规划与能力评估。
> 本文不是一份写死的测试代码，而是一份**可执行、可追溯、可扩展**的用例库：每条用例标明入口、场景、期望、以及与现有自动化资产（Vitest 单测 `U` / 真实 smoke `S` / 真实站点 E2E 脚本 `E` / 待补 `GAP`）的映射关系。

---

## 0. 被测系统与运行方式

| 项 | 值 |
|---|---|
| 架构 | Electron 33 + ESM；主进程 = WS JSON-RPC 服务 + CDP 网络监控；渲染端 preload = 语义提取/动作执行/事件观测 |
| 对外入口 | ① MCP server（`browse_*` 工具，stdio）② WS JSON-RPC（`ui.*`，`ws://127.0.0.1:9223`）③ Skills（read-webpage / web-network-monitor / content-publish） |
| 单测 | `npm test`（Vitest，jsdom 环境） |
| 集成真实层 | `npm run smoke`（真实 Electron + 本地 CSP 页，自包含，失败退出码非零） |
| 真实站点 E2E | `node e2e/e2e_realsites.cjs`（需已登录态，外网） |
| 分支 | 稳定：`main`/`v1` = `v6.9.0`(`134d490`)；开发：`dev` |

---

## 1. 测试分层策略（测试金字塔）

```
        ▲ 少而贵：真实站点 E2E（登录态/发布/抓包）—— E
     ▲▲  真实 WebContents 集成 smoke（CSP/extract/act/多标签）—— S
   ▲▲▲  单测（jsdom 纯逻辑：协议/提取/动作/观测/工具面）—— U
 █████████████████████████████████████████████
 手动/半自动：安全、并发、富编辑器、验证码 ——（本文大量用例落此层）
```

- **关键原则**：jsdom 单测只验证"函数在自造 DOM 里"的纯逻辑；**必须在真实 WebContents 验证的契约放 smoke**（历史上两次回归——preload ESM 崩溃、CSP 禁 eval——正是 jsdom 漏掉而真实层抓到的）。**落地规则**：凡涉及 Chromium 行为（CSP、网络、编辑器合成事件、真实可见性）的用例，不允许只写 jsdom 就宣称"已测"。

---

## 2. 黑盒测试（能力面 + 真实使用）

黑盒 = 从外部看系统行为，不关心内部实现。覆盖：能力清单 → 真实使用路径 → 异常边界 → 安全护栏 → 并发。

### 2.1 能力清单矩阵（入口 → 黑盒场景 → 期望 → 状态）

| 能力 | 入口 | 黑盒场景 | 成功判据 | 状态 |
|---|---|---|---|---|
| 导航 | `ui.navigate` / `browse_navigate` | 输入 http/https URL，等待加载 | 返回活动 tab；`get_tree` 反映新页面 | S/E |
| 取语义树 | `ui.get_tree` / `browse_get_tree` | 任意页面 | 返回非空树、节点含 `id/role/label/states/bounds` | U/S/E |
| 读正文 | Skill `read-webpage` | 文章页 | 以 `browse_evaluate` 跑正文脚本返回标题+正文+节选 | 手动 |
| 执行动作 | `ui.act` / `browse_act` | click/type/setContent/select/clear/focus/hover/scroll_to/submit/toggle | DOM 按真实期望变化（计数/值/焦点/禁用态） | U(部分)/S |
| 页面求值 | `ui.evaluate` / `browse_evaluate` | 任意 JS 表达式/函数 | 返回 JSON 值（含 CSP 严格站） | S |
| 事件订阅 | `ui.subscribe` / `browse_subscribe` | 订阅 dom_change/state_changed/captcha/message/js_error/network_response | 页面变化时收到对应事件 | 手动 |
| 抓包 | `browse_network_body`/Skill `web-network-monitor` | 触发行 {{a}} 接口 | 拿到请求/响应体 | 手动 |
| 等待 | `ui.wait` | 动态元素出现/消失 | 条件满足后返回 | 手动 |
| 滚动 | `ui.scroll` / `browse_scroll` | 长页面 | `scroll_y` 变化、树 relayout | 手动 |
| 标签 | `ui.{new,list,set_active,close}_tab` / `browse_*` | 多标签 CRUD + 切换 + 上下文切换 | 计数/活动态/`document.title`/URL 正确 | S |
| 发布 | Skill `content-publish` | 知乎/CSDN 等发布全流程 | 完成发布+校验信号 | 手动 |
| 退出 | `ui.quit` / `browse_quit` | 优雅退出 | 进程退出、WS 断开、清理子进程 | 手动 |

### 2.2 Agent 真实使用路径（端到端黑盒，编号 `BB-E2E`）

> 每条是一条"Agent 会真这么干"的完整链路，串多个能力。

- **BB-E2E-1 搜索→进站→交互**：搜索 → 取树 → 点结果 → 取树（换站）→ 填查询 → 点提交 → 校验结果在树上体现。*（已有 e2e 真站骨架，建议固定为契约）*
- **BB-E2E-2 表单全流程（发布）**：登录态 → 进创作中心 → 检测编辑器（contenteditable/Draft/ProseMirror/CodeMirror）→ 填标题+正文 → 发布 → 校验成功/审核信号。*（对应 Skill content-publish）*
- **BB-E2E-3 移动端/水合型 SPA**：React/Vue 受控组件 → 输入后 state 同步 → 树自更新（订阅 diff）。*（test_pages/react_spa.html）*
- **BB-E2E-4 多标签工作流**：多开 → 各 tab 独立上下文（树/evaluate/act）→ 交叉切换不串台 → 关闭清理。*（smoke 覆盖核心，扩展校验跨 tab 上下文隔离）*
- **BB-E2E-5 需登录的站**：百度/知乎等 → 登录态自动带 cookie（持久化）→ 操作不受阻。
- **BB-E2E-6 验证码/消息探测**：出现登录窗/验证 → `captcha_appeared`/`message_appeared` 事件上报。

### 2.3 异常与边界（`BB-ERR`）

| 用例 | 场景 | 期望 |
|---|---|---|
| ERR-1 离线/导航失败 | 无效域名、连接拒绝、404 | 返回明确 error，不挂起、不清 Pending |
| ERR-2 超时 | evaluate/导航挂起 | 有超时保护，返回超时 error |
| ERR-3 超大页面 | 大 DOM/长列表 | 树大小上限保护，不 OOM |
| ERR-4 动态加载 | 无限滚动、懒加载 | 事件驱动/轮询可等到新内容 |
| ERR-5 同源 iframe | iframe 页 | 递归进入；跨源 iframe 优雅跳过 |
| ERR-6 CSP/受限站 | Bing/Gmail 等 | get_tree 可用；evaluate 走 CDP 仍可用（已锁 smoke） |
| ERR-7 空白/渲染中页 | 空白页、loading 中 | extract 不报错；返回空树而非崩溃 |
| ERR-8 断连重连 | userData 会话重启 | cookie/登录态保留 |

### 2.4 安全与护栏（`BB-SEC`）

| 用例 | 场景 | 期望 |
|---|---|---|
| SEC-1 evaluate 注入拦截 | `process`/`require`/Node 对象作表达式 | MCP + WS 双层拦截，返回拒绝 |
| SEC-2 evaluate 长度上限 | 超长 JS | 截断/拒绝 |
| SEC-3 scroll 注入 | `scroll_to` 目标含 JS 载荷 | JSON 编码注入，不可执行 |
| SEC-4 data-ai-id 指纹 | 页面脚本读 `data-ai-id` | 仅作句柄，行为无副作用（审计中见 §5） |
| SEC-5 沙箱关闭面 | `nodeIntegration:false` + `contextIsolation:true` + `webSecurity:true` | 上述三项未被破坏（配置断言） |

### 2.5 并发 / 多客户端 / 多标签（`BB-CONC`）

| 用例 | 场景 | 期望 |
|---|---|---|
| CONC-1 多 WS 客户端同时订阅网络 | 2+ 客户端 subscribe | 各客户端各收各的一份，不重复广播（回归锁，见 WB-NET） |
| CONC-2 多标签并发请求 | 多 tab 同时 extract/act | request-id 匹配正确，不串台 |
| CONC-3 订阅退订 && 另一客户端 | A 退订/关 tab | 共享 debugger 不误 detach，B 仍收到（回归锁 `5d8ab00`） |

---

## 3. 白盒测试（结构级覆盖）

白盒 = 按实现分支设计用例，保证每个模块/关键分支被测。逐模块列**已覆盖**与**缺口(GAP)**。

### 3.1 协议与消息 `src/shared/protocol.js` —（Vitest 已覆盖，`U`）
Request/Response/Error/Event 构造、非法 JSON/版本校验、方法白名单、错误码（标准 + 自定义）。**GAP**：无——已达分支充分。

### 3.2 语义提取 `src/preload/extractor.cjs` —（`U` + 部分 `S`）
已覆盖：非空、计数、disabled 态、hidden 过滤、aria-label/title 优先级、label 截断、bounds、纯布局降噪、data-\* 保留、id 稳定、ARIA role 覆盖、focus 标记、空页、树体量。
**GAP**：可见性对 `visibility:hidden` 祖先继承链、`offscreen` 语义元素（见 §2.2 观察项，现靠 isPureLayout 兜底）、同源 iframe 递归、aria-expanded/hidden 动态态。

### 3.3 动作执行 `src/preload/actions.cjs` —（`U` + `S`）
已覆盖：click（原生+React 委托、需真实 Chromium 验证→smoke）、type/input、change、clear、select、focus、错误分支（无元素/非文本框）。
**GAP（重要）**：富编辑器 setContent 的 Draft/ProseMirror/CodeMirror 分支、`submit`/`toggle`/`hover`/`scroll_to` 分支、`keydown/keyup` 合成、受控组件原生 setter 路径的回归用例。

### 3.4 页面观测 `src/preload/watcher.cjs` —（`U`）
已覆盖：插入/移除 dom/state_changed、disabled 变化、无关变化不广播、stop 后不发。
**GAP**：5s 低频 captcha/message 扫描触发条件、500ms 防抖合并正确性（时间边界）、同 tab 多事件次序。**实测发现**：`js_error` 经 preload `window.onerror` 捕获在真实桌面下**失效**——`contextIsolation:true` 将 preload 世界与页面主世界隔离，页面抛错不会被 preload 的 `onerror` 捕获（smoke OB 实测 `captured=0`；jsdom 单测同 world 故通）。修法需走 CDP `Runtime.exceptionThrown` 事件，属功能修复而非测试任务（见 §5）。

### 3.5 网络监控 CDP `src/main/page_manager.js`（_cdpNetworkTabs/_networkSubscribers）—（**GAP**）
本次重构（每 tab 单例 + 订阅引用计数）**无可自动化测试**。需覆盖：首订阅 attach+`Network.enable`、末退订 tear down、多客户端各收各一份、关 tab 清理、getNetworkBody 跨会话定位不串台（回归锁 `890e715`/`5d8ab00`）——建议落 smoke。

### 3.6 生命周期 `src/main/page_manager.js` —（**GAP**，部分 smoke）
tab CRUD、request-id 并发匹配、`_pendingRequests` 清理、closeTab `_cleanupTabResources`（debugger detach + 缓存清理）、set_active 上下文切换。建议补：超时拒绝、未归请求清理、越界/重复 id。

### 3.7 WS 服务 `src/main/ws_server.js` —（**GAP**，`test_ws_protocol` 仅消息层）
方法路由是否存在性、未知方法 → 方法未找到错误、事件 `_broadcast` 派发、`ui.evaluate` 双护栏（长度/process/require）。极需真实或模拟 WS 客户端的契约测试。

### 3.8 preload 桥接 `src/preload/bridge.cjs` —（`S`）
真实 IPC 链路由 smoke 验证（extract/act/evaluate/backref）。**GAP**：错误透传形态、渲染进程崩溃/无 preload 时主进程行为。

### 3.9 MCP 工具面 `src/main/mcp_tools.js` —（`U`）
工具数=13、唯一名、核心 5 原语必在、无 read_article、描述/schema 最小化（token 守卫）。**GAP**：CallTool 的入参正常/非法分支、与 `ws_call` 的错误映射（部分靠手动）。

---

## 4. 测试资产总览与运行命令

| 资产 | 位置 | 覆盖 | 运行 | 状态 |
|---|---|---|---|---|
| 协议单测 | `tests/test_protocol.js` (14) | 协议/错误码 | `npm test` | U |
| 提取单测 | `tests/test_semantic_extractor.js` (16) | extractor | `npm test` | U |
| 动作单测 | `tests/test_action_binder.js` (10) | actions | `npm test` | U |
| 观测单测 | `tests/test_state_tracker.js` (5) | watcher | `npm test` | U |
| 工具面单测 | `tests/test_mcp_tools.js` (7) | MCP 工具 token 守卫 | `npm test` | U |
| WS 层单测 | `tests/test_ws_protocol.js` | 消息层 | `npm test` | U |
| **集成 smoke** | `e2e/smoke_ws.cjs` | 真实 WebContents 契约 | `npm run smoke` | S |
| 真实站点 E2E | `e2e/e2e_realsites.cjs` | 搜索/财经/多标签（真站） | `node e2e/e2e_realsites.cjs` | E |
| 本地 fixture 页 | `tests/test_pages/*` | SPA/cookie/动态/控件/iframe | 供 smoke/E2E | 辅助 |
| 清理 | `tests/_scratch.mjs` | 临时脏文件 | — | **建议删** |

---

## 5. 能力评估矩阵（黑盒 / 白盒覆盖度）

| 能力域 | 黑盒覆盖 | 白盒覆盖 | 主要缺口 / 风险 |
|---|---|---|---|
| 协议栈 | 高 | 高 | 无 |
| 语义提取 | 高(U) / 中(S) | 中 | visibility 继承 & offscreen 语义元素、iframe 递归 |
| **动作执行** | 中 | **低** | **富编辑器(Draft/ProseMirror/CodeMirror)/submit/toggle 无自动化** |
| 页面观测 | 中 | 中 | 防抖边界、低频扫描、JS error 捕获无自动化 |
| CDP 网络监控 | 低 | **极低** | **重构后无可视测试，串台回归只靠手动** |
| 生命周期 | 中(S) | 低 | request-id/Pending 清理、超时无白盒 |
| WS 服务 | 低 | **极低** | 路由/未知方法/护栏无自动化 |
| evaluate 安全护栏 | 中 | 低 | 注入拦截无契约测试 |
| 多客户端/并发 | 低 | 低 | 订阅隔离仅理论，无真实多客户端 |
| 登录/会话/验证码 | 低 | — | 靠真人手动，未固化 |

---

## 6. 落地路线（GAP → 自动化，按风险排序）

1. **P0** 网络监控 & 生命周期落 smoke（回归锁：跨会话拿 body、订阅退订不误 detach、关 tab 清理、多客户端各收一份）。
2. **P0** evaluate 安全护栏契约测试（length/process/require 注入 → 拒绝）。
3. **P1** 动作执行补富编辑器（ProseMirror/CodeMirror）路径到 smoke + 单测分支。
4. **P1** 把 `e2e_realsites` 收敛成可断言的契约脚本（目前手输）。
5. **P1** captcha/js_error 观测事件落 smoke（本地 fixture 造 reader-visible 提示）。
6. **P2** 删 `tests/_scratch.mjs`；版本号单一化（`package.json` vs `v6.9.0`）。
7. **P2** 将 §2.2 的 BB-E2E 主链路固化为可复跑真实脚本，视网络环境编入 CI。

> **不落地的已知项（防御为改而改）**：手写 extractor 与 CDP AX 树的取舍——经真实页核对（data-ai-id 可回溯、可见性过滤准确）后判定**维持现状**；`offscreen 语义元素`列入观察，不改代码。

---

_维护：随 `dev` 演进更新“状态”列；每合入一个修复，把对应回归用例从「手动/待补」提升为自动化。_
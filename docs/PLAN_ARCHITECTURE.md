# AI Browser 架构方案（v2）

> 版本：v2 · 面向 `1.2.x`
> **关键更正（项目所有者）**：「就是 ai 操作的，**不是人机共架**，**现在的项目实现就已经是我说的这个效果了啊**」。
> 「人可见、可手动介入」是**已经成立的现状**，是要被**守护**的约束，**不是要被建造的功能**。
> 因此本文**不包含**任何交接协议 / 控制权状态机 / 新增 MCP 工具 / 给人做的新 UI。v1 中的 `Control Arbitrator` 整章已作废移除。
> 本文重心：**守护不变量 + 还掉三笔工程债**（`page_manager.js` 上帝对象、读层新旧双轨、核心零单测且无 CI）。
> 现状基线：`src/` 3951 行 / 16 文件；`npm test` 127 例全绿；`page_manager.js` 1180 行零单测；MCP 13 工具。

---

## 0. 前提更正与本次架构工作的范围

v1 的错误在于把「人要能看见、能操作」当成了需要新建协作协议的需求。它不是——它已经是现状（真实可见的窗口 + 防遮挡开关 + 受信输入 + tab 条 + 登录态持久化）。人机协作发生在 **agent 的对话里**：agent 说一句人话，人去那个看得见的窗口里操作，做完了回一句。浏览器这侧不需要新增任何东西。

所以架构工作重定义为两件事：

1. **守护**：把"人可见、可手动操作"固化为**不可违反的约束**，并让它**可被自动化验证**（§1）。
2. **还债**：三笔与定位无关、但直接决定"稳定、可维护、GitHub 上大众可用"的工程债（§2 契约、§3 拆分、§4 读层、§5 稳定性、§6 测试与 CI）。

三笔债是真实且独立的：`page_manager.js` 1180 行零单测（改不动、不敢改）、读层新旧两条并存且默认走旧的（行为不可预期、适配债只增不减）、核心零单测且 e2e 依赖真实站点（贡献者无法验证自己的改动、CI 无法在断网下通过）。

---

## 1. 不变量守护：人可见、可手动操作

从产品方案 §2 承接，本节把它落到**代码位置**与**可执行的验证**上。

### 1.1 守护清单（含代码位置）

| # | 机制 | 代码位置 | 守护要求 |
|---|---|---|---|
| I1 | **headless 化 / 隐藏窗口** | `src/main/index.js:73` 创建的 BrowserWindow 无隐藏参数 | **禁止**引入任何 headless 模式、`show:false`、后台运行的"优化"。这是产品定义，不是配置项 |
| I2 | **网络看门狗 `app.relaunch()`** | `src/main/index.js:180-198`：每 30s 探测 `https://example.com/`，连续 3 次失败即 `app.relaunch() + app.exit(0)`，最快 **~65 秒**重启（`spin()` 在创建窗口时立即跑一次，三次失败落在 t≈5/35/65s） | **唯一真正要改代码的止血项**，要求见 §1.2 |
| I3 | **窗口被遮挡导致输入丢失** | `src/main/index.js:37-39` 三个开关：`disable-backgrounding-occluded-windows` / `disable-renderer-backgrounding` / `disable-background-timer-throttling` | **不得退化**。它们不是性能优化，是"人能看到、agent 能输入"的前提。任何"省电/提性能"删掉它们的 PR 都应被拒绝 |
| I4 | **单实例锁抢焦点** | `src/main/index.js:63-71`：`second-instance` 时 `restore() + focus()` | 保留。人想手动操作时把窗口调到前台符合预期 |
| I5 | **GPU 加速关闭** | `src/main/index.js:20` `disableHardwareAcceleration()` | 保留。防崩溃的稳定性措施，别为渲染性能开回来 |
| I6 | **tab 条** | `src/renderer/tab_bar.html`，36px，人可切标签/新建/关闭 | 保留。**不新增**给人用的 UI（地址栏、设置面板、聊天框、状态灯、横幅、接管按钮一律不做）。人用的就是页面本身和这个 tab 条 |

### 1.2 I2 看门狗止血（严格四件小事，不扩大成机制）

问题：人正在扫码登录 / 过滑块 / 填表单时，网络抖动会让浏览器在人毫无察觉的情况下自我重启，登录态与操作上下文全丢。这是对"人可手动介入"最直接的破坏。

1. `WATCHDOG_FAIL_LIMIT` **3 → 5**（间隔保持 30s，最快重启从 **~65 秒**推迟到 **~2 分钟**，五次失败落在 t≈5/35/65/95/125s）。
   理由：`example.com` 在国内网络下本身会偶发超时，3 次阈值太敏感——这很可能就是"浏览器莫名重启"投诉的真实来源。
2. 探测目标改为读 `AI_BROWSER_WATCHDOG_URLS`（**逗号分隔、支持多个**），默认 `['https://example.com/', 'https://www.baidu.com/']`；**任一目标可达即视为网络存活**，只有整轮全失败才计一次失败。
   理由：看门狗只需要 NetworkService 能往返，不需要特定主机。单 host 在国内不可靠，正是"假死判定 → 重启循环"的来源；多目标把误判率再降一个量级。用户也可整体指向自己网络下稳定的地址。
   注：v2 初稿写的是单数 `AI_BROWSER_WATCHDOG_URL` 单目标；实现采用了复数多目标，本条以实现的复数形式为准。
3. **`AI_BROWSER_WATCHDOG=0` 逃生开关**：置 0 时完全不启动看门狗（不注册 interval、不做探测）。
   理由：给 GitHub 用户一个自救手段，成本两行——遇到某网络环境下反复误重启时不必等我们发版。**它是启动期的静态总开关**（把"要不要装这个定时器"的决定权交给用户），**不是运行期状态判断**，改完需重启生效。
4. README 的 Troubleshooting 写明该自愈行为的存在与配置方式（含上述两个 env）。

**明确不做**：不检测"人正在操作吗"、不做**运行期**的暂停开关、不引入任何**与人相关的联动判断**——那是给一个自愈机制加协议，本末倒置。
（第 3 条的 `AI_BROWSER_WATCHDOG=0` **不违反**这条：它是启动期静态总开关，只决定"装不装这个定时器"，不判断任何运行期状态，也与人是否在场无关。）

**已裁决并落地**：看门狗**不做**任何"推断人在操作就推迟重启"的逻辑。

曾有一个 `shouldDeferRelaunch({ windowFocused, idleSeconds })` 的实现（窗口聚焦 + 系统空闲时间低 → 推断人在操作 → 推迟 relaunch），已被移除。除了违反上面"明确不做"这条，它还是**反效**的：

> `page_manager.js` 的 `_inputViaCdp` / `peek` 每次 agent 操作都会调 `window.show()/moveTop()/focus()`，所以"窗口聚焦"很可能是 **agent 在用而不是人在用**。
> 后果：人坐在电脑前看 agent 干活（最常见场景）时恒定 defer → **看门狗永远不重启**，自愈能力在最需要它的时候失效；而真正"人在扫码"时 agent 处于阻塞等待、未必抢焦点，该保护的场景反而覆盖不到。

`tests/test_invariants.js` 中有一条断言守着它不复发（`watchdog.js` 不得再出现 `shouldDeferRelaunch`）。**不要把它加回来**——若将来真要区分"谁在用"，必须先解决 agent 抢焦点这个根本问题，而不是靠 `isFocused()` 猜。

### 1.3 关于 `browse_quit`：不改

**agent 拥有进程生命周期是既定设计，不改。** 不做"有人在场就拒绝退出"。
理由：agent 无从判断人是否在场（引入判断就是引入协议），而拒绝对 agent 而言是一个**无法理解、无法恢复**的失败。

处理方式只有一条：README 写明语义 ——

> `browse_quit` 会关闭整个浏览器窗口和进程，是 agent 在任务结束时释放资源用的。如果你（人）正在窗口里手动操作，请直接告诉 agent「先别 quit」。

一句话文档胜过一段无法可靠实现的逻辑。

### 1.4 把不变量变成可执行的东西（本节唯一的架构新增）

守护条款写在文档里会被下一个 PR 悄悄违反。所以新增 `tests/test_invariants.js`：**静态源码扫描断言**，零运行时依赖、毫秒级、不需要起 Electron。

```js
// tests/test_invariants.js —— 不变量的回归网
// I1 无 headless / 无隐藏窗口
expect(src('src/main/index.js')).not.toMatch(/show:\s*false|headless/i);
// I3 三个防遮挡开关必须都在
for (const sw of ['disable-backgrounding-occluded-windows',
                  'disable-renderer-backgrounding',
                  'disable-background-timer-throttling'])
  expect(src('src/main/index.js')).toContain(sw);
// I5 GPU 加速保持关闭
expect(src('src/main/index.js')).toContain('disableHardwareAcceleration()');
// I2 看门狗阈值不得被调回敏感值
expect(wdFailLimit()).toBeGreaterThanOrEqual(5);
// I2 逃生开关分支必须存在（不得被"简化配置"删掉）
expect(cfgKeys()).toContain('AI_BROWSER_WATCHDOG');
// I2 看门狗不得重新引入"人工状态判断"（见 §1.2 待裁决项）
expect(src('src/shared/watchdog.js')).not.toContain('shouldDeferRelaunch');
// I6 tab 条存在
expect(exists('src/renderer/tab_bar.html')).toBe(true);
```

理由：不变量的敌人不是设计错误，是**三个月后某个"顺手清理"的 PR**。10 行静态断言的成本远低于一次回归排查。

---

## 2. 契约与协议收口

### 2.1 MCP 收不到实时事件 —— 决策：事件搭车 `get_tree`，MCP 工具数 **0 新增**

现状：`browse_subscribe` 能订阅，但 `src/main/mcp_ws.js:59` 丢弃所有无 id 推送 → MCP 路径**收不到任何实时事件**，而 `browse_subscribe` 在工具列表里承诺了这件事。

| 方案 | 判定 |
|---|---|
| (a) MCP notification 推送 | ❌ stdio 客户端（Claude Code / Cursor / Codex）对 server→client notification 处理参差，多数直接丢弃；`notifications/*` 语义也不匹配 |
| **(b) 事件搭车 `get_tree`** | ✅ **选它**。MCP 心智模型就是"agent 拉"，而 agent 每步本来就要读树，顺带把"这段时间发生了什么"带回，零额外往返、零新增工具 |
| (c) 独立 `browse_events` 轮询工具 | ❌ 会突破"MCP 保持 13"的硬约束 |
| (d) MCP resources `browser://events` | ❌ 需客户端支持 resources 订阅，覆盖面最差 |

服务端做 seq 环形缓冲 + **per-session 游标**：每次 `get_tree` 返回 `[lastSeq, now]` 区间的事件并推进游标，上限 200。

```js
// src/main/event_log.js —— 零依赖
class EventLog {
  push(event: string, data: object): number                 // 返回单调 seq
  since(seq: number, {limit=50, events?}): { seq, events }  // raw ws: ui.events
  drain(sessionId, {limit=50}): { seq, events }             // 读并推进该 session 游标
  latestSeq(): number
}
```

侧效：天然支持"离开 10 分钟回来再看"——期间的累积事件一次带回。
`ui.subscribe` 保持给 raw WS 客户端用；README 需写明 **MCP 路径下 `browse_subscribe` 无实际效果**（当前工具描述有误导）。

### 2.2 `ui.*` 增量清单

| 方法 | 变化 | 说明 |
|---|---|---|
| `ui.events` | **新增**（仅此一个） | raw WS 轮询事件缓冲；MCP 侧走 `get_tree.context.events` 搭车 |
| `ui.get_tree` | 修改 | `context` 补齐 `events`；形状统一（见 §2.4）；读层默认切换见 §4 |
| `ui.wait` | 修改 | 改走读层门面（现在硬编码走旧 extractor）；`button_enabled` 的 `target` 支持 `data-ai-id` 精确匹配（现在是 label 子串，重名即错），保留子串回落以兼容 |
| `ui.act` / `ui.navigate` / `ui.evaluate` 等 | **不改** | v1 的仲裁门控随 `control.js` 一并作废 |
| **`ui.screenshot`** | **删除** | 从未实现的死契约，与"不截图、不 OCR"的定位冲突。**三处必须一起删**：`src/shared/protocol.js:58`（`VALID_METHODS`）、`docs/SPEC.md:73`、`docs/WHITEPAPER.md:93`。只删 protocol 会让两份文档立刻变成错误文档 |

### 2.3 MCP：保持 13 个工具，一个都不加

`ui.peek` 已实现并路由、但不在 13 个 MCP 工具里 —— 这是真实缺陷，但在"工具数锁 13"的约束下，**P1 只做文档化**：在 README 的 Raw WebSocket API 一节写明 `ui.peek` 的存在与用法，MCP 用户暂不可用。

**未来换入候选（2.0 breaking change，本次不做）**：`browse_subscribe` 在 MCP 路径实质无效（§2.1），是换出 `browse_peek` 的天然候选。工具数不变、净能力提升。现在不动是因为改工具列表是破坏性变更，要随主版本号一起发。

### 2.4 `TreeContext` 统一（消掉两条读层路径的形状分裂）

现状：`ax:true` 路径返回 `context.stats={layer:'ax'}`、`session={}`，旧路径形状不同 → 调用方无法一致地读 `context`。

新增 `src/shared/tree_contract.js` 作为**唯一真源**，两条路径的产出都经 `normalizeContext()` 补齐成同构：

```ts
type TreeContext = {
  url: string; title: string; tab_id: number;
  modals:  Modal[];                 // AX: role=dialog|alertdialog（旧: class 关键词表，迁移期保留）
  forms:   Form[];                  // AX 路径允许为 []
  session: { logged_in: boolean|null; user: string|null };   // 两条路径都必须有这个键
  stats:   { layer:'ax'|'legacy'; nodes:number; interactive:number;
             truncated:boolean; elapsed_ms:number };         // 统一键名，消掉 {layer:'ax'} 与 {} 的分裂
  events:  { seq:number; items:[{seq, ts, event, data}] };   // 新增：搭车事件
  warnings: string[];               // 唯一告警出口，替代散落的 console.error 与静默 catch
}
```

新增错误码：无。仲裁相关的 `-32010`~`-32015` 随 `control.js` 一并作废。

### 2.5 P2 可选：`context.human_required` 纯提示字段

唯一合规的形态：**只在 `get_tree` 的 `context` 里多一个字段，不阻塞任何调用、不新增工具、不做 UI、不做升级逻辑。**

```ts
human_required: {
  kind: 'login'|'captcha'|'sms'|'2fa'|'payment'|'risk'|'identity'|'other'|null;
  confidence: number;     // 0..1
  signals: string[];      // 命中证据，让 agent 自行判断可信度
}
```

价值：agent 下一次读树自然看见"这页面可能需要人"，然后**在对话里**向用户求助——协作仍然发生在 agent 侧，浏览器不参与。
检测器只做 4 个高置信信号：登录页/二维码（URL 命中 `passport.|login.|qrconnect` + 二维码图面积 >150²）、滑块（关键词 AND 可见且 ≥100×40 AND 文案命中）、Cloudflare/reCAPTCHA/hCaptcha（iframe src 极准）、HTTP 403/429/419（复用已有 `Network.responseReceived`）。
验收：10 个常见站点误报 ≤ 1。误报的代价是 agent 白问一句，可接受；漏报的代价是 agent 死循环重试，所以宁可窄。

---

## 3. `page_manager.js` 拆分方案

### 3.1 目标模块划分

```
src/main/
  index.js            # Electron 生命周期 / 窗口 / 看门狗（纯编排，不碰业务）
  event_log.js        # ★新增 事件环形缓冲 + per-session 游标  → 零依赖
  tree_contract.js    # ★新增（放 shared/）                    → 零依赖
  tab_registry.js     # tab 生命周期 + 布局                    → electron
  cdp_session.js      # 每 tab debugger attach/detach/domain 引用计数 → electron
  frame_resolver.js   # OOPIF 帧归属 / 坐标换算 / 帧内执行      → cdp_session
  read_layer.js       # 读层门面 getTree/getFocused             → ax_reader, legacy_reader, frame_resolver
  ax_reader.js        # 即现有 axExtractor.js（原地保留，纯函数已有单测）
  legacy_reader.js    # 旧 preload 读层（迁移期）               → ipc_bridge
  act_layer.js        # 操作门面 executeAction/peek             → cdp_input, frame_resolver, legacy_actions
  cdp_input.js        # 受信输入 pointer/key/text/upload/clear    → cdp_session
  legacy_actions.js   # preload actions.cjs 调用（迁移期）
  network_monitor.js  # Network/Runtime 域 + request map + getNetworkBody → cdp_session
  ipc_bridge.js       # ipcMain 请求 id 匹配 + 泛型 request()    → electron
  page_manager.js     # 瘦身为组合根（facade，≤200 行），只持有模块引用
  ws_server.js        # switch → METHODS 路由表
```

**谁持有状态**（`page_manager` 本身不再持有任何业务状态）：

| 模块 | 状态 |
|---|---|
| `tab_registry` | `tabs Map` / `activeTab` / `tabCounter` / `_openedTabs` / `_preloadPath` |
| `cdp_session` | `_cdpTabs Map(tabId → {wc, domains:Set})` |
| `network_monitor` | `_networkRequestMap` / `_networkSubscribers` / `_runtimeSubscribers` |
| `read_layer` | `_axDiffCache` |
| `event_log` | 环形缓冲 + seq + per-session 游标 |

**依赖方向（单向，无环）**：
`page_manager → {read_layer, act_layer, tab_registry, network_monitor}`
`act_layer → {cdp_input, frame_resolver, legacy_actions}`
`read_layer → {ax_reader, legacy_reader, frame_resolver, cdp_session}`
`cdp_input / frame_resolver → {cdp_session}`

用 `tests/test_arch_boundaries.js`（20 行正则扫 import）断言无反向依赖，成本近乎零。

### 3.2 安全拆分步骤

**前提事实**：现有 127 个单测**没有一个 import `PageManager`**（已核实）。所以拆分对单测零影响，风险全在 e2e smoke 与真实行为上。因此：

**Step 0（前置，必做）**：给 `page_manager.js` 的对外方法补"行为锁定测试"。
新增 `tests/_helpers/fake_electron.js`（假 `BrowserView` + 假 `webContents.debugger.sendCommand` 返回 fixture + 真 `ipcMain` 打桩），覆盖：`navigate` / `getTree`(ax+legacy) / `executeAction`(click/type/clear/upload) / `newTab` / `closeTab` / `setActive` / `listTabs` / `getNetworkBody`，约 20 例。
**这是能安全拆分的唯一前提 —— 没有它，后面每一步都是在盲拆。**

Step 1–9（每步一个 commit，纯搬移 + 委托，diff 可读，可独立 `git revert`）：

| Step | 搬出内容 | gate |
|---|---|---|
| 1 | `tab_registry`：`newTab/closeTab/listTabs/setActive/_layoutView/_layoutAllViews/_forceRepaint/_getView/_sendToView` | test + smoke |
| 2 | `cdp_session`：`_ensureCdp/_teardownCdpIfIdle/_canCdp/_cdpTabs` | 同上 |
| 3 | `ipc_bridge`：`_setupIPC/_pendingRequests/_requestId` + 抽出泛型 `request(tabId, channel, payload, timeoutMs)` | 同上 |
| 4 | `network_monitor`：`_startNetworkMonitor/_stop*/_onCdpMessage/getNetworkBody/_networkRequestMap`；`_cleanupTabResources` 拆成 registry 回调 | 同上 |
| 5 | `frame_resolver`：`_owningFrame/_frameOffset/_readOopifFrames`；**顺带修 OOPIF 补丁堆**（见下） | + `e2e/oopif_multi_iframe.mjs` |
| 6 | `cdp_input`：`_cdpPointerTarget/_inputViaCdp/_typeChars/_cdpKey/_selectAllFallback/_clearInFrame/_uploadViaCdp/_resolveClickByUrl/_ensureAxHandles` | + `e2e/cdp_input_regress.mjs` |
| 7 | `read_layer`：`getTree/getTreeViaAx/getFocused/_liteFromTree` + `normalizeContext` 统一 | 同上 |
| 8 | `act_layer`：`executeAction/peek/_consumeOpenedTab`；**`catch {}` 静默 fallback 改为显式 `warnings`** | 同上 |
| 9 | `page_manager` 瘦身 facade；`ws_server` switch → 路由表 | + 5 站点全量冒烟 |

**顺带修掉的 OOPIF 补丁堆（Step 5）**：
现在链路是 `axf-{seq}-{idx}` → 对每个 frame 跑一次 `executeJavaScript` 探测归属 → `_frameOffset` 用 `location.pathname` 匹配 iframe src（启发式，同名 iframe 会错）→ 坐标换算 → 命中校验，五层堆叠。
改成：**打标时把 `frame.frameTreeNodeId` 写进 id** → `axf-{frameTreeNodeId}-{idx}`，`resolve(aiId)` 直接按 treeNodeId 在 `framesInSubtree` 里查，一次命中，删掉 pathname 启发式和逐帧探测（后者是 O(frames) 次跨进程 JS 调用）。坐标仍要 iframe offset，但那是必要的。

**Step 8 的静默 fallback**：现在 CDP 输入失败后 `catch {}` 静默回落到 `preload/actions.cjs` 白名单代码，agent 完全不知情。改为把回落记录进返回值的 `warnings` 与 `context.warnings`，行为不变但可见。

---

## 4. 读层收口到 AX 的迁移路径

策略：**双跑对照（shadow）→ 灰度默认 → 删旧**。不做"择日一刀切默认切换"（理由：真实站差异大，一刀切出问题只能全量回滚，代价不可控）。

新增 `AI_BROWSER_READ_LAYER = legacy | ax | shadow`，默认 `legacy`（当前行为零变化）。

**Stage A — 对照（shadow）**：主路径仍返回 legacy 结果，并发跑一次 AX，比较后写 `event_log`：

```jsonc
{"event":"read.drift","data":{"tab":1,"url":"...","legacy_nodes":412,"ax_nodes":180,
  "missing_in_ax":[{"role":"button","label":"发布"}],
  "missing_in_legacy":[{"role":"link","label":"创作中心"}],
  "jaccard":0.93,"equal":false,"elapsed_ms":41}}
```

**比较口径（只比这三项，其余不比）**：
1. **可交互节点集合**（role ∈ button/link/textbox/checkbox/radio/combobox/menuitem）的 `(role,label)` 多重集 Jaccard；
2. `data-ai-id` 解析成功率（能否被操作层定位到真元素）；
3. `context.modals`。

理由：比"两棵树全等"必然全不等（两棵树粒度不同），比这三项才等价于"agent 能否完成同样的任务"。

**Stage B — 灰度默认**：连续 20 个真实站样本满足 `jaccard ≥ 0.9` 且解析成功率 ≥ legacy → 默认切 `ax`。
**必须保留逃生开关**：`AI_BROWSER_READ_LAYER=legacy` 或 `ui.get_tree {layer:'legacy'}`。
理由：GitHub 上的用户遇到某站 AX 抽风时得有自救手段，否则只能等我们发版。

**Stage C — 删旧**：默认 ax 稳定一个 minor 版本后，删 `extractor.cjs` 的启发式部分（class 关键词表 / 编辑器白名单 / 中文短语表 / 红色星号 `::before` 扫描 / 两套 iframe 逻辑）与 `legacy_reader.js`。`actions.cjs` 保留作 fallback 兜底（缩到 execCommand/Draft 两条），但它不再被静默调用。

**回滚**：Stage A/B 任意时刻改 env 即回滚，零代码变更；Stage C 之后靠 `git revert`。
**等价验证清单**（`tools/read_parity.mjs` + `e2e/realsites`）：B站写文章、知乎编辑器、GitHub、CSDN、一个 antd 后台、一个含跨域 iframe 的页 —— 6 站 × 3 项指标。

---

## 5. 稳定性

### 5.1 网络看门狗 —— 只做 §1.2 那三件小事

不检测人工操作、不加暂停开关、不引入任何状态判断。只做：阈值 3→5、URL 可配置、README 告知。

### 5.2 `browse_quit` —— 不改

见 §1.3。只改文档。

### 5.3 崩溃恢复 & 单实例锁

- **tab 级 `render-process-gone`**：现在只 `console.error`（`src/main/index.js:141-145`）。改成自动 `tab_registry.reload(tabId)`（重建 BrowserView、回原 URL、**保留 tabId**），广播 `tab.crashed {tabId, url, recovered:true}`。理由：崩溃后留一个白屏 tab 比重建更糟，且 agent 侧只认 tabId。
- **主进程崩溃**：靠 MCP 侧 `ensureElectronRunning` 重连（已有）+ 新增 `~/.ai-browser/sessions/last.json` 自动恢复上次标签页（`AI_BROWSER_RESTORE_SESSION=0` 可关）。
- **单实例锁**：`src/main/index.js:63` 取了 `gotLock` 却没用 → 两个 Electron 会抢同一个 9223 端口，agent 随机连到一个、tab 状态分裂。改成 `!gotLock` 时**只 focus 已有窗口然后退出**。Electron 的锁已按 userData 路径区分，不同 `AI_BROWSER_USER_DATA` 天然隔离。注意保留 I4 的 `restore() + focus()` 行为。

### 5.4 数据持久化与隐私

```
~/.ai-browser/
  partitions/default/          # persist:ai-browser-default
  partitions/<profile>/        # AI_BROWSER_PROFILE=<name>
  sessions/last.json           # 崩溃/退出快照（URL+title+scrollY，无表单/cookie）
  config.json                  # 用户级：读层默认、watchdog URL
  logs/app.log                 # AI_BROWSER_LOG=1 才写，默认关
```

- `partition` 现在硬编码 `persist:ai-browser` → 改 `persist:ai-browser-${profile}`。理由：多项目 / 多账号隔离（"同时跑个人号和工作号"是真实需求）。
- **快照不写 cookies、不写表单内容**，只写 URL + title + scrollY。理由：写表单等于把密码落盘。
- **不新增 `browse_clear_session` 工具**（工具数锁 13）：换 profile 目录比清理更安全，用 `npm run session:clear` CLI + `AI_BROWSER_PROFILE` 解决。

### 5.5 WS 鉴权（P2）

`ws://localhost:9223` 现在完全**无鉴权**：本机任意进程都能驱动一个含登录态的浏览器，且 DNS rebinding 可绕过 localhost 限制；`ui.evaluate` 是任意 JS 执行。这是真实风险不是理论风险。
P2 加可选 `AI_BROWSER_TOKEN`，非空时要求连接握手带 token。**在修好之前，README 必须写明"不建议在不可信网络环境使用"**。

---

## 6. 测试策略与 CI

### 6.1 分层与比例（目标）

| 层 | 占比 | 覆盖 | 工具 | CI |
|---|---|---|---|---|
| **L0 不变量** | — | `tests/test_invariants.js` 静态源码扫描（§1.4）+ `test_arch_boundaries.js` | vitest node | ✅ |
| **L1 纯函数** | 55% | axExtractor 归一化/差分/过滤、`protocol`、`guards`、`config`、`event_log` 环形缓冲、`tree_contract` | vitest node | ✅ |
| **L2 模块级（假 electron）** | 25% | 拆分后各模块对外行为：`tab_registry` 用假 BrowserView、`cdp_session` 用假 debugger、`frame_resolver` 断言 treeNodeId 直达 | vitest + `fake_electron.js` | ✅ |
| **L3 jsdom** | 10% | preload 层（现有 100+ 例），随 legacy 删除逐步减少 | vitest jsdom | ✅ |
| **L4 真实 Electron e2e** | 8% | 真 Electron + 真 WS + **本地 fixture 页面**（含 iframe/OOPIF/表单/模态） | node + ws | ✅ macOS + Linux(xvfb) |
| **L5 真实站金丝雀** | 2% | 6 站 × 3 指标（读层对照 + 关键流） | `npm run realsites` | ⛔ nightly / 手动，`continue-on-error` |

**关键取舍：L4 的 fixture 页必须是本地 HTML，不依赖网络。**
现在 `e2e/` 里大量 `bili_*` 直接打真实 B站 —— CI 上必然 flaky。这是"GitHub 上大家能用"的硬门槛：**外部贡献者在断网下跑 CI 也必须全绿**。联网用例统一打 `@network` tag，`vitest --exclude` 在 CI 跳过，本地 `npm run test:network` 才跑。

### 6.2 CI 设计（`.github/workflows/ci.yml`）

```yaml
jobs:
  unit:                       # L0–L3
    strategy: { matrix: { os: [ubuntu-latest, macos-latest], node: [20] } }
    steps: [checkout, npm ci, npm test, npm run lint]
  e2e:                        # L4
    strategy: { matrix: { os: [ubuntu-latest, macos-latest] } }
    steps:
      - run: npm ci
      - run: xvfb-run --auto-servernum npm run smoke   # Linux
        if: matrix.os == 'ubuntu-latest'
      - run: npm run smoke                              # macOS
        if: matrix.os == 'macos-latest'
  canary:                     # L5
    if: github.event_name == 'schedule' || inputs.run_canary
    continue-on-error: true
    steps: [npm ci, npm run realsites]
```

- **明确不做 Windows CI**：现有 0 个 Windows 用例 + 无可用硬件，加了只会常红。README 的兼容性表相应降级为 `experimental / untested`（现状写的是 "Windows expected to work"，是从未实测的虚假承诺）。
- Linux e2e 若第一周 flaky 率高，先标 `continue-on-error: true` 观察，不要硬扛。
- 新增 `npm run lint`（eslint，只开 `no-unused-vars` / `no-undef`）。理由：大众项目的准入门槛。
- 覆盖率只卡 L1+L2 ≥ 70%，**不追 90%**。理由：Electron 项目的真实保障在 L4/L5，单测覆盖率数字意义有限。

---

## 7. 分阶段路线图

### P0 — 止血与守护 ★（改动最小、价值最高）

**产出**：① 看门狗四件小事（§1.2）；② `tests/test_invariants.js` 守护测试（§1.4）；③ `docs/SPEC.md` 重写（现版本描述的模块文件名全不存在，且写着"为什么不用 CDP"三条理由，与现实相反——项目重度依赖 CDP，`evaluate` 首选 CDP 是因为页面 CSP 会拦 preload 里的 `eval`）；④ README 的三处事实修正：单测数 127（现写 100）、Windows 降级为 untested、`browse_quit` 语义说明（§1.3）+ 自愈行为说明（含 `AI_BROWSER_WATCHDOG_URL` 与 `AI_BROWSER_WATCHDOG=0`）。

> 文档事实修正顺带覆盖 `docs/WHITEPAPER.md`：它的 `ui.*` 方法清单里 `ui.screenshot`（:93）是死契约（P1 随三处同步删除），示例中的 id 形如 `e:btn-42` 也与现状的 `ax-{backendDOMNodeId}` 不符。

**验收**：`npm test` 全绿（含新增守护测试）；故意删掉一个防遮挡开关 → 守护测试**失败**；`example.com` 不可达时浏览器不再于 65 秒内重启（改为 ~2 分钟）；`AI_BROWSER_WATCHDOG=0` 时看门狗完全不启动。

**依赖**：无。**回滚**：三项改动各自独立 revert。

### P1 — 契约收口

**产出**：`tree_contract.js` + `normalizeContext()` 统一双路径 `context`；`event_log.js` + `ui.events` + MCP 侧搭车 `get_tree.context.events`；删除 `ui.screenshot` 死契约（**三处同步**：`protocol.js` / `SPEC.md` / `WHITEPAPER.md`）；`ui.wait` 走读层门面 + `target` 支持 data-ai-id；README 写明 `ui.peek` 仅 raw WS 可用、`browse_subscribe` 在 MCP 路径无实际效果。

**验收**：`tests/test_tree_contract.js` 断言 ax / legacy 两条路径产出同构（尤 `session`、`stats.layer`、`events` 不缺键）；注入一个 DOM 变更事件后，`browse_get_tree` 的 `context.events` 能取到它。**依赖**：P0。**回滚**：逐项 revert。

### P2 — `page_manager.js` 拆分（Step 0–9）

**产出**：Step 0 的 20 例行为锁定测试 + 9 个新模块 + facade（≤200 行）+ `ws_server` 路由表化 + `tests/test_arch_boundaries.js`；顺带修 OOPIF 补丁堆（Step 5）与静默 fallback（Step 8）。

**验收**：127 旧单测 + 新增 ≥150 例全绿；`smoke` + 5 个 e2e 脚本绿；`page_manager.js` ≤ 200 行。**依赖**：P1（先收口契约再拆，否则拆的过程中契约还在变）。**回滚**：每 Step 一个 commit，独立 `git revert`。

### P3 — 读层收口 + 安全

**产出**：`AI_BROWSER_READ_LAYER` 三档 + `read.drift` 事件 + `tools/read_parity.mjs`；默认切 ax 后删旧 extractor；`context.human_required` 纯提示字段（§2.5，4 个高置信检测器）；WS 可选鉴权 `AI_BROWSER_TOKEN` + `SECURITY.md`。

**验收**：6 站 Jaccard ≥ 0.9；检测器 10 站误报 ≤ 1；带 token 时无 token 连接被拒。**依赖**：P2。**回滚**：env 切回 `legacy`；其余逐项 revert。

### P4 — 稳定性与开源可用性

**产出**：会话快照 + tab 崩溃自动恢复 + 主进程崩溃恢复；profile 分区；`!gotLock` 行为修正；CI + lint + 本地 fixture 页；**清理 `e2e/` 58 个一次性探针（保留 ≤12 个）、删除 `src/core` / `src/server` / `src/protocol` 三个空目录、清理根目录 `douyin_*.cjs` 一次性脚本**；`README_CN.md` + `CONTRIBUTING.md`（含**核心 vs skills 边界**）+ ISSUE/PR 模板（含 `site_report` 模板——本项目最高频 issue 是"某个站点跑不通"）。

**验收**：CI 在 ubuntu/macos **断网**下全绿；`e2e/` ≤12 文件。**依赖**：P2。**回滚**：各自独立。

---

## 8. 明确不做（写在这里防止后面被加回来）

| 不做 | 理由 |
|---|---|
| **控制权交接协议 / 状态机 / `control.js`** | 项目所有者明确否决：这是 AI 操作的浏览器，"人可见可操作"是现状不是需求。协作发生在 agent 的对话里，浏览器侧不参与 |
| **新增 MCP 工具（工具数锁 13）** | 工具清单每轮全量注入 agent 上下文，token 成本线性增长。能力扩展优先走 raw WS 与 `context` 字段 |
| **给人做的新 UI**（地址栏 / 设置面板 / 状态灯 / 请求横幅 / 接管按钮 / 聊天框） | 人用的就是页面本身和 tab 条。每一个没人用的 UI 元素都是持续的维护负债 |
| **headless 模式 / `show:false` / 后台运行** | 窗口可见是产品定义，不是配置项（不变量 I1） |
| **"检测人是否在操作"的任何逻辑** | 包括**运行期**暂停看门狗的开关、OS 级输入 hook、全局键盘监听。给一个自愈机制加协议是本末倒置；OS hook 还有三平台的权限与隐私成本。（启动期静态总开关 `AI_BROWSER_WATCHDOG=0` 不属此类，见 §1.2 第 3 条） |
| **改 `browse_quit` 语义** | agent 拥有进程生命周期是既定设计；拒绝对 agent 是无法理解、无法恢复的失败 |
| 截图 / OCR | 项目定位。连 `ui.screenshot` 死契约都要删掉 |
| 验证码自动破解 / 打码平台 | 合规风险 |
| 远程通知 / 云托管 / 多用户 / 多 agent 并发写 | 本地单机单人；远程需要账号体系和常驻服务器，复杂度放大十倍 |
| Windows CI | 0 用例基础，加了只会常红。改为在 README 诚实降级 |
| 页面状态事务回滚 | 浏览器无事务；半回滚（goBack）比不回滚更危险 |
| 录屏 / 操作回放 / 时间旅行调试 | 成本极高，对本项目目标收益几乎为零 |

---

## 9. 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| 拆分期间 e2e 回归（尤其 OOPIF 与输入链路） | 高 | Step 0 行为锁定测试先行；每 Step 单独 commit + `cdp_input_regress` / `oopif_multi_iframe` 双 gate |
| AX 读层在部分站点不如 legacy | 中 | 三档 env + 逃生开关 + 6 站对照 gate 才切默认 |
| 不变量被后续 PR 悄悄违反 | 中 | `tests/test_invariants.js` 静态断言进 CI（§1.4） |
| AX 全量读的性能（大页面） | 中 | 已有 diff/subset 机制兜底 |
| Linux e2e（xvfb）flaky | 中 | 首周 `continue-on-error` 观察；L4 fixture 本地化，不依赖网络 |
| WS 无鉴权被利用（P3 之前的时间窗） | 低 | P0 起 README/SECURITY 明确"不建议在不可信网络环境使用"；P3 加可选 token |

# 复核报告：另一会话的审计（2026-10-30）是否成立

> 复核对象：`findings.md`、`docs/audit/pm-2026-10-30/`（11 篇）、`docs/PLAN_REMEDIATION.md`（51 卡）
> 复核基线：v2.4.6（`src/` 与审计基线 v2.4.5 一致，审计的 file:line 仍适用）
> 复核方式：逐条读代码 + **两个真机实验**（起独立实例、独立 profile、非 9223 端口）。只读，未改源码。

## 0. 结论先说

**大部分成立，而且有一条比它自己定的级更严重。**

| 判定 | 条数 | 说明 |
|---|---|---|
| 成立 | 13 | 有代码证据；关键项还做了真机复现 |
| 部分成立 | 2 | 现象在，但描述夸大了（`OOPIF 每读必合`、`README 无截图` 的叙事部分） |
| 不成立 | 0 | 未发现凭空捏造的问题 |
| 报告写错/低估 | 4 | 见 §4，其中 1 条是**低估**（evaluate 回落 = 宿主 RCE），1 条是**事实错误**（e2e 连接方式），1 条**过于保守**（下载同名），1 条**已过时**（数字） |

**最重要的新结论（报告把它归在 P1，实际是 P0 且可与 P0 串成一条链）**：
`ui.evaluate` 在页面脚本抛错时会回落到 preload 的 `eval`，而 preload 有 Node。我用
`Function('return globalThis["pro"+"cess"].version+" / pid="+globalThis["pro"+"cess"].pid')()`
（拆词绕过 `guards.js` 的 `process\.` 正则）实测拿到 `v20.18.3 / pid=40158`。
再叠加"任意页面可连 WS 控制面"这一条，**一条链等于：普通网页 → 宿主代码执行**，无需任何用户操作。
两个实验都跑通了（§3）。

---

## 1. 逐条判定

| # | 报告主张 | 判定 | 我的证据（读到的代码 / 实测） |
|---|---|---|---|
| C1 | WS 无鉴权、不校验 `Origin`、explicit tab 跨标签 | **成立（已实测）** | `ws_server.js:111` 形参名 `_req` 即未使用；`shared/tab_route.cjs:42-51` 对 explicit **只校验存在性**，不校验归属；实测页面枚举出 3 个 tab 并读到另一 tab 的正文（§3.1） |
| C2 | `bridge` 向页面暴露 `sendTree/sendDiff`，`ai:*` 不校验 sender | **成立** | `bridge.cjs:21-23` 两个函数确实挂在 `__ai_browser__` 上；`page_manager.js:389-396` 只按 `payload.id` 取 pending，无 sender 校验；`_requestId` 为 `++` 自增（`:2516`）可枚举。**注意：这条不需要 WS 就能被页面利用**（页面直接调 `sendTree`），所以它和 C1 是两条独立入口 |
| C3 | preload `eval` 兜底 + guard 可绕 | **成立，且严重性被低估** | `bridge.cjs:104` 直接 `eval(data.js)`；`page_manager.js:2471-2477` 的 catch **把页面异常也当"CDP 不可用"**，于是任何在页面里抛错的表达式都会被拿到 preload 重跑一次；`guards.js:7` 只挡字面量 `process.`/`require(`，拆词即绕。实测见 §3.2 |
| C4 | 全局 `--no-sandbox` + 每 tab `sandbox:false` | **成立** | `index.js:460` `appendSwitch('no-sandbox')`；`page_manager.js:3793` `sandbox:false`（注释自承"preload 要 require 本地 .cjs"） |
| C5 | upload 接受任意绝对路径 | **成立** | `mcp_tools.js:55` `file: absolute path`；`page_manager.js:2122` → `DOM.setFileInputFiles`，全链路无存在性/白名单/大小校验 |
| C6 | MCP 固定 15s 腰斩 120s/300s | **成立** | `mcp_ws.js:26` `timeout=15000`；`call(method, params)` **没有第三个参数**（`:156`），无法按调用覆盖；`mcp_tools.js:56` 声明 1s..300s |
| C7 | `subset/mode` 默认读法下静默失效 | **成立** | `ws_server.js:270-276`：只有 `params.ax` 分支才把 `subset/mode` 传给 `getTreeViaAx`；默认分支 `getTree(params.focusedOnly, tabId)` 根本不接这两个参数。消费者在 `page_manager.js:1583/1593`（AX 路径内） |
| C8 | `focused_only` 空转 | **成立** | 参数一路传到 `bridge` 的 `ai:extract {focusedOnly}`，但 `src/preload/` 里 **`focusedOnly` 零匹配** → 抽取器忽略；`page_manager` 只用它跳过帧合并与 editors |
| C9 | 每次读树必合并 OOPIF | **部分成立** | `_autoMergeOpaqueFrames`（`:1236`）有 3 道早退：无 tree/context、已合并、`shouldAutoAx` 为假。`frame_probe.cjs:39` 的判据是 `visible_count>0`，所以**只有存在可见跨进程帧的页面**才每次重读全部帧。问题真实（无缓存、每次新读），但"每读必合并"不准确 |
| C10 | `wait` 为 text/url 也抽整棵树；未知 condition 空转 | **成立** | `ws_server.js:747` 每轮先 `getTree(false, tabId)`，`764-778` 再对 text/url 额外 `evaluate`；`timeout` 已钳制 `[100,120000]`（`:728`），但**没有 condition 白名单**，写错条件就是白等 120s 后 `satisfied:false` |
| C11 | `id:null` 缺失 / paint_check 绕过路由 / ignored_params / `subset:"all"` / protocol.js | **成立（4/5）** | `:145` 解析错误缺 `id:null`；`:369` `params.tab !== undefined ? params.tab : pageManager.activeTab` 直接跳过分组/会话路由（`heal:true` 时会去重载**人正在看的**那页）；`wrapper_hint.js:130` 建议 `subset:"all"`，而 schema 只有 `interactive|full`；`shared/protocol.js` 生产未引用（已确认）。`ignored_params` 含 `tab` 未单独复核（低风险） |
| C12 | PageManager 零行为单测 + CI 不跑 e2e | **成立** | `grep -rn "PageManager" tests/*.js` **零命中**；`.github/workflows/ci.yml` 只有 `npm ci` + `npm test` |
| C13 | README 漂移：20 工具 / 无截图 / 658+447 / 表 14 行 | **成立（拆分见下）** | 实测 `MCP_TOOLS.length = 17`；badge 写 `658 unit + 447 e2e`（实际 1231 / 814）；工具表 `grep -c` = 14 行；"src/ contains no capture call at all" 与 `page_manager.js:1413 Page.captureScreenshot` / `:4232 capturePage` 直接矛盾。**但**"读页面不靠截图"这个叙事本身成立，失真的是"src 里没有任何截图调用"这句 |
| C14 | cookie 固化延迟退出 / Cmd+W 即退出 | **成立（未逐行复核）** | 结论方向与代码结构一致，但 `index.js:1389-1433` 与 `:900/1486` 我未逐行读，标"待确认细节"；不影响修复方向 |
| C15 | 网络抓包 / canvas hook 默认全开 | **成立** | `page_manager.js:118-120` `NETWORK_CAPTURE_DEFAULT = !(env==='0')`；`canvas_monitor.js:282-286` `isCanvasHookEnabled` 默认 `true` |
| C16 | 同名下载是否覆盖（报告标"待实测"） | **成立，无需实测** | `download_monitor.js:52-55`：`safe = basename(filename)` 后直接 `setSavePath(path.join(dir, safe))`，**没有任何唯一化** → 同名即覆盖。报告的"待实测"过于保守 |
| C17 | 布局公式两份 / `_ensureCdp` 乐观记账 / `tabsInGroup` 裸解引用 / test_imports 漏 `.cjs` / 无 lint | **成立** | `_layoutAllViews`(`:708`) 与 `_layoutView`(`:5102`) 同一公式两份；`_ensureCdp`(`:5523-5525`) `sendCommand(domain+'.enable')` **未 await** 就 `domains.add`；`tabsInGroup`(`:603`) `this.tabs.get(id).webContents.getURL()` 裸解引用（正是白屏事故那一类）；`test_imports.js:22` 只收 `.js`；`package.json` 无 lint/format/type 脚本 |

---

## 2. 我的两个实验（可复现）

脚本在 `/tmp`（不属于项目）：`attack_probe.cjs`、`chain_probe.cjs`、`eval_probe.cjs`、`origin_probe.cjs`。
起独立实例：`AI_BROWSER_PORT=9333`、独立 `AI_BROWSER_USER_DATA`、`AI_BROWSER_START_HIDDEN=1`，结束即杀进程组。

### 2.1 页面 → 控制面（C1，P0 成立）

一个普通 `http://127.0.0.1:<port>/` 页面里 `new WebSocket('ws://127.0.0.1:9333')`：

```
攻击页自述: {"phase":"stolen","count":3,
  "urls":["https://www.baidu.com/","http://127.0.0.1:64761/secret","http://127.0.0.1:64762/"],
  "text":"SECRET-BALANCE-9f3a-ATTACKER-MUST-NOT-SEE"}
```

页面不仅连上了，还 `ui.list_tabs` 枚举出全部 tab，并对**另一个源**的 tab 执行 `ui.evaluate` 读到了正文。
（跨源：`64761` vs `64762` 不同端口 = 不同 origin。）

### 2.2 页面 → 宿主（C3，实际是 P0）

同一个页面，在 WS 上发一条 `ui.evaluate`：

```js
Function('return globalThis["pro"+"cess"].version+" / pid="+globalThis["pro"+"cess"].pid')()
```

回执：`{"phase":"done","host":"v20.18.3 / pid=40158"}` —— 这是 **Electron 主进程那侧的 Node**，不是页面。
单独验证（不经过页面，直接 `ui.evaluate`）：

| 表达式 | 结果 |
|---|---|
| `typeof process` | `"undefined"`（页面世界，正确） |
| `Function('return process.pid')()` | 被 guard 拦（`disallowed Node-specific identifier`） |
| `Function('return globalThis["pro"+"cess"].pid')()` | **`40110`** ← 拆词绕过 |
| `Function('return globalThis["pro"+"cess"].version')()` | **`"v20.18.3"`** |

### 2.3 "见 Origin 就拒"能不能落地（给修复方案的前提）

起一个 `ws` server 记录握手头，分别用 Node 全局 `WebSocket`（`tools/browser.cjs` 用的就是它）与 `ws` 包连接：

```
path=global  | origin = null | ua = "node"
path=ws-pkg  | origin = null | ua = ""
```

结论：**Node 客户端不发 `Origin`，浏览器必发**。所以"拒绝带 `Origin` 的连接"能挡住页面，且不会误伤 MCP / CLI / e2e。这条前提成立（报告没验证过它，但它恰好是对的）。

---

## 3. 修复方案评审（挑关键的）

### SEC-01 · Origin + token —— 方向对，但迁移清单写错了文件

- **对的部分**：拒绝带 `Origin` 的连接 + token 双层；未认证 socket 不进分发；用 env 作为 CI 逃生门。
- **前提已验**：Origin 判据可行（§2.3）。
- **❌ 事实错误（会直接卡住实施）**：卡里写"e2e 统一走 `_harness.cjs` 的 `connect()`"。
  `e2e/_harness.cjs` 里**没有任何 WebSocket 连接**（它只有 `waitPortFree` / `assertIdentity`）。
  真正的共享客户端是 **`tools/browser.cjs:8`**（`new WebSocket("ws://localhost:" + port)`），
  另有 3 个脚本自带连接：`e2e/oopif_multi_iframe.mjs:30`、`e2e/cdp_input_regress.mjs:12`，
  以及 `e2e/_repro_identity.cjs:23` —— **最后这个是"假冒 WS server"**（身份探测用），
  它不该被加 token，加错了会把"测的是不是自己那个实例"这条保障弄坏。
  照卡执行会：改一个不存在的函数、漏掉真正的 25 个套件的入口、误伤身份探测。
- **建议**：把 token 拼装点收敛到 `tools/browser.cjs` 一处 + 两个 `.mjs` 各一行；`_repro_identity` 明确豁免。
- **另一个小坑**：token 文件只按 `userDataDir` 定位、且"每次启动轮换 + 退出删除"。
  开发版与打包版若共用 `~/.ai-browser`（或用户 `AI_BROWSER_PORT` 换端口但沿用 profile），
  会互相把对方的 token 轮换掉。建议文件名带端口：`ws-token-<port>`，只在**该端口**的实例启动时轮换。

### SEC-02 · 删 `sendTree/sendDiff` + sender/踢 tab 绑定 —— 对，且比 C1 更容易被利用

- 删的两个函数确实是死代码（preload 自己走 `ipcRenderer.send`，页面侧无调用方）。
- `_pendingRequests` 增 `{tabId, kind}`、复用 `_tabIdForContents` 的方向正确。
- **补一条卡里没写的**：`_tabIdForContents` 依赖 `webContents` **对象身份**。
  渲染器崩溃后 `reload()` 会换掉 webContents，崩溃前发出的 pending 将永远无人认领 →
  **必须靠 `finally` 里的超时兜底**（现有 5s 超时够）。卡里只写了"测已销毁/未知 sender"，建议补"崩溃后仍能超时释放"。

### SEC-03 · 换掉 preload eval —— 方向对，但没修根因

- 移除 Node 侧 `eval` 是必须的（§2.2 已证）。
- **❌ 漏了根因**：`page_manager.js:2471-2477` 把"页面脚本抛异常"和"CDP 不可用"混在同一个 catch 里。
  只删 `_evaluateViaPreload` 而不改这个分类，结果会变成：页面里正常抛错的表达式被报成 `cdp-unavailable`
  ——**换了一种撒谎**。改成只在 `err.message === 'no-cdp'` / attach 失败时才降级，其余原样抛出。
- **❌ 别指望 guard**：`guards.js` 是字面量正则，`Function(...)`、拆词拼接都能过（§2.2 实测）。
  卡里没有强调这点，容易让人以为"留着 guard 就安全"。
- 建议：`executeJavaScript` 与 CDP 都是页面世界，CDP 不可用时它大概率也不可用 —— 那就**如实返回不可用**，
  不要为"降级"再造一条有 Node 的路。

### API-01 · per-call timeout —— 对

`call` 目前没有第三参（`:156`），加 `{timeoutMs}` 是必要改动；`timeoutForTool` 表 + 服务端上限不重复加，
设计合理。唯一要注意：默认仍 15s 的"坏工具拖不住整轮"这条要保留（卡里写了）。

### API-02 / API-03 · subset / focused_only —— 方向对，代价被高估（或说错了约束）

- 卡里担心的 `DEFAULT_SNAPSHOT_JS` 5000 字符上限**与这两条无关**（那是 `snapshot` 的内联脚本，
  不是树抽取）。真正的成本在"默认路径要新增一次剪枝/聚焦遍历"。
- `subset` 想让默认路径生效，可以复用 `axExtractor.filterInteractive` 吗？**不能直接复用**：
  AX 树带 `backendDOMNodeId`，DOM 树带 `data-ai-id`，剪枝后若丢了父子引用，`get_tree` 给的 id 与
  `actions` 会不一致。要么按 DOM 树形状另写一份剪枝，要么在抽取器里剪（`extractor.cjs` 更合适）。
- `focused_only` 要定义清楚"子树"是否含祖先链（agent 需要按钮的父容器来判断上下文）。
  卡里只写"只返回焦点子树"，实施时必然要补这一句。

### CORE-00 · Fake Electron 骨架 —— 方向对，但别从 `new PageManager` 开始

`page_manager.js` 顶部是静态 `import { BrowserView } from 'electron'`，单测里要 `vi.mock('electron')`
并提供 `BrowserView`/`ipcMain`/`app`/`webContents` 的一整套假对象，成本高于卡的估时（M）。
更小的第一刀：把 `view` 的操作面（`setBounds`/`webContents.send`/`debugger`/`isDestroyed`）抽成
`ViewShell` 接口，先在单测里注入假实现，再谈 fake electron 全局。

### DOC-01 · README 一致性 —— 对，但要把 badge 与工具表一起纳入

卡里写了"工具表由 `MCP_TOOLS` 生成"。**必须加上 badge 的 `658 + 447`**（实际 1231 / 814）和
"src 里没有任何截图调用"这句（与 `Page.captureScreenshot` 矛盾）。这三处都是**一句话就能验证的假话**，
对 agent 和人都最伤可信度。

---

## 4. 报告自身的问题（按严重度）

1. **低估**：C3（evaluate 回落）在 `findings.md` 里是 P1，实际可与 C1 串成宿主 RCE。应升 P0，
   并与 C1 一起作为第一优先级。
2. **事实错误**：SEC-01 卡里的 `_harness.cjs connect()` 不存在；真正的入口是 `tools/browser.cjs`
   + 2 个 `.mjs`，且 `_repro_identity.cjs` 必须豁免。
3. **夸大**：C9 "每次读树必合并 OOPIF" —— 有 3 道早退，只在有可见跨进程帧时才合并。
4. **过于保守**：C16 标"待实测"，但代码里就没有唯一化逻辑，可直接判定为覆盖。
5. **轻微过时/数字错**：审计基线写"1228 条"，现为 1231（不影响结论）。

---

## 5. 如果只做三件事（我的排序）

顺序与报告略不同：**先把两条"页面能伸手"的路堵住，再谈 token**。

| 顺序 | 动作 | 为什么排这里 | 规模 |
|---|---|---|---|
| 1 | `ws_server` 连接时 **拒绝任何带 `Origin` 的握手** | 5 行。§2.3 已证不误伤 Node 客户端；§2.1 的整条链当场断掉 | XS |
| 2 | 删 `_evaluateViaPreload`，并把"页面抛错"与"CDP 不可用"分开 | §2.2 证明已能在宿主执行代码；这一步不需要动协议 | S |
| 3 | 删 `sendTree/sendDiff` + `ai:*` 校验 sender/归属 | 页面不走 WS 也能伪造树（C2）；与 1、2 独立 | M |

做完这三件，再上 SEC-01 的 token（按 §3 的修正点改迁移清单）与 `sandbox:true`（SEC-06，L 级，别低估）。

**一个必须写进测试的判据**：把 §2.1/§2.2 的探针做成 `e2e/security_ws.cjs` 的固定用例 ——
页面连不上（`readyState` 3 / close 1008）、且 evaluate 拿不到 `process`。
两条都要有**阳性对照**：临时删掉 Origin 检查应当变红，否则这道闸门永远绿。

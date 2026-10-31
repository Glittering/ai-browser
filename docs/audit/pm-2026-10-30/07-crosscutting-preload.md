# M7 · 横切库与 preload 安全边界

> 范围：`src/shared/`（39 个模块，约 4.0k 行）、`src/preload/{bridge,extractor,actions,watcher}.cjs`。

## 1. 结构

`src/shared/` 的设计意图是「**判据可测**」：把不依赖 Electron 的纯逻辑下沉，
让 vitest 在 Node/jsdom 下直接钉住行为。实际也是这么用的：

- 纯函数：`tab_route / tab_group / tab_state / view_liveness / deadline / effect_state /
  input_verify / value_contract / hit_point / dialog_policy / ref_guard / ref_epoch /
  frame_probe / doc_coverage / wrapper_hint / screenshot_opts / nav_wait / blank_page`
- 主进程专用：`config / version / protocol（仅测试使用）`
- preload 专用（CJS）：`extractor 依赖的 value_contract / auth_wall / frame_probe`

`preload/bridge.cjs` 只负责 IPC 接线与模块编排；`extractor/actions/watcher` 各自独立。
这个拆分本身是对的，也是「读层/操作层能写单测」的前提。

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| 判据与副作用分离 | `deadline.js`、`tab_route.cjs`、`view_liveness.cjs` 顶部注释 | 能用假对象把「怎么判」钉死 |
| 所有「失败形态」都有枚举/稳定文案 | `effect_state.js:36-80`、`network_monitor.js:20-25` | 调用方不必解析英文 |
| 敏感值不回读 | `value_contract.cjs` | 密码/支付信息不进模型上下文 |
| 路由判据唯一 | `tab_route.cjs` + `page_manager.resolveTargetTab` | 多 agent 不互相打错页 |
| `dl` 通道校验 sender | `bridge.cjs:38-46` + `index.js:758` `isChromeSender` | 站点页面调用只得到 `{found:false}` |
| 纯函数测试覆盖高 | 39 个模块中仅 `protocol.js` 无生产引用 | 读层/操作层判据可回归 |

## 3. 问题清单

### P1-1 preload 向**页面主世界**暴露了写 IPC 的入口，且主进程不校验 sender

**证据**：`bridge.cjs:21-46` `contextBridge.exposeInMainWorld("__ai_browser__", { sendTree, sendDiff, windowOpenBridge, dl })`。
`sendTree` 直接 `ipcRenderer.send("ai:tree", tree)`；主进程 `ai:tree` 只看 `payload.id`，
从 `_pendingRequests` 取出 pending 并 `resolve(payload)`（`page_manager.js:389-396`），
**不校验 `_event.sender` 属于哪个 tab，也不校验请求期望哪个 tab**。同理：

- `ai:action_result`（`page_manager.js:398-407`）
- `ai:evaluate_result`（`:409-417`）
- `ai:diff`（`:419-421`，直接 `_broadcast('dom_change')`）
- `ai:event`（`:423-427`，直接广播任意事件）

而 `_requestId` 是全局自增整数（`page_manager.js:219, 1153`），**可猜、可枚举**。

**影响**：页面里任意脚本可以：

1. 发 `__ai_browser__.sendTree({id: N, tree: 伪造树})`，把 agent 正在等待的
   `getTree` 结果替换成攻击者构造的树（例如把「转账」按钮描述成「取消」）；
2. 发 `sendDiff` / `ai:event`，向订阅了 `dom_change` 的 agent 注入假事件；
3. `windowOpenBridge('open', 任意token, 'https://phishing')`
   （`bridge.cjs:31-37` + `page_manager.js:435-467`）在 agent 组里开新标签；
   组满时还会**淘汰并关闭**另一个标签（`page_manager.js:452-459`）；
4. `dl.open/reveal` 有 `isChromeSender` 保护，这一点是对的。

**注意**：`sendTree` / `sendDiff` 在生产代码里**没有任何调用方**
（`grep -rn "sendTree\|sendDiff" src` 只命中定义），属于遗留入口，删除零风险。

**最小修复**：
1. 删除 `sendTree` / `sendDiff` 暴露（以及 `ai:diff`/`ai:event` 的页面可用性）；
2. 所有 `ai:*` 结果通道校验 `_tabIdForContents(event.sender)` 非空，且与 pending
   请求记录的 `tabId` 一致（把 `{resolve, tabId, kind}` 存进 `_pendingRequests`）；
3. `window_open` 的 token 必须由主进程在注入 shim 时签发（`_windowOpenShimTabs` 里生成
   并下发），页面只能使用自己拿到的 token；无签发记录的 token 直接拒绝；
4. 长期：preload 不再向页面暴露任何「写」通道，shim 通过 `postMessage` + 主进程
   白名单协议通信。

**验收**：页面里执行 `__ai_browser__.sendTree({id:1,tree:{}})` 无效；
`windowOpenBridge('open','guess','https://x')` 不创建 tab；MCP/e2e 全绿。

---

### P1-2 `browse_evaluate` 的 preload 兜底在**有 Node 的上下文**里 `eval`，而 guard 可被一行绕过

**证据**：

- `page_manager.evaluate` 先走 CDP；CDP 失败时 `return await this._evaluateViaPreload(view, js)`
  （`page_manager.js:2482-2487`）。
- preload 侧 `ipcRenderer.on("ai:evaluate", ... var result = eval(data.js) ...)`
  （`bridge.cjs:112-131`）——这是**直接 eval**，作用域是 `bridge.cjs` 模块作用域，
  因此 `require` 在作用域内可见（preload `sandbox:false`，Node 可用）。
- 唯一的防护是 `shared/guards.js:6` 的几条正则：
  `\bprocess\.\b|\brequire\s*\(|\bchild_process\b|\bglobalThis\.process\b`。
- 绕过示例：`("req"+"uire")("child_process")`、`globalThis["pro"+"cess"]`、
  `this.constructor.constructor("return require")()`。

**影响**：`browse_evaluate` 的文档口径是「run a JS *expression* in page context
（5000-char cap, Node identifiers rejected）」（`mcp_tools.js` / README），
但在 CDP 不可用的降级路径里，它实际执行在**主进程的 preload 上下文**。
一次 prompt injection（页面文字诱导 agent「运行这段校验脚本」）就能从「读页面」
升级为**宿主任意代码执行**。这与产品「不把页面当代码执行环境」的定位直接冲突。

**修复**：
1. **删掉 preload eval 兜底**：CDP 不可用时返回 `cdp-unavailable`，而不是换一个更特权的上下文；
2. 如果必须保留兜底，用 `webContents.executeJavaScript(js)`（主世界、无 Node），
   或经 `Runtime.evaluate` 的 `contextId` 指定页面上下文；
3. 在 README/工具描述里把 guard 明确定性为「防误用，不是沙箱」，不要给调用方
   「Node identifiers rejected = 安全」的错觉；
4. 对 `browse_evaluate` 增加「调用方必须显式 `allow_eval:true`」的开关（可选）。

**验收**：断掉 CDP（mock `debugger.sendCommand` 抛错）后调用 `browse_evaluate`，
返回 `cdp-unavailable`，且 `require('child_process')` 无法执行。

---

### P1-3 `sandbox:false` + `--no-sandbox` 使上述两条链的后果从「页面级」升级为「宿主级」

见 M1 P1-2。这里只强调**组合效应**：preload 有 Node + 页面能写 IPC + 进程无 OS sandbox，
三者叠加后，「页面 → 宿主」只需要一条链，而不是三条独立漏洞。

**建议**：M1 的结构性修复（preload 打包成单文件 → `sandbox:true`）应优先于任何新功能。

---

### P2-1 `shared/` 同时存在 ESM `.js` 与 CJS `.cjs`，没有 lint 约束

**证据**：`package.json` `"type": "module"`；`shared/` 里 `tab_route.cjs`、`value_contract.cjs`、
`frame_probe.cjs` 等是 CJS（给 preload `require`），`effect_state.js`、`deadline.js` 等是 ESM
（给 main `import`）。`page_manager.js` 顶部混用 `import x from '...cjs'` 与
`import { y } from '...js'`。

**影响**：新人无法从扩展名以外的线索判断「这个模块能不能在 preload 用」；
一旦把某个 `.js` 模块 require 进 preload，会在运行时才报 `ERR_REQUIRE_ESM`。
当前靠约定与测试（`test_imports.js`）维持。

**建议**：加 ESLint 规则/自定义脚本：
`src/preload/**` 只能 require `*.cjs`；`src/shared/*.cjs` 不得 import ESM；
CI 跑一次 `node --check` 全量语法检查。

---

### P2-2 `shared/wrapper_hint.js` 建议的 `subset:"all"` 不在 schema enum 里

**证据**：`wrapper_hint.js:130` 文案：`re-read the tree with subset:"all" to address it`；
`mcp_tools.js:36` 的 enum 是 `['interactive', 'full']`。

**影响**：agent 照提示传 `subset:"all"`，在严格校验的 MCP 客户端会被拒；
在宽松客户端会被忽略（默认路径本来也不支持 subset，见 M4 P1-1）。
一条「下一步提示」同时踩了两个坑。

**修复**：文案改为 `subset:"full"`（或无 subset），并与 M4 的 subset 实现一起校对。

---

### P2-3 `shared/protocol.js` 在生产代码中无人使用，只被测试引用

**证据**：`grep -rn "shared/protocol" src` 只命中自身；`tests/test_protocol.js` 引用。
`VALID_METHODS` 列表与 `ws_server` 的 switch 是两份手工清单。

**影响**：这份「协议常量」看起来是契约，实际不参与校验；新增方法时容易忘记同步，
测试可能只验证「列表与 switch 一致」而不是「协议行为正确」。属于**假单一事实源**。

**建议**：要么让 `ws_server` 真正用 `VALID_METHODS` 做入口校验（推荐），
要么删除该文件，把常量移到测试里。

---

### P2-4 没有 lint / 格式化 / 类型检查

**证据**：仓库无 `.eslintrc*`、`.prettierrc*`、`tsconfig.json`/`jsconfig.json`；
`package.json` 无 `lint`/`typecheck` 脚本；CI 只跑 `npm test`（`.github/workflows/ci.yml`）。

**影响**：67 个源文件、21.7k 行，靠人工保持风格；`catch (e) {}`、未使用变量、
可疑的 `await` 缺失都只能靠 review。对一个准备长期维护的 OSS 项目，这是低成本高收益的缺口。

**建议**：ESLint（`no-unused-vars`, `no-floating-promises` 需要 TS parser）+ Prettier；
先以 `warn` 接入，逐步清零；CI 加 `npm run lint`。

---

### P3-1 注释密度高，但存在「注释比代码更乐观」的倾向

例：`guards.js` 的 error message 暗示「Node identifiers rejected」等于安全；
`page_probe.js` 说「代价只在 canvas 页面」，实际每次动作都有 evaluate；
`index.js:931` 说「有人用就不重启」，实际没有该逻辑。
建议把「保证」与「尽力」在措辞上分开（`must` vs `best-effort`），并在 CI 里用
注释链接到对应测试（`// see tests/...`）。

## 4. 效率与简洁性

- `shared/` 的模块粒度总体合适（每个 < 300 行，单一判据）。
- `value_contract.cjs` / `auth_wall.cjs` 这类「给 preload 用的 CJS」与主进程 ESM 的边界
  应在目录上更明显（如 `shared/preload/`），减少误用。
- `frame_probe.cjs` 同时被 extractor（CJS）与 page_manager（ESM）使用，是跨边界的
  关键模块，建议加「双环境冒烟测试」。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 3.5 | 判据下沉的方向正确；双模块系统增加认知负担 |
| 逻辑 | 3.0 | 纯函数扎实；IPC 信任边界缺失是硬伤 |
| 质量 | 3.5 | 注释质量高；缺 lint/类型 |
| 效率 | 3.5 | 模块小、依赖少 |
| 可测 | 4.5 | 39 个模块几乎都有测试，是项目最强项 |
| 风险 | 1.5 | 页面可写 IPC + preload eval + 无 sandbox，组合风险高 |

## 6. 结论

`shared/` 是项目「可测性」的根基，做得很对；`preload` 是当前**最薄的信任边界**：
页面能写结果通道、能触发开标签、能在降级路径里 eval 到 Node。这三件事不需要架构重构，
但必须在继续加功能之前关掉。顺序：**删 sendTree/sendDiff → 删除/隔离 eval 兜底 →
sender 校验 → 打包 preload 开 sandbox**。

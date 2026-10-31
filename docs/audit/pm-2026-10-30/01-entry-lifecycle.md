# M1 · 入口 / 进程 / 窗口 / 生命周期

> 范围：`src/main/index.js`（1494 行）、`src/shared/{watchdog,window_show,tab_hooks,nav_follow,view_liveness,error_banner}.js`、
> `src/renderer/{tab_bar,error_banner,download}.html`、`scripts/start.cjs`。

## 1. 这个模块在做什么

`index.js` 不是「入口」，而是**整个应用的外壳层**：进程生命周期、单实例、窗口、
标签栏、地址栏、下载 UI、错误横幅、应用图标、网络看门狗、退出清理全部在这里。
`createWindow()` 是真正的装配点（`index.js:640-938`），它按顺序创建窗口 → 标签栏视图 →
错误横幅视图 → `PageManager` → `startWSServer` → 首屏显示。

```
app.whenReady
  └─ createWindow()
       ├─ BrowserWindow(show:false, preload=bridge.cjs)   index.js:659-669
       ├─ createTabBarView()   nodeIntegration:true       index.js:161-172
       ├─ PageManager(window)                             index.js:680
       │    ├─ _setupIPC() / session hooks / downloads
       │    └─ newTab(startUrl)
       ├─ startWSServer(pageManager, PORT)                index.js:~700
       ├─ chrome IPC: tab:*, nav:*, dl:*, error-banner:*   index.js:718-760
       ├─ 两个轮询：tab bar 2s / nav 1.5s                  index.js:903,924
       ├─ StartNetworkWatchdog()                          index.js:930,1150
       └─ showInitialWindow()  dom-ready / 3s 兜底         index.js:992-1075
```

## 2. 做对了什么（应保留）

| 机制 | 证据 | 价值 |
|---|---|---|
| 单实例锁 + 第二次启动聚焦已有窗口 | `index.js:503-535` | 避免两个进程抢 9223 与同一 Chromium profile（Bug 6 的根因） |
| 延迟显示 + `showInactive()` | `index.js:940-1016` | agent 拉起窗口时不抢人键盘焦点，同时保证最终可见 |
| 首屏显示原因可解释（`dom-ready / renderer-ready / timeout / fail-load`） | `index.js:992-1016` | 白屏事故的观测口，不是「等 3 秒赌一把」 |
| GPU 连续崩溃才降级，且落标记可恢复 | `index.js:446-452, 1128-1150` | 不再因一次偶发崩溃把所有人降到软件合成 |
| 看门狗双 host + 阈值 5 + 可关 | `shared/watchdog.js:20-60`、`index.js:485` | 降低误判，且明确拒绝「猜谁在键盘前」的启发式 |
| 退出路径统一收口（close / window-all-closed / before-quit / ui.quit） | `index.js:1387-1500` | 防重入 + 会话 cookie 落盘 + 日志 shutdown 行 |
| 错误横幅非阻塞、可自动收起、失败降级原生框 | `index.js:86-155, 251-300` | 崩溃时人能看见，且不把主进程卡死 |
| selftest 可注入崩溃/收起 | `index.js:1334-1341` | 把「崩溃链路」变成可回归的 |

## 3. 问题清单

### P1-1 `index.js` 是第二个上帝对象（1494 行，8 类职责）

**证据**：`index.js` 同时负责：窗口（640-938）、chrome 视图（161-300）、下载 UI（718-760）、
图标（542-640）、看门狗（1078-1150）、cookie 固化（1389-1437）、退出（1440-1500）、
渲染进程重建（174-250）。

**影响**：任何一处改动都要重新理解整个启动顺序；`createWindow` 内部有 20+ 个
`try/catch` 与回调闭包，新增一个 chrome 面板只能继续往同一个函数里塞。
更关键的是**它没有行为级单测**：`tests/` 里只有 `test_invariants.js` 读源码文本。

**最小修复**（不改行为）：先把纯逻辑抽成可测模块 —— `cookie_persistence.js`
（输入 cookie 数组，输出要 set 的 details）、`watchdog_runner.js`（注入 `probe` 与 `relaunch`）、
`window_show_policy.js`（已有 `window_show.js`，但 index 仍内联了判定）。
**结构性修复**：`app/lifecycle.js`、`window_shell.js`、`chrome_views.js`、`download_ui.js`、
`app_icon.js`，`index.js` 只剩装配与事件绑定，目标 < 300 行。

**验收**：`index.js` 行数下降 > 60%；每个抽出的模块有独立单测；`e2e lifecycle/paint/view` 全绿。

---

### P1-2 运行在 `--no-sandbox` + preload `sandbox:false` 下（信任边界与产品定位冲突）

**证据**：`index.js:460` 无条件 `app.commandLine.appendSwitch('no-sandbox')`；
`page_manager.js:3793` 每个标签页 `sandbox:false`（为了让 CommonJS preload 能 `require` 本地模块）。

**影响**：本产品每天访问的是**任意不可信站点**，且由模型驱动点击。Chromium 渲染进程
一旦被攻破，攻击者直接拿到宿主用户权限（读 `~/.ai-browser` 里的登录态、读写任意文件）。
`no-sandbox` 原本是为「受限 IDE shell 启动」加的兼容开关，但它现在是**所有用户、所有场景**
的默认值。

**最小修复**：把 `no-sandbox` 收进显式环境变量（仅在检测到受限环境时启用），
默认走 Chromium sandbox；打包版单独验证一次启动。
**结构性修复**：用 esbuild 把 `bridge.cjs + extractor/actions/watcher` 打成**单文件 preload**，
即可 `sandbox:true`；这是 Electron 官方推荐的路径，能同时消掉 `sandbox:false`。

**验收**：默认安装包在 macOS 上 `sandbox:true` 启动、`npm test` + `e2e smoke/interact/value` 全绿；
`no-sandbox` 只出现在受限环境的显式分支。

---

### P2-1 标签栏/错误横幅用 `nodeIntegration:true + contextIsolation:false`

**证据**：`index.js:163`、`index.js:262`；两者都 `loadFile` 本地页面。
目前注入面已做转义：标签标题 `tab_bar.html:247`、组名 `tab_bar.html:265` 用 `escapeHtml`；
横幅用 `textContent`（`error_banner.html:69-74`）。但 `download.html:154` 对
`rec.mime` 未转义（`innerHTML` 拼接），虽然 download 页不是 chrome view（有 preload 隔离），
仍是一个「UI 层 XSS」的坏示范。

**影响**：chrome 视图是**唯一**具备 Node 能力的渲染面。今天靠「每个插值都记得转义」维持安全，
一旦新增一个字段（如把页面 title 的富文本、下载文件名、组 label 中某段）忘了转义，
就是 `require('child_process')` 级别的 RCE。

**建议**：chrome 视图改成 preload + `contextIsolation:true`（只暴露 `tab:*` / `nav:*` / `dl:*`
的最小 API），并把 `download.html` 的 `mime` 改为 `textContent`。

**验收**：`grep nodeIntegration: true src/main/index.js` 为空；新增 chrome UI 字段时无需再考虑转义。

---

### P2-2 退出时把所有会话 cookie 改写成 13 个月持久 cookie，且退出耗时可线性增长

**证据**：`index.js:1389-1433`：`expirationDate = now + 400 天`，覆盖所有「非 durable」cookie；
每 10 个 `await 100ms`，最后再固定等 2s（`index.js:1431-1434`）。

**影响**：
1. **隐私/语义**：服务端明确设为 session-only 的 cookie（如临时登录态、CSRF nonce）
   被静默变成长达 13 个月的磁盘持久 cookie。用户并不知道「关掉浏览器后这个站点还留着登录」。
2. **退出时延**：500 个 cookie ≈ 5s + 2s；1000 个 ≈ 12s。用户点关闭后窗口迟迟不退，
   容易被误判为卡死。
3. 这是「保持登录」的**手段**，不是唯一手段；应显式化。

**建议**：加 `AI_BROWSER_PERSIST_SESSION_COOKIES=0` 开关并在 README 写明默认行为；
只对用户确认过的站点（或白名单域）延长；退出路径加总预算（如 3s 上限，超时先 `flushStore()` 再退）。

**验收**：默认关掉该行为后，登录态仍能通过「服务器下发持久 cookie」保持；
退出 P95 < 3s。

---

### P2-3 两个轮询与「事件驱动」的自我叙述不一致

**证据**：`index.js:903` `setInterval(refreshTabBar, 2000)`；
`index.js:924` `setInterval(pushNavState, 1500)`；注释（`index.js:906-910`）说地址栏已改为
事件驱动、轮询只是兜底，但兜底仍每 1.5s 无条件跨进程 `executeJavaScript`。

**影响**：常驻 2 个定时器 ≈ 1.2 次/秒的 IPC + 渲染执行。对桌面应用不算致命，但：
1. 笔记本电池与 CPU 空转；
2. `refreshTabBar` 每次都重建 DOM，标签多时会造成可感知的输入抖动（人正在拖标签时）。

**建议**：事件驱动为主，兜底降到 5–10s；标签栏改为增量更新（只改变化的 tab），
或在 `document.visibilityState === 'hidden'` 时暂停。

**验收**：空闲 5 分钟 CPU < 0.5%；标签切换无整栏重绘闪烁。

---

### P2-4 看门狗重启可能打断「人正在输入」，且注释与实现相反

**证据**：`shared/watchdog.js:12-22` 明确写「不做『人是否在键盘前』的启发式」；
但 `index.js:931` 仍留着注释「Relaunch is skipped while a human appears to be actively using the window」。
实际 `index.js:1142-1150` 连续 5 次失败（约 2.5 分钟）直接 `app.relaunch()`。

**影响**：人在窗口里填表/扫码时，网络抖动累计 5 次 → 窗口重启，输入丢失。
这不一定违反产品定位（agent 是操作者），但**人正在手动介入**时重启是明确有害的。

**建议**：不要用 `isFocused`（agent 也会抢焦点），而用
`webContents.on('before-input-event')` 记录「最近一次真实键盘输入时间」；若 30s 内有输入，
把重启延后一轮（最多延后 N 次）。这不是猜身份，而是观测「刚刚有输入」这个事实。

**验收**：`e2e/lifecycle` 增加「模拟输入 + 看门狗触发」用例：有输入时不重启，静默 30s 后重启。

---

### P2-5 macOS 上关窗即退出，可能静默毁掉 agent 正在进行的任务

**证据**：`index.js:900` `mainWindow.on('close', cleanupAndQuit)`；
`index.js:1486` `app.on('window-all-closed', cleanupAndQuit)`（无平台分支）。

**影响**：macOS 用户习惯 `Cmd+W` 关窗、应用留在 Dock。这里 `Cmd+W` = 杀进程 = 所有标签页、
未保存表单、agent 会话全部消失。对「共享长驻窗口」的产品叙事是反直觉的。

**建议**：窗口关闭时若仍有 WS 客户端连接（agent 在工作），改为隐藏窗口 + 托盘/Dock 恢复，
并在 tab 条给一句「agent 仍在运行」；或至少弹一次确认。

**验收**：有活跃 agent 连接时 `Cmd+W` 隐藏而非退出；Dock 点击可恢复。

---

### P3-1 文档/不变量与代码漂移

- `docs/PLAN_ARCHITECTURE.md` §1 仍写「禁止 `show:false`」（I1），而实现是
  `show:false` + `showInactive()`，`tests/test_invariants.js:33-40` 已把断言改成「允许延迟显示」。
- 同文件 I5 要求「必须保持 `disableHardwareAcceleration()`」，实现已翻转为默认开 GPU
  （`index.js:446-452`），且 `test_invariants.js` 不再守这条。
- `index.js:931` 的过时注释（见 P2-4）。

**建议**：`PLAN_ARCHITECTURE.md` 顶部加「已被 v2.4.5 实现覆盖」的横幅，把「当前约束」
迁到 `docs/ARCHITECTURE.md`；不变量测试与文档同源（测试失败信息里引用文档锚点）。

---

### P3-2 单实例分支只 `app.quit()` 不 `return`

**证据**：`index.js:503-535`。`gotLock === false` 时执行 `app.quit()`，但模块剩余代码继续注册
`whenReady`、`before-quit` 等。实践中 Electron 会退出，但这是「靠时序正确」而非「靠结构正确」。

**建议**：分支末尾 `process.exit(0)` 或把所有注册包进 `if (gotLock) { ... }`。

---

## 4. 效率与简洁性

- `showInitialWindow` 先 `dom-ready` 再 3s 兜底，再主动查一次 `readyState`（`index.js:1060-1075`）——
  三重判定是为了白屏，合理；但 `evaluate` 失败时静默，可加一条 `show_reason=probe-failed`。
- 图标/缩略图缓存有上限（`thumbCache` 达到 16 清空），可接受。
- `createWindow` 里同时注册 `ipcMain.on` 与 `app.on('web-contents-created')`，
  依赖「只创建一次窗口」的隐含假设；建议把注册移到模块级并显式幂等。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 2.5 | 生命周期与 UI 外壳混在一个文件；可拆点明确 |
| 逻辑 | 3.5 | 退出/显示/看门狗路径考虑得很细，少数注释与实现相反 |
| 质量 | 3.0 | 注释质量高，但 1500 行 + 多职责拉低 |
| 效率 | 3.0 | 两个常驻轮询；退出可被 cookie 数量拖慢 |
| 可测 | 2.0 | 纯函数已下沉一部分，但 index 无行为单测 |
| 风险 | 2.5 | no-sandbox + chrome 视图 Node 能力是结构性风险 |

## 6. 结论

这是「工程判断力很强、但结构在替人记事」的典型：每个事故都留下了注释、兜底和 selftest，
所以它很稳；但也因此越长越厚。**先拆 index.js，再把 no-sandbox 变成例外而不是默认**，
是本模块最值得做的两件事。

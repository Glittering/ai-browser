# M3 · 标签 / 视图 / 布局 / 崩溃恢复

> 范围：`src/main/page_manager.js` 的 tab 部分（约 200–760、3780–4200、4719–5120）、
> `src/shared/{tab_state,tab_group,tab_route,view_liveness,tab_hooks,placeholder}.cjs`、
> `src/renderer/tab_bar.html`。

## 1. 职责与状态

`PageManager` 是**唯一状态持有人**：标签页 Map、分组、会话目标、CDP 连接、网络/canvas 账本、
快照、重绘/白屏状态、窗口可见性都在一个实例里。构造器里登记了 26 个 `Map/Set`
（`page_manager.js:203-300`），其中 20+ 个以 `tabId` 为键。

```
newTab() ─┬─ BrowserView + preload(bridge.cjs)
          ├─ group 归属 / 限额 / 淘汰
          ├─ loading 占位页（先给"正在打开 X"）
          ├─ CDP attach（Network/Runtime/Page…）
          ├─ window.open shim（Page.addScriptToEvaluateOnNewDocument）
          └─ 崩溃/加载失败钩子
setActive() ── 加回 BrowserView + _layoutView + _raiseView
closeTab() ── remove + detach + close + tab_state.clearPerTab + 选下一个
```

## 2. 做对了什么（本模块最大的亮点）

| 机制 | 证据 | 价值 |
|---|---|---|
| per-tab 清理**清单化** + 完整性闸门 | `shared/tab_state.cjs:1-111`、`tests/test_tab_state_reset.js:122` | 把「新增一个 Map 忘了清」变成构建失败，而不是半年后的幽灵状态。这是教科书级的机制修复 |
| 视图存活判定单点化 | `shared/view_liveness.cjs`、`page_manager.js:4249` | 悬空 `webContents` 不再击穿主进程 |
| 分组 + 每 agent 工作区 | `shared/tab_group.cjs`、`page_manager.js:557-660` | 多 agent 并用时互不抢目标 |
| 组满时淘汰而不是拒绝 | `page_manager.js:428-470` | 站点脚本在等 `window.open` 返回，拒绝会让页面卡死 |
| 启动页「顶替」规则 | `page_manager.js:207-210`、`shared/tab_route.cjs` | agent 开第一页时不会让人盯着百度首页以为没动 |
| 占位页用 `pathToFileURL` | `shared/placeholder.cjs`、`page_manager.js:5542-5548` | 打包后路径含空格不再出现「URL 字符串永不相等」 |
| 崩溃恢复有 15s 上限 | `page_manager.js:282-286`、`_attachCrashRecovery` | 避免崩溃→重载→崩溃的死循环 |

## 3. 问题清单

### P1-1 `PageManager` 是 5857 行、70+ 方法的上帝对象

**证据**：文件行数 5857；构造器 203-300；方法覆盖 tab、导航、读层、AX、操作、
网络、canvas、下载、权限、快照、白屏、对话框、窗口、订阅、CDP 适配。
`tab_state.cjs` 的注释自己承认「26 个容器，20 多个以 tabId 为键」。

**影响**：
1. **改不动**：任何改动都要在 6000 行里确认副作用；新增一个能力默认继续往类里加方法。
2. **测不了**：`tests/` 里没有任何测试真正 `new PageManager(...)`（全是 mock 或读源码），
   5857 行的核心逻辑只靠 e2e 兜底（而 e2e 不进 CI，见 M8）。
3. **状态耦合**：读层/操作层/观测层共享同一个 `this`，无法单独替换或并行初始化。

**结构性修复（分三步，不要求一次到位）**：
1. **先按状态切**：`TabRegistry`（tabs/active/group/session）、`ViewShell`（layout/raise/bounds）、
   `CdpHub`（attach/domains/dialog watch）、`ReadService`、`ActService`、`Observability`。
   `PageManager` 只做门面，把调用转发给服务。
2. **依赖注入**：服务构造时拿 `{ window, session, cdp, broadcast }`，而不是 `this`。
3. **回归护栏**：把现有 e2e 的 25 套件作为拆分验收；每拆一个服务补一组单测
   （用假 `BrowserView`/假 `debugger`）。

**验收**：`page_manager.js` < 1500 行；`ReadService`/`ActService` 可在 Node 下用假对象单测；
e2e 全绿且套件数不减少。

---

### P1-2 `newTab()` 单函数约 230 行，混合 8 类关注点

**证据**：`page_manager.js:3780-4010`：创建 view、决定分组、占位页、限额/淘汰、
CDP attach、window.open shim、canvas hook、导航启动、失败/崩溃钩子全在一个函数里，
内部还有 `proceed` 闭包与多个 `setTimeout`。

**影响**：新增「新标签页的某个初始化步骤」只能继续插入；顺序敏感（注释里已经记录了
多次「必须在这个之后/之前」的事故）。任何一步抛错都可能留下半初始化的 tab。

**修复**：抽成有序的初始化管线：
`createView → resolveGroup → attachHooks → showPlaceholder → navigate`，
每步返回 `{ok, cleanup}`，失败时回滚已完成的步骤（而不是留下半成品 tab）。

**验收**：`newTab` < 60 行；新增步骤只改管线数组；失败注入测试（某步抛错）后无残留 tab。

---

### P1-3 `_ensureCdp` 乐观记账：`enable` 未 await，失败后永远不再重试

**证据**：`page_manager.js:5522-5527`：

```js
if (!entry.domains.has(domain)) {
  wc.debugger.sendCommand(domain + '.enable');  // 未 await / 未 catch
  entry.domains.add(domain);                    // 先记账
}
```

**影响**：导航中/渲染器忙时 `enable` 可能 reject（被 `unhandledRejection` 捕获，只记日志），
但 `domains` 已标记为启用 → 后续所有该域命令都可能失败，且**不会再尝试 enable**。
表现是「这个 tab 的网络记录/canvas/对话框监听静默没有」，与「页面本来就没有」无法区分。

**修复**：`await sendCommand(...).then(() => entry.domains.add(domain)).catch(() => {})`；
失败时 `delete` 记账，让下次调用重试；并在回执里暴露 `cdp_domains` 状态。

**验收**：mock `sendCommand` 首次 reject、第二次 resolve，断言第二次会重新 enable。

---

### P2-1 `tabsInGroup()` / `listTabs()` 仍直接解引用 `webContents.getURL()`，没有存活判定

**证据**：`page_manager.js:597-608`（`tabsInGroup`）、`page_manager.js:648-658`（`listGroups`）。
`view_liveness` 已在 `paintCheck` 等处使用（`page_manager.js:4249`），但这两处仍是裸访问。

**影响**：渲染进程消失/`webContents` 悬空时，`ui.list_tabs` 会在主进程抛
`Cannot read properties of undefined (reading 'getURL')` —— 正是 2026-10-30 白屏事故的
同一类缺陷，只是换了一个入口。全局 `uncaughtException` 会记录并尝试重建标签栏，
但 RPC 本身失败。

**修复**：所有 `this.tabs.get(id).webContents.*` 统一走 `view_liveness.safeUrl(view)` /
`isAlive(view)`；`tabsInGroup` 对失效 view 返回 `{id, url:null, dead:true}`。

**验收**：在 `tabsInGroup` 的假 view 上把 `webContents` 置空，断言不抛错且标 `dead`。

---

### P2-2 布局公式有两份，注释自己承认会漏

**证据**：`_layoutAllViews`（`page_manager.js:708-721`）与 `_layoutView`（`page_manager.js:5100-5108`）
各自计算 `y = tabBarHeight`、`height = contentBounds.height - tabBarHeight - inset`。
`index.js` 还负责 `_bottomInset` 的设置与横幅布局。

**影响**：新增一个底部/顶部 chrome 元素（现在只有一个 34px 横幅）时，必须同时改 2–3 处；
漏一处就是「内容缩在左上角/底部空一条」——项目历史上已经发生过。

**修复**：唯一几何函数 `computeViewBounds(contentBounds, {tabBar, bottomInset})`，
所有调用方（含 index 的横幅）都用它；单测覆盖 3 种 inset 组合。

---

### P2-3 总量无上限：限额是「每组 8」，但组可以无限增长

**证据**：`ensureGroup`（`page_manager.js:557-582`）每个 `sessionId` 一个组；
`tabGroup.limitFromEnv` 默认 8（README:426）；`canOpenInGroup` 只检查组内数量
（`page_manager.js:613-622`）。没有全局 tab 上限。

**影响**：10 个 agent/脚本各自开 8 页 = 80 个 BrowserView（每个都是独立渲染进程 + CDP + 网络账本）。
内存与句柄线性增长；`_groups` 本身也不设上限。长驻服务（MCP 场景）尤其明显。

**修复**：全局上限（如 32）+ 超限时按「最久未用、非人类组、无对话框」淘汰；
`ensureGroup` 对空闲组做 TTL 回收。

**验收**：脚本开 100 页，进程内存收敛、`ui.list_tabs` 数量 ≤ 上限、被淘汰的 tab 有记录。

---

### P2-4 只有「组满」会淘汰，且 agent 必须主动 `list_tabs` 才知道自己的页面被挤掉

**证据**：`page_manager.js:238`、`455-456`、`3851-3852`；淘汰记录只进 `this.evictions`
（最多 20 条，`ui.list_tabs` 回采后清空）。

**影响**：agent 正在操作 A 页，弹窗把 A 挤掉；下一次 `ui.act {tab:A}` 收到
`no-such-tab`，但 agent 不知道「是被我们自己淘汰的」，容易归因成页面 bug 并重试。

**修复**：淘汰时广播一个 `tab_evicted` 事件（WS 已有订阅机制），并在错误回执里带
`evicted:true, reason:'group-full'`。

---

### P2-5 `closeTab` 里 debugger 被 detach 两次

**证据**：`page_manager.js:4723-4725` 先 `view.webContents.debugger.detach()`；
随后 `_cleanupTabResources` 走 `_cdpTabs` 再 detach（`tab_state.cjs:NOT_PER_TAB` 注释：
「清理前必须 debugger.detach()」）。

**影响**：Electron 对未 attach 的 detach 会抛错，被 catch 掉；功能无害，但说明
「谁负责 detach」没有单一归属，未来容易出现「先 close 后 detach 失败 → 泄漏」。

**修复**：把 detach 只放在 `_cleanupTabResources`（有 `_cdpTabs` 记账、能判断是否 attach），
`closeTab` 不再直接碰 debugger。

---

### P3-1 tabId 复用已被 `tab_state` 正确处理（正向记录）

`tabId` 会复用（`this.tabCounter` 递增，但 Map 删除后可重新分配？实际是递增不复用，
注释却强调复用风险）。无论是否复用，`clearPerTab` 的清单 + 闸门测试都消除了这一类风险，
建议把同样的「清单 + 闸门」模式复制到 **session 级**与 **group 级**容器。

## 4. 效率 / 简洁性

- `newTab` 的初始化包含多次 CDP/磁盘往返（占位页、shim、canvas、crash hook），
  实测注释给的是 120–300ms（`page_manager.js:124`）。可接受，但应把「可选步骤」
  （canvas hook 默认关）与「必需步骤」分开，避免未来默认开启后拖慢每个新标签。
- `setActive` 每次都 `removeBrowserView` + `addBrowserView`（`page_manager.js:4880-4900`），
  在快速切换时会造成闪烁；可用 `setTopBrowserView` 或只调整 z 序。
- `tabsInGroup` 在 `canOpenInGroup` / `pickEvictableInGroup` / `listGroups` 中被反复调用，
  每次都遍历所有 tabs；组多时 O(groups × tabs)。规模小可忽略，但可维护 `group -> Set<tabId>` 索引。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 2.0 | 状态归属清晰，但 5857 行单类无法独立演进 |
| 逻辑 | 3.5 | 生命周期/清理/淘汰考虑得很细；仍有裸解引用与乐观记账 |
| 质量 | 3.0 | 注释一流；函数过长、布局重复 |
| 效率 | 3.0 | 正常路径可接受；全局无上限、切页重挂视图 |
| 可测 | 2.0 | 有清单闸门与纯函数，但核心类无行为单测 |
| 风险 | 3.0 | 白屏类主风险已治理；残留同类入口 |

## 6. 结论

这是项目的**心脏**，也是最大的单点。好消息是：最危险的一类缺陷（per-tab 状态泄漏、
悬空视图）已经被「清单 + 闸门 + 存活判定」机制化，这是非常成熟的工程动作。
下一步不是继续打补丁，而是**按状态把类切开**，让「新增一个 per-tab 容器」仍然只需
登记一次，而不是在 6000 行里找所有使用点。

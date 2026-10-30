# TODO — 内存分析 & 崩溃待办

> 本文件沉淀"内存问题只读深挖"阶段的结论与待办。该阶段**只做分析，未改动任何代码**；
> 所有"确认点"均基于源码审查 + 相关单测运行（未修改源码）。

---

## 2026-10-30 轮：内存问题只读深挖结论

### 已确认的问题（真实遗漏，待进入修复流程）

1. **`src/main/page_manager.js` `_refTrackers` 从不清理**
   - 位置：`:1214-1216`（create/get）
   - 全文件 grep 无任何 `delete`
   - 影响：长期会话中按 tabId 持续持有 tracker 对象 → 泄漏

2. **`src/main/page_manager.js` `_axDiffCache` 关闭 tab 不清**
   - 定义：`:255`；navigate 清：`:1018`；写入：`:1579-1584`
   - `closeTab` / `_cleanupTabResources` 均未清理 → 关掉的 tab 的 lite snapshot 保留

3. **`src/main/canvas_monitor.js` `tabs` Map 关闭 tab 不清**
   - `CanvasMonitor.clear(tabId)`（`:134`）存在，但 `PageManager._cleanupTabResources`（`:4760`）与 `_forgetTab` 均未调用
   - 结果：关掉的 tab 保留 canvas 抓取状态（上限 5000 calls / 4MB per tab，但**累计未清**）

4. **`src/main/page_manager.js` `_failureGuard` Set 关闭 tab 未清理**（偏小，minor）

### 本轮深挖后"已排除/已确认 OK"的区域

- 模块级可变状态几乎清零（`new Map/Set` 只出现在 const 集合 / class 实例字段 / 函数局部）
- `src/preload`：watcher（`mutationQueue`/flush/scan 有清理）、extractor（WeakSet）、bridge ✅
- `src/shared`：全部纯函数/局部集合 ✅
- `src/renderer`：无 module-scope 状态 ✅
- `src/shared/protocol.js`：纯常量 ✅
- `src/main/app_model_source.js`：纯函数 ✅
- `src/main/mcp_ws.js`：`_pending` 有 flush 清理 ✅
- 有界设计已验证（单测全绿）：network_monitor、error_log、snapshot_diff、canvas_monitor、download_monitor、media_inline、thumbCache、evictions、FIELD_MAX 等

### 深挖中发现的小点

- `src/main/index.js:889`：`navStateWc` 保存已销毁 webContents 引用（直到下次切 tab 未清）— **已于 Bug 7 修复**（`wireNavState` 清理旧监听 + 清引用）。

### 待办（更新：Bug 8 已修复并验证）

- [x] **Bug 5**：tab close 时清理 `_refTrackers` / `_axDiffCache` / `_failureGuard` / `canvasMonitor` —— **已修复**（`_cleanupTabResources` 补上对应清理），回归 4/4 + 相关 158 + 全量 1170 全绿。
- [x] **Bug 6**："经常跑两个 ai-browser，关闭一个，还会崩溃" —— **已修复并验证**（见下）。

  - **根因**：`src/main/index.js` 单实例锁退出分支是 `else if (!(process.platform === 'darwin' && app.isPackaged))` —— macOS 打包版把第二个实例的退出豁免掉（条件成立时不 quit），导致两个 Electron 实例可同 userDataDir（`~/.ai-browser`）+ 同端口 :9223 双开。
  - **修复**：退出分支改为无条件 `} else { … app.quit(); }`。
  - **验证**：回归 `tests/test_bug6_second_instance_crash.js`（BUG6-1/2）RED→GREEN；全量单测 85 文件 / 1172 项全绿；API 预算 14/14；`git diff --check` clean。
- [x] **Bug 7**：navState 跟随状态清理 —— **已修复并验证**（见下）。

  - **根因**：`src/main/index.js` `wireNavState` 直接 `navStateWc = wc` 覆盖旧引用，**未清理旧 webContents 的 nav 监听**（关 tab / 切 tab 后旧对象销毁，引用与监听堆积到下次 setActive 才清理）。
  - **修复**：wireNavState 在覆盖前对旧 `navStateWc`（`isDestroyed()`）做 `removeListener` 清理并置空引用；监听改挂模块级稳定函数 `pushNavState`。
  - **验证**：回归 `tests/test_bug7_nav_state_cleanup.js`（BUG7-1/2）RED→GREEN；全量单测 86 文件 / 1174 项全绿；API 预算 14/14；`git diff --check` clean。
- [x] **Bug 8**：浏览器整包有点过大 —— **已修复并验证**（见下）。

  - **定位**：npm 发布包本身很小（tarball 665.4 kB / unpacked 1.6 MB / 101 files ✅）；嫌疑区在**安装包 app.asar**——实测 `/node_modules` ≈ 10 MB，含 `@types/*`（dev-only）≈ 2.4 MB、`@vitest`/`@esbuild` 构建工具链也混入；build 脚本本已 `prune: true` 却未兜底。
  - **修复**：`scripts/build_dmg.cjs` + `scripts/build_win.cjs` 的 `IGNORE` 黑名单补上 dev-only 依赖（@vitest/@esbuild/@types/@electron/jsdom/vitest）与垃圾目录（.github/.trae/.exec-trail/.workbuddy）。
  - **验证**：回归 `tests/test_bug8_package_size_bloat.js`（BUG8-1/2/3）RED→GREEN；全量单测 87 文件 / 1177 项全绿；API 预算 14/14；`git diff --check` clean。
- [ ] 真机 RSS/heap 监控（renderer process 数、v8 heapUsed）— 当前环境无 GUI，未量。

### 历史状态

- Bug 1~4 已修复并关闭（回归/全量/API 预算/相关 e2e 全绿）。

---

以上为本次"只分析、不改动"阶段的记录。

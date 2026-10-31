# M8 · 测试与质量体系

> 范围：`tests/`（93 个文件，91 个被 vitest 收取）、`e2e/`（34 个脚本 / `e2e:all` 25 套件）、
> `vitest.config.js`、`.github/workflows/ci.yml`、`tools/coverage_probe.cjs`。

## 1. 现状（实测）

| 指标 | 数值 | 备注 |
|---|---|---|
| 单测文件 | 91 | `vitest run` 收取 |
| 单测条目 | **1228** | 本轮实测 91 passed，23.26s |
| e2e 套件 | 25（`e2e/run_all.cjs`） | 另有 9 个脚本未进全量（如 `flicker` 需录屏权限） |
| CI | 仅 `npm test`，macOS-14，Node 20 | e2e / lint / 类型 / 覆盖率均不在 CI |
| 覆盖率工具 | 无 | `@vitest/coverage-*` 未安装 |
| 真实 `PageManager` 单测 | **0** | 全部用 `makePageManager()` mock 或读源码文本 |

单测质量整体**高于多数同类开源项目**：
- 判据下沉到 `shared/`，纯函数可测（M7）；
- 有「不变量测试」（`test_invariants.js`）、「导入完整性」（`test_imports.js`）、
  「API token 预算只许下降」（`test_api_budget.js`）这类**机制性**闸门；
- 测试名称就是事故编号（`AB-001`、`ST-RT-001`、`ACT-DL-1`），失败信息带恢复指引。

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| 不变量静态守护 | `tests/test_invariants.js:1-40` | 删掉「窗口可见 / tab 条 / watchdog 阈值」会立刻红 |
| API 预算只许下降 | `tests/test_api_budget.js:1-60` | 把「每轮 token 税」变成 CI 断言 |
| 导入完整性（ESM 链接期错误） | `tests/test_imports.js:1-15` | 防「删了导出忘了改 import，启动才炸」 |
| e2e 身份校验 + 独立端口 | `e2e/_harness.cjs:1-60`、`run_all.cjs:19-25` | 不会「跟冒牌 server 说话还以为在测自己」 |
| 结果解析只认 `PASS=n FAIL=m` | `run_all.cjs:1-20` | 观测格式坏掉时判失败，而不是假绿 |
| 失败信息写「为什么不能改 + 怎么恢复」 | `test_invariants.js` 全文 | 对 contributor 极友好 |

## 3. 问题清单

### P1-1 5857 行的 `PageManager` 没有行为级单测，全部依赖不进 CI 的 e2e

**证据**：`grep -rn "new PageManager" tests e2e` 无结果；`tests/test_ws_handlers.js:21`、
`test_evaluate_frame_ref.js:13` 等都是 `makePageManager()` 返回假对象；
`docs/AUDIT-2026-10-30.md` 也承认 `page_manager.js` 零单测。
CI（`.github/workflows/ci.yml`）只跑 `npm test`，e2e 需要真实桌面会话。

**影响**：这是项目最大的**质量单点**。读层/操作层/标签生命周期/清理逻辑全在这个类里，
而 PR 合并前能自动验证的只有「mock 的 WS 层」和「纯函数」。
本轮审计发现的 `_ensureCdp` 乐观记账、`getTree` 无 tab 返回 null、
`tabsInGroup` 裸解引用等问题，都属于「e2e 不覆盖、单测也没有」的盲区。

**修复（按性价比排序）**：
1. 把 `PageManager` 的**纯判据**继续外移（`tab_state` 已经是成功案例）；
2. 用假 `BrowserView`/假 `webContents`/假 `debugger` 构造 `PageManager`，
   单测「关闭 tab 的清理顺序」「路由选择」「布局计算」「CDP 失败后的降级」；
3. 至少把 `newTab`/`closeTab`/`setActive`/`_layoutAllViews` 四个方法抽成可注入依赖的
   函数，单测覆盖失败注入（某步抛错后无残留）。

**验收**：`new PageManager(fakeWindow)` 可在 vitest 下构造；新增 20+ 条行为单测；
e2e 套件数不减少。

---

### P1-2 CI 只跑 macOS 单测：没有 e2e、没有 Linux、没有 lint/类型/覆盖率

**证据**：`.github/workflows/ci.yml` 全文只有 `npm ci` + `npm test`（macos-14, node 20）。

**影响**：
- 一个只在 Linux 上出现的打包/路径问题（`pathToFileURL` 类）不会被发现；
- e2e 是产品的主要回归网（25 套件 / 800+ 断言），但只在作者本机跑；
- 没有 lint，`no-unused-vars` / 浮空 Promise / 未 await 只能靠人眼。

**修复**：
1. 加 Linux job（至少 `npm test`，验证路径/大小写敏感）；
2. 加 `lint`（ESLint）+ `node --check` 全量语法；
3. 选 2–3 个无 GUI 依赖的 e2e（`background`、`lifecycle`、`smoke`）在 CI 跑
   （Linux 用 xvfb，或 macOS runner 的隐藏窗口模式）；
4. 加覆盖率（先只对 `src/shared/` 设阈值，`page_manager` 逐步纳入）。

**验收**：PR 必须 4 个 check 全绿才能合并；CI 时长 < 15 分钟。

---

### P2-1 源码文本断言占比不低，容易「重构就红、行为坏了却绿」

**证据**：`test_invariants.js`、`test_bug5_tab_close_cleanup.js`（读 `page_manager.js` 文本）、
`test_bug7_nav_state_cleanup.js`、`test_tab_state_reset.js:122`、`test_mcp_forwarding.js`。

**影响**：这类测试的价值是「防止有人删掉护栏」，不是「验证行为」。
它们对**改名/搬家**极其敏感（把 `newTab` 拆成 `createTab` 就会红），
但对**逻辑错误**无能为力（文本还在，行为已坏）。

**建议**：保留少量「不变量」文本断言（窗口可见、tab 条存在、watchdog 阈值），
其余改成行为断言；如果必须读源码，断言「语义锚点」而不是具体函数名。

---

### P2-2 没有覆盖率度量，「58/61 模块有测试」是**引用计数**，不是覆盖

**证据**：`package.json` 无 coverage 脚本；`tools/coverage_probe.cjs` 是**页面可点元素覆盖率**
探针（README:762），不是代码覆盖率；审计文档里的「58/61」按模块是否被测试文件引用统计。

**影响**：无法回答「这个 PR 让哪块代码失去了覆盖」「`page_manager` 的实际行覆盖率是多少」。
对 21.7k 行的项目，这是决策盲区。

**建议**：`@vitest/coverage-v8`，先出报告不设阈值；下一版对 `src/shared/` 设 80%，
`src/main/page_manager.js` 设「不得低于当前值」。

---

### P2-3 `test_imports.js` 只扫 `.js`，漏掉 preload 的 `.cjs` require

**证据**：`test_imports.js:19-27` 的 `walk` 只收集 `entry.name.endsWith('.js')`。
preload 是 `.cjs`，通过 `require('./extractor.cjs')` 链接；删掉一个 `.cjs` 导出，
单测不会红，只有启动浏览器才炸（与它要防的问题同类）。

**修复**：walk 同时收 `.cjs`，并对 `require(...)` 做同样的导出存在性检查。

---

### P2-4 e2e 全量依赖真实站点/桌面，且部分套件「不在全量里」

**证据**：`run_all.cjs` 注释明确 `flicker` 故意不在全量（需要屏幕录制权限）；
`e2e/realsites/sites.cjs` 目前 17 个站点（README:980），依赖外网。

**影响**：真实站点会变（登录墙、反爬、A/B），e2e 红可能是站点变了而不是产品坏了；
但这类测试又是「真实世界可用性」的唯一证据。需要区分「产品回归」与「站点漂移」。

**建议**：给 realsites 套件打 `site-drift` 标签，失败时先跑 fixture 对照；
把关键断言（能读到正文、能点到按钮）与站点特定断言分开。

---

### P3-1 测试命名两种风格并存

`test_*.js` 与 `*.test.js` 都有；`vitest.config.js` 的 include 同时覆盖。
不影响运行，但不利于「按模块找测试」。建议统一为 `test_<module>.js`。

### P3-2 断言总数与套件数的口径要在文档里固定

README 写「658 unit + 447 e2e」，`docs/SPEC.md` 写「1228 条 / 25 套件 / 814 断言」，
本轮实测 1228。数字会漂，建议由脚本生成并写入 badge/文档，而不是手写。

## 4. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 4.0 | 判据下沉、纯函数测试、机制闸门，方向很对 |
| 逻辑 | 3.0 | 覆盖广度好，核心类与集成路径是盲区 |
| 质量 | 3.5 | 失败信息质量极高；文本断言与命名不统一 |
| 效率 | 4.0 | 1228 条 23s，反馈快 |
| 可测 | 3.0 | 纯函数 5 分，核心类 1 分，平均后偏中 |
| 风险 | 2.5 | 最大风险是「CI 绿但 e2e 红」 |

## 5. 结论

测试体系是项目最被低估的资产：**1228 条、23 秒、带事故编号与恢复指引**，
这已经是成熟团队的水平。当前不需要「写更多测试」，而是要把测试**放到正确的位置**：
1. 让 `PageManager` 可构造、可注入（解锁核心类单测）；
2. 让 CI 跑 lint + 一个 e2e 子集（解锁「合并前能发现集成回归」）；
3. 让覆盖率可见（解锁「知道自己在赌什么」）。

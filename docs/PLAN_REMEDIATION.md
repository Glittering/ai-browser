# AI Browser 整改计划（v2.5 → v2.7）

> 制定日期：2026-10-31　依据：[`docs/audit/pm-2026-10-30/`](audit/pm-2026-10-30/00-overview.md)
> 基线：v2.4.5 · `src/` 67 文件 / 21.7k 行 · 单测 91 文件 / 1228 条全绿（23s）
> 本文只描述「怎么改、改到什么程度、怎么证明改好了」，**不包含代码改动**。

---

## TL;DR（给忙碌的开发者）

1. **第一个 PR**：`SEC-01`（WS token + Origin）——关闭「浏览器内任意页面可驱动浏览器」的 P0。
2. **同一天并行**：`SEC-02`（删 `sendTree/sendDiff` + sender 校验）、
   `SEC-03`（用 `executeJavaScript` 替掉 preload `eval`）、`CORE-00`（fake Electron 骨架）。
3. **版本节奏**：2.5.0 安全版（WS 需 token，破坏性但附迁移）→ 2.6.0 结构版 →
   2.7.0 体验/质量版。
4. **每张卡都含**：Bug 证据 → 修复步骤 → 可执行验收 → 测试文件与关键断言 → 回滚开关；
   先写失败测试，再修。
5. **不要按章节顺序做**：按 1.4 的轨道与 1.6 的合并顺序做；`page_manager.js` 严格串行。

> 规模：51 张卡 / 约 61 人日；4 人并行约 6 周（含 2 周缓冲），2 人约 6–7 周，1 人约 12–14 周。

---

## 0. 使用说明

### 0.1 目标与非目标

**目标**

1. 关闭 P0/P1 安全缺口，使「用户敢用它登录」成立。
2. 让工具声明与实现一致（不再有「传了参数但静默失效」）。
3. 把两个上帝文件（`page_manager.js` / `extractTree`）各拆出第一刀，使后续开发可并行。
4. 把测试放到正确的位置：核心类可单测、CI 能发现集成回归、文档漂移会变红。

**非目标（本计划明确不做）**

- 不新增面向用户的浏览功能（书签、历史、扩展、下载管理器 UI 等）。
- 不全量迁移 TypeScript；只加 lint + 必要的 JSDoc。
- 不重写读层算法；只做等价拆分 + 缓存。
- 不改产品叙事（「不截图读页面」仍然成立；截图只作为诊断工具）。
- 不做多租户/远程访问；仍然是本机单用户工具。

### 0.2 任务卡字段

每张卡固定包含：

| 字段 | 含义 |
|---|---|
| ID | `SEC-01` / `API-02` / `CORE-03`…，全仓库唯一 |
| 优先级 | P0（立即）/ P1（本迭代）/ P2（排期）/ P3（顺手） |
| 估时 | XS ≤ 2h · S ≤ 0.5d · M 1–2d · L 3–5d |
| 轨道 | A 安全 / B 协议 / C 核心 / D 读+操作 / E 生命周期+观测 / F 质量+文档 |
| 依赖 | 必须先完成的任务 |
| 破坏性 | 是否改变对外行为；若改变，迁移方式是什么 |
| Bug | 代码证据（`file:line`）与影响 |
| 修复 | 具体到函数/文件/数据结构的做法 |
| 验收 | 可执行、可观测的完成标准（不是「代码写完」） |
| 测试 | 单测 / e2e / 手工，含文件路径与关键断言 |
| 回滚 | 出问题时如何退回 |

### 0.3 完成定义（DoD）

一个任务只有全部满足才算完成：

1. **先有失败测试**：能复现 bug 的测试已提交（red），修复后转绿（green）。
2. `npm test` 全绿，且新增/修改的测试覆盖了失败路径（不只是 happy path）。
3. 相关 e2e 套件全绿；若该任务不方便 e2e，必须在卡里写明原因与替代验证。
4. 回执/错误信息与实现一致：不新增「success 但没做成」、不新增空 `catch {}`。
5. 文档同步：README / SPEC / 工具描述 / 注释至少一处需要改的已改。
6. PR 描述含：根因、修复、验证命令、回滚方式、性能数字（如适用）。

### 0.4 测试分层

| 层 | 位置 | 用途 | 运行成本 |
|---|---|---|---|
| U | `tests/test_*.js`（Node） | 纯函数、类、协议、mock Electron | 毫秒 |
| J | `tests/test_*.js`（jsdom） | DOM 抽取、合成事件、内容可编辑 | 十毫秒 |
| E | `e2e/*.cjs`（真实 Electron） | 真实站点/真实 CDP/真实窗口 | 秒–分钟 |
| A | `e2e/security_*.cjs` | 攻击用例（页面内脚本、伪造 IPC） | 秒 |
| M | 手工清单 | 打包、签名、跨平台、Gatekeeper | 分钟 |

**命名约定**：新增单测统一 `tests/test_<domain>_<subject>.js`；新增 e2e 统一
`e2e/<domain>_<subject>.cjs`，并登记到 `e2e/run_all.cjs` 的 `SUITES`（除非明确标为 manual）。

### 0.5 建议的 PR 粒度

- 一张任务卡 = 一个 PR（最多两个：测试 + 实现，若测试需要先合入）。
- 跨卡重构（如 `CORE-01`）允许一个 PR，但必须保持 `npm test` 与既有 e2e 全绿。
- 禁止把「顺手格式化」混进功能 PR；格式化单独一个 PR。

### 0.6 常用命令

| 目的 | 命令 |
|---|---|
| 全量单测 | `npm test` |
| 单个单测文件 | `npx vitest run tests/test_ws_auth.js` |
| 单测监听 | `npx vitest tests/test_ws_auth.js` |
| 全量 e2e | `node e2e/run_all.cjs` |
| 指定 e2e 套件 | `SUITES=security_ws,ipc_trust node e2e/run_all.cjs` |
| 单个 e2e | `node e2e/security_ws.cjs` |
| 开发启动 | `npm start` |
| lint / 语法 / 覆盖率 | `npm run lint` / `npm run syntax` / `npm run coverage`（QA-01/03 落地后） |

> e2e 会启动真实 Electron 并默认使用 `~/.ai-browser`。跑之前先退出正在运行的实例，
> 或设置 `AI_BROWSER_USER_DATA=/tmp/ai-browser-e2e` 隔离 profile。

---

## 1. 总览

### 1.1 里程碑

| 里程碑 | 时间 | 主题 | 退出标准 |
|---|---|---|---|
| **M0 止血** | Day 1–3 | 关掉「页面 → 控制面」与「preload → Node」 | 攻击 e2e 全绿；无 token 的 WS 被拒；`browse_evaluate` 在无 CDP 时不会执行 Node |
| **M1 一致** | Week 1–2 | 声明=实现；文档=代码 | `browse_wait 20s` 可用；`subset/mode/focused_only` 有效；文档一致性测试进 CI |
| **M2 结构** | Week 3–4 | 两个上帝文件各拆第一刀 | `PageManager` 可被 fake 构造并有 20+ 行为单测；帧缓存命中；动作串行化 |
| **M3 收尾** | Week 5–6 | 生命周期/观测/质量体系 | CI 双平台 + lint + e2e 子集；覆盖率可见；SECURITY/ARCHITECTURE 落地 |

> 表中周次按 4 人并行编排，W5–W6 是回归/发布缓冲；2 人约 6–7 周，1 人约 12–14 周
> （协调成本会吃掉一部分并行收益）。
> 估时见每张卡，汇总见 [附录 E](#附录-e估时与人力)。

### 1.2 任务总表

| ID | 任务 | 优先级 | 轨道 | 估时 | 依赖 |
|---|---|---|---|---|---|
| SEC-01 | WS Origin 拒绝 + 启动 token | **P0** | A | M | — |
| SEC-02 | IPC 结果通道 sender 校验；删除 `sendTree/sendDiff` | **P0** | A | M | — |
| SEC-03 | 移除 preload `eval` 兜底（改用 `executeJavaScript`） | **P0** | A | S | — |
| SEC-04 | upload 目录白名单 + 大小/敏感路径 | P1 | A | M | — |
| SEC-05 | screenshot 路径白名单 + `ignored_params` 修正 | P1 | A | S | — |
| SEC-06 | preload 打包 + `sandbox:true` + 去掉全局 `--no-sandbox` | P1 | A | L | SEC-01..05 |
| SEC-07 | `window.open` 每 tab 密钥签发与校验 | P1 | A | S | SEC-02 |
| API-01 | MCP 每次调用独立超时（跟随 `timeout_ms`） | P1 | B | S | — |
| API-02 | `subset` / `mode` 对默认读法生效 | P1 | B | M | — |
| API-03 | `focused_only` 真正只返回焦点子树 | P1 | B | S | API-02 |
| API-04 | 参数契约测试（schema 字段必须被消费） | P1 | B | M | — |
| API-05 | 方法注册表（WS / MCP / 文档单一事实源） | P2 | B | L | API-04 |
| API-06 | 统一错误信封 + `id:null` + 非法参数 | P2 | B | M | — |
| API-07 | `ui.wait` 按条件选探针（不再每轮抽整树） | P1 | B | S | — |
| API-08 | `paint_check` 走统一路由 | P3 | B | XS | — |
| API-09 | `protocol.js` 变成真源或删除 | P3 | B | XS | — |
| CORE-00 | Fake Electron 测试骨架（解锁核心类单测） | **P0** | C | M | — |
| CORE-01 | 抽出 `CdpHub`，修 `enable` 乐观记账 | P1 | C | M | CORE-00 |
| CORE-02 | 抽出 `ViewShell`，布局公式唯一 | P2 | C | M | CORE-01 |
| CORE-03 | 抽出 `TabRegistry`，全局 tab 上限 | P2 | C | L | CORE-02 |
| CORE-04 | `tabsInGroup/listTabs` 存活保护 | P1 | C | S | CORE-00 |
| CORE-05 | `closeTab` 的 debugger detach 单一归属 | P3 | C | XS | CORE-01 |
| CORE-06 | 淘汰事件广播 + 回执 `evicted` | P2 | C | S | CORE-03 |
| CORE-07 | `newTab` 初始化管线 + 失败回滚 | P2 | C | M | CORE-02 |
| READ-00 | 抽取器 characterization 测试（20 fixture） | P1 | D | M | — |
| READ-01 | `extractTree` 按判据拆文件 | P2 | D | L | READ-00 |
| READ-02 | OOPIF 帧树缓存 + 并行 + 每帧超时 | P1 | D | M | READ-00 |
| READ-03 | `getTree` in-flight 去重 + 超时冷却 | P1 | D | S | CORE-00 |
| READ-04 | 树 diff 缓存上限 | P2 | D | S | API-02 |
| READ-05 | `TreeContract.normalize()`（两读法同构） | P2 | D | M | API-02/03 |
| ACT-01 | 每 tab 动作队列 + 取消令牌 | P1 | D | L | CORE-00 |
| ACT-02 | 降级原因进回执（`fallback.reason`） | P2 | D | S | — |
| ACT-03 | preload `clear` 语义与 CDP 对齐 | P2 | D | S | — |
| ACT-04 | 不可逆对话框提示（不改变自动接受） | P3 | D | S | — |
| LIFE-01 | cookie 固化开关 + 退出预算 | P2 | E | S | — |
| LIFE-02 | watchdog 用系统空闲时间，避免打断人 | P2 | E | S | — |
| LIFE-03 | 有 agent 连接时 `Cmd+W` 隐藏而非退出 | P2 | E | M | — |
| LIFE-04 | 两个轮询降频/事件化 | P3 | E | S | — |
| OBS-01 | 网络捕获状态可见（`capture_error`） | P2 | E | S | — |
| OBS-02 | canvas hook 默认策略（先测量再决定） | P2 | E | M | 测量脚本 |
| OBS-03 | 下载同名文件唯一化 | P2 | E | S | — |
| OBS-04 | diff 截断给出丢失范围 | P3 | E | S | — |
| QA-01 | CI：Linux + lint + 语法检查 | P1 | F | M | — |
| QA-02 | CI：e2e 子集（smoke/background/lifecycle） | P1 | F | M | SEC-01 |
| QA-03 | 覆盖率度量与阈值 | P2 | F | S | — |
| QA-04 | `test_imports` 覆盖 `.cjs` | P2 | F | XS | — |
| QA-05 | 源码文本断言逐步行为化 | P3 | F | M | CORE-00 |
| DOC-01 | README/SPEC 与代码一致性 + 测试 | P1 | F | S | — |
| DOC-02 | 当前架构文档 + ADR + 历史横幅 | P2 | F | M | — |
| DOC-03 | `docs/SECURITY.md`（信任边界） | P2 | F | S | SEC-01..06 |
| REL-01 | 发布脚本 `--dry-run` / 确认 / 拆分安装 | P2 | F | S | — |

### 1.3 依赖图（关键路径）

```
CORE-00 ─► CORE-01 ─► CORE-02 ─► CORE-03 ─► CORE-06
   │            └────► CORE-05
   ├────► CORE-04
   ├────► READ-03
   └────► ACT-01

SEC-02 ─► SEC-07
SEC-01..05 ─► SEC-06 ─► DOC-03

READ-00 ─► READ-01
   └────► READ-02

API-02 ─► API-03 ─► READ-05
   └────► READ-04

API-04 ─► API-05
```

**关键路径**：`CORE-00 → CORE-01 → CORE-02 → CORE-03`（结构改造）。
安全线（SEC-01/02/03）不依赖任何人，应第一天并行启动。

### 1.4 并行编排（4 人）

| 周 | 人 1（A 安全） | 人 2（B 协议） | 人 3（C 核心） | 人 4（D 读/操作） |
|---|---|---|---|---|
| W1 | SEC-01/02/03/05 | API-01/07/04 | CORE-00/01 | READ-00/02 |
| W2 | SEC-04/07；SEC-06 启动 | API-02/03/06；DOC-01 | CORE-02/04 | READ-03；ACT-01 启动 |
| W3 | SEC-06 收尾；DOC-03 | API-05 启动；QA-01 | CORE-03/05/06 | ACT-01 收尾/02/03 |
| W4 | 安全回归 + 攻击用例扩展 | API-05 收尾；QA-02 | CORE-07；QA-05 | READ-01（拆文件） |
| W5 | 支援 | 支援 | 支援 | READ-04/05 |
| W6 | 全员：LIFE/OBS/QA-03/04、REL-01、发布 2.7 | | | |

### 1.5 文件所有权（避免合并冲突）

| 文件/目录 | W1–W2  owner | W3–W4 owner | 备注 |
|---|---|---|---|
| `src/main/ws_server.js` | A（仅 connection/auth 顶部） | B（case 重构） | A 先合；B 后动 |
| `src/preload/bridge.cjs` | A | — | SEC-02/03/06 串行 |
| `src/main/page_manager.js` | A（IPC/eval/upload/screenshot 区域） | C（类拆分）→ D（读/操作区域） | **严格串行**，见 1.6 |
| `src/main/index.js` | A（sandbox 开关） | E（生命周期） | |
| `src/main/mcp_*.js` | B | B | |
| `src/preload/extractor.cjs` | D | D | |
| `src/shared/*`（新增） | 各自新建文件 | 同左 | 新文件不冲突 |
| `tests/helpers/*` | C | C | 其他轨道只读 |

### 1.6 `page_manager.js` 合并顺序（重要）

这个文件会被 A/C/D 三条轨道同时触碰，必须按窗口合并：

1. **W1**：A 只改「IPC handlers + `evaluate` + `screenshot` + `upload` + `_windowOpen*`」区域，
   不碰 tab/read 主体；C 只新建 `src/main/cdp_hub.js`，对 `page_manager` 只做「替换调用」。
2. **W2**：C 合入 `CdpHub` 替换；A 已合完，不再动该文件。
3. **W3**：C 做 `ViewShell`/`TabRegistry` 提取；D 不动 `page_manager`，只做 `READ-00` 与
   新文件 `shared/tree_subset.js`。
4. **W4**：C 合完后再把 `page_manager` 交给 D 做 `READ-02/03`、`ACT-01`。

> 违反顺序的 PR 一律 rebase 重做，不接受「先合再修冲突」——这个文件 5857 行，
> 冲突手工解决的风险高于等待一天。

### 1.7 进度跟踪

- 每张任务卡对应一个 GitHub Issue，标题 `[SEC-01] WS Origin 拒绝 + 启动 token`，
  标签 `track:A`、`priority:P0`、`milestone:M0`。
- 看板四列：**Backlog → In Progress → In Review → Done**。卡进入 In Progress 前，
  必须把本卡的「验收」与「测试」原样抄进 Issue，避免实现时降低标准。
- 状态只允许五种：`todo` / `doing` / `review` / `done` / `blocked`；每周五更新一次
  `docs/PLAN_REMEDIATION.md` 任务总表（新增「状态」列）或单独的
  `docs/remediation-status.md`。
- 阻塞超过 1 天：在 Issue 写 `blocked-by: <ID>`，周会调整顺序；不要私下跳过依赖。
- 合并顺序以 1.6 为准；违反者 rebase，不接受「先合再修冲突」。

---

## 2. M0：安全止血（Day 1–3）

> 目标：关闭「浏览器内页面 → 控制面」与「页面 → preload Node」两条链。
> 本周**不添加任何新功能**；所有修复都必须带攻击用例。

### SEC-01 · WS Origin 拒绝 + 启动 token　`P0` `M` `Track A`

**Bug**
WS 只绑定 loopback，但连接处理完全忽略请求头：
`ws_server.js:110` `wss.on('connection', (ws, _req) => { ... })`，没有 token、没有 `Origin` 校验。
路由默认打当前激活标签（`:176-205`），且 `tab` 参数可指向任意标签
（`page_manager.js:693-701`）。浏览器内任意页面脚本都能连 `ws://127.0.0.1:9223`，
读取所有登录态标签、执行任意 JS、截图。

**修复**
1. 新增 `src/shared/ws_auth.cjs`（CJS，main/CLI/MCP 共用）：
   - `tokenPath()` → `${config.userDataDir}/ws-token`（默认 `~/.ai-browser/ws-token`）；
     路径必须与 `AI_BROWSER_USER_DATA` 联动；CLI/MCP 若使用自定义 profile，需带同一个环境变量；
   - `ensureToken()`：不存在或损坏时 `crypto.randomBytes(32).toString('hex')`，
     写 `{ token, port, pid, created_at }`，目录 `0700`、文件 `0600`；
   - `readToken()`、`timingSafeEqual(a,b)`（长度不同直接 false）；
   - 允许 `AI_BROWSER_WS_TOKEN` 覆盖（CI/临时调试）。
2. `index.js` 在 `app.whenReady` 前调用 `ensureToken()`（每次启动**轮换**）；退出时删除文件。
3. `ws_server.js` 连接第一段：
   ```js
   wss.on('connection', (ws, req) => {
     if (req.headers.origin) return ws.close(1008, 'origin not allowed');
     const url = new URL(req.url, `http://${config.wsBindHost}`);
     const token = url.searchParams.get('token')
       || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
     if (!token || !timingSafeEqual(token, readToken())) return ws.close(1008, 'unauthorized');
     ...
   });
   ```
   未认证 socket 不进入 JSON-RPC 分发（连 `ui.hello` 都不允许）。
4. `mcp_ws.js` / `scripts/cli_call.cjs` / `e2e/_harness.cjs` 在每次连接时读取 token 并拼到 URL；
   读不到时重试 500ms（Electron 可能仍在启动），最多 10s。
   e2e 统一走 `_harness.cjs` 的 `connect()`，禁止脚本各自 `new WebSocket`
   （`security_ws.cjs` 例外）；加一条静态检查防未来绕过。
5. **测试迁移（同一 PR 完成，否则 CI 全红）**：
   - `vitest.config.js` 加 `setupFiles:['tests/setup.js']`；`tests/setup.js` 设
     `process.env.AI_BROWSER_WS_TOKEN = 'vitest-token'`（`readToken` 优先读 env）；
   - 新增 `tests/helpers/ws_url.js`：`wsUrl(port)` 自动拼 `?token=`；
   - 更新直接 `new WebSocket` 的 5 个文件：`test_act_params.js`、
     `test_evaluate_frame_ref.js`、`test_nav_wait.js`、`test_ws_handlers.js`、
     `test_ws_protocol.js`；`test_mcp_ws.js` / `test_cli_call.js` 的 URL 同步；
   - `test_ws_auth.js` 显式删除 env 测「无 token / 错 token」，测完恢复。
6. 迁移开关：`AI_BROWSER_WS_ALLOW_ANONYMOUS=1` 时跳过 token（仅限本地开发者），
   启动日志打印一次显眼警告；默认**关闭**。2.6.0 删除该开关。

**验收**
- 无 token 的 Node 客户端连接被关闭（1008），且收不到任何 RPC 结果。
- 带 `Origin: https://evil.example` 的连接被关闭，即使 token 正确。
- 带正确 token 的 `ai-browser call ui.list_tabs` 正常。
- 浏览器内页面执行 `new WebSocket('ws://127.0.0.1:9223')` 后无法收到任何响应（e2e）。

**测试**
- `tests/test_ws_auth.js`（U）：
  - `ensureToken` 生成 64 hex、文件 mode `0600`、重复调用复用；
  - `timingSafeEqual` 长度/内容不同均 false；
  - 起一个 `startWSServer(fakePM, 0)`，分别用「无 token / 错 token / 带 Origin / 正确」
    连接，断言 close code 与是否能 `ui.list_tabs`。
- `e2e/security_ws.cjs`（A，新套件）：
  起本地 http fixture，页面脚本尝试 WS；断言 `window.__attackResult === 'blocked'`；
  同时 Node 侧带 token 的调用成功（证明拦截不是「服务没起来」）。
- `tests/test_cli_token.js`（U）：mock `readToken` 缺失 → CLI 打印可执行提示，而不是 `ECONNREFUSED`。
- `tests/test_e2e_ws_usage.js`（U）：除 `_harness.cjs` / `security_ws.cjs` 外，
  `e2e/*.cjs` 不得出现 `new WebSocket`（防止未来绕过 token）。

**回滚**：`AI_BROWSER_WS_ALLOW_ANONYMOUS=1` 恢复旧行为（一个版本）。
**破坏性**：是。迁移文档必须写进 README 的「Raw WebSocket」小节与 release notes。

---

### SEC-02 · IPC 结果通道 sender 校验；删除 `sendTree/sendDiff`　`P0` `M` `Track A`

**Bug**
`bridge.cjs:21-23` 通过 `contextBridge.exposeInMainWorld` 把 `sendTree` / `sendDiff`
暴露给页面主世界；主进程 `ai:tree`（`page_manager.js:389-396`）只看 `payload.id`，
从全局 `_pendingRequests` 取出 pending 并 resolve，**不校验 sender，也不校验该请求属于哪个 tab**。
`ai:action_result`（`:398-407`）、`ai:evaluate_result`（`:409-417`）、
`ai:diff`（`:419-421`）、`ai:event`（`:423-427`）同样不校验。
`_requestId` 全局自增（`:219, 1153`），可猜可枚举。

**影响**：页面可通过 `sendTree/sendDiff` 伪造 agent 读到的树、注入 `dom_change` 事件；
`ai:action_result` / `ai:evaluate_result` 虽未直接暴露给页面，但缺少 sender 绑定，
任何被注入的 preload 或其他 webContents 都能跨 tab 命中 pending。
`sendTree/sendDiff` 在生产代码中**没有任何调用方**。

**修复**
1. 删除 `bridge.cjs` 中 `sendTree` / `sendDiff` 暴露（生产无调用方）；
   `ai:diff` 的唯一生产者就是 `sendDiff`，因此连同 handler 一起删除。
   `ai:event` **保留**：它是 watcher 的内部通道，没有暴露给页面，但要加 sender 绑定。
2. `_pendingRequests` 的值从 `{resolve,reject}` 改为
   `{resolve,reject,tabId,kind}`；三处发起请求时写入：
   - `getTree`（`:1153`）`tabId=tid, kind='tree'`
   - `evaluate` 的 preload 路径（SEC-03 会删除，可忽略）
   - `executeAction`（`ai:action`）`tabId=tid, kind='action'`
3. 复用已有 `_tabIdForContents(sender)`（`page_manager.js:523`，按 `webContents`
   对象身份匹配）；补测试覆盖已销毁 / 未知 sender 返回 `null`。
4. 每个 `ipcMain.on('ai:*')` 第一行：
   ```js
   const senderTab = this._tabIdForContents(event.sender);
   if (senderTab === null || senderTab === undefined) return;
   const pending = self._pendingRequests.get(id);
   if (!pending || pending.tabId !== senderTab || pending.kind !== expectedKind) return;
   ```
5. `ai:event`：`senderTab` 必须非空，广播时附 `tab: senderTab`；
   不需要 secret（页面没有入口），但若未来把事件通道暴露给页面，必须补「每 tab secret + nonce」。
6. `window.open` 见 SEC-07；`dl` 通道已有 `isChromeSender`，保持不变。

**验收**
- 页面里 `typeof window.__ai_browser__.sendTree === 'undefined'`。
- 即使绕过暴露面直接 `ipcRenderer.send('ai:tree', ...)`（模拟被注入的 preload），
  sender/pending 不匹配也不会 resolve。
- tab A 发送 tab B 的 action 结果被忽略；A 自己结果的正常路径不受影响。
- watcher 事件仍能到达订阅者，且带正确 `tab`。

**测试**
- `tests/test_ipc_sender.js`（U）：用 fake `ipcMain` + fake sender→tab 映射；
  - `ai:tree` 的 sender 是 tab2、pending 属于 tab1 → 不 resolve；
  - 正确 sender → resolve；
  - `ai:action_result` 同理；
  - `ai:event` 的 sender 未知 → 不广播。
- `e2e/ipc_trust.cjs`（A）：页面脚本尝试 `__ai_browser__.sendTree`（undefined）；
  尝试 `window.open` 伪造 token；断言 agent 仍读到真实树、没有新 tab。
- `tests/test_bridge_surface.js`（U）：用 fake `electron` / `contextBridge` 加载
  `bridge.cjs`，捕获 `exposeInMainWorld` 的对象，断言 key 只含 `windowOpenBridge` 与 `dl`
  （白名单），新增暴露面必须显式改测试。

**回滚**：无行为兼容问题（删除的是死代码）；watcher 若受影响，回滚单个事件通道。

---

### SEC-03 · 移除 preload `eval` 兜底（改用 `executeJavaScript`）　`P0` `S` `Track A`

**Bug**
`page_manager.evaluate` 在 CDP 失败时 fallback 到 preload：
`page_manager.js:2472-2477`（CDP 失败后的 catch）→ `page_manager.js:2514-2526` 的
`_evaluateViaPreload` → `bridge.cjs:112-131` 的**直接 `eval(data.js)`**。
preload 是 `sandbox:false` 的 CJS 模块作用域，`require` 在作用域内可见。
唯一防护是 `shared/guards.js:6` 的正则：
`\bprocess\.\b|\brequire\s*\(|\bchild_process\b|\bglobalThis\.process\b`。
`("req"+"uire")("child_process")` 即可绕过 → 宿主任意代码执行。
工具文档却把 `browse_evaluate` 描述为「页面上下文执行」。

**修复**
1. `_evaluateViaPreload` 改为 `_evaluateViaWebContents`：
   ```js
   const wc = view.webContents;
   if (!wc || wc.isDestroyed()) throw new Error('cdp-unavailable');
   return await wc.executeJavaScript(js, true); // main world，无 Node
   ```
   `executeJavaScript` 不受页面 CSP 影响，也不需要 debugger。
2. 删除 `bridge.cjs` 的 `ai:evaluate` / `ai:evaluate_result` 监听，以及
   `_pendingRequests` 中 `kind='evaluate'` 的分支。
3. `guards.js` 保留，但注释与错误信息改为「防误用，不是沙箱」；
   README/工具描述同步。
4. 若 `executeJavaScript` 也失败：返回 `{ok:false,error:'cdp-unavailable',hint:'页面已销毁或正在导航，稍后重试'}`，
   **不再换上下文执行**。

**验收**
- 断开 CDP（fake `sendCommand` 抛错）后调用 `browse_evaluate`，返回 `cdp-unavailable`，
  且在页面里 `typeof require === 'undefined'`。
- 传入 `("req"+"uire")("child_process")` 不会启动子进程（进程数/哨兵文件断言）。
- 正常路径 `browse_evaluate('1+1')` 仍返回 2。

**测试**
- `tests/test_evaluate_context.js`（U）：fake view 的 `executeJavaScript` 被调用；
  `ai:evaluate` 通道不存在；CDP 失败 → 错误码。
- `e2e/evaluate_context.cjs`（A）：页面内断言 `typeof require === 'undefined'`、
  `typeof process === 'undefined'`；尝试拼接 require 后返回错误而不是执行。
- 手工：在 `about:blank`（无 CDP 可用场景）调用一次 evaluate，确认降级路径不崩。

**回滚**：保留 `_evaluateViaWebContents` 的开关 `AI_BROWSER_EVAL_FALLBACK=0`（默认关）。

---

### SEC-04 · upload 目录白名单 + 大小/敏感路径　`P1` `M` `Track A`

**Bug**
`browse_act {action:'upload', file:'/任意/绝对路径'}`（`mcp_tools.js:55`）直接进入
`_uploadViaCdp` 的 `DOM.setFileInputFiles({files:[filePath]})`（`page_manager.js:3229`）；
OOPIF 路径会把文件字节读进页面（`:3256+`）。没有白名单、大小上限、敏感路径拒绝。
这是 agent 唯一能读宿主文件的通道（evaluate 在页面上下文读不到本地文件），
一次 prompt injection 即可外传 `~/.ssh/id_rsa`。

**修复**
1. 新增 `src/shared/upload_guard.js`（ESM）：
   ```js
   export function resolveUploadPath(input, roots, { maxBytes }) {
     const abs = fs.realpathSync(path.resolve(input));      // 解 symlink
     const allowed = roots.map(r => fs.realpathSync(r));
     if (!allowed.some(r => abs === r || abs.startsWith(r + path.sep))) throw ...
     if (abs.split(path.sep).some(s => s.startsWith('.'))) throw ... // .ssh/.aws/.env
     const st = fs.statSync(abs);
     if (!st.isFile()) throw ...;
     if (st.size > maxBytes) throw ...;
     return { path: abs, size: st.size };
   }
   ```
2. 默认 roots：`~/Downloads`、`config.userDataDir/uploads`；Desktop/Documents **不默认**，
   需要时用 `AI_BROWSER_UPLOAD_ROOTS` 显式追加（`:` 分隔）。这样 prompt injection
   至少不能直接读 `~/Documents` 下的合同/密钥；错误提示会给出如何追加。
3. 默认 `maxBytes = 25MB`；`AI_BROWSER_UPLOAD_MAX_MB` 覆盖。
4. `_uploadViaCdp` / `_uploadViaFrameJs` 入口先过 guard；失败返回
   `{success:false, error:'upload-path-denied', hint:'allowed roots: ...'}`。
5. 回执增加 `uploaded_path`（绝对路径）与 `size`；README 安全节写明这是本地文件读取原语。

**验收**
- `/etc/passwd`、`~/.ssh/id_rsa`、`~/Downloads/../.ssh/id_rsa`、符号链接指向外部 → 全部拒绝。
- `~/Downloads/a.pdf`（<25MB）→ 成功，回执含路径与大小。
- 30MB 文件 → 拒绝，错误码稳定。
- 页面拿不到被拒文件的任何字节。

**测试**
- `tests/test_upload_guard.js`（U）：临时目录构造上述 6 种路径 + 大小；断言错误码。
- `e2e/upload_guard.cjs`（A）：真实 `<input type=file>`，分别上传允许/禁止文件；
  断言页面 `input.files[0].name` 与回执一致/拒绝。
- 手工：macOS 的 `/tmp` 是 symlink 到 `/private/tmp`，确认 realpath 后仍在白名单外时拒绝。

**回滚**：`AI_BROWSER_UPLOAD_ROOTS` 设为 `/` 可恢复旧行为（不推荐，仅应急）。

---

### SEC-05 · screenshot 路径白名单 + `ignored_params` 修正　`P1` `S` `Track A`

**Bug**
`ui.screenshot {path:'/任意/绝对路径'}` 会 `fs.mkdirSync(dirname,{recursive:true})` 后写文件
（`page_manager.js:1462-1472`），等于本地任意文件写入。且 `ws_server.js:711` 把含 `tab`
的整个 `params` 传给 `screenshot`，`known` 白名单不含 `tab`（`:1482`），
回执每次都多一条 `ignored_params:['tab']` 的假警告。

**修复**
1. 新增 `resolveScreenshotPath(input, { allowAny })`：
   - 默认根 `config.userDataDir/screenshots`（可用 `AI_BROWSER_SCREENSHOT_DIR`）；
   - `path.relative(root, abs)` 必须不以 `..` 开头且非绝对；
   - 目录 `0755`、文件 `0644`；拒绝已存在的符号链接目标。
2. `allow_any_path:true` 只在 raw WS 可用（MCP 不暴露），且需 `AI_BROWSER_SCREENSHOT_ANY=1`。
3. `screenshot` 的 `known` 加入 `tab`、`allow_any_path`；`tab` 不再进 `ignored_params`。
4. `ws_server` 截图分支只传截图相关字段（`tab` 单独作为参数），从根上避免误报。

**验收**
- `/tmp/x.png` 默认被拒；`~/.ai-browser/screenshots/x.png` 成功。
- 回执 `ignored_params` 在正常调用时为空。
- 不存在的父目录会创建，且权限符合预期。

**测试**
- `tests/test_screenshot_path.js`（U）：`../`、绝对路径、symlink、允许根内的嵌套路径。
- `tests/test_ws_handlers.js` 增加：`ui.screenshot` 回执 `ignored_params` 不含 `tab`。
- `e2e/paint` 套件复用截图，确认路径默认值不破坏现有断言。

**回滚**：`AI_BROWSER_SCREENSHOT_ANY=1` 恢复任意路径（仅本地调试）。

---

### SEC-06 · preload 打包 + `sandbox:true`　`P1` `L` `Track A`

**Bug**
`index.js:460` 无条件 `app.commandLine.appendSwitch('no-sandbox')`；
`page_manager.js:3793` 每个 view `sandbox:false`（因为 preload 需要 `require` 本地 CJS）。
这使 SEC-02/03 的后果从「页面级」升级为「宿主级」。

**修复（分两步，允许跨里程碑）**
1. **2.5.x（低风险）**：`no-sandbox` 收进 `AI_BROWSER_NO_SANDBOX=1` 显式开关；
   默认不 append。打包版单独验证启动（`e2e/smoke` + 手工）。
   CI / 容器（root 或缺少 SUID sandbox）在 workflow 里显式设 `AI_BROWSER_NO_SANDBOX=1`，
   本地默认保持 sandbox 开启。
2. **2.6.0（结构性）**：
   - 加 `esbuild` devDependency 与 `scripts/build_preload.cjs`：
     `src/preload/bridge.cjs` + `extractor.cjs` + `actions.cjs` + `watcher.cjs` +
     它们 require 的 `shared/*.cjs` → `dist/preload.js`（CJS，单文件）。
     参数：`format:'cjs'`、`platform:'node'`、`external:['electron']`、
     `target:'node20'`、`sourcemap:false`；产物里 `require("electron")` 必须保留。
   - `page_manager` 的 `preload` 指向 `dist/preload.js`，`sandbox:true`。
   - `npm start` / `e2e` 前自动构建；`package.json files` 加 `dist/preload.js`。
   - `npm test` 不依赖构建（单测直接 require 源文件）。
3. 保留 `AI_BROWSER_PRELOAD_SOURCE=1` 回退到未打包 preload（排查用）。

**验收**
- `BrowserView` 的 `webPreferences.sandbox === true`（测试可读构造参数）。
- preload 里 `process.sandboxed === true`；`window.__ai_browser__` 仍可用。
- 默认启动不再带 `--no-sandbox`（`app.commandLine.hasSwitch('no-sandbox') === false`）。
- 打包 dmg 在 macOS 上启动、`smoke`/`interact`/`value` 全绿。
- 读层/操作层功能不退化（e2e 25 套件全绿）。

**测试**
- `tests/test_preload_bundle.js`（U）：构建产物存在、能被 `new Function` 解析、
  包含 `extractTree`/`executeAction` 导出、大小 < 1.5MB。
- `tests/test_view_options.js`（U）：fake `BrowserView` 构造参数断言 `sandbox:true`、
  `nodeIntegration:false`、`contextIsolation:true`。
- `e2e/security_sandbox.cjs`（A）：页面里 `typeof require === 'undefined'`，
  且 preload 的桥仍可用；`process.sandboxed` 通过 `executeJavaScript` 读不到（预期）。
- 手工：dmg 安装后启动 + 登录一个站点 + 下载一次。

**回滚**：`AI_BROWSER_NO_SANDBOX=1` + `AI_BROWSER_PRELOAD_SOURCE=1` 同时打开。
**风险**：打包引入构建步骤；必须在 `npm start`/e2e harness/发布脚本三处都接上。

---

### SEC-07 · `window.open` 每 tab 密钥签发与校验　`P1` `S` `Track A`

**Bug**
页面可调用 `windowOpenBridge('open', 任意token, 'https://phishing')`（`bridge.cjs:31-37`），
主进程 `ai:window_open`（`page_manager.js:435-467`）不校验 token 是否由我们签发，
直接建 tab；组满时还会淘汰并关闭另一个 tab（`:452-459`）。

**修复**
1. 主进程为每个 tab 生成 `secret = crypto.randomBytes(16).toString('hex')`，存在
   `_windowOpenSecrets: Map<tabId, secret>`；注入 shim 时把 `__AI_SECRET__` 替换成它。
   shim 生成的 token 形如 `<secret>:<seq>_<ts>`，**前缀是 tab 身份，后缀区分同一 tab 的多个窗口**。
2. shim 的所有调用都带完整 token；主进程用 `_tabIdForContents(event.sender)` 找到 tab，
   校验 `p.token.startsWith(secret + ':')`；不等直接 return（可选记一条 `window_open_denied`）。
3. `nav`/`close` 仍用 `_windowOpenTokens`（完整 token → 子 tab）做二次校验：
   token 必须存在且 `sourceTabId === senderTab`。
4. 组满淘汰只对「签发过的 open」生效；伪造请求在淘汰之前就被拒。
5. secret 在 `closeTab` 时清理（登记进 `tab_state` 的 PER_TAB 清单）。

**验收**
- 页面脚本用随机 token 调 `windowOpenBridge('open', ...)` → 不创建 tab、不淘汰。
- 页面正常 `window.open('')` / `location=` 仍能开 tab（shim 用正确 secret）。
- `nav` 只作用于自己创建的占位 tab；跨 tab 的 token 被拒。

**测试**
- `tests/test_window_open_token.js`（U）：fake ipcMain/sender；
  伪造 token 不建 tab；正确 secret 建 tab；组满时只淘汰一次；`close` 后 secret 清理。
- `e2e/window_open` 套件扩展：页面内直接调用随机 token，断言 tab 数不变。
- `tests/test_tab_state_reset.js`：`_windowOpenSecrets` 必须出现在 PER_TAB 清单。

**回滚**：保留 `AI_BROWSER_WINDOW_OPEN_LEGACY=1` 跳过 secret 校验（仅一个版本）。

---

## 3. M1：声明 = 实现（契约）

### API-01 · MCP 每次调用独立超时　`P1` `S` `Track B`

**Bug**
`mcp_ws.js:26` 固定 `timeout = 15000`；`:154-161` 到点 reject `WS timeout`。
但工具声明了更长预算：`mcp_tools.js:56`（act 1s..300s）、`:166`（wait，服务端上限 120s）。
通过 MCP 调 `browse_wait {timeout_ms:60000}` 第 15 秒必失败，服务端仍在轮询。

**修复**
1. `createWsClient.call(method, params, { timeoutMs })`：每次调用用自己的 deadline，
   默认仍 15s。
2. 新增 `src/shared/tool_timeout.js`：
   ```js
   export function timeoutForTool(name, args = {}) {
     if (name === 'browse_wait') return Math.max(15000, (args.timeout_ms ?? 10000) + 5000);
     if (name === 'browse_act')  return Math.max(15000, (args.timeout_ms ?? 15000) + 5000);
     if (name === 'browse_navigate') return Math.max(15000, (args.timeout_ms ?? 30000) + 5000);
     return 15000;
   }
   ```
3. `mcp_server` 每次 `wsClient.call` 传入该值；错误信息带 `{method, elapsed_ms}`。
4. 服务端保持现有上限（wait 120s、act 300s），不重复加。

**验收**
- `browse_wait {timeout_ms:20000}` 在 17s 才出现条件时成功（不是 15s 超时）。
- 超时错误文本包含方法名与耗时。
- 普通工具仍在 15s 左右超时，避免「一个坏工具拖住整轮」。

**测试**
- `tests/test_tool_timeout.js`（U）：表格驱动，断言 5 个工具的计算值。
- `tests/test_mcp_ws_timeout.js`（U）：本地起一个延迟 200ms 的 WS server，
  client 设 `timeoutMs:100` → 错误含 `elapsed`；设 500 → 成功。
- `e2e/wait_long.cjs`（E，标记 slow）：页面 17s 后出现文本，MCP 调用成功；
  记录耗时，断言 > 16000ms。

**回滚**：`AI_BROWSER_MCP_TIMEOUT_MS` 覆盖全局默认（应急）。

---

### API-02 · `subset` / `mode` 对默认读法生效　`P1` `M` `Track B`

**Bug**
`ws_server.js:270-276` 只有 `params.ax` 为真才把 `subset/mode` 传给
`getTreeViaAx`；默认分支 `getTree(focusedOnly, tabId)` 完全不接。
实现只在 AX：`page_manager.js:1583`（diff）、`:1593`（interactive）。
MCP schema 无条件声明二者（`mcp_tools.js:36-37`、`mcp_server.js:112-117`）。
传 `subset:'interactive'` 仍返回全量树；`mode:'diff'` 没有 `diff` 字段。

**修复**
1. 新增 `src/shared/tree_subset.js`（纯函数，ESM）：
   - `isInteractive(node)`：有 `click/type/setContent/clear` 动作，或
     `state` 含 `editable/focusable`，或 role 属于 `button/link/textbox/checkbox/...`；
   - `pruneInteractive(tree)`：保留交互节点及其祖先链，保留根 `stats/context`；
   - `liteTree(tree)`：只留 `id/role/label/url/bounds/states/actions/primary/editor_type`；
   - `diffTrees(prevLite, nextTree)`：按 id 返回 `{added, removed, changed}`；
     与现有 AX diff 的字段保持一致（`node.id` 为准）。
2. `page_manager.getTree` / `getTreeViaAx` 读出后统一过：
   ```js
   if (subset === 'interactive') res.tree = pruneInteractive(res.tree);
   if (mode === 'diff') {
     const prev = this._treeDiffCache.get(tid);
     res.diff = prev ? diffTrees(prev, res.tree) : { added: [], removed: [], changed: [], first: true };
     this._treeDiffCache.set(tid, liteTree(res.tree));
   }
   ```
   `getTree` 签名改为 `getTree({ focusedOnly, subset, mode }, tabId)`（或对象参数，内部调用点同步）。
   `getTreeViaAx` 删除自带的 diff 实现，改用共享函数（保持旧字段兼容）。
3. `ws_server` 两条路径都传参数；`mcp_tools` 描述补一句「两条读法都生效」。
4. `_axDiffCache` 重命名 `_treeDiffCache`，登记进 `tab_state`（PER_TAB）。
5. 顺手修 `src/shared/wrapper_hint.js:130`：建议里的 `subset:"all"` 改为
   `subset:"full"`（schema 只有 `interactive|full`），并加测试断言提示值与 enum 一致。

**验收**
- 同一 fixture：`subset:'interactive'` 的节点数 < full 的 40%，且包含所有可点节点。
- `mode:'diff'` 在默认路径返回 `diff.added`；第二次读只含新增/变化。
- 两条读法对同一页面的 interactive 集合一致（允许 AX 多 `url`）。
- 原有 AX diff 测试不修改语义通过。

**测试**
- `tests/test_tree_subset.js`（U）：构造 100 节点树，断言 prune 后祖先保留、
  非交互叶子被剪、根 stats 保留；`liteTree` 字段白名单；`diffTrees` 的 added/removed/changed。
- `tests/test_ws_handlers.js`（U）：fake PM 断言 `ui.get_tree {subset,mode,ax:false}`
  收到这两个参数（防回归）。
- `tests/test_wrapper_hint.js`（U）：提示里的 `subset` 值必须在 `interactive|full` 内。
- `e2e/read_subset.cjs`（E）：真实长页面，比较 full/interactive 节点数与 token 估算；
  同一页连续两次 `mode:diff`，第二次 `added` 为空。

**回滚**：`AI_BROWSER_TREE_SUBSET=0` 关闭剪枝（保参数但仍返回 full）。

---

### API-03 · `focused_only` 真正只返回焦点子树　`P1` `S` `Track B`

**Bug**
MCP 描述「Return only the focused element subtree」（`mcp_tools.js:32`）；
`page_manager.getTree` 把 `focusedOnly` 发给 preload（`:1155`），但 `bridge.cjs:70`
调用 `extractTree()` 无参，`extractor.cjs` 全文没有 `focusedOnly`，主进程也没有过滤。
`browse_get_tree {focused_only:true}` 返回整棵树。

**修复**
1. 在 `tree_subset.js` 增加 `pruneToFocused(tree, focusedId)`：
   - 找到 `id === focusedId` 的节点；
   - 返回「该节点 + 祖先链」的新树（祖先保留 `children` 中只含路径子节点）；
   - 保留根 `stats/context`；
   - 找不到时返回 `{ tree: null, focused_only: { applied:false, reason:'no-focused-element' } }`。
2. 两条读法读出后应用；`getTree` 不再把 `focusedOnly` 发给 preload（或保留但忽略）。
   跨进程帧：若主树找不到焦点 id 且存在可见 OOPIF，回退一次
   `_autoMergeOpaqueFrames`（3s 预算）再剪；仍找不到则 `no-focused-element`，
   并在 `focused_only.reason` 里注明 `frame`，避免“焦点在 iframe 里”被误报成“没有焦点”。
3. 回执增加 `focused_only: { applied, nodes, focused_id }`，让调用方能判断是否真的剪了。
4. 工具描述改为「返回焦点元素及其祖先链；无焦点元素时 `tree:null` 并给 hint」。

**验收**
- 4000 节点 fixture、焦点在输入框：返回 < 50 节点，包含焦点元素与祖先。
- 无焦点元素：`tree:null` + `hint`，不是返回全树。
- `ui.get_focused` 行为不变（仍返回 `focused_element_id`），但成本下降（可选）。

**测试**
- `tests/test_tree_focused.js`（U）：构造 6 层树，断言路径与节点数；无焦点分支。
- `e2e/read_subset.cjs` 增加：点进搜索框后 `focused_only:true` 节点数 < 50。
- `tests/test_mcp_forwarding.js`：断言 `focused_only` 到达 PM（防止再次丢参）。

**回滚**：`AI_BROWSER_FOCUSED_SUBSET=0` 返回全树。

---

### API-04 · 参数契约测试（schema 字段必须被消费）　`P1` `M` `Track B`

**Bug**
同一个参数要经过 `mcp_tools.js`（声明）→ `mcp_args.js`（归一）→ `mcp_server.js`
（转发）→ `ws_server.js`（case）→ `page_manager`（消费）五层手工搬运。
历史上 `frame_ref`、`dx/dy` 都因漏抄而静默失效；现有
`tests/test_mcp_forwarding.js` 是逐个手写断言，新增字段不会自动被覆盖。

**修复**
1. 把 `mcp_server` 的工具分发抽成可测函数：
   `export async function dispatchTool(name, args, wsClient)`（行为不变）。
2. 新增 `tests/helpers/fake_ws_client.js`：记录每次 `{method, params}`。
3. 新增 `tests/test_api_contract.js`（U）：
   - 对每个工具，按 `inputSchema.properties` 生成哨兵值
     （string `'__S__'`、number `123`、boolean `true`、object `{ __sentinel: true }`）；
   - 调 `dispatchTool`，拿到实际转发的 `params`；
   - 断言：每个 schema 字段要么在 `params` 的任意深度出现，要么在
     `ROUTING_ONLY`（如 `operation`、`action`）或 `INTENTIONALLY_DROPPED` 白名单里并注明原因；
   - 反向断言：`params` 里不出现 schema 未声明的字段（`tab` 等基础设施字段除外）。
4. 第二层：`tests/test_ws_param_consumption.js`（U）：
   用 fake PageManager 记录调用参数，断言 `ui.get_tree`/`ui.act` 等把
   `subset/mode/focused_only/frame_ref/dx/dy` 真正传给了 PM（覆盖「MCP 发了、WS 丢了」）。

**验收**
- 故意从 `mcp_args.js` 删除 `frame_ref` → 新测试红。
- 新增一个 schema 字段但忘记转发 → 新测试红。
- 白名单每一条都有注释原因；白名单增长需要代码审查。

**测试**
- 上述两个文件；测试自身不依赖 Electron（纯 Node）。
- CI 中作为必过项。

**回滚**：无行为变更，纯测试。

---

### API-05 · 方法注册表（单一事实源）　`P2` `L` `Track B`

**Bug**
WS 40 个 `case`（`ws_server.js:267-930`）、MCP 17 个 `case`（`mcp_server.js:99-380`）、
`mcp_tools` schema、`mcp_args` 映射、README 工具表五份手写清单；
新增/改动一个方法要同时改 3–5 处。

**修复（渐进，不要求一次到位）**
1. 新增 `src/main/method_specs.js`：
   ```js
   export const SPECS = {
     'ui.get_tree': {
       mcp: 'browse_get_tree',
       params: ['focused_only', 'ax', 'subset', 'mode', 'tab'],
       timeout: 'default',
       readOnly: true,
     },
     ...
   };
   ```
2. 第一版只做**映射与校验**，不改执行体：
   - `ws_server` 入口用 `SPECS[method]` 判断方法是否存在（替换 `VALID_METHODS`）；
   - `mcp_server` 用 `SPECS` 断言工具名与 WS 方法的对应关系；
   - `test_api_contract` 从 `SPECS` 生成「必须被消费」的字段集合。
3. 第二版（可下个版本）再把参数归一/错误映射收敛到 spec。
4. `mcp_tools` 的 JSON schema 仍手写（token 预算敏感），但 `name` 与 `SPECS` 必须一致。

**验收**
- 新增一个方法只改 `SPECS` + 一个 handler 文件 + 一条测试。
- `test_api_budget` 仍通过（工具 schema 体积不增加）。
- 删除 `shared/protocol.js`（见 API-09）。

**测试**
- `tests/test_method_specs.js`（U）：`SPECS` 的每个 `mcp` 名都在 `MCP_TOOLS` 中；
  每个 `MCP_TOOLS` 都有 `SPECS`；`params` 是 schema 属性的子集。
- `test_api_contract` 改为从 `SPECS` 驱动。

**回滚**：保留旧 switch 作为 fallback 一个版本（`AI_BROWSER_LEGACY_DISPATCH=1`）。

---

### API-06 · 统一错误信封 + `id:null` + 非法参数　`P2` `M` `Track B`

**Bug**
- 解析错误响应缺 `id: null`（`ws_server.js:143-146`），不符合 JSON-RPC 2.0。
- 同类失败有时 `{ok:false}`、有时 `-32603`（`browse_diff/browse_canvas` 未知 op 抛错）。
- `ui.wait` 非法 `condition` 静默空转到 120s（`:754-790`）。
- `ui.get_tree` 无 tab 返回 `{tree:null, context:null}`，与其他方法 `no-such-tab` 不一致。

**修复**
1. 新增 `src/shared/tool_error.js`：
   ```js
   export const CODES = {
     NO_SUCH_TAB: 'no-such-tab',
     INVALID_PARAMS: 'invalid-params',
     CDP_UNAVAILABLE: 'cdp-unavailable',
     TIMEOUT: 'timeout',
     BUSY: 'busy',
     CROSS_TAB_DENIED: 'cross-tab-denied',
     ...
   };
   export const fail = (code, message, hint, extra) => ({ ok:false, error:{code,message,hint}, ...extra });
   ```
2. WS 层：
   - 协议错误用 JSON-RPC（`-32700` 带 `id:null`、`-32601`、`-32602`）；
   - 工具失败统一 `result: {ok:false, error:{...}}`（不再抛 `-32603` 给可预期失败）；
   - 未捕获异常仍 `-32603`，但附 `data: {code:'internal'}` 并落盘。
3. `ui.wait` 入口校验 `condition` ∈ 四个值，否则 `-32602`。
4. `ui.get_tree` 无 tab → `fail('no-such-tab', ..., 'tab 可能已被关闭/淘汰')`。
5. 所有工具回执在有 `ok` 时显式 `ok:true`（不再有的返回裸对象、有的返回 `{success}`）。

**验收**
- 10 个典型错误在两套接口（WS/MCP）上返回同一 `error.code`。
- 非法 `condition` 立即返回 `-32602`，不空转。
- `get_tree` 无 tab 与 `act` 无 tab 的错误码一致。
- 原有依赖 `success` 字段的调用仍兼容（保留别名一个版本）。

**测试**
- `tests/test_error_envelope.js`（U）：表驱动 10 个错误；断言 `code/hint`；
  解析错误带 `id:null`。
- `tests/test_ws_handlers.js`：无 tab、非法 condition 两条。
- `e2e/smoke`：正常调用仍返回 `ok:true`。

**回滚**：`AI_BROWSER_LEGACY_ERRORS=1` 保留旧字段（一个版本）。

---

### API-07 · `ui.wait` 按条件选探针　`P1` `S` `Track B`

**Bug**
`ws_server.js:747-748` 每轮无条件 `await pageManager.getTree(false, tabId)`；
`text_contains`（`:770-779`）与 `url_contains`（`:780-790`）只用 `evaluate`。
而 `getTree` 会触发 preload 全量抽取 + OOPIF 合并（`page_manager.js:1166-1180`）
+ editors 探测，单轮可能数百 ms 到数秒；500ms 轮询名存实亡。

**修复**
1. 按条件分派：
   - `url_contains`：`evaluate('location.href')`；
   - `text_contains`：先 `evaluate('document.body.innerText')` 做快速包含；
     若未命中且 `context.cross_process_frames.visible_count > 0`，每第 5 轮退回读树
     （保证 iframe 内容仍能被等到）；
   - `button_enabled` / `modal_appeared`：读树（现状）。
2. 轮询间隔自适应：200ms → 500ms，连续失败指数退避到 1s。
3. 每次回执带 `polls`、`last_probe`（`url|text|tree`）、`last_error`。
4. 未知 `condition` 按 API-06 立即报错。

**验收**
- `url_contains` 单轮 < 50ms（无树抽取）；`text_contains` 命中时 < 50ms。
- 有 iframe 的页面，`text_contains` 仍能等到帧内文字（第 5 轮兜底）。
- `browse_wait {timeout_ms:20000}` 实际轮询次数 > 30（不再被单轮抽树拖慢）。

**测试**
- `tests/test_wait_probe.js`（U）：spy `getTree`：
  - `url_contains` 全程 0 次；
  - `text_contains` 命中时 0 次，未命中且有帧时每 5 轮 1 次；
  - `button_enabled` 每轮 1 次。
- `e2e/wait_probe.cjs`（E）：记录每轮耗时，P95 < 100ms；与旧实现对比。

**回滚**：`AI_BROWSER_WAIT_ALWAYS_TREE=1` 恢复旧行为。

---

### API-08 · `paint_check` 走统一路由　`P3` `XS` `Track B`

**Bug**：`ws_server.js:369` 用 `params.tab ?? pageManager.activeTab`，而其他方法用已解析的
`tabId`；`heal:true` 可能重载人正在看的页面。

**修复**：改用 `tabId`；`heal:true` 时若目标不是本 session 的 tab，要求 `confirm_reload:true`。

**验收**：`paint_check` 不带 tab 时作用在 session 目标；`heal:true` 不会静默重载人类页面。
**测试**：`tests/test_ws_handlers.js` 加一条：session 目标是 tab2，`paint_check` 不带 tab →
作用在 tab2 而不是 activeTab。

---

### API-09 · `protocol.js` 变成真源或删除　`P3` `XS` `Track B`

**Bug**：`src/shared/protocol.js` 只被 `tests/test_protocol.js` 引用；生产代码不用它校验，
`VALID_METHODS` 与 switch 是两份清单，属于「假单一事实源」。

**修复**：随 API-05 删除；`test_protocol` 改为测 `ws_server` 的真实分发（未知方法 → -32601）。
**验收**：`grep -rn "shared/protocol" src` 为空；未知方法仍返回 `-32601`。
**测试**：`tests/test_protocol.js` 改为测 `ws_server` 的真实分发（保留未知方法用例）。

## 4. M2：结构改造（两个上帝文件各拆第一刀）

> **里程碑归属**：`CORE-00` 是 M0 的前置（Day 1 完成），`CORE-01..07` 属于 M2。
> 放在同一章是为了让「核心类改造」的上下文连续；排期以 1.1/1.2 为准。

### CORE-00 · Fake Electron 测试骨架　`P0` `M` `Track C`

**Bug（缺基础设施）**
`page_manager.js` 5857 行，但 `tests/` 里没有任何测试真正 `new PageManager(...)`：
全部是 `makePageManager()` 假对象或读源码文本。原因是构造函数直接依赖
`BrowserView / ipcMain / session / app / nativeImage / dialog`，没有注入点。
后续所有核心改造（CORE-01..07、READ-03、ACT-01）都卡在这里。

**修复**
1. 新增 `tests/helpers/fake_electron.js`：
   ```js
   export class FakeWebContents extends EventEmitter {
     constructor({ url = 'about:blank' } = {}) {
       super();
       this.url = url;
       this.debugger = new FakeDebugger();
       this.executeJavaScript = vi.fn(async () => null);
       this.isDestroyed = () => false;
       this.getURL = () => this.url;
       this.send = vi.fn();
     }
   }
   export class FakeView { constructor(opts) { this.webContents = new FakeWebContents(); this.bounds = null; }
     setBounds = vi.fn((b) => { this.bounds = b; }); }
   export class FakeWindow extends EventEmitter {
     constructor(bounds = { x:0, y:0, width:1200, height:800 }) { ... }
     getContentBounds() { return this.bounds; }
     addBrowserView = vi.fn(); removeBrowserView = vi.fn(); setTopBrowserView = vi.fn();
   }
   ```
2. `tests/helpers/fake_debugger.js`：
   - `attach/isAttached/detach` 状态机；
   - `sendCommand(method, params)` 可编程：`debugger.onCommand((m) => ...)` 返回 Promise；
   - 记录调用序列，供断言。
3. `tests/helpers/page_manager_env.js`：
   - `vi.mock('electron', ...)` 提供 `app.getPath`、`session.fromPartition`（fake session:
     `on/webRequest/cookies`）、`ipcMain`（EventEmitter）、`nativeImage.createFromBuffer`、
     `dialog.showMessageBox`、`shell.openPath`；
   - `makePageManager()` 返回 `{ pm, window, views, debugger }`，并暴露 `pm.close()`。
4. 首个冒烟测试 `tests/test_page_manager_boot.js`：
   - 构造成功；`pm.newTab('about:blank')` 返回 id；
   - `pm.close()` 不抛错、所有定时器清空（`vi.getTimerCount() === 0`）。

**验收**
- `new PageManager(fakeWindow)` 在 vitest 下可用，无需启动 Electron。
- `npm test` 时间增加 < 2s。
- 至少 3 个后续任务（CORE-01/04、READ-03）能直接用它写测试。

**测试**：上述 boot 测试 + fake debugger 单测。
**回滚**：纯新增文件，无风险。

---

### CORE-01 · 抽出 `CdpHub`，修 `enable` 乐观记账　`P1` `M` `Track C`

**Bug**
`page_manager.js:5521-5523`：
```js
if (!entry.domains.has(domain)) {
  wc.debugger.sendCommand(domain + '.enable'); // 未 await / 未 catch
  entry.domains.add(domain);                   // 先记账
}
```
`sendCommand` 返回 Promise；导航中/渲染器忙时可能 reject（被全局 `unhandledRejection`
吞掉，只记日志），但 `domains` 已标记启用 → 后续该域命令可能失败，且不会再 enable。
表现是「这个 tab 的网络记录/对话框监听静默没有」。

**修复**
1. 新增 `src/main/cdp_hub.js`：
   ```js
   export class CdpHub {
     constructor({ getView, onMessage }) { this._tabs = new Map(); }
     async attach(tabId) { /* 只 attach 一次，注册单个 message/debugger 监听 */ }
     async ensure(tabId, domain) {
       const entry = await this.attach(tabId);
       if (entry.domains.has(domain)) return;
       try {
         await entry.wc.debugger.sendCommand(domain + '.enable', entry.enableParams?.[domain]);
         entry.domains.add(domain);
         delete entry.errors[domain];
       } catch (e) {
         entry.errors[domain] = String(e.message || e).slice(0, 200);
         throw e; // 调用方可选择降级，但状态必须诚实
       }
     }
     async send(tabId, method, params) { await this.attach(tabId); return this._tabs.get(tabId).wc.debugger.sendCommand(method, params); }
     detach(tabId) { ... }
     status(tabId) { return { attached, domains:[...], errors:{...} }; }
   }
   ```
2. `PageManager` 构造时 `this.cdp = new CdpHub({ getView: id => this._getView(id), onMessage: ... })`；
   把 `_ensureCdp`、`_cdpTabs`、`_onCdpMessage` 的接线迁过去（保留 `_onCdpMessage` 作为回调）。
3. `ensure` 失败不吞：调用方（网络/canvas/dialog）记录 `capability.error`；
   `ui.capabilities` / `ui.list_tabs` 暴露每 tab `cdp: {attached, domains, errors}`。
   **兼容**：`_ensureCdp(tabId, view, domain)` 保持同步 `void` 语义，内部
   `this.cdp.ensure(...).catch(e => entry.errors[domain] = ...)`；只有需要确认启用的
   路径（截图 / 首次 network_list）才 `await this.cdp.ensure(...)`，避免制造
   unhandled rejection。
4. 并发 `ensure` 同一 domain 去重（`_inflight` Map），避免同时发三次 enable。

**验收**
- mock `sendCommand('Network.enable')` 第一次 reject、第二次 resolve：第二次调用会重试并成功。
- 并发 3 次 `ensure('Network')` 只发 1 次 enable。
- `ui.capabilities` 能看到 `cdp.errors`（失败时非空）。
- 无新增 unhandled rejection。

**测试**
- `tests/test_cdp_hub.js`（U）：上述三条 + detach 幂等 + status。
- `tests/test_page_manager_boot.js` 扩展：构造时 CdpHub 就绪。
- `e2e/network` 套件：`network_list` 回执含 `capture.cdp` 状态（与 OBS-01 联动）。

**回滚**：`AI_BROWSER_LEGACY_CDP=1` 保留旧 `_ensureCdp` 一个版本。
**依赖**：CORE-00。

---

### CORE-02 · 抽出 `ViewShell`，布局公式唯一　`P2` `M` `Track C`

**Bug**
两份布局公式：`_layoutAllViews`（`page_manager.js:708-721`）与 `_layoutView`
（`:5100-5108`），注释自己承认「新建 tab 走的是 `_layoutView`，这 34px 必然会漏掉一处」。
`index.js` 还负责 `_bottomInset` 与横幅布局。

**修复**
1. 新增 `src/shared/layout_bounds.js`（纯函数）：
   ```js
   export function computeViewBounds(content, { tabBarHeight, bottomInset = 0 }) {
     return { x: 0, y: tabBarHeight, width: Math.max(0, content.width),
              height: Math.max(0, content.height - tabBarHeight - bottomInset) };
   }
   ```
2. 新增 `src/main/view_shell.js`：
   - `create(tabId)` / `destroy(tabId)` / `attach` / `detach` / `raise`；
   - `layout(view)` 与 `layoutAll()` 都调用 `computeViewBounds`；
   - `setBottomInset(px)` 后自动 `layoutAll()`；
   - 所有 `setBounds` 只在这里发生。
3. `PageManager` 的 `_layoutView/_layoutAllViews/_raiseView` 改为委托；`index.js` 的横幅
   只调 `viewShell.setBottomInset()`，不再自己算高度。
4. 覆盖测试：3 种 `bottomInset`（0/34/100）× 2 种窗口尺寸；新 tab 的 bounds 与
   `layoutAll` 后的 bounds 完全一致。

**验收**
- `e2e/layout` 的几何三等式仍绿。
- 新增窗口高度 300px（内容区可能为负）时 height 被 clamp 到 0，不抛错。
- 搜索 `setBounds` 只出现在 `view_shell.js`（index 的窗口 setBounds 除外）。

**测试**
- `tests/test_layout_bounds.js`（U）：纯函数表驱动。
- `tests/test_view_shell.js`（U）：新 tab 与全量布局一致；inset 变化触发重排。
- `e2e/layout`：现有套件 + 一条「横幅出现/消失后内容不缩」。

**回滚**：`AI_BROWSER_LEGACY_LAYOUT=1`。
**依赖**：CORE-01。

---

### CORE-03 · 抽出 `TabRegistry`，全局 tab 上限　`P2` `L` `Track C`

**Bug**
`PageManager` 同时持有 `tabs / activeTab / _groups / _sessionTab / _groupSeq` 等；
`ensureGroup` 每个 session 一组（`page_manager.js:557-582`），限额只按组（默认 8），
**没有全局上限**。10 个 agent/脚本可开 80 个 BrowserView（每个独立渲染进程 + CDP + 网络账本）。

**修复**
1. 新增 `src/main/tab_registry.js`：
   ```js
   export class TabRegistry {
     constructor({ maxTabs = 32 }) { this.tabs = new Map(); this.groups = new Map();
       this.activeTab = null; this.sessionTab = new Map(); this.nextId = 1; }
     add(view, { groupId }) { ... }
     remove(tabId) { ... }
     get(tabId) / list() / byGroup(groupId)
     canOpen(groupId, limit) / pickEvictable({ groupId, skipTabId }) // 全局 + 组内
     setActive(tabId) / activeFor(sessionId)
     stats() { return { total, byGroup, atCap } }
   }
   ```
2. `PageManager` 保留 `this.tabs = registry.tabs`（同一个 Map）以兼容现有代码；
   新逻辑（计数、淘汰、组索引）走 registry，逐步替换。
   **迁移期规则**：`registry.tabs` 只允许 registry 写；`PageManager` 内已有的
   `this.tabs.set/delete` 逐处替换为 `registry.add/remove`，不接受新增直接写 Map。
   可在 dev 模式下用 Proxy 对直接写打警告，`test_tab_registry` 断言「直接写 Map 不计入 stats」。
3. 全局上限 `AI_BROWSER_MAX_TABS`（默认 32）；到达上限时淘汰顺序：
   非人类组 → 最久未使用 → 无打开对话框 → 不是任何 session 的当前 tab。
4. `evict` 返回 `{tabId, reason}`，由 CORE-06 广播。
5. `ensureGroup` 对空闲组做 TTL（30 分钟）回收，避免 `_groups` 无限增长。

**验收**
- 脚本连开 100 个 tab：`list_tabs` ≤ 32；进程内存收敛；每次淘汰有记录。
- 人类组的 tab 不会被 agent 的流量挤掉（除非全局无其他可淘汰）。
- 有打开对话框的 tab 不会被淘汰。
- 现有 `e2e/multiagent` 全绿（每个 agent 仍能开自己的页）。

**测试**
- `tests/test_tab_registry.js`（U）：上限、淘汰顺序、组 TTL、tabId 单调、active 选择。
- `tests/test_page_manager_tabs.js`（U）：用 fake view 调 `newTab/closeTab`，断言 registry 计数。
- `e2e/multiagent` 增加：两个 agent 各开 10 页，总数不超上限且互不干扰。

**回滚**：`AI_BROWSER_MAX_TABS=0` 关闭全局上限。
**依赖**：CORE-02。

---

### CORE-04 · `tabsInGroup/listTabs` 存活保护　`P1` `S` `Track C`

**Bug**
`page_manager.js:597-608`（`tabsInGroup`）与 `:648-658`（`listGroups`）直接
`view.webContents.getURL()`，没有 `view_liveness` 判定。渲染进程消失时，
`ui.list_tabs` 会在主进程抛 `Cannot read properties of undefined (reading 'getURL')`。
这正是 2026-10-30 白屏事故的同类缺陷，只是换了入口。

**修复**
1. 新增 `safeViewInfo(view, tabId)`（可放 `shared/view_liveness.cjs`）：
   ```js
   if (!view || !view.webContents || view.webContents.isDestroyed()) {
     return { id: tabId, url: null, title: null, dead: true };
   }
   return { id: tabId, url: safeUrl(view), title: safeTitle(view), dead: false };
   ```
2. `tabsInGroup` / `listTabs` / `listGroups` 全部用它；`dead:true` 的 tab 不参与淘汰选择。
3. `ui.list_tabs` 回执带 `dead` 数量；`tab_dead` 事件可选。

**验收**
- 把某个 view 的 `webContents` 置空，`ui.list_tabs` 不抛错，返回 `dead:true`。
- `closeTab` 对 dead view 仍能完成清理（不二次抛错）。
- `e2e/lifecycle` 的崩溃恢复用例仍绿。

**测试**
- `tests/test_tab_liveness.js`（U）：3 种失效形态（undefined / isDestroyed=true / 抛错）。
- `tests/test_ws_handlers.js`：`ui.list_tabs` 在 fake PM 返回 dead tab 时不崩。

**回滚**：无行为风险。

---

### CORE-05 · `closeTab` 的 debugger detach 单一归属　`P3` `XS` `Track C`

**Bug**
`page_manager.js:4723-4725` 先 `view.webContents.debugger.detach()`；随后
`_cleanupTabResources` 通过 `_cdpTabs` 再 detach。第二次会抛错（被 catch），
说明「谁负责 detach」没有单一归属。

**修复**：detach 只放在 `_cleanupTabResources`（它知道是否 attach）；
`closeTab` 只负责 remove + close + 调 cleanup。`CdpHub.detach` 幂等。

**验收**：`detach` 只调用一次；未 attach 时不调用；重复 detach 不抛错。
**测试**
- `tests/test_page_manager_tabs.js`：`detach` 只被调用一次；未 attach 时不调用。
- `tests/test_cdp_hub.js`：重复 detach 不抛错。

**依赖**：CORE-01。

---

### CORE-06 · 淘汰事件广播 + 回执 `evicted`　`P2` `S` `Track C`

**Bug**
组满淘汰只写 `this.evictions`（最多 20 条，`ui.list_tabs` 回采后清空）；
agent 正在操作 A 页，弹窗把 A 挤掉，下一次 `ui.act {tab:A}` 收到 `no-such-tab`，
但不知道「是被我们自己淘汰的」，容易归因成页面 bug 并重试。

**修复**
1. 淘汰时广播 `{type:'tab_evicted', tab, reason:'group-full'|'global-cap', by:sourceTabId}`。
2. `_recentEvictions: Map<tabId,{reason,at}>` 保留 60s；`no-such-tab` 错误的 `hint`
   自动带「该 tab 于 Ns 前因 group-full 被淘汰」。
3. `ui.list_tabs` 回执保留 `evictions`（向后兼容）。
4. MCP 没有事件流，靠 `hint` 与下一次 `list_tabs` 发现。

**验收**
- 触发淘汰后，订阅 `tab_evicted` 的客户端收到事件（e2e）。
- 对被淘汰 tab 执行 `act`，错误 `hint` 含 `evicted`。
- 事件不重复（同一 tab 只广播一次）。

**测试**
- `tests/test_tab_registry.js`：淘汰返回 reason；registry 不重复事件。
- `e2e/multiagent`：订阅事件 + 断言 hint。

**依赖**：CORE-03。

---

### CORE-07 · `newTab` 初始化管线 + 失败回滚　`P2` `M` `Track C`

**Bug**
`page_manager.js:3780-4010` 单函数约 230 行，创建 view、分组、占位页、限额、CDP、
window.open shim、canvas hook、导航、失败钩子全在一起，顺序敏感，失败可能留下半初始化 tab。

**修复**
1. 抽出 `src/main/tab_pipeline.js`：
   ```js
   const STEPS = [
     { name: 'create-view', run: ..., undo: ... },
     { name: 'resolve-group', run: ..., undo: ... },
     { name: 'attach-hooks', run: ..., undo: ... },
     { name: 'show-placeholder', run: ..., undo: ... },
     { name: 'navigate', run: ..., undo: ... }, // 最后一步，失败保留错误页
   ];
   export async function runTabPipeline(ctx, steps = STEPS) { ... }
   ```
2. 每一步返回 `{ok, value}`；失败时逆序执行已成功步骤的 `undo`，并返回
   `{ok:false, failed_step, error}`；`newTab` 只负责调用并映射错误。
3. 顺序相关注释保留在对应 step 上（它们是最贵的知识）。

**验收**
- 在第 1–4 步分别注入异常：`tabs` 数量回到调用前，无残留 view/debugger/定时器。
- 正常路径的 tabId、分组、占位页、导航行为与现在一致（e2e 全绿）。
- `newTab` 函数 < 60 行。

**测试**
- `tests/test_tab_pipeline.js`（U）：5 种失败注入 + 正常路径；断言 undo 调用顺序。
- `tests/test_page_manager_tabs.js`：`newTab` 失败后 `list_tabs` 为空。
- `e2e/smoke` + `e2e/window_open`：行为不退化。

**回滚**：`AI_BROWSER_LEGACY_NEWTAB=1`。
**依赖**：CORE-02/03。

---

## 5. M2（并行）：读层性能与正确性

### READ-00 · 抽取器 characterization 测试　`P1` `M` `Track D`

**Bug（缺护栏）**
`extractTree()` 是 970 行单函数（`extractor.cjs:72-1048`），内部约 40 个闭包；
没有「输入 HTML → 输出树」的黄金文件测试。任何拆分都可能悄悄改变角色/可见性/文本，
而现有 15 个 extractor 测试只覆盖零散判据。

**修复**
1. 新增 `tests/fixtures/extractor/*.html`（20 个）：
   - 基础表单（input/select/textarea/checkbox/radio）
   - 富文本（contenteditable / ProseMirror 结构 / Draft 结构）
   - 表格 + 分页
   - 嵌套 shadow DOM（2 层）
   - 同源 iframe（jsdom 可访问）
   - 隐藏元素（display:none / visibility:hidden / aria-hidden / 尺寸 0）
   - 登录墙（密码框 + 域名）
   - 长列表（500 项，测性能上限）
   - 装饰性 div 噪声（测 isPureLayout）
   - 链接/按钮/图标按钮（aria-label 缺失）
   - 自定义 role / aria-* 组合
   - 中文/emoji/IME 组合文本
   - 敏感输入（password / 支付字段）
   - 图片 + alt + 背景图
   - canvas 应用外壳
   - 空页面 / 只有脚本
   - 超长文本（截断规则）
   - 重复 id / 非法属性
   - 弹窗/遮罩层
   - 表单校验错误文本
2. 新增 `tests/test_extractor_golden.js`（J）：
   - 用 jsdom 加载 HTML，调 `extractTree()`；
   - **归一化**：把 `id/ref` 按 DOM 顺序重写为 `#0..#n`，去掉时间/随机字段；
   - 与 `tests/fixtures/extractor/golden/<name>.json` 深比较；
   - `UPDATE_GOLDEN=1` 时重写黄金文件（仅限人工确认的变更）。
3. 黄金文件先由**当前实现**生成并提交，作为重构基线。

**验收**
- 20 个 fixture 全绿；单次全量 < 2s。
- 修改任一判据（如 `isHidden`）会导致至少一个 golden 变化，测试能发现。
- 后续 READ-01 拆分后，golden 零变化。

**测试**：上述文件。
**回滚**：纯测试。

---

### READ-01 · `extractTree` 按判据拆文件　`P2` `L` `Track D`

**Bug**
`extractor.cjs:72-1048` 是一个 970 行函数，所有判据共享闭包状态；
无法局部测试、无法按需裁剪，代码审查困难。

**修复**
1. 目标结构（全部 CJS，便于 preload）：
   ```
   src/preload/extract/
     index.cjs        // extractTree(): 遍历 + 组合
     visibility.cjs   // isHidden / isPureLayout / renderedText
     roles.cjs        // role 推断 / actions / states
     text.cjs         // 文本截断 / 敏感值 / 富文本
     bounds.cjs       // 坐标 / 面积 / 视口裁剪
     editors.cjs      // contenteditable / 编辑器类型 / primary
     shadow.cjs       // 穿透 shadow root 的查询
     frames.cjs       // OOPIF 门节点 / 同源 iframe
   ```
2. `extractor.cjs` 变成薄壳：`module.exports = require('./extract/index.cjs')`，
   保持 `extractTree()` / `extractPageContext()` 导出不变。
3. 每个模块暴露纯函数，接收 `(el, ctx)`；`ctx` 只含只读配置与统计累加器。
4. 迁移顺序：先 `visibility` → `text` → `roles` → `bounds` → `editors` → `shadow` → `frames`；
   每步跑 READ-00 golden。

**验收**
- golden 20/20 不变。
- 每个模块 < 300 行；`extractTree` 主体 < 400 行。
- 新增一个判据只改一个文件 + 一个 fixture。
- `npm test` 时间不增加 > 20%。

**测试**
- READ-00 golden 全程；每个新模块加 3–5 条纯函数测试。
- `tests/test_extractor_jsdom.js` 现有用例不改语义通过。

**回滚**：保留 `extractor_legacy.cjs` 一个版本，用 env 切换。
**依赖**：READ-00。

---

### READ-02 · OOPIF 帧树缓存 + 并行 + 每帧超时　`P1` `M` `Track D`

**Bug**
`page_manager.js:1170` 每次 `getTree` 调 `_autoMergeOpaqueFrames`；门槛
`frameProbe.shouldAutoAx` 只要「任意可见跨进程帧」就为真（`src/shared/frame_probe.cjs:39`）。
`_readOopifFrames`（`:1657-1720`）对每个帧**顺序** `await` 两次
`frame.executeJavaScript`（树 + 上下文），总预算 15s。
现代页面常见可见 iframe（广告/视频/嵌入表单），所以这不是罕见分支。

**修复**
1. 新增 `_frameCache: Map<tabId, { seq, at, frames, errors }>`：
   - key 含 `frameSeq`（每次 `did-frame-navigate` / `did-navigate` 递增）；
   - TTL `AI_BROWSER_FRAME_CACHE_MS` 默认 500ms；
   - 命中且未过期 → 直接复用，不再 `executeJavaScript`。
2. 帧读取改为并行：
   ```js
   const results = await Promise.allSettled(frames.map(f =>
     withDeadline(readOneFrame(f), 3000, 'frame:' + f.key)));
   ```
   单帧失败只影响该帧，写进 `frame_hints.frames[].error`；总预算 8s。
3. 失效：`did-frame-navigate`、`did-navigate`、`did-finish-load`、tab 关闭。
4. `_frameCache` 登记进 `shared/tab_state.cjs` 的 PER_TAB 清单（闸门测试会强制）。
5. `get_tree` 回执带 `frame_cache: 'hit'|'miss'` 与 `frames_read`，便于验证。

**验收**
- 带 3 个可见 iframe 的页面：第一次读 N 次 `executeJavaScript`，500ms 内第二次为 0 次。
- 导航后第一次读重新读取（N 次）。
- 单帧挂起 3s 只损失该帧，其余帧正常合并；总耗时 < 8s。
- `ui.wait` 单轮不再被帧读取拖到数秒（与 API-07 联动）。

**测试**
- `tests/test_frame_cache.js`（U）：fake frames 计数；TTL；导航失效；单帧 reject。
- `e2e/frame_cache.cjs`（E）：真实 `iframe srcdoc`/跨进程 fixture，页面内计数器；
  断言第二次 `get_tree` 的 counter 不变，耗时 < 100ms。
- `tests/test_tab_state_reset.js`：`_frameCache` 必须在 PER_TAB。

**回滚**：`AI_BROWSER_FRAME_CACHE_MS=0` 关闭缓存（仍并行）。
**依赖**：READ-00（golden 保护）。

---

### READ-03 · `getTree` in-flight 去重 + 超时冷却　`P1` `S` `Track D`

**Bug**
`getTree` 的 5s 超时只 `reject`（`page_manager.js:1153-1161`），preload 里的同步抽取
无法中断；`ui.wait` 每 500ms 重试时会堆叠多个抽取，页面更卡，形成正反馈。

**修复**
1. `_treeInflight: Map<tabId, Promise>`：同一 tab 的并发 `getTree` 复用同一个 Promise；
   `finally` 删除。登记进 PER_TAB（值不是 tab 状态，可安全 clear）。
   清除 Map **不会取消**底层抽取：回调里先 `if (!this._getView(tid)) return`，
   避免 tab 关闭后仍写 `_noteTreeRefs` / diff 缓存。
2. `_treeCooldownUntil: Map<tabId, ts>`：超时后 500ms 内直接返回
   `{ok:false,error:'busy',hint:'上一次读取超时，稍后重试'}`，不再发 IPC。
3. 超时错误带 `elapsed_ms` 与 `tab`；`getTree` 无 tab 按 API-06 返回 `no-such-tab`。
4. 回执带 `deduped:true`（复用了 in-flight）。

**验收**
- 5 个并发 `getTree` 只产生 1 次 `ai:extract`，5 个结果相同。
- 超时后 500ms 内的调用不再发 IPC，返回 `busy`。
- 不同 tab 互不影响。

**测试**
- `tests/test_tree_inflight.js`（U）：fake `webContents.send` 计数；并发/冷却/跨 tab。
- `tests/test_ws_handlers.js`：`ui.get_tree` 无 tab 的错误码。

**回滚**：`AI_BROWSER_TREE_INFLIGHT=0`。
**依赖**：CORE-00。

---

### READ-04 · 树 diff 缓存上限　`P2` `S` `Track D`

**Bug**
`_axDiffCache`（`page_manager.js:261`）只在导航时清（`:1024`），无容量上限；
缓存值是整棵树的 lite 快照，无限滚动 feed 上可以很大。API-02 后默认路径也会用它，
问题放大。

**修复**
1. 重命名 `_treeDiffCache`；每项 `{ nodes, at, lite }`。
2. 全局上限：`AI_BROWSER_DIFF_CACHE_NODES` 默认 50000 节点；超限按 LRU 淘汰。
3. 单 tab 上限：5000 节点；超过则只存 `Set<ref>`（用于 added/removed，changed 降级为
   `changed:null, changed_reason:'too-large'`）。
4. 回执 `diff_cache: {mode:'lite'|'refs', nodes}`。

**验收**
- 10 个 tab × 6000 节点页面，缓存节点总数 ≤ 50000。
- 超限时 `diff` 仍返回 added/removed，changed 明确降级。
- 关闭 tab / 导航后缓存释放（PER_TAB 闸门）。

**测试**
- `tests/test_tree_diff_cache.js`（U）：容量、LRU、降级字段。
- `e2e/read_subset.cjs`：大页面两次 diff 不爆内存。

**依赖**：API-02。

---

### READ-05 · `TreeContract.normalize()`（两读法同构）　`P2` `M` `Track D`

**Bug**
只有 AX 树带 `_debug.layer/version`（`axExtractor.js:371`）与 `context.stats.layer='ax'`
（`:522`）；`subset/mode` 只对 AX 生效；AX 有 `url`，默认路径没有。
调用方无法用同一套代码消费两条路径（`PLAN_ARCHITECTURE` 曾规划 `tree_contract` 但未落地）。

**修复**
1. 新增 `src/shared/tree_contract.js`：
   ```js
   export const TREE_SCHEMA = { /* 最小字段 + 可选字段 + 缺失语义 */ };
   export function normalizeTree(tree, { source }) {
     return { ...tree, source, capabilities: { urls: source==='ax', diff: true, ... } };
   }
   export function validateTree(tree) { /* 返回 errors[]，测试/调试用 */ }
   ```
2. 两条路径返回前都过 `normalizeTree`；默认路径的链接补 `url`（已有 `href` 解析可复用）。
3. 只做**加法**（不改既有字段名），避免破坏 agent prompt。
4. `tests/test_tree_contract.js`：用同一 fixture 的两份树跑同一 schema。

**验收**
- 两条路径的树都通过 `validateTree`；差异字段有 `source/capabilities` 标注。
- 现有 e2e 读树断言不因新增字段失败（允许额外字段）。
- README 的工具描述只写一套字段说明。

**测试**：`tests/test_tree_contract.js` + `README` 文档一致性测试（DOC-01）。
**回滚**：`AI_BROWSER_TREE_CONTRACT=0` 返回原始树。
**依赖**：API-02/03。

---

## 6. M2（并行）：操作层一致性

### ACT-01 · 每 tab 动作队列 + 取消令牌　`P1` `L` `Track D`

**Bug**
`executeAction` 对同一 tab 没有串行化；`deadline` 到点只是 `Promise.race`
（`shared/deadline.js:16-42`），底层 CDP 命令/键入循环仍在跑。
agent 超时后重试 → 与「僵尸动作」并发，可能重复提交；`page_changed` 指纹互相污染。

**修复**
1. `_actQueues: Map<tabId, Promise>`；`executeAction` 公共入口包一层：
   ```js
   const enqueuedAt = Date.now();
   const prev = this._actQueues.get(tid) || Promise.resolve();
   const run = prev.catch(() => {}).then(() => {
     if (Date.now() - enqueuedAt > 30000) {
       return { ok: false, error: { code: 'busy', message: 'action queue wait exceeded 30s' } };
     }
     return this._executeActionInner(..., token);
   });
   let tracked;
   tracked = run.finally(() => {
     if (this._actQueues.get(tid) === tracked) this._actQueues.delete(tid);
   });
   this._actQueues.set(tid, tracked);
   return tracked;
   ```
   排队上限 30s：轮到时若已等待 >30s，直接返回 `busy`，**不执行**（不承诺提前唤醒，
   因为那需要取消已经排在前面的动作）。
2. 取消令牌 `{ cancelled:false }` 传入 `_executeActionInner`；deadline 触发时置 true：
   - `type` 的逐字循环每步检查；
   - `press` 的按键序列每步检查；
   - `drag` 的 steps 每步检查；
   - 单次 CDP `Input.dispatch*` 无法取消，但不再发后续步骤。
3. 回执增加 `queued_ms`、`cancelled`；`timed_out:true` 时 `cancelled` 明确告诉调用方
   底层是否真的停了。
4. `_actQueues` 登记进 PER_TAB（tab 关闭时清）。

**验收**
- 同一 tab 两个 `act`：第二个在第一个结束后才开始（fake 时钟/延迟断言）。
- 不同 tab 可并行（总耗时接近单个）。
- `type` 5000 字 + 1s deadline：回执后 100ms 内停止键入；`get_value` 不再变化。
- 排队等待 > 30s 的动作在轮到时返回 `busy`，不执行。

**测试**
- `tests/test_action_queue.js`（U）：串行/并行/超时/取消/清理。
- `e2e/act_cancel.cjs`（E）：真实 contenteditable，长文本 + 短 deadline；
  记录 500ms 内 `value.length` 两次采样不变。
- `tests/test_page_manager_boot.js`：close 后 `_actQueues` 为空。

**回滚**：`AI_BROWSER_ACT_QUEUE=0`（回到并发）。
**依赖**：CORE-00。

---

### ACT-02 · 降级原因进回执　`P2` `S` `Track D`

**Bug**
`page_manager.js:2090, 2112, 2121, 1742` 四处 `catch (e) { /* fall through */ }`；
回执只有 `clicked_via:'preload-click'`，没有原因。站点可能不认合成事件
（`isTrusted=false`），agent 无法判断「为什么这次和上次不一样」。

**修复**
1. 每处 catch 记录 `fallback = { from:'cdp', to:'preload', reason: short(e) }`。
2. 回执合并 `fallback`；`clicked_via` 保留（兼容）。
3. `preload` 也失败时，`fallback.reason` 带两段：`cdp:<原因>;preload:<原因>`。
4. 错误 `hint` 示例：「CDP 点击被遮挡，已退化为合成事件；若站点无反应，尝试 press 或先 scroll 到可视区」。

**验收**
- mock CDP 抛 `Element is not clickable` → 回执含 `fallback.reason`。
- 正常 CDP 点击 → 无 `fallback` 字段。
- e2e 中至少一个「合成点击」场景能看到原因。

**测试**
- `tests/test_act_fallback.js`（U）：4 条降级路径 + 正常路径。
- `tests/test_effect_state.js`：`fallback` 不改变 effect 判定。

**回滚**：无行为风险（新增字段）。

---

### ACT-03 · preload `clear` 语义与 CDP 对齐　`P2` `S` `Track D`

**Bug**
主进程 `clear` 走编辑器状态提交与回读；preload `actions.cjs:57-62` 只是
`value=''` / `innerHTML=''` + `change`。CDP 不可用时，`clear` 在 Draft/ProseMirror 上
可能只清空 DOM，内部模型仍有内容；`effect_state` 却可能报 `committed`。

**修复**
1. preload `clear` 后回读：
   - `input/textarea`：`el.value === ''`；
   - `contenteditable`：`el.innerText.trim() === ''` 且 `el.textContent.trim() === ''`；
   - 若仍有内容 → `{success:false, partial:true, hint:'clear 需要 CDP；当前仅清空 DOM'}`。
2. 主进程的 `effect_state` 在 `partial:true` 时强制 `unknown`，不报 `committed`。
3. 不改变「CDP 可用时」的行为。

**验收**
- jsdom 中模拟「清空 DOM 但保留 `_model`」的编辑器：返回 `partial:true`。
- 普通 input：成功。
- 回执 hint 明确下一步（重读树/改用 setContent）。

**测试**：`tests/test_actions_preload.js`（J）：3 种编辑器形态 + 回读。
**回滚**：无（新增 `partial` 字段）。

---

### ACT-04 · 不可逆对话框提示　`P3` `S` `Track D`

**Bug**
`shared/dialog_policy.cjs:30-45` 自动接受 `confirm`；回执只有 `dialogs` 记录，
没有「这是一次不可逆操作」的显式标记。模型可能在没有人类确认的情况下完成删除。

**修复**
1. `dialog_policy` 对 `confirm` 文案匹配 `删除|注销|支付|永久|删除全部|clear all|delete` 时
   返回 `irreversible:true`（纯函数，不改变自动接受）。
2. 回执加 `dialogs[].irreversible`；顶层 `irreversible_action:true` + `hint`。
3. 可选参数 `confirm_policy:'ask'`（未来做人工确认）；本期只记录。

**验收**
- 「确定删除全部？」→ `irreversible:true`；「确定离开页面？」→ false。
- 自动接受行为不变。
- 测试覆盖中英文关键词与大小写。

**测试**：`tests/test_dialog_policy.js` 扩展表驱动。
**回滚**：无。

## 7. M3：生命周期、观测与体验

### LIFE-01 · cookie 固化开关 + 退出预算　`P2` `S` `Track E`

**Bug**
`index.js:1389-1433` 退出时把所有非 durable cookie 的 `expirationDate` 改成 400 天后，
每 10 个 `await 100ms`，最后再固定等 2s。影响：
1. 服务端明确设为 session-only 的 cookie（临时登录态、CSRF nonce）被静默变成长达
   13 个月的磁盘持久 cookie；
2. 1000 个 cookie 的退出延迟约 12s，用户会以为卡死。

**修复**
1. 抽出纯函数 `src/shared/cookie_persist.js`：
   ```js
   export function selectSessionCookies(cookies, { now, persist, maxDays = 400 }) {
     if (!persist) return [];
     return cookies.filter(c => !c.expirationDate)
       .map(c => ({ ...c, expirationDate: now + maxDays * 86400 }));
   }
   ```
2. `AI_BROWSER_PERSIST_SESSION_COOKIES=0` 关闭（默认仍开，保持现有体验）。
3. 退出总预算 3s：`Promise.race([persistAll(), sleep(3000)])`，随后
   `session.cookies.flushStore()` 再 `race(500ms)`；超时写日志 `cookie_flush_timeout`。
4. README 安全/隐私节写明默认行为与关闭方式。

**验收**
- 1000 个 session cookie：退出总耗时 < 3.5s。
- `=0` 时一个 cookie 都不改写，退出 < 500ms。
- 服务器下发的持久 cookie 不受影响（只处理无 `expirationDate` 的）。

**测试**
- `tests/test_cookie_persist.js`（U）：选择逻辑、maxDays、opt-out、fake timers 预算。
- `e2e/lifecycle`：退出后重开，登录态仍在（默认）；关闭开关后 session cookie 丢失（可选）。

**回滚**：环境变量即时生效。

---

### LIFE-02 · watchdog 用系统空闲时间，避免打断人　`P2` `S` `Track E`

**Bug**
`index.js:1142-1150` 连续 5 次探测失败（约 2.5 分钟）直接 `app.relaunch()`。
人在窗口里填表/扫码时，网络抖动累计 5 次 → 窗口重启，输入丢失。
`index.js:931` 的注释还写着「有人用就跳过重启」，但实现没有该逻辑
（`shared/watchdog.js:12-22` 明确拒绝 `isFocused` 启发式）。

**修复**
1. 抽出 `src/shared/watchdog_policy.js`：
   ```js
   export function shouldRelaunch({ failStreak, limit, idleSeconds, deferrals, maxDeferrals = 4 }) {
     if (failStreak < limit) return { relaunch:false };
     if (idleSeconds < 30 && deferrals < maxDeferrals) return { relaunch:false, defer:true };
     return { relaunch:true };
   }
   ```
2. `index.js` 用 `powerMonitor.getSystemIdleTime()` 作为 `idleSeconds`
   （系统级「多久没有键盘/鼠标输入」，不依赖窗口焦点，agent 的 CDP 输入不会误判）。
3. 延后最多 4 轮（约 2 分钟），之后即使有人操作也重启，避免永久不恢复。
4. 日志记录 `deferred:human-active`，`ui.status` 可见。

**验收**
- 空闲 5s + 失败达阈值 → 不重启，记录 defer；下一轮仍失败且空闲 60s → 重启。
- 连续 defer 4 次 → 第 5 次强制重启。
- 修复 `index.js:931` 的过时注释。

**测试**
- `tests/test_watchdog_policy.js`（U）：阈值/空闲/defer 上限表驱动。
- `tests/test_watchdog.js` 现有用例保持。
- 手工：断网 + 持续输入，观察 2 分钟内不重启；停手后重启。

**回滚**：`AI_BROWSER_WATCHDOG_IDLE_GUARD=0`。

---

### LIFE-03 · 有 agent 连接时 `Cmd+W` 隐藏而非退出　`P2` `M` `Track E`

**Bug**
`index.js:900` `mainWindow.on('close', cleanupAndQuit)`；
`index.js:1486` `app.on('window-all-closed', cleanupAndQuit)`（无平台分支）。
macOS 用户习惯 `Cmd+W` 关窗、应用留在 Dock；这里 `Cmd+W` = 杀进程 =
所有标签页、未保存表单、agent 会话全部消失。

**修复**
1. 抽出决策函数 `src/shared/close_policy.js`：
   ```js
   export function shouldHideOnClose({ isQuitting, activeAgents, tabCount }) {
     return !isQuitting && activeAgents > 0 && tabCount > 0;
   }
   ```
2. `mainWindow.on('close', (e) => { if (shouldHide... ) { e.preventDefault(); mainWindow.hide();
   pageManager.broadcast('window_hidden',{reason:'close'}); return; } cleanupAndQuit(); })`。
3. `hasActiveAgents()`：`_wsClients` 中 `isAgentConn && readyState===OPEN` 的数量。
4. `ui.quit` / `Cmd+Q`（before-quit）始终退出；Dock 点击（activate）恢复窗口。
5. 隐藏时在标签栏/错误横幅显示一句「agent 仍在运行，点 Dock 图标恢复」。
6. `AI_BROWSER_CLOSE_BEHAVIOR=quit|hide` 允许用户改回旧行为。

**验收**
- 有 agent 连接时关闭窗口：进程存活、WS 仍响应、标签页还在；Dock 点击恢复。
- 无 agent 连接时关闭：与现在一致（退出）。
- `ui.quit` 任何情况下都退出。
- `Cmd+Q` 退出（before-quit）。

**测试**
- `tests/test_close_policy.js`（U）：4 种组合。
- `tests/test_page_manager_boot.js`：`hasActiveAgents` 计数。
- `e2e/lifecycle_close_hide.cjs`（E，macOS 用 `osascript` 发 `Cmd+W`；
  其他平台标 manual）：断言进程存活 + `ui.list_tabs` 可调用。
- 手工：Linux/Windows 关闭窗口行为。

**回滚**：`AI_BROWSER_CLOSE_BEHAVIOR=quit`。

---

### LIFE-04 · 两个轮询降频/事件化　`P3` `S` `Track E`

**Bug**
`index.js:903` `setInterval(refreshTabBar, 2000)`；
`index.js:924` `setInterval(pushNavState, 1500)`。
注释说地址栏已事件驱动、轮询只是兜底，但兜底仍每 1.5s 跨进程 `executeJavaScript`；
标签栏每 2s 重建 DOM，标签多时可能造成输入抖动。

**修复**
1. 标签栏：订阅主进程事件（`tab_created/closed/updated`、`page-title-updated`、
   `did-navigate`）触发增量刷新；兜底改 10s；`document.hidden` 时暂停。
2. 地址栏：`did-navigate`、`did-navigate-in-page`、`page-title-updated`、
   `did-start-loading`/`did-stop-loading` 触发；兜底 5s。
3. 增量渲染：只更新变化的 tab 节点，不重建整栏。

**验收**
- 空闲 5 分钟：两个轮询合计触发 < 10 次（旧为 350 次）。
- 标签标题/URL 变化在 200ms 内可见。
- 空闲 CPU < 0.5%。

**测试**
- `tests/test_tab_bar_refresh.js`（U）：fake timers + 事件，断言调用次数。
- `e2e/nav`：导航后地址栏更新；`e2e/focus` 回归。
- 手工：Activity Monitor 观察空闲 CPU。

**回滚**：`AI_BROWSER_POLL_MS=1500/2000` 恢复旧频率。

---

### OBS-01 · 网络捕获状态可见　`P2` `S` `Track E`

**Bug**
`_ensureNetworkCapture` 三档 `Network.enable` 都失败后直接返回
（`page_manager.js:5611-5639`），不记录错误、不设置状态；`ui.network_list` 只返回数组。
agent 看到空列表，会得出「这个页面没有接口」的错误结论。

**修复**
1. `NetworkMonitor` 增加 `captureState(tabId)`：
   `{ enabled, attempts, error, buffer_bytes, dropped }`。
   （默认开关已存在：`AI_BROWSER_NETWORK_CAPTURE=0` 与 `ui.network_configure`；
   本卡不新增开关，只把「开/关/失败」说清楚。）
2. `_ensureNetworkCapture` 成功/失败都写入状态；失败 `recordError('network_enable_failed')`。
3. `ui.network_list` 回执改为 `{ ok:true, requests:[...], capture:{...} }`（保留旧字段兼容：
   顶层仍可展开 `requests`，或加 `entries` 别名）。
4. `ui.capabilities` 的 `network` 段带同一状态。

**验收**
- mock 三次 enable 失败：`network_list` 的 `capture.error` 非空，`enabled:false`。
- 正常时 `capture.buffer_bytes` 有值，接近上限时 `dropped>0`。
- 不再出现「空数组 = 没有请求」的歧义。

**测试**
- `tests/test_network_monitor.js`（U）：状态机、失败、dropped。
- `tests/test_ws_handlers.js`：`ui.network_list` 回执含 `capture`。
- `e2e/network`：真实页面断言 `capture.enabled===true`。

**回滚**：新增字段，无破坏。

---

### OBS-02 · canvas hook 默认策略（先测量再决定）　`P2` `M` `Track E`

**Bug**
`canvas_monitor.js:282-286` 默认开；每个新 tab 在 `did-finish-load` 后注入
`canvas_hook_source.js`（788 行，monkey-patch `CanvasRenderingContext2D`）。
对不用 canvas 的页面也有注入与包装开销，并可能干扰已有 canvas 封装。

**修复（决策任务，不先写代码）**
1. 新增 `tools/bench_canvas_hook.cjs`：在 3 类站点（普通 DOM / 图表 / 游戏/canvas 应用）
   分别测：首屏可交互时间、`get_tree` P50/P95、页面 JS 错误数、hook 安装耗时。
2. 决策门槛（写进本计划）：
   - 若普通页 `get_tree` P95 增加 > 5% 或首屏 > 50ms → 改为**懒安装**
     （首次 `browse_canvas` 时安装 + `reload:true` 补齐）；
   - 否则保持默认开，并在 README 性能节写明「每页注入」。
3. 若改懒安装：`canvasConfigure` 增加 `install:'auto'|'now'`；首次调用自动 reload，
   回执 `reloaded:true` 提示调用方状态已重置。

**验收**
- 产出一份 `docs/bench/canvas-hook-2026-11.md`，含 3 站点数字与结论。
- 结论落地为代码或明确的「保持现状 + 文档」。
- 若改懒安装，`e2e/canvas` 全绿且首次调用可用。

**测试**：基准脚本本身 + `e2e/canvas`。
**回滚**：`AI_BROWSER_CANVAS_HOOK=0/1`。

---

### OBS-03 · 下载同名文件唯一化　`P2` `S` `Track E`

**Bug**
`download_monitor.js:44-94` 在 `will-download` 里 `setSavePath(<dir>/<tab>/<name>)`，
`done` 时用 `item.getSavePath()` 回读。同一 tab 连续导出两个 `export.csv`，
若 Electron 不自动加 ` (1)`，第二个会覆盖第一个，而两条记录都显示 `completed`。

**修复**
1. 新增 `allocateSavePath(dir, filename)`：`existsSync` 时依次尝试 `name (1).ext`…
   上限 1000；返回绝对路径。
2. `will-download` 使用它；`done` 仍回读 `getSavePath()` 作为最终事实。
3. 回执 `path` 必须唯一；重复路径触发 `download_path_collision` 日志。

**验收**
- 同名两次下载 → 两个不同路径且都存在。
- 大小写不敏感文件系统（macOS 默认）下也不覆盖。
- 1000 个同名文件时返回明确错误，不无限循环。

**测试**
- `tests/test_download_path.js`（U）：临时目录，1/2/1000 次。
- `e2e/download_unique.cjs`（E）：页面触发两次同文件名下载，断言两个路径。
- `e2e/download` 现有套件回归。

**回滚**：`AI_BROWSER_DOWNLOAD_UNIQUE=0`。

---

### OBS-04 · diff 截断给出丢失范围　`P3` `S` `Track E`

**Bug**
`snapshot_diff.js` 的 `DIFF_MAX_ENTRIES` 截断只报 `{limit, dropped}`；
agent 知道 diff 不全，但不知道该重读哪一段。

**修复**：截断时记录 `first_dropped_path` / `last_dropped_path`；
按路径前缀聚合 `dropped_by_prefix`（最多 10 组）。

**验收**：截断回执含首尾丢失路径与分组；旧字段 `{limit,dropped}` 保留。
**测试**
- `tests/test_snapshot_diff.js`：构造 200 条变更、limit 50，断言首尾路径与分组。
- 回执字段为新增，不破坏现有调用。

---

## 8. M3：质量体系与文档

### QA-01 · CI：Linux + lint + 语法检查　`P1` `M` `Track F`

**Bug**
`.github/workflows/ci.yml` 只有 `npm ci` + `npm test`（macos-14、Node 20）。
没有 Linux、没有 lint、没有 `node --check`；67 个源文件、21.7k 行靠人眼保持风格。

**修复**
1. `unit` job 改矩阵：`os: [macos-14, ubuntu-22.04]`，Node 20。
2. 新增 `lint` job：
   - devDeps：`eslint`、`@eslint/js`、`globals`；
   - `eslint.config.js`（flat）：`js.configs.recommended` + Node/Electron globals；
   - `*.cjs` 用 `sourceType:'commonjs'`；
   - 规则：`no-unused-vars`（warn，`argsIgnorePattern:'^_'`）、`no-undef`（error）、
     `no-empty`（warn）、`no-constant-condition`（error）；
   - 基线错误清零；warning 数量记录在 PR，不强制一次清完。
3. 新增 `syntax` job：`node --check` 遍历 `src/**/*.js`、`src/**/*.cjs`、`scripts/**/*.cjs`、`bin/**/*.cjs`。
4. `npm run lint` / `npm run syntax` 本地可跑。

**验收**
- PR 必须 `unit (macos)`、`unit (ubuntu)`、`lint`、`syntax` 四项全绿。
- CI 总时长 < 12 分钟（缓存 npm）。
- 故意写一个未定义变量 → `lint` 红。

**测试**：CI 本身；本地加 `tests/test_ci_config.js`（U）断言 workflow 含四个 job、
矩阵含两个 OS（防止有人删掉 Linux）。
**回滚**：lint 先 `continue-on-error: true` 一周，再转必过。

---

### QA-02 · CI：e2e 子集（smoke/background/lifecycle）　`P1` `M` `Track F`

**Bug**
e2e 是产品的主要回归网（`e2e:all` 25 套件），但只在作者本机跑；
CI 绿不代表集成没坏。

**修复**
1. 新增 `e2e-smoke` job（macos-14）：
   ```yaml
   - run: npm ci
   - run: SUITES=smoke,background,lifecycle node e2e/run_all.cjs
   ```
   超时 15 分钟；`timeout-minutes: 20`。
2. 若 macOS runner 无法建窗口：优先用 `AI_BROWSER_START_HIDDEN=1`（background 套件已支持）；
   仍失败则改为 self-hosted macOS runner，并把 job 标 `continue-on-error` 一周收集稳定性数据。
3. 失败时上传 `~/.ai-browser/logs` 与 e2e 输出作为 artifact。
4. 新增 `e2e/security_ws.cjs`、`ipc_trust.cjs`、`evaluate_context.cjs` 到 `SUITES`
   （它们不依赖外网，适合 CI）。

**验收**
- 连续 10 次 PR 运行，`e2e-smoke` 全绿且 P95 < 8 分钟。
- 故意破坏 `background` 行为（如隐藏窗口时不响应 RPC）→ job 红。
- 失败 artifact 能定位到具体套件。

**测试**：CI 自身；本地 `SUITES=... node e2e/run_all.cjs`。
**依赖**：SEC-01（token 让 harness 能连）。

---

### QA-03 · 覆盖率度量与阈值　`P2` `S` `Track F`

**Bug**
没有覆盖率工具；「58/61 模块有测试」是按文件引用统计，不是行/分支覆盖。
无法回答「这个 PR 让哪块代码失去了覆盖」。

**修复**
1. devDep `@vitest/coverage-v8`；`vitest.config.js` 加 `coverage.provider='v8'`、
   `reporter:['text','json-summary','html']`、`exclude`（`src/renderer/**`、`scripts/**`、`bin/**`）。
2. `package.json`：`"coverage": "vitest run --coverage"`。
3. 第一周只报告、不阻断；记录基线后设阈值（建议值，可按实测下调，但只许升）：
   - `src/shared/**`：lines 80 / functions 80；
   - `src/preload/**`：lines 55 / functions 55；
   - `src/main/**`：lines 35 / functions 35；
   - 全局：lines 35。
   `page_manager.js` 暂不设单文件阈值，CORE 系列完成后单独加。
4. CI 上传 `coverage/` artifact；`coverage/` 加入 `.gitignore`。

**验收**
- `npm run coverage` 生成报告；第二周起低于阈值退出码非 0。
- 基线记录在 `docs/COVERAGE.md`（含日期与提交）。
- 新增 `src/shared` 模块未测试时，阈值会拦住。

**测试**：CI + 本地。
**回滚**：阈值先只报告不阻断一周。

---

### QA-04 · `test_imports` 覆盖 `.cjs`　`P2` `XS` `Track F`

**Bug**
`tests/test_imports.js:19-27` 的 `walk` 只收 `.js`；preload 是 `.cjs`，
删掉一个 `.cjs` 导出不会被发现，只有启动浏览器才炸。

**修复**
1. walk 同时收 `.js` / `.cjs`；
2. 对 ESM `import` 与 CJS `require('./x.cjs')` 都做「目标文件存在 + 导出名存在」检查；
3. 允许 `require('electron')`、`node:*` 等内置模块跳过。

**验收**
- 故意删除 `extractor.cjs` 的 `extractPageContext` 导出 → 测试红。
- 现有 `test_imports` 全绿。

**测试**
- `tests/test_imports.js` 扩展 walk 断言（含 `.cjs`）。
- 新增一个临时 `.cjs` fixture（测试内创建/删除），断言缺失导出会被抓到。

---

### QA-05 · 源码文本断言逐步行为化　`P3` `M` `Track F`

**Bug**
`test_invariants.js`、`test_bug5_tab_close_cleanup.js`、`test_bug7_nav_state_cleanup.js`、
`test_tab_state_reset.js`、`test_mcp_forwarding.js` 读源码文本。它们能防「删护栏」，
但对逻辑错误无能为力，且改名/搬家就红。

**修复（渐进，不一次性删）**
1. 保留 3 条真正的「不变量」文本断言：
   - 窗口/标签栏/看门狗阈值存在；
   - `tab_state` 的 PER_TAB 清单与闸门；
   - API 预算只许下降。
2. 其余 4 条改为行为断言（依赖 CORE-00）：
   - `tab close cleanup` → fake view 关闭后断言所有 Map/Set 为空；
   - `nav state cleanup` → 导航后断言状态字段重置；
   - `mcp forwarding` → API-04 的契约测试；
   - `bug5` 的源码检查 → 行为测试。
3. 每改一条，在 PR 描述里写「原断言防的是什么，新断言怎么防」。

**验收**
- 文本断言文件从 5 个降到 ≤ 3 个；每个保留项有注释说明「为什么必须读源码」。
- 重构（改名/搬家）不再导致无关测试红。

**测试**
- 每改一条，对应行为测试先在旧实现上失败、在新实现上通过。
- `tests/test_invariants.js` 或独立脚本断言「读源码文本的测试文件 ≤ 3」。

---

### DOC-01 · README/SPEC 与代码一致性 + 测试　`P1` `S` `Track F`

**Bug（可直接证伪）**

| README 声称 | 代码事实 |
|---|---|
| `20 browse_* tools`（`README.md:35`） | 17 个（`mcp_tools.js`）；同文 `:192` 又写 17 |
| `There is no screenshot step ... no capture call at all`（`:37-38`） | `browse_screenshot`（`mcp_tools.js:185`）、`ui.screenshot`（`ws_server.js:705`）、`Page.captureScreenshot`（`page_manager.js:1409`） |
| 工具表 14 行（`README.md:195-210`） | 缺 `browse_screenshot` / `browse_auth_state` / `browse_errors` |
| badge `658 unit + 447 e2e`（`:18`） | 实测 1228 单测；`docs/SPEC.md:769` 写 1228 |
| 「不截图、不做 OCR」（`docs/SPEC.md:13`） | 截图已作为诊断工具；「读页面不依赖截图」仍成立 |

**修复**
1. README：
   - 工具数改 17；工具表补齐 17 行（从 `MCP_TOOLS` 复制名称与一句描述）；
   - 「no screenshot」改为「**读页面的主路径不依赖截图**；`browse_screenshot` 仅用于失败诊断」；
   - 删除 badge 的静态数字，改为 `tests: see CI`（或由 release 脚本更新）；
   - 安全节补充：WS token、upload 边界、`browse_evaluate` 的上下文。
2. `docs/SPEC.md:13` 同一措辞；`:769` 的数字由脚本生成。
3. 新增 `tests/test_docs_consistency.js`（U）：
   ```js
   const names = [...readme.matchAll(/^\| `(browse_[a-z_]+)`/gm)].map(m => m[1]);
   expect(new Set(names)).toEqual(new Set(MCP_TOOLS.map(t => t.name)));
   expect(readme).toMatch(/17 `browse_\*` tools/);
   expect(readme).not.toMatch(/no capture call|contains no capture/i);
   expect(readme).not.toMatch(/658 unit/);
   expect(spec).not.toMatch(/不截图、不做 OCR/);
   ```
4. 若采用生成式工具表：在 README 放 `<!-- TOOLS:START -->` / `<!-- TOOLS:END -->`，
   `scripts/gen_docs.cjs` 从 `MCP_TOOLS` 写入；CI 校验无 diff。

**验收**
- 上面 5 条冲突全部消失。
- `test_docs_consistency` 在 CI 必过。
- 新增/删除工具时，忘记改 README 会红。

**测试**：上述测试 + 手工预览 npm 页面。
**回滚**：纯文档。

---

### DOC-02 · 当前架构文档 + ADR + 历史横幅　`P2` `M` `Track F`

**Bug**
`docs/PLAN_ARCHITECTURE.md` 开头仍写「`src/` 3951 行 / 16 文件；测试 127 例」，
实际 21.7k 行 / 67 文件 / 1228 例；I1（禁止 `show:false`）与 I5（必须关 GPU）
都已被实现反转。新贡献者会按错误文档理解架构。

**修复**
1. 新建 `docs/ARCHITECTURE.md`（当前事实，约 200 行）：
   - 进程模型（main / preload / renderer / chrome views）；
   - 状态归属（PageManager / CdpHub / ViewShell / TabRegistry / shared）；
   - 信任边界（页面 / agent / 宿主，链接 SECURITY.md）；
   - 数据流（读 / 操作 / 观测）；
   - 扩展点（新增工具、新增读判据、新增观测器）；
   - 关键不变量清单（每条链接到测试）。
2. 新建 `docs/adr/` + 模板；先补 5 条已发生的决策：
   - 0001 为什么默认开 GPU；
   - 0002 为什么允许 `show:false` + 延迟显示；
   - 0003 为什么加截图（诊断而非主路径）；
   - 0004 为什么 WS 用 token 而不是 UDS（本期）；
   - 0005 为什么 upload 需要白名单。
3. `docs/PLAN_*.md` 顶部统一加横幅：「历史方案，当前事实见 `docs/ARCHITECTURE.md`」。
4. 新建 `docs/README.md` 索引：Current / History / Marketing 三栏。
5. `test_docs_consistency` 断言 `ARCHITECTURE.md` 存在且链接的测试文件存在。

**验收**
- 新贡献者只看 `docs/README.md` 能在 10 分钟内找到「当前架构 / 如何跑测试 / 安全模型」。
- `PLAN_ARCHITECTURE` 不再被 README 当作当前架构引用。
- ADR 至少 5 条，格式统一。

**测试**
- `tests/test_docs_consistency.js`：`ARCHITECTURE.md` / `docs/README.md` / ADR 文件存在；
  文档里链接的测试文件路径全部存在。
- 手工：按 `docs/README.md` 走一遍 10 分钟路径。

---

### DOC-03 · `docs/SECURITY.md`（信任边界）　`P2` `S` `Track F`

**Bug**
安全模型是隐式的：README 只说「localhost + 无认证，不要暴露」，
没有说明「页面 → 控制面」「agent → 宿主」「人 → agent」三层边界，
也没有列出 upload / evaluate / screenshot 的能力与限制。

**修复**
1. 新建 `docs/SECURITY.md`：
   - **威胁模型**：本机单用户；不可信页面；可能被 prompt injection 的 agent；
     同机其他进程。
   - **边界表**：

     | 边界 | 规则 | 实现 |
     |---|---|---|
     | 页面 → 控制面 | 页面永远不能发起控制调用 | Origin 拒绝 + token |
     | 页面 → 宿主 | 页面没有 Node；preload 不 eval | sandbox + executeJavaScript |
     | agent → 宿主 | 默认只能读页面；本地文件需白名单 | upload guard / screenshot guard |
     | 人 → agent | 人可接管；关窗不误杀任务 | Cmd+W hide + watchdog idle |
   - **能力清单**：`browse_evaluate`（页面上下文）、`upload`（白名单）、`screenshot`（目录）、
     `download`（目录）、`browse_quit`。
   - **已知非目标**：远程访问、多租户、防同机恶意进程（token 文件同用户可读）。
   - **报告方式**：GitHub Security Advisory / 邮件。
2. README 安全节链接到它；`docs/README.md` 索引。
3. `test_docs_consistency` 断言 SECURITY.md 存在且包含四个边界关键词。

**验收**
- 文档中的每条规则都能在代码里找到对应实现（附 `file:line`）。
- 安全研究者能在 5 分钟内判断「哪些是设计、哪些是漏洞」。

**测试**
- `tests/test_docs_consistency.js`：`SECURITY.md` 存在，含四个边界关键词与能力清单。
- 手工：逐条把边界表的「实现」列指到当前 `file:line`，过期即改。

---

### REL-01 · 发布脚本 `--dry-run` / 确认 / 拆分安装　`P2` `S` `Track F`

**Bug**
`scripts/release.cjs` 把 `git push`、`gh release create`、`npm publish`、
MCP registry、安装到 `/Applications` 串成一条命令。有前置检查与幂等判断，
但没有 dry-run 汇总；在错误 commit 上执行一次会产生不可撤回的 npm 版本。

**修复**
1. `--dry-run`：打印 13 步计划、版本 diff、将执行的命令；不产生任何副作用。
2. `--yes`：跳过交互确认；默认在 `npm publish` 前要求输入版本号确认。
3. 拆分 `--install`（只安装到 `/Applications`）与 `--publish`（只发布）。
4. 所有副作用命令经统一 `run(cmd, args)` 包装；`AI_BROWSER_RELEASE_TRACE=<file>` 时
   只记录不执行（用于测试）。

**验收**
- `node scripts/release.cjs --dry-run` 退出 0，输出 13 步，trace 文件为空（无副作用）。
- 不带 `--yes` 时在 publish 前停下等待输入；CI 用 `--yes`。
- `--install` 不触发 publish。

**测试**
- `tests/test_release_plan.js`（U）：`buildPlan({from,to,...})` 纯函数，13 步顺序与命令。
- 手工：在临时分支跑 `--dry-run`，确认 git 状态不变。

---

## 9. 里程碑退出标准（可直接执行）

### M0（Day 3 结束）

```bash
npm test
SUITES=security_ws,ipc_trust,evaluate_context node e2e/run_all.cjs
```

必须满足：

- [ ] 无 token / 带 Origin 的 WS 连接被拒；页面内 WS 攻击失败。
- [ ] `__ai_browser__.sendTree === undefined`；伪造结果不影响读树。
- [ ] CDP 不可用时 `browse_evaluate` 返回 `cdp-unavailable`，页面无 Node。
- [ ] `npm test` 全绿，新增攻击测试全绿。
- [ ] `tests/test_page_manager_boot.js` 绿：`new PageManager(fakeWindow)` 可构造、可关闭。
- [ ] `docs/audit/pm-2026-10-30/02-transport-protocol.md` 的 P0 标记为已修（在 release notes 记录）。

### M1（Week 2 结束）

```bash
npm test
SUITES=wait_long,read_subset,upload_guard node e2e/run_all.cjs
node scripts/check_docs.cjs   # 或 npm test 内的 docs 测试
```

- [ ] `browse_wait {timeout_ms:20000}` 可用；MCP 不再 15s 腰斩。
- [ ] `subset/mode/focused_only` 在默认读法有可观测效果。
- [ ] 参数契约测试能抓住「删掉 frame_ref」这类回归。
- [ ] README/SPEC 与代码一致；文档测试进 CI。
- [ ] CI 有 Linux + lint + syntax。
- [ ] 发布 2.5.0（安全版，含 token 迁移说明）。

### M2（Week 4 结束）

```bash
npm test
node e2e/run_all.cjs          # 全量 25+ 套件
```

- [ ] `PageManager` 可被 fake 构造；新增 ≥ 20 条行为单测。
- [ ] 带 3 个 iframe 的页面第二次 `get_tree` < 100ms（缓存命中）。
- [ ] 同一 tab 的动作串行；超时后停止键入。
- [ ] 100 tab 脚本不超上限；淘汰有事件与 hint。
- [ ] `extractTree` 已拆（或至少完成 visibility/text/roles 三块），golden 不变。
- [ ] 发布 2.6.0（结构版，无对外 API 破坏）。

### M3（Week 6 结束）

```bash
npm run lint && npm run syntax && npm run coverage
node e2e/run_all.cjs
```

- [ ] CI 四 job + e2e 子集稳定 10 次。
- [ ] 覆盖率报告与阈值生效。
- [ ] `docs/ARCHITECTURE.md` / `SECURITY.md` / ADR 落地。
- [ ] `release --dry-run` 可用。
- [ ] 发布 2.7.0。

---

## 10. 风险、回滚与迁移

### 10.1 风险表

| 风险 | 概率 | 影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| WS token 破坏现有脚本/示例 | 高 | 中 | `ai-browser call`/MCP/e2e 自动读 token；README 迁移节；一个版本的匿名开关 | `AI_BROWSER_WS_ALLOW_ANONYMOUS=1` |
| preload 打包导致启动失败 | 中 | 高 | 三处接入构建（start/e2e/release）；打包前后 smoke；源码回退开关 | `AI_BROWSER_PRELOAD_SOURCE=1` |
| `PageManager` 拆分引入回归 | 中 | 高 | CORE-00 fake 测试 + 全量 e2e + 小步合并 | 保留旧方法一个版本 |
| 帧缓存读到旧内容 | 中 | 中 | 500ms TTL + 导航失效 + `frame_cache` 回执 | `AI_BROWSER_FRAME_CACHE_MS=0` |
| 动作队列死锁/卡住 | 低 | 高 | 30s 等待上限；tab 关闭清队列；`busy` 错误 | `AI_BROWSER_ACT_QUEUE=0` |
| `Cmd+W` 行为变化让用户困惑 | 中 | 低 | 仅 agent 连接时隐藏；横幅提示；文档 | `AI_BROWSER_CLOSE_BEHAVIOR=quit` |
| e2e 进 CI 不稳定 | 高 | 中 | 先 3 个无外网套件；artifact；必要时 self-hosted | 暂时 `continue-on-error` |
| 文档测试过于脆弱 | 中 | 低 | 用标记区间生成；只断言关键事实 | 手动更新 |
| upload 白名单挡住合法流程 | 中 | 中 | `AI_BROWSER_UPLOAD_ROOTS` 可加目录；错误给明确 roots | 环境变量放宽 |
| diff 语义变化影响 agent | 中 | 中 | `diff.first` 标记；保留旧字段；README 示例 | `AI_BROWSER_TREE_SUBSET=0` |

### 10.2 版本与迁移

| 版本 | 内容 | 破坏性 | 迁移 |
|---|---|---|---|
| **2.5.0** | SEC-01..05/07、API-01/02/03/07、API-04、DOC-01、QA-01/02 | **WS 需要 token**；`get_tree` 无 tab 改为错误；`ignored_params` 修正 | README「Raw WebSocket」：从 `~/.ai-browser/ws-token` 读取，`?token=`；CLI/MCP 自动 |
| **2.6.0** | SEC-06、CORE-01..07、READ-00/01/02/03、ACT-01/02/03 | 无对外 API 破坏；内部结构变化 | 无需迁移；性能与稳定性提升 |
| **2.7.0** | LIFE-01..04、OBS-01..04、QA-03/04/05、DOC-02/03、REL-01 | `Cmd+W` 行为在 agent 连接时变化 | 环境变量可改回；release notes 说明 |

**2.5.0 发布说明必须包含**：

1. 为什么需要 token（页面可驱动浏览器的 P0）。
2. 如何拿到 token（文件路径、权限、`ai-browser call` 自动读取）。
3. 如何临时恢复旧行为（不推荐）。
4. 截图/上传的新边界。

---

## 11. 待决策项（需要产品/维护者拍板）

| # | 问题 | 选项 | 建议 | 截止 |
|---|---|---|---|---|
| D1 | canvas hook 默认开还是懒安装 | 保持 / 懒安装 | **先测量**（OBS-02），按门槛决定 | W3 |
| D2 | `Cmd+W` 隐藏还是退出 | 总是退出 / 有 agent 时隐藏 | 有 agent 时隐藏，其他退出 | W3 |
| D3 | agent 访问人类组标签 | 允许 / 禁止 / 需确认 | **允许**（human takeover 是核心流程），回执加 `cross_group:true` | W4 |
| D4 | token 轮换策略 | 每次启动轮换 / 持久 | 每次启动轮换；客户端每次连接重读 | W1 |
| D5 | 是否上 UDS | 仅 token / token+UDS | 2.5 token；3.0 再评估 UDS（Linux/macOS） | 3.0 |
| D6 | `browse_evaluate` 是否保留 | 保留 / 移除 | 保留，但只允许页面上下文；文档明确「不是沙箱」 | W1 |
| D7 | 截图是否进 MCP 主工具表 | 隐藏 / 展示 | 展示，但描述为「诊断」；不改变「读页面不截图」 | W2 |
| D8 | upload 默认允许目录 | 仅 Downloads+uploads / 加 Desktop+Documents | **先严后松**：默认仅 Downloads+uploads，错误提示教用户用 `AI_BROWSER_UPLOAD_ROOTS` 追加 | W1 |

---

## 附录 A：新增/修改测试文件清单

| 文件 | 层 | 覆盖任务 | 关键断言 |
|---|---|---|---|
| `tests/helpers/fake_electron.js` | U | CORE-00 | `new PageManager(fakeWindow)` 可构造 |
| `tests/helpers/fake_debugger.js` | U | CORE-00/01 | `sendCommand` 可编程、记录调用 |
| `tests/helpers/page_manager_env.js` | U | CORE-00 | Electron mock + 清理 |
| `tests/test_page_manager_boot.js` | U | CORE-00 | 构造/关闭/定时器清零 |
| `tests/test_ws_auth.js` | U | SEC-01 | token/Origin/close code |
| `tests/test_cli_token.js` | U | SEC-01 | 缺 token 的可执行提示 |
| `tests/test_e2e_ws_usage.js` | U | SEC-01 | e2e 不得绕过 harness |
| `tests/test_ipc_sender.js` | U | SEC-02 | 跨 tab 结果被忽略 |
| `tests/test_bridge_surface.js` | U | SEC-02 | 暴露面白名单 |
| `tests/test_evaluate_context.js` | U | SEC-03 | 无 CDP → `cdp-unavailable` |
| `tests/test_upload_guard.js` | U | SEC-04 | 路径/大小/symlink |
| `tests/test_screenshot_path.js` | U | SEC-05 | 根目录/相对路径/ignored_params |
| `tests/test_preload_bundle.js` | U | SEC-06 | 产物存在/可解析/大小 |
| `tests/test_view_options.js` | U | SEC-06 | `sandbox:true` |
| `tests/test_window_open_token.js` | U | SEC-07 | 伪造 token 不建 tab |
| `tests/test_tool_timeout.js` | U | API-01 | 5 个工具超时计算 |
| `tests/test_mcp_ws_timeout.js` | U | API-01 | per-call deadline |
| `tests/test_tree_subset.js` | U | API-02 | prune/lite/diff |
| `tests/test_wrapper_hint.js` | U | API-02 | 提示值符合 schema enum |
| `tests/test_tree_focused.js` | U | API-03 | 焦点子树/无焦点 |
| `tests/test_api_contract.js` | U | API-04 | schema 字段全被消费 |
| `tests/test_ws_param_consumption.js` | U | API-04 | WS 层不丢参 |
| `tests/test_method_specs.js` | U | API-05 | SPECS ↔ MCP_TOOLS |
| `tests/test_error_envelope.js` | U | API-06 | 10 个错误码一致 |
| `tests/test_wait_probe.js` | U | API-07 | url/text 不抽树 |
| `tests/test_cdp_hub.js` | U | CORE-01 | enable 重试/并发去重/status |
| `tests/test_layout_bounds.js` | U | CORE-02 | 3×2 组合 |
| `tests/test_view_shell.js` | U | CORE-02 | 新 tab 与全量一致 |
| `tests/test_tab_registry.js` | U | CORE-03/06 | 上限/淘汰/事件 |
| `tests/test_page_manager_tabs.js` | U | CORE-03/04/05 | newTab/closeTab/dead view |
| `tests/test_tab_liveness.js` | U | CORE-04 | 3 种失效 |
| `tests/test_tab_pipeline.js` | U | CORE-07 | 5 种失败回滚 |
| `tests/test_extractor_golden.js` | J | READ-00/01 | 20 fixture 深比较 |
| `tests/test_frame_cache.js` | U | READ-02 | 命中/TTL/失效/单帧失败 |
| `tests/test_tree_inflight.js` | U | READ-03 | 5 并发 1 次 IPC/冷却 |
| `tests/test_tree_diff_cache.js` | U | READ-04 | 上限/LRU/降级 |
| `tests/test_tree_contract.js` | U | READ-05 | 两树同 schema |
| `tests/test_action_queue.js` | U | ACT-01 | 串行/并行/超时/取消 |
| `tests/test_act_fallback.js` | U | ACT-02 | 4 条降级原因 |
| `tests/test_actions_preload.js` | J | ACT-03 | clear 回读 |
| `tests/test_dialog_policy.js` | U | ACT-04 | 不可逆关键词 |
| `tests/test_cookie_persist.js` | U | LIFE-01 | 选择/预算/opt-out |
| `tests/test_watchdog_policy.js` | U | LIFE-02 | 阈值/空闲/defer |
| `tests/test_close_policy.js` | U | LIFE-03 | 4 种组合 |
| `tests/test_tab_bar_refresh.js` | U | LIFE-04 | 事件驱动次数 |
| `tests/test_network_monitor.js` | U | OBS-01 | capture 状态 |
| `tests/test_download_path.js` | U | OBS-03 | 唯一化/1000 次 |
| `tests/test_snapshot_diff.js` | U | OBS-04 | 截断首尾/分组 |
| `tests/test_ci_config.js` | U | QA-01 | 4 job/2 OS |
| `tests/test_docs_consistency.js` | U | DOC-01/02/03 | 工具表/数量/禁用措辞 |
| `tests/test_release_plan.js` | U | REL-01 | 13 步/无副作用 |
| `e2e/security_ws.cjs` | A | SEC-01 | 页面内 WS 被拒 |
| `e2e/ipc_trust.cjs` | A | SEC-02/07 | 无 sendTree/伪造 token 无效 |
| `e2e/evaluate_context.cjs` | A | SEC-03 | 页面无 Node |
| `e2e/security_sandbox.cjs` | A | SEC-06 | preload sandbox |
| `e2e/upload_guard.cjs` | A | SEC-04 | 允许/拒绝上传 |
| `e2e/wait_long.cjs` | E | API-01/07 | 17s 等待成功 |
| `e2e/read_subset.cjs` | E | API-02/03 | 节点数/焦点子树 |
| `e2e/frame_cache.cjs` | E | READ-02 | 第二次读 0 次帧执行 |
| `e2e/act_cancel.cjs` | E | ACT-01 | 超时后停止键入 |
| `e2e/lifecycle_close_hide.cjs` | E | LIFE-03 | 关窗不退出 |
| `e2e/download_unique.cjs` | E | OBS-03 | 两个不同路径 |

> 新增 e2e 必须登记到 `e2e/run_all.cjs` 的 `SUITES`（除非在文件头标注 `MANUAL_ONLY`）。

## 附录 B：新增环境变量

| 变量 | 默认 | 作用 | 引入任务 |
|---|---|---|---|
| `AI_BROWSER_WS_TOKEN` | 自动生成 | 覆盖 token（CI/调试） | SEC-01 |
| `AI_BROWSER_WS_ALLOW_ANONYMOUS` | `0` | 临时允许无 token（仅本地） | SEC-01 |
| `AI_BROWSER_UPLOAD_ROOTS` | `~/Downloads:<userData>/uploads` | upload 白名单（Desktop/Documents 需显式加） | SEC-04 |
| `AI_BROWSER_UPLOAD_MAX_MB` | `25` | 单文件上限 | SEC-04 |
| `AI_BROWSER_SCREENSHOT_DIR` | `<userData>/screenshots` | 截图根目录 | SEC-05 |
| `AI_BROWSER_SCREENSHOT_ANY` | `0` | 允许任意截图路径（仅本地） | SEC-05 |
| `AI_BROWSER_NO_SANDBOX` | `0` | 显式关闭 Chromium sandbox | SEC-06 |
| `AI_BROWSER_PRELOAD_SOURCE` | `0` | 用未打包 preload | SEC-06 |
| `AI_BROWSER_WINDOW_OPEN_LEGACY` | `0` | 跳过 window.open secret 校验（一个版本） | SEC-07 |
| `AI_BROWSER_MAX_TABS` | `32` | 全局标签上限（0=不限） | CORE-03 |
| `AI_BROWSER_FRAME_CACHE_MS` | `500` | 帧树缓存 TTL（0=关） | READ-02 |
| `AI_BROWSER_TREE_INFLIGHT` | `1` | 并发读去重 | READ-03 |
| `AI_BROWSER_DIFF_CACHE_NODES` | `50000` | diff 缓存节点上限 | READ-04 |
| `AI_BROWSER_ACT_QUEUE` | `1` | 每 tab 动作队列 | ACT-01 |
| `AI_BROWSER_PERSIST_SESSION_COOKIES` | `1` | 退出时固化 session cookie | LIFE-01 |
| `AI_BROWSER_WATCHDOG_IDLE_GUARD` | `1` | 有人操作时延后重启 | LIFE-02 |
| `AI_BROWSER_CLOSE_BEHAVIOR` | `hide-with-agent` | `quit` 可改回旧行为 | LIFE-03 |
| `AI_BROWSER_POLL_MS` | `5000/10000` | 兜底轮询频率 | LIFE-04 |
| `AI_BROWSER_DOWNLOAD_UNIQUE` | `1` | 同名下载唯一化 | OBS-03 |
| `AI_BROWSER_RELEASE_TRACE` | 空 | 发布脚本只记录不执行（测试） | REL-01 |

## 附录 C：对外可见变化（2.5.0 重点）

1. **WS 连接**：`ws://127.0.0.1:9223/?token=<hex>`；带 `Origin` 的连接被拒。
   `ai-browser call` / MCP / e2e harness 自动读取 `~/.ai-browser/ws-token`。
2. **`ui.get_tree` 无 tab**：从 `{tree:null,context:null}` 改为
   `{ok:false,error:{code:'no-such-tab'},hint}`。
3. **`ui.screenshot`**：`path` 默认限制在 `~/.ai-browser/screenshots`；
   `ignored_params` 不再包含 `tab`。
4. **新增回执字段**（只增不减）：
   `focused_only:{applied,nodes,focused_id}`、`diff_cache`、`frame_cache`、
   `queued_ms`、`cancelled`、`fallback:{from,to,reason}`、
   `uploaded_path`、`capture:{enabled,error,...}`。
5. **`browse_wait` 长超时可用**：不再被 MCP 15s 腰斩。
6. **`browse_get_tree` 的 `subset/mode`**：两条读法都生效。

## 附录 D：前 3 天执行清单（M0）

| 时间 | 任务 | 产出 |
|---|---|---|
| D1 AM | CORE-00 骨架（fake electron + boot 测试） | `tests/helpers/*`、`test_page_manager_boot.js` |
| D1 AM | SEC-01 token 模块 + 单测 | `src/shared/ws_auth.cjs`、`test_ws_auth.js` |
| D1 PM | SEC-01 接入 ws/mcp/cli/e2e | 无 token 连接被拒 |
| D1 PM | SEC-02 删除暴露 + sender 校验 | `test_ipc_sender.js` 绿 |
| D2 AM | SEC-03 改用 `executeJavaScript` | `test_evaluate_context.js` 绿 |
| D2 PM | SEC-05 截图路径 + ignored_params | `test_screenshot_path.js` 绿 |
| D2 PM | API-01 超时 | `test_tool_timeout.js` 绿 |
| D3 AM | 攻击 e2e（security_ws/ipc_trust/evaluate_context） | 三个套件绿 |
| D3 PM | 回归 + 发布 2.5.0-alpha（内部） | release notes 草稿 |

> 单人执行时，D3 下午留作缓冲；不要为了赶进度跳过攻击用例。

## 附录 E：估时与人力

| 阶段 | 任务数 | 估时（人日） | 说明 |
|---|---|---|---|
| M0 安全止血 | 4（SEC-01..03 + CORE-00） | ~5 | 第一天并行启动 |
| M1 安全+契约 | 16 | ~20 | SEC-04..07、API-01..09、DOC-01、QA-01/02 |
| M2 结构 | 17 | ~25 | CORE-01..07、READ-00..05、ACT-01..04 |
| M3 收尾 | 14 | ~11 | LIFE、OBS、QA-03/04/05、DOC-02/03、REL-01 |
| **合计** | **51** | **~61 人日** | 含测试与文档，不含发布后观察 |

- 1 人全职：约 12–14 周（含缓冲）。
- 2 人（A/B + C/D）：约 6–7 周。
- 4 人（按轨道）：约 5–6 周（含 1–2 周回归/发布缓冲），但需要 1.6 的合并纪律。

## 附录 F：PR 模板

```markdown
## 任务
SEC-01（或链接到本计划对应小节）

## 根因
（一句话 + file:line）

## 改了什么
- ...

## 怎么证明
- [ ] 新增失败测试：`tests/test_ws_auth.js`（先红后绿）
- [ ] `npm test`：1228 + N 全绿
- [ ] e2e：`SUITES=security_ws node e2e/run_all.cjs`
- [ ] 手工：...

## 对外变化 / 迁移
- 无 / 见 README「Raw WebSocket」

## 回滚
- 环境变量：`AI_BROWSER_...=...`

## 风险
- ...
```

**提交信息约定**：`fix(SEC-01): require ws token and reject browser origins`。
一个 PR 只做一张卡；跨卡重构在标题里列出主卡与依赖卡。

---

## 12. 一页纸总结

- **先做**：SEC-01/02/03 + CORE-00。这四件事决定「页面能不能控制浏览器 / 能不能读宿主」，
  以及「后续改动有没有测试可依」。
- **再做**：API-01/02/03/07 + DOC-01。让「工具声明」重新可信。
- **然后**：CORE-01/02/03 + READ-02/03 + ACT-01。让核心类可演进、读层不卡、动作不打架。
- **最后**：LIFE/OBS/QA-03/04/05/DOC-02/03。把体验与质量体系补齐。
- **验收原则**：每个 bug 先有一条会失败的测试；每个「修好了」都有可执行命令；
  每个破坏性变更都有回滚开关与迁移说明。

> 本计划与 `docs/audit/pm-2026-10-30/` 配套使用：审计回答「哪里有问题」，
> 本计划回答「按什么顺序、改成什么样、怎么证明」。



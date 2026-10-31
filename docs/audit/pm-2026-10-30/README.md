# AI Browser 全模块审计（PM / 架构视角）· 2026-10-30

> 基线：v2.4.5 · `src/` 67 个文件 / 约 21.7k 行 · 单测 91 文件 / 1228 条（实测全绿，23s）
> 方法：文档声称 → 代码核对 → 失败路径推演 → 与既有 `docs/AUDIT-2026-10-30.md` 交叉验证。
> **本轮只读，不改任何源码。** 所有结论带 `file:line`；无法证实的标「待确认」。

## 为什么还要再做一次审计

仓库已有一份很扎实的缺陷清单（`docs/AUDIT-2026-10-30.md`），但它回答的是
「哪里写错了」。本次回答的是另外四个问题：

1. **产品承诺与代码现状是否仍然一致**（文档漂移本身就是 bug）；
2. **架构的信任边界是否成立**（谁能驱动浏览器、谁能读登录态）；
3. **哪些问题会随功能增长无限复发**（机制问题，而不是个案）；
4. **如果要继续做大，先还哪三笔债**。

## 严重度定义

| 级别 | 定义 | 处理建议 |
|---|---|---|
| **P0** | 可导致登录态/隐私泄露、任意代码执行、数据丢失，且路径可被外部触发 | 立刻修，修完再做功能 |
| **P1** | 能力静默失效、架构性风险、核心路径无回归保护 | 本迭代内修 |
| **P2** | 效率、一致性、可维护性、体验问题 | 排期修 |
| **P3** | 文案/注释/命名/小优化 | 顺手修 |

## 模块地图与报告

| # | 模块 | 主要文件 | 报告 |
|---|---|---|---|
| M0 | 总览与路线图 | — | [`00-overview.md`](00-overview.md) |
| M1 | 入口 / 进程 / 窗口 / 生命周期 | `src/main/index.js` | [`01-entry-lifecycle.md`](01-entry-lifecycle.md) |
| M2 | 传输与协议（WS / JSON-RPC / MCP / CLI） | `ws_server.js` `mcp_*.js` `protocol.js` | [`02-transport-protocol.md`](02-transport-protocol.md) |
| M3 | 标签 / 视图 / 布局 / 恢复 | `page_manager.js`（tab 部分） | [`03-tabs-views.md`](03-tabs-views.md) |
| M4 | 语义树读层 | `extractor.cjs` `axExtractor.js` `page_probe.js` | [`04-read-layer.md`](04-read-layer.md) |
| M5 | 操作层 | `actions.cjs` `deadline.js` `effect_state.js` | [`05-act-layer.md`](05-act-layer.md) |
| M6 | 观测层 | `network_monitor.js` `canvas_monitor.js` `download_monitor.js` `error_log.js` | [`06-observability.md`](06-observability.md) |
| M7 | 横切库与 preload 安全边界 | `src/shared/*` `src/preload/*` | [`07-crosscutting-preload.md`](07-crosscutting-preload.md) |
| M8 | 测试与质量体系 | `tests/` `e2e/` `.github/` | [`08-test-quality.md`](08-test-quality.md) |
| M9 | 构建 / 发布 / 分发 / 文档 | `scripts/` `bin/` `package.json` `docs/` | [`09-build-release-docs.md`](09-build-release-docs.md) |

## 评分口径（每模块 1–5 分）

- **架构**：边界是否清晰、状态是否有唯一归属、扩展是否局部。
- **逻辑**：正常路径与失败路径是否自洽，是否会说谎（success 但没做成）。
- **质量**：可读性、重复、命名、注释与代码是否一致。
- **效率**：每次调用的额外 IO / CPU / 往返；长会话是否收敛。
- **可测**：能否在不启动 Electron 的前提下验证核心判据。
- **风险**：安全、稳定性、数据丢失。分数越高越安全。

> 评分不是考试，是排序工具：用来决定「先修什么」。

## 配套开发计划

本审计回答「哪里有问题」；具体到每一步怎么改、验收标准、测试用例的**可执行整改计划**见：

- [`docs/PLAN_REMEDIATION.md`](../../PLAN_REMEDIATION.md)（51 张任务卡，按 M0–M3 里程碑与 A–F 轨道编排）

计划中的任务 ID（`SEC-*` / `API-*` / `CORE-*` / `READ-*` / `ACT-*` / `LIFE-*` / `OBS-*` / `QA-*` / `DOC-*` / `REL-*`）
与本目录报告中的问题一一对应；每张卡包含 Bug 证据、修复方案、验收标准与测试文件。

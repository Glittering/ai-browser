# 任务计划：AI Browser 全模块代码审计（只读，不改代码）

## 目标
以高级项目经理 / 产品经理视角，从架构、代码逻辑、代码质量、效率、简洁性、缺陷风险、可发展性
七个维度，对当前项目逐个功能模块做只读审计；每完成一个模块产出一份独立报告。
**本轮不修改任何源码**，只产出分析、结论、优先级与后续路线图。

## 约束
- 不改 `src/`、`tests/`、`e2e/`、`scripts/`、`bin/` 任何文件。
- 所有结论必须有代码证据（`file:line`）或可复现命令；无法证实的标「待确认」。
- 报告是对既有 `docs/AUDIT-2026-10-30.md` 的**独立复核 + 增量**，不重复抄写；冲突处明确标注。
- 不把"重构"当结论：每个问题给出「影响 / 最小修复 / 结构性修复 / 验收方式」。

## 报告目录
`docs/audit/pm-2026-10-30/`
- `00-overview.md` 总报告（产品定位、架构全景、模块评分、问题总表、路线图）
- `01-entry-lifecycle.md` 入口 / 进程 / 窗口 / 生命周期
- `02-transport-protocol.md` WS / JSON-RPC / MCP / CLI
- `03-tabs-views.md` 标签、视图、布局、重绘、崩溃恢复
- `04-read-layer.md` 语义树读层（legacy + AX + frame + coverage）
- `05-act-layer.md` 操作层（CDP 输入、兜底、effect_state）
- `06-observability.md` 网络 / canvas / 下载 / 错误日志 / 能力探针 / diff
- `07-crosscutting-preload.md` shared 工具库 + preload 桥 + 安全边界
- `08-test-quality.md` 测试体系 / e2e / CI / 不变量
- `09-build-release-docs.md` 构建、发布、分发、文档与产品一致性

## 阶段
| # | 模块 | 状态 |
|---|---|---|
| P0 | 盘点与计划（本文件） | complete |
| P1 | M1 入口/进程/窗口/生命周期 | complete |
| P2 | M2 传输与协议 | complete |
| P3 | M3 标签/视图/布局 | complete |
| P4 | M4 读层 | complete |
| P5 | M5 操作层 | complete |
| P6 | M6 观测层 | complete |
| P7 | M7 shared + preload | complete |
| P8 | M8 测试与质量 | complete |
| P9 | M9 构建发布与文档 | complete |
| P10 | M0 总报告与路线图 | complete |
| P11 | 整改计划（每步 bug / 修复 / 验收 / 测试） | complete |

## 后续交付物
`docs/PLAN_REMEDIATION.md`
- 51 张任务卡，覆盖审计中全部 P0–P3 问题；
- 按 M0（止血）/ M1（契约）/ M2（结构）/ M3（收尾）分阶段；
- 每卡含：`file:line` 证据、修复步骤、可执行验收标准、单测/e2e 文件与关键断言、回滚开关；
- 含并行编排、文件所有权、合并顺序、风险表、版本迁移与 PR 模板。

## 方法
1. 先读文档（README/SPEC/PLAN_ARCHITECTURE/AUDIT）建立"声称的行为"。
2. 再读代码验证"实际的行为"，重点看状态所有权、错误路径、清理路径、并发/时序。
3. 每模块：画调用链 → 列状态容器 → 查失败路径 → 查重复实现 → 查可测性 → 打分 → 出报告。
4. 每模块报告完成后更新 `progress.md` 与 `findings.md`（不把外部内容写入 task_plan）。

## 错误记录
| 错误 | 尝试 | 处理 |
|---|---|---|
| - | - | - |

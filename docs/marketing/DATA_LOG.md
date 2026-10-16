# DATA_LOG — ai-browser 推广数据日志

> 每日由 `scripts/marketing/data_snapshot.sh` 追加（或自动化任务触发）。
> 表头说明：stars/forks/issues 为 GitHub 实时值；views14/clones14 为 GitHub Traffic API 的近 14 天累计；
> npm_dl 为 npm 下载量接口的近 7 天下载数（接口对新 scope 包可能返回 N/A）；
> mcp 列为官方 MCP Registry 的 latest 版本与状态。
>
> 关键事件（发布/收录/事故）记在「事件」列，保持单行可 grep。

## 基线事实（2026-10-16 建日志时）

- 仓库创建 2026-07-15；npm 最新 1.2.2（版本线：0.0.0-stage → 1.1.10 → 1.2.0 → 1.2.1 → 1.2.2）
- MCP Registry：`io.github.Glittering/ai-browser` 1.2.2 active（isLatest）
- 已发布文章：掘金 https://juejin.cn/post/7697024318929633320 （2026-10-16 21:00，分类"人工智能"）
- 已发布文章：知乎 https://zhuanlan.zhihu.com/p/2094594014632793355 （2026-10-17 00:20）
- 已发 GitHub issue 评论 4 条（stagehand #2148/#1250、chrome-devtools-mcp #2856/#3020）
- 网络限制：本机 HN/Reddit 不通（SNI/DNS 阻断、无代理）；linux.do/NodeSeek 需推荐码已放弃
- **流量异常观察（2026-10-17）**：GitHub Traffic 14 天 clones 454/130 uniques，而 views 仅 18/12——克隆量是浏览量的 25 倍，
  符合镜像/依赖扫描器特征而非人类访客。判断真实关注度以 views/stars 为准，clones 单独记录备查。

## 每日快照

| 日期时间 | stars | forks | issues | views14 | uniq14 | clones14 | npm_ver | npm_dl周 | mcp_ver | mcp状态 | 事件 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-17 01:07 | 4 | 0 | 0 | 18 | 12 | 454/130 | 1.2.2 | N/A | 1.2.2 | active | 建日志基线；掘金+知乎长文已发布；npm下载接口返回 not found（索引滞后或零下载）；clones 远超 views 疑非人类流量 |
| 2026-10-17 02:05 | 4 | 0 | 0 | 18 | 12 | 454/130 | 1.2.2 | N/A | ? | ? |  |
| 2026-10-17 02:07 | 4 | 0 | 0 | 18 | 12 | 454/130 | 1.2.2 | N/A | 1.2.2 | active | 掘金/知乎/头条已发布；CSDN 草稿待手动发布 |

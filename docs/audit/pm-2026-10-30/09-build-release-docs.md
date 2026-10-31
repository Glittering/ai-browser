# M9 · 构建 / 发布 / 分发 / 文档与产品一致性

> 范围：`scripts/`（build_dmg 18.7k、release 21.7k、build_win、install_app、verify_build…）、
> `bin/ai-browser.cjs`、`package.json`、`server.json`、`.github/workflows/`、
> `README.md`（63KB）、`README-CN.md`、`docs/`（90 个文件）、`skills/`、`llms-install.md`。

## 1. 发布链路

```
scripts/release.cjs（13 步）
  前置检查 → 写 5 处版本号 → 发版闸门测试 → commit + tag → push main/dev/tag
  → GitHub Release → build_dmg（asar + 校验）→ 上传 dmg → npm publish
  → MCP registry（mcp-publisher）→ 安装到 /Applications → 在打包产物上跑验收
```

这是**少见的完整闭环**：版本号自动同步、产物与源码一致性校验（`verify_build.cjs`）、
发布后对「已安装的 App」再跑一遍 e2e（`release.cjs:400`）。
对一个个人维护的 OSS 项目，这条链路的质量高于大多数商业项目。

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| 版本号 5 处自动同步 | `release.cjs:82-120` | 不会再出现「npm 2.4.4 / app 2.4.5」 |
| 发版前跑闸门测试 | `release.cjs:124-136` | 防止「带病发布」 |
| 产物与源码一致性校验 | `release.cjs:255`、`scripts/verify_build.cjs` | asar 里是不是这份代码，可证 |
| 安装后再验收 | `release.cjs:400-413` | 验证「用户实际拿到的东西」，不是 dev 树 |
| fs 代理 / asar 写入的踩坑注释 | `build_dmg.cjs:14-60, 90-113` | 把环境坑变成可复现的知识 |
| 未签名/未公证如实写进 README | `README.md:65` | 不隐瞒 Gatekeeper 摩擦 |
| npm + MCP registry + dmg + 源码四渠道 | `package.json` `files`、`server.json` | 覆盖「agent 接入」与「人安装」两种用户 |

## 3. 问题清单

### P1-1 README 与实现存在**可直接证伪**的冲突（screenshot / 工具数 / 测试数）

**证据**：

| README 声称 | 代码事实 |
|---|---|
| `20 browse_* tools`（`README.md:36`） | 17 个（`mcp_tools.js`，`grep -c "name: 'browse"` = 17）；同文 `README.md:192` 又写 17 |
| `There is no screenshot step ... src/ contains no capture call at all`（`README.md:37-38`） | `browse_screenshot`（`mcp_tools.js:185`）、`ui.screenshot`（`ws_server.js:705`）、`Page.captureScreenshot`（`page_manager.js:1409`） |
| 工具表只有 14 行（`README.md:193-208`） | 缺 `browse_screenshot` / `browse_auth_state` / `browse_errors` |
| badge `658 unit + 447 e2e`（`README.md:18`） | 实测 **1228** 单测；`docs/SPEC.md:769` 写 1228 |
| 「不截图、不做 OCR」（`docs/SPEC.md:13`） | 已提供截图作为**诊断工具**；不截图作为「读页面的主路径」仍然成立，但表述绝对化 |

**影响**：README 是**产品的第一份 API 文档**，也是 agent 读的 prompt 素材。一个模型读到
「没有截图能力」，就不会在失败时使用 `browse_screenshot`；读到「20 个工具」，会去猜
不存在的工具。这比代码 bug 更直接地降低可用性。

**修复**：
1. 把「不截图」改成「**读页面不依赖截图**；截图仅作为失败诊断的辅助工具」；
2. 工具表由 `MCP_TOOLS` 生成（脚本写入 README 的标记区间），或加测试断言表内名字集合 === 工具名集合；
3. badge 由 CI 更新（shields endpoint 或 release 脚本写入）；
4. 加 `tests/test_docs_consistency.js`：工具数、工具名、版本号、单测数至少四项自动比对。

**验收**：README 与 `mcp_tools.js` 不一致时 `npm test` 红。

---

### P2-1 `docs/PLAN_ARCHITECTURE.md` 已过期，但仍在被当作「当前架构」引用

**证据**：文件开头写「现状基线：`src/` 3951 行 / 16 文件；`npm test` 127 例」，
实际 21.7k 行 / 67 文件 / 1228 例；§1 的 I1（禁止 `show:false`）与 I5（必须关 GPU）
都已被实现反转（见 M1 P3-1）。

**影响**：新贡献者按这份文档理解架构，会得到错误结论；更糟的是，它记录的「约束」
与 `tests/test_invariants.js` 的现行断言不一致，出问题时不知道以谁为准。

**修复**：
1. 顶部加醒目横幅：「本文是 v1.2 时代的历史方案，当前约束见 `docs/ARCHITECTURE.md`」；
2. 新建 `docs/ARCHITECTURE.md`（当前状态：进程模型、状态归属、信任边界、扩展点），
   由代码/测试守护；
3. 用 ADR（`docs/adr/NNN-*.md`）记录「为什么把 GPU 默认打开」「为什么允许截图」这类决策，
   替换「计划文档即事实」的模式。

---

### P2-2 发布脚本把「不可逆动作」串成一条命令，缺少 dry-run 闸门

**证据**：`release.cjs` 依次执行 `git push`（`:164-169`）、`gh release create`（`:183-210`）、
`npm publish`（`:283-286`）、MCP registry（`:311-358`）、安装到 `/Applications`（`:376-387`）。
有前置检查与幂等判断（Release 已存在则跳过），但没有 `--dry-run` 汇总「将要做什么」。

**影响**：在错误的 commit/分支上执行一次，就会产生不可撤回的 npm 版本（npm 不允许覆写已发布版本）。
对个人项目，这是高风险操作。

**建议**：`--dry-run` 打印 13 步的计划与版本 diff；`npm publish` 前要求输入版本号确认
（或 `--yes` 显式跳过）；把「发布」与「本机安装」拆成两个命令。

---

### P2-3 Node 版本声明与 CI/运行时不一致

**证据**：`package.json` `engines.node >=18`；CI 用 Node 20（`.github/workflows/ci.yml`）；
Electron 33 自带 Node 20.x；`docs/SPEC.md` 写「Node.js 22+（Electron 自带）」。

**影响**：三处口径不同。贡献者在 Node 18 上跑测试可能通过，但打包/运行时的 API
（如 `structuredClone`、`fetch` 行为）与 Electron 内不一致。

**建议**：统一为 `>=20`（与 CI 一致），`SPEC` 改为「Electron 33 自带 Node 20」；
加 `.nvmrc`。

---

### P2-4 文档体量大、缺少「当前/历史」分区

**证据**：`git ls-files docs | wc -l` = 90；同时存在 `PLAN_*`（产品/架构/canvas/network/app model）、
`AUDIT-*`、`POSTMORTEM_*`、`DEPENDENCY_AND_DISTRIBUTION_AUDIT`、`marketing/`。
没有 `docs/README.md` 索引。

**影响**：读者无法判断哪份是当前事实、哪份是历史。对开源项目，这会持续制造
「文档说 A、代码是 B」的冲突（P1-1 就是结果）。

**建议**：`docs/README.md` 分三栏：**Current**（SPEC / ARCHITECTURE / AGENT_INSTRUCTIONS）、
**History**（PLAN_* / 旧审计）、**Marketing**；历史文档顶部统一加状态横幅。

---

### P3-1 `package.json files` 不含 `docs/`，npm 页面上的相对链接可能失效

**证据**：`package.json` 的 `files` 包含 `src/scripts/skills/bin/tools/coverage_probe.cjs/
examples/...`，不含 `docs/`；README 大量 `docs/...` 相对链接。

**影响**：**待确认**（npm 通常会把相对链接重写到 repository blob）。若不重写，
npm 用户点「架构说明」会 404。

**建议**：发布后抽查 npm 页面 3 个链接；或把关键文档链接改成绝对 GitHub URL。

---

### P3-2 仓库内含较大演示资产

**证据**：`docs/marketing/demo2.gif` 等演示文件在 git 中（README 顶部直接引用）。

**影响**：clone 体积增大；对「npx 即用」的用户无影响（npm 包不含 docs），
但对贡献者与 CI checkout 有成本。

**建议**：演示资产放 GitHub Release 或 CDN，README 用外链；或 Git LFS。

## 4. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 4.0 | 四渠道分发 + 发布闭环，设计成熟 |
| 逻辑 | 3.5 | 发布步骤可靠；缺 dry-run/确认 |
| 质量 | 3.0 | 文档质量高但漂移严重；README 有硬冲突 |
| 效率 | 4.0 | 自动化程度高，人工步骤少 |
| 可测 | 2.5 | 构建/发布脚本本身几乎没有测试 |
| 风险 | 2.5 | 不可逆发布动作 + 文档误导 |

## 5. 结论

工程交付链路是**加分项**，文档一致性是**减分项**。当前最值得做的一件小事：
把「README 说的工具/能力」变成 CI 断言（成本低、收益立刻可见）。
其次是给 `PLAN_ARCHITECTURE` 加历史横幅，并建立一份「当前架构」单一事实源。

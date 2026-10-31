# M4 · 语义树读层（默认 DOM / AX / 帧 / 覆盖率）

> 范围：`src/preload/extractor.cjs`（1626 行）、`src/main/axExtractor.js`（671）、
> `src/main/page_manager.js` 的 `getTree/getTreeViaAx/_autoMergeOpaqueFrames/_annotateCoverage`
> （1147–1600）、`src/shared/{frame_probe,frame_read_source,doc_coverage,ref_epoch,ref_guard,find_ref,editors_probe,wrapper_hint}.js`。

## 1. 两条读法

```
browse_get_tree(ax:false)                       browse_get_tree(ax:true)
  └─ IPC ai:extract ─► preload extractTree()      └─ CDP Accessibility.getFullAXTree
       DOM 启发式（角色/可见性/可点性/富文本）          └─ normalize → DOM.resolveNode
  └─ getTree 后处理：                                   └─ stamp data-ai-id（幂等）
       ├─ 自动合并 OOPIF 子帧（15s deadline）          └─ 合并 OOPIF（同一套）
       ├─ 覆盖率 page_coverage                        └─ href 装饰 / diff / subset
       └─ editors 索引（额外一次 Runtime.evaluate）
```

设计意图是**默认路径不依赖 CDP**（更稳），AX 路径作为「链接带 url、交互子集更准」的增强。
两条路共用 `data-ai-id` 作为句柄（`axExtractor.js:488-540`），这是让 agent 的
「读 → 操作」不因切换读法而失效的关键设计。

## 2. 做对了什么

| 机制 | 证据 | 价值 |
|---|---|---|
| `data-ai-id` 作为**权威句柄**，已有则沿用，模块级只增序号 | `extractor.cjs:12-18, 786-821` | 插入一个元素后旧 ref 不会整体错位；两条读法不会互相作废 |
| 热读不写 DOM（值相同不 setAttribute） | `extractor.cjs:812-821` | 避免每次读树向站点 observer 灌 4000 条属性变更 |
| 读失败要**声明自己失败**（`read_ok/read_error`） | `bridge.cjs:70-90` | 「页面空」和「没读成」不再长得一样 |
| 覆盖率分子分母同口径 | `extractor.cjs:634-650`、`doc_coverage.js` | 能把「外壳读全、正文 0 字」量化出来 |
| 帧合并有 `nodes_added / text_coverage`，不只说 merged | `shared/frame_probe.cjs:39-90` | 「我试过了」和「成功了」分开 |
| 子树/中断恢复的口径测试 | `tests/test_extractor*`（15 个文件） | jsdom 下可回归纯 DOM 判据 |

## 3. 问题清单

### P1-1 默认读法下 `subset` / `mode` 被静默忽略（与 M2 P1-2 同源）

**证据**：`ws_server.js:270-276` 只在 `ax:true` 时转发；`page_manager.js:1583,1593` 是唯一实现。
MCP schema 未提「需要 ax」（`mcp_tools.js:36-37`）。

**影响**：这是**读层**的契约问题：调用方以为拿到了「交互子集/增量」，实际是全量。
对长页面，token 成本可能差 5–10 倍；对 `mode:'diff'`，调用方会解析不存在的 `diff` 字段。

**修复**：把 `filterInteractive` 提到与读法无关的后处理层（对 DOM 树同样有效）；
`mode:'diff'` 对默认树也做 lite 快照；或者在 `ws_server`/MCP 层显式拒绝并给出可执行提示。

**验收**：两条路径对同一页面返回的 `subset:'interactive'` 节点集合一致（允许 AX 多出链接 url）。

---

### P1-2 `extractTree()` 是 970 行的单函数，读层的演进成本极高

**证据**：`extractor.cjs:72-1048` 一个函数，内部嵌套 `winOf/isHtmlElement/isHidden/renderedText/
extractBounds/detectEditorType/extractEditorBlocks/...` 约 40 个闭包；版本标记 `VERSION_TAG = "v6.9"`（`:75`）。
整个文件 1626 行，只有一个导出函数（另加 `extractPageContext`）。

**影响**：
1. **无法局部替换**：想改「可点性判定」必须改 970 行里的某一段，且所有判据共享闭包状态
   （`seen`、`counter`、`opaqueFrames`），很难单独测试。
2. **无法按需裁剪**：`focused_only` 仍然跑完整遍历再筛，不能只读焦点子树。
3. **代码审查困难**：一个 PR 改 30 行，reviewer 需要在近千行里建立上下文。

**结构性修复**：按判据拆成 `visibility.js` / `roles.js` / `text.js` / `bounds.js` /
`editors.js` / `shadow.js` / `frames.js`，`extractTree` 只做「遍历 + 组合」；
每个判据接收 `(el, ctx)`，用 jsdom fixture 单测。这不是为了漂亮，是为了**能安全地
继续提升覆盖率**（coverage_probe 显示真实站点仍有一半可点元素没进树）。

**验收**：单文件 < 300 行；现有 15 个 extractor 测试不改语义通过；新增判据只改一个文件。

---

### P1-3 自动合并 OOPIF 在**常见页面**上每次读都执行，且无跨读缓存

**证据**：`page_manager.js:1170` 每次 `getTree` 调 `_autoMergeOpaqueFrames`；
门槛是 `frameProbe.shouldAutoAx`：只要有**任意一个可见跨进程帧**就为真
（`frame_probe.cjs:39-41`）。`_readOopifFrames` 对每个帧执行 JS 抽取
（`frame_read_source.js`），上限 15s（`page_manager.js:1244`）。
`res.tree.__oopif_merged` 只作用于**本次响应**，下一次是新树，仍会重读。

**影响**：现代页面很常见可见跨进程 iframe（广告、视频、嵌入表单、第三方登录），
所以「自动合并」不是罕见分支，而是**默认路径上的高频分支**。一次 `get_tree` 的成本 =
主文档抽取 + N 个帧抽取（每帧 2 次 `executeJavaScript`，且顺序 await）+ editors 探测；
`ui.wait` 每 500ms 调一次（M2 P1-4），会把成本放大到每秒数次。
在 B 站编辑器这类正文在 OOPIF 的页面上，这是「能用」与「卡」的分界线。

**修复**：
1. 帧树按 `(frameId, navigationSeq)` 缓存，`frameNavigated` 时失效；
2. `shouldAutoAx` 加条件：主树节点数/文字量低于阈值，或调用方显式 `include_frames:true`；
3. 帧读取并发化（现在 `_readOopifFrames` 内部顺序 `await`，见 `frame_read_source.js`），
   并给每个帧独立短超时（如 3s），不要用一个 15s 总预算拖住主树。

**验收**：带 3 个可见 iframe 的 fixture 上，连续两次 `get_tree` 第二次 < 50ms；
`ui.wait` 单轮 < 100ms。

---

### P1-4 两条读法的「契约」仍不完全一致

**证据**：
- 只有 AX 树带 `_debug.layer/version`（`axExtractor.js:371`）与 `context.stats.layer='ax'`（`:522`）；
  默认树没有对应字段。
- `subset`/`mode` 只对 AX 生效（见 P1-1）。
- AX 路径额外做 href 装饰（`axExtractor.js:565-575`），默认路径没有 `url` 字段。
- 默认路径补 `editors` 索引（`page_manager.js:1182-1185`），AX 路径由树根自带。

**影响**：调用方无法用同一套代码消费两条路径；prompt/工具文档需要写「如果 ax:true 则…」，
这会把复杂度转嫁给模型。`docs/PLAN_ARCHITECTURE.md` 曾规划 `tree_contract.js` 做统一，
目前未落地。

**修复**：定义 `TreeContract`（最小字段集 + 可选字段 + 缺失语义），两条路径都过一个
`normalizeTree()`；对「AX 独有」的字段显式标注 `capabilities`，而不是让调用方猜。

**验收**：同一 fixture 上，两条路径的树通过同一个 schema 校验；差异字段有 `source` 标注。

---

### P2-1 标签不存在时 `getTree` 返回 `{tree:null, context:null}`，不是错误

**证据**：`page_manager.js:1147-1151`。
`ui.get_tree` 直接 `send(result)`，没有 `ok:false`。而 `ui.act` / `ui.scroll` 对同一情形
返回 `no-such-tab`（`page_manager.js:4244` 等）。

**影响**：agent 读到 `tree:null` 可能理解成「页面是空的」，进而得出「页面没加载」的
错误结论；而真正原因是标签页已被关掉/淘汰。

**修复**：返回 `{ok:false, error:'no-such-tab', tab}`，与其它工具一致；
或在 `tree:null` 同时给 `context.read_ok=false, read_error='no-such-tab'`。

---

### P2-2 5s 读超时**不取消**渲染进程里的抽取；重复超时会叠加主线程负载

**证据**：`page_manager.js:1152-1162` 用 `setTimeout(5000)` reject，但 preload 的
`extractTree()`（同步、970 行、遍历整棵 DOM）已经开跑，无法中断；`bridge.cjs:70-90`
仍会在完成后 `send('ai:tree')`，只是主进程已删掉 pending，结果被丢弃。

**影响**：页面很大/很卡时，agent 每秒重试一次 `get_tree` → 渲染进程里堆叠多个
同步抽取，页面更卡，形成正反馈。`ui.wait` 的 500ms 轮询会放大这一点。

**修复**：preload 侧加 `_inflight` 去重（同一 tab 同时只跑一次抽取，后到请求复用结果）；
主进程超时后设置「冷却」到下一次 `did-finish-load` 或 1s，而不是无限重试。

**验收**：在 `while(true)` 阻塞渲染器的 fixture 上，连续 10 次 `get_tree` 不会让
主线程排队超过 1 个抽取。

---

### P2-3 `_axDiffCache` 只有「导航时清」，没有容量上限

**证据**：`page_manager.js:261` 创建，`:1024` 导航时 `delete`，`:1583-1590` 写入。
缓存值是整棵树的 lite 快照（`_liteFromTree`），在无限滚动 feed 上可以很大。

**影响**：长会话 + 多标签 + 大页面时，内存随「每个 tab 一份 lite 树」增长；
没有像 network/canvas 那样的字节上限与 dropped 统计。

**修复**：给缓存加「每 tab 最大节点数 + 全局最大字节」；超限时降级为「只存 ref 集合」
而不是完整 lite 树。

---

### P1-5 `focused_only` 是空转：工具描述说「只返回焦点子树」，实际返回全量树

**证据**：MCP 描述 `focused_only: "Return only the focused element subtree."`
（`mcp_tools.js:32`）；`page_manager.getTree` 把 `focusedOnly` 发给 preload
（`page_manager.js:1155`），但 `extractTree()` **不接收任何参数**（`bridge.cjs:70`
调用 `extractTree()`），`extractor.cjs` 全文没有 `focusedOnly`；主进程侧也没有过滤
（唯一的用途是跳过帧合并/editors 索引：`page_manager.js:1170,1182`）。

**影响**：`browse_get_tree {focused_only:true}` 返回整棵树。调用方以为拿到了
「当前输入框附近」，实际拿到全页；在长页面/大表单上既浪费 token，又可能让模型
误判上下文。`ui.get_focused` 只读 `tree.focused_element_id`（`page_manager.js:2424-2426`），
所以它不受影响，但同样付出了全量抽取的成本。

**修复**：两条路一起修 ——
1. extractor 接收 `focusedOnly`，从 `deepActive()` 起做局部遍历；
2. 或在主进程按 `focused_element_id` 剪枝（子树 + 祖先链）。
**验收**：`focused_only:true` 在 4000 节点 fixture 上返回节点数 < 50，且包含焦点元素。

---

### P3-1 默认树与 AX 树的 `ref` 命名空间混用（已修，但值得留一条不变量）

`extractor.cjs:798-809` 记录了 Figma Mirror 的事故：元素同时有 `id="3:1858"` 与
`data-ai-id="ax-4293"`，两条路径轮流改写，导致 ref 互相作废。现在的优先级正确
（`existingAiId || nativeId || generated`），建议加一条**静态不变量测试**：
任何写入 `data-ai-id` 的代码必须走 `assignAiId()` 单点，禁止别处 `setAttribute('data-ai-id')`。

## 4. 效率与简洁性

| 指标 | 现状 | 评价 |
|---|---|---|
| 单次默认读 | 主文档同步抽取 + N 帧 + editors 探测 + 覆盖率 | 中偏重；常见页面有帧，退化为多次跨进程 |
| 单次 AX 读 | `getFullAXTree` + DOM.resolveNode × N + 帧 | 重；但只应在需要链接/交互子集时用 |
| 增量 | 仅 AX + 仅同标签 | 默认路径没有增量 |
| 缓存 | 仅 AX diff（无上限） | 缺帧缓存、缺大小上限 |

**建议的读层目标**：`get_tree` P50 < 100ms（普通页）、P95 < 400ms（带 3 帧），
并给出 `cost_ms` 与 `frames_read` 让调用方自己决定是否要重读。

## 5. 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构 | 3.0 | 双读法有意为之，但契约未统一 |
| 逻辑 | 3.5 | 失败要说出来、覆盖率同口径、id 稳定，都是硬功夫 |
| 质量 | 2.5 | 970 行单函数是最大的债 |
| 效率 | 2.0 | 每读必合帧 + 无缓存 + focused 全量 |
| 可测 | 3.5 | 纯函数与 jsdom 测试多，但 extractor 本体难拆 |
| 风险 | 3.0 | 读错/读漏有 hint；慢与重复读是主要风险 |

## 6. 结论

读层是产品差异化的核心：**「不截图、不 OCR，用结构化树」**能不能成立，全看这里。
当前判据非常讲究（id 稳定、覆盖率先量再报、失败要声明），但实现形态（970 行单函数 +
每次全量 + 必合帧）决定了它很难继续提升覆盖率。下一步应优先做**拆函数 + 帧缓存 +
subset 统一**，而不是继续加站点特化规则。

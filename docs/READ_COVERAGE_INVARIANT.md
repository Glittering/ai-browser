# 读能力不变量（read coverage invariant）

> 2026-10-19 建立。对应 `e2e/readcov_ws.cjs`，跑法 `npm run readcov`。
> 这份文档回答一个问题：**"agent 到底读到了没有"这件事，凭什么能下结论。**

## 1. 不变量

对任意页面，下面三条必须同时成立：

| # | 不变量 | 判据 |
|---|---|---|
| A | 要么读到 ≥90% 的可见文字，要么回执带一句**照着能做**的话 | `page_coverage.ratio >= 0.9` 或 `hint` 命中 `ax:true`/`frame_ref`/`frame_hints`/`ui.screenshot`/`canvas_read`/`context.route` |
| B | 分子不许大于分母（+2 字容差） | `tree_chars <= page_chars + 2`；超过 1.2 倍另报 `over_measured` |
| C | 读不全时，hint 指的那条路**必须真的走得通** | 逐地形：AX 里必须出现某个具体字符串（`axMustContain`），或 `frame_ref` 真的读回字数（`needFrameReadable`） |

不变量 A 是核心。它把一个没法验证的自我声明（"已经合并了帧 / 已读到"）换成了
一个可执行的二选一：**要么数字够，要么话够**。两者都没有，就是洞。

## 2. 验收表（2026-10-19 20:0x 实跑，PASS=99 FAIL=0）

DOM = 进树的字 / 页面可见字（都是**非空白**字符）。

| fixture | 地形 | DOM | 比例 | hint | AX | 期望区间 |
|---|---|---|---|---|---|---|
| /basic.html | 普通静态页 | 43/43 | 100% | — | — | [0.9, 1] |
| /long.html | 60 段长文 | 3489/4980 | 70% | 有 | 100% | [0.4, 0.95] |
| /same-frame.html | 同源 iframe | 69/229 | 30% | 有 | — | [0.05, 0.45] |
| /xorigin-frame.html | OOPIF | 129/217 | 59% | 有 | — | [0, 0.75] |
| /canvas.html | 纯 canvas | 4/4 | n/a | 有 | — | — |
| /canvas-text.html | canvas + 正文 | 66/566 | 12% | 有 | 100% | [0.05, 0.5] |
| /hidden.html | display:none | 13/13 | 100% | — | — | [0.9, 1] |
| /sr-only.html | 移出视口 | 6/22 | 27% | 有 | 100% | [0.05, 0.6] |
| /shadow.html | open shadow root | 35/35 | 100% | — | — | [0.5, 1] |
| /virtual.html | 虚拟列表 | 47/104 | 45% | 有 | 100% | [0.2, 0.8] |
| /table.html | 8×3 表格 | 54/54 | 100% | — | — | [0.9, 1] |
| /empty.html | 空页 | 0/0 | null | — | — | — |
| /late.html | 3 秒后注入 | 64/136 | 47% | 有 | 100% | [0.4, 0.95] |
| /script-text.html | 容器内有 script | 6/6 | 100% | — | — | [0.5, 1] |

AX 列 `—` = 这条不靠 AX 出路，没读它。帧类页面走 `frame_ref`（见不变量 C），
`/canvas` 走 `ui.screenshot`。

真实站点抽样（同一套口径）：

| 页面 | DOM | hint | AX |
|---|---|---|---|
| https://www.baidu.com/ | 306/338 = 91% | 无 | 100% |
| https://www.zhihu.com/ | 346/443 = 78% | 有（主线正文） | 542/443 → 钳到 100%，`names_exceed_text` |

## 3. 口径（为什么这些数字可以互相比）

**同一把尺子**：分子（树里各节点 label）和分母（innerText + 各帧可见文字）都只数
**非空白字符**。中文页面不太吃这个亏，英文页面按词空格能虚低 15%，表格页能虚低
40%（实测 8×3 表格：68% → 100%，少的是 `\t` 不是字）。

**分母覆盖所有承载文字的表面**：主文档 innerText + 同源子帧 + open shadow root +
跨进程帧（帧那边由 `frame_read_source.stats.text_chars` 提供，不重复付钱）。
少算任何一块，比例就虚高 —— shadow 那一块漏掉时实测 `35/8`，`over_measured`。

**分子只算"渲染出来的字"**：抽取器给 label 标 `label_kind`，
`text` 之外（`aria` / `alt` / `title` / `placeholder` / `value`）都是可访问名，
不在 innerText 里，一律不计入分子。实测 `/basic.html` 曾因
`<input placeholder="随便填">` 报 46/43 —— 页面只有 43 字，却显得"超读"了。

**两种"超读"必须分开**：

| 情形 | 字段 | 含义 |
|---|---|---|
| DOM 树分子 > 分母 | `over_measured: true` | **测量出错了**：分母漏了一个承载文字的表面，或分子在重复计数。不许钳成 100% 装作没事 |
| AX 树分子 > 分母 | `names_exceed_text: true` | **设计使然**：AX 的 label 是可访问名，天生含 aria/alt/title。钳到 100%，不报警 |

## 4. 已知残留（不修，但必须可见）

| # | 残留 | 影响 | 出路 |
|---|---|---|---|
| 1 | 单个 label 裁到 60 字（帧内 120 字），裁断处补 `…` | 长文覆盖率上限约 70%；一段 500 字正文只剩 60 字 | `get_tree {ax:true}`（实测 5 张页面全部 100%） |
| 2 | 纯 `<div>` 的文字不进 DOM 树 | 虚拟列表只剩 hud 一句（45%） | AX |
| 3 | `position:absolute;left:-9999px` 没有独立节点 | `/sr-only` 只读到 6/22；字只在 body blob 里 | AX（AX 里它有名字） |
| 4 | 每帧最多 200 节点 / 1200 候选 | 超长列表被截断 | `frame_ref` 分页读 |
| 5 | 表格的行列结构不保留 | 只能拿到 cell 文字 | AX 有 role 结构 |
| 6 | OOPIF 内 `drag` 不支持 | 拖拽类交互失效 | 帧内 `ui.act`（click/type 有） |
| 7 | AX 与 DOM 的 `context` 字段不完全一致 | 同一页两种读法上下文可比但不相同 | 见 `_finishAxTree` 的字段补齐 |

## 5. 加一条 fixture

```js
// 1) FIXTURES 里加页面
"/mycase.html": `<!doctype html>...`,
// 2) EXPECT 里加预期（band 写"要求"，不是实测值的复制）
{ path: "/mycase.html", band: [0.9, 1], name: "……", mustContain: ["必须出现的字"] },
```

- `band`：DOM ratio 允许区间；`needNull` / `needUnmeasurable` / `needHint` / `needMerged` /
  `needFrameReadable` / `forbid` / `mustContain` / `axBand` / `axMustContain` / `waitMs` / `known`。
- 单跑一张：`ONLY=/mycase.html AI_BROWSER_PORT=9544 node e2e/readcov_ws.cjs`
- **必须另起端口**：套件会先 `waitPortFree`，默认 9223 被用户正在用的实例占着，
  它会直接拒绝，不会去动那个实例。
- 调 `band` 的唯一合法理由是"实测值才是对的，并且说得出为什么"。改断言让它过
  = 把 bug 编码成契约（这个错误在 DC-10 上犯过一次，见 git log）。

## 6. 这套东西凭什么可信

首次跑 **PASS=47 FAIL=14** —— 14 条全是真缺陷，没有一条是断言写错。修完 PASS=99。

变异验证（故意把代码改坏，看套件是否报警，证明它不是在空跑）：

| 变异 | 结果 |
|---|---|
| `LOW_COVERAGE` 改回 0.5 | `/long.html` 3 条红（hint 空、指路空） |
| 分母拿掉 `shadowChars` | `/shadow.html` 红：`tree=35 page=8` over_measured |
| `extractLabel` 不标 `label_kind` | `/basic.html` 红：分子 46 > 分母 43 |

注意第一条：`/sr-only` 对 0.5 闸门**不敏感**（它的静音是 `MIN_MISSING_CHARS` 造成的，
被另一条断言钉住）。每个闸门都要有自己的哨兵页面，这也是地形表的用处。

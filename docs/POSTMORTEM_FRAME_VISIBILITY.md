# 复盘：泛雅 / 超星学习页 —— "内容看不见"的四个 bug，以及为什么这个项目还不够稳

> 时间：2026-10-19
> 触发：`fanya_analysis.md`（外部只看接口、不看代码做的独立分析）
> 提交：`4c109b9`（帧内容读取器）、`b3c717a`（capabilities 归因）、`f7af8b8`（去重 + act 帧内兜底）、
> 以及 `tools/coverage_probe.cjs` 的分母修复
> 全部结论都在**真实页面**上验证过（ai-browser 常年登录着西电专技平台），没有一条只靠单测。

---

## 0. 一句话

四个 bug 表面上是"iframe 读不到"，实质是同一个结构性缺陷的四个投影：
**通路一直在增加，但没有任何一个数字在回答"这条通路读够了吗"。**
于是"我努力了"顺理成章地被写成"我成功了"，而失败对调用方不可见。

---

## 1. 事实：修复前后的测量

| 观测点 | 修复前（实测） | 修复后（实测） |
|---|---|---|
| 默认语义树 | 27 节点，1 个 `axf-` ref，**零个章节标题** | 35 节点，9 个 `axf-` ref，6 个章节条目全在 |
| `context.frame_hints` | `{auto_ax:"merged", frames_read:1}` | `{auto_ax:"merged", frames_read:1, nodes_added:9, text_coverage:0.86, frames:[{ref:"frame-1", src:"https://…/studentcourse?…"}]}` |
| `ui.evaluate {frame_ref:"frame-1"}` | `frame_not_found: no cross-process frame owns frame-1` | 在帧内执行，返回 `/mooc2-ans/mycourse/studentcourse` |
| `ui.act {target:"axf-1-1", action:"focus"}` | `Target not found for ref: axf-1-1`（而 ref 就在树里） | `{success:true, method:"frame-js", focused:true, effect_state:"committed"}` |
| `ui.act {target:"axf-1-4", action:"click"}` | 同上（那时 axf-1-4 是行容器） | `{success:true, clicked_via:"oopif-click", effect_state:"committed"}` |
| `ui.capabilities` 的 L2 结论 | `only 27 elements … the UI is largely canvas-rendered`，且 `canvas_top=0`、跨进程 iframe=1 | `only 35 elements … and 1 cross-process iframe(s) … the content is inside those frames, NOT on a canvas` |
| `capabilities.route.recommended` | `[]`（问"走哪条路"给了一个空答案） | `["L2_semantic_tree"]` |
| `node --tools/coverage_probe` | 可点目标 **4**、可用率 **100%**、真缺口 0 —— 全是外壳，正文不在分母里 | 可点目标 **11**、可用率 **82%**、跨进程帧 1 个已计入分母 |
| 全量测试 | 796 passed | 826 passed |

那行 `100%` 是这次最值得记住的数字：**它在一个"整门课都看不见"的页面上报出了满分。**

---

## 2. 逐个 bug 的根因

### 2.1 capabilities 把"iframe 藏起来"说成"canvas 渲染"

代码在 `src/main/capability_probe.js:369`：

```js
`only ${flat.length} elements (${actionable} actionable)${totalCanvas ? ` and ${totalCanvas} canvas element(s)` : ''} — the UI is largely canvas-rendered, so the tree cannot see the content`
```

"— the UI is largely canvas-rendered" 是**模板串里的无条件字面量**，只有前面那截计数受条件控制。

为什么会写成这样：这个探针最初是为 ComfyUI / rhtv 这类 canvas 应用写的。当时"树薄"**唯一**
已知的成因就是 canvas，于是这个假设被写进了**结论的措辞**，而不是写成**待验证的假说**。
后来跨进程 iframe 成了更常见的成因，文案没跟着改。

判定标准上的错误很具体：
- "只有 27 个元素" 是**观测**；
- "因为 canvas" 是**推断**；
- 推断必须挂在证据上（`canvas_top > 0`），不能挂在"我想不出别的原因"上。

同一份回执里，探针**自己**测到了 `canvas_top = 0` 和 `iframe: 跨进程 1 个`，两行字互相打脸。
比归因错更糟的是它把 agent 推向 L3 指针手势 —— 在一个 DOM 页面上去"点坐标"。

顺带发现第二个问题：`route.recommended` 是**空数组**。因为所有 route 的 `preferred` 都挂在
`rich`（元素数 ≥60 等）这一个判据上。系统被问到"该怎么办"时给了空答案 —— 这比给错答案
更容易让人放弃。

### 2.2 树里有 `frame-1`，用它说"找不到"

`mergeFrameTrees` 会给每个跨进程帧造一个门节点，id 是 `frame-N`。这是**纯 UI 节点**，
页面里没有对应元素。而 `_owningFrame()` 只会"按 `data-ai-id` 在帧里查元素"。

根因不是 iframe，而是**两个子系统各自发明 ref**：采集端造 `axf-N-i`（有元素），合并端造
`frame-N`（无元素），而"树里出现的 ref 必须可解析"这条契约从来没有被写下来。
同类问题在 `opened_tab`、`stale_ref` 那两轮里都出现过。

### 2.3 `merged` 但什么都没读到（真正的根因）

三层叠加，每一层单独看都"没做错"：

1. **采集面**（`_readOopifFrames` 内联的选择器）：
   `[contenteditable],[role=textbox],[role=combobox],textarea,input[type=*],button,[role=button],a[href]`
   —— 这是一份**表单控件读取器**，为"B站图文编辑器住在 OOPIF 里"那一回写的。
   而泛雅的章节条目是 `<a onclick>` 且 `href` 为 null：实测该帧 `a` 有 8 个、`a[href]` 只有 2 个，
   6 个章节一个都匹配不上；正文里也没有别的可点元素，于是整帧只剩一个搜索框。
2. **合并层**（`axExtractor.mergeFrameTrees` 的 `lift()`）：只保留
   `actions.length > 0` 的节点。就算采集端读出了标题/列表/表格单元，也会在这里被丢**第二次**。
3. **回执层**：`describeAutoAx` 的 `merged` 判据是 `frames.length > 0`，也就是
   "我确实拼进去了"（拼进去一个搜索框也算）。`frames_read: 1` 听起来像充足。

三层都是"局部正确"，叠起来的结果是：**内容整体消失 + 回执说成功**。

### 2.4 `frame_ref` 与 `act` 的帧内路由不一致

`click`/`type`/`paste`/`upload` 各自有 OOPIF 分支，`focus` 没有 —— 它落到 preload 的顶层
`querySelector`，于是对一个树里明明白白存在的 ref 报"找不到"。
这不是能力缺失，是**能力表列得不全**：OOPIF 支持被写在每个 action 的分支里，而不是写在
统一的入口上。任何一个新 action 天生就是"不支持 iframe"，除非有人记得加。

---

## 3. 为什么会有这些 bug（结构性原因，按可操作性排序）

### 3.1 能力是按事故追加的，不是按契约设计的

这份代码里能查到清晰的"事故地层"：B站编辑器事故 → 表单控件选择器；canvas 事故 →
canvas 归因文案；`opened_tab` 事故 → `startedAt` 时间戳。每一次修复都只对自己那场事故负责，
**没有人在加 iframe 通路时回头审查"树薄"的所有归因**。于是两条互相矛盾的话可以并排
放在同一份回执里几个月，没有人发现 —— 因为没有任何机制要求它们一致。

### 3.2 "我努力了"被当成"结果对了"

同类证据不是孤例：

| 字段 | 判据 | 真实含义 |
|---|---|---|
| `merged` | `frames.length > 0` | 我拼进去了（可能只有 1 个搜索框） |
| `frames_read` | 读了几个帧 | 读了，但读到了什么不知道 |
| `capabilities.route.preferred` | `rich = 元素≥60 && 角色≥4 && 可操作≥10` | 三个魔数的主观判断，没有单位 |
| `auth_state.verdict` | 曾经用 `csrfToken` 子串命中 `token` | 谎报已登录（已修，但同类写法在这个仓库里出现过多次） |

共同点：**回执里全是形容词，没有一个数字带单位和对照。**
`effect_state`（三态）+ `retry` 那一轮修的正是这个，但没有覆盖到"读"这条通路 ——
只覆盖了"写"。

### 3.3 同一个页面有三种表示，但没有一致性检查

DOM 树 / AX 树 / 帧树各自独立构建，各有各的 id 命名空间和覆盖范围。结果是：
`frame-1` 在一个里有、另一个里没有；`axf-1-0` 只存在于帧树；AX 树根本不认识它们。
**没有任何一处代码同时持有两份表示并比较。** 所以每个表示内部的缺陷都不可见。

### 3.4 测试只验证自己的形状，不验证页面覆盖率

826 条测试全绿，和"正文一个字都读不到"可以同时成立。因为断言是

```js
expect(describeAutoAx({ merged: true, framesRead: 2 })).toEqual({ auto_ax: 'merged', frames_read: 2 });
```

而不是"这一页的 6 个章节标题必须在树里"。合成 fixture 里的 `<a href>` 永远比真实站点里的
`<a onclick>` 乖巧 —— 而这次的 bug 恰好整个藏在后者里。

### 3.5 度量存在，但分母悄悄排除了"要紧的那块"

这是本次最值得反复看的一条。项目**早就有**"数覆盖率"的纪律：`tools/coverage_probe.cjs`
（2026-10-17）用 `cursor:pointer` 数"人看着能点的东西有多少进了树"，把 43%/33%/60% 这种
感觉变成了数字，还挂进了 CI（低于 80% 退出码 1）。

但这个工具只有一份 `document.querySelectorAll('*')` —— **默认文档**。于是：

- 在泛雅上它报 `可点目标 4，可用率 100%，真缺口 0`；
- 同一次会话里，默认语义树里 0 个章节、capabilities 说"canvas 渲染"、agent 什么都做不了。

**满分和完全失效可以同时为真，因为分母里没有"我没测的地方"。**
同一个工具里还有第二处同类问题：`INTER` 写的是 `a[href]`（和帧读取器一模一样的假设），
加上"唯一可交互后代"的判据把隐藏 input 也数进去 —— 于是 6 个章节行被永久误报成"真缺口"。

这不是"不会做"，是**纪律只覆盖了一部分，而没人检查覆盖面本身**。

### 3.6 默认读法对"薄"没有告警

27 节点的树和 200 节点的树被同等对待。如果 `get_tree` 能回答"这页可见文字 420 字、树里只覆盖了 4 字"，
这次事故在**第一次读树**时就暴露了，而不是等一份外部报告。

---

## 4. 统一解释：为什么"不够稳定健壮通用"

> **通用** = 对没见过的站点也成立。而我们对站点的所有知识都以"选择器"和"文案"的形式
> 沉淀在代码里，这两样东西天然是逐站点的。
>
> **健壮** = 出错时能被发现。而我们所有失败都是"静默返回更少的节点"，
> 因为没有任何一层在比较"应该有多少"和"实际有多少"。
>
> **稳定** = 同样的输入给同样的结果。而默认树的内容取决于站点渲染到第几帧、
> iframe 何时挂载、`getBoundingClientRect` 何时非零 —— 没有任何一个环节记录"这次读到的是稳态还是中间态"。

三条都不是"模型不够聪明"或"代码写得糙"，而是**缺少一层可测量的对照**。
这一轮补的就是这一层，而且刻意把它放在**回执**里（`nodes_added` / `text_coverage`），
而不是放在日志里 —— 只有进到 agent 的视野，它才会影响决策。

---

## 5. 这次的改法为什么不是又一贴膏药

| 改法 | 为什么可复用 |
|---|---|
| 采集规则搬进 `src/shared/frame_read_source.js`，单一所有者 | 选择器不再散落在 `page_manager` 的字符串里；用"真实函数 + `toString()`"产出源码，避免拼装层吃掉一层转义（`\s` → `s` 这类错误只有在页面里跑起来才现形） |
| 采集面按**语义类别**定义：可交互（标签/ARIA）+ 内容块（标题/列表/段落/表格） | 不是站点特判。`<a onclick>`、`div[role=link]`、`<li>`、`<td>` 都落在类别里，不需要为每个站点加一条 |
| 支配规则用 DOM 包含关系表达（祖先让位给后代） | 一条规则同时解决 `li>a`、`td>p`、`div[role=link]>a` 三种重复。并且方向是有理由的：点内层会冒泡到外层，反过来不成立 |
| 回执从形容词改成测量值 | `nodes_added` / `text_coverage` 有单位、有对照。0.01 一眼就知道不对，不需要读代码 |
| `gateFrameIndex` / `pickSubframe`：ref 解析器显式化 | "树里的 ref 必须可解析"从口头约定变成可单测的函数，序号口径在两边注释里强制对齐 |
| act 的帧内兜底放在**唯一出口**（顶层 miss → 帧内原生动作） | 把"哪个 action 支持 iframe"从"看代码"变成"默认支持"，新 action 不再天生残缺 |
| coverage_probe 的分母包含帧，并打印"未测量 N 个" | 度量本身开始对自己诚实：**数不到的地方必须出现在报告里** |

---

## 6. 诚实边界（这次没做的）

1. ~~**主文档仍然没有覆盖率告警。**~~ → **已做**（`context.page_coverage`，见 §6.1）。
2. **每帧上限 200 个节点**，长正文会被截断；`text_coverage` 会告诉你低，但没有"分页读正文"的工具。
3. **表格结构不保真**：只保留 cell 文本，没有行/列关系。成绩表能读，不能算。
4. **`drag` 在 OOPIF 里仍不支持**（没有可信的帧内等价物）。
5. **coverage_probe 的残留 2 个缺口**（章级行容器）是模型的表达力问题，不是真缺口 ——
   它现在会把它们**列出来**而不是藏进百分比里，这是可以接受的中间态。
6. **AX 路径与 DOM 路径的 `context` 仍有细微差别**（这次只对齐了 `frame_hints`）。

### 6.1 `page_coverage` 补完之后新暴露的东西

这个数字一加上去，立刻在两处证明了它的价值，也顺手牵出两个**与本轮改动无关**的旧缺陷。

| 页面 | 默认树 | AX 树 | 结论 |
|---|---|---|---|
| 泛雅课程页（修后） | 159/185 = 86% | — | 与 `frame_hints.text_coverage` 0.86 同源，互相印证 |
| 泛雅课程页（把帧内容摘掉，模拟修前） | 25/185 = 14% | — | **报警**，且归因指向跨进程帧 |
| 百度首页 | 348/357 = 97% | — | 无提示 |
| CSDN 长文 | 1450/5270 = **28%** | 5182/5270 = **98%** | 真信号：默认 DOM 树读不全长正文 |
| `about:blank` / 空页 | 0/0 | — | `ratio: null`（"没有可读的文字" ≠ "没读到"） |

**CSDN 那一行是这次最有价值的新发现**：一个 5000 字的技术文章，默认树只覆盖 28%，
而 AX 树覆盖 98%。也就是说过去 agent 在这种页面上"读到了标题和几个链接，
以为自己读完了整篇"。这是第 2 条边界（节点上限）在真实页面上的量化证据，
现在它从"文档里的一句提示"变成了"每次读树都自带的一个数字"。

顺带修掉的两个旧缺陷（都在读路径上，都属于"一个可选字段炸掉整条路"）：

- **`document.cookie` 在 opaque origin 上抛 SecurityError。** `extractPageContext` 里
  裸写 `cookieString: document.cookie`；`about:blank`、sandbox iframe、`data:` 文档
  都会抛，于是**整个抽取器崩掉**。cookie 只喂登录态启发式，是一个可选字段 ——
  可选字段炸掉整条读路径是纯粹的自伤。现在 `readCookieSafely()` 降级为 `""`
  （方向安全：宁可说"要确认登录"，不可谎报已登录）。
- **读失败被伪装成"页面只有一个小节点"。** bridge 的兜底把异常文本塞进一个节点
  当树返回，调用方无从区分"页面本来就空"和"我们没读成"。现在兜底带
  `read_ok: false` + `read_error`，且此时**不产出 `page_coverage`** ——
  拿兜底占位当分子只会得出一个看似正常的小数字，把"没读成"包装成"内容少"。
  失败时多两个字段，成功时零成本（happy path 不写这两个键）。

---

## 7. 下次给 ai-browser 加"读页面"能力的检查清单

1. 采集面是按**语义类别**定义的，还是按某个站点的选择器？
2. 有没有一个数字能回答"页面有多少 / 我读到了多少"？没有就先加数字，再谈能力。
3. 树里出现的每一种 ref，都有解析器吗？序号在产出端和解析端是否同源？
4. 这个能力在"没有任何可点元素"的页面上还工作吗？（正文、表格、纯文本）
5. 失败时是**报错**还是**静默返回空**？"读到空"和"不存在"必须能分开。
6. 有没有一条**真实页面**的回放测试，而不是只有合成 fixture？
7. 有没有一个工具在数"这条通路的覆盖率"？如果它只数了页面的一部分，报告里说清楚了吗？

---

## 附录：复现命令

```bash
# 1. 默认树：修前 27 节点/0 章节；修后 35 节点/6 章节 + 覆盖率
ai-browser call ui.get_tree '{"tab":1}' | jq '.context.frame_hints'

# 2. 门节点 ref 能不能用（修前必报 frame_not_found）
ai-browser call ui.evaluate '{"js":"location.pathname","frame_ref":"frame-1","tab":1}'

# 3. act 能不能进帧（修前 Target not found）
ai-browser call ui.act '{"target":"axf-1-1","action":"focus","tab":1}'

# 4. 归因（修前说 canvas-rendered，recommended 为空）
ai-browser call ui.capabilities '{"tab":1,"include_network":false}' \
  | jq '{recommended: .route.recommended, why: (.route.routes[] | select(.route=="L2_semantic_tree") | .why)}'

# 5. 分母（修前 4 个目标 / 100%；修后 11 个 / 82%，且说明跨进程帧已计入）
node tools/coverage_probe.cjs "<url>" 9000
```

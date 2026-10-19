# 技能与 API 面优化方案（v2）

> 触发问题（项目所有者原话）：
> 「每次打开新的聊天窗口，都要重新学习一遍……正常来说，给 agent 接入一个新能力，它只需要学会了，以后都是直接使用。而不是没次都要明着调用，从是什么、什么原理，到接口都有什么，挨个学习好久。」
> 「咱们 api 是不是非常多？可以参考一下 chrome 的无障碍模式、其它的无头浏览器等。分析有没有不合理的地方。」

本文不含猜测。**第 1 节全部是量出来的数字**，第 6 节每一步都配一个可执行的断言。

---

## 1. 实测基线

| 项目 | 实测 | 说明 |
|---|---|---|
| MCP 工具数 | 20 | `src/main/mcp_tools.js` |
| 工具 schema 序列化 | **17,502 字节 ≈ 4,730 token** | 按 3.7 字节/token 估 |
| **注入频率** | **每一轮** | MCP 客户端每轮都注入完整 tool 列表 |
| 顶层参数总数 | 101 | 平均 5.05 个/工具 |
| 单工具最重 | `browse_act` **4,353 B / 27 参数 / 占 24.9%** | 第二：`browse_network` 2,074 B / 23 参数 |
| `examples/AGENT_INSTRUCTIONS.md` | 12,168 B ≈ 3,290 token | **中英双语，两份内容重复** |
| 3 个技能 SKILL.md | 9,353 B ≈ 2,530 token | content-publish / read-webpage / web-network-monitor |
| `README.md` | 56,052 B ≈ 15,150 token | 如果有人让它读 |
| **npm 包内技能文件数** | **0** | `npm pack` 55 个文件，`skills/` 一个都没进去 |

**冷启动真实成本**：一个全新会话要把"这是什么、什么原理、接口有哪些"读完，光 `AGENT_INSTRUCTIONS.md` 就是 3,290 token，加上三个技能 2,530，加每轮 4,730 —— **还没点第一下，已经花掉 1 万 token 左右**。这就是"挨个学习好久"的来源。

---

## 2. 诊断：两个症状，四个根因

### R1 · 技能根本没随包分发（最硬的一条）

`package.json` 的 `files` 里没有 `skills/`：

```
files: [bin, scripts, src, tools/coverage_probe.cjs,
        examples/AGENT_INSTRUCTIONS.md, examples/mcp-config.json, llms-install.md, LICENSE]
```

`npm pack --dry-run` 实测：55 个文件，**0 个技能**。

所以通过 `npx @glittering0717/ai-browser` 安装的用户**永远拿不到那三个技能**。它们只存在于 git 仓库里，对用户不可见。用户唯一能拿到的是那份 12KB 的双语说明书，还得自己复制粘贴进 `CLAUDE.md`。

> 这一条单独就能解释大部分"每次都要重新学"的抱怨：**没有一个能被客户端自动发现、自动加载的东西。**

### R2 · 说明书是"教程"，不是"运行时表面"

`AGENT_INSTRUCTIONS.md` 的结构是：定位 → 标准循环 → 省 token 技巧 → 排查顺序 → 其它工具 → 人工介入 → 收尾。这是一篇**给人读的教程**，agent 必须从头读到尾才知道怎么开始。

而且它中英双语，agent 只需要一种语言，**另一半是纯浪费**。

正确的位置关系应该是：**工具 schema 在每轮里（免费在场），说明书只在"要做某类任务"时按需加载。** 我们把这两层合并成了一层，于是把最贵的资源（每轮固定注入）用在了最低频的信息上（怎么发布文章到 CSDN）。

### R3 · 工具面是"拍平的动词表"，不是"按动作分组的契约"

这是 API 设计的核心问题，而且**已经产生了真实 bug**。

`browse_act` 的 27 个参数，实际上是 5 组互斥参数集的并集：

| 动作组 | 专属参数 | 数量 |
|---|---|---|
| drag | to_target, dx, dy, to_x, to_y, from_x, from_y, from_anchor, to_anchor, hold, button | 11 |
| press | key, keys | 2 |
| wheel | delta_x, delta_y, hold | 2 |
| get_value | offset, limit | 2 |
| click | url, keep_tab | 2 |

agent 每次要读完 27 个才能找到自己要用的那 3 个。`browse_network` 同理：4 个 operation（list/get/clear/configure）的 22 个参数拍平在同一层。

**这不是"工具多"，是"参数拍平"。** 平面命名空间会互相撞车——实测已经撞了：

```js
// src/main/mcp_server.js:202-217（原文）
to_target: args.to_target,
dx: args.dx,            // drag 的偏移
dy: args.dy,
...
dx: args.delta_x,       // wheel 的偏移 ← 同一个 key，后者胜出
dy: args.delta_y,
```

对象字面量同名键后者覆盖前者，所以：

```
browse_act({ action: 'drag', dx: 100, dy: 50 })
  → 最终 params.dx = undefined, params.dy = undefined
```

**拖拽按偏移量的用法在 MCP 路径上是静默失效的**，`tests/` 里没有任何用例覆盖它（`grep dx tests/` 为空）。这正是"打补丁式设计"的典型代价：每加一个动作就往同一个对象里塞字段，迟早互相踩。

### R4 · 纪律写在文档里，不写在返回值里

"点击后要 diff 验证""success 不等于做成了""找不到元素先重读树"——这些纪律现在都在 `AGENT_INSTRUCTIONS.md` 里。

问题是：**文档会被忘掉，返回值每轮都在。** 新会话读到第 3 步就丢了第 1 步的纪律。上次对照 BrowserSkill 时看到的 `effect_state` / `steps` 就是把纪律放进返回值——这是同一个病根的另一半解。

---

## 3. 参照系：Chrome 和 Playwright 怎么处理"多"

用户提到 chrome 的无障碍模式和别的无头浏览器。它们确实大，但**大得有结构**：

| 方案 | 规模 | 组织方式 | 关键手法 |
|---|---|---|---|
| **CDP** | 50+ 域 / 300+ 方法 | 按 **domain** 分区（Page / DOM / Input / Network / Accessibility…） | **按需 enable**：没 enable 的域的命令是 no-op，等于"不加载" |
| **Chrome a11y (AXTree)** | 每节点 20+ 属性 | 角色 + 属性 | **省略默认值**：只在非默认时才带属性 |
| **Playwright** | 40+ 方法 | 一个 locator 抽象 + 组合式命名（getBy* / is* / waitFor*） | **共享抽象**，方法名可推出语义 |
| **我们** | 20 工具 / 101 参数 | 按实现模块切 | ❌ 参数拍平、无抽象共享、默认值全写进 schema |

三条可直接借的结论：

1. **它们的"多"是分层的，不是拍平的。** CDP 的 `Input.dispatchMouseEvent` 也有 10 个参数，但那 10 个全是"一次鼠标事件"的属性，属于同一个语义组——不跨动作共用命名空间。我们的 `dx` 既属于 drag 又属于 wheel，就是分层没做。
2. **省略默认值。** Chrome 的 AX 树不带默认属性。我们的 schema 里 `default: false`、`default: 500`、`default: 'down'` 全都是可省的字节。
3. **共享抽象比减少数量更有效。** Playwright 方法不比我们少，但 `locator` 一个概念统住了所有寻址，agent 学一次就够。我们每次都要解释 `data-ai-id` 是什么形状。

**所以优化方向不是"把 20 个砍成 8 个"，而是三件事：参数分组、省略默认、把共性抽成一个说法。** 工具数可以顺带收敛，但不是目的。

---

## 4. 目标与验收

| # | 指标 | 现状 | 目标 | 怎么测 |
|---|---|---|---|---|
| M1 | 工具 schema 固定注入 | 4,730 token/轮 | **≤ 3,600**（P3 后，见 §4.1 修正） | `tests/test_api_budget.js` |
| M2 | 单工具顶层参数 | 27 | **≤ 14**（P2 已达成 13） | 同上 |
| M3 | 冷启动必须读的文档 | ≈5,800 token（说明书+技能） | **≤ 300**（入口），其余按需 | 同上 + 人工走查 |
| M4 | **零文档通过率**（只靠 tool schema，不读任何文档，完成 5 个典型任务） | 未测 | **≥ 4/5** | 新建 e2e 场景，见 §6 P4 |
| M5 | 技能是否随包分发 | 0 个文件 | 3 个以上 | 同上 |

M4 是唯一真正对应"学会一次就够"的指标。前四个是它的先行指标。

> 诚实说明：**新会话的上下文必然是空的，模型不会"记住"。**所以"学一次"在产品上只能实现为两件事——(a) 默认表面（tool schema）自足到不用读文档；(b) 深层知识按需加载且极短。任何声称能让模型跨会话记住的做法，都是在骗自己。

---

## 4.1 P2 实测修正：参数分组不省字节（重要）

原先预计"参数分组能把 schema 压到 9,600 字节"。**实测不成立，必须记下来。**

| | 分组前 | 分组后 | 变化 |
|---|---|---|---|
| `browse_act` 顶层参数 | 27 | **13** | −52% |
| `browse_network` 顶层参数 | 23 | **7** | −70% |
| `browse_act` 字节 | 4,353 | 4,177 | **−4%** |
| `browse_network` 字节 | 2,074 | 2,226 | **+7%**（反而涨了） |
| schema 总字节 | 17,502 | 17,033 | −2.7% |

原因：JSON Schema 的嵌套本身要付结构税——`{"type":"object","description":…,"properties":{…}}`
每个分组多一层包装，吃掉了参数收敛省下的量。`browse_network` 涨了，是因为分组描述写多了。

**结论（会改掉后面的做法）**：

1. **分组的收益是认知负荷，不是 token。** 27 个参数拍平在顶层时，agent 每轮都要读完 27 条才能找到
   自己要用的 3 条；现在它只读"我要用 drag"那一组。这个收益真实存在，但**不体现在字节上**。
2. **字节的大头是描述文字（43%）和工具数量，不是参数个数。** 所以剩下的降本必须走 P3：
   减少工具数、砍掉纯复述参数名的描述。
3. **M1 的目标要改成可达的**：P2 后 4,622 token（−2%），P3 目标 **≤ 3,600**（−23%）。
   再往下压就要牺牲防错信息（比如"paste 用 html 才能保住格式"这类），那会让 agent 犯更多错——
   **用错误换 token 是不划算的**，这条线到此为止。

---

## 5. 阶段划分

### P0 · 度量与守护（本次）
- 新增 `tests/test_api_budget.js`，把 §4 的 M1/M2/M3/M5 变成断言
- 断言值 = 当前基线（先锁住，不许变差），之后每个阶段提交时**手动下调**
- 这样每一步优化都有痕迹、都不许回退——这是"留痕"的机器版本，比写在文档里可靠

### P1 · 技能包重构（本次）
- 新建 `skills/ai-browser/SKILL.md`（≤2,500 B）：**只讲"什么时候用哪个工具"，不讲原理**
- 原理、排查顺序、canvas 细节搬进 `skills/ai-browser/references/*.md`，按需读
- `AGENT_INSTRUCTIONS.md` 瘦身：删掉重复语种，只留 300 token 的速查表
- **修 `package.json` 的 `files`，把 `skills/` 打进去**（R1）
- 加断言：`skills/` 必须在 files 里，入口文件超预算即失败

### P2 · 参数分组瘦身（本次，向后兼容）
- `browse_act`：27 → 约 9 个顶层参数。drag/wheel/press/read/click 各自收进对象
  ```js
  { action:'drag', target:'e:node-3', drag:{ from:{x,y}|{target,anchor}, to:{x,y}|{target,anchor}, hold, button } }
  { action:'wheel', wheel:{ dx, dy, hold }, target }
  ```
- `browse_network`：23 → 约 8。list 的 9 个过滤条件收进 `filters`
- **schema 只暴露分组，handler 同时接受旧的扁平参数**——旧脚本照跑，agent 少读。
- 顺手修掉 R3 的 `dx` 覆盖 bug，并补上覆盖 drag/wheel 两条路径的测试

### P3 · 工具收敛到 12（破坏性，需确认后再做）
| 现在 | 变成 | 理由 |
|---|---|---|
| list/new/close/set_active_tab（4 个） | `browse_tabs {op}`（1 个） | 同一实体的 CRUD，四个工具只为一个动词 |
| browse_scroll | 并入 `browse_act{action:'scroll'}` | 与 `scroll_to` 语义重叠 |
| browse_repaint | **删除**（内部自动） | 渲染 bug 的补丁，不该成为 agent 的负担 |
| browse_capabilities | 折进 `get_tree` 的 `context.route_hint` | 把"要不要探测"变成"已经告诉你了" |
| 其余 | 保留 | |

结果：navigate / get_tree / act / diff / wait / tabs / network / canvas / screenshot / errors / auth_state / evaluate / quit ≈ **13**（正好回到 `PLAN_PRODUCT.md` 当初锁死的量级）。

**为什么不一上来就做**：这是破坏性变更，需要 major 版本号 + 迁移表。等 P2 把 token 降下来、M4 有基线之后再做，才能证明"砍了没变差"。

### P4 · 纪律进返回值（与上一轮对照报告 P0 合并）
- `effect_state` 三态、`steps` 追溯、`stale_ref`
- 这一项才是"不用读文档"的终极解：**agent 不需要被教，因为返回值自己会说话**

**进度（2026-10-19）**

| 项 | 状态 | 落地位置 |
|---|---|---|
| `effect_state` 三态 + `retry` 策略 | ✅ | `src/shared/effect_state.js`，唯一出口 `page_manager._annotateActResult` |
| `stale_ref` / `tree_epoch` / `ref_diagnosis` | ✅ | `src/shared/ref_epoch.js` + `getTree` 尾部登记 + `_annotateActResult` 诊断 |
| `steps` 逐步追溯 + 失败自动截图 | ⬜ **未做，且不打算按原样做** | 见下 |

`steps` 没做的理由（不是懒，是权衡后否决）：

1. **它要求改动作实现的内部结构**。目前 12 个动作各自是一条直线（解析目标 → 派发
   → 校验），没有"步骤"这个中间层。要产出 `steps`，得先把每个动作拆成带名字的
   阶段，等于在 3,800 行的 `page_manager.js` 里做一次大重构 —— 与 §6「不做的三件事」
   里"不为数字好看去改结构"冲突。
2. **失败自动截图有副作用成本**：每写一张图就多一次磁盘 I/O + 一个要清理的文件，
   而 agent 想看页面时 `browse_screenshot` 一直都在。**默认替它截，等于替它决定
   要看什么**，还把"失败"这个信号变成"多了一个要解读的东西"。
3. **收益被 P4 前两项吃掉大半**：诊断"为什么失败"的关键信息（有没有被动过 / ref 是
   过期还是错了）现在已经在回执里，不需要逐步时间线也能做对下一步。

真要补，优先级最高的是 `elapsed_ms`（一个数字，零结构改动），而不是完整 `steps`。

---

## 6. 明确不做

- **不做"把 20 个砍成 5 个"的极简主义**。工具数不是主要成本，参数拍平才是。砍错了反而让 agent 要多轮组合。
- **不做单一 mega-tool**（`browse({domain, op, ...})`）。看起来工具少了，实际把类型信息和错误信息都糊掉了，是所有 MCP 设计里最差的一种。
- **不做"模型记住"类的伪方案**（本地记忆文件、跨会话缓存）。每次会话开始上下文必然为空，这是机制，不是缺陷。
- **不给说明书加更多内容**。任何新增解释都要先回答：**能不能换成一句 schema 描述、或者一个返回值字段？**

---

## 7. 已修：`opened_tab` 漏报"这次点击开的新标签"（2026-10-19）

**症状**：西电专技课程页点「进入学习」（站点 JS 走 `window.open("")` + `location` 赋值），
标签**确实开了**，回执却是 `opened_tab: null` —— agent 据此认为"点了没反应"，
正是这一轮要消灭的那类误判。

**实测时序**（act 10~15ms 就返回，标签 100~240ms 才出现）：

| 轮次 | 新标签出现 | 说明 |
|---|---|---|
| 1 | 214ms | 站点先 fetch 拿地址再 window.open |
| 2 | 104ms | 热缓存 |
| 3 | 236ms | 冷一点 |

第一次测到的"稳定 105~119ms"是三轮热缓存的假象，加等待后复测立刻散到 200ms 以上。
**这条推翻了"固定 100ms 就够"的初始判断** —— 延迟跟着网络走，不是一个常数。

**修法**：点完给一个有界窗口再收记录（`_awaitOpenedTab`），配三个提前退出：
1. 已有记录 → 立即返回；
2. 本 tab 已开始原地导航 → 立即返回（站内跳转不会同时开新标签，而这是最高频的点击）；
3. 目标不是 `<a>` → 立即返回（实测：不加这道闸，点段落这种点击从 7ms 变 261ms）。

**代价（实测，写清楚免得以后被当成 bug）**：

| 点击类型 | 耗时 |
|---|---|
| 非链接元素（点段落） | 13~16ms（闸门拦掉等待） |
| 站内跳转链接 | 39ms（前 32ms + 探 tagName 约 7ms） |
| 会开新标签的链接 | 103~132ms（记录一出现就返回，不等满） |
| 强制 `opened_tab_wait_ms: 0` | 6~16ms |

可关：`opened_tab_wait_ms: 0` 单次关闭，`AI_BROWSER_OPENED_TAB_WAIT_MS=0` 全局关闭。

**顺带修掉的两处**：
- `_consumeOpenedTab` 现在读**实时** URL。之前回的是建标签那一刻的 `about:blank`
  —— 对 agent 来说跟"打开了个空白页"没区别，正是当初那个 bug 的样子。还没导航完时
  回 `url_pending: true`，而不是假装知道地址。
- 两个实机才暴露的错：`_evaluateViaCdp` 返回的是 `{result:{value}}` 包裹（用它判
  tagName 会永远判成"不是链接"）；`_awaitOpenedTab` 引用了没在参数表里的 `target`
  （`wait:0` 时短路，所以单测和快路径都发现不了，只在真机上炸）。

# canvas 类站点的可用性：按「意义落在哪一层」分类，而不是按「是不是 canvas」

> 2026-10-29。触发问题：Figma / Miro / tldraw / Excalidraw / AFFiNE / Flutter Web /
> Glide DataGrid / Google Docs / Notion / 浏览器内 VM 控制台 —— 这些把界面画在
> canvas 上、语义树近乎空白的站点，ai-browser 还能不能用。
>
> 本文的每条结论都标注来源：**[实测]** 表示在本机真实浏览器里跑过并有落盘数据
> （`outputs/canvas-targets-probe.json`、`outputs/canvas-model-probe.json`）；
> **[机制]** 表示据该站点的公开技术事实推断，未在本机取得可复现样本。

---

## 0. 一句话结论

那类分析把问题定义成「canvas 让语义树空白」，**只对了一半，而且是不太致命的那一半**。

真正致命的是**验证层**：动作做完了，工具无法证明它发生了。而「可验证操作」正是本
项目唯一的赌注——读取可以退化成截图，验证不能。

**[实测]** 在 Excalidraw（无需登录、全球最有代表性的 canvas 白板）上拖出一个矩形：

| 观测手段 | 结果 |
|---|---|
| 语义树 | 40 个元素，全是工具栏 |
| canvas | 2 个，均为 2D 上下文 |
| `window` 上的数据模型 | **没有**（只有 `EXCALIDRAW_ASSET_PATH` 这个字符串路径） |
| `ui.canvas_read` | 29 条记录全是全屏 `fillRect`/`clearRect`，`texts` **为空** |
| `ui.act` 回执 | `page_changed` 为真，但真因是**选中图元后右侧属性面板出现**（DOM +48 节点） |
| `ui.diff` | `changed:true`，差异条目**全部是 DOM 节点**，没有一条来自画布 |

也就是说：这一次 `page_changed:true` 是**运气**。动作只要不产生面板变化（移动已有
图元、在空白处涂色、连续调参），DOM 就是零字节，回执会变成 `page_changed:false`
加一句「payload most likely never landed」——把一次成功的写入说成失败。

已用夹具复现并修复（见第 4 节）。复现方式：页面上只有一个 `<canvas>`、图元存在闭包
里、DOM 不可能有任何动静。修复前：`page_changed=false`、`page_delta={text_chars:0,
dom_nodes:0,focused_chars:0}`、`effect_hint` 说写入没落地，而页面内部状态确实从 0 个
图元变成 1 个。

---

## 1. 四层模型：意义在哪一层，就用哪一层的判据

把「这些站点很难」换成一个可判断的问题：**这个应用把「意义」交给了什么载体？**

| 层 | 载体 | 能读到什么 | 判据（怎么确认它在这一层） | 现状 |
|---|---|---|---|---|
| **A** 语义层 | DOM / ARIA | 角色、名称、状态、可操作性 | `ui.get_tree` 元素数与 `actionable` | 已覆盖 |
| **B** 模型层 | 应用自己的数据模型 | 完整文档 JSON，可读可写可回读 | `window` 上有 `serialize`/`_nodes`/`getState`；或框架运行时里挂着 store | **弱**：只按 `window` 全局的**名字**猜 |
| **C** 绘制层 | canvas 2D 绘制调用 | 画了什么：文本串、几何边界、绘制顺序、**这一帧变没变** | `window.__aiCanvasFp()` 存在且随绘制变化 | 部分：能记调用，**今天之前回答不了「变了没有」** |
| **D** 像素层 | 合成后的位图 | 只有截图 | WebGL / skia / 视频流 | 明确不做主路径 |

站点归位（**[机制]** 标注的未取得可复现样本）：

| 站点 | 判定的层 | 依据 |
|---|---|---|
| Excalidraw **[实测]** | C（+ A 工具栏） | 2D canvas、无 window 模型、`canvas_read` 只有全屏 rect |
| Glide DataGrid **[实测]** | C + A | 5 个 2D canvas，同时 215 个 DOM 元素（表头、按钮在 DOM） |
| tldraw / AFFiNE **[实测：仅落地页]** | C（推定） | 落地页分别 3 / 2 个元素、无 canvas——**没有拿到真实白板样本**，见第 5 节 |
| Figma / Miro **[实测：仅营销页]** | B → 无 / C | 营销页有 canvas（Miro 2 个 2D）与 React fiber（Figma 42 跳），但 fiber 上找不到 store——**这是营销页，不代表编辑器** |
| Google Docs **[实测：撞登录墙]** | C + contenteditable 混合 | 未取得样本 |
| Flutter Web **[实测：渲染未完成]** | D | wonderous.app 树只有 1 个节点、`flt-*` 宿主为 0，8 秒内没渲染出来 |
| 浏览器内 VM 控制台 **[机制]** | D | 画面是流式位图，任何结构都拿不到 |

**这张表的用途不是给站点打分，而是决定走哪条路。** 同一层内的站点用同一套打法，
不需要为每个站点写适配。

---

## 2. 每一层怎么打

### A 层：已覆盖，不作为这批站点的出路

canvas 应用的工具栏通常在 DOM 里，所以 `ui.get_tree` 至少能拿到「有哪些工具」。
Excalidraw 40 个元素 / 84 个可操作动作就是这个。够做「点矩形工具」，不够做
「把第三个画框里的文字改成标题」。

### B 层：从「按名字猜」升级为「按结构找」

现在 `APP_KEY_RE` 是名字白名单（`app|editor|graph|store|...`）。**[实测]** 它漏掉了
Excalidraw 的一切，也漏掉了所有把 store 藏在模块作用域里的应用。

三个可行的判据，按可靠性排序：

1. **结构签名**（不看名字）：对象同时具备 `getState`+`subscribe`（zustand/redux）、
   `getText`+`getMap`+`transact`（Yjs）、`serialize`（可序列化模型）。
2. **框架运行时**：从根元素的 `__reactFiber$*` 沿 `return` 链上溯，检查
   `memoizedState`（hooks 链表）、`stateNode`（class 实例）、`memoizedProps`。
   **[实测]** Figma 营销页能走通 42 跳、12 个 context 依赖——通道是通的，只是营销页
   本来就没有编辑器 store。
3. **网络层**：协作类应用（Figma/Miro/tldraw/AFFiNE）的文档更新走 WebSocket，
   帧里是 CRDT 增量。能观测到「变了」，但**不应尝试解析成文档**（协议私有、
   版本敏感、写错会污染协作房间）。

投入产出：第 1 条最便宜且立刻能用；第 2 条是 Figma/Miro 这类「模型在框架里」的唯一
通路；第 3 条只做观测，不做解析。

### C 层：这是 canvas 应用的主读取层，但别承诺「重建场景」

**[实测]** 一个反直觉但重要的事实：Excalidraw 用的是 2D canvas，却**没有 `fillText`**。
它整帧 `clearRect` + 一次性 `fillRect` + 大量 `Path2D`，文本走离屏 canvas 合成。
所以「2D canvas → 抓 `fillText` → 等于读到了文字」这条推理**在真实应用上不成立**。

C 层能可靠回答的只有两件事：
1. **画了什么**（调用记录）—— 对绘图型应用信息量大，对「整帧重绘」型应用密度低。
2. **变了没有**（帧指纹）—— 对所有 canvas 应用都成立，且不依赖理解语义。

第 2 件事今天已经落地（第 4 节）。它不试图理解画布，只回答「这一帧和上一帧是不是
同一帧」，这正是验证需要的粒度。

### D 层：诚实边界

WebGL、Flutter Web（skia）、流式远程桌面：**没有结构化通路**，只有像素。已做的选择是
不把截图/OCR 当主路径（那等于把工具退化成「人肉视觉」，而且不可验证）。

给这类站点的答复应当是「读不到，请用站点自己的导出/分享接口，或者由人在窗口里操作」，
而不是「让 agent 在坐标上瞎点」。这条边界写进 `ui.capabilities` 的 route 里，比事后
让 agent 自己发现要省得多。

---

## 3. 为什么不给每个站点写适配

用户列的十来个站点，如果按「站点」组织工作量，就是十来个适配器，每个都会腐烂。
按「层」组织只有四条路，而且第 C 层的一条改动（帧指纹）同时修好了 Excalidraw、
Glide DataGrid 和所有还没被想到的 canvas 白板。

这也解释了为什么修复点落在 `page_probe` / `snapshot_diff` / `canvas_hook` 这三个
**与站点无关**的模块上，而不是新增任何站点知识。

---

## 4. 今天落地的改动（含可证伪证据）

### 改了什么

| 文件 | 改动 |
|---|---|
| `src/main/canvas_hook_source.js` | `push()` 里累积**帧指纹**：`clear` 时 `frames+1`、`fp` 归零；其它绘制按顺序 `fp = fp*33 ^ hash(rec)`。暴露不可枚举的 `window.__aiCanvasFp()`，返回 `{n, fp, frames, on}`；`mode=off` 时返回 `null`（「没在录」≠「录了但空」） |
| `src/shared/page_probe.js` | `PAGE_PROBE_JS` 增加 `c` 字段读该指纹；`diffProbe` 拆出 `domChanged` 与 `canvasChanged`；仅画布变化时回执给 `canvas_changed:true` + 一句说明，**且不把写类动作降级成 unknown** |
| `src/main/snapshot_diff.js` | 默认快照增加 `out.canvas`（+148 字符，4621→4769 / 5000），`ui.diff` 因此能看见画布写入 |
| `e2e/canvas_ws.cjs` | 新增纯 canvas 白板夹具（DOM 只有一个 canvas、图元在闭包）+ CB-1..CB-10 |
| `tests/test_page_probe.js` | PP-17..PP-24 |
| `tests/test_canvas_hook_source.js` | 5 条**执行**真实 hook 源码的用例（不是字符串断言） |

### 证据链

**1. 缺陷可证伪复现**（回退 `page_probe` 的 `c` 字段）：

```
FAIL | CB-3 … page_changed=false delta={"text_chars":0,"dom_nodes":0,"focused_chars":0}
FAIL | CB-6 … page_changed=false: the action returned success but the main document did not change…
PASS | CB-7 页面内部状态真的变了（自证）— 1
```

写入真的发生了（页面自述 1 个图元），工具却说「payload 很可能没落地」。

**2. 修复后**（同一夹具）：

```
PASS | CB-3 … success=true page_changed=true delta=undefined
PASS | CB-4 … canvas_changed=true
PASS | CB-8 ui.diff → verdict=changed
PASS | CB-9 差异条目 [{"path":"canvas.fp","from":0,"to":452990307},{"path":"canvas.n","from":0,"to":36}]
PASS | CB-10 静止不动时 verdict=unchanged（指纹不会自己漂）
```

**3. 两条通路各自独立**（回退快照里的 `out.canvas`）：CB-8/CB-9 红，CB-3..CB-7 绿。
说明 `ui.act` 与 `ui.diff` 是两条独立的观测口，不是同一条断言换了个名字。

**4. 指纹本身的稳定性**（单测，`node:vm` 里执行真实 hook 源码）：同一帧内容重放两次
得到同一个 `fp`；多画一个矩形 `fp` 变；`mode=off` 返回 `null`。

### 数字

- 单测 **1071 / 78 文件**全绿（改动前 1058）
- `npm run canvas` **24 项**全绿（改动前 13 项，+CB-1..CB-10、+C-14）

---

## 5. 这份实测的边界（必须写清楚，否则上面的结论会被高估）

1. **大多数站点只测到了落地页或登录墙**：Figma / Miro / Google Docs / Notion /
   AFFiNE 均未进入真实编辑器。表里对它们的判定是**[机制]**推断，不是实测。
2. **tldraw、AFFiNE 的真实白板没拿到**：落地页 3 / 2 个元素、0 canvas。
3. **Flutter Web 没有有效样本**：`gallery.flutter.dev` 在本机 DNS 不可达；
   `wonderous.app` 返回 200 但 8 秒内树只有 1 个节点、`flt-glass-pane` 为 0，
   属于「渲染未完成」而不是「渲染了但读不到」。这一层的结论目前只有机制推导。
4. **Glide DataGrid 两轮数字不一致**（33 与 215 个元素）：加载时序没定住，
   这本身就是「外网站点不适合作回归基线」的证据——所以夹具才是判据，外网只是取样。
5. **`canvas_read` 在 Excalidraw 上读不到文字**这条**只代表该渲染器的画法**，
   不能推广成「2D canvas 都读不到文字」：自带夹具里 `fillText` 的中英文都能读到
   （C-04..C-06）。

---

## 6. 下一步（按性价比排序）

1. **B 层结构发现**：把 `APP_KEY_RE` 的名字匹配换成「结构签名优先、名字只作提示」，
   再补 React fiber / Yjs 两条运行时通路。这是 Figma / Miro / Notion 这类站点的
   唯一出路，也是 `ui.capabilities` 从「猜」变成「查」的关键。
2. **idle 检测**：动画页面（时钟、光标、进度条）的画布指纹会自己变，此时它不能当作
   「我的操作生效了」的证据。做法：动作前后各多读一次，空闲期也在动就标
   `canvas_animating:true`，让 agent 知道这个信号不可用。
3. **C 层的场景级读取**（谨慎）：只有确认渲染器确实用 `fillText` 时才提供文本列表，
   否则如实报「这个画布是整帧重绘，只有帧指纹可信」。**不做 OCR。**
4. **Flutter Web 的专门判断**：先把「可复现样本」拿到（本地起一个 Flutter Web demo），
   再决定是归 D 层还是有一条 `flt-semantics` 的旁路（Flutter 本身有语义树，
   只是挂在 shadow DOM 里，值得单独验一次）。

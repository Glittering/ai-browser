# 不用截图和 OCR：给 Agent 喂"语义树"的浏览器是怎么设计的

> 这是一个开源项目的设计复盘。项目叫 AI Browser（GitHub: `Glittering/ai-browser`），MIT 协议。这篇文章不讲情怀，只讲设计决策：为什么放弃截图路线、语义树长什么样、受信输入为什么必须走 CDP、"验证操作生效"为什么应该是一个工具原语。文末有仓库链接，欢迎拍砖。

## 一、先把问题定义清楚：截图路线到底错在哪

现在让 Agent 操作网页的主流做法是：截图 → 视觉模型读图 → 猜坐标点击。

这条路的问题不是"不够好"，是抽象层选错了：

1. **贵**：每一次交互都是一张图进上下文。一个 10 步的任务就是 10 张图，视觉 token 的消耗是纯文本的几十倍。
2. **脆**：坐标绑定的是像素。页面滚动 100px、弹一个 toast、响应式布局切一档，所有坐标全废。你没法对"像素偏移"做单元测试。
3. **慢**：截图 → 上传 → 视觉模型推理 → 返回坐标，一个循环几百毫秒到几秒。而 DOM 查询是微秒级。
4. **信息有损**：视觉模型看到的是渲染结果，看不到"这个输入框必填""这个按钮 disabled""这个弹层刚关掉了"。这些恰恰是 Agent 最需要的状态。

更深一层：**截图本质是换了个马甲的 OCR 问题**。人类用眼睛读网页是因为我们只有眼睛；Agent 不需要眼睛，它需要的是结构。

所以这个项目的核心决策只有一句话：**人类看像素，AI 看语义树。**

## 二、语义树：不是无障碍树的转储，是给 Agent 的"页面接口"

第一次尝试会很自然地想到：把浏览器的无障碍树（Accessibility Tree）dump 给 Agent 不就行了？

不够。无障碍树是为屏幕阅读器设计的，它的假设是"用户按 Tab 顺序线性浏览"；而 Agent 需要的是随机访问、状态查询和操作验证。我们在无障碍树基础上做了三件事：

### 2.1 每个元素带类型、标签、状态和可执行动作

```json
{
  "tree": {
    "role": "textbox",
    "label": "请输入文章标题（5～100个字）",
    "value": "AI Browser test title",
    "states": ["visible", "focused"],
    "actions": ["type", "setContent", "clear", "focus"]
  }
}
```

`role/label/value` 是三元组，`states` 是可见性/焦点/禁用等状态，`actions` 是这个元素**支持哪些操作**——Agent 不用试错，接口直接告诉它能干什么。

### 2.2 页面级"上下文"和元素树一起返回

```json
{
  "context": {
    "modals": [{ "header": "博主不存在", "buttons": ["确定"] }],
    "required_hints": ["0/256", "请选择", "*"],
    "messages": [{ "text": "发布成功", "type": "success" }],
    "session": { "logged_in": true },
    "stats": { "inputs": 20, "buttons": 35, "links": 94, "iframes": 2 }
  }
}
```

模态框、必填提示、toast 消息、登录态——这些东西散落在页面各处，但对 Agent 判断"我刚才那步到底成没成"至关重要。一次 `get_tree` 全带走。

### 2.3 稳定元素 ID，而不是每次重新匹配

每个元素注入稳定的 `data-ai-id`（如 `e:div-60`）。Agent 拿到树、选中节点、执行操作，全程引用同一个 ID。这和"每次用 CSS selector 重新找元素"是两种可靠性等级——后者在 React/Vue 的 class hash 面前不堪一击。

> 实测数据：东方财富一个股票页能抽出 2458 个语义节点，全部带 ID，一次返回。

## 三、受信输入：为什么合成事件在路上，CDP 在终点

Agent 操作网页的第二条路是"合成事件"：`element.dispatchEvent(new MouseEvent('click'))` 或者框架的 `fireEvent`。

合成事件在真实网站上死得很难看，原因各不相同但都无解：

- **Draft.js / ProseMirror / Quill**：监听的是 `beforeinput`/`composition` 等受信输入链，合成事件直接进不了编辑器的状态机。
- **用 Pointer Capture 的框架**（比如 React Flow 画布）：合成 `PointerEvent` 的坐标是 (0,0)，拖拽移动量为零——你拖了个寂寞。
- **部分站点屏蔽 Cmd+A**：知乎编辑器就干这事，合成全选无效。

项目的选择是：**所有点击和按键走 Chrome DevTools Protocol 的受信输入通道**，和真人键鼠同一条路：

```
点击：元素滚入视口 → Input.dispatchMouseEvent(mousePressed/mouseReleased) → elementFromPoint 校验命中
输入：focus → 全选（被屏蔽时回退原生 Range API）→ 受信 Delete → 逐字符 rawKeyDown → char → keyUp
```

逐字符而不是一次性 `insertText`，是因为很多编辑器的自动格式化、@提及、 Markdown 快捷键都挂在逐键事件上。慢一点，但和真人打字完全同构。

**校验不是可选项**：每次点击后用 `elementFromPoint` 复核"点的位置到底是哪个元素"——浮层吞点击是 Agent 操作的头号故障源，不校验就等于把成功寄托于运气。

## 四、验证是原语：对付"工具返回 success 但什么都没发生"

这是整个设计里我最得意的一块，因为它来自真实的痛。

浏览器 MCP 工具返回 `success` 只代表"指令已执行"，不代表"页面发生了变化"。实际场景里：

- 点击被浮层吞了，返回 success，页面纹丝不动；
- 表单提交后接口静默失败，UI 没变化；
- **Canvas 应用只改数据模型，DOM 一个字节都不动**（ComfyUI 改 `node.widgets[].value`，DOM 零变动）。

前两者还能靠"再读一次 DOM"发现，第三者读 DOM 永远得到"没变化"。Agent 于是陷入"我明明点了但没生效"的循环，或者更糟——误以为生效了继续往下走。

所以 `browse_diff` 被做成了工具原语而不是测试代码：

1. 操作前快照基线（DOM 语义树 + 页面数据模型指纹）；
2. 操作后比对，返回**显式的 changed / unchanged 判定**，附带前后值和 JSON path；
3. 对页面自身的数据模型做指纹化——canvas 类应用的数据变动即使 DOM 零变化也能捕获；
4. 表达式抛错或快照为空时返回**显式错误**，而不是让后续所有 diff 假绿。

最后一条是红线：一个"永远返回 unchanged"的 diff 工具比没有 diff 工具更危险。测试自己先要通过"控制组"——故意制造不变的操作，确认工具能报告 unchanged。

## 五、Canvas 文字：在绘制层截获，而不是 OCR

Canvas 里的文字（图表标签、流程图节点）对截图方案是重灾区：要么 OCR（又贵又不准），要么放弃。

项目的做法是 tee 住 2D Canvas API：录制 `fillText` 等绘制调用的字符串参数，文字在进入像素之前就已经是文本了。几个设计约束：

- **绝不接管原生调用**——录制失败也不能改变渲染结果；
- 只有 WebGL 保留截图路径，且默认关闭，用了就算视觉账；
- 录制层和渲染层解耦，Canvas 用不用由调用方决定。

## 六、不抢焦点：副驾的自我修养

这个形态叫"副驾浏览器"（co-pilot browser）：一个正常可见的 Electron 窗口，常驻桌面，持久登录，Agent 通过 MCP（17 个 `browse_*` 工具）或裸 WebSocket JSON-RPC 驱动它。

"Agent 在后台操作时窗口不抢焦点"不是锦上添花，是生死线——窗口每操作一次就弹到前面，人根本没法同时干别的事，"共享浏览器"的形态就不成立。实现上是 `showInactive` 启动 + 页内焦点状态模拟（懒加载靠 IntersectionObserver，焦点模拟让它以为页面可见）。

难点是**怎么证明自己不抢焦点**。项目用了外部验证：跑一整套 API 操作切片的同时让计算器占据前台，用 macOS `lsappinfo` 从进程外读真实前台应用，断言全程不变；并且保留一个**故意抢焦点的控制组**——没有控制组的焦点测试是可以假绿的。

扫码、滑块、支付确认怎么办？人直接伸手用鼠标做掉，Agent 在对话里等一句"done"。**人机交接不需要 API，需要的是不添乱。**

## 七、工程与红线

- **测试**：428 个单元测试（28 个文件）+ 12 个 Electron e2e 套件共 428 个断言，全部跑真实浏览器，fixture 离线化（焦点套件测的是真实前台进程，不是 mock）。
- **安全**：`contextIsolation` + `nodeIntegration:false`；`evaluate` 限 5000 字符并拒绝 `process.`/`require`/`child_process`，两条传输通道（MCP / WS）同一套 guard；控制端口只绑 `127.0.0.1`——协议无鉴权，所以**永远不要转发或暴露 9223 端口**，能连上它就能驱动浏览器。
- **诚实的边界**：macOS / Linux 已测，Windows 未测（纯 Electron + CDP，理论上没问题，但没测就是没测）；单人维护；和 chrome-devtools-mcp 定位有重叠——要 DevTools 深度用它，要"常驻副驾"用这个。
- **安装**：`npx -y @glittering0717/ai-browser mcp`，Node ≥ 18，首次自动准备 Electron 引擎（国内设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。已收录 MCP 官方 Registry：`io.github.Glittering/ai-browser`。

## 八、复盘：三个可迁移的结论

1. **感知层的抽象比操作层重要**。选对了表示（语义树），操作、验证、测试全部顺流而下；选错了（截图），后面每一层都在还债。
2. **"像真人"是可靠性的捷径**。受信输入 + 逐字符 + 命中校验，比任何框架特判清单都短，且对未知框架天然有效。
3. **验证必须是一等公民**。Agent 场景里"假装成功"比"明确失败"危险十倍，显式判定 + 控制组是底线。

---

仓库：https://github.com/Glittering/ai-browser （MIT，欢迎 issue 拍砖，特别是"哪些网站语义树读错了"——这是目前最想收的反馈）

*本文为项目设计复盘，数据均来自仓库实测（428 单测 + 428 e2e 断言、17 个 MCP 工具、知乎 Draft.js / CSDN CKEditor 全流程、东方财富 2458 节点）。*

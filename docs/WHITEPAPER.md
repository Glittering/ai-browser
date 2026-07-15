# AI Browser — 架构白皮书 v1.0

> "The computer should disappear. AI never needs to know pixels exist."
> — 基于 AI Native 渲染理念，2026.07.15

---

## 1. 问题：为什么逆向工程人类浏览器是死路？

semantic-ui-bridge 验证了一个事实：**在人类浏览器上用 CDP AX / DOM evaluate 补丁式提取语义是可行的，但上限很低。**

| 补丁方案（bridge） | 根本问题 |
|-------------------|---------|
| CDP Accessibility.getFullAXTree | AX树为盲人设计，不为AI设计。React SPA中初始快照几乎为空。 |
| DOM.getDocument + evaluate | 每次拉全量DOM，Agent自己遍历5000节点——token浪费巨大。 |
| networkidle + wait_for_selector | 每个页面需人工定制等待策略。通用性差。 |
| 坐标模拟click | <div onclick> + React事件委托 → 坐标点击无效果。 |
| 文本输入 | `locator.fill()`触发的是合成事件，React controlled input可能不接受。 |

根源：**所有方案都在试图从"为人类渲染的像素+DOM"中反向提取语义。方向性错误。**

---

## 2. 洞察：渲染时同步产出两份输出

浏览器内核的渲染管线是这样的：

```
HTML/CSS/JS → Parse → DOM Tree → Style → Layout → Paint → Composite → Pixels
```

关键节点：**DOM Tree + Style + Layout 阶段，语义信息是完整的。Paint之后的像素才是给人类看的。**

正确方案：在 DOM Tree → Style 完成后，分叉：

```
DOM Tree + Computed Style
        │
        ├─→ 人类管线：Layout → Paint → Composite → 屏幕（照常保留，给人看）
        │
        └─→ AI管线：Semantic Extraction → Action Binding → JSON-RPC Server
                                                     │
                                              Agent 直接调 API
```

人类看到的网页完全不变。AI得到的是**同步产出的、无需反向提取的结构化界面**。

这不是"无障碍补丁"。无障碍是在Paint之后再加一层screen reader接口——为时已晚。AI管线是在渲染前中期介入，拿到的是第一手语义。

---

## 3. AI Browser 架构

```
┌─────────────────────────────────────────────────────┐
│                   Chromium Content API               │
│  (Blink渲染引擎 — 我们不改它，只hook它的输出)         │
│                                                     │
│  HTML/CSS/JS → DOM Tree → Style Resolution           │
│       │                                              │
│       ├─→ 人类管线 (保留，浏览器窗口可见)             │
│       │                                              │
│       └─→ AI 管线 (新增)                             │
│            │                                         │
│            ├─ Semantic Extractor                     │
│            │  从DOM+Style提取:                        │
│            │  • 交互元素 (button/input/select/a)     │
│            │  • 语义角色 (landmark/heading/table)    │
│            │  • 文本内容 (heading/paragraph/label)   │
│            │  • 视觉层级 (z-index, visibility)       │
│            │                                         │
│            ├─ Action Binder                          │
│            │  为每个交互元素绑定可调用动作:             │
│            │  • click, dblclick, hover               │
│            │  • type, clear, select                  │
│            │  • focus, blur                          │
│            │  • scroll_to, get_bounds                │
│            │  动作直接调原生DOM API，不走坐标          │
│            │                                         │
│            ├─ State Tracker                          │
│            │  追踪DOM变更:                             │
│            │  • MutationObserver (新增/删除节点)      │
│            │  • 属性变更 (disabled, checked, value)   │
│            │  • focus/blur 事件                       │
│            │  • dialog/modal 打开关闭                  │
│            │  → 推送结构化diff给Agent                 │
│            │                                         │
│            └─ JSON-RPC Server (WebSocket)            │
│               Agent 的唯一界面:                       │
│               • ui.get_tree() → SemanticUITree        │
│               • ui.act(action, target, params)        │
│               • ui.subscribe(events) → EventStream    │
│               • ui.screenshot(region?) → base64       │
│                  (截图是降级，仅在开发调试用)         │
└─────────────────────────────────────────────────────┘
```

---

## 4. 核心 API（JSON-RPC over WebSocket）

```
→ {"method": "ui.get_tree", "params": {"focused_only": false}}
← {"result": {"tree": SemanticUITree, "timestamp": 1752...}}

→ {"method": "ui.act", "params": {"action": "click", "target": "e:btn-42"}}
← {"result": {"success": true, "diff": ["e:dlg-99: added", "e:btn-42: state=active"]}}

→ {"method": "ui.subscribe", "params": {"events": ["focus", "dialog_open", "dom_change"]}}
← {"event": "dom_change", "changes": [{"node": "e:list-5", "children_added": ["e:item-12"]}]}
```

和 bridge 的区别：

| | bridge（补丁） | AI Browser（产品） |
|---|---|---|
| 数据源 | CDP AX（快照） | DOM + Style（实时） |
| 时机 | 调一次拉一次 | 持续同步，变更推送 |
| JS动态渲染 | 需手动等待 | 自动跟踪 |
| 动作执行 | 转坐标→转locator | 直接调原生DOM API |
| React controlled input | 可能失败 | 原生value赋值+dispatchEvent |
| 部署 | Python库 | 独立浏览器进程 |

---

## 5. SemanticUITree 数据模型（继承并扩展 bridge）

```json
{
  "app": {"url": "https://example.com", "title": "Page Title"},
  "root": {
    "id": "e:root-0",
    "role": "group",
    "label": "Page Title",
    "states": ["visible"],
    "children": [
      {
        "id": "e:btn-42",
        "role": "button",
        "label": "提交订单",
        "tag": "button",
        "states": ["enabled", "focusable", "visible"],
        "actions": ["click", "focus", "hover"],
        "bounds": {"x": 320, "y": 480, "w": 120, "h": 40},
        "attributes": {"type": "submit", "data-track": "checkout"}
      }
    ]
  },
  "timestamp": 1752569600.123,
  "focused_element_id": "e:input-15"
}
```

比 bridge 多了：
- `tag` — 原始HTML标签名（Agent可选参考）
- `attributes` — data-* 和 ARIA 属性
- Action类型多了 `hover`, `dblclick`, `clear`

---

## 6. MVP 范围

### 砍掉

- ❌ 多Tab管理（1.0只有一个页面）
- ❌ 扩展/插件系统
- ❌ 书签/历史（Agent自己管状态）
- ❌ 下载管理
- ❌ DevTools / 人类调试面板
- ❌ 地址栏 / 导航UI（Agent通过API导航）

### 留下（灵魂功能）

- ✅ **双输出渲染**：人类窗口 + AI JSON-RPC Server 并存
- ✅ **Semantic Extractor**：从DOM提取交互元素树
- ✅ **Action Binder**：click/type/focus/scroll 直接调原生DOM
- ✅ **State Tracker**：MutationObserver → 推送UI diff
- ✅ **WebSocket Server**：Agent通过 ws://localhost:9223 连接
- ✅ **Human View**：一个极简浏览器窗口（via风格），证明"人也能正常看"

### MVP 一句话

> 一个基于Chromium的浏览器进程。打开WebSocket，Agent调 `ui.get_tree` 拿到实时语义树，`ui.act("click", "e:btn-42")` 执行操作——不走坐标、不等快照、不猜React事件。

---

## 7. 技术方案选择

### 基础：Electron / Chromium Embedded Framework？

| 方案 | 优势 | 劣势 |
|------|------|------|
| Electron | Node.js生态，快速原型 | 重（~150MB），但1.0不管体积 |
| Playwright + CDP | 已熟悉，可复用adapter逻辑 | CDP仍是中间层，不是原生DOM |
| Puppeteer + CDP | 同上 | 同上 |
| **直接用 Electron 嵌 Blink + 自建WebSocket** | **完全控制DOM，原生动作执行** | 需要写BrowserWindow + preload脚本 |

**选 Electron。** 理由：
- preload脚本可以直接注入DOM hook（Semantic Extractor + Action Binder + State Tracker）
- main process 开WebSocket server
- 人类窗口直接就是BrowserWindow
- `ipcMain`/`ipcRenderer` 做内部通信，比CDP快10倍
- 1.0不用在乎包体积——Insanely Great first, optimize later

### 为什么不用Playwright/Puppeteer？

它们用CDP——CDP是调试协议，不是AI接口。每个 `DOM.getDocument` 调用要序列化整个DOM到JSON再传回——对5000节点的页面是灾难。而preload脚本在渲染进程内直接访问DOM，零序列化开销。

---

## 8. 模块结构

```
ai-browser/
├── docs/
│   ├── WHITEPAPER.md
│   ├── SPEC.md
│   └── TEST_SPEC.md
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.js           # 入口：创建BrowserWindow + 启动WS server
│   │   ├── ws_server.js       # WebSocket JSON-RPC server
│   │   └── page_manager.js    # 页面生命周期管理
│   ├── preload/               # 注入到渲染进程（直接访问DOM）
│   │   ├── semantic_extractor.js  # DOM → SemanticUITree
│   │   ├── action_binder.js       # 动作映射+执行
│   │   ├── state_tracker.js       # MutationObserver → diff
│   │   └── bridge.js              # preload ↔ main IPC
│   └── shared/                # 主进程和渲染进程共享
│       └── protocol.js        # JSON-RPC消息格式定义
├── tests/
│   ├── test_semantic_extractor.js
│   ├── test_action_binder.js
│   ├── test_state_tracker.js
│   ├── test_ws_protocol.js
│   ├── test_integration.js    # 真实页面全链路
│   └── test_pages/            # 测试用的HTML文件
│       ├── basic_controls.html
│       ├── react_spa.html
│       └── dynamic_content.html
├── package.json
└── electron-builder.yml       # 打包配置（未来）
```

---

## 9. 非目标

- 不做浏览器市场份额竞争
- 不做人类用户的日常浏览器
- 不做自然语言→动作翻译（那是Agent的事）
- 不做多Tab/扩展/同步
- 不做移动端（1.0只桌面）

---

## 10. 成功标准

| 指标 | 目标 |
|------|------|
| get_tree 延迟 | <50ms（preload内直接读DOM） |
| act 延迟 | <10ms + DOM事件处理时间 |
| React SPA 兼容性 | controlled input正确赋值，事件委托正常触发 |
| 动态DOM跟踪 | MutationObserver推送延迟 <100ms |
| 测试覆盖率 | 语义提取 100%，动作执行 90%+ |
| Agent集成体验 | 1行连接WebSocket，3行拿到语义树 |

---

*AI Browser 不是浏览器的替代品。它是浏览器的另一半——那个从来没人做的部分。*
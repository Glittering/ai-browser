# AI Browser — 技术规格 v1.0

## 技术栈

| 组件 | 选择 | 理由 |
|------|------|------|
| 浏览器内核 | Electron 33 (Chromium 130+) | preload直接访问DOM，ipcMain/renderer零序列化 |
| 运行时 | Node.js 22+ | Electron自带 |
| WebSocket | ws (npm) | 轻量，JSON-RPC传输 |
| 测试框架 | Vitest + Playwright | 单元(Electron mock) + 集成(真实BrowserWindow) |
| 打包 | electron-builder | 未来分发用（1.0不打包） |
| 语言 | JavaScript (ESM) | Electron原生语言，无编译层 |

## 依赖

```json
{
  "name": "ai-browser",
  "version": "0.1.0",
  "main": "src/main/index.js",
  "dependencies": {
    "electron": "^33.0.0",
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "playwright": "^1.45.0",
    "@playwright/test": "^1.45.0"
  }
}
```

## 模块详解

### 1. main/index.js — Electron入口

```
创建 BrowserWindow({
  width: 1280,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, '../preload/bridge.js'),
    contextIsolation: true,   // 安全：preload不能直接访问main
    nodeIntegration: false    // 渲染进程无Node权限
  }
})

启动 WebSocket server (端口 9223)
→ 管理 PageManager
```

### 2. main/ws_server.js — WebSocket JSON-RPC Server

```
ws://localhost:9223

消息格式：
→ {"id": 1, "method": "ui.get_tree", "params": {}}
← {"id": 1, "result": {...}}

→ {"id": 2, "method": "ui.act", "params": {"action": "click", "target": "e:btn-42"}}
← {"id": 2, "result": {"success": true, "diff": [...]}}

→ {"method": "ui.subscribe", "params": {"events": ["focus", "dom_change"]}}
← {"event": "dom_change", "changes": [...]}  （无id，推送）

支持的方法：
- ui.get_tree(focused_only?)
- ui.act(action, target, params)
- ui.subscribe(events[])
- ui.unsubscribe(subscription_id)
- ui.navigate(url)
- ui.screenshot(region?)  // 降级用
- ui.get_focused()
- ui.evaluate(js_code)   // 危险权限，可选关闭
```

### 3. main/page_manager.js — 页面生命周期

```
- navigate(url) → BrowserWindow.loadURL(url)
- 页面加载完成 → 通知 preload 启动 Semantic Extractor
- 管理多个 page 实例（1.0 只有一个）
- 处理 IPC：preload → main → ws_server → Agent
```

### 4. preload/bridge.js — IPC桥梁

```
contextBridge.exposeInMainWorld('__ai_browser__', {
  // 渲染进程 → main 进程
  sendTree: (tree) => ipcRenderer.send('ai:tree', tree),
  sendDiff: (changes) => ipcRenderer.send('ai:diff', changes),
  sendEvent: (event) => ipcRenderer.send('ai:event', event),

  // 接收 main 进程指令
  onAction: (callback) => ipcRenderer.on('ai:action', callback),
  onExtract: (callback) => ipcRenderer.on('ai:extract', callback)
})
```

### 5. preload/semantic_extractor.js — DOM → SemanticUITree

核心算法：

```
extractTree() {
  1. 从 document.body 开始遍历
  2. 跳过不可见元素 (display:none, visibility:hidden, aria-hidden)
  3. 跳过纯布局容器 (<div>, <span> 无 role/onclick/语义)
  4. 对每个语义节点：
     - 分配唯一id (e:<tag>-<counter>)
     - 判定role:
       基于 tagName (<button>/<a>/<input>/<select>/<textarea>)
       + ARIA role 属性
       + 事件监听器推断 (<div onclick> → button)
     - 提取label:
       优先 aria-label → title → textContent截断(前60字符)
     - 提取states:
       disabled, readonly, checked, focused, visible
     - actions:
       button → click, focus, hover
       textbox → type, clear, focus
       select → select, focus
       slider → scroll_to (模拟调节)
     - bounds:
       getBoundingClientRect()
     - attributes:
       data-* + aria-* + name/id/class
  5. 返回 root UIElement + children树
}
```

### 6. preload/action_binder.js — 动作执行

```
executeAction(elementId, action, params) {
  1. 通过 id → document.querySelector(`[data-ai-id="${elementId}"]`)
     或者维护 id→element 的 WeakMap
  2. 验证action对该element合法
  3. 执行：
     click → el.click() (原生，触发React合成事件)
     dblclick → el.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))
     type → el.value = params.text; el.dispatchEvent(new Event('input', {bubbles:true}))
            + el.dispatchEvent(new Event('change', {bubbles:true}))
            // React controlled input 关键：先设value，再触发input+change
     clear → el.value = ''; dispatchEvent('input') + dispatchEvent('change')
     select → el.value = params.value; dispatchEvent('input') + dispatchEvent('change')
     focus → el.focus()
     hover → el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}))
     scroll_to → el.scrollIntoView({behavior:'instant',block:'center'})
  4. 返回 {success: true/false, error?: string}
}
```

React兼容性关键：
- 不用模拟键盘逐键输入——直接设 `value` + 触发 `input` + `change` 事件
- React的onChange/onInput是通过合成事件系统监听的，`dispatchEvent` 可触发
- 对受控组件（value由React state控制），还需额外触发 `ReactPortal` 更新路径

### 7. preload/state_tracker.js — MutationObserver推送

```
startTracking() {
  observer = new MutationObserver(mutations => {
    changes = []
    for each mutation:
      if addedNodes → chidren_added
      if removedNodes → children_removed
      if attribute changed (disabled/checked/value/aria-*) → state_changed
      if characterData changed → text_changed
    
    去重 → 合并 → 推送 via bridge.sendDiff(changes)
  })
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'checked', 'readonly', 'value', 'aria-expanded', 'aria-selected', 'hidden'],
    characterData: true,
    characterDataOldValue: false
  })
  
  // 额外：focus/blur 通过 document.addEventListener 追踪
}
```

### 8. shared/protocol.js — 消息格式

```js
// JSON-RPC 2.0 子集
export function createRequest(id, method, params) {
  return JSON.stringify({ id, method, params })
}

export function createResponse(id, result) {
  return JSON.stringify({ id, result })
}

export function createError(id, code, message) {
  return JSON.stringify({ id, error: { code, message } })
}

export function createEvent(event, data) {
  return JSON.stringify({ event, data })
}
```

## 关键设计决策

### 为什么 contextIsolation + preload，而不是 nodeIntegration？

- 安全：渲染进程不能直接访问Node/文件系统
- preload是唯一桥梁，通过contextBridge暴露有限API
- Agent能控制网页但不能逃逸浏览器沙箱

### 为什么 WeakMap 存 element→id 映射？

- DOM元素被删除时，WeakMap自动清理，不用手动GC
- 每次 extractTree 时 refresh 映射

### 为什么不用 CDP / DevTools Protocol？

- CDP序列化DOM→JSON开销巨大（5000节点页面可能10MB+）
- 动作通过CDP转坐标→转locator，路径长且不可靠
- preload直接在渲染进程读DOM——0序列化，0延迟

---

*规格是活的——开发过程中根据DOM行为调整。React controlled input兼容性是MVP最大风险点。*
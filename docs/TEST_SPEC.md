# AI Browser — 测试规范 v1.0

## 测试哲学

> 测试先行。测试即需求文档。先写测试→源码让测试绿。

## 测试层级

```
        ┌──────────┐
        │ 集成测试  │  15% — test_integration.js（真实Electron BrowserWindow + Agent全链路）
        ├──────────┤
        │ 模块测试  │  35% — test_semantic_extractor.js, test_action_binder.js, test_state_tracker.js
        ├──────────┤
        │ 协议测试  │  20% — test_ws_protocol.js（JSON-RPC格式 + WS连接）
        ├──────────┤
        │ 单元测试  │  30% — 纯函数逻辑（role判定、label提取、消息格式化）
        └──────────┘
```

## 测试页面

`tests/test_pages/` 下四个HTML：

### basic_controls.html（20个用例依赖此页）
所有原生HTML控件：button×4, textbox×3, checkbox×2, radio×2, select, slider, table, 隐藏元素×3, 纯布局wrapper×2, 动态插入区

### react_spa.html（10个用例）
最小React应用（CDN加载）：controlled input, 按钮onClick, 条件渲染（toggle显示/隐藏）, 列表动态追加

### dynamic_content.html（8个用例）
纯JS操作DOM：setTimeout插入元素, 异步fetch后渲染, dialog.showModal, aria-expanded toggle, MutationObserver验证

## 测试用例详解

### test_semantic_extractor.js

| ID | 描述 | 页面 | 断言 |
|----|------|------|------|
| SE-001 | extractTree()返回非空root | basic | root != null, root.role存在 |
| SE-002 | button计数≥4 | basic | buttons.length ≥ 4 |
| SE-003 | textbox计数≥3 | basic | textboxes.length ≥ 3 |
| SE-004 | disabled button状态正确 | basic | disabled按钮 states含"disabled" |
| SE-005 | 隐藏元素不出现在tree中 | basic | 不可见button不出现 |
| SE-006 | label提取：aria-label优先 | basic | aria-label="搜索" 的input label为"搜索" |
| SE-007 | label提取：title回退 | basic | 无aria-label的button用title |
| SE-008 | label提取：textContent截断 | basic | label长度≤60 |
| SE-009 | bounds正确（getBoundingClientRect） | basic | button.bounds含{x,y,w,h}，w>0,h>0 |
| SE-010 | 纯布局wrapper被去噪 | basic | 无语义<div>不出现 |
| SE-011 | data-*属性保留 | basic | attributes含data-testid |
| SE-012 | id稳定性 | basic | 两次extractTree相同元素id一致 |
| SE-013 | ARIA role覆盖tagName | basic | <div role="button">被识别为button |
| SE-014 | focus元素标记 | basic | focused_element_id非null（如果某元素focus了） |
| SE-015 | React SPA中动态渲染元素出现 | react_spa | 条件渲染toggle后新button出现 |
| SE-016 | React controlled input的value反映 | react_spa | input的value字段非空 |
| SE-017 | 嵌套iframe不导致崩溃 | basic | 不抛异常 |
| SE-018 | 空页面不崩溃 | 空白页 | root非null，children=[] |
| SE-019 | fragment/Shadow DOM元素穿透 | basic | 自定义元素内部交互项被提取 |
| SE-020 | tree大小合理（不过度膨胀） | basic | total nodes < 500（不能把所有<div>都列出来） |

### test_action_binder.js

| ID | 描述 | 页面 | 断言 |
|----|------|------|------|
| AB-001 | click button触发原生click事件 | basic | button.click()被调用 → 计数器+1 |
| AB-002 | click button触发React onClick | react_spa | React state变更（textContent改变） |
| AB-003 | type设置input值并触发input事件 | basic | input.value == "test", input事件触发 |
| AB-004 | type设置React controlled input | react_spa | React state同步更新 |
| AB-005 | type后触发change事件 | basic | change事件监听器被调用 |
| AB-006 | select选择option | basic | select.value变化 |
| AB-007 | focus让元素获得焦点 | basic | document.activeElement == target |
| AB-008 | clear清空input | basic | input.value == "" |
| AB-009 | 不存在的elementId返回error | basic | success=false, error非空 |
| AB-010 | 对不可type元素执行type返回error | basic | 对button type → error |
| AB-011 | scroll_to让元素进入视口 | basic | 元素不可见→scroll后可见 |
| AB-012 | 重复click不抛异常 | basic | 连续3次click均success |

### test_state_tracker.js

| ID | 描述 | 页面 | 断言 |
|----|------|------|------|
| ST-001 | DOM插入子节点 → diff推送 | dynamic | children_added事件触发 |
| ST-002 | DOM删除子节点 → diff推送 | dynamic | children_removed事件触发 |
| ST-003 | 属性变更 → diff推送 | dynamic | 按钮disabled切换 → state_changed |
| ST-004 | textContent变更 → diff推送 | dynamic | text_changed事件触发 |
| ST-005 | 去重：同一帧内多次变更合并 | dynamic | 连续3次插入→1条diff（合并） |
| ST-006 | focus事件推送 | dynamic | 点击input→focus事件触发 |
| ST-007 | dialog打开推送 | dynamic | dialog.showModal→dialog_open事件 |
| ST-008 | 无需观察的属性不触发diff | dynamic | 修改style.color不触发diff |
| ST-009 | 关闭observer后事件停止 | dynamic | disconnect后不再推送 |
| ST-010 | 大量变更不丢事件 | dynamic | 一次插入50个节点→全部track |

### test_ws_protocol.js

| ID | 描述 | 断言 |
|----|------|------|
| WS-001 | WS连接成功 | client连接到 ws://localhost:9223 |
| WS-002 | get_tree返回合法JSON | result.tree非null |
| WS-003 | get_tree的id回传正确 | response.id == request.id |
| WS-004 | act返回success+diff | result.success==true, diff非空 |
| WS-005 | act失败返回error | 错误target → result.error非空 |
| WS-006 | subscribe接收推送 | subscribe后收到event消息 |
| WS-007 | unsubscribe停止推送 | unsubscribe后不再收到event |
| WS-008 | navigate切换URL | 页面URL改变 + tree更新 |
| WS-009 | 并发请求不互相干扰 | 同时发3个不同id的请求→各自正确响应 |
| WS-010 | 错误method返回JSON-RPC error | method="ui.invalid" → error.code=-32601 |

### test_integration.js（真实端到端）

| ID | 描述 | 目标页面 | 断言 |
|----|------|---------|------|
| I-001 | Electron启动+WS连接+get_tree | basic_controls | 全链路通 |
| I-002 | Agent调act click → 页面响应 | basic | 按钮文本变化 |
| I-003 | React SPA 条件渲染 → tree自动更新 | react_spa | toggle后新button出现 |
| I-004 | React controlled input type → state同步 | react_spa | React显示值变化 |
| I-005 | 真实网站人民网 get_tree | people.com.cn | >50个元素，含button+text+textbox |
| I-006 | 任意复杂SPA不崩溃 | 至少2个现代站点 | 无crash，tree_size>20 |

## 运行命令

```bash
# 单元+模块 (不需要Electron，mock DOM)
npx vitest run tests/test_semantic_extractor.js tests/test_state_tracker.js

# 协议测试 (需要WS server启动)
npx vitest run tests/test_ws_protocol.js

# 集成测试 (需要完整Electron)
npx vitest run tests/test_integration.js

# 全量
npx vitest run
```

## 测试先行规则

1. **测试文件在源码之前创建**
2. **首次运行必须FAIL**（源码不存在/函数未实现）
3. **一次只让一个测试红→绿**
4. **测试用mock DOM（jsdom）不依赖真实浏览器**（模块测试部分）
5. **集成测试可skip**（CI无显示器时 Electron无法启动）

---

*测试不是附加品。测试是产品定义。*
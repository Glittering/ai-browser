# 从 1.x 升级到 2.0

2.0 只有一个破坏性变更：**标签页的四个工具合并成一个**。其余全部兼容，
raw WebSocket 层的 `ui.*` 方法一个都没动。

## 变了什么

| 1.x | 2.0 |
|---|---|
| `browse_list_tabs {}` | `browse_tabs {op:"list"}` |
| `browse_new_tab {url}` | `browse_tabs {op:"new", url}` |
| `browse_close_tab {tab}` | `browse_tabs {op:"close", tab}` |
| `browse_set_active_tab {tab}` | `browse_tabs {op:"switch", tab}` |

## 为什么

四个工具操作的是同一个实体（标签页），每个只承载一个动词。这是工具数量膨胀里
最没有道理的一种：agent 每轮都要读四条几乎相同的 schema，才能在脑子里拼出
"原来可以用这几个管标签"。

合并后顶层参数 101 → 71，工具数 20 → 17。

## 迁移

如果你的提示词 / 脚本里搜得到 `browse_list_tabs`、`browse_new_tab`、
`browse_close_tab`、`browse_set_active_tab`，按上表替换即可。都是机械替换。

MCP 客户端在启动时重新拉取工具列表，所以升级后**新会话自动生效**，不需要改配置。

## 已知的语义代价

`browse_close_tab` 原来是 `destructiveHint: true`。合并后整个 `browse_tabs`
只能标 `false`（否则 `op:"list"` 也会被客户端渲染成危险操作）。关闭标签页的
破坏性现在写在 description 里，而不是 annotation 里。

这是合并唯一的代价，记在这里，别当成疏漏。

## 没有变的

- 所有 `ui.*` WS 方法（`ui.list_tabs` / `ui.new_tab` / `ui.close_tab` /
  `ui.set_active_tab` / `ui.scroll` / `ui.repaint` …）保持原样
- `browse_act` / `browse_network` 的参数分组同时接受**旧的扁平写法**，
  1.x 的调用可以原样跑（见 `src/main/mcp_args.js`）
- `browse_scroll`、`browse_capabilities`、`browse_repaint` 都还在

## 为什么没顺手删掉更多

- **`browse_repaint` 保留**：它 400 字节，但删掉并不修掉渲染 bug，只会拿掉
  agent 唯一的恢复手段。用稳定性换 100 token 不划算。
- **`browse_scroll` 保留**：塞进 `browse_act` 会让工具表面泄露实现细节（它走的是
  `ui.scroll` 而不是 `ui.act`），为 536 字节制造不一致不值得。
- **`browse_capabilities` 保留**：把它折进 `get_tree` 意味着每次读树都要跑一遍
  能力探测，那是把成本从低频挪到高频。

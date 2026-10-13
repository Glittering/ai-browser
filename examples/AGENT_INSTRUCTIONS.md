# AI Browser — Agent Instructions

把下面**任意一节**里的代码块整段复制，粘贴进你的 agent 的 memory / instructions / system prompt
（Claude Code 的 `CLAUDE.md`、Cursor Rules、Codex `AGENTS.md`、或任意 MCP 客户端的自定义指令）。
不需要改任何东西——浏览器由 agent 自己在第一次调用时拉起。

* [中文版](#中文版copy-paste) · [English](#english-copy-paste)
* [配置 MCP 服务器](#配置-mcp-服务器) · [参数速查](#参数速查) · [人工介入到底是怎么发生的](#人工介入到底是怎么发生的)

> 配套文件：`mcp-config.json`（客户端配置）、`raw-ws.mjs`（不用 MCP 的最小例子）、
> `read-page.mjs`（读一页并列出可交互元素）、`with-human.mjs`（需要人介入时的完整流程）。

---

## 中文版（copy-paste）

```text
我可以用 AI Browser 浏览网页。它提供 MCP 服务（17 个 browse_* 工具），第一次调用时会自动
拉起一个真实可见的浏览器窗口，用完调用 browse_quit 释放。页面以结构化语义树返回，不是截图。

标准循环：
1. browse_navigate { url }                 打开页面
2. browse_get_tree                         读页面，返回语义树：每个节点有 role / label / value /
                                           states / actions
3. browse_act { action, target }           操作元素，target 填第 2 步节点里的 id（即 data-ai-id）
                                           action 可选：click / type（光标处追加）/ setContent
                                           （整体替换）/ clear / focus / hover / scroll_to /
                                           upload / get_value（只读回读全文）/ drag / press / wheel
4. browse_wait { condition }               等待条件成立：button_enabled / modal_appeared /
                                           text_contains / url_contains
5. browse_evaluate { js }                  在页面上下文跑 JS 表达式（上限 5000 字符，
                                           禁用 process. / require / child_process）

省 token（browse_get_tree 参数）：
- { "subset": "interactive" }  只保留可交互节点，砍掉纯布局分支 —— 默认就该带上
- { "ax": true }               走 AX 语义层，链接会带 url
- { "mode": "diff" }           只看上次读取以来新增 / 消失的可交互节点

验证写操作（success 不等于做成了）：browse_diff 先 snapshot 基线，写操作之后再 diff，
verdict 显式给出 changed / unchanged。

其他：browse_scroll 滚动文档（画布类页面用 browse_act 的 wheel）；browse_list_tabs /
browse_new_tab / browse_close_tab / browse_set_active_tab 管标签页；browse_network 拉取网络
请求（含 POST body，免订阅）；browse_capabilities 一次探明页面该走哪条路（结构化数据 /
语义树 / 指针手势）；browse_canvas 读 canvas 绘制调用里的文本（不是 OCR）；
browse_downloads 查下载文件落盘路径；browse_repaint 在窗口画面陈旧时强制重绘。

需要人帮忙时（登录、扫码、短信验证码、滑块 / 人机验证，以及任何我做不了的操作）：
浏览器窗口是真实可见的，人随时可以用鼠标键盘操作。我应该在对话里直接说一句人话请用户去窗口里
完成，例如"请在浏览器窗口里扫码登录，完成后回复我'好了'"，然后停下来等用户回复；收到"好了"之后
重新 browse_get_tree 确认状态再继续。不要编造登录凭据，也不要反复重试那些注定失败的点击。
浏览器侧没有任何"交接"接口，也不需要——人机协作就发生在我们的对话里。

收尾：任务完成后调用 browse_quit（会关闭整个浏览器窗口和进程，释放资源）。
```

## English (copy-paste)

```text
I can browse the web with AI Browser. It exposes an MCP server (17 browse_* tools), auto-starts a
real, visible browser window on my first call, and I release it with browse_quit when done. Pages come
back as a structured semantic tree — no screenshots, no OCR.

Standard loop:
1. browse_navigate { url }                 load a page
2. browse_get_tree                         read the page: nodes carry role / label / value / states /
                                           actions
3. browse_act { action, target }           act on an element; target is the node's id (its data-ai-id)
                                           action: click / type (append at caret) / setContent
                                           (replace all) / clear / focus / hover / scroll_to /
                                           upload / get_value (read-only) / drag / press / wheel
4. browse_wait { condition }               block until: button_enabled / modal_appeared /
                                           text_contains / url_contains
5. browse_evaluate { js }                  run a JS expression in page context (5000-char cap;
                                           process. / require / child_process are rejected)

Saving tokens (browse_get_tree params):
- { "subset": "interactive" }   drop layout-only branches — use this by default
- { "ax": true }                AX semantic layer; links carry url
- { "mode": "diff" }            only interactive nodes added/hidden since my last read

Verifying writes (success is not evidence): browse_diff snapshots a baseline, then diffs after the
write and returns an explicit verdict of changed / unchanged.

Also: browse_scroll (document scrolling; use the wheel action on canvas apps); browse_list_tabs /
browse_new_tab / browse_close_tab / browse_set_active_tab for tabs; browse_network for captured
requests including POST bodies (no subscription); browse_capabilities to pick a route on an
unfamiliar page (structured data / semantic tree / pointer gestures); browse_canvas reads text
straight from canvas draw calls (no OCR); browse_downloads for on-disk download paths;
browse_repaint when the window shows a stale page.

When I need a human (login, QR code, SMS code, slider/CAPTCHA, or anything I genuinely cannot do):
the browser window is real and visible — the user can just use their mouse and keyboard in it. I should
say so plainly in the conversation (e.g. "please scan the QR code in the browser window and reply
'done'"), then stop and wait for that reply. After "done", I re-read with browse_get_tree and continue.
I never invent credentials or loop on clicks that cannot work. There is no hand-off API on the browser
side, and none is needed — the collaboration happens right here in our conversation.

Wrap up: call browse_quit when the task is finished (it closes the window and exits the process).
```

---

## 配置 MCP 服务器

把下面配置复制到你的客户端配置文件里（Claude Desktop `claude_desktop_config.json`、
项目根目录 `.mcp.json`、Cursor `~/.cursor/mcp.json`、Codex 等）。npm 包方式无需任何本地路径：

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "npx",
      "args": ["-y", "@glittering0717/ai-browser", "mcp"]
    }
  }
}
```

从源码运行时改用 `"command": "node"`，args 指向
`/你的/绝对路径/ai-browser/src/main/mcp_server.js`（必须是绝对路径）。

* 首次启动会准备 Electron 引擎（约 100 MB，仅一次）；网络慢可在客户端的环境变量里设
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
* 无需事先启动浏览器：MCP 服务器会探测 `9223` 端口，没人在监听就自己 spawn Electron（最多等 30 秒）。
* 想常驻浏览器也可以：在项目根目录跑 `npm start`，之后所有客户端共用这一个窗口。
* 不装 MCP 也能用：原始 WebSocket JSON-RPC 在 `ws://localhost:9223`，见 `raw-ws.mjs`。

---

## 参数速查

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `browse_navigate` | `url`, `tab?` | 打开 URL |
| `browse_get_tree` | `subset`, `ax`, `mode`, `focused_only`, `tab` | 读语义树 + `context`（弹窗、必填提示、toast、登录态、统计） |
| `browse_act` | `action`, `target`, `text?`, `value?`, `url?`, `keep_tab?`, `file?`, `tab?` | `target` = 节点 `id`（`data-ai-id`） |
| `browse_evaluate` | `js`, `tab?` | 表达式（非语句），5000 字符上限 |
| `browse_scroll` | `direction`, `amount`, `target`, `tab` | 滚页面或滚到某元素 |
| `browse_wait` | `condition`, `target?`, `text?`, `timeout_ms?` | 轮询直到成立或超时 |
| `browse_diff` | `operation` (`snapshot`/`diff`), `js?`, `snapshot?`, `rearm?`, `forget?` | 快照基线 + 比对，证明写操作真的生效 |
| `browse_capabilities` | `include_network?`, `network_limit?` | 探明页面路线：L1 结构化数据 / L2 语义树 / L3 指针手势 |
| `browse_network` | `operation` (`list`/`get`/`clear`/`configure`), `method?`, `url_contains?`, `status_min/max?` | 网络请求检查，含 POST body，默认免订阅 |
| `browse_canvas` | `operation` (`list`/`read`/`configure`/`capture`), `canvas_id?` | 读 canvas 绘制调用文本；WebGL 才用 `capture` |
| `browse_downloads` | — | 查下载项与落盘路径（下载异步，点完后轮询） |
| `browse_repaint` | — | 窗口画面陈旧时强制合成器重绘，返回 `repaint_count` |
| `browse_list_tabs` / `browse_new_tab` / `browse_close_tab` / `browse_set_active_tab` | `tab?`, `url?` | 标签页管理 |
| `browse_quit` | — | 关闭窗口并退出进程 |

> 实时事件订阅（`dom_change` / `network_response` / `js_error` 等）只在原始 WebSocket 层
> 提供（`ui.subscribe`），MCP stdio 不支持 server→client 通知，所以没有 `browse_subscribe`；
> 拉取式的检查一律用 `browse_network`。

---

## 人工介入到底是怎么发生的

这是本项目最容易被误解的一点，说清楚：

1. 浏览器窗口**真实可见**，人随时可以用鼠标键盘操作它——登录、扫码、滑块验证码都行。
2. agent 做不了的事，**在对话里说一句人话请求用户去做**，然后停下来等回复。
3. 用户做完回一句"好了"，agent 重新 `browse_get_tree` 确认状态，继续往下走。
4. **浏览器侧没有任何"交接"接口，也不需要。** 交接是一个对话协议，不是一个 API。
   脚本版的等价实现见 `with-human.mjs`：它只是 `readline` 打印一句提示 + 等回车，
   浏览器对此毫不知情。
5. 登录态存在 `persist:` partition 里，重启浏览器也还在，通常只需人工介入一次。

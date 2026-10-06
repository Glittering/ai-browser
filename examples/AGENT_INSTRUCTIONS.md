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
我可以用 AI Browser 浏览网页。它提供 MCP 服务（13 个 browse_* 工具），第一次调用时会自动
拉起一个真实可见的浏览器窗口，用完调用 browse_quit 释放。页面以结构化语义树返回，不是截图。

标准循环：
1. browse_navigate { url }                 打开页面
2. browse_get_tree                         读页面，返回语义树：每个节点有 role / label / value /
                                           states / actions
3. browse_act { action, target }           操作元素，target 填第 2 步节点里的 id（即 data-ai-id）
                                           action 可选：click / type / clear / focus / hover /
                                           scroll_to / upload
4. browse_wait { condition }               等待条件成立：button_enabled / modal_appeared /
                                           text_contains / url_contains
5. browse_evaluate { js }                  在页面上下文跑 JS 表达式（上限 5000 字符，
                                           禁用 process. / require / child_process）

省 token（browse_get_tree 参数）：
- { "subset": "interactive" }  只保留可交互节点，砍掉纯布局分支 —— 默认就该带上
- { "ax": true }               走 AX 语义层，链接会带 url
- { "mode": "diff" }           只看上次读取以来新增 / 消失的可交互节点

其他：browse_scroll 滚动；browse_list_tabs / browse_new_tab / browse_close_tab /
browse_set_active_tab 管标签页；browse_subscribe 订阅 dom_change / network_response /
captcha_appeared / message_appeared / js_error / state_changed；browse_network_body 取某个
请求的响应体（需先 subscribe）。

需要人帮忙时（登录、扫码、短信验证码、滑块 / 人机验证，以及任何我做不了的操作）：
浏览器窗口是真实可见的，人随时可以用鼠标键盘操作。我应该在对话里直接说一句人话请用户去窗口里
完成，例如"请在浏览器窗口里扫码登录，完成后回复我'好了'"，然后停下来等用户回复；收到"好了"之后
重新 browse_get_tree 确认状态再继续。不要编造登录凭据，也不要反复重试那些注定失败的点击。
浏览器侧没有任何"交接"接口，也不需要——人机协作就发生在我们的对话里。

收尾：任务完成后调用 browse_quit（会关闭整个浏览器窗口和进程，释放资源）。
```

## English (copy-paste)

```text
I can browse the web with AI Browser. It exposes an MCP server (13 browse_* tools), auto-starts a
real, visible browser window on my first call, and I release it with browse_quit when done. Pages come
back as a structured semantic tree — no screenshots, no OCR.

Standard loop:
1. browse_navigate { url }                 load a page
2. browse_get_tree                         read the page: nodes carry role / label / value / states /
                                           actions
3. browse_act { action, target }           act on an element; target is the node's id (its data-ai-id)
                                           action: click / type / clear / focus / hover / scroll_to /
                                           upload
4. browse_wait { condition }               block until: button_enabled / modal_appeared /
                                           text_contains / url_contains
5. browse_evaluate { js }                  run a JS expression in page context (5000-char cap;
                                           process. / require / child_process are rejected)

Saving tokens (browse_get_tree params):
- { "subset": "interactive" }   drop layout-only branches — use this by default
- { "ax": true }                AX semantic layer; links carry url
- { "mode": "diff" }            only interactive nodes added/hidden since my last read

Also: browse_scroll; browse_list_tabs / browse_new_tab / browse_close_tab / browse_set_active_tab for
tabs; browse_subscribe for dom_change / network_response / captcha_appeared / message_appeared /
js_error / state_changed; browse_network_body to fetch a response body (subscribe first).

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

复制 `mcp-config.json` 到你的客户端配置文件里（Claude Desktop `claude_desktop_config.json`、
项目根目录 `.mcp.json`、Cursor `~/.cursor/mcp.json`、Codex 等），**把占位符换成你本机的绝对路径**：

```jsonc
{
  "mcpServers": {
    "ai-browser": {
      "command": "node",
      // ↓ 改成你的实际路径，必须是绝对路径
      "args": ["/ABSOLUTE/PATH/TO/ai-browser/src/main/mcp_server.js"]
    }
  }
}
```

例如 `/Users/me/code/ai-browser/src/main/mcp_server.js`。

* 路径必须是绝对路径：MCP 客户端的工作目录不一定是项目根目录。
* 无需事先 `npm start`：MCP 服务器会探测 `9223` 端口，没人在监听就自己 spawn Electron（最多等 30 秒）。
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
| `browse_list_tabs` / `browse_new_tab` / `browse_close_tab` / `browse_set_active_tab` | `tab?`, `url?` | 标签页管理 |
| `browse_network_body` | `url_pattern`, `tab?` | 取响应体（先 `browse_subscribe` 订阅 `network_response`） |
| `browse_subscribe` | `events[]` | `dom_change` / `network_response` / `captcha_appeared` / `message_appeared` / `js_error` / `state_changed`，`"*"` 订阅全部 |
| `browse_quit` | — | 关闭窗口并退出进程 |

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

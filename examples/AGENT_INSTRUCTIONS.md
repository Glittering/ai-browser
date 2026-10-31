# AI Browser — agent 接入

## 先别贴这份文件

```bash
npx -y @glittering0717/ai-browser skill install
```

装一次，之后**每次新会话客户端会自动发现**这些技能，不需要你在对话里重新教一遍、也不用把
下面任何内容粘进 system prompt：

| 技能 | 干什么 |
|---|---|
| `ai-browser` | 最小循环、卡住时的第一反应、难搞页面的处理 |
| `content-publish` | 把文章发布到 CSDN / 知乎 / 掘金 |
| `read-webpage` | 读一篇文章正文并总结 |
| `web-network-monitor` | 长时间盯某个页面的请求 |

不装技能也能用——20 个 `browse_*` 工具的 schema 本身自带说明。技能只是把"怎么组合"讲清楚。

---

## 兜底：客户端不支持技能时

把下面这段贴进 `CLAUDE.md` / `AGENTS.md` / 自定义指令。**只需要这几行**，其余按需查技能里的
`references/`。

```text
我可以用 ai-browser 操作一个真实可见的浏览器（MCP: browse_* 工具）。

循环：browse_navigate {url} → browse_get_tree {subset:"interactive"} 取节点 id →
      browse_act {action:"click"|"type", target:id, text?}

success:true 只代表动作发出去了，不代表页面变了。要证明生效：browse_diff 先 snapshot、
操作后 diff，看 verdict。unchanged 说明要么点错了、要么页面没响应，别接着瞎点。

卡住时的顺序：节点没有 → browse_wait 再重读树；有节点但操作失败 → 动作层问题（iframe /
canvas / 富文本），换动作不是换选择器；点了没反应 → browse_screenshot 看视觉 或
browse_network 看请求；怀疑掉登录 → browse_auth_state；都不是 → browse_errors。

需要人（登录/扫码/滑块/支付）：**在你这轮回复里直接说一句**，请用户在窗口里操作，然后结束这轮等
回话；收到"好了"再 browse_get_tree 确认。这一步不需要任何工具——本项目没有 chat / message /
ask_user 这类工具，也没有"发起一次性会话"，别去调宿主的临时对话能力。不要编造凭据，不要重试
注定失败的点击。窗口是真的，人随时能抢鼠标。

收尾：browse_quit 关掉窗口和进程（人正在操作时不要调）。
```

---

## 详细内容在哪

按需读，不要一次读完：

| 想知道 | 读 |
|---|---|
| 失败排查顺序、四条别做、省 token 的读树参数 | `skills/ai-browser/references/troubleshooting.md` |
| canvas / 富文本 / 跨进程 iframe / 上传 | `skills/ai-browser/references/hard-pages.md` |
| 抓请求、从页面取结构化数据 | `skills/ai-browser/references/network.md` |
| 登录、表单、多标签、证明生效 | `skills/ai-browser/references/tasks.md` |
| 全部参数 | 工具的 `inputSchema`（每轮都在，不用另读） |

## 配置 MCP 服务器

见 `examples/mcp-config.json`，或：

```json
{ "mcpServers": { "ai-browser": {
  "command": "npx", "args": ["-y", "@glittering0717/ai-browser", "mcp"]
} } }
```

浏览器由 agent 在第一次调用时自己拉起，不需要你手动开。

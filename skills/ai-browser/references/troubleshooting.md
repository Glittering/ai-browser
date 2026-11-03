# 失败排查顺序

按这个顺序走，**别一上来就写站点专用选择器**。绝大多数"点不动"不是选择器问题。

1. **重读树，或先 wait。** SPA 常常只是还没渲染完。`browse_wait {condition:"text_contains"}` 或
   `browse_get_tree {mode:"diff"}` 看有没有新增节点。
2. **节点在树里但操作失败 → 动作层问题。** 跨进程 iframe、canvas、需要受信输入、上传控件未挂载。
   写选择器解决不了——换动作（`press` / `wheel` / `drag`）或换目标才是解法。
3. **树里没有、页面上明明有 → 读层缺口。** 这是浏览器该修的东西，不是你的脚本该绕的。
   先跑 `tools/coverage_probe.cjs <url>` 量化覆盖率，再决定是否绕过。
4. **以上都不成立**，才在自己脚本里用选择器兜底。别把"某个站点的选择器"记成通用知识。

## 四条别做

- **别把 `success: true` 当成功。** 要证明页面变了：act 前后各 `browse_diff`，看 `verdict`。
- **别用截图当读页面的主要手段。** 截图只用来判断"视觉上怎么了"（浮层、遮挡、渲染错位），
  读内容一律走语义树。
- **别在登录态失效时继续点。** 先 `browse_auth_state`，`auth_wall.detected=true` 就停下来找用户。
- **别在用户正操作窗口时 `browse_quit`。** 它会关掉整个窗口和进程。

## 回执说"没送达"（`input_blocked`）

`browse_act` 回 `success:false` + `input_blocked:true` 时，**事件一发都没投**，那一页什么都没发生。
这不是"点了没反应"（那种是页面自己的事，`page_changed:false` 才轮得到它），而是浏览器知道这一页
收不到模拟输入 —— Chromium 会丢弃发往 `visibilityState:hidden` 文档的键鼠事件，而补救之后仍然收不到
（通常是你设了 `AI_BROWSER_INPUT_FOCUS=0` 或 `AI_BROWSER_FOCUS=never`）。

**照着 success 的经验再点一次，就会把一次点击变成两次。** 三条出路按代价排：
① 改走 JS 路径（`browse_evaluate` 直接改值 / 派发合成事件 —— 富文本框架可能不认）；
② `browse_tabs {"op":"window","visible":true}` 把窗口显示出来**一次**，此后每一页都一路收得到；
③ 去掉那两个 env，让浏览器自己补给那一页一发焦点伪造（默认就是这条，不动 z 序也不抢你的鼠标）。

## 读树的省 token 参数

| 参数 | 作用 |
|---|---|
| `subset: "interactive"` | 只留可交互节点，砍掉纯布局分支（默认就该带） |
| `mode: "diff"` | 只看自上次读取以来新增/消失的交互节点 |
| `ax: true` | 走 AX 语义层，链接会带 `url`（iframe 内容也更全） |
| `focused_only: true` | 只看焦点子树 |

树里 `value` 超过 200 字符会被截断。要全文用
`browse_act {action:"get_value", target, offset, limit}` —— 只读，不聚焦、不触发 input 事件。

# 内容包：Canvas 杀手场景（CONTENT_CANVAS_DEMO）

> 这不是策略文档，是**可以直接发的内容**。所有证据都是 2026-10-19 用 ai-browser 真实跑出来的。
> 核心叙事一句话：**AI 在一个纯 Canvas 白板上写了字，然后不截图、不 OCR，把它写的字原样读了出来——一行 JSON，连字体和坐标都带着。**

---

## 一、为什么这个场景是"杀手级"（内部理解，写稿时不这么直白说）

对普通人：`"AI 能看懂画板上的画"` 听起来像又一个 AI 功能。
对开发者：**这个场景里，截图方案是全瞎的**——canvas 上没有任何 DOM，Playwright 的 accessibility tree 是空的，视觉模型要花视觉 token 还猜不准坐标。而 ai-browser 拿到的是绘制调用层的原始字符串。

| 方案 | 在这个场景里拿到什么 |
|---|---|
| 截图 + 视觉模型 | 一张图，OCR 猜文字，不知道字体/坐标，花视觉 token |
| Playwright / accessibility tree | **什么都没有**（canvas 无 DOM 节点） |
| ai-browser（绘制层捕获） | `{"text":"AI Browser wrote this - no screenshot, no OCR","font":"20px Excalifont...","at":{"x":10,"y":13.2,"width":937.4,"height":42.2}}` |

**证据素材（已生成，可直接用）：**
- `ops-audit/demo_3_written.png` —— 白板截图，画面上就是那行字（给人看的）
- `ops-audit/demo_canvas_read3.json` —— agent 实际收到的 JSON（给机器看的）
- 复现路径：`AI_BROWSER_CANVAS_HOOK=1` 启动 → excalidraw.com → 按数字 8 选文本工具 → 点画布 → 打字 → Esc → `browse_canvas read`

> ⚠️ 发稿纪律：canvas 捕获默认关闭（`AI_BROWSER_CANVAS_HOOK=1` 开启），稿子里必须如实写这个开关，不能让人以为开箱即得。诚实边界是这套打法的一部分。

## 二、第二个真故事（今天刚发生）：AI 自己把发错的视频标题改了

B站视频 BV15RJb6oERJ 的标题挂了两天源文件名 `demo_vertical`，已被搜索引擎收录。今天的修复**没有人工操作**：agent 进入 B站创作中心 → 稿件管理 → 编辑页 → 改标题 → 处理弹窗 → 提交 → 公开 API 复核确认生效。全程用的就是 ai-browser，登录态是常驻的、没重新登录过一次。

这是"持久登录 + 人随时接管"卖点的活案例，也是**别人抄不走的 dogfooding 内容**。

## 三、Reddit 成稿（首发 r/ModelContextProtocol，养号后再发 r/ClaudeAI）

**Title:** `My agent wrote on a canvas whiteboard, then read its own writing back as JSON — no screenshots, no OCR`

**Body:**

I've been building an MCP-driven browser where the agent reads pages as a semantic tree instead of screenshots. Yesterday it crossed a line I didn't expect it to cross this early.

The task: open Excalidraw (a pure-canvas whiteboard — no DOM nodes for anything you draw), pick the text tool, and write a sentence. Then read it back.

Why this matters: in this exact scenario, the two mainstream approaches are blind.

- Screenshot + vision model: works, but burns vision tokens, OCR-guesses the text, and never knows exact position or font.
- DOM / accessibility tree (Playwright-style): **returns nothing at all.** There is no DOM for canvas strokes.

What my agent actually received after typing via trusted CDP input:

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

That's the 2D draw-call layer (fillText), captured as structured data — not pixels, not OCR. Same mechanism catches what a canvas app *changed*, which is how you verify an action when zero DOM bytes moved.

Disclosure: I'm the author. MIT, macOS/Linux today (Windows untested), first launch downloads ~110MB engine. Canvas capture is opt-in (`AI_BROWSER_CANVAS_HOOK=1`) — I'd rather tell you that than let you find out.

Try the same experiment: `npx -y @glittering0717/ai-browser mcp`, point your agent at excalidraw.com, tell it to write something and read it back. If your stack gets a different result, I genuinely want to know how.

Repo: https://github.com/Glittering/ai-browser

**发帖纪律**：正文 320 词左右；先在评论区补一张白板截图；不并发多 sub；被删别重发，先读该 sub 规则。

## 四、V2EX 成稿（分享创造）

**标题：** `[开源] 让 AI 在纯 Canvas 白板上写字，再不截图把它读回来——顺手让它把自己发错的视频标题改了`

**正文：**

做过浏览器自动化的应该都撞过这两堵墙：

1. 登录态。临时浏览器实例每次都是新的，扫码/滑块全要重来。
2. Canvas。页面一旦是 canvas 画的，DOM 里什么都没有，DOM 方案全瞎；截图方案要烧视觉 token 还猜不准。

我做的 AI Browser（Electron + MCP，MIT）走的是第三条路：agent 读语义树，输入走 CDP 受信事件，人随时可以接管鼠标。昨天验证了一个比较极端的场景——

**在 Excalidraw（纯 canvas 白板）上让 agent 选文本工具、打字，然后把字读回来。** agent 收到的不是图，是：

```json
{ "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 } }
```

fillText 在绘制层直接截获，字体坐标都在，零 OCR。

今天顺手修了个自己的事故：B站一条视频标题挂了两天源文件名 `demo_vertical`，agent 用它的常驻登录态进创作中心改标题、处理弹窗、提交，最后用公开 API 复核生效，全程没让我碰一下鼠标。

已知边界（先说清楚省得你们喷）：macOS/Linux 已测，Windows 没测；首次启动要拉 ~110MB 引擎；canvas 捕获默认关着，要 `AI_BROWSER_CANVAS_HOOK=1`，我不想让人以为开箱就有。

接入就一句：`npx -y @glittering0717/ai-browser mcp`，注册进 Claude Code / Cursor 的 mcp 配置。把这句话发给你的 agent 试试："打开 excalidraw.com，随便写句话，再把它读回来"。

仓库：https://github.com/Glittering/ai-browser —— 目前 4 个 star，比你们的键盘温度还低，欢迎来改（或骂）。

## 五、B站重拍脚本（60 秒，竖屏保留）

| 时间 | 画面 | 口播/字幕 |
|---|---|---|
| 0:00–0:05 | 白板特写：字正在一笔笔出现 | "AI 在画板上写的字，它自己能读回来——不截图、不认图" |
| 0:05–0:15 | 左终端右白板：agent 收到 JSON，高亮 text/font/at | "它拿到的是这个——文字、字体、坐标，一行 JSON" |
| 0:15–0:25 | 分屏对照：Playwright 树空 vs 语义树有值 | "DOM 方案在这儿是全瞎的，截图方案在烧钱猜" |
| 0:25–0:45 | 快剪：B站后台标题从 demo_vertical 变成新标题 | "今天它还自己进了创作中心，把发错的标题改了——用的就是我常驻的登录态" |
| 0:45–0:55 | 一行命令 + 二维码式字幕 | "接入一句话：npx -y @glittering0717/ai-browser mcp，把链接发给你的 agent 就行" |
| 0:55–1:00 | 结尾卡：仓库 + slogan | "人类看像素，AI 看语义树" |

**统一 CTA（所有平台结尾）**

> 别"求 star"。给读者一个 60 秒内能做的动作：
> "把这句话发给你的 Claude/Cursor：`打开 excalidraw.com，随便写句话，再把它读回来`。能跑通，再决定要不要点 star；跑不通，来 Discussions 贴日志。"

## 六、发布顺序建议（本周）

1. 修图/录屏（用脚本五重拍 demo 视频）→ B站
2. V2EX（老号，今天就能发）
3. Reddit r/ModelContextProtocol（养号 3 天后发 r/ClaudeAI）
4. 掘金挂"AI 编程"话题改写（1500–2000 字，加入这次 B站修复的完整步骤与坑）
5. 全部发出 48 小时后，用 ops-audit 脚本回采数据，决定哪个继续加注

# V2EX 发帖执行手册（Runbook）

> 目标频道：**V2EX「分享创造」节点**（node = `create`）。
> V2EX 官方发帖指引明确要求：*发布作品请在**分享创造**节点，而非其他节点。* 用错节点会被移动甚至判定违规——这是硬规则。
> 账号：`Glittering`（老号，已登录在 ai-browser 常驻 profile 里）。

## 时间纪律
V2EX 首页按最后回复时间排序。发布时间优先：**工作日 08:30–09:00**（早班族）> 12:30 午休 > 21:00–23:00。
凌晨发的帖，第二天中午前就被冲到看不见的位置，数据不可信。

## 主路径（脚本）

```bash
cd /Users/Zhuanz/WorkBuddy/2026-10-18-23-53-03/ops-audit
/Users/Zhuanz/.workbuddy/binaries/node/versions/22.22.2-6/bin/node aib_driver.mjs v2ex_publish.mjs --timeout=240000
```

脚本行为：进 `/write?node=create` → 校验登录态 → 填标题与正文 → **校验字数确实写进去了** → 点发布 → 处理最多 4 轮确认弹窗 → 抓 URL → 自动回填 `docs/marketing/CHANNEL_POSTS.md`。
脚本**会抛错而不是静默通过**：字数没进去就停，不会发半截。

## 兜底（脚本失败时手工执行）

1. `browse_navigate` → `https://www.v2ex.com/write?node=create`
2. `browse_auth_state` 必须 `logged_in=true`；不是就停，别往下走。
3. 标题框选择器 `#topic_title`（maxlength 120），正文框 `#editor`（textarea[name=content]，上限 20000）。
4. 勾选 `Markdown` 语法（`#syntax-markdown`），否则代码块不会渲染。
5. 确认节点下拉值是 `create`（分享创造）；不是就改。
6. 点**预览**检查代码块渲染无误 → 点**发布**（新界面按钮在预览区下方）。
7. 成功后 URL 形如 `https://www.v2ex.com/t/<id>`，回填到 `CHANNEL_POSTS.md` 的投放记录表。
8. **发布后 5 分钟内可以编辑标题/正文、也可以移动节点**——发现节点选错立刻纠正，超时就改不了了。

## 稿件（脚本内已内置，此处留档）

标题：
`[开源] 让 AI 在纯 Canvas 白板上写字，再不截图把它读回来——顺手让它把自己发错的视频标题改了`

正文要点（完整版见 `ops-audit/v2ex_publish.mjs` 里的 `BODY` 常量）：
- 两个痛点：临时实例的登录态、canvas 无 DOM
- 主证据：Excalidraw 场景 + agent 读回的 JSON（text / font / 坐标）
- 副证据：browse_diff 能识别 DOM 零变动的 canvas 数据变化
- 真实故事：agent 自己去 B站把发错的视频标题改了
- **边界必须写**：macOS/Linux 已测、首次 ~110MB、canvas 捕获要 `AI_BROWSER_CANVAS_HOOK=1`、控制端口只绑 localhost
- 结尾自嘲："目前 4 个 star，比你们的键盘温度还低"——V2EX 吃这个，反感的是装

## 发布后 48 小时该做什么
1. 用 `ops-audit/collect*.mjs` 回采：V2EX 帖子的回复数、GitHub referrers 是否出现 `v2ex.com`。
2. **referrers 里出现 v2ex.com = 这篇真的带来了人**，这是唯一值得看的指标。
3. 有回复就全部认真回（尤其质疑，回答得越冷静越加分）；无人回复不追加解释帖。

## 待补的事项（不影响发帖）
- 账号目前**没有头像**，V2EX 明确提示"有头像的主题会得到更多关注"——补一张。
- 正文暂时没图：需要先把 demo 截图传到公开可访问的地址（例如 push 到仓库后引用 raw URL），再编辑补进去（发布后 5 分钟内可改，超时就只能评论区补）。

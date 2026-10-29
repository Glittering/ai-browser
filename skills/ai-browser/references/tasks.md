# 任务配方

## 登录 / 需要人的环节

登录态存在持久分区里，**重启浏览器也还在**，所以通常只需人工介入一次。

1. 判断现状：`browse_auth_state`。`auth_wall.detected=true` 就是被踢了。
2. 需要人：在对话里说一句人话（"请在浏览器窗口里扫码登录，完成后回复我'好了'"），然后**停下来等**。
3. 收到回复后 `browse_get_tree` 确认真的进去了，再继续。
4. 不要编造凭据，不要连续重试注定失败的点击——重试只会让站点的风控更严。

## 表单填写

1. `browse_get_tree {subset:"interactive"}` 拿到所有可交互节点，注意 `required` 与 `states`。
2. 按节点 `id` 逐个 `browse_act {action:"type"}`。**不要用 Tab 键跳转**——顺序依赖布局，很脆。
3. 提交前重读一次树，看 `context` 里的必填提示与远端校验错误。
4. 提交后 `browse_diff` 证明真的变了；`browse_network` 看 POST 到底发了什么。
5. 只看到 toast 就当成功是常见误判——**toast 不等于后端接受**，要看到列表/详情页出现新数据。

## 多标签

- `browse_tabs {op:"list"}` 看现状；`{op:"new", url}` 新开；`{op:"switch", tab}` 切换（`switch` 可带 `show:true`：同时把这一页顶到用户眼前、并设为默认目标）。
- 省略 `tab` 就打你自己的工作页（一个 agent = 一块自己的组）；只显式传 `tab` 才换目标。
- `window.open` / `target="_blank"` 派生标签页跟**打开者**的组走；后台 agent 弹窗不抢视野（不显示），活跃才顶到眼前。想留在原地（不跟随新标签）传 `keep_tab:true`。

## 证明操作生效（`browse_diff`）

`success` 不是证据，`diff` 才是。

```
browse_diff { operation:"snapshot", js:"app.state" }   // 取基线（js 可选，不带就比 DOM）
browse_act  { action:"click", target:"<id>" }
browse_diff { operation:"diff", snapshot:"<基线>" }     // verdict: changed | unchanged
```

`unchanged` 是个强信号：不是你点错目标，就是页面根本没响应。别接着瞎点。

## 有专用 skill 的活儿

这三类别在这里硬做，用对应的技能（它们带更细的校验步骤）：

- 把文章发布到 CSDN / 知乎 / 掘金 → `content-publish`
- 读一篇文章的正文并总结 → `read-webpage`
- 长时间盯某个页面的请求 → `web-network-monitor`

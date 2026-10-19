我不再让 AI 看截图了

有段时间我一直以为是自己不会用。

让 AI 去知乎发篇文章，它卡在登录页出不来；让它去后台点发布，它读不懂弹窗；让它读个金融网站，它只会不停截图，然后告诉我"我看到了一些内容"。

后来我想明白一件事：它不是不聪明，它是瞎的。

我们给它的不是一个网页，而是一张图。

网页明明是一棵树——标题是标题、按钮是按钮、输入框有名字、有状态、能点能填、能验证。可一截图，这棵树就塌成了像素矩阵，所有结构信息全没了。然后我们还指望它从像素里"认出"哪个是按钮，再猜一个坐标去点。

于是就有了那些经典的翻车：

- 页面滚一下，坐标全废
- toast 提示"发布成功"一秒钟就没了，截图根本来不及
- Draft.js、ProseMirror 这类富文本编辑器，光标都进不去，更别说排版加粗

最麻烦的是 canvas。canvas 上压根没有 DOM 节点，基于 accessibility tree 的方案在这里拿到的是**空的**——它连"这里有个东西"都不知道。

## 换个思路：让它看结构

所以我做了一个 Electron 浏览器，但驾驶员是 AI Agent。

最大的不同是感知方式：Agent 拿到的不是图片，是语义树。每个元素带上角色、标签、值、状态、可执行动作，外加一个稳定 ID。

```json
{
  "role": "textbox",
  "label": "请输入文章标题（5～100 个字）",
  "value": "AI Browser 测试标题",
  "states": ["visible", "focused"],
  "actions": ["type", "clear", "focus"]
}
```

顺便把弹窗、必填提示、成功消息、登录态一起塞进 context。这样 Agent 不该再问"我是不是已经登录了"。

## 三个不显眼但决定成败的细节

**输入要走 CDP 受信事件**

不是合成 JS 事件，是 `Input.dispatchKeyEvent` / `dispatchMouseEvent`。

差别是真实的：Draft.js、ProseMirror、Quill、CKEditor 都吃这一条通道，**不需要任何网站特判**——因为它们本来就是给真人的键鼠用的。点击后我还会用 `elementFromPoint` 校验确实命中，避免"点到隔壁元素"。

**canvas 其实不需要 OCR**

2D canvas 的文字是在 `ctx.fillText()` 里画出来的——那就在绘制调用层把字符串截下来：

```json
{
  "text": "AI Browser wrote this - no screenshot, no OCR",
  "font": "20px Excalifont, Xiaolai, sans-serif",
  "at": { "x": 10, "y": 13.2, "width": 937.4, "height": 42.2 }
}
```

字体、坐标、颜色全在，零 OCR。只有 WebGL 才需要截图，而且默认关着。

**"生效了没有"必须是原语**

这是被坑出来的。有次工具返回 success，但页面上什么都没发生。Agent 信了，继续往下走，等到第三步的时候，错误已经被放大到看不出原样了。

所以我把验证做成了工具原语：快照前后对比，返回显式的 changed/unchanged 判定，带上前后值和路径，再对页面数据模型做个指纹。这样连"只改 canvas 数据、DOM 零变动"的操作也能抓住。

## 现在它能干什么

- 用你**已登录**的浏览器去后台干活——不用重新登录，扫码一次长期有效
- 在 canvas 白板上写字，再不靠 OCR 把自己写的字读回来
- 遇到扫码、滑块、支付确认时，你伸手拿鼠标接管，它就在对话里等着

最后说清楚边界：目前只在 macOS 和 Linux 上测过，Windows 没测；首次启动要拉约 110MB 的引擎数据；控制端口只绑在本机而且没有鉴权——别把它转发出去。

项目在这里，MIT：https://github.com/Glittering/ai-browser
想试就一条命令：npx -y @glittering0717/ai-browser mcp
跑不通别急着关，把日志贴到 Discussions，那才是我最想要的输入。

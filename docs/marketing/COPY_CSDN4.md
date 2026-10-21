# COPY_CSDN4 — CSDN 第四篇（SEO 长尾 · 富文本编辑器自动化）

> 用途：2026-10-24 12:00 发布。分类专栏「人工智能」，创作声明如实勾选「部分内容由AI辅助生成」，摘要 100–130 字，标签走推荐池。
> 目标搜索词：`Agent 自动化粘贴` / `富文本编辑器 自动化` / `Draft.js 自动化` / `CodeMirror 自动填入` / `网页编辑器 自动化输入`。
> 结构硬要求：小标题 + 自动目录 + 代码块 + 对比表 + FAQ + 小结。
> **标题套用 PLAYBOOK §0 公式**：痛点词前置（`写不进`）+ 具体对象（四类编辑器）+ 可验证承诺（实测数据）。

---

## 标题

`Agent 写不进富文本编辑器？知乎、掘金、CSDN、开源中国四家的粘贴方案实测`

## 摘要（128 字）

让 Agent 自动填写网页内容，最难的不是导航栏按钮，是富文本编辑器。知乎用 Draft.js、掘金用 CodeMirror、CSDN 用 CKEditor、开源中国用 Tiptap——四种受控机制各不相同。本文逐个给出可行写入路径、实测结果表和通用降级方案，附带"如何判定真的写进去了"的字数校验方法。

## 正文（约 2400 字）

### 一、问题：为什么 `Ctrl+V` 在程序里不灵

让 Agent 往网页里填内容，第一反应是发一个粘贴事件。这在日常使用里天经地义——人就是这么做的。但合成（`synthetic`）的粘贴事件在大量富文本编辑器里**根本不触发编辑器的处理逻辑**，原因是浏览器安全模型：

```js
// 合成事件不会被信任
const evt = new ClipboardEvent('paste', { clipboardData: dt });
el.dispatchEvent(evt);   // isTrusted === false
```

编辑器框架普遍会在 handler 里忽略 `isTrusted === false` 的事件，或者压根没挂载 paste listener，而是依赖浏览器原生行为把内容送进来。结果就是：事件派发了、没报错、编辑器纹丝不动。

更麻烦的是，不同编辑器的"受控写入"入口各不相同。下面是四家的实测。

### 二、四类编辑器的可行写入路径

| 编辑器 / 站点 | 内核 | 可行写入方式 | 不可行方式 |
|---|---|---|---|
| 知乎回答 | Draft.js | 真实按键输入进 `.public-DraftEditor-content` | 直接改 DOM / 合成 paste 部分失效 |
| 掘金文章 | CodeMirror | paste 写入后用 `CodeMirror.getValue()` 校验 | 信任 paste 回执（会误报 0 字符）|
| CSDN 文章 | CKEditor | 隐藏 file input + Markdown 文件注入 | `setValue` / setContent（丢格式）|
| 开源中国 | Tiptap / ProseMirror | paste 富文本（标题层级全保留）| 纯文本 paste（丢全部结构）|
| 微博输入框 | 原生 textarea | CDP 受信分块输入 | 合成 paste（`consumed: false`）|

#### 1）Draft.js（知乎）

Draft.js 用 `ContentState` 而不是 DOM 来维护内容，直接改 innerText 会被下一次 React 渲染覆盖。可行路径是定位到真正的编辑区并走真实输入：

```js
// 只量这个区域才是真实字数
document.querySelector('.public-DraftEditor-content').innerText.length
```

**坑**：页面顶部的搜索框和正文编辑器在语义树里都带 `editable` 状态。只按 editable 过滤，会误把几千字粘进搜索框。正确的定位条件是 `role=textbox` **且** `states` 含 `editable=richtext`。

#### 2）CodeMirror（掘金）

CodeMirror 接受 paste，但它的回执不可信——返回 `landed_chars: 0` 时内容其实已经写进去了。必须独立校验：

```js
// 用编辑器实例自己的 API 读，不看粘贴回执
document.querySelector('.CodeMirror').CodeMirror.getValue().length
```

这是本次实测里最容易误判的一处：如果只信回执，会得出"写入失败"的结论并重来一次，最后正文变成两份。

#### 3）CKEditor（CSDN）

`setContent` 和 `setValue` 都会丢 Markdown 结构。最稳的是走 CSDN 自己的 Markdown 导入通道——页面上有一个隐藏的文件输入：

```js
// #import-markdown-file-input 是隐藏的原生 input[type=file]
// 把 .md 文件路径喂给它即可原样导入，保真 100%
```

这条路径在本次实测里 3045 字符的正文零损耗导入，代码块和表格全部保留。

#### 4）Tiptap / ProseMirror（开源中国）

这是唯一一家 paste 富文本能完整保留结构的：9 个二级标题全部落地，加粗和代码块原样保留。原因是 ProseMirror 的 clipboard parser 支持 HTML 片段。所以这里反而**不能用**降级到纯文本的方案——那样会把所有结构信息丢掉。

#### 5）原生 textarea（微博）

最朴素的场景反而最倔：合成 ClipboardEvent 完全无效（`consumed: false`、`effect_state: unknown`）。可行方案是 CDP 的受信输入，按 60 字一块分次写入，174 字全部落地：

```bash
# 分块输入，避免 React 一次性 setState 丢失
browse_act type --chunk 60
```

### 三、通用降级方案

如果目标站点不走以上任何一种，按这个顺序降级：

1. **CDP `Input.insertText`** —— 浏览器级受信输入，能骗过绝大多数框架的 `isTrusted` 校验；
2. **真实按键**（`Input.dispatchKeyEvent`）—— 逐字符发送，速度慢但兼容性最好；
3. **调编辑器实例 API**（`CodeMirror.getValue` / `editor.setData`）—— 前提是能拿到实例；
4. **文件注入**——像 CSDN 那样，如果站点提供导入通道，这永远是最保真的一条。

优先级排序的依据是：**越靠近浏览器原生，越难被框架拦住。**

### 四、怎么判定"真的写进去了"

这是整个环节里最容易被忽略的一点。三类误判：

- **只信工具回执**：paste 报 `landed_chars: 0` 但内容在（CodeMirror 的坑）；
- **只信 toast**：几乎每个平台在失败时都会弹成功提示；
- **不刷新就验收**：发布类操作要刷新后仍能读到正文才算数。

可靠做法是**用编辑器自己的读取 API 做字数比对**，而不是看 DOM 快照或者通知：

```
预期字数 vs 实际读出字数，比值 ≥ 0.9 才放行下一步
```

以掘金那次为例：预期 2244 字符，读出 2244 字符——而不是工具自报的 0。

### 五、FAQ

**Q1：为什么不干脆都用截图 + 视觉模型？**
A：成本结构不可持续。每一步都要一张图，视觉 token 是纯文本的几十倍；坐标绑死像素，页面一滚动、弹个窗、换个分辨率整套坐标全废；toast 一秒就消失，截图根本来不及。

**Q2：Windows 上有差异吗？**
A：macOS/Linux 已实测，Windows 未测。粘贴事件的处理在 Chrome 系浏览器上应当一致，但系统剪贴板权限策略可能有差异。

**Q3：遇到验证码/滑块怎么办？**
A：不做。这类组件本来就是设计来区分人和程序的，绕过它既不可靠也无必要——让 Agent 停在对话框里等人接管，成本远低于破解。

**Q4：这套方法的边界在哪？**
A：WebGL 渲染的内容（Three.js 场景、部分数据大屏）取不到文本，只能退回截图；2D canvas 的文字在绘制调用层可以拿到字符串和坐标，不需要 OCR。

### 六、小结

富文本编辑器之所以是自动化里最容易翻车的一环，是因为每一家的受控机制都不一样——没有一个通用解，只有针对每种内核的已知可行路径，外加一套靠谱的降级顺序。

真正省时间的不是先试最快的方案，而是**一开始就写下怎么验证**。字数校验这一步花了五分钟写代码，省掉的是误判后重复投稿、内容翻倍、甚至发错位置的整晚返工。

本文所有结论来自真实发稿任务的逐平台记录，项目开源（MIT）：https://github.com/Glittering/ai-browser

跑不通欢迎评论区贴日志，那比 star 更有价值。

---

## FAQ（发布后用）

- **自补评论（发布后 30 分钟内）**：补充一个踩坑数据点——"今天给某平台排版时，正文里少了两个 h3，原因是 Markdown 里的标题行被引擎当成了代码块缩进。发之前最好本地先过一遍渲染。"

# COPY_SEGMENTFAULT1 — SegmentFault 首篇（纯踩坑 · 零推广）

> 用途：2026-10-25 20:30 自动发布。**全程不推销**，只讲一次粘贴失败的完整排查。SF 用户最吃这个，也是唯一能自然带出工程深度的形式。
> 标题 20–30 字。发布后把公开链接回填 CHANNEL_POSTS.md。SF 无创作者后台数据，以公开计数为准。

---

## 标题

`CDP 直达渲染器时 Cmd+V 不触发：一次粘贴失败的完整排查`

## 正文（约 1200 字）

### 现象

需求很普通：程序化地把一段带格式的 HTML 粘进网页里的富文本编辑器。

在普通 `<input>` 和 `<textarea>` 里，一切正常。换到 Draft.js 编辑器——**格式全丢**，六个二级标题变成一段纯文本。换 ProseMirror，一样。CKEditor 稍好，但加粗 span 丢了一半。

第一反应是粘贴内容的问题。换了 `text/plain`、`text/html`、构造 `DataTransfer` 各种组合，现象不变。

### 环境

- Chromium 系浏览器，通过 CDP（Chrome DevTools Protocol）驱动
- 输入方式：`Input.dispatchKeyEvent` 派发合成键盘事件（含 Meta+V）
- 目标：Draft.js / ProseMirror / Quill / CKEditor 四类编辑器

### 排查过程

**第一步：确认事件到达了没有。**
在页面里监听 `keydown`，合成事件确实触发了，`key === 'v'`、`metaKey === true` 都对。事件到了，但粘贴没发生。

**第二步：区分"页面里派发的假事件"和"浏览器认可的真事件"。**
这里要分开两条路径：

- 浏览器进程持有**加速键**（accelerator）表。用户真按 Cmd+V 时，事件先到浏览器进程，命中加速键表，触发原生 `paste` 命令，再由浏览器把 `paste` 事件派发给页面。
- 通过 CDP `Input.dispatchKeyEvent` 派发的合成键，**直达渲染器进程**，不过浏览器进程——加速键表这一层被绕过了。

所以在渲染器里监听 `keydown` 什么都对，但原生粘贴命令从未被触发。普通 input 看起来"能粘贴"，是因为有些实现会响应 `keydown` 自己插入文本，而富文本编辑器只认真原生 `paste` 事件——它们要靠这个事件走自己的粘贴管线。

**第三步：为什么编辑器只认真粘贴事件。**
Draft.js 有 `DraftPasteProcessor`，ProseMirror 有 `transformPastedHTML`——粘贴对编辑器不是"插入字符串"，是一次完整的文档转换：决定哪些标签保留、哪些内联样式合并、哪些块级结构重排。JS 直接改 DOM 或改 value，编辑器的文档模型根本不知道，渲染自然不更新。

### 根因

两个独立的问题叠在一起：

1. 合成键盘事件绕过了浏览器进程的加速键路径，原生 `paste` 不会触发；
2. 富文本编辑器只通过 `paste` 事件接收内容，且必须让内容进入它自己的粘贴管线。

### 解法

不模拟键盘，直接派发一个真实的 `paste` 事件，把 `text/html` 装进 `ClipboardEvent` 的 `DataTransfer`：

```js
const dt = new DataTransfer();
dt.setData('text/html', html);
dt.setData('text/plain', text);
const ev = new ClipboardEvent('paste', {
  clipboardData: dt,
  bubbles: true,
  cancelable: true
});
target.dispatchEvent(ev);
```

关键点：编辑器自己的粘贴管线会处理这个事件——格式保留与否由编辑器的规则决定，而不是由注入方决定。这正好是想要的行为。

### 验证

同一段内容（6 个 `h2`、6 个代码块、48 个加粗 span、7 个列表项）注入四类编辑器后的保留统计：

| 编辑器 | 处理方式 | 格式保留 |
|---|---|---|
| Draft.js | `paste` 事件过 DraftPasteProcessor | h2/代码块/加粗/列表全保留 |
| ProseMirror | `transformPastedHTML` | 全保留 |
| Quill | 粘贴管线 | 全保留 |
| CKEditor | 粘贴管线 | 全保留（此前丢加粗的问题同步解决） |

### 经验

- 程序化操作富文本编辑器，"派发事件"不够，要派发**编辑器认可的那一个事件**；
- 合成键 ≠ 真实键，差异在浏览器进程的加速键层，页面内监听什么都看不出来；
- 判据要独立于工具返回值：注入后读编辑器自己的文档模型长度，而不是信"调用成功"。

同类问题在 canvas 和跨进程 iframe 上也有对应解法，方法论一致：找到目标真正消费数据的那一层，把数据送到那一层。我们把这个过程记录在了项目文档里（Electron + CDP + MCP 的浏览器自动化方案，MIT 开源），有同样踩坑的可以去翻 discussions。

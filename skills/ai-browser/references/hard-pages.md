# 难搞的页面

## canvas（纯绘制，没有 DOM 节点）

**先找应用模型，再退到绘制层。**「图是 canvas」不等于「没有结构」：

1. **`browse_capabilities {deep:true}`** —— 扫库指纹（fabric / Konva / paper / Excalidraw /
   CodeMirror / Monaco）。实例即使**关在闭包里**也能抓出来（hook 原型方法 + 一条合成事件）。
   命中就给 `read_expr`（**顶层可求值的完整表达式**，直接喂 `browse_evaluate`）。
   有模型 → 读整张图的结构（图形类型/坐标/尺寸/文本），写完能**回读校验**。**这是首选。**
2. 没有已知库 → `browse_canvas {operation:"list"}` + `read` 截获 `fillText` 文本
   （需 `AI_BROWSER_CANVAS_HOOK=1`；**WebGL 是黑盒**，捕获不到文本，只能 `capture` 拿 PNG，
   自己承担视觉成本）。纯 canvas 应用**不要 OCR**。
3. 都没有 → 只能靠坐标动作 + 帧指纹确认"画面变了"，但**读不出"画的是什么"**（如实告知，别假装）。

在 canvas 上落点用坐标动作，不要找元素：

```
browse_act { action:"click", drag:{to:{x:420,y:180}} }   // 绝对值
browse_act { action:"wheel", wheel:{dx:0, dy:-240, hold:["Control"]} }  // 缩放
browse_act { action:"drag", drag:{from:{x:100,y:100}, to:{x:300,y:260}} } // 平移/框选
```

## 富文本编辑器（Draft.js / ProseMirror / Quill / CKEditor / 各类 contenteditable）

**不要逐字符输入，也不要设 `innerHTML`。** 用 paste，让编辑器走自己的粘贴管线：

```
browse_act { action:"paste", target:"<id>", html:"<h2>标题</h2><p>正文…</p>" }
```

`html` 优先；只给 `text` 会退化成纯文本，标题/列表/代码块/加粗全丢。
所有主流编辑器共用同一条 CDP 通道，不需要站点特判。

## 跨进程 iframe（OOPIF）

iframe 里的节点在读层有独立 id（形如 `axf-3-1`），`browse_get_tree` 未必带出来。

- 先 `browse_get_tree {ax: true}` —— AX 层把 iframe 内容也纳进来了
- 仍然没有 → `browse_capabilities` 看 `iframes` 清单
- 动作可以直接瞄准 `axf-3-1` 这类 id，跨进程也能点到

## 上传

```
browse_act { action:"upload", target:"<id>", file:"/abs/path/to/file.pdf" }
```

`target` 可以是文件输入框、触发选择器的按钮、**或者 CSS 选择器**（唯一允许选择器的动作，
因为纯 div 的上传控件常常没有语义节点）。跨进程 iframe 里同样可用。
`file` 必须是绝对路径。

## 弹窗与浮层

树里的 `context` 会带 modal / required hint / toast / 登录态 / 统计。
点了之后先看 `context.modals`，不要靠截图猜弹窗有没有出现。

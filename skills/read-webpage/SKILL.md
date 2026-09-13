---
name: read-webpage
description: >-
  适用于需要阅读、理解或总结某个网页的正文文章内容（标题 + 段落）的任务，尤其是新闻/博客/公众号等文章型页面。触发词：读这篇文章、阅读该页、总结内容、提炼要点、这篇文章讲了什么、extract the article、summarize this page。
  注意边界：若只需读取页面上的控件/标签/按钮/少量文本，请用 browse_get_tree，不要用本 skill；目标是交互（登录、表单、评论）而非读正文时也不要用本 skill。
---

# 网页正文提取（read-webpage）

## 目标
把当前页面"正文文章"（标题 + 段落）从 HTML 日报纹路中提取出来，交付给用户阅读/总结。取代已下线的 MCP 工具 `browse_read_article`，完全用 `browse_evaluate` 实现。

## 前置
- 已打开目标文章页，页面已加载完成（必要时先 `browse_wait({condition:'url_contains', ...})`）。
- 本 skill 只做"读"，不做跳转/点击。

## 步骤
1. 确保浏览器已指向文章页。
2. 调用 `browse_evaluate`，传入下述正文提取 JS 表达式，`params.tab` 按需指定：
   js:
   ```
   (function(){
     var h1 = document.querySelector('h1');
     var title = h1 ? h1.textContent.trim() : document.title;
     var article = document.querySelector('.article-body, .article-content, .main-content, .rich_media_content, article, .txt-article, .Body, #content, .post-content');
     var ps = article ? article.querySelectorAll('p') : document.querySelectorAll('p');
     var paras = [];
     for (var i=0; i<Math.min(ps.length, 30); i++) {
       var t = ps[i].textContent.trim();
       if (t.length > 25) paras.push(t.slice(0, 400));
     }
     return JSON.stringify({title:title, pCount:paras.length, paras:paras.slice(0,15)});
   })()
   ```
3. 解析返回值里的 `JSON`（字段：`title`、`pCount`、`paras[]`）。
4. 若 `pCount === 0`：页面无可提取正文，改用 `browse_get_tree` 读界面控件，并向用户说明"此页非文章型内容"。
5. 组装交付：`title` + 每段 `paras`（按顺序拼接，保留换行），再根据用户意图做总结/提炼要点。

## 示例（Claude Code 风格）
用户："读下这篇掘金文章讲了什么"
- `browse_evaluate({ js: <上面脚本>, tab })`
- 解析返回 → 输出 `标题 + 逐段摘要`。

## 验证
- 命中 `<article>` / `.article-content` 等容器时为二段式（title + paras）。
- 输出与旧 `browse_read_article` 等价（同一脚本主体）。
- 空结果时明确提示，不强行拼接垃圾文本。

## 边界与替代
- 只用于"正文文章"。登录框、评论、表格、导航等非文章内容走 `browse_get_tree` / `browse_act`。
- 不分页/不处理懒加载（动态新增段落不会出现）；长文分段处理或提示用户。
- 静默失败判据：若取回的 title 与 paras 均为空，判为"非文章页"。
---
name: read-webpage
description: >-
  read-webpage —— 只在「要把一整篇文章的正文取出来」时用我：标题 + 段落，新闻/博客/公众号/掘金这类页面。
  触发词：读这篇文章、看看这篇、帮我读一下、这页讲了啥、这篇写的是什么、提取正文、翻译这页、总结这篇。
  不适用：读控件 / 按钮 / 少量文本 → browse_get_tree；要交互（登录 / 表单 / 评论 / 发布）→ ai-browser 主循环。
---

# 网页正文提取（read-webpage）

## 目标
把当前页面"正文文章"（标题 + 段落）从 HTML 日报纹路中提取出来，交付给用户阅读/总结。完全用 `browse_evaluate` 实现（历史上曾有一个专门的读正文工具，已下线，别再找它）。

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
- 输出为标题 + 段落数组（同一套提取脚本主体），可直接交给用户阅读或总结。
- 空结果时明确提示，不强行拼接垃圾文本。

## 不适用（交给谁）
- 只要读控件 / 标签 / 按钮 / 少量文本 → `browse_get_tree`，不要提正文
- 目的是交互（登录、填表、评论、发布）→ 回 `ai-browser` 的主循环
- 要的是接口返回的 JSON，而不是页面上的字 → `ai-browser` 的 `references/network.md`
- 页面根本还没打开、不知道在哪 → 先用 `browse_navigate` 过去（`ai-browser` 主循环）

## 技术边界
- 只用于"正文文章"。登录框、评论、表格、导航等非文章内容走 `browse_get_tree` / `browse_act`。
- 不分页/不处理懒加载（动态新增段落不会出现）；长文分段处理或提示用户。
- 静默失败判据：若取回的 title 与 paras 均为空，判为"非文章页"。
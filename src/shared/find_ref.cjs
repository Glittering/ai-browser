'use strict';
// shared/find_ref.cjs — 按 data-ai-id 找元素，**穿透影子根**。
//
// 为什么不能只用 document.querySelector：shadow boundary 是硬边界，顶层查询进不去。
// Web Component 里的元素（B站 opus 的 <bili-comments>、YouTube 的 <ytd-*>、
// 各设计系统的 <ui-*>）即使抽取层已经写了 data-ai-id，顶层也查不到 —— 报出来只是
// "no element with data-ai-id=..."，读起来像"元素不存在"，实际是"查询路径够不着"。
// 实测 2026-10-17：B站帖子详情页的评论输入框整个在 bili-comments 的 shadow root 里，
// 抽取层补了下探（extractor.cjs 的 childrenOf）之后，解析这一侧也必须跟着穿透，
// 否则就是"树里有、点不动"。
//
// 两半各自有存在的理由：
//   findRef     —— 运行时函数，给能在页面里直接跑的代码用（preload/actions.cjs 自己
//                  那份等价实现就是它，故意不跨界 require，避免一处路径写错连带
//                  整个 preload 起不来）。
//   findRefExpr —— 字符串表达式，给主进程"拼注入脚本"的地方用。返回自包含表达式，
//                  所以可以原地替换 `document.querySelector(...)`，不需要在每个
//                  IIFE 里补前置声明（这样的地方有十几处，漏一处就是一处静默失效）。

function findRefExpr(idJsExpr) {
  return "(function(id){var f=function(r){var e=null;"
    + "try{e=r.querySelector('[data-ai-id=\"'+id+'\"]')}catch(x){e=null}"
    + "if(e)return e;"
    + "var a;try{a=r.querySelectorAll('*')}catch(x){return null}"
    + "for(var i=0;i<a.length;i++){var s=a[i].shadowRoot;if(!s)continue;var h=f(s);if(h)return h}"
    + "return null};return f(document)})(" + idJsExpr + ")";
}

// 在**某个子树内**穿透影子根找一个后代（按选择器）。
//
// 为什么还需要这个：找到编辑器外壳（例如 B站 的 <bili-rich-text> 宿主）之后，
// 真正的 contenteditable 往往在它自己的 shadow root 里 —— `el.querySelector(
// '[contenteditable=true]')` 同样不跨边界，于是"清空校验"读到空、把已经清干净
// 的编辑器判成"没清掉"，接着又删一遍。读回口径必须和定位口径一样深。
function findDescExpr(rootJsExpr, selectorJsExpr) {
  return "(function(root,sel){var f=function(r){var e=null;"
    + "try{e=r.querySelector(sel)}catch(x){e=null}"
    + "if(e)return e;"
    + "var a;try{a=r.querySelectorAll('*')}catch(x){return null}"
    + "for(var i=0;i<a.length;i++){var s=a[i].shadowRoot;if(!s)continue;var h=f(s);if(h)return h}"
    + "return null};return f(root)})(" + rootJsExpr + "," + selectorJsExpr + ")";
}

module.exports = { findRefExpr, findDescExpr };

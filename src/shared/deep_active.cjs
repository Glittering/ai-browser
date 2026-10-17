'use strict';
// src/shared/deep_active.cjs —— 「真正的焦点元素」表达式。
//
// 为什么需要它：`document.activeElement` 在 Web Component 里只到**宿主**为止。
// 焦点实际在 `<bili-rich-text>` 的 shadow root 里那个 contenteditable 上，但
// `document.activeElement` 返回的是 `bili-rich-text` 宿主本身，宿主上没有内容
// （innerText 为空），于是所有"读回输入内容再和目标比对"的校验全部读到空串。
//
// 后果不是"慢"或"看不清"，而是**假阴性**：内容明明打进去了，回执却报
// `Input not verified / actual_chars: 0`。调用方（尤其 agent）看到这个结论会
// 再打一次，结果是**重复输入**——比直接报错更糟，因为它看起来像"上次没成功"。
// 实测（2026-10-17，B站 opus 详情页评论框）：type 返回失败、actual_chars=0，
// 而回读 value 是完整的一句话。
//
// 修法：沿 `shadowRoot.activeElement` 一路下钻，取最里层的那个。
// 这条链是浏览器自己维护的焦点路径，不是猜 —— 每一层都是**该树内**的 activeElement。
//
// 返回值是一个**页面内可执行的 JS 表达式字符串**（不是函数），因为这些调用点
// 全部是拼进 `executeJavaScript` 的一行脚本里，统一用表达式才不用改它们的形状。
function deepActiveExpr() {
  return '(function(){' +
    'var e=null;try{e=document.activeElement}catch(x){return null}' +
    // 防御死循环：shadow 嵌套深度有限，但页面可以自己构造循环引用。
    'var g=0;while(e&&e.shadowRoot&&e.shadowRoot.activeElement&&g++<10){e=e.shadowRoot.activeElement}' +
    'return e})()';
}

// 同源 iframe 里的焦点：顶层 document.activeElement 是 <iframe> 元素本身，
// 这条链进不去（跨进程更进不去）。调用方要区分"在帧里"时自己判 tagName 即可，
// 这里不多导出一个口径 —— 两处判断同一件事迟早会不一致。
module.exports = { deepActiveExpr };

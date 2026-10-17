'use strict';
// findRefExpr 是这里的地基：定位本身也得能穿透 shadow，否则连 el 都拿不到，
// 命中判定再对也没用（"树里有、点不动"）。
const { findRefExpr } = require('./find_ref.cjs');

// shared/hit_point.cjs — "指针落在这个坐标上，到底会命中谁"，**穿透影子根**。
//
// 为什么不能只用 document.elementFromPoint：它和 querySelector 一样，被 shadow
// boundary 挡住 —— 对影子内部的元素，它返回的是**宿主**（离目标最近的那个
// 自定义元素），不是元素本身。
//
// 实测证据（2026-10-18，B站 视频页评论区，整块装在 <bili-comments> 的 shadow 里）：
//   树里报的 bounds => {x:733,y:377,w:24,h:24}     ← 坐标本身是准的
//   document.elementFromPoint(745,389) => bili-comments   ← 宿主
//   containsHit => false
// 于是"点击前先证明坐标会落在目标上"这道校验对影子内部元素**恒为假**，
// 点击只能回退到 preload 的 el.click()（非受信合成事件）。这在 CKEditor /
// ProseMirror / Draft.js 之类只认真实指针序列的编辑器上会直接失效，
// 而且"回退"这个事实不会出现在返回里 —— 看着成功，机制已经降级了。
//
// 修法：命中后逐级下钻。`ShadowRoot` 实现了 `DocumentOrShadowRoot`，所以
// `shadowRoot.elementFromPoint(x,y)` 是标准 API（不是 hack），坐标与
// document 版本同为视口坐标。一直钻到没有 shadowRoot 或钻不动为止。
//
// 配套的第二处修正：判定"命中即目标"必须用**含 shadow 的包含关系**。
// `Node.contains()` 不是 shadow-including 的 —— 隔着一层 shadow 它照样返回
// false（影子树是独立的 node tree）。上溯要写 `parentNode || ShadowRoot.host`。
//
// 隔离实验（tools/_oneoff/shadow_hittest.html + shadow_hittest_probe.cjs）：
//   A 裸元素        flat=A-plain  deep=A-plain  旧判定 true  新判定 true
//   B 一层 shadow   flat=DIV(宿主) deep=B-inner  旧判定 false 新判定 true
//   C 两层 shadow   flat=DIV(宿主) deep=C-deep   旧判定 false 新判定 true
//   D shadow 内被盖 flat=DIV       deep=DIV      旧判定 false 新判定 false ← 阴性仍守住
// 新判定是旧判定的严格超集：任何原本为真的情形仍为真（命中链是目标的祖先链），
// 只是把"隔着 shadow 其实命中了"这一整类假阴性补回来。

// 下钻层数上限：防御性。真实页面不会嵌套 32 层 shadow，但万一某页自己套娃，
// 宁可停下返回宿主的命中结果，也不要在页面里转不出来（这个 JS 是注入到页面
// 上下文里同步跑的，死循环等于页面卡死）。
const MAX_DEPTH = 32;

// 最深命中元素。传进来的 x/y 是**已求值**的 JS 表达式字符串（例如 "745" 或 "c.x"）。
function deepHitExpr(xJs, yJs) {
  return '(function(x,y){var h=null;try{h=document.elementFromPoint(x,y);}catch(e){h=null}' +
    'var g=0;' +
    'while(h&&h.shadowRoot&&g++<' + MAX_DEPTH + '){' +
    'var n=null;try{n=h.shadowRoot.elementFromPoint(x,y);}catch(e){n=null}' +
    'if(!n||n===h)break;h=n;}' +
    'return h;})(' + xJs + ',' + yJs + ')';
}

// 含 shadow 的"anc 是不是 n 的（含自身）祖先"。上溯时遇到 ShadowRoot 就跳到 host。
function shadowAncestorOfExpr(ancJs, nodeJs) {
  return '(function(anc,n){var c=n,g=0;while(c&&g++<128){if(c===anc)return true;' +
    'c=c.parentNode||c.host||null;}return false;})(' + ancJs + ',' + nodeJs + ')';
}

// 坐标会不会落在 el 上。el 用 data-ai-id 定位（本身已穿透 shadow，见 find_ref.cjs）。
// 判定：最深命中元素 === el，或 el 是它的含 shadow 祖先。
// **不能**反过来接受 hit.contains(el)：那等于"父元素当然包含子元素"，会把
// "按在了外层容器上"这种失败情形原样放行（拖拽连接点那处踩过，见 page_manager）。
function hitTestExpr(idJs, xJs, yJs) {
  return '(function(){var el=' + findRefExpr(idJs) + ';if(!el)return false;' +
    'var h=' + deepHitExpr(xJs, yJs) + ';if(!h)return false;' +
    'return ' + shadowAncestorOfExpr('el', 'h') + ';})()';
}

// "这个点上实际是哪个元素" —— 用于回执/错抓检测。
// 返回 {el:"TAG cls", id:最近一个带 data-ai-id 的含 shadow 祖先的 id} 或 null。
// 原来用 e.closest('[data-ai-id]')，同样跨不过 shadow：影子内部的元素 closest
// 走到影子树顶就停，永远返回 null，于是"抓错节点"的检测被静默跳过。
function hitInfoExpr(xJs, yJs) {
  return '(function(){var e=' + deepHitExpr(xJs, yJs) + ';if(!e)return null;' +
    'var c=e,id=null,g=0;' +
    'while(c&&g++<128){if(c.getAttribute){var v=c.getAttribute("data-ai-id");if(v){id=v;break;}}' +
    'c=c.parentNode||c.host||null;}' +
    'return {el:(e.tagName||"")+" "+(typeof e.className==="string"?e.className:"").slice(0,60),id:id};})()';
}

module.exports = { deepHitExpr, hitTestExpr, hitInfoExpr, shadowAncestorOfExpr, MAX_DEPTH };

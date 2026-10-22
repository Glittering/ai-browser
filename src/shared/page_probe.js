// shared/page_probe.js — "这一步到底改动了页面没有"必须由工具回答，不能让 agent 猜。
//
// 事故（2026-10-19，B站投稿）：
//   browse_act click 返回 success:true，agent 以为投递成功，继续往下走。
//   实际点中的是**外层** `<div class="submit-container">`，真正的可点元素是它
//   里面的 `<span class="submit-add">`。页面一个字节都没变，回执却是一片绿。
//   错误在第三步之后才暴露 —— 这时已经不可能靠"回头看"把因果连起来。
//
// 为什么这必须是原语而不是让调用方自查：
//   调用方（模型）没有"我刚才那一手到底生效了吗"的直觉。它拿到的 success
//   只说明**命令发出去了**，不说明**页面接住了**。中间这层语义只能由掌握
//   渲染进程的工具补上。否则每个站点、每个动作都要调用方自己写一遍快照对比，
//   而它连"该在什么时候拍快照"都不知道（拍早了页面还没渲染）。
//
// 设计取舍：
//   1. 只读、极轻。一次 evaluate 拿 5 个标量，不碰 AX 树、不截图。
//      动作用户关心的时延是"点击后多久有反馈"，多 2 次 evaluate（各 ~1ms）
//      换掉一整类静默失败，值得。
//   2. 指纹取**全量文本 hash + DOM 节点数 + 焦点元素内容长度 + URL**。
//      只看文本会漏掉"弹窗打开但文案相同"，只看节点数会漏掉"同位置替换"。
//      四个信号任一变化即视为 changed —— 宁可报 changed:true 放过，
//      不可报 false 冤枉（false 会诱导 agent 重复提交）。
//   3. changed:false 不等于失败。点击一个已选中的 radio、关闭一个已关的抽屉，
//      都是合法的无变化。所以这里只**陈述观测**，把结论留给调用方，并配一句
//      可执行的下一步。真正"该有变化却无变化"的判定放在 MUST_HAVE_EFFECT 里，
//      只对写类动作（输入/粘贴/上传）生效 —— 那些动作没有"合法无变化"的情形。
//
// 4. 主文档视角的边界：探针只读 top document。OOPIF 子帧里的变化它看不见，
//    因此 changed:false 的措辞是"主文档未变化"，不是"什么都没发生"。这个区别
//    写进 hint 里，避免把 B站 read-editor 那种跨进程编辑器误判成失败。

// 页面内执行的探针。纯读，不写任何属性，不触发任何事件。
// 返回的字段都用单字母：它要跨 RPC 边界回传，越短越好，语义在下面注释里。
//   t = body 全量文本长度（折叠空白后，与 DEFAULT_SNAPSHOT_JS 的口径一致）
//   h = 该文本的 djb2 hash（base36）—— 长度相同的内容替换靠它抓
//   d = 当前**可编辑**焦点元素的内容长度（深浅穿透 shadow root）—— 输入类动作的主信号。
//       只算 input/textarea/select/contenteditable：点击一个普通 div 也会让
//       activeElement 变过去，若把它的 innerText 算进来，每次"点了个没反应的
//       按钮"都会因为焦点跑过去而报 page_changed:true —— 那等于把这个探针
//       最该抓的场景（点了没反应）全丢掉。实测于 2026-10-22 的 fixture 回归。
//   n = DOM 元素总数（粗粒度结构变化：弹窗、列表插入）
//   u = location.href（SPA 路由跳转）
export const PAGE_PROBE_JS = `(function(){
  try{
    var b=document.body||document.documentElement;
    var t=(b&&(b.innerText||b.textContent))||'';
    t=t.replace(/\\s+/g,' ');
    var h=5381;
    for(var i=0;i<t.length;i++)h=((h<<5)+h+t.charCodeAt(i))|0;
    var a=document.activeElement,g=0;
    try{ while(a&&a.shadowRoot&&a.shadowRoot.activeElement&&g++<8)a=a.shadowRoot.activeElement; }catch(_e){}
    var dv='';
    try{
      if(a){
        var tg=a.tagName;
        var ed=(a.isContentEditable===true)||tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT';
        if(ed) dv=(a.value!=null)?String(a.value):(a.innerText||a.textContent||'');
      }
    }catch(_e){}
    var n=0;
    try{ n=document.getElementsByTagName('*').length; }catch(_e){}
    return {t:t.length,h:(h>>>0).toString(36),d:(dv||'').replace(/\\s+/g,'').length,n:n,u:String(location.href)};
  }catch(e){ return {__err:String((e&&e.message)||e)}; }
})()`;

// 哪些动作值得拍前后快照。只读动作（get_value / focus / hover / scroll_to）
// 不拍：它们本来就不该改页面，拍了只是白花两次往返。
// wheel 也不拍：滚动会改变 scroll 位置但 body.innerText 不变，节点数也不变，
// 必然报 false —— 那是个稳定的假阴性，不如不报。
const PROBED_ACTIONS = new Set([
  'click', 'type', 'setContent', 'clear', 'paste', 'upload', 'drag', 'press',
]);

// 这些动作**没有"合法无变化"的情形**：输入/粘贴/上传成功就一定有内容落地。
// 它们报 page_changed:false 时给强提示（并说明先读回再决定）。
const MUST_HAVE_EFFECT = new Set(['type', 'setContent', 'clear', 'paste', 'upload']);

export function shouldProbe(action) {
  return PROBED_ACTIONS.has(String(action || ''));
}

// 动作返回后到拍快照之间要等多久，让 React/Vue 的提交与路由跳转落地。
// 写类动作内部已经等过一轮（paste 350ms、type 有 input 校验），只需短等；
// click 触发弹窗/路由时框架往往在下一个 microtask + 一帧后才渲染，给足 220ms。
export function settleMs(action) {
  return MUST_HAVE_EFFECT.has(String(action || '')) ? 80 : 220;
}

const HINT_WRITE =
  'page_changed=false: the action returned success but the main document is byte-identical '
  + '(same text hash, same DOM node count, same focused-field length). The payload most likely '
  + 'never landed — a wrapper element was targeted, or the editor listens on a child surface. '
  + 'Read the element back with get_value BEFORE retrying: a second paste on a live editor '
  + 'duplicates the content instead of fixing it.';

const HINT_CLICK =
  'page_changed=false: the action returned success but the main document did not change. Two '
  + 'common causes: (a) the click hit a wrapper element and the real handler is on a deeper '
  + 'node — re-read the tree and target the inner <span>/<a>/<button>; (b) the control was '
  + 'already in the requested state, in which case there is nothing to retry. If the effect was '
  + 'expected inside an out-of-process iframe, this probe cannot see it — verify with '
  + 'get_tree/screenshot instead.';

/**
 * 比较前后两次探针。纯函数，无 Electron 依赖，可直接单测。
 * @returns {{changed: boolean|null, delta: object|null}}
 *          changed=null 表示数据不可比（某次探针失败），调用方应忽略而不是当成 false。
 */
export function diffProbe(before, after) {
  const ok = (p) => p && typeof p === 'object' && !p.__err && typeof p.h === 'string';
  if (!ok(before) || !ok(after)) return { changed: null, delta: null };
  const delta = {
    text_chars: (Number(after.t) || 0) - (Number(before.t) || 0),
    dom_nodes: (Number(after.n) || 0) - (Number(before.n) || 0),
    focused_chars: (Number(after.d) || 0) - (Number(before.d) || 0),
  };
  const changed = before.h !== after.h
    || (Number(before.n) || 0) !== (Number(after.n) || 0)
    || (Number(before.d) || 0) !== (Number(after.d) || 0)
    || before.u !== after.u;
  return { changed, delta };
}

/**
 * 把观测结果写进动作回执。纯函数（返回新对象）。
 *
 * 只在 changed === false 时附加 page_delta 和 effect_hint：
 * 正常路径（changed:true）不多说一个字，避免每步回执都多两行噪音。
 */
export function applyProbe(res, before, after, action) {
  if (!res || typeof res !== 'object') return res;
  const d = diffProbe(before, after);
  if (d.changed === null) return res;
  const out = { ...res, page_changed: d.changed };
  if (d.changed) return out;
  out.page_delta = d.delta;
  const isWrite = MUST_HAVE_EFFECT.has(String(action || ''));
  if (!out.effect_hint) {
    out.effect_hint = isWrite ? HINT_WRITE : HINT_CLICK;
  }
  // 写类动作 + 主文档零变化 = 内容很可能没落地。把 effect_state 从 committed
  // 降回 unknown，否则回执是自相矛盾的：success:true + effect_state:committed
  // 等于告诉 agent"这一手已经生效，别重试"，而观测说它没生效。
  //
  // 为什么是 unknown 而不是 none：探针只看主文档，OOPIF 子帧里的编辑器
  // （B站 read-editor）变化它看不见。unknown + verify_first 是唯一诚实的选择。
  if (isWrite && out.success === true) {
    out.effect_state = 'unknown';
    out.retry = 'verify_first';
  }
  return out;
}

export default { PAGE_PROBE_JS, shouldProbe, settleMs, diffProbe, applyProbe };

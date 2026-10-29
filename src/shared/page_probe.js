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
//   c = canvas 帧指纹 "fp:n:frames"，来自页面里的 canvas hook（canvas_hook_source.js
//       暴露的 window.__aiCanvasFp）。null = 这个页面没装 hook / hook 关着。
//
// 为什么必须加 c：上面四个信号全部只看 DOM，而**纯 canvas 应用的写入在 DOM 上
// 常常是零字节**。实测（2026-10-29，Excalidraw）：在白板上拖出一个矩形，DOM 节点
// 数与文本哈希都不变（画布是 <canvas>，图元不是 DOM 节点），于是 page_changed
// 只能靠"选中图元后右侧属性面板出现"这种副作用偶然为真；一旦动作不产生面板
// 变化（移动已存在的图元、在画布空白处涂色、连续调参），就会报 false，并附上一句
// "payload 很可能没落地" —— 把一次成功的写入说成失败，比不报更糟。
// 同一个指纹也进了 DEFAULT_SNAPSHOT_JS，所以 ui.diff 对画布写入同样能报 changed。
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
    var cf=null,cn=null;
    try{ var fpFn=window.__aiCanvasFp; if(typeof fpFn==='function'){var v=fpFn(); if(v){cf=String(v.fp);cn=v.n;}} }catch(_e){}
    var vis='';
    try{ vis=String(document.visibilityState||''); }catch(_e){}
    return {t:t.length,h:(h>>>0).toString(36),d:(dv||'').replace(/\\s+/g,'').length,n:n,u:String(location.href),c:cf,k:cn,v:vis};
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

// canvas 侧的证据分两种，措辞必须分开 —— 它们的下一步动作完全相反。
//
// 可归因（动作前 150ms 空闲窗口里指纹没动过）：这就是 canvas 应用上"写入成功"
// 的**常态**外观，图元不是 DOM 节点，画一笔只会让 <canvas> 重绘一次。
// 而调用方最容易犯的错恰恰是"为了确认再画一次"，于是画布上多了一个形状。
const HINT_CANVAS =
  'page_changed=true by canvas only: the DOM is byte-identical and the canvas draw sequence '
  + 'changed — the normal shape of a successful write on a canvas surface (shapes are not DOM '
  + 'nodes). Do NOT redo the action to "make sure": a second drag/paste duplicates the result. '
  + 'Read content back via the route in ui.capabilities, not ui.canvas_read — full-frame '
  + 'renderers (Excalidraw-class) log no fillText, so an empty texts[] does NOT mean empty canvas.';

// 不可归因（空闲窗口里指纹自己在动）：这一页会自己重绘（时钟、光标、动画、直播）。
// 此时"画布变了"什么都证明不了。把它算进 page_changed 尤其危险 —— 那会把
// page_probe 最初要抓的那件事（点了没反应）重新变回**永远为真**。
const HINT_CANVAS_NOISY =
  'canvas signal unusable on this page: the canvas repainted during a 150ms idle window before '
  + 'the action, so a canvas change cannot be attributed to your action. page_changed reflects '
  + 'the DOM only here. If you need certainty, call ui.snapshot twice with NO action in between '
  + 'and compare snapshot.canvas yourself — if it moves on its own, trust the app\'s own state '
  + 'route (ui.capabilities) instead of the canvas.';

// 画布变了、但**归因不了**：页面在空闲窗口里被后台节流冻住了（一次绘制都没有），
// 于是既不能说是我的动作、也不能说不是。这时最容易被误读成"成功"，所以必须
// 明说"别当成落地了"。
const HINT_CANVAS_UNKNOWN =
  'canvas changed, but attribution unknown: the page was hidden or throttled during the idle check, '
  + 'so this repaint may be its own animation. Do NOT assume your action landed. Bring the page to '
  + 'the front and check again, or verify through the app state route in ui.capabilities.';

// 动作前用于标定"这一页画布会不会自己动"的空闲窗口。150ms 覆盖 60fps 下 9 帧，
// 足够看出持续重绘；再长就会让 canvas 页上每次动作都多等一截。只在页面确实有
// canvas 指纹时才等（见 page_manager.executeAction）。
export const IDLE_WINDOW_MS = 150;

/**
 * 比较前后两次探针。纯函数，无 Electron 依赖，可直接单测。
 *
 * @param {object} opts.idleBaseline 动作前、早于 before 的一次采样。给了它才做
 *        "这一页画布会不会自己动"的标定；不给就只按指纹差异下结论。
 * @returns {{changed, delta, domChanged, canvasChanged, canvasIdle}}
 *   canvasChanged: true=内容变了 / false=没变 / null=没有可用信号
 *   （没装 hook、只有一侧有指纹、或**这一页自己在重绘**）
 *   canvasIdle:    true=空闲期静止（变化可归因给动作）/ false=自己在动 / null=没标定
 */
export function diffProbe(before, after, opts = {}) {
  const ok = (p) => p && typeof p === 'object' && !p.__err && typeof p.h === 'string';
  if (!ok(before) || !ok(after)) {
    return { changed: null, delta: null, domChanged: false, canvasChanged: null, canvasIdle: null };
  }
  const delta = {
    text_chars: (Number(after.t) || 0) - (Number(before.t) || 0),
    dom_nodes: (Number(after.n) || 0) - (Number(before.n) || 0),
    focused_chars: (Number(after.d) || 0) - (Number(before.d) || 0),
  };
  const domChanged = before.h !== after.h
    || (Number(before.n) || 0) !== (Number(after.n) || 0)
    || (Number(before.d) || 0) !== (Number(after.d) || 0)
    || before.u !== after.u;

  // 只比**帧指纹本身**，绝不比它周围的计数器。
  //
  // 这里踩过一次，代价很大：接入时把探针字段写成 `fp:n:frames` 的拼接串，而 n 与
  // frames 是单调递增的计数器 —— 于是"内容一模一样地重绘了一遍"（时钟、光标、
  // ECharts 动画区间、canvas 视频）也会让字符串变化，page_changed 变成**永远为真**，
  // 恰好把 page_probe 存在的意义（抓"点了没反应"）反过来废掉。
  // hook 里的 fp 本来是对的（同内容 → 同 fp，有单测钉住），是接入层把它废掉了。
  // 教训：**单测证明了 A，产品用的是 A 的包装 B** —— 两边各自都"对"，合起来是错的。
  const cb = typeof before.c === 'string' ? before.c : null;
  const ca = typeof after.c === 'string' ? after.c : null;
  const raw = (cb && ca) ? cb !== ca : null;

  // 空闲标定：判断"这一页会不会自己画"。
  //
  // 判据是**绘制计数**，不是指纹。这一点改过一次，方向是反的：
  // 一开始用"空闲期两次采样指纹不同 = 自己在画"，那是拿一个受采样相位影响的量
  // 去回答一个与相位无关的问题。同内容重绘的页面（60fps 画同一个画面）两次采样
  // 有相当概率取到同一个前缀哈希，于是"自己在画"漏判，接着把页面自己的动画
  // 算成我的功劳 —— 错在放行方向上，最不能接受的那一种。绘制计数单调递增，
  // 空闲窗口里涨了就是画了，与相位无关。
  //
  // 三份采样分工：
  //   idleBaseline → before   动作之前（150ms）。这里在画 = 页面自己会动。
  //   before       → after    动作本身，这就是要观测的差值。
  //   after        → post     动作之后。还在画 = 画面不会停下来。
  //
  // 只有"没画"这个结论需要**正证据**：空闲窗口里一次绘制都没有，也不一定是静止
  // —— 后台标签页被 Chromium 把 rAF 降到约 1fps 甚至暂停，页面是真的冻住了，而
  // 动作会把它唤醒。此时若判"可归因"，放行的恰好是页面自己的动画。所以隐藏页面
  // 上给出 null（不可判），这是唯一诚实的答案。
  let canvasIdle = null;
  if (raw !== null) {
    const ib = opts.idleBaseline;
    const pb = opts.postBaseline;
    const kBefore = Number(before.k) || 0;
    const kAfter = Number(after.k) || 0;
    if (ib && typeof ib.c === 'string') {
      const drewIdle = kBefore - (Number(ib.k) || 0);
      const postBusy = pb && typeof pb.c === 'string'
        && (pb.c !== ca || (Number(pb.k) || 0) > kAfter);
      if (postBusy || ib.c !== cb || drewIdle >= 2) {
        canvasIdle = false;
      } else if (String(before.v || '') === 'visible') {
        canvasIdle = true;
      } else {
        canvasIdle = null;
      }
    }
  }
  const canvasChanged = (canvasIdle === false) ? null : raw;
  return { changed: domChanged || canvasChanged === true, delta, domChanged, canvasChanged, canvasIdle };
}

/**
 * 把观测结果写进动作回执。纯函数（返回新对象）。
 *
 * 只在 changed === false 时附加 page_delta 和 effect_hint：
 * 正常路径（changed:true）不多说一个字，避免每步回执都多两行噪音。
 * 例外是"仅 canvas 变化"（成功写入的样子，调用方看不出落点）与"canvas 自漂"
 * （信号不可用，必须说清不是"没变化"）。
 */
export function applyProbe(res, before, after, action, opts = {}) {
  if (!res || typeof res !== 'object') return res;
  const d = diffProbe(before, after, opts);
  if (d.changed === null) return res;
  const out = { ...res, page_changed: d.changed };

  // canvas 字段**只在页面确实有 canvas 信号时**才出现，且出现就恒为三态之一。
  // 曾经只在 true 时写，于是"没变"与"没装 hook"在回执里长得一模一样 ——
  // 一个读不出含义的字段比没有这个字段更糟。没有 canvas 的页面继续不给字段，
  // 与加这个信号之前逐字节一致。
  const hasCanvas = d.canvasChanged !== null || d.canvasIdle !== null;
  if (hasCanvas) {
    out.canvas_changed = d.canvasChanged;
    out.dom_changed = d.domChanged;
    // canvas_idle **连同 null 一起发**。null 的含义是"标定不出来"（页面在后台被
    // 节流、空闲期一次绘制都没有），而"省略这个字段"会被读成"这一页没有画布"。
    // 两者的下一步动作相反：前者要另找验证手段，后者根本不用担心画布。
    out.canvas_idle = d.canvasIdle;
  }

  if (d.changed) {
    if (d.canvasChanged === true && !d.domChanged && !out.effect_hint) {
      // 只有标定到"空闲期静止"才敢说这是成功写入的样子。标定不出来时
      // （canvasIdle=null）同样的话会变成一句误导。
      out.effect_hint = d.canvasIdle === true ? HINT_CANVAS : HINT_CANVAS_UNKNOWN;
    }
    return out;
  }

  out.page_delta = d.delta;
  const isWrite = MUST_HAVE_EFFECT.has(String(action || ''));
  if (!out.effect_hint) {
    // 自漂时不能说"payload 很可能没落地"——那等于用一个坏掉的观测手段下结论。
    out.effect_hint = d.canvasIdle === false ? HINT_CANVAS_NOISY : (isWrite ? HINT_WRITE : HINT_CLICK);
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

// 默认导出是**另一个对象**，不是命名空间本身。page_manager 用的是
// `import pageProbe from ...`，于是这里少列一个名字，调用方拿到的就是 undefined
// 而不会报错 —— IDLE_WINDOW_MS 就漏过一次：`setTimeout(r, undefined)` 等于 0ms，
// "空闲标定"退化成"立刻再采一次"，两次采样的计数完全相同，页面被误判成静止，
// 于是动画页上的"画布变了"被算成动作生效。症状在很远的地方（回执里 canvas_idle
// 恒为 true），根因在这里。
// 由 tests/test_page_probe.js 的 PP-30 逐键核对，不再靠人记得。
export default {
  PAGE_PROBE_JS, shouldProbe, settleMs, diffProbe, applyProbe, IDLE_WINDOW_MS,
};

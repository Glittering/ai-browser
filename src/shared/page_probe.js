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
    var cl=null;
    var cg=0;
    try{ var fpFn=window.__aiCanvasFp; if(typeof fpFn==='function'){var v=fpFn(); if(v){cf=String(v.fp);cn=v.n;cl=(v.last==null?null:v.last);cg=(v.g===1?1:0);}} }catch(_e){}
    var vis='';
    try{ vis=String(document.visibilityState||''); }catch(_e){}
    return {t:t.length,h:(h>>>0).toString(36),d:(dv||'').replace(/\\s+/g,'').length,n:n,u:String(location.href),c:cf,k:cn,v:vis,l:cl,g:cg};
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

// **判不了**（证据不足）：页面可能被后台节流冻住、也可能是拿不到完整帧的增量渲染器。
// 此时"画布没变"这句话不能说 —— 我们并没有真的看见它没变。这是最容易被误读成
// "什么都没发生"的一种状态，必须明说"这个信号在当页不可用"。
const HINT_CANVAS_UNKNOWN =
  'canvas signal unusable on this page: not enough evidence to tell whether the canvas changed '
  + '(the page was hidden/throttled during the idle check, or it repaints without whole frames). '
  + 'page_changed reflects the DOM only here. If you need certainty, call ui.snapshot twice with '
  + 'NO action in between and compare snapshot.canvas yourself; if it moves on its own, trust the '
  + 'app state route in ui.capabilities instead of the canvas.';

// **看不见看得见的东西**：页面用 WebGPU/WebGL 画，而我们的钩子只挂得到 2D 上下文。
// 实测（Figma，2026-10-30）：DOM 里 1 张 canvas 是 webgpu、2D 画布 0 张，而钩子照样
// 记到 41 帧 —— 那些来自页面自己建的**离屏** 2D 画布（缩略图/排版缓存），用户看不见。
// 于是一次真实的 100→200 宽度修改，fp 一动不动，回执报 canvas_changed:false。
// 那是**假阴性**：写入成功了却说"证明没变"，比 null 坏得多，所以这里宁可全给 null。
const HINT_CANVAS_GPU =
  'canvas signal unusable on this page: the visible surface is drawn with WebGPU/WebGL, which the '
  + 'draw hook cannot see (it only wraps 2D contexts; the frames it counts come from offscreen 2D '
  + 'canvases). canvas_changed/canvas_idle are null here — that means "cannot be judged", NOT '
  + '"nothing happened". page_changed reflects the DOM only. Verify the write by reading the app\'s '
  + 'own state (ui.capabilities): a property panel, a layer list or a mirror DOM, not pixels.';

// 动作前用于标定"这一页画布会不会自己动"的空闲窗口。150ms 覆盖 60fps 下 9 帧，
// 足够看出持续重绘；再长就会让 canvas 页上每次动作都多等一截。只在页面确实有
// canvas 指纹时才等（见 page_manager.executeAction）。
export const IDLE_WINDOW_MS = 150;

/**
 * 这一页的画布处于哪种状态 —— 决定了"画布变了"能不能当成证据。
 *
 * 四种，各有各的判据（**不要**拿一个量去回答两个问题）：
 *
 *   static   空闲窗口里一次都没画过。用**前缀哈希 fp** 判变化：静态页只画一帧，
 *            下一帧边界永远不来，所以只有 fp 是即时的。
 *   repeat   在画，但每次画的**完整帧**一样（稳定的动画循环 / 同内容重绘）。
 *            用**完整帧哈希 last** 判变化：它与采样相位无关，因此这一页终于可判了。
 *   drift    在画，且完整帧每帧都不同（时钟指针、协作光标、视频）。
 *            此时"画布变了"无法归因给动作 —— 只能回答"不可判"。
 *   unknown  证据不足：空闲窗口一个样本都没有、拿不到完整帧（增量渲染器）、
 *            或页面在后台被节流（那时"没画"不等于"不会画"）。
 *
 * 为什么不能用"空闲期采到几个不同的指纹"来区分 repeat 与 drift：稳定重绘的页面
 * 也会因为采样落在帧内不同位置而给出几个不同的**前缀**哈希。实测踩过这个坑，
 * 于是改成"数帧而不是数相位"——完整帧哈希只有内容变了才会变。
 */
function canvasVerdict(before, after, opts) {
  const num = (v) => Number(v) || 0;
  const samples = Array.isArray(opts.idleSamples)
    ? opts.idleSamples.filter((x) => x && typeof x.c === 'string')
    : [];
  // 没做标定（调用方没给样本）：退回"只看指纹差"，与加这套判据之前完全一致。
  // 生产路径上不会走到这里 —— page_manager 见到 canvas 指纹就会采三份。
  if (!samples.length) return { mode: 'static', active: false };

  const idleDrew = num(before.k) - num(samples[0].k);
  // 指纹在空闲窗口里变过 = 这一页**确实画过**（c 只在真有绘制时变）。这与计数器
  // 是两条独立证据：慢速动画（1fps）可能一次计数差都攒不够，但指纹已经变了。
  //
  // 端点必须含 before：窗口是从**第一个**样本到**动作前那一刻**，只比样本之间会漏掉
  // 最后一段（实测只有一个样本时这条恒为 false，自漂页当场被当成静止页）。
  const cbNow = typeof before.c === 'string' ? before.c : null;
  const idleVaried = samples.some((x) => x.c !== samples[0].c)
    || (cbNow !== null && samples[samples.length - 1].c !== cbNow);
  const post = opts.postBaseline;
  const postBusy = !!(post && typeof post.c === 'string'
    && (post.c !== after.c || num(post.k) > num(after.k)));
  const active = idleDrew >= 2 || idleVaried || postBusy;

  if (!active) {
    // 空闲期真的没画。但后台标签页被 Chromium 把 rAF 降到约 1fps 甚至暂停，
    // 那时"没画"不是"不会画"的证据 —— 隐藏页上只能给 unknown。
    const m2 = String(before.v || '') === 'visible' ? 'static' : 'unknown';
    return { mode: m2, active: false };
  }
  // 在画。能不能判，取决于拿不拿得到**完整帧**（与采样相位无关的那个值）。
  const lasts = new Set();
  for (const s2 of samples) if (s2.l !== null && s2.l !== undefined) lasts.add(String(s2.l));
  if (lasts.size > 1) return { mode: 'drift', active: true };       // 每帧内容都不同 → 不可归因
  if (lasts.size === 1 && samples.length >= 2) return { mode: 'repeat', active: true }; // 每帧一样 → 可判
  return { mode: 'unknown', active: true };                          // 在画但没有完整帧（增量渲染器）
}

/**
 * 比较前后两次探针。纯函数，无 Electron 依赖，可直接单测。
 *
 * @param {object[]} opts.idleSamples 动作之前连续采的几次（≥2 才能判 repeat）。
 * @param {object}   opts.postBaseline 动作之后再隔 IDLE_WINDOW_MS 采的一次。
 * @returns {{changed, delta, domChanged, canvasChanged, canvasIdle, canvasRepeat, mode, hasCanvas}}
 *   canvasChanged: true=变了 / false=没变 / null=不可判（drift、unknown）
 *   canvasIdle:    true=静止 / false=自己在画 / null=不可判
 *   canvasRepeat:  这一页在重绘但每帧内容相同（此时 canvasChanged 仍然可信）
 *   hasCanvas:     两次采样里有没有指纹（决定回执要不要带这四个字段）
 */
export function diffProbe(before, after, opts = {}) {
  const ok = (p) => p && typeof p === 'object' && !p.__err && typeof p.h === 'string';
  const empty = {
    changed: null, delta: null, domChanged: false,
    canvasChanged: null, canvasIdle: null, canvasRepeat: false, mode: 'unknown', hasCanvas: false,
  };
  if (!ok(before) || !ok(after)) return empty;

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
  // 教训：**单测证明了 A，产品用的是 A 的包装 B** —— 两边各自都"对"，合起来是错的。
  const cb = typeof before.c === 'string' ? before.c : null;
  const ca = typeof after.c === 'string' ? after.c : null;
  const hasCanvas = !!(cb && ca);

  const verdict = hasCanvas ? canvasVerdict(before, after, opts) : { mode: 'unknown', active: false };
  const mode0 = verdict.mode;
  // GPU 绘制层：钩子记到的是**离屏 2D 画布**，不是用户看的那张（Figma 实测）。
  // 这种页面上 fp 与可见画布无关，任何结论（包括 false）都是编的 —— 一律给 null。
  // 注意方向：这里唯一可接受的错是"多说几个不知道"，绝不允许再说 false。
  const gpuBlind = !!(hasCanvas && (before.g === 1 || after.g === 1));
  const mode = gpuBlind ? 'gpu' : mode0;
  let canvasChanged = null;
  if (hasCanvas && !gpuBlind) {
    if (mode === 'static') {
      canvasChanged = cb !== ca;
    } else if (mode === 'repeat') {
      const lb = before.l == null ? null : String(before.l);
      const la = after.l == null ? null : String(after.l);
      canvasChanged = (lb !== null && la !== null) ? lb !== la : null;
    }
    // drift / unknown：变化**不可归因**，给 null 而不是 true —— 一个"可能是我干的"
    // 结论比"我不知道"更容易被误用。
  }
  // canvas_idle: true=静止 / false=自己在画 / null=判不了。'unknown' 既可能是
  // "在画但拿不到完整帧"，也可能是"根本没证据"（隐藏页），所以下面按 active 给值 ——
  // 让一个 50% 把握的结论长得像 100% 把握的结论，是这类字段最常见的坏法。
  const canvasIdle = gpuBlind ? null : (mode === 'static' ? true : (verdict.active ? false : null));
  const canvasRepeat = gpuBlind ? false : (mode === 'repeat');
  return {
    changed: domChanged || canvasChanged === true,
    delta, domChanged, canvasChanged, canvasIdle, canvasRepeat, mode, hasCanvas,
  };
}

/**
 * 把观测结果写进动作回执。纯函数（返回新对象）。
 *
 * 只在 changed === false 时附加 page_delta 和 effect_hint：
 * 正常路径（changed:true）不多说一个字，避免每步回执都多两行噪音。
 * 例外是"仅 canvas 变化"（成功写入的样子，调用方看不出落点）与"信号不可用"
 * （必须说清不是"没变化"，而是"这里判不了"）。
 */
export function applyProbe(res, before, after, action, opts = {}) {
  if (!res || typeof res !== 'object') return res;
  const d = diffProbe(before, after, opts);
  if (d.changed === null) return res;
  const out = { ...res, page_changed: d.changed };

  // canvas 字段**只要页面确实有指纹**就发，哪怕结论是"不可判"。曾经只在 true 时写，
  // 于是"没变""不可判""没有画布"三种情况在回执里长得一模一样 —— 一个读不出含义
  // 的字段比没有这个字段更糟。没有画布的页面继续不给字段，与加这个信号之前逐字节一致。
  if (d.hasCanvas) {
    out.canvas_changed = d.canvasChanged;
    out.dom_changed = d.domChanged;
    out.canvas_idle = d.canvasIdle;
    out.canvas_repeat = d.canvasRepeat;
  }

  if (d.changed) {
    if (d.canvasChanged === true && !d.domChanged && !out.effect_hint) {
      out.effect_hint = HINT_CANVAS;
    }
    return out;
  }

  out.page_delta = d.delta;
  const isWrite = MUST_HAVE_EFFECT.has(String(action || ''));
  if (!out.effect_hint) {
    if (d.mode === 'gpu') out.effect_hint = HINT_CANVAS_GPU;
    else if (d.mode === 'drift') out.effect_hint = HINT_CANVAS_NOISY;
    else if (d.mode === 'unknown' && d.hasCanvas) out.effect_hint = HINT_CANVAS_UNKNOWN;
    else out.effect_hint = isWrite ? HINT_WRITE : HINT_CLICK;
  }
  // 写类动作"什么都没变"：工具无法证明它落地了，只能降级成"先验证"。
  // 它看不见的东西（OOPIF、原生弹窗、跨进程编辑）太多，unknown + verify_first 是唯一诚实的选择。
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

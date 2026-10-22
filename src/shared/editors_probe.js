// shared/editors_probe.js — DOM 侧的可编辑区清单，给**默认读法**补消歧信息。
//
// 为什么 AX 那边（main/axExtractor.js 的 summarizeEditors）已经有了一份、
// 这里还要再来一份：两条读法覆盖的是同一批页面，但 browse_get_tree 的**默认**
// 路径走 DOM extractor，不产出 `editable` 状态串，也就没有可编辑区索引。
// 只在 AX 路径修，等于告诉用户"想知道哪个是正文请加 ax:true" —— 而默认路径
// 恰恰是最常被用的那条。坑必须在自己所在的那条路上修掉。
//
// 只读、只碰四个属性（rect / placeholder / aria-label / data-ai-id），不写 DOM。
export const EDITORS_PROBE_JS = `(function(){
  try{
    var sel='input,textarea,[contenteditable=true],[contenteditable=""],[role=searchbox]';
    var all=document.querySelectorAll(sel),out=[];
    for(var i=0;i<all.length&&out.length<40;i++){
      var e=all[i],r;
      try{r=e.getBoundingClientRect();}catch(_e){continue;}
      var w=Math.round(r.width),h=Math.round(r.height);
      if(w*h<800) continue;
      var tag=e.tagName.toLowerCase();
      if(tag==='input'){
        var ty=String(e.type||'text').toLowerCase();
        if(/^(hidden|submit|button|checkbox|radio|file|reset|image|color|range)$/.test(ty)) continue;
      }
      var ce=e.getAttribute('contenteditable');
      var et=(ce==='true'||ce==='')?'richtext':(tag==='textarea'?'textarea':'textbox');
      var ph=String(e.getAttribute('placeholder')||'').slice(0,40);
      out.push({
        ref:String(e.getAttribute('data-ai-id')||''),
        role:String(e.getAttribute('role')||'textbox'),
        editor_type:et,w:w,h:h,
        label:String(e.getAttribute('aria-label')||'').slice(0,40),
        placeholder:ph,
        readonly:!!e.readOnly,
        type:tag==='input'?String(e.type||'text').toLowerCase():''
      });
    }
    return out;
  }catch(e){return {__err:String((e&&e.message)||e)}}
})()`;

// 与 axExtractor 的 SEARCH_LIKE 必须一致 —— 两处口径分叉会让"同一个页面在
// ax:true 与默认读法下给出相反的 primary"，那比没有索引更糟。这里不 import
// 是因为 axExtractor 属于 main 进程模块，而本文件也被 preload 侧测试引用。
export const SEARCH_LIKE = /搜索|查找|检索|search|find/i;

const MIN_AREA = 800;
const PRIMARY_MIN_AREA = 20000;

/**
 * 把 DOM 探针的原始行转换成与 AX 路径**同构**的 editors 数组。
 * 纯函数，可直接单测（不需要 Electron）。
 *
 * @param {Array} rows      EDITORS_PROBE_JS 的返回值
 * @param {Set}   knownRefs 树里真实存在的 ref（探针是全局扫的，包含被剪枝的节点）
 * @returns {Array|null}    <2 个有效编辑区时返回 null
 */
export function buildEditorsIndex(rows, knownRefs) {
  if (!Array.isArray(rows)) return null;
  const known = knownRefs instanceof Set ? knownRefs : new Set(knownRefs || []);
  const list = [];
  for (const r of rows) {
    if (!r || !r.ref || (known.size && !known.has(r.ref))) continue;
    const w = Number(r.w) || 0;
    const h = Number(r.h) || 0;
    const area = w * h;
    if (area < MIN_AREA) continue;
    const ph = String(r.placeholder || '');
    const label = String(r.label || '');
    const searchlike = r.role === 'searchbox'
      || r.type === 'search'
      || SEARCH_LIKE.test(ph)
      || SEARCH_LIKE.test(label);
    list.push({
      ref: r.ref,
      role: r.role || 'textbox',
      editor_type: r.editor_type || 'textbox',
      label: label.slice(0, 40),
      ...(ph ? { placeholder: ph.slice(0, 40) } : {}),
      w, h, area,
      readonly: !!r.readonly,
      ...(searchlike ? { searchlike: true } : {}),
    });
  }
  if (list.length < 2) return null;
  const sorted = list.sort((a, b) => b.area - a.area).slice(0, 8);
  let primary = null;
  for (const e of sorted) {
    if (e.readonly || e.searchlike) continue;
    if (e.area < PRIMARY_MIN_AREA) break;
    primary = e.ref;
    break;
  }
  return sorted.map(({ area, ...rest }) => (rest.ref === primary ? { ...rest, primary: true } : rest));
}

export default { EDITORS_PROBE_JS, buildEditorsIndex, SEARCH_LIKE };

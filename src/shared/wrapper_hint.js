// shared/wrapper_hint.js — 「你点的这个节点是个容器，文字其实归别人」的诊断。
//
// 为什么需要（2026-10-25 知乎私信）：私信列表行是 `<div class="ChatUserListItem">`，
// 它的 AX name 是**整段预览文字的拼接**（"创作者小助手 10-21 ☄️最新一期「创作打卡
// 挑战赛」活动来喽！…"）。于是按文字找链接时，命中的是这个行容器而不是会话里的
// `<a>创作打卡挑战赛第五十四期</a>`：
//
//   ● [e:div-30] generic acts=["click"]  ← label 是拼接出来的，点它只会选中会话
//   ● [e:a-236]  link    acts=["click","focus","hover"]  ← 真链接，点了才跳活动页
//
// 实测：点 e:div-30 回执 success=true / clicked_via=cdp-click，但 url 不动 —— 用户看到
// 的就是「树里有、点不动」。而回执里当时没有任何一句话说明"你点的是容器"。
//
// 修法分两层：
//   ① 树里给这类容器打 agg 标记（见 axExtractor.markAggregatedLabels），让"文字属于谁"
//      在读树时就能分辨；
//   ② 动作回执里补一条诊断：**目标自身没有文字**（own text 为空）却带着拼接出来的大段
//      文字、且页面没变时，把"这段文字真正的归属节点"找出来告诉调用方。
//
// 判定"自身没有文字"是关键：像 `<a>创作打卡…</a>` 这种，文字是它的**直接子文本节点**，
// own text 非空 → 不是容器，不该报。只有 own text 为空、文字全在子孙里的，才是拼接。

// 在页面里跑：给一个 data-ai-id，返回这段文字的真正归属节点（若目标只是个容器）。
// 返回 null 表示"目标自己就有文字，不是容器"或"找不到更合适的归属"。
//
// 为什么候选集限定在 a/button/[role]/[tabindex]/[data-ai-id]：
// 知乎私信页有上万个元素，全量扫描 + 逐个拼子文本会明显卡页面；而"能承担一次点击"
// 的元素几乎都在这个集合里。宁可漏报，也不要让诊断本身成为性能问题。
export function wrapperHintExpr(aiId) {
  const ID_LITERAL = JSON.stringify(String(aiId == null ? '' : aiId));
  return `(function(){
    var ID = ${ID_LITERAL};
    var el = null;
    try { el = document.querySelector('[data-ai-id="' + ID + '"]'); } catch (e) { el = null; }
    if (!el) return null;
    function ownText(n) {
      var s = '';
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) s += c.textContent;
      }
      return s.replace(/\\s+/g, ' ').trim();
    }
    if (ownText(el).length >= 3) return null;   // 自己就有文字 → 它是内容的归属，不是容器
    var agg = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (agg.length < 6) return null;            // 太短的容器没有诊断价值
    var cands = document.querySelectorAll('a,button,[role="link"],[role="button"],[tabindex],[data-ai-id]');
    var best = null;
    var limit = Math.min(cands.length, 4000);
    // "这段文字跟容器那段文字有关"的判据。为什么不用 agg.indexOf(t)：
    // 容器 label 是**拼接**出来的，中间的标点/空格/被截断的尾巴会让整串对不上。
    // 实测知乎私信：label 里写的是「创作打卡挑战赛第五十四期 」，链接的 own text
    // 是"创作打卡挑战赛第五十四期"（没有书名号、没有空格）。整串匹配会漏掉它，
    // 而这恰恰就是要找的那个链接。退一步用"8 字窗口命中"：只要候选文字里有连续
    // 8 个字出现在容器文字里，就算相关 —— 中文 8 个字已经足够特异。
    function related(aggText, t) {
      if (aggText.indexOf(t) >= 0) return 2;      // 整串命中：最可信
      if (t.length < 8) return 0;
      for (var k = 0; k + 8 <= t.length; k++) {
        if (aggText.indexOf(t.slice(k, k + 8)) >= 0) return 1;
      }
      return 0;
    }
    var viewH = window.innerHeight || 800;
    for (var i = 0; i < limit; i++) {
      var c = cands[i];
      if (c === el) continue;
      if (c.contains(el)) continue;             // 目标的祖先：点它等于又点一次外层
      var t = ownText(c);
      if (t.length < 6) continue;
      var match = related(agg, t);
      if (!match) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var cs = getComputedStyle(c);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var tag = String(c.tagName || '').toUpperCase();
      var role = String((c.getAttribute && c.getAttribute('role')) || '');
      var clickable = (tag === 'A' || tag === 'BUTTON' || role === 'link' || role === 'button' || cs.cursor === 'pointer');
      var area = Math.max(1, Math.round(r.width) * Math.round(r.height));
      // 排序必须按"相关性"而不是"谁小"：
      //   ① 整串命中优先于 8 字窗口命中 —— 知乎那边同一条私信里躺着第一期到第五十四期
      //      五个链接，它们的 8 字窗口全都命中"创作打卡挑战赛"，只按面积排会挑中
      //      面积最小的那一期（实测挑成了第五十期，还滚在视口外 4500px）；
      //   ② 视口内优先 —— 用户看到并想点的是屏幕上那个；
      //   ③ 能点的优先；
      //   ④ 最后才用面积（越贴近那段文字越精确）。
      var inView = (r.y + r.height > 0 && r.y < viewH) ? 0 : 1;
      // 更长的那段文字更具体：同一段预览里"创作打卡挑战赛"和"创作打卡挑战赛第五十四期"
      // 都是整串命中，但后者才是用户想点的那一期。
      var specificity = 200 - Math.min(199, t.length);
      // 排序：整串命中 > 能点 > 更具体（文字更长）> 视口内 > 面积小。
      // 为什么"更具体"排在"视口内"前面：同一段预览里的第一期…第五十四期五个链接，
      // 整串命中的只有对的那一期，即使它在视口外也值得点（点击前会 scrollIntoView）；
      // 反过来点一个"看得见但期数错了"的链接，是把人带到错误页面。
      var score = (2 - match) * 1e15 + (clickable ? 0 : 1e13)
        + specificity * 1e9 + inView * 1e8 + Math.min(area, 99999);
      if (!best || score < best.score) {
        best = {
          score: score,
          id: (c.getAttribute && c.getAttribute('data-ai-id')) || null,
          tag: tag,
          role: role || null,
          text: t.slice(0, 60),
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          clickable: clickable,
          exact: match === 2,
        };
      }
    }
    if (!best) {
      // 是容器，但页面里找不到"更该点"的节点：仍然要把结论说出来（别让调用方
      // 再点第二次同样的容器），只是不编造一个 id。
      return { is_wrapper: true, own_text: '', agg_text: agg.slice(0, 80), better_target: null };
    }
    delete best.score;
    return { is_wrapper: true, own_text: '', agg_text: agg.slice(0, 80), better_target: best };
  })()`;
}

// 回执里给调用方看的下一步。措辞刻意点名"容器"，因为下一步动作完全取决于这个判断：
// 容器要点它里面/旁边的叶子节点，而不是再点一次同一个容器。
export function wrapperHintText(w) {
  if (!w || !w.is_wrapper) return '';
  const bt = w.better_target;
  if (bt && bt.id) {
    return `target is a container: its own text is empty and the label is aggregated from descendants ("${w.agg_text}"). A more precise node owns that text: ${bt.id} (${bt.role || bt.tag}${bt.clickable ? ', clickable' : ''}) — click that instead of retrying this one.`;
  }
  if (bt) {
    return `target is a container: its own text is empty and the label is aggregated from descendants ("${w.agg_text}"). The text actually lives on <${bt.tag}> "${bt.text}"${bt.clickable ? ' (clickable)' : ' (not clearly clickable)'}, which has no ref yet — re-read the tree with subset:"all" to address it.`;
  }
  return `target is a container: its own text is empty and the label is aggregated from descendants ("${w.agg_text}"). Retrying the same node will not help — target the descendant that actually holds the text.`;
}

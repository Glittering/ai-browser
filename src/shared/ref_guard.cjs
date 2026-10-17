// src/shared/ref_guard.cjs — ui.act target 的形状体检（纯函数）
//
// 坑：ui.act 的 target 是 get_tree 返回的 data-ai-id（如 `e:button-12`、
// `axf-3-1`，或元素原生 id），**不是按钮上可见的文字**。传 "发布" 这类
// label 时，最终以 `[data-ai-id="发布"]` 去查，命中不到，回一句
// "Target not found for ref: 发布" —— 字面没错，但完全没有指出"你传的是
// 文字不是 id"这个真正原因，调用方容易反复重试同一个错误形状。
//
// 这里在入口把明显不像 ref 的形状挡下来，并给可操作的提示。判定从宽：
// 只拒**几乎不可能是 id** 的输入（含空白字符、超长、以引号/括号开头），
// 原生 id 一律放行 —— 误拒一个合法 id 比漏放一个 label 更糟。

'use strict';

const MAX_REF_LEN = 120;

// CJK（含全角标点）。ref 里不会出现，文案里必然出现。
const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
// 选择器的"结构符"。要求**至少有一个**，而不是"有空格就算"——
// 否则 "Publish now" 这种英文按钮文案会被当成后代选择器放行，
// 那恰恰是这套体检要拦的东西。
const SELECTOR_MARK_RE = /[.#\[>]|\*/;
// 选择器里允许出现的字符集合（够覆盖后代/子代/属性/伪类/分组选择器的常见写法）。
const SELECTOR_CHARS_RE = /^[A-Za-z0-9_\-.#\[\]="'>+~:*()\s]+$/;

/**
 * 是否"像一条 CSS 选择器"。
 * 用于 upload：上传控件常常既没有 data-ai-id、也没有可用的原生 id
 * （B站「本地上传」是个纯 div 菜单项，AX 树里根本没有它），只能靠选择器定位。
 * 判定刻意从严：必须**无 CJK + 含结构符 + 字符集合法**，避免把页面文案放进来。
 */
function looksLikeCssSelector(t) {
  if (!t) return false;
  if (CJK_RE.test(t)) return false;
  if (!SELECTOR_MARK_RE.test(t)) return false;
  return SELECTOR_CHARS_RE.test(t);
}

/**
 * 把复合选择器拆成"逐段"的简单选择器（只按**顶层**复合子拆，属性值/伪类
 * 参数里的空格引号不算）。返回形如 ['.a', '.b', '[type=file]']。
 * 拆的时候丢掉组合子（`>` `+` `~` 与空格一样处理），因为回退只关心"哪几层"，
 * 不关心层与层之间是父子还是兄弟 —— 原始写法会由调用方原样保留为第一个候选。
 */
function splitCompoundSelector(t) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += t[i + 1] || ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') { depth++; cur += ch; continue; }
    if (ch === ']' || ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * 选择器的回退候选，**由长到短**：`.a .b .c` → `['.a .b .c', '.a .b', '.a']`。
 *
 * 为什么需要：大量上传组件在"已经有文件"的状态下会把上传区（连同它内部那个
 * 永远隐藏的 `<input type=file>`）整个卸载，只留一个封面预览。此时
 * `.container-coverimage-box .el-upload__input` 查不到任何元素 —— 但它的祖先
 * `.container-coverimage-box` 还在，点它能重新唤出选择器。调用方拿这串候选
 * 逐个试，第一个命中的就是"还能点的那一层"。
 *
 * 非选择器形状（真的 data-ai-id）原样返回单元素数组，不改变既有行为。
 */
function selectorAncestors(t) {
  const s = String(t || '').trim();
  if (!s) return [];
  if (!looksLikeCssSelector(s)) return [s];
  const parts = splitCompoundSelector(s);
  if (parts.length <= 1) return [s];
  // 第一个永远是原样的完整选择器（保留 `>` `+` 这些精确组合子），后面才是
  // 逐层退化的版本 —— 优先精确命中，实在没有才放宽成后代匹配。
  const out = [s];
  for (let n = parts.length - 1; n >= 1; n--) {
    const cand = parts.slice(0, n).join(' ');
    if (cand !== s) out.push(cand);
  }
  return out;
}

/**
 * target 是否"看着像"一个 data-ai-id。
 * @param {string} target
 * @param {{allowSelector?: boolean}} [opts] allowSelector：该动作是否接受 CSS
 *        选择器（目前只有 upload）。开启后选择器形态直接放行，其余判定不变。
 * @returns {string|null} null 表示放行；字符串是拒绝原因（可直接给调用方看）。
 */
function refShapeError(target, opts) {
  if (target === undefined || target === null || target === '') return null; // 空由调用方按各动作规则处理
  const t = String(target);
  const allowSelector = !!(opts && opts.allowSelector);
  if (allowSelector && looksLikeCssSelector(t)) return null;
  if (/\s/.test(t)) {
    return 'target looks like visible text, not a data-ai-id: ' + JSON.stringify(t.slice(0, 60))
      + ' — pass the id from get_tree (e.g. "e:button-12", "axf-3-1", or the element\'s native id), not the label on screen'
      + (allowSelector ? '; a CSS selector (e.g. ".el-upload__input") is also accepted for upload' : '');
  }
  // 纯 CJK、且不含任何 ASCII 字母/数字/结构符（`:` `-` `_` 等）——不可能是
  // data-ai-id。树里的 ref 要么带结构前缀（`e:button-12` / `axf-3-1`），要么
  // 是站点的原生 id（ASCII）。真实站点上"发布"/"点击发布"这类输入就是按钮
  // 文案，放行只会让它变成一句无方向的 "Target not found"。
  // 混了 ASCII 的一律放行（`e:按钮-1` 可能是合法 id）。
  if (CJK_RE.test(t) && !/[A-Za-z0-9]/.test(t)) {
    return 'target looks like visible text, not a data-ai-id: ' + JSON.stringify(t.slice(0, 60))
      + ' — pass the id from get_tree (e.g. "e:button-12", "axf-3-1"). If this really is the element\'s native id, locate it with ui.evaluate instead';
  }
  if (t.length > MAX_REF_LEN) {
    return 'target is ' + t.length + ' chars — data-ai-id values are short ids from get_tree, not text';
  }
  if (/^["'`()[\]{}]/.test(t)) {
    return 'target starts with a quote/bracket — pass the bare id from get_tree, not a selector';
  }
  return null;
}

module.exports = { refShapeError, looksLikeCssSelector, selectorAncestors, splitCompoundSelector, MAX_REF_LEN };

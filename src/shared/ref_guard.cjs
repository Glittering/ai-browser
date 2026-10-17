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

/**
 * target 是否"看着像"一个 data-ai-id。
 * 返回 null 表示放行；返回字符串表示拒绝原因（可直接给调用方看）。
 */
function refShapeError(target) {
  if (target === undefined || target === null || target === '') return null; // 空由调用方按各动作规则处理
  const t = String(target);
  if (/\s/.test(t)) {
    return 'target looks like visible text, not a data-ai-id: ' + JSON.stringify(t.slice(0, 60))
      + ' — pass the id from get_tree (e.g. "e:button-12", "axf-3-1", or the element\'s native id), not the label on screen';
  }
  // 纯 CJK、且不含任何 ASCII 字母/数字/结构符（`:` `-` `_` 等）——不可能是
  // data-ai-id。树里的 ref 要么带结构前缀（`e:button-12` / `axf-3-1`），要么
  // 是站点的原生 id（ASCII）。真实站点上"发布"/"点击发布"这类输入就是按钮
  // 文案，放行只会让它变成一句无方向的 "Target not found"。
  // 混了 ASCII 的一律放行（`e:按钮-1` 可能是合法 id）。
  if (/^[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+$/.test(t)) {
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

module.exports = { refShapeError, MAX_REF_LEN };

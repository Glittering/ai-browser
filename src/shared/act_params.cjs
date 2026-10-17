// src/shared/act_params.cjs — ui.act 的参数归一（纯函数）
//
// 坑：WS 层的 `ui.act` 只认 `params:{...}` 嵌套形状。把 `text` / `html` /
// `from_x` 放在顶层时它们**被静默丢掉**，动作照常执行但输入为空，回执是
// "type called with empty text" —— 调用方会以为自己传了文字，只是没生效。
// 这不是猜测：本轮实测里，同一个 act 调用写成 `{action, target, text}` 就失败，
// 写成 `{action, target, params:{text}}` 就成功。
//
// 现在两种形状都接受：嵌套优先，顶层未嵌套的已知动作参数被提升，并在回执里
// 用 params_hoisted 说明"这些是从顶层挪进来的"，调用方不必靠猜。

'use strict';

// 动作级参数（与 mcp_tools.browse_act 的 properties 同源）。tab/action/target
// 是 RPC 层自己的字段，不参与提升。
const ACTION_KEYS = [
  'text', 'html', 'value', 'offset', 'limit', 'url', 'keep_tab', 'file', 'files',
  'timeout_ms', 'to_target', 'from_anchor', 'to_anchor', 'hold', 'button', 'key', 'keys',
  'dx', 'dy', 'to_x', 'to_y', 'from_x', 'from_y', 'delta_x', 'delta_y', 'steps',
  'from', 'to', 'path',
];

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} top  WS 收到的完整 params
 * @returns {{params: object, hoisted: string[]}}
 */
function hoistActParams(top) {
  const src = top && typeof top === 'object' ? top : {};
  const nested = src.params && typeof src.params === 'object' ? src.params : {};
  const params = { ...nested };
  const hoisted = [];
  for (const k of ACTION_KEYS) {
    if (src[k] !== undefined && params[k] === undefined) {
      params[k] = src[k];
      hoisted.push(k);
    }
  }
  // 坐标快捷键：drag 的 from_x/from_y 与 to_x/to_y 在内部用 {from:{x,y}} 表达。
  // 只在一个都没给、且两个分量都齐时才合成，避免半截坐标变成 (x, 0)。
  if (params.from == null && num(params.from_x) && num(params.from_y)) {
    params.from = { x: params.from_x, y: params.from_y };
    if (!hoisted.includes('from')) hoisted.push('from(x,y)');
  }
  if (params.to == null && num(params.to_x) && num(params.to_y)) {
    params.to = { x: params.to_x, y: params.to_y };
    if (!hoisted.includes('to')) hoisted.push('to(x,y)');
  }
  return { params, hoisted };
}

module.exports = { hoistActParams, ACTION_KEYS };

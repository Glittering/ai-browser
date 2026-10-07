// shared/value_contract.cjs — node.value 截断契约（单一实现，两条读层共用）
//
// 背景：node.value 的 200 限制是本项目自己的行为，不是 CDP/无障碍树的限制。
// 旧实现在两处各自 `String(v).slice(0, 200)`：
//   - src/preload/extractor.cjs（legacy DOM 读层）
//   - src/main/axExtractor.js（AX 读层）
// 结果是"原值恰好 200"与"更长但被截断"不可区分，agent 无从判断要不要补读。
//
// 契约：
//   - 未截断：只返回 { value }，不给普通节点增加多余字段（省 token）。
//   - 截断：额外返回 value_truncated / value_full_length / value_length_unit /
//     value_fetch_ref。value 永远是原值前缀，不追加 "..."。
//   - 长度单位统一为 Unicode code point（不是 UTF-16 code unit，也不是字节），
//     保证不会把 emoji 等 surrogate pair 切半。
//
// 同时被 ui.act{action:'get_value'} 复用做 offset/limit 分页，因此这里的
// slice 语义与截断语义必须完全一致。
//
// CJS：preload（require）与 main（ESM default import）都要能用。

const VALUE_UNIT = 'unicode_code_point';
const DEFAULT_VALUE_LIMIT = 200;

// get_value 的分页上限：默认一次拿 20000 code point，硬上限 100 万。
const GET_VALUE_DEFAULT_LIMIT = 20000;
const GET_VALUE_HARD_LIMIT = 1000000;

// code point 长度。Array.from 按迭代器拆分，等价于 code point 计数。
function codePointLength(raw) {
  return Array.from(raw == null ? '' : String(raw)).length;
}

// 按 code point 取子串 [offset, offset+limit)。越界自动收敛，绝不产生孤立 surrogate。
function sliceByCodePoints(raw, offset, limit) {
  const arr = Array.from(raw == null ? '' : String(raw));
  const start = Math.max(0, Math.min(arr.length, Number(offset) || 0));
  const end = (limit == null || !isFinite(Number(limit)))
    ? arr.length
    : Math.min(arr.length, start + Math.max(0, Math.floor(Number(limit))));
  return arr.slice(start, end).join('');
}

/**
 * 截断节点 value。
 * @param {*} raw 原始值
 * @param {string} target 该节点的 data-ai-id（get_value 的定位主键）
 * @param {number} limit code point 上限，默认 200
 */
function truncateNodeValue(raw, target, limit = DEFAULT_VALUE_LIMIT) {
  const str = raw == null ? '' : String(raw);
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_VALUE_LIMIT;
  const arr = Array.from(str);
  if (arr.length <= cap) return { value: str };
  return {
    value: arr.slice(0, cap).join(''),
    value_truncated: true,
    value_full_length: arr.length,
    value_length_unit: VALUE_UNIT,
    value_fetch_ref: { action: 'get_value', target },
  };
}

// 把内部字段 value_fetch_ref 展开成带实际 tab 的可直接执行提示，并删掉内部字段。
// 主进程组装最终树响应时调用（tab 只有主进程知道）。
function expandValueFetch(node, tabId) {
  if (!node || !node.value_fetch_ref) return node;
  const target = node.value_fetch_ref.target;
  node.value_fetch = {
    mcp: { tool: 'browse_act', args: { action: 'get_value', target, tab: tabId } },
    ws: { method: 'ui.act', params: { action: 'get_value', target, tab: tabId } },
  };
  delete node.value_fetch_ref;
  return node;
}

// 走一棵树，展开所有 value_fetch_ref。
function expandValueFetchTree(tree, tabId) {
  if (!tree) return tree;
  const walk = (n) => {
    if (!n) return;
    expandValueFetch(n, tabId);
    for (const c of n.children || []) walk(c);
  };
  walk(tree);
  return tree;
}

// 敏感控件：password/file 的"值"不进入语义树，也不给长度或取全量提示。
function sensitiveInputKind(el) {
  if (!el || !el.tagName) return null;
  const tag = String(el.tagName).toLowerCase();
  if (tag !== 'input') return null;
  const type = String((el.type || (el.getAttribute && el.getAttribute('type')) || 'text')).toLowerCase();
  if (type === 'password') return 'password';
  if (type === 'file') return 'file';
  return null;
}

// ui.act{action:'get_value'} 的响应构造（与截断契约同一长度单位）。
function getValueResult(rawText, offset, limit) {
  const full = codePointLength(rawText);
  const start = Math.max(0, Math.min(full, Number(offset) || 0));
  const cap = (limit == null || !isFinite(Number(limit)))
    ? GET_VALUE_DEFAULT_LIMIT
    : Math.max(1, Math.min(GET_VALUE_HARD_LIMIT, Math.floor(Number(limit))));
  const value = sliceByCodePoints(rawText, start, cap);
  const returned = codePointLength(value);
  const hasMore = start + returned < full;
  return {
    value,
    offset: start,
    returned_length: returned,
    value_full_length: full,
    value_length_unit: VALUE_UNIT,
    value_truncated: hasMore,
    next_offset: hasMore ? start + returned : null,
  };
}

module.exports = {
  VALUE_UNIT,
  DEFAULT_VALUE_LIMIT,
  GET_VALUE_DEFAULT_LIMIT,
  GET_VALUE_HARD_LIMIT,
  codePointLength,
  sliceByCodePoints,
  truncateNodeValue,
  expandValueFetch,
  expandValueFetchTree,
  sensitiveInputKind,
  getValueResult,
};

// shared/effect_state.js — 每个动作回执都自带"页面到底被改动了没有"的三态判断。
//
// 为什么必须有这个字段（来自真实故障，不是设计洁癖）：
//   agent 点击后拿到 `{success:false, error:'...'}`，它无法回答一个关键问题 ——
//   **刚才那一下，页面里到底发生没发生？**
//   · 如果是"根本没点到"（target_not_found），重试是安全的；
//   · 如果是"点到了但回执超时"，重试就是第二次提交 —— 表单重复提交、消息发两遍、
//     订单下两次。这类事故在 agent 上比人更容易发生，因为 agent 没有"我记得我刚
//     点过"这层直觉。
//   以前这个判断藏在 error 字符串里，要靠模型读懂措辞（"may have partially applied"
//   写在一个 30 个词的英文长句末尾，实测经常被忽略）。现在把它变成一个**机器可判
//   的枚举**，并配一条明确的重试策略。
//
// 三态定义（宁可保守，不可乐观）：
//   none      —— 有证据表明页面**没被动过**（目标不存在、参数不合法、CDP 没连上、
//                形状体检没过）。重试安全。
//   committed —— 输入已经派发且页面 ack 了。不要重试。
//   unknown   —— **无法证明**没被动过（超时、事件派发了但页面没消费、粘贴落地存疑、
//                按了一半的键）。必须先读页面状态再决定，绝不能盲目重试。
//
// 最后一条是这套东西的全部价值所在：默认值是 unknown，不是 none。分类不出来时
// 承认不知道，比猜"应该没点到"安全得多。

export const EFFECT_NONE = 'none';
export const EFFECT_COMMITTED = 'committed';
export const EFFECT_UNKNOWN = 'unknown';

// 重试策略枚举（跟着 effect_state 一起回，省得调用方自己去查表）
export const RETRY_SAFE = 'safe';
export const RETRY_NO = 'no';
export const RETRY_VERIFY_FIRST = 'verify_first';

// 「页面一定没被动过」的征兆。全部取自 page_manager.js 里真实存在过的 error 文案
// （见 tests/test_effect_state.js 的 E-* 用例，那里逐条钉住了真实字符串）。
const NO_EFFECT_PATTERNS = [
  /target[_ ]not[_ ]found/i,
  // 上面的正则同时覆盖两种真实写法：page_manager 的 `target_not_found:` 与
  // src/preload/actions.cjs:34 的 `Target not found for ref:`。它们**不是同一
  // 个词**，2026-10-19 真机回归时按前者写死就漏判了后者，差点把"没点到"误判成
  // "不知道"（那会让 agent 对一次干净的失败也不敢重试）。
  /^no target/i,
  /^no url provided/i,
  /^no link matches url/i,
  /no-such-tab|tab not found/i,
  /target_has_no_value/i,
  /sensitive_value_not_readable/i,
  /unsupported action/i,
  /missing[-_ ](snapshot|target|param)/i,
  /unknown-snapshot|tab-mismatch/i,
  /cdp-unavailable/i,
  /requires CDP/i,
  /^wheel: need /i,
  /^drag: (start element not found|to_target not found|need one of)/i,
  /upload target not found/i,
  /cannot read file/i,
  /^type called with empty text/i,
  /^paste called with neither/i,
  /snapshot_failed/i,
  /ref_not_an_id|looks like visible text|not a data-ai-id/i,
  /element_not_found|element is not visible|has zero size/i,
];

// 「已经派发，但结果不确定」的征兆。顺序很重要：先判 partial，再判 no-effect，
// 因为 paste 的失败判断里同时出现 "not found" 与 "not consumed"，前者是入口检查后者
// 是事后存疑，而**事后**才是真相。
const PARTIAL_PATTERNS = [
  /may have partially applied/i,
  /not consumed by the page/i,
  /consumed but nothing landed/i,
  /interrupted|disconnected|target closed|debugger detached/i,
  /deadline exceeded|timed? ?out/i,
];

function matches(patterns, text) {
  for (const re of patterns) if (re.test(text)) return true;
  return false;
}

/**
 * 这条错误是不是"目标找不到"？ref 过期诊断只在这种失败上做，别的一律无关。
 * 单独导出是因为 page_manager 那边要用**同一套判定**，不能两处各写一份正则
 * （两份词表迟早分叉，实际已经分叉过一次：page_manager 用 `target_not_found:`，
 * preload 用 `Target not found for ref:`）。
 */
export function isTargetMiss(error) {
  return typeof error === 'string' && /target[_ ]not[_ ]found/i.test(error);
}

/**
 * 判定一个动作回执的 effect_state。
 *
 * @param {object} result   page_manager 里各种动作返回的对象
 * @returns {'none'|'committed'|'unknown'}
 */
export function classifyEffect(result) {
  if (!result || typeof result !== 'object') return EFFECT_UNKNOWN;

  // 1. 超时是最高优先级：它可能已经生效，且**一定**不该被当成"没点到"。
  if (result.timed_out === true) return EFFECT_UNKNOWN;

  // 2. 明确成功 —— 动作实现里所有成功路径都在 CDP 派发之后才返回 success:true。
  if (result.success === true) return EFFECT_COMMITTED;

  // 2b. hover/peek 这条路径用 revealed 数组表达成功，没有 success 字段。
  if (Array.isArray(result.revealed) && !result.error) return EFFECT_COMMITTED;

  // 3. 按键按到一半失败：已经发出去的键**已经生效了**，后面那半没有。
  if (Array.isArray(result.pressed) && result.pressed.length > 0) return EFFECT_UNKNOWN;

  const errText = [result.error, result.hint, result.message]
    .filter((x) => typeof x === 'string')
    .join(' | ');

  // 4. 事后存疑优先于入口检查。
  if (matches(PARTIAL_PATTERNS, errText)) return EFFECT_UNKNOWN;

  // 5. 有证据表明没被动过。
  if (matches(NO_EFFECT_PATTERNS, errText)) return EFFECT_NONE;

  // 6. 失败但没有证据 —— 承认不知道。
  return EFFECT_UNKNOWN;
}

// 三态 → 重试策略。
//
// ⚠️ `retry` 回答的不是"有没有副作用"，而是**"原样再来一次有没有意义"**。
// 这两件事会分叉，实测踩过：目标 ref 过期时 effect_state=none（确实什么都没发生，
// 重试没有副作用），但原样重试**必然再失败一次** —— 那时给 `safe` 就是在骗调用方。
// 所以 ref 类失败由调用方在 extras 里把 retry 覆盖成 verify_first。
export function retryAdvice(state) {
  if (state === EFFECT_NONE) return RETRY_SAFE;
  if (state === EFFECT_COMMITTED) return RETRY_NO;
  return RETRY_VERIFY_FIRST;
}

// unknown 时随回执给一句**可执行**的话。它必须自解释 —— 模型第一次看到这个字段
// 也要能立刻知道该干什么，不然就得回去读文档，那正是我们要消灭的成本。
const HINTS = {
  [EFFECT_NONE]: null,
  [EFFECT_COMMITTED]: null,
  [EFFECT_UNKNOWN]:
    'effect unknown: the page may have partially applied this action. Read the page (get_tree / get_value) to see its current state before trying again — a blind retry can submit twice.',
};

/**
 * 把三态写进回执。纯函数，返回新对象（不原地改调用方的 result）。
 *
 * @param {object} result
 * @param {object} [extras] 额外要合并进去的字段（如 stale_ref 诊断）
 */
export function withEffectState(result, extras) {
  if (!result || typeof result !== 'object') return result;
  const state = classifyEffect(result);
  const out = { ...result, effect_state: state, retry: retryAdvice(state), ...(extras || {}) };
  const hint = HINTS[state];
  // 已经有更具体的错误说明时不覆盖，只在 unknown 且没有说明时补一句 ——
  // 保证 agent 一定能看到"先验证再重试"这条要求。
  if (hint && !result.effect_hint) out.effect_hint = hint;
  return out;
}

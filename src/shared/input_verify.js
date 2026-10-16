// 输入校验用的文本归一化。
//
// 为什么需要它：`ui.act {action:'type'|'setContent'}` 走 CDP 受信键入，输完之后要
// 回读可编辑区内容，确认"字真的打出去了"。回读来的文本和输入的目标文本不会逐字节
// 相等 —— 富文本编辑器会按自己的排版规则重写内容（最常见的是把一个语义换行渲染成
// 一串 \n）。直接逐字比对会让**已经成功**的输入被判成失败，回一个
// `cdp-input-failed`，调用方据此重试或放弃。这属于谎报，是本项目最忌讳的一类问题。
//
// 用法：
//   normalizeInputText(s)  —— 校验主口径：忽略排版空白 + 压缩连续换行
//   skeletalInputText(s)   —— 兜底口径：连换行一起剥，只用于判断"内容有没有落上去"
//
// 设计取舍（重要）：绝不能简单粗暴地把 \s 全剥掉。那样 "a\nb\nc" 与 "abc" 会等价，
// 段落结构整个没了还判成功 —— 等于把谎报换成另一种谎报。所以：
//   - 排版空白（空格 / tab）压掉：编辑器加缩进用户看不出来，不算差异；
//   - 换行**参与**比对：段落结构必须保住；
//   - 但连续换行压成一个：分几层由编辑器决定，不该由调用方的文本决定。

/** 校验主口径：\r\n 归一 → 压排版空白 → 连续换行压成一个。 */
export function normalizeInputText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, '')
    .replace(/\n{2,}/g, '\n');
}

/** 兜底口径：在 normalizeInputText 之上再剥掉所有换行，得到纯内容指纹。 */
export function skeletalInputText(s) {
  return normalizeInputText(s).replace(/\n+/g, '');
}

/**
 * 判定一次输入是否达到了预期。
 * @param {string} expected 调用方想写入的文本
 * @param {string} actual   回读到的可编辑区内容
 * @returns {{ok: boolean, landed: boolean}} ok=按主口径达标；landed=忽略全部空白后内容已到位（排版被重排过）
 */
export function verifyInputText(expected, actual) {
  const want = normalizeInputText(expected);
  const got = normalizeInputText(actual);
  // clear（空目标）：允许残留空块外壳 —— 浏览器永远会留一个空块承载光标。
  if (!want) return { ok: skeletalInputText(actual) === '', landed: true };
  const ok = got.includes(want);
  // 忽略全部空白后再比一次：相等说明东西其实打进去了、只是被编辑器重新排了版。
  const landed = ok || skeletalInputText(actual) === skeletalInputText(expected);
  return { ok, landed };
}

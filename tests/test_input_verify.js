import { describe, it, expect } from 'vitest';
import { normalizeInputText, skeletalInputText, verifyInputText } from '../src/shared/input_verify.js';

// 这批用例全部来自真实投放现场。最有价值的是 **B站 read-editor**：往它的
// contenteditable 里 'type'/'setContent' 一段带换行的文本，回读到的内容里
// 每个语义换行都被渲染成了多个 \n。修校验口径之前，这类输入一律被判成
// `cdp-input-failed` —— 明明内容已经写上去了。

describe('normalizeInputText', () => {
  it('normalizes CRLF into LF', () => {
    expect(normalizeInputText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips typographic whitespace but keeps line breaks', () => {
    expect(normalizeInputText('  a  \t b  \n c ')).toBe('ab\nc');
  });

  it('collapses a run of newlines into one', () => {
    expect(normalizeInputText('a\n\n\n\n\nb')).toBe('a\nb');
  });

  it('never collapses away paragraph boundaries entirely', () => {
    // 最重要的不变量：把 \s 全剥掉会让 "a b" 和 "ab" 等价，也让
    // "a\nb" 和 "ab" 等价。段落结构丢了还判成功 = 谎报。
    expect(normalizeInputText('a\nb')).not.toBe(normalizeInputText('ab'));
  });
});

describe('skeletalInputText', () => {
  it('drops every line break, leaving pure content', () => {
    expect(skeletalInputText('a\n\n\nb\n c')).toBe('abc');
  });
});

describe('verifyInputText', () => {
  it('accepts content the editor reformatted with inflated line breaks (B站 read-editor)', () => {
    // 实测：输入 'AA\nBB'，回读 'AA\n\nBB'
    const r = verifyInputText('AA\nBB', 'AA\n\nBB');
    expect(r.ok).toBe(true);
    expect(r.landed).toBe(true);
  });

  it('accepts content whose newlines were inflated even more aggressively', () => {
    // 实测：输入三段以 '\n\n' 分隔的文本，回读得到 5 个连续换行
    const expected = '第一段。\n\n第二段。\n\n第三段结束。';
    const actual = '第一段。\n\n\n\n\n第二段。\n\n\n\n\n第三段结束。';
    const r = verifyInputText(expected, actual);
    expect(r.ok).toBe(true);
  });

  it('holds the idempotency short-circuit honest: identical text stays unchanged', () => {
    expect(verifyInputText('only one line', 'only one line').ok).toBe(true);
  });

  it('still fails loudly when the text genuinely did not land', () => {
    const r = verifyInputText('给 AI 装了浏览器', '完全无关的一句话');
    expect(r.ok).toBe(false);
    expect(r.landed).toBe(false);
  });

  it('reports landed=true even when only whitespace differs', () => {
    // 内容其实到位了、只是排版不同 —— 处置方式是"继续"，不是"重来"
    const r = verifyInputText('ab cd', 'a  b\n c  d');
    expect(r.ok).toBe(false);
    expect(r.landed).toBe(true);
  });

  it('treats residual empty blocks as cleared (clear action)', () => {
    // 浏览器永远会留一个空块承载光标，clear 之后残留 \n 是常态而非失败
    const r = verifyInputText('', '\n');
    expect(r.ok).toBe(true);
  });

  it('does not report cleared when real content remains', () => {
    expect(verifyInputText('', '还有字').ok).toBe(false);
  });
});

// tests/test_ref_guard.js — ui.act target 形状体检（纯函数）
// 坑的来源：target 传了可见文字（"发布"）而不是 data-ai-id，最终以
// `[data-ai-id="发布"]` 查空，回一句不带方向的 "Target not found"。
import { describe, it, expect } from 'vitest';
import { refShapeError, MAX_REF_LEN } from '../src/shared/ref_guard.cjs';

describe('refShapeError — reject shapes that cannot be ids', () => {
  it('RG-1: whitespace inside means it is a label, not an id', () => {
    const e = refShapeError('点击 发布按钮');
    expect(e).toContain('looks like visible text');
    expect(e).toContain('data-ai-id');
  });

  it('RG-1b: a pure-CJK string with no ASCII structure is a label, not an id (no space needed)', () => {
    // 真实站点上 agent 就是直接传 "发布" / "点击发布"，没有空格。树里的 ref
    // 要么带结构前缀（e:button-12 / axf-3-1）要么是 ASCII 原生 id，纯 CJK
    // 无 ASCII 的 id 实际不存在 —— 放行只会退化成无方向的 Target not found。
    for (const label of ['发布', '点击发布', '编辑器', '保存草稿']) {
      const e = refShapeError(label);
      expect(e, label).toContain('looks like visible text');
    }
    // 错误必须是可操作的：给出 id 形状 + 万一真是原生 id 的绕过方式
    expect(refShapeError('发布')).toContain('e:button-12');
    expect(refShapeError('发布')).toContain('ui.evaluate');
  });

  it('RG-2: over-long target is text, not an id', () => {
    const e = refShapeError('x'.repeat(MAX_REF_LEN + 1));
    expect(e).toContain('data-ai-id values are short');
  });

  it('RG-3: selector-ish input gets a pointed error', () => {
    expect(refShapeError('[data-ai-id="e:button-1"]')).toContain('starts with a quote/bracket');
    expect(refShapeError('#submit')).toBeNull(); // # 开头不是引号/括号，放行
  });

  it('RG-4: legitimate refs pass untouched', () => {
    for (const ok of ['e:button-12', 'axf-3-1', 'submit-btn', 'e:input-7', 'e:按钮-1', 'app', 'title-input__inner']) {
      expect(refShapeError(ok), ok + ' must pass').toBeNull();
    }
  });

  it('RG-5: empty/undefined is not this guard\'s business', () => {
    expect(refShapeError('')).toBeNull();
    expect(refShapeError(undefined)).toBeNull();
    expect(refShapeError(null)).toBeNull();
  });
});

// ---- CSS 选择器作为 target（仅 upload） ----
// 坑的来源：CSDN 的封面输入框没有 data-ai-id，只能用
// `.container-coverimage-box .el-upload__input` 定位；旧逻辑见到空白就当
// "可见文案"拒掉，逼得调用方退化成单类名选择器碰运气。
import { looksLikeCssSelector } from '../src/shared/ref_guard.cjs';

describe('refShapeError — upload 接受 CSS 选择器', () => {
  it('RG-6: 带空格的组合选择器在 upload 下放行', () => {
    for (const sel of [
      '.container-coverimage-box .el-upload__input',
      '.upload-button > input[type="file"]',
      '#panel .cover',
      '[data-testid="cover"] input',
    ]) {
      expect(refShapeError(sel, { allowSelector: true }), sel).toBeNull();
    }
  });

  it('RG-6b: 同一个选择器在别的动作下仍被拒（只有 upload 解析选择器）', () => {
    const e = refShapeError('.container-coverimage-box .el-upload__input');
    expect(e).toContain('looks like visible text');
  });

  it('RG-6c: 放行选择器不能把页面文案一起放进来', () => {
    // 中文文案：即便开了 allowSelector 也必须拒
    for (const label of ['点击 发布按钮', '添加封面 从本地上传', '选择 文件']) {
      expect(refShapeError(label, { allowSelector: true }), label).toContain('looks like visible text');
    }
    // 英文文案：没有选择器结构符（. # [ > *），不能被误当成后代选择器
    for (const label of ['Publish now', 'Choose File', 'upload local file']) {
      expect(refShapeError(label, { allowSelector: true }), label).not.toBeNull();
    }
  });

  it('RG-6d: looksLikeCssSelector 的边界', () => {
    expect(looksLikeCssSelector('.el-upload__input')).toBe(true);
    expect(looksLikeCssSelector('#f')).toBe(true);
    expect(looksLikeCssSelector('*')).toBe(true);
    expect(looksLikeCssSelector('div > input')).toBe(true);
    expect(looksLikeCssSelector('Publish now')).toBe(false);   // 无结构符
    expect(looksLikeCssSelector('.封面')).toBe(false);          // 含 CJK
    expect(looksLikeCssSelector('')).toBe(false);
    expect(looksLikeCssSelector(null)).toBe(false);
    // 逗号/分号不属于选择器常用字符集 → 不当选择器（防自然语言长句）
    expect(looksLikeCssSelector('.a, .b')).toBe(false);
  });

  it('RG-6e: 普通 ref 不受影响', () => {
    for (const ok of ['e:button-12', 'axf-3-1', 'submit-btn', 'app']) {
      expect(refShapeError(ok, { allowSelector: true }), ok).toBeNull();
    }
  });
});

// 选择器的回退候选：上传组件在"已有文件"状态会把上传区（连同内部那个永久隐藏的
// file input）整个卸载，只剩祖先容器。整条选择器查不到元素时，得靠祖先当锚点把它
// 重新点出来 —— 否则 `.box .el-upload__input` 这种写法必然失败。
import { selectorAncestors } from '../src/shared/ref_guard.cjs';

describe('selectorAncestors — 由长到短的回退候选', () => {
  it('RG-7: 后代选择器逐层退到祖先', () => {
    expect(selectorAncestors('.container-coverimage-box .el-upload__input'))
      .toEqual(['.container-coverimage-box .el-upload__input', '.container-coverimage-box']);
    expect(selectorAncestors('.a .b .c')).toEqual(['.a .b .c', '.a .b', '.a']);
    // 纯标签链里没有任何结构符，按 refShapeError 的口径本来就不算选择器
    // （防止 "Publish now" 这类英文文案被当成后代选择器），这里保持一致。
    expect(selectorAncestors('a b c')).toEqual(['a b c']);
  });

  it('RG-7b: 单段选择器原样返回（没有更短的退路）', () => {
    expect(selectorAncestors('.el-upload__input')).toEqual(['.el-upload__input']);
    expect(selectorAncestors('#cover')).toEqual(['#cover']);
  });

  it('RG-7c: 显式复合子只退到祖先，不做组合子放宽', () => {
    // 把 `>` 放宽成后代只会加大误命中面（可能点到页面别处的 input），而回退的
    // 目的单一：找到"这一层还在"的祖先当锚点。所以不给放宽版本。
    expect(selectorAncestors('.box > input[type="file"]')).toEqual(['.box > input[type="file"]', '.box']);
  });

  it('RG-7d: 属性值/伪类参数里的空格不拆开', () => {
    expect(selectorAncestors('.a [title="x y"] .b'))
      .toEqual(['.a [title="x y"] .b', '.a [title="x y"]', '.a']);
    expect(selectorAncestors('.a:not(.b .c) .d'))
      .toEqual(['.a:not(.b .c) .d', '.a:not(.b .c)']);
  });

  it('RG-7e: data-ai-id 形状的 target 不受影响（原样单元素）', () => {
    for (const ref of ['e:button-12', 'axf-3-1', 'submit-btn', 'app']) {
      expect(selectorAncestors(ref), ref).toEqual([ref]);
    }
    expect(selectorAncestors('')).toEqual([]);
    expect(selectorAncestors(null)).toEqual([]);
  });
});

// ---- deadline：paste 已在 P1-2 覆盖；这里回归 actionDeadlineMs 对 paste 的缩放 ----
import { actionDeadlineMs } from '../src/shared/deadline.js';

describe('actionDeadlineMs — paste still scales (regression)', () => {
  it('RG-DL-1: bigger payload → bigger budget', () => {
    const small = actionDeadlineMs('paste', { html: '<p>x</p>' });
    const big = actionDeadlineMs('paste', { html: '<p>' + 'y'.repeat(50000) + '</p>' });
    expect(big).toBeGreaterThan(small);
  });
});

// tests/test_validation_state.js — P2-2：必填态 / 无效态 / 校验错误
//
// 事故条件：掘金的红*必填不在 node.states，行内错误"至少添加一个标签"不在
// context 里 —— 两件事同时缺，于是 agent 提交了、页面拒绝了、回执里什么都没说。
//
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

let ns;
beforeAll(async () => {
  ns = (await import('../src/preload/extractor.cjs'))?.default;
});

// jsdom 不跑布局：isShown() 依赖 getClientRects/getBoundingClientRect，全给几何。
function renderAll() {
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    els[i].getClientRects = () => [{ width: 100, height: 20 }];
    els[i].getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 });
  }
}
function page(html) {
  document.body.innerHTML = html;
  renderAll();
  return { tree: ns.extractTree(), ctx: ns.extractPageContext() };
}
function find(tree, pred) {
  const out = [];
  (function w(n) { if (!n) return; if (pred(n)) out.push(n); for (const c of n.children || []) w(c); })(tree);
  return out;
}
const byId = (tree, id) => find(tree, (n) => n.id === id)[0];

describe('node.states — required / invalid (P2-2)', () => {
  it('VS-1: native required surfaces as states.required', () => {
    const { tree } = page('<form><label for="t">标题</label><input id="t" required></form>');
    expect(byId(tree, 't').states).toContain('required');
  });

  it('VS-2: aria-required=true counts too (component libraries skip the native attr)', () => {
    const { tree } = page('<div><input id="tag" aria-required="true"></div>');
    expect(byId(tree, 'tag').states).toContain('required');
  });

  it('VS-3: aria-invalid=true surfaces as states.invalid', () => {
    const { tree } = page('<div><input id="e" aria-invalid="true"></div>');
    expect(byId(tree, 'e').states).toContain('invalid');
  });

  it('VS-4: an error-state class on a near ancestor counts (antd/bootstrap pattern)', () => {
    const { tree } = page('<div class="ant-form-item has-error"><input id="p"></div>');
    expect(byId(tree, 'p').states).toContain('invalid');
  });

  it('VS-5: an empty required field is NOT invalid — :invalid fires before the user types anything', () => {
    // 若用 el.matches(':invalid')，每个空必填框一进页面就顶 invalid，信号变噪声。
    const { tree } = page('<form><input id="r" required></form>');
    const n = byId(tree, 'r');
    expect(n.states).toContain('required');
    expect(n.states || []).not.toContain('invalid');
  });

  it('VS-6: a clean field carries neither state (negative control)', () => {
    const { tree } = page('<form><input id="ok" placeholder="随便填"></form>');
    const st = byId(tree, 'ok').states || [];
    expect(st).not.toContain('required');
    expect(st).not.toContain('invalid');
  });
});

describe('context.validation_errors — [{text, near}] (P2-2)', () => {
  it('VS-7: an aria-invalid field exposes its message with a locator', () => {
    const { ctx } = page(`
      <div>
        <input id="title" aria-invalid="true" aria-describedby="title-err">
        <span id="title-err">标题不能为空</span>
      </div>`);
    expect(ctx.validation_errors).toBeTruthy();
    const hit = ctx.validation_errors.find((e) => e.text === '标题不能为空');
    expect(hit).toBeTruthy();
    expect(hit.near).toBe('title');
  });

  it('VS-8: an inline error next to a contenteditable tag field is associated (the 掘金 case)', () => {
    // 标签输入区不是 input/textarea，只数原生控件时这条错误永远关联不上字段。
    const { ctx } = page(`
      <div class="tag-editor">
        <div id="tag-input" contenteditable="true" aria-invalid="true"></div>
        <div class="error-tip">至少添加一个标签</div>
      </div>`);
    const hit = (ctx.validation_errors || []).find((e) => e.text === '至少添加一个标签');
    expect(hit).toBeTruthy();
    expect(hit.near).toBe('tag-input');
  });

  it('VS-9: no errors on a clean page means null, not an empty array', () => {
    const { ctx } = page('<form><input id="a" placeholder="标题"><button>保存</button></form>');
    expect(ctx.validation_errors).toBeNull();
  });

  it('VS-10: an error message is never attributed to the wrong field', () => {
    // 同一容器里两个控件时，fieldOf 拒绝猜测 —— 宁可 near 为空，也不报错配。
    const { ctx } = page(`
      <div>
        <input id="a"><input id="b">
        <span class="error">账号或密码错误</span>
      </div>`);
    const hit = (ctx.validation_errors || []).find((e) => e.text === '账号或密码错误');
    if (hit) expect(hit.near).not.toBe('a'); // 不允许猜成某一个字段
  });
});

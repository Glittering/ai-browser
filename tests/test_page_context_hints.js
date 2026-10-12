// tests/test_page_context_hints.js — 顶层 context 的 hints / required_hints / fields 形状
//
// 本轮三条修复的回归（src/preload/extractor.cjs）：
//   #1 裸 <span>/<div> 辅助文案进 context.hints。语义树**仍然**没有它 —— isPureLayout
//      剪掉裸 div/span 是在压 token 体积，那个取舍不动，动的是"读不到的代价"。
//   #2 必填红星扫描从 modal 循环搬到整文档 + 顶层 context.required_hints
//      （原先"红星能否被读到"取决于容器 class 里有没有 modal/dialog/popup 关键词）。
//   #3 context.modals[].fields[] 条目带 id，与 forms[].fields[] 同构
//      （原先弹窗里有多个同类输入框时，error/required 对应不到具体元素）。
//
// 断言政策：每条"应该收不到"的测试都配一条阳性对照（同一条文案换个位置就该收到），
// 否则观测一失效就永远绿。
// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

let ns;
beforeAll(async () => {
  ns = (await import('../src/preload/extractor.cjs'))?.default;
});

// jsdom 不跑布局：getClientRects() 恒为空、getBoundingClientRect() 恒为 0，而 isShown()
// 两者都看。这些测试关心的是"文案收没收"，不是可见性判定，所以给全文档元素补几何；
// 可见性本身由单独一条测试覆盖（display:none 的那条，inline style 仍会被判 Hidden）。
function renderAll() {
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    els[i].getClientRects = () => [{ width: 100, height: 20 }];
    els[i].getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20,
    });
  }
}
function page(html) {
  document.body.innerHTML = html;
  renderAll();
  return ns.extractPageContext();
}
// jsdom 不实现 innerText（恒 undefined），而「请填写」类信号走的是 innerText。真实
// Chromium 里有它；单测补一个最小实现（压平空白），只为让那条信号可测。
function stubInnerText() {
  if (document.body.innerText === undefined) {
    Object.defineProperty(document.body, 'innerText', {
      configurable: true,
      get() { return (this.textContent || '').replace(/\s+/g, ' '); },
    });
  }
}
const has = (arr, pred) => (arr || []).some((x) => pred(String(x)));

// ===========================================================================
describe('顶层 context.hints — 裸 span/div 辅助文案', () => {
  it('CTX-001: 形状是 N/M 的裸 span（父元素就是 body）进 hints', () => {
    const ctx = page('<span id="c1">0/256</span>');
    expect(has(ctx.hints, (h) => /^\d+\/256$/.test(h.trim()))).toBe(true);
  });

  it('CTX-002: 紧贴表单控件的裸 span 说明文案进 hints（无 class、形状也不是 N/M）', () => {
    const ctx = page(
      '<div class="row"><label for="a">头像</label><input id="a">' +
      '<span id="h">支持 jpg/png，单张不超过 5MB</span></div>');
    expect(has(ctx.hints, (h) => h.indexOf('jpg/png') >= 0)).toBe(true);
  });

  // 阳性对照：同一条文案，只把位置挪出表单控件的容器 —— 就必须收不到。
  // 没有这一条，CTX-002 可能是被别的扫描顺带满足的，证伪不了"紧凑容器"这个条件。
  it('CTX-003: 同一条文案不在表单控件旁边就收不到（CTX-002 的阴性对照）', () => {
    const ctx = page(
      '<div id="far"><p>文章正文</p><span id="h">支持 jpg/png，单张不超过 5MB</span></div>');
    expect(has(ctx.hints, (h) => h.indexOf('jpg/png') >= 0)).toBe(false);
  });

  it('CTX-004: 字段自己的 label 文案不会被重复收进 hints（树里已经有了）', () => {
    const ctx = page('<div class="row"><label for="a">头像</label><input id="a"></div>');
    expect(has(ctx.hints, (h) => h.trim() === '头像')).toBe(false);
  });

  it('CTX-005: display:none 的辅助文案不进 hints', () => {
    const ctx = page(
      '<div class="row"><label for="a">头像</label><input id="a">' +
      '<span id="h" style="display:none">支持 jpg/png，单张不超过 5MB</span></div>');
    expect(has(ctx.hints, (h) => h.indexOf('jpg/png') >= 0)).toBe(false);
  });

  it('CTX-006: 容器过大时不顺着它把整页文本灌进来', () => {
    let big = '<div class="row"><label for="a">简介</label><textarea id="a"></textarea>';
    for (let i = 0; i < 40; i++) big += '<span>第' + i + '段正文文字</span>';
    big += '</div>';
    const ctx = page(big);
    expect(has(ctx.hints, (h) => /第\d+段正文文字/.test(h))).toBe(false);
  });
});

// ===========================================================================
describe('顶层 context.required_hints — 必填红星整文档扫描', () => {
  it('CTX-010: 普通页面（容器 class 没有任何 modal 关键词）的红星进顶层 required_hints', () => {
    const ctx = page(
      '<div class="row"><label for="a">姓名<span class="req-star">*</span></label><input id="a"></div>');
    expect(has(ctx.required_hints, (h) => h.indexOf('姓名') >= 0)).toBe(true);
  });

  it('CTX-011: 弹窗容器里的红星同样进顶层 required_hints（搬迁后能力没丢）', () => {
    const ctx = page(
      '<div class="publish-modal"><label for="m">标题<span class="req-star">*</span></label>' +
      '<input id="m"><button>确定</button></div>');
    expect(has(ctx.required_hints, (h) => h.indexOf('标题') >= 0)).toBe(true);
  });

  it('CTX-012: modals[].required_hints 已删除（唯一实现在顶层，避免两份漂移）', () => {
    const ctx = page(
      '<div class="modal"><label for="m">标题<span class="req-star">*</span></label>' +
      '<input id="m"><button>确定</button></div>');
    for (const m of (ctx.modals || [])) expect(m.required_hints).toBeUndefined();
  });

  it('CTX-013: 字数上限 N/M 不进 required_hints（会冒充必填），它归 hints', () => {
    const ctx = page(
      '<div class="row"><label for="a">简介</label><textarea id="a"></textarea>' +
      '<span id="cnt">0/256</span></div>');
    expect(has(ctx.required_hints, (h) => /\d+\s*\/\s*\d+/.test(h))).toBe(false);
    expect(has(ctx.hints, (h) => /\d+\s*\/\s*\d+/.test(h))).toBe(true);
  });

  // 这条是搬扫描的直接后果：老实现在 modal 容器里顺带收 N/M 和「字数」，搬到整文档
  // 后任何正文含"字数"二字的页面都会报出一堆必填提示。实测 richtext 编辑器页曾报
  // ["字数统计测试","字数 6/256","6/256"]，而那一页一个表单控件都没有。
  it('CTX-014: 没有表单控件、正文含「字数」的页面，required_hints 为空', () => {
    stubInnerText();
    const ctx = page('<p>字数统计测试</p><span>6/256</span>');
    expect(ctx.required_hints == null || ctx.required_hints.length === 0).toBe(true);
  });

  it('CTX-015: 孤零零的红星字符不进 required_hints（不说明任何字段必填）', () => {
    const ctx = page('<span class="req-star">*</span>');
    expect((ctx.required_hints || []).includes('*')).toBe(false);
    expect(has(ctx.required_hints, (h) => !/[一-龥A-Za-z0-9]/.test(h))).toBe(false);
  });

  it('CTX-016: 「请填写」类文案进 required_hints', () => {
    stubInnerText();
    const ctx = page('<p>请填写邮箱后再提交</p>');
    expect(has(ctx.required_hints, (h) => h.indexOf('请填写') >= 0)).toBe(true);
  });

  it('CTX-017: 全角红星（＊）也认，同样收它所在那一行的文案', () => {
    const ctx = page(
      '<div class="row"><label for="a">手机<span class="req-star">＊</span></label><input id="a"></div>');
    expect(has(ctx.required_hints, (h) => h.indexOf('手机') >= 0)).toBe(true);
  });
});

// ===========================================================================
describe('context.modals[].fields[] — 与 forms[].fields[] 同构', () => {
  it('CTX-020: 弹窗字段条目带 id，且 id 是真实 DOM id', () => {
    const ctx = page(
      '<div class="modal"><label for="m">标题</label><input id="mTitle" required>' +
      '<textarea id="mBody"></textarea><button>确定</button></div>');
    const fields = ((ctx.modals || [])[0] || {}).fields || [];
    expect(fields.map((f) => f.id)).toEqual(['mTitle', 'mBody']);
    expect(document.getElementById('mTitle')).not.toBeNull();
    expect(document.getElementById('mBody')).not.toBeNull();
  });

  // 注意：不能只做"两条路径互相比对"—— 那样两边同时丢掉 id 也还是"一致"（实测：
  // 拔掉 id 后 CTX-020 转红而互比对那条照绿）。必须同时钉住期望键集合本身。
  it('CTX-021: 字段条目的键集合就是 {id,type,placeholder,required}，两条路径一致', () => {
    const ctx = page(
      '<form><div class="row"><label for="f">姓名</label><input id="f" required></div></form>' +
      '<div class="modal"><div class="row"><label for="m">标题</label>' +
      '<input id="m" required></div><button>确定</button></div>');
    const formField = ((ctx.forms || [])[0].fields || [])[0];
    const modalField = ((ctx.modals || [])[0].fields || [])[0];
    const want = ['id', 'placeholder', 'required', 'type'];
    expect(Object.keys(formField).sort()).toEqual(want);
    expect(Object.keys(modalField).sort()).toEqual(want);
  });

  it('CTX-022: aria-describedby 列多个 id 时逐个查（老代码把整串当单个 id，永远查不到）', () => {
    const ctx = page(
      '<div class="modal"><input id="m" aria-describedby="err hint">' +
      '<span id="err">标题不能为空</span><span id="hint">不超过 40 字</span>' +
      '<button>确定</button></div>');
    const f = ((ctx.modals || [])[0].fields || [])[0];
    expect(f.error).toBe('标题不能为空');
  });

  it('CTX-023: aria-errormessage 也能指到错误', () => {
    const ctx = page(
      '<div class="modal"><input id="a" aria-errormessage="e">' +
      '<span id="e">手机格式不对</span><button>确定</button></div>');
    const f = ((ctx.modals || [])[0].fields || [])[0];
    expect(f.error).toBe('手机格式不对');
  });

  // 老代码的容器错误查找没有"容器内恰好一个输入"的约束：同容器多个字段时，每个字段
  // 都会挂上同一条错误（谁都不对应，纯误导）。加上约束后这种情况宁空着也不猜。
  it('CTX-024: 同容器多个输入时，不把同一条错误安到每个字段头上', () => {
    const ctx = page(
      '<div class="modal"><div class="row"><input id="a"><input id="b">' +
      '<span class="field-error">这条错误不属于任何一个字段</span></div>' +
      '<button>确定</button></div>');
    for (const f of ((ctx.modals || [])[0].fields || [])) expect(f.error).toBeUndefined();
  });

  // 上一条的阳性对照：容器内恰好一个输入时，才认容器里的错误元素。
  it('CTX-025: 容器内恰好一个输入时，认容器里的错误元素', () => {
    const ctx = page(
      '<div class="modal"><div class="row"><input id="a">' +
      '<span class="field-error">姓名不能为空</span></div><button>确定</button></div>');
    const f = ((ctx.modals || [])[0].fields || [])[0];
    expect(f.error).toBe('姓名不能为空');
  });
});

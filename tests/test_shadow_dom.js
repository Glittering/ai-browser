// tests/test_shadow_dom.js — Web Component（影子 DOM）里的元素：读得到、也点得动。
// @vitest-environment jsdom
//
// 背景（2026-10-17 真实站点验证）：B站 opus 帖子详情页的整块评论区装在
// <bili-comments> 的 shadow root 里。修复前：
//   · DOM 语义树只有 45 个节点，评论面板是个空 tabpanel（el.children 看不到 shadow）
//   · AX 通路能看到 190 个节点，但 ui.act 用 ax-291 报 "Target not found for ref"
//     （AX id 只在 AX 侧，动作层按 data-ai-id 在 DOM 里找，两次都够不着）
// 也就是说：不是某个站点的选择器写错了，而是"影子 DOM"这条通路整条缺失。
//
// 修复分两半，这个文件两半都钉住：
//   读 —— extractor.cjs 的 childrenOf() 下探 el.shadowRoot
//   写 —— actions.cjs 的 findRef() / shared/find_ref.cjs 的 findRefExpr 穿透 shadow

import { describe, it, expect, beforeAll } from 'vitest';

let extractTree;
let actions;
let findRefExpr;

beforeAll(async () => {
  // jsdom 的 getBoundingClientRect 恒为 0，会让"可见尺寸"判据把所有元素都否掉
  // （SD-2 走的是"人看着能点"那条通路，需要真实尺寸）。data-w/data-h 可覆盖。
  Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.dataset && this.dataset.w ? this.dataset.w : 100);
    const h = Number(this.dataset && this.dataset.h ? this.dataset.h : 40);
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  };
  const ex = await import('../src/preload/extractor.cjs');
  extractTree = (ex.default || ex).extractTree;
  const ac = await import('../src/preload/actions.cjs');
  actions = ac.default || ac;
  const fr = await import('../src/shared/find_ref.cjs');
  findRefExpr = (fr.default || fr).findRefExpr;
});

function flatten(n, out = []) {
  if (!n) return out;
  out.push(n);
  (n.children || []).forEach((c) => flatten(c, out));
  return out;
}

function byId(tree, id) {
  return flatten(tree).find((n) => n.id === id) || null;
}

// 影子根里的内容 document.querySelector 看不到，测试里需要显式拿 host.shadowRoot
function makeHost(html, mode = 'open') {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById('host');
  const sr = host.attachShadow({ mode });
  sr.innerHTML = html;
  return { host, sr };
}

describe('SD 影子 DOM —— 读取（extractor）', () => {
  it('SD-1: 影子根里的 button 进语义树', () => {
    makeHost('<button id="inShadow">发送</button>');
    const tree = extractTree();
    // 顶层 document.querySelector 确认拿不到 —— 证明这个断言真的依赖穿透
    expect(document.querySelector('#inShadow')).toBeNull();
    const n = byId(tree, 'inShadow');
    expect(n, '影子根里的按钮必须进树').toBeTruthy();
    expect(n.role).toBe('button');
  });

  it('SD-2: 影子根里的可点 div（cursor:pointer + 文本）也进树', () => {
    // 这条走的是"人看着能点"的判定，顺带证明 childrenOf 在语义/非语义两条分支都生效
    makeHost('<div id="shadowClickable" style="cursor:pointer">发布</div>');
    const n = byId(extractTree(), 'shadowClickable');
    expect(n).toBeTruthy();
    expect(n.actions || []).toContain('click');
  });

  it('SD-3: 嵌套影子根（shadow 里再套 shadow）也能读到', () => {
    const { sr } = makeHost('<div id="mid"><button id="deep">深层按钮</button></div>');
    const mid = sr.getElementById('mid');
    const inner = mid.attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id="deepest">最深层</button>';
    const tree = extractTree();
    expect(byId(tree, 'deepest'), '两层 shadow 里的按钮也要进树').toBeTruthy();
  });

  it('SD-4: closed 影子根按设计读不到，且不抛错（不能为它去做绕过）', () => {
    makeHost('<button id="sealed">密封</button>', 'closed');
    expect(() => extractTree()).not.toThrow();
    expect(byId(extractTree(), 'sealed')).toBeNull();
  });
});

describe('SD 影子 DOM —— 动作（findRef）', () => {
  it('SD-5: actions.findRef 能穿透 shadow 找到元素', () => {
    makeHost('<button data-ai-id="s-act-1">发送</button>');
    expect(document.querySelector('[data-ai-id="s-act-1"]')).toBeNull(); // 前提：顶层查不到
    const el = actions.findRef(document, 's-act-1');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('发送');
  });

  it('SD-6: findRefExpr 生成的表达式与运行时实现等价（主进程注入的就是它）', () => {
    makeHost('<button data-ai-id="s-act-2">确认</button>');
    // 主进程把这段表达式拼进页面脚本，这里用 Function 模拟同样的执行环境
    const expr = findRefExpr(JSON.stringify('s-act-2'));
    const el = new Function('document', 'return ' + expr)(document);
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('确认');
  });

  it('SD-7: 回归 —— 顶层（不在 shadow 里）的元素照样能找到', () => {
    document.body.innerHTML = '<button data-ai-id="s-top-1">顶层</button>';
    expect(actions.findRef(document, 's-top-1')).toBeTruthy();
    const el = new Function('document', 'return ' + findRefExpr(JSON.stringify('s-top-1')))(document);
    expect(el).toBeTruthy();
  });

  it('SD-8: 找不到时返回 null（不抛），调用方仍能报出可读的 not found', () => {
    document.body.innerHTML = '<div>nothing</div>';
    expect(actions.findRef(document, 'nope')).toBeNull();
    const el = new Function('document', 'return ' + findRefExpr(JSON.stringify('nope')))(document);
    expect(el).toBeNull();
  });

  it('SD-9: 嵌套 shadow 里的元素也能被 findRef 找到（递归要有深度）', () => {
    const { sr } = makeHost('<div id="lvl1"></div>');
    const lvl2 = sr.getElementById('lvl1').attachShadow({ mode: 'open' });
    lvl2.innerHTML = '<div id="lvl2"></div>';
    const lvl3 = lvl2.getElementById('lvl2').attachShadow({ mode: 'open' });
    lvl3.innerHTML = '<button data-ai-id="s-deep-1">深层</button>';
    const el = actions.findRef(document, 's-deep-1');
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('深层');
  });

  // ---- 句柄来自元素原生 id 时，查找必须认 getElementById ----
  //
  // 实测（Notion，2026-10-30）：空段落叶子 id=":r6:"、data-ai-id 写上去立刻被
  // React 重渲染抹成空。抽取器没有 data-ai-id 时用原生 id 当句柄
  // （`existingAiId || nativeId`），于是 get_tree 报 :r6:，而 type 报
  // "Target not found for ref: :r6:" —— 读得到、打不进。
  it('SD-10: 只有原生 id（data-ai-id 被抹掉）时仍能找到', () => {
    document.body.innerHTML = '<div id=":r6:" contenteditable="true">段落</div>';
    // 前提：属性确实不在（模拟被框架抹掉的真实状态），不能靠 data-ai-id 侥幸命中
    expect(document.querySelector('[data-ai-id=":r6:"]')).toBeNull();
    expect(actions.findRef(document, ':r6:')).toBeTruthy();
    const el = new Function('document', 'return ' + findRefExpr(JSON.stringify(':r6:')))(document);
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('段落');
  });

  it('SD-11: 两种命中方式都成立时不冲突（data-ai-id 优先，值不同也能各找各的）', () => {
    document.body.innerHTML = '<div id="native-1" data-ai-id="e:div-9">x</div>';
    expect(actions.findRef(document, 'e:div-9').id).toBe('native-1');
    expect(actions.findRef(document, 'native-1')).toBe(actions.findRef(document, 'e:div-9'));
    const el = new Function('document', 'return ' + findRefExpr(JSON.stringify('native-1')))(document);
    expect(el && el.id).toBe('native-1');
  });

  it('SD-12: 原生 id 兜底不会把"不存在"变成"乱命中"', () => {
    document.body.innerHTML = '<div id="other">x</div>';
    expect(actions.findRef(document, 'native-1')).toBeNull();
    const el = new Function('document', 'return ' + findRefExpr(JSON.stringify('native-1')))(document);
    expect(el).toBeNull();
  });
});

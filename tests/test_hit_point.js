// tests/test_hit_point.js — 命中探测必须穿透影子根。
// @vitest-environment jsdom
//
// 缺陷（2026-10-18 实测，B站 视频页评论区，整块装在 <bili-comments> 的 shadow 里）：
//   树里给的坐标 {x:733,y:377,24x24} 是准的，但
//   document.elementFromPoint(745,389) 返回的是宿主 bili-comments，
//   于是 `h===el || el.contains(h)` 恒为 false —— 点击前的"坐标会不会落在目标上"
//   校验**对影子内部元素永远失败**，点击每次都静默降级成非受信的 el.click()。
//   降级不报错，所以现象是"能点，但对只认真指针序列的编辑器没反应"。
//
// 这个文件把两类判定都钉住：
//   下钻  —— shadowRoot.elementFromPoint 逐级钻（DocumentOrShadowRoot 标准 API）
//   上溯  —— 跨 shadow 后 Node.contains 失效，必须写 parentNode || ShadowRoot.host
//
// 打桩方式：jsdom 没有 elementFromPoint，这里按**浏览器真实语义**补上：
//   · 落在某点时，浏览器给出的命中链就是"真·最深元素"的祖先链；
//   · document.elementFromPoint 给出这条链上第一个属于文档树的元素（也就是宿主）；
//   · shadowRoot.elementFromPoint 给出这条链上第一个属于该影子树的元素。
// 所以只要预先指定"这个点的真·最深元素是 E"，两级的返回值就能算出来，
// 而不用真的实现层叠/命中测试 —— 要测的是下钻与上溯的逻辑，不是排版。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let hp;

beforeAll(async () => {
  const mod = await import('../src/shared/hit_point.cjs');
  hp = mod.default || mod;
});

// ---- 打桩 ------------------------------------------------------------------

// 上溯一步：影子树的顶是 ShadowRoot，它的 parentNode 是 null，要靠 .host 跳出去。
const up = (n) => n.parentNode || n.host || null;

// cur 是否位于 root **自己的**节点树里（严格 parentNode，不跨 shadow）。
// 影子树的子节点往上走是 ShadowRoot → null，永远到不了 document —— 这正是
// `document.contains(shadowChild) === false` 的由来。
const strictIn = (root, cur) => {
  let n = cur;
  while (n) { if (n === root) return true; n = n.parentNode; }
  return false;
};

// 按浏览器语义造一个 elementFromPoint：从真·最深元素沿祖先链（含 host 跳）往上走，
// 返回第一个属于 root 自己树里的元素。
const makeFromPoint = (root) => (x, y) => {
  const el = globalThis.__TRUE_HIT;
  if (!el) return null;
  let cur = el;
  while (cur) { if (strictIn(root, cur)) return cur; cur = up(cur); }
  return null;
};

// 给 document 和所有 shadow root 装上命中探测。
function installHit(...roots) {
  for (const r of roots) {
    try { Object.defineProperty(r, 'elementFromPoint', { value: makeFromPoint(r), configurable: true, writable: true }); } catch (e) {}
  }
}

// 当前"真·最深元素"
const setHit = (el) => { globalThis.__TRUE_HIT = el; };

const evalExpr = (expr) => new Function('return ' + expr)();

// ---- 用例 ------------------------------------------------------------------

describe('HP — 命中探测穿透 shadow', () => {
  let host2, inner, host3, mid, deep, plain, lid, covered;

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="host2"></div><div id="host3"></div><div id="host4"></div>' +
      '<div id="plain"></div><div id="lid"></div>';
    plain = document.getElementById('plain');
    plain.setAttribute('data-ai-id', 'A-plain');
    lid = document.getElementById('lid');
    lid.setAttribute('data-ai-id', 'X-lid');

    // B：一层 shadow
    host2 = document.getElementById('host2');
    const sr2 = host2.attachShadow({ mode: 'open' });
    inner = document.createElement('button');
    inner.setAttribute('data-ai-id', 'B-inner');
    sr2.appendChild(inner);

    // C：两层 shadow
    host3 = document.getElementById('host3');
    const sr3 = host3.attachShadow({ mode: 'open' });
    mid = document.createElement('div');
    sr3.appendChild(mid);
    const sr3b = mid.attachShadow({ mode: 'open' });
    deep = document.createElement('button');
    deep.setAttribute('data-ai-id', 'C-deep');
    sr3b.appendChild(deep);

    // D：shadow 里被外部浮层盖住
    const host4 = document.getElementById('host4');
    const sr4 = host4.attachShadow({ mode: 'open' });
    covered = document.createElement('button');
    covered.setAttribute('data-ai-id', 'D-covered');
    sr4.appendChild(covered);

    installHit(document, sr2, sr3, sr3b, sr4);
    setHit(null);
  });

  // HP-1 对照：裸元素，两种口径都必须为真（防"修完反而把普通情形修坏"）。
  it('HP-1 裸元素（无 shadow）：命中判定为真', () => {
    setHit(plain);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('A-plain'), '80', '220'))).toBe(true);
  });

  // HP-2 核心回归：一层 shadow。旧口径为假（返回宿主），新口径为真。
  it('HP-2 一层 shadow：旧口径恒假、新口径为真', () => {
    setHit(inner);
    // 旧式判定：拿到的是宿主 host2，既不等于目标、也不被目标包含
    const flat = document.elementFromPoint(80, 40);
    expect(flat).toBe(host2);
    expect(flat === inner || inner.contains(flat)).toBe(false);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('B-inner'), '80', '40'))).toBe(true);
  });

  // HP-3 两层 shadow：必须钻两次。
  it('HP-3 两层 shadow：逐级下钻后命中', () => {
    setHit(deep);
    expect(document.elementFromPoint(80, 100)).toBe(host3);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('C-deep'), '80', '100'))).toBe(true);
  });

  // HP-4 阴性：被盖住时必须判"没命中"，不能因为换了算法就放行。
  it('HP-4 shadow 内的目标被浮层盖住：判否', () => {
    setHit(lid); // 真·命中是盖在上面的浮层，不是 shadow 里那个按钮
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('D-covered'), '80', '160'))).toBe(false);
  });

  // HP-5 目标是宿主本身、命中落在它的 shadow 内部：旧口径也为真，防回归。
  it('HP-5 目标是宿主、命中在其 shadow 内：仍为真', () => {
    host2.setAttribute('data-ai-id', 'H-host');
    setHit(inner);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('H-host'), '80', '40'))).toBe(true);
  });

  // HP-6 目标是 shadow 宿主在外的父元素。
  it('HP-6 目标是宿主的外层父元素：为真', () => {
    document.body.setAttribute('data-ai-id', 'P-body');
    setHit(deep);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('P-body'), '80', '100'))).toBe(true);
  });

  // HP-7 命中旁人：必须判否。
  it('HP-7 命中另一个无关元素：判否', () => {
    setHit(lid);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('A-plain'), '80', '220'))).toBe(false);
  });

  // HP-8 id 不存在：拿不到 el，必须是 false 而不是抛错。
  it('HP-8 id 不存在：返回 false（不抛）', () => {
    setHit(plain);
    expect(evalExpr(hp.hitTestExpr(JSON.stringify('nope-404'), '80', '220'))).toBe(false);
  });

  // HP-9 错抓检测：原来用 closest('[data-ai-id]')，跨不过 shadow，
  // 影子内部的元素永远得到 id:null → is_target 恒真 → 检测被静默跳过。
  it('HP-9 hitInfoExpr 在 shadow 内取得到 data-ai-id', () => {
    setHit(deep);
    const info = evalExpr(hp.hitInfoExpr('80', '100'));
    expect(info).not.toBeNull();
    expect(info.id).toBe('C-deep');
  });

  // HP-10 错抓检测的阳性面：抓错了要报出**实际**是誰。
  it('HP-10 hitInfoExpr 报出实际命中的元素（抓错节点可被发现）', () => {
    setHit(lid);
    const info = evalExpr(hp.hitInfoExpr('80', '160'));
    expect(info.id).toBe('X-lid');
  });

  // HP-11 表达式自包含：能在没有任何闭包的上下文里求值（new Function 已经证明）。
  // 单独钉一条，防止以后有人把它改成依赖调用方变量。
  it('HP-11 生成的表达式不依赖外部变量', () => {
    const src = hp.hitTestExpr(JSON.stringify('B-inner'), '1', '2');
    expect(src.startsWith('(function()')).toBe(true);
    expect(() => new Function('return ' + src)).not.toThrow();
  });

  // HP-12 防御：页面里套娃 shadow 时不能转不出来（这段 JS 是在页面上下文同步跑的）。
  it('HP-12 下钻有上限，套娃 shadow 不死循环', () => {
    let cur = document.body;
    const roots = [document];
    let deepest = null;
    for (let i = 0; i < hp.MAX_DEPTH + 4; i++) {
      const sr = cur.attachShadow({ mode: 'open' });
      const d = document.createElement('div');
      sr.appendChild(d);
      roots.push(sr);
      cur = d;
      deepest = d;
    }
    deepest.setAttribute('data-ai-id', 'ZZ-deep');
    installHit(...roots);
    setHit(deepest);
    const got = evalExpr(hp.deepHitExpr('1', '1'));
    expect(got).toBeTruthy();
    // 触到上限，所以拿到的不是最深的那个 —— 证明上限真的生效、而不是碰巧钻到底
    expect(got).not.toBe(deepest);
  });
});

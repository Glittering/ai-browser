// tests/test_floating_layer.js — 脱流浮层（下拉菜单/弹出面板）里的每一项：单独成节点。
// @vitest-environment jsdom
//
// 背景（2026-10-17 真实站点）：B站 动态卡片的「更多」菜单里，「置顶 / 删除」是纯 div，
// 没有 role、没有 aria。它们的 cursor:pointer 是**从触发按钮继承**下来的，于是
// "父元素 pointer 就抑制"的边界规则把整张菜单一路并进了触发按钮 —— 语义树里只剩
// 一个 label 为 "取消置顶  删除" 的节点，看着像拿到了入口，实际点不了。
//
// 修法：识别"脱流且溢出了父块的浮层根"，浮层内部只收最内层的可点元素。
//
// 这些用例同时对冲另一头的风险：规则放宽容易把"卡片里每个装饰都收一遍"放回来
// （CSDN 上会从 254 涨到 840），所以 FL-2/FL-3 是**阴性**用例，必须保持不涨。

import { describe, it, expect, beforeAll } from 'vitest';

let extractTree;

beforeAll(async () => {
  // jsdom 没有布局：默认给 100×40，需要几何的用例用 data-rect 显式指定
  // "x,y,w,h"（浮层判定依赖"盒子是否溢出父块"，只靠宽高不够）。
  Element.prototype.getBoundingClientRect = function () {
    const raw = this.dataset && this.dataset.rect;
    if (raw) {
      const [x, y, w, h] = String(raw).split(',').map(Number);
      return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
    }
    const w = Number(this.dataset && this.dataset.w ? this.dataset.w : 100);
    const h = Number(this.dataset && this.dataset.h ? this.dataset.h : 40);
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  };
  const ex = await import('../src/preload/extractor.cjs');
  extractTree = (ex.default || ex).extractTree;
});

function flatten(n, out = []) {
  if (!n) return out;
  out.push(n);
  (n.children || []).forEach((c) => flatten(c, out));
  return out;
}

const labels = (tree) => flatten(tree).map((n) => String(n.label || '').trim());
const clickable = (tree) =>
  flatten(tree).filter((n) => (n.actions || []).includes('click'));

// B站 那张菜单的最小复刻：
//   触发区(cursor:auto) > 触发层(absolute,24×24) > 浮层(absolute,140×106，溢出父块)
//     > 项(140×40) > 包装 > label
function biliMenuHtml() {
  return `
    <div id="trigger" style="cursor:auto" data-rect="920,340,24,24">
      <div id="tp" style="position:absolute;cursor:pointer" data-rect="927,337,24,24">
        <div id="popup" style="position:absolute;cursor:pointer" data-rect="812,369,140,106">
          <div id="item1" style="cursor:pointer" data-rect="813,422,140,40">
            <div style="cursor:pointer" data-rect="840,393,86,18">
              <div style="cursor:pointer" data-rect="840,393,26,18">
                <div id="label1" style="cursor:pointer" data-rect="840,393,26,18">取消置顶</div>
              </div>
            </div>
          </div>
          <div id="item2" style="cursor:pointer" data-rect="813,462,140,40">
            <div style="cursor:pointer" data-rect="840,433,86,18">
              <div style="cursor:pointer" data-rect="840,433,26,18">
                <div id="label2" style="cursor:pointer" data-rect="840,433,26,18">删除</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

describe('FL 脱流浮层 —— 菜单项独立成节点', () => {
  it('FL-1: 浮层里的纯 div 菜单项各自是独立可点节点', () => {
    document.body.innerHTML = biliMenuHtml();
    const tree = extractTree();
    const cl = clickable(tree);
    const del = cl.find((n) => String(n.label).trim() === '删除');
    const top = cl.find((n) => String(n.label).trim() === '取消置顶');
    expect(del, '「删除」必须作为可点节点出现').toBeTruthy();
    expect(top, '「取消置顶」必须作为可点节点出现').toBeTruthy();
    // 两个不同的目标，不能是同一个节点被复用
    expect(del.id).not.toBe(top.id);
  });

  it('FL-2: 浮层里的多层包装只收最内层，不出现"包装节点 + 叶子节点"两份', () => {
    document.body.innerHTML = biliMenuHtml();
    const tree = extractTree();
    const dels = clickable(tree).filter((n) => String(n.label).trim() === '删除');
    expect(dels.length, '一个菜单项只能出一个节点').toBe(1);
  });

  it('FL-3: 菜单文本不再被并进触发按钮的 label', () => {
    document.body.innerHTML = biliMenuHtml();
    const tree = extractTree();
    const merged = labels(tree).filter((l) => l.includes('取消置顶') && l.includes('删除'));
    expect(merged, '不应该再有把整张菜单合并成一个节点的 label').toEqual([]);
  });

  it('FL-4（阴性）: 普通卡片里的小链接仍然不吞掉外层卡片', () => {
    // CSDN 场景：可点卡片里放一个小链接，两者是不同目标，两条通路都要留，
    // 但**不能**变成"卡片里每个 div 都收一遍"。
    document.body.innerHTML = `
      <div id="card" style="cursor:pointer" data-rect="0,0,600,300">
        <span id="title" style="cursor:pointer" data-rect="10,10,200,20">标题</span>
        <a id="link" href="#" style="cursor:pointer" data-rect="10,200,80,20">详情</a>
      </div>`;
    const tree = extractTree();
    const titleNodes = clickable(tree).filter((n) => String(n.label).trim() === '标题');
    expect(titleNodes.length, '静态容器里的文字不应因为 cursor 继承而单独成节点').toBe(0);
  });

  it('FL-5（阴性）: 整页绝对定位但不溢出父块，不按浮层处理', () => {
    // 全绝对定位布局的 SPA：一旦把"脱流"当成"浮层"，节点数会失控。
    document.body.innerHTML = `
      <div id="shell" style="position:relative" data-rect="0,0,1200,800">
        <div id="panel" style="position:absolute;cursor:pointer" data-rect="0,0,1200,800">
          <div id="box" style="cursor:pointer" data-rect="10,10,300,100">
            <div id="txt" style="cursor:pointer" data-rect="10,10,200,20">整页布局里的文字</div>
          </div>
        </div>
      </div>`;
    const tree = extractTree();
    // 边界仍然落在 panel（最外层手型块），只有它带这个名字；
    // box / txt 作为被继承的装饰**不得**单独成节点。
    const sameRectAsTxt = clickable(tree).filter((n) => n.bounds
      && n.bounds.width === 200 && n.bounds.height === 20);
    expect(sameRectAsTxt.length, '内层文字块不应单独成节点').toBe(0);
    const carries = clickable(tree).filter((n) => String(n.label).trim() === '整页布局里的文字');
    expect(carries.length, '名字只应挂在这一个边界节点上').toBe(1);
  });

  it('FL-6: position:fixed 的元素直接算浮层（即使没有溢出父块）', () => {
    document.body.innerHTML = `
      <div id="anchor" style="cursor:auto" data-rect="100,100,40,40">
        <div id="fixedPanel" style="position:fixed;cursor:pointer" data-rect="100,100,300,200">
          <div id="mi" style="cursor:pointer" data-rect="110,110,280,30">
            <span id="miLabel" style="cursor:pointer" data-rect="110,110,60,20">固定层里的项</span>
          </div>
        </div>
      </div>`;
    const tree = extractTree();
    const hit = clickable(tree).filter((n) => String(n.label).trim() === '固定层里的项');
    expect(hit.length).toBeGreaterThan(0);
    // 只收最内层：出现的那一个必须是 label 那层的尺寸，而不是 280×30 的包装或整张面板
    const innermost = hit.filter((n) => n.bounds && n.bounds.width === 60 && n.bounds.height === 20);
    expect(innermost.length, '浮层内应只收最内层可点元素').toBe(1);
  });

  it('FL-7: 浮层里只有图标的可点块仍然收（不能因为没文字就否掉）', () => {
    document.body.innerHTML = `
      <div id="t2" style="cursor:auto" data-rect="0,0,24,24">
        <div id="tp2" style="position:absolute;cursor:pointer" data-rect="0,0,24,24">
          <div id="pop2" style="position:absolute;cursor:pointer" data-rect="200,200,62,40">
            <div id="iconItem" style="cursor:pointer" data-rect="200,200,62,40"></div>
          </div>
        </div>
      </div>`;
    const tree = extractTree();
    // 只有图标（querySelector 能找到 svg/img/i[class]）——这里用 i.icon 模拟
    document.getElementById('iconItem').innerHTML = '<i class="icon-share"></i>';
    const tree2 = extractTree();
    expect(flatten(tree2).length).toBeGreaterThan(0);
    // 图标块进了树（有 click 或至少被当成可点目标）——只要不因"无文字"被整段丢掉
    const iconNodes = clickable(tree2).filter((n) => String(n.id).indexOf('iconItem') >= 0
      || (n.bounds && n.bounds.width === 62 && n.bounds.height === 40));
    expect(iconNodes.length, '图标按钮不应该被当成装饰丢掉').toBeGreaterThan(0);
    expect(flatten(tree).length).toBeGreaterThan(0);
  });
});

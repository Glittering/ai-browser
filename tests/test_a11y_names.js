// tests/test_a11y_names.js — 图片 alt / 提交按钮 value 用作名字，label 关联控件的选中态
// @vitest-environment jsdom
//
// 背景（2026-10-17 真实站点实测）：
//
// 1) B站动态正文插入的表情是 `<img alt="[doge_金箍]">`。正文里看得见，语义树里
//    role=image 但 label 是空串 —— "刚才插进去的是哪个表情"读不出来。
//    图片的可访问名是 alt，这是 HTML-AAM 规定的，不是站点特例。
//
// 2) CSDN 发布页的「可见范围」是自绘单选：可点的是 `<label>`，真控件是里面
//    `opacity:0` 的 `<input type=radio>`。于是四个选项在树里长得一模一样，
//    只有 visible —— "我选中了哪个"读不出来，只能靠截图。label 的选中态应当
//    来自它关联的控件（label.control / label[for]），WAI-ARIA 用 aria-checked。

import { describe, it, expect, beforeAll } from 'vitest';

let extractTree;

beforeAll(async () => {
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

const nodes = (tree) => flatten(tree);
const byRole = (tree, role) => nodes(tree).filter((n) => n.role === role);
const labelOf = (tree, role) => byRole(tree, role).map((n) => String(n.label || '').trim());

describe('图片 alt / 提交按钮 value 作为名字', () => {
  it('AN-1: img 的 alt 成为 image 节点的 label', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <img alt="[doge_金箍]" src="a.png" data-w="28" data-h="28">
    </div>`;
    const tree = extractTree();
    expect(labelOf(tree, 'image')).toContain('[doge_金箍]');
  });

  it('AN-2（阴性）: alt="" 的装饰图不制造假名字', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <img alt="" src="b.png" data-w="28" data-h="28">
    </div>`;
    const tree = extractTree();
    const imgs = byRole(tree, 'image');
    // 图可能因为没名字被剪掉；只要出现在树里，label 必须仍是空串
    for (const im of imgs) expect(String(im.label || '').trim()).toBe('');
    expect(labelOf(tree, 'image')).not.toContain('b.png');
  });

  it('AN-3: input[type=submit] 的 value 成为 label', () => {
    document.body.innerHTML = `<form data-rect="0,0,600,200">
      <input type="submit" value="提交表单" data-rect="10,10,120,36">
    </form>`;
    const tree = extractTree();
    const hit = nodes(tree).filter((n) => String(n.label || '').trim() === '提交表单');
    expect(hit.length).toBeGreaterThan(0);
  });

  it('AN-4: aria-label 优先于 alt（原有优先级不变）', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <img aria-label="头像" alt="[doge_金箍]" src="c.png" data-w="28" data-h="28">
    </div>`;
    const tree = extractTree();
    const labels = labelOf(tree, 'image');
    expect(labels).toContain('头像');
    expect(labels).not.toContain('[doge_金箍]');
  });
});

describe('label 关联控件的选中态', () => {
  it('AN-5: label 包着已选中的 radio → label 节点带 checked', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <label data-rect="10,10,80,32" style="cursor:pointer">
        <input type="radio" name="v" checked style="opacity:0" data-w="16" data-h="16">仅我可见
      </label>
      <label data-rect="100,10,80,32" style="cursor:pointer">
        <input type="radio" name="v" style="opacity:0" data-w="16" data-h="16">全部可见
      </label>
    </div>`;
    const tree = extractTree();
    const checkedLabels = nodes(tree).filter(
      (n) => String(n.label || '').trim() === '仅我可见' && (n.states || []).includes('checked')
    );
    const unchecked = nodes(tree).filter(
      (n) => String(n.label || '').trim() === '全部可见' && (n.states || []).includes('checked')
    );
    expect(checkedLabels.length, '「仅我可见」应被标成 checked').toBeGreaterThan(0);
    expect(unchecked.length, '「全部可见」不应被标成 checked').toBe(0);
  });

  it('AN-6: label[for] 指向已选中的 checkbox → label 节点带 checked', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <input id="cb1" type="checkbox" checked data-w="16" data-h="16">
      <label for="cb1" style="cursor:pointer" data-rect="40,10,120,32">同意协议</label>
    </div>`;
    const tree = extractTree();
    const hit = nodes(tree).filter(
      (n) => String(n.label || '').trim() === '同意协议' && (n.states || []).includes('checked')
    );
    expect(hit.length).toBeGreaterThan(0);
  });

  it('AN-7: role=radio + aria-checked=true → checked', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200">
      <div role="radio" aria-checked="true" style="cursor:pointer" data-rect="10,10,80,32">原创</div>
    </div>`;
    const tree = extractTree();
    const hit = nodes(tree).filter(
      (n) => String(n.label || '').trim() === '原创' && (n.states || []).includes('checked')
    );
    expect(hit.length).toBeGreaterThan(0);
  });

  it('AN-8: aria-selected=true → selected（tab 类）', () => {
    document.body.innerHTML = `<div data-rect="0,0,600,200" role="tablist">
      <div role="tab" aria-selected="true" style="cursor:pointer" data-rect="10,10,80,32">文章</div>
    </div>`;
    const tree = extractTree();
    const hit = nodes(tree).filter(
      (n) => String(n.label || '').trim() === '文章' && (n.states || []).includes('selected')
    );
    expect(hit.length).toBeGreaterThan(0);
  });
});

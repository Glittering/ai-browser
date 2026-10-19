// tests/test_doc_coverage.js — 「树读到了多少页面文字」的口径
//
// 存在的理由：2026-10-19 的泛雅事故里，默认树 27 个节点、正文 0 字，而当时
// 没有任何数字表达这件事。这个模块就是那个数字：分子是树里的正文字数，
// 分母是主文档 innerText + 跨进程帧里的可见文字。
//
// 这里钉住四类容易写错的地方：
//   1. 可编辑节点的 label 是占位符/值，不是正文（算进去会让覆盖率虚高）
//   2. 空页面报 null，不报 0（"没读到"和"没有可读的"必须分开）
//   3. 分母太小时比例没有意义（一句话的页面也能 100%）
//   4. 归因必须挂在实测数字上：缺字主要在哪一侧，就指哪一侧
import { describe, it, expect } from 'vitest';
import { sumLabelChars, pageCoverage, LOW_COVERAGE, MIN_MISSING_CHARS } from '../src/shared/doc_coverage.js';

const node = (label, extra = {}) => ({ id: 'x', role: 'generic', label, actions: [], ...extra });
const tree = (...nodes) => ({ id: 'root', role: 'generic', label: '', children: nodes });
// 分子数的是**非空白字符**（分母 innerText 里的空白结构不算，两边必须同一把尺子）。
// 测试里要断言的"字数"一律走这个函数，别用 String.length。
const nw = (s) => String(s).replace(/[\s\u00a0]/g, '').length;

describe('sumLabelChars()', () => {
  it('DC-1: 累加所有正文 label，深度不限', () => {
    const t = tree(node('课程门户'), { id: 'a', role: 'generic', label: '', children: [node('章节'), node('考试')] });
    expect(sumLabelChars(t).chars).toBe(2 + 2 + 4);
    expect(sumLabelChars(t).labels).toBe(3);
    expect(sumLabelChars(t).nodes).toBe(5); // root + 课程门户 + a + 章节 + 考试
  });

  it('DC-2: 可编辑节点的 label 是占位符/值，不算正文', () => {
    // 实测：一个带 placeholder 的搜索框能把 0% 抬到 20%，而那 6 个字页面正文里
    // 根本没有（innerText 不含 placeholder）。
    const t = tree(node('搜索框占位符文字很长'), { id: 'in', role: 'textbox', label: '搜索', editor_type: 'textbox', actions: [] });
    expect(sumLabelChars(t).chars).toBe('搜索框占位符文字很长'.length);
  });

  it('DC-3: 空树 / null 不炸', () => {
    expect(sumLabelChars(null)).toEqual({ chars: 0, labels: 0, nodes: 0 });
    expect(sumLabelChars(tree()).chars).toBe(0);
  });

  it('DC-12: 容器 label 复述子节点文字时，只算一次（实测 547/185 的那个 bug）', () => {
    // 线上真身：`<div role="link">1.1 标题 <b>1</b></div>` 包着 `<a>1.1 标题</a>`，
    // 抽取器给两层都写了 label。全加一遍 → 分子 547 大于分母 185，覆盖率溢出。
    const t = tree(
      { id: 'c1', role: 'link', label: '1.1 课程导学', actions: [], children: [node('1.1 课程导学')] },
      { id: 'c2', role: 'link', label: '1.2 学习目标', actions: [], children: [node('1.2 学习目标')] }
    );
    // 只算两个内层 a 的文字，容器那两份不再加。（字数按**非空白**数，见 countChars）
    expect(sumLabelChars(t).chars).toBe(nw('1.1 课程导学') + nw('1.2 学习目标'));
    expect(sumLabelChars(t).labels).toBe(2);
  });

  it('DC-13: 图标链接（有空的子节点）不许当叶子丢掉自己的文字', () => {
    // 反面：如果按"只数叶子"，`<a>课程门户<i/></a>` 会被漏掉 —— 那是少算。
    const t = tree({ id: 'a', role: 'link', label: '课程门户', actions: [], children: [{ id: 'i', role: 'image', label: '', actions: [] }] });
    expect(sumLabelChars(t).chars).toBe(4);
    expect(sumLabelChars(t).labels).toBe(1);
  });

  it('DC-14: 同一个 iframe 的三个描述节点只算一次，且 name 属性不算正文', () => {
    // 实测：合并逻辑会给一个跨进程帧建 iframe_body / iframe / Iframe 三个节点，
    // 前两个的 label 是 name 属性 "frame_content-zj"（16 字），闸门是第三个。
    // 不排除 → 凭空多 32 字，195/185 溢出。
    const t = tree(
      { id: 'b', role: 'iframe_body', label: 'frame_content-zj', actions: [] },
      { id: 'f', role: 'iframe', label: 'frame_content-zj', actions: [] },
      { id: 'g', role: 'Iframe', label: 'frame_content-zj', actions: [], children: [node('已完成任务点: 0/4')] }
    );
    expect(sumLabelChars(t).chars).toBe(nw('已完成任务点: 0/4'));
  });

  it('DC-15: img 的 alt 不算正文（innerText 里没有 alt）', () => {
    const t = tree(
      { id: 'l', role: 'link', label: '', actions: [], children: [{ id: 'i', role: 'image', label: 'Logo', actions: [] }] },
      node('赵士诚')
    );
    expect(sumLabelChars(t).chars).toBe(3);
  });
});

describe('pageCoverage()', () => {
  it('DC-4: 泛雅事故的那组数字 —— 主文档读得好、帧里 0 字进树', () => {
    // 主文档 300 字全进了树，帧里 420 字只进了 4 字。
    const c = pageCoverage({ treeChars: 304, mainChars: 300, frameChars: 420 });
    expect(c.page_chars).toBe(720);
    expect(c.percent).toBe(42);
    expect(c.ratio).toBeCloseTo(0.422, 3);
    expect(c.hint).toContain('cross-process frame');
    expect(c.hint).toContain('304/720');
  });

  it('DC-5: 缺字主要在主文档时，不许把锅甩给帧', () => {
    const c = pageCoverage({ treeChars: 100, mainChars: 900, frameChars: 20 });
    expect(c.hint).toContain('main document');
    expect(c.hint).not.toContain('cross-process frame');
  });

  it('DC-6: 两侧都不占大头时，如实说"分不清"，不编原因', () => {
    const c = pageCoverage({ treeChars: 100, mainChars: 400, frameChars: 400 });
    expect(c.hint).toContain('split');
  });

  it('DC-7: 覆盖率够高就不给提示（没有问题时不要制造噪声）', () => {
    const c = pageCoverage({ treeChars: 950, mainChars: 1000, frameChars: 0 });
    expect(c.ratio).toBeCloseTo(0.95, 3);
    expect(c.hint).toBe(null);
  });

  it('DC-8: 空页面 / 纯 canvas → null，不是 0', () => {
    expect(pageCoverage({ treeChars: 0, mainChars: 0, frameChars: 0 }).ratio).toBe(null);
    expect(pageCoverage({}).ratio).toBe(null);
    expect(pageCoverage(null).ratio).toBe(null);
  });

  it('DC-9: 分子分母都很小时不给提示（一句话的页面不该被当成事故）', () => {
    const c = pageCoverage({ treeChars: 18, mainChars: 20, frameChars: 0 });
    expect(c.tree_chars).toBe(18);
    expect(c.ratio).toBeCloseTo(0.9, 3);
    expect(c.hint).toBe(null);
  });

  it('DC-9b: 闸门看的是"漏掉多少字"，不是"页面多大" —— 泛雅真身回归', () => {
    // 实测：泛雅课程页 innerText 只有 185 字，修前的树只读到 25 字，
    // 缺的 160 字全在跨进程帧里。若闸门写成 `page_chars < 200 → 静音`，
    // 这个指标存在的理由（泛雅）就被它自己的闸门排除了。
    const c = pageCoverage({ treeChars: 25, mainChars: 30, frameChars: 155 });
    expect(c.page_chars).toBe(185);
    expect(c.percent).toBe(14);
    expect(c.hint).toContain('cross-process frame');
  });

  it('DC-9c: 比例闸门是主判据；绝对缺口只挡"一两个字"的噪声', () => {
    // 这条测试换过三版判据，每版都被实测推翻（见 doc_coverage.js 的 missingEnough）：
    //   page_chars < 200 → 泛雅 185 字被静音；缺 ≥ 20 字 → /sr-only 的 73% 被静音。
    // 现在：ratio < 0.9 就说话，只用一个 5 字的下限挡碎屑。
    const pc = (treeChars, mainChars) => pageCoverage({ treeChars, mainChars });
    // 大页面 88% → 报
    expect(pc(880, 1000).hint).not.toBe(null);
    // 大页面 95% → 不报
    expect(pc(950, 1000).hint).toBe(null);
    // 一句话的页面刚好 90% → 不报
    expect(pc(18, 20).hint).toBe(null);
    // 页面只有 6 字、漏 5 字（17%）→ 报：这不是"页面太小"，是几乎什么都没读到
    expect(pc(1, 6).hint).not.toBe(null);
    // 页面 8 字、漏 4 字 → 不报：一个词以下，说了也没用
    expect(pc(4, 8).hint).toBe(null);
  });

  it('DC-9d: /sr-only.html 真身回归 —— 22 字的页面漏 16 字必须出声', () => {
    // 实测（e2e/readcov_ws.cjs）：移出视口的 span 没有独立节点，树里只剩 6 字。
    const c = pageCoverage({ treeChars: 6, mainChars: 22 });
    expect(c.percent).toBe(27);
    expect(c.hint).not.toBe(null);
  });

  it('DC-10: 分子大于分母时不许装作 100% 没事 —— 那是分母漏了一块', () => {
    // 这条测试原来断言的是"钳到 1、不给提示"，也就是我自己第一版的行为：
    // 泛雅页分子 547 分母 185，钳成 100%，看起来最健康，问题藏得最深。
    // 现在反过来：比例照钳（1 是比例的上界），但必须带 over_measured 和一句
    // "分母漏了一个承载文字的表面"。
    const c = pageCoverage({ treeChars: 1400, mainChars: 1000, frameChars: 0 });
    expect(c.ratio).toBe(1);
    expect(c.percent).toBe(100);
    expect(c.tree_chars).toBe(1400); // 原始数字保留
    expect(c.over_measured).toBe(true);
    expect(c.hint).toContain('larger than the denominator');
  });

  it('DC-10b: 只是轻微超过（1.0~1.2）不算事故，不制造噪声', () => {
    // 同源子帧的文字如果刚好多出来一点点，不该每次都喊。阈值 1.2。
    const c = pageCoverage({ treeChars: 1100, mainChars: 1000, frameChars: 0 });
    expect(c.ratio).toBe(1);
    expect(c.over_measured).toBeUndefined();
  });

  it('DC-16: 同源子帧的文字必须进分母（实测 83/20 被报成 100% 的那个 bug）', () => {
    // 主文档 21 字，同源子帧 330 字，树里 83 字。
    // 修前：分母 21 → 比例 3.95 → 钳到 100%（谎报）。
    // 修后：分母 351 → 24%，且提示"主要缺口在正文里"。
    const c = pageCoverage({ treeChars: 83, mainChars: 21, sameOriginChars: 330, frameChars: 0 });
    expect(c.page_chars).toBe(351);
    expect(c.same_origin_chars).toBe(330);
    expect(c.percent).toBe(24);
    expect(c.over_measured).toBeUndefined();
    expect(c.hint).not.toBe(null);
  });

  it('DC-17: canvas 页的量不了，不许报 100%', () => {
    // 实测：一个把 12 行字画在画布上的页面，innerText 只有 4 字的 HUD 文案。
    // 分母 4、分子 60 → 1500% → 钳到 100%。画布上的字一个字都没被读，却报满分。
    const c = pageCoverage({ treeChars: 60, mainChars: 4, frameChars: 0, canvases: 1 });
    expect(c.ratio).toBe(null);
    expect(c.percent).toBe(null);
    expect(c.unmeasurable).toBe('canvas');
    expect(c.hint).toContain('canvas');
  });

  it('DC-18: 有 canvas 但页面正文很多时，正常按文字算（canvas 只是页面的一部分）', () => {
    const c = pageCoverage({ treeChars: 900, mainChars: 1000, frameChars: 0, canvases: 2 });
    expect(c.percent).toBe(90);
    expect(c.unmeasurable).toBeUndefined();
    expect(c.hint).toBe(null);
  });

  it('DC-11: 阈值边界两侧行为相反（LOW_COVERAGE 现为 0.9，跟着不变量走）', () => {
    const below = pageCoverage({ treeChars: Math.floor(1000 * LOW_COVERAGE) - 1, mainChars: 1000, frameChars: 0 });
    const above = pageCoverage({ treeChars: Math.ceil(1000 * LOW_COVERAGE) + 1, mainChars: 1000, frameChars: 0 });
    expect(below.hint).not.toBe(null);
    expect(above.hint).toBe(null);
  });
});

// tests/test_frame_read.js — 跨进程子帧内容读取器的契约测试
//
// 事故背景（2026-10-19，超星泛雅学习页）：
//   正文 iframe 里 8 个 <a>，其中 6 个是章节条目，href 为 null（onclick 驱动）。
//   原来的采集选择器是 `...[role=button],a[href]` —— 一份**表单控件读取器**，
//   于是章节列表一条都进不了语义树；而 context.frame_hints 照样写
//   {auto_ax:"merged", frames_read:1}，因为确实并进去一个搜索框。
//   调用方读到 merged，认为内容已读到，然后一路 target_not_found。
//
// 这里用 jsdom 复现那一页的形状，钉住三件事：
//   1. 没有 href 的链接也是链接（可交互、可点）
//   2. 没有可点元素的内容块也要被读出来（标题/列表项/表格单元）
//   3. 覆盖率是可测的数字，不是一句自我声明
//
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildFrameReadSource } from '../src/shared/frame_read_source.js';

// 产出源码必须是合法 JS：它是被 executeJavaScript 直接 eval 的字符串，
// 语法错会让整个帧读取静默失败（catch 之后 continue）。
function run(html, prefix = 'axf-2-', before = null) {
  document.body.innerHTML = html;
  if (before) before(document);
  const src = buildFrameReadSource(prefix);
  // jsdom 不布局，getBoundingClientRect 恒 0 —— 读取器会判定"不可见"而全丢。
  // 这里给出真实尺寸，模拟一个正常渲染的帧。
  const stub = () => ({ x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
  for (const el of document.querySelectorAll('*')) el.getBoundingClientRect = stub;
  // jsdom 没实现 innerText；读取器用它算"这一帧看得见多少字"。
  Object.defineProperty(document.body, 'innerText', {
    configurable: true,
    get: () => document.body.textContent || '',
  });
  const fn = new Function('document', 'location', 'return ' + src);
  return fn(document, { href: 'https://mooc2-ans.xidian.edu.cn/mooc2-ans/mycourse/studentcourse?x=1' });
}

describe('buildFrameReadSource — 源码契约', () => {
  it('FR-0: 产出的源码语法合法（否则 executeJavaScript 静默失败）', () => {
    const src = buildFrameReadSource('axf-1-');
    expect(() => new Function('document', 'location', 'return ' + src)).not.toThrow();
    expect(src).toContain('axf-1-');
  });

  it('FR-0b: prefix 不同则源码不同（不能拼死）', () => {
    expect(buildFrameReadSource('axf-1-')).not.toBe(buildFrameReadSource('axf-3-'));
  });
});

describe('子帧内容读取器 — 泛雅章节列表（无 href 的 a）', () => {
  // 真实结构：章节条目是 <a onclick=...> 且 href 为 null。锚点标签外面还有
  // <li> 包着，如果只读 li 会得到"1 1.1 xxx 1"这种拼起来的噪声。
  const FANYA = `
    <div class="chapter_list">
      <ul>
        <li><a onclick="openChapter(1)">1 我国信息化发展的形势任务与实践启示</a>
          <ul>
            <li><a onclick="openChapter(11)">1.1 我国信息化发展的形势任务与实践启示</a></li>
          </ul>
        </li>
        <li><a onclick="openChapter(2)">2 未来产业发展：全球模式与中国路径</a>
          <ul>
            <li><a onclick="openChapter(21)">2.1 未来产业发展：全球模式与中国路径(上）</a></li>
            <li><a onclick="openChapter(22)">2.2 未来产业发展：全球模式与中国路径（中）</a></li>
          </ul>
        </li>
      </ul>
    </div>
    <input type="text" placeholder="搜索">`;

  it('FR-1: 没有 href 的 <a> 仍然是 link 且可点（这正是原来的漏洞）', () => {
    const out = run(FANYA);
    const links = out.nodes.filter((n) => n.role === 'link');
    const titles = links.map((n) => n.label);
    expect(titles).toContain('1.1 我国信息化发展的形势任务与实践启示');
    expect(titles).toContain('2.2 未来产业发展：全球模式与中国路径（中）');
    expect(links.length).toBe(5);
    // 可点：链接必须带 click
    for (const l of links) expect(l.states.join(',')).toContain('focusable');
  });

  it('FR-2: 每个产出的 ref 都写进了页面的 data-ai-id（否则 act 找不到）', () => {
    const out = run(FANYA);
    const ids = out.nodes.map((n) => n.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(document.querySelector(`[data-ai-id="${id}"]`), `ref ${id} 必须能定位`).toBeTruthy();
    }
    expect(new Set(ids).size).toBe(ids.length); // 不重复
  });

  it('FR-3: 内容块让位给后代 —— 不会同时出现 li 和它里面的 a', () => {
    const out = run(FANYA);
    const labels = out.nodes.map((n) => n.label);
    // 父级 li 的文本是整段拼接（"1 我国信息化… 1.1 …"），不该单独成节点
    expect(labels.some((l) => l.startsWith('1 我国信息化') && l.includes('1.1'))).toBe(false);
    expect(labels).toContain('1 我国信息化发展的形势任务与实践启示');
  });

  it('FR-4: 覆盖率是可测的数字（这一页应该接近 1）', () => {
    const out = run(FANYA);
    expect(typeof out.stats.text_chars).toBe('number');
    expect(out.stats.text_chars).toBeGreaterThan(0);
    // 这一页的文字全在链接里，所以 readonly 文本块为 0、interactive > 0 ——
    // 覆盖率必须把这些"装在链接里的正文"也算进分子，否则一眼看过去像没读到。
    expect(out.stats.text_blocks).toBe(0);
    expect(out.stats.interactive).toBeGreaterThan(0);
    expect(out.stats.coverage).toBeGreaterThan(0.8);
  });
});

describe('子帧内容读取器 — 没有可点元素的正文', () => {
  // 这是"表单控件读取器"时代的第二类盲区：一段纯正文/一张成绩表，一个可点
  // 元素都没有，于是整帧读出来是空的 —— 但内容明明在那里。
  it('FR-5: 纯正文（h2 + p）能读出来，且标成只读（不给 click/type）', () => {
    const out = run('<h2>课程介绍</h2><p>本课程共计 4 个任务点。</p><p>考核方式：在线考试。</p>');
    const roles = out.nodes.map((n) => n.role);
    expect(roles).toContain('heading');
    const labels = out.nodes.map((n) => n.label);
    expect(labels).toContain('课程介绍');
    expect(labels).toContain('考核方式：在线考试。');
    for (const n of out.nodes) expect(n.states).toEqual(['readonly']);
  });

  it('FR-6: 表格单元能读出来（成绩表这类"只有文本"的数据）', () => {
    const out = run('<table><tr><td>章节</td><td>状态</td></tr><tr><td>1.1</td><td>已完成</td></tr></table>');
    expect(out.nodes.map((n) => n.role)).toContain('cell');
    expect(out.nodes.map((n) => n.label)).toContain('已完成');
  });

  it('FR-7: 空的/纯布局的帧返回 null 而不是空壳（合并方据此跳过）', () => {
    const out = run('<div><div><span></span></div></div>');
    expect(out).toBe(null);
  });

  it('FR-8: 零尺寸元素不算（隐藏内容不进树）', () => {
    document.body.innerHTML = '<div style="display:none"><p>不该出现的文字</p></div><p>应该出现</p>';
    const src = buildFrameReadSource('axf-9-');
    for (const el of document.querySelectorAll('*')) {
      el.getBoundingClientRect = () => (el.textContent === '不该出现的文字'
        ? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
        : { x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
    }
    Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent || '' });
    const fn = new Function('document', 'location', 'return ' + src);
    const out = fn(document, { href: 'https://x.test/' });
    expect(out.nodes.map((n) => n.label)).toEqual(['应该出现']);
  });
});

describe('子帧内容读取器 — 表单控件不能被这次改动弄丢', () => {
  it('FR-9: 富文本 / 输入框 / select 仍然带 editor_type 与可写动作', () => {
    const out = run(`
      <div contenteditable="true" aria-label="正文"></div>
      <textarea placeholder="请输入标题"></textarea>
      <select aria-label="学期"><option>2026</option></select>
      <button>提交</button>`, 'axf-4-', (doc) => {
      // jsdom 没实现 isContentEditable（恒 undefined）。真实浏览器里它是 true，
      // 读取器靠它判定富文本 —— 测试里必须显式补上，否则测的不是同一条分支。
      const ed = doc.querySelector('[contenteditable]');
      Object.defineProperty(ed, 'isContentEditable', { configurable: true, value: true });
    });
    const byLabel = (l) => out.nodes.find((n) => n.label === l);
    expect(byLabel('正文').editor_type).toBe('richtext');
    expect(byLabel('请输入标题').editor_type).toBe('textarea');
    expect(byLabel('学期').role).toBe('select');
    expect(out.nodes.find((n) => n.role === 'button').label).toBe('提交');
  });
});

import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';
import { JSDOM } from 'jsdom';
import { wrapperHintExpr, wrapperHintText } from '../src/shared/wrapper_hint.js';

// 2026-10-25 知乎私信：点 `<div class="ChatUserListItem">`（label 是整段预览拼接）→
// 回执 success=true、clicked_via=cdp-click，但 URL 不动。用户看到的是"点不动"。
// 真链接在会话面板里：`<a>创作打卡挑战赛第五十四期</a>`。
//
// 这里钉的是回执里的诊断：目标自身没文字却带着拼接文字时，必须点出"谁是这段文字
// 真正的归属"，否则调用方只会重复点同一个容器。同时钉住反向：目标自己有文字时
// **不能**误报（否则每次正常点击都会多一句噪音）。
//
// 表达式在真实环境里由 Runtime.evaluate 在页面上下文执行；这里用 JSDOM 的 window.eval
// 跑同一份字符串 —— 测的必须是线上那段代码，而不是它的复述。
function page(html) {
  // runScripts: 'outside-only' 是必须的：没有它，window.eval 跑在 Node 的上层上下文里，
  // 注入的表达式拿不到页面里的 document（表现是静默返回 null，比报错更难查）。
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  // jsdom 没有布局引擎：给每个元素一个固定矩形，模拟"看得见、可点"
  let i = 0;
  const all = w.document.querySelectorAll('*');
  for (const el of all) {
    const width = el.dataset.w ? Number(el.dataset.w) : 120;
    el.getBoundingClientRect = () => ({ x: 10, y: 10 + i * 20, width, height: 16, top: 10 + i * 20, left: 10, right: 10 + width, bottom: 26 + i * 20 });
    i++;
  }
  w.eval(wrapperHintExpr('')); // 预热：确认在没有目标时也不抛
  return { w, run: (id) => w.eval(wrapperHintExpr(id)) };
}

describe('wrapperHintExpr — 点容器时指出真正的归属节点', () => {
  it('容器的 label 是拼接文字、真链接在别处 → better_target 指向那个链接', () => {
    const { run } = page(`
      <div class="row" data-ai-id="e:div-30"><div class="name">创作者小助手</div><div class="snippet">10-21 最新一期「创作打卡挑战赛第五十四期」将于 10 月 23 日开始</div></div>
      <div class="chat"><a data-ai-id="e:a-236" href="/campaign/1">创作打卡挑战赛第五十四期</a></div>
    `);
    const w = run('e:div-30');
    expect(w).toBeTruthy();
    expect(w.is_wrapper).toBe(true);
    expect(w.agg_text).toContain('创作打卡挑战赛');
    expect(w.better_target).toBeTruthy();
    expect(w.better_target.id).toBe('e:a-236');
    expect(w.better_target.tag).toBe('A');
    expect(w.better_target.clickable).toBe(true);
  });

  it('目标自己有直接文字（<a>创作打卡…</a>）→ 不报（避免每次正常点击都加噪音）', () => {
    const { run } = page(`
      <div class="row" data-ai-id="e:div-30"><span>创作打卡挑战赛第五十四期</span></div>
      <a data-ai-id="e:a-236">创作打卡挑战赛第五十四期</a>
    `);
    expect(run('e:a-236')).toBe(null);
  });

  it('容器文字太短 → 不报（没有诊断价值）', () => {
    const { run } = page(`<div data-ai-id="e:x">短</div>`);
    expect(run('e:x')).toBe(null);
  });

  it('找不到归属节点时也给 is_wrapper（只说结论，不编造 id）', () => {
    const { run } = page(`<div data-ai-id="e:row"><div>这段很长的文字没有任何可点的</div><div>归属节点也没有链接</div></div>`);
    const w = run('e:row');
    expect(w && w.is_wrapper).toBe(true);
    expect(w.better_target).toBe(null);
    const txt = wrapperHintText(w);
    expect(txt).toContain('container');
    expect(txt).toContain('Retrying the same node will not help');
  });

  it('祖先节点不能被当成归属（点祖先等于又点一次外层）', () => {
    const { w, run } = page(`
      <section data-ai-id="e:sec"><div>外面一大段文字创作打卡挑战赛第五十四期继续</div></section>
      <div data-ai-id="e:inner" data-w="10"><span>外面一大段文字创作打卡挑战赛第五十四期继续</span></div>
    `);
    w.document.querySelector('[data-ai-id="e:sec"]').appendChild(w.document.querySelector('[data-ai-id="e:inner"]'));
    const hint = run('e:inner');
    if (hint && hint.better_target) expect(hint.better_target.id).not.toBe('e:sec');
  });


  it('同一段文字里有多个近似项（第五十期/第五十四期）→ 选整串命中的那个，不是面积最小的', () => {
    const { run } = page(`
      <div class="row" data-ai-id="e:div-30" data-w="286">
        <div>创作者小助手</div>
        <div>10-21 ☄️最新一期「创作打卡挑战赛」活动来喽！「创作打卡挑战赛第五十四期 」将于 10 月 23 日开始</div>
      </div>
      <a data-ai-id="e:a-136" data-w="158">创作打卡挑战赛第五十期</a>
      <a data-ai-id="e:a-236" data-w="173">创作打卡挑战赛第五十四期</a>
    `);
    const w = run('e:div-30');
    expect(w && w.better_target && w.better_target.id).toBe('e:a-236');
    expect(w.better_target.exact).toBe(true);
  });

  it('整串命中的在视口外、近似的在视口内 → 仍然选整串命中（scrollIntoView 会把它带进来）', () => {
    const { w: win, run } = page(`
      <div class="row" data-ai-id="e:div-30" data-w="286">
        <div>创作者小助手</div>
        <div>「创作打卡挑战赛第五十四期 」将于 10 月 23 日开始</div>
      </div>
      <a data-ai-id="e:a-236">创作打卡挑战赛第五十四期</a>
      <a data-ai-id="e:a-999">创作打卡挑战赛</a>
    `);
    // 把整串命中的那个挪到视口外
    win.document.querySelector('[data-ai-id="e:a-236"]').getBoundingClientRect =
      () => ({ x: 10, y: -3000, width: 173, height: 17, top: -3000, left: 10, right: 183, bottom: -2983 });
    const w = run('e:div-30');
    expect(w && w.better_target && w.better_target.id).toBe('e:a-236');
  });

  it('ref 不存在 → null（不是崩溃）', () => {
    const { run } = page(`<div data-ai-id="e:real">很长的文字在这里用来测试不存在的情况</div>`);
    expect(run('e:not-exist')).toBe(null);
  });
});

describe('wrapperHintText — 下一步要能照着做', () => {
  it('有 id 时给出可直接使用的 ref', () => {
    const t = wrapperHintText({
      is_wrapper: true,
      agg_text: 'xxx 拼接文字',
      better_target: { id: 'e:a-236', tag: 'A', role: 'link', clickable: true, text: '创作打卡' },
    });
    expect(t).toContain('e:a-236');
    expect(t).toContain('click that instead');
  });

  it('没有 id 时让调用方重读树，而不是让它瞎猜', () => {
    const t = wrapperHintText({
      is_wrapper: true,
      agg_text: 'xxx',
      better_target: { id: null, tag: 'SPAN', role: null, clickable: false, text: '创作打卡' },
    });
    expect(t).toContain('no ref');
    // ⚠️ 这里曾经断言 `subset:"all"` —— 那个值在 schema 里根本不存在
    // （合法值只有 interactive|full），于是提示把 agent 引到一个必然报错的参数上。
    // 现在从 MCP_TOOLS 的 schema 里取合法枚举来断言，写错值就会红。
    const subsetSchema = MCP_TOOLS.find((x) => x.name === 'browse_get_tree')
      .inputSchema.properties.subset;
    const suggested = /subset:"([^"]+)"/.exec(t);
    expect(suggested, '提示里必须给一个可照抄的 subset 值').toBeTruthy();
    expect(subsetSchema.enum, `提示建议的 ${suggested[1]} 必须在上面的 enum 里`).toContain(suggested[1]);
  });

  it('不是容器时返回空串（不给普通回执加字）', () => {
    expect(wrapperHintText(null)).toBe('');
    expect(wrapperHintText({ is_wrapper: false })).toBe('');
  });
});

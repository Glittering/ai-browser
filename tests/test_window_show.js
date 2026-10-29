// tests/test_window_show.js — 窗口显示那一刻的自述口径（纯函数，表驱动）
//
// 为什么单独钉这一层：这是本项目第二次在同一个地方撒谎，两次都是"记录比事实好看"。
//   第一次：waited_for_dom 恒为 true（3s 兜底也报 true）。
//   第二次：修了 timeout 却漏了**占位页** —— 2026-10-24 起新标签页先加载
//           loading.html，它自己会发 dom-ready，于是 show_reason 照旧报
//           'dom-ready'、waited_for_dom 照旧报 true，而此刻目标文档一个字节都没到
//           （实测外网不通时 body 恒为 578 字符）。
//
// 这类错误在 e2e 里只表现为一个莫名其妙的红（NV-A3 在起始页加载不出来时必红），
// 所以判据必须在这一层被穷举：**reason × url 的每一种组合都要有明确期望**。
import { describe, it, expect } from 'vitest';
import { classifyShowReason, describeShowUrl, SHOW_REASONS, SHOW_EVENT_REASONS } from '../src/shared/window_show.js';

const REAL_PAGE = 'https://www.baidu.com/';
const PLACEHOLDER = 'file:///Users/x/ai-browser/src/renderer/loading.html?url=https%3A%2F%2Fwww.baidu.com%2F';

describe('classifyShowReason — 等到的到底是谁的 DOM', () => {
  it('WD-01 真页面 dom-ready → 如实报 dom-ready，waited_for_dom=true', () => {
    expect(classifyShowReason('dom-ready', REAL_PAGE)).toEqual({
      show_reason: 'dom-ready', waited_for_dom: true, on_placeholder: false,
    });
  });

  it('WD-02 占位页 dom-ready → placeholder + waited_for_dom=false（这才是真话）', () => {
    // 修复前这里返回 {show_reason:'dom-ready', waited_for_dom:true}，
    // 于是"等到内容再显示"这条承诺被自己的占位页架空。
    expect(classifyShowReason('dom-ready', PLACEHOLDER)).toEqual({
      show_reason: 'placeholder', waited_for_dom: false, on_placeholder: true,
    });
  });

  it('WD-03 占位页上的 renderer-ready 同样不算（readyState 是占位页的）', () => {
    expect(classifyShowReason('renderer-ready', PLACEHOLDER)).toEqual({
      show_reason: 'placeholder', waited_for_dom: false, on_placeholder: true,
    });
  });

  it('WD-04 空 URL 按占位页处理（导航刚发起时 getURL() 还是空）', () => {
    const r = classifyShowReason('dom-ready', '');
    expect(r.show_reason).toBe('placeholder');
    expect(r.waited_for_dom).toBe(false);
  });

  it('WD-05 3s 兜底 / 加载失败都不得声称"等到了 DOM"', () => {
    expect(classifyShowReason('timeout', REAL_PAGE).waited_for_dom).toBe(false);
    // fail-load 以前被算成 waited_for_dom=true（只排除 timeout）。目标文档**失败了**，
    // 后面接手的是我们自绘的错误页 —— 那不是"等到了页面"。
    const f = classifyShowReason('fail-load', 'https://nope.invalid/');
    expect(f).toEqual({ show_reason: 'fail-load', waited_for_dom: false, on_placeholder: false });
  });

  it('WD-06 反例：站点自己的页面恰好叫 loading.html，不能被当成占位页', () => {
    // 判据在 placeholder.cjs 里已经避开网络页面（/^https?:/ 直接 false）。
    // 这一条是给"顺手把判据改成 endsWith('loading.html')"的人踩的刹车：
    // 真按文件名匹配，一个叫 loading.html 的站点正文档会被永远当成"还没开始"。
    expect(classifyShowReason('dom-ready', 'https://site.test/loading.html')).toEqual({
      show_reason: 'dom-ready', waited_for_dom: true, on_placeholder: false,
    });
    expect(classifyShowReason('dom-ready', 'http://127.0.0.1:8080/docs/loading.html?x=1').waited_for_dom).toBe(true);
  });

  it('WD-07 穷举：枚举内的原因，输出一定在枚举内且口径自洽', () => {
    const urls = [REAL_PAGE, PLACEHOLDER, '', 'about:blank', 'https://site.test/loading.html'];
    const ready = new Set(['dom-ready', 'renderer-ready']);
    // 只穷举**事件**（输入侧）。'placeholder' 是折算出来的结论，拿它当输入去
    // 断言"输出在枚举内"就是自证 —— 那条边界由 WD-07 的 expectWait 负责。
    for (const reason of SHOW_EVENT_REASONS) {
      for (const url of urls) {
        const r = classifyShowReason(reason, url);
        expect(SHOW_REASONS).toContain(r.show_reason);
        expect(SHOW_REASONS).toContain(reason); // 事件名本身也必须是一个合法输出
        const expectWait = ready.has(reason) && r.show_reason !== 'placeholder';
        expect(r.waited_for_dom).toBe(expectWait);
        // 单向蕴含，不是等价：on_placeholder 回答"当时在哪一页"，show_reason 回答
        // "为什么显示"。超时那一刻我们还停在占位页是完全正常的（show_reason=timeout
        // + on_placeholder=true），两者并不是同一件事。但反过来说，**没在占位页上
        // 却报 placeholder 就是撒谎**，这条必须堵死。
        if (r.show_reason === 'placeholder') expect(r.on_placeholder).toBe(true);
      }
    }
  });

  it('WD-07b 枚举外的原因原样透传（可见性优先），且绝不声称等到了 DOM', () => {
    // 透传而不是改写成 'unknown'：一个没见过的原因留在日志里比被抹平更有用。
    // 但"等到了"这个结论不能跟着透传 —— 不认识的路径一律不认。
    const r = classifyShowReason('weird-reason', REAL_PAGE);
    expect(r.show_reason).toBe('weird-reason');
    expect(r.waited_for_dom).toBe(false);
    expect(classifyShowReason(undefined, REAL_PAGE).show_reason).toBe('unknown');
    expect(classifyShowReason(undefined, REAL_PAGE).waited_for_dom).toBe(false);
  });

  it('WD-08 describeShowUrl 保留占位页 URL 里的目标地址，但不会把日志撑爆', () => {
    expect(describeShowUrl(PLACEHOLDER)).toContain('url=https');
    const long = 'https://x.test/?q=' + 'a'.repeat(1000);
    const out = describeShowUrl(long, 60);
    expect(out.length).toBeLessThanOrEqual(61); // 60 + 省略号
    expect(out.endsWith('…')).toBe(true);
    expect(describeShowUrl(null)).toBe('');
  });
});

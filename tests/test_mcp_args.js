// tests/test_mcp_args.js — MCP 参数映射（分组 → 扁平）的白盒 + 回归测试
//
// 这一层存在的理由见 src/main/mcp_args.js 顶部。三条硬要求：
//   1. 新的分组写法必须映射正确
//   2. 旧的扁平写法必须继续工作（向后兼容，不许破坏既有脚本）
//   3. drag 与 wheel 共用 dx/dy 时不得互相覆盖 —— 这是真实发生过的事故
//
// 事故复现：2026-10 之前 mcp_server.js 里
//   { dx: args.dx, dy: args.dy, ..., dx: args.delta_x, dy: args.delta_y }
// 对象字面量同名键后者胜出，于是 browse_act({action:'drag', dx:100}) 的
// dx 被 undefined 覆盖，拖拽按偏移量的用法静默失效且无任何异常。
// 下面 R-1 就是钉住这条的。

import { describe, it, expect } from 'vitest';
import { actParams, networkParams } from '../src/main/mcp_args.js';

describe('actParams — drag', () => {
  it('R-1: drag 的分组 dx/dy 不被 wheel 字段覆盖（事故回归）', () => {
    const p = actParams({ action: 'drag', target: 'e:node-3', drag: { dx: 100, dy: 50 } });
    expect(p.dx).toBe(100);
    expect(p.dy).toBe(50);
  });

  it('R-2: drag 的旧扁平 dx/dy 同样不被覆盖（兼容 + 事故回归）', () => {
    const p = actParams({ action: 'drag', target: 'e:node-3', dx: 100, dy: 50 });
    expect(p.dx).toBe(100);
    expect(p.dy).toBe(50);
  });

  it('R-3: dx=0 是有效值，不能被当空值丢掉', () => {
    const p = actParams({ action: 'drag', drag: { dx: 0, dy: 0 } });
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(0);
  });

  it('D-1: 分组 from/to 绝对坐标', () => {
    const p = actParams({ action: 'drag', drag: { from: { x: 10, y: 20 }, to: { x: 300, y: 260 } } });
    expect(p.from).toEqual({ x: 10, y: 20 });
    expect(p.to_x).toBe(300);
    expect(p.to_y).toBe(260);
  });

  it('D-2: 旧扁平 from_x/from_y 仍然转成 from 对象', () => {
    const p = actParams({ action: 'drag', from_x: 10, from_y: 20, to_x: 300, to_y: 260 });
    expect(p.from).toEqual({ x: 10, y: 20 });
    expect(p.to_x).toBe(300);
  });

  it('D-3: 锚点可以写在 from/to 里，也可以用旧的 top-level 名', () => {
    const a = actParams({ action: 'drag', drag: { from: { anchor: 'right' }, to: { anchor: 'left' } } });
    expect(a.from_anchor).toBe('right');
    expect(a.to_anchor).toBe('left');
    const b = actParams({ action: 'drag', from_anchor: 'right', to_anchor: 'left' });
    expect(b.from_anchor).toBe('right');
    expect(b.to_anchor).toBe('left');
  });

  it('D-4: 落到另一个元素 / 修饰键 / 鼠标键', () => {
    const p = actParams({
      action: 'drag',
      target: 'e:a',
      drag: { target_to: 'e:b', hold: ['Shift'], button: 'middle' },
    });
    expect(p.to_target).toBe('e:b');
    expect(p.hold).toEqual(['Shift']);
    expect(p.button).toBe('middle');
  });

  it('D-5: 非 drag 动作不产出 drag 字段（不污染 params）', () => {
    const p = actParams({ action: 'click', target: 'e:x', drag: { dx: 1 } });
    expect(p.dx).toBeUndefined();
    expect(p.to_target).toBeUndefined();
  });
});

describe('actParams — wheel', () => {
  it('W-1: 分组 wheel.dx/dy', () => {
    const p = actParams({ action: 'wheel', wheel: { dx: 0, dy: -240, hold: ['Control'] } });
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(-240);
    expect(p.hold).toEqual(['Control']);
  });

  it('W-2: 旧扁平 delta_x/delta_y 仍然可用', () => {
    const p = actParams({ action: 'wheel', delta_x: 5, delta_y: -10 });
    expect(p.dx).toBe(5);
    expect(p.dy).toBe(-10);
  });
});

describe('actParams — 其余动作', () => {
  it('C-1: click 的 url / keep_tab 分组与扁平两种写法', () => {
    const a = actParams({ action: 'click', click: { url: 'https://x/y', keep_tab: true } });
    expect(a.url).toBe('https://x/y');
    expect(a.keep_tab).toBe(true);
    const b = actParams({ action: 'click', url: 'https://x/y', keep_tab: true });
    expect(b.url).toBe('https://x/y');
    expect(b.keep_tab).toBe(true);
  });

  it('C-2: keep_tab=false 不会被 ?? 丢掉', () => {
    const p = actParams({ action: 'click', click: { keep_tab: false } });
    expect(p.keep_tab).toBe(false);
  });

  it('P-1: press 的 key / keys 分组与扁平', () => {
    expect(actParams({ action: 'press', press: { key: 'Escape' } }).key).toBe('Escape');
    expect(actParams({ action: 'press', key: 'Meta+a' }).key).toBe('Meta+a');
    expect(actParams({ action: 'press', press: { keys: ['Meta', 'a'] } }).keys).toEqual(['Meta', 'a']);
  });

  it('G-1: get_value 的 read.offset/limit 与扁平', () => {
    const a = actParams({ action: 'get_value', read: { offset: 10, limit: 500 } });
    expect(a.offset).toBe(10);
    expect(a.limit).toBe(500);
    const b = actParams({ action: 'get_value', offset: 10, limit: 500 });
    expect(b.offset).toBe(10);
    expect(b.limit).toBe(500);
  });

  it('T-1: 通用字段原样透传', () => {
    const p = actParams({
      action: 'paste',
      target: 'e:editor',
      html: '<h2>t</h2>',
      text: 'fallback',
      file: '/tmp/a.pdf',
      timeout_ms: 30000,
    });
    expect(p.html).toBe('<h2>t</h2>');
    expect(p.text).toBe('fallback');
    expect(p.file).toBe('/tmp/a.pdf');
    expect(p.timeout_ms).toBe(30000);
  });

  it('T-2: 空参数不炸，只产出空值字段', () => {
    expect(() => actParams()).not.toThrow();
    const p = actParams({});
    expect(p.text).toBeUndefined();
    expect(p.dx).toBeUndefined();
  });
});

describe('networkParams', () => {
  it('N-1: list 的 filters 分组', () => {
    const p = networkParams({
      operation: 'list',
      filters: { method: ['POST'], url_contains: '/api/', status_min: 400, limit: 20 },
    });
    expect(p.method).toEqual(['POST']);
    expect(p.url_contains).toBe('/api/');
    expect(p.status).toEqual({ min: 400, max: undefined });
    expect(p.limit).toBe(20);
  });

  it('N-2: list 的旧扁平过滤条件仍然可用', () => {
    const p = networkParams({ operation: 'list', method: ['GET'], status_max: 299 });
    expect(p.method).toEqual(['GET']);
    expect(p.status).toEqual({ min: undefined, max: 299 });
  });

  it('N-3: 无 status 过滤时不下发 status 字段', () => {
    expect(networkParams({ operation: 'list' }).status).toBeUndefined();
  });

  it('N-4: get 的 include 分组映射到 include_* 名', () => {
    const p = networkParams({
      operation: 'get',
      network_id: 'n1',
      include: { response_body: true, request_headers: true, body_limit: 1024 },
    });
    expect(p.include_response_body).toBe(true);
    expect(p.include_request_headers).toBe(true);
    expect(p.body_limit).toBe(1024);
  });

  it('N-5: get 的旧扁平 include_* 仍然可用', () => {
    const p = networkParams({ operation: 'get', network_id: 'n1', include_response_body: true });
    expect(p.include_response_body).toBe(true);
  });

  it('N-6: body_offset 分组映射到 request/response 两条通道', () => {
    const p = networkParams({ operation: 'get', body_offset: { request: 1024, response: 2048 } });
    expect(p.request_body_offset).toBe(1024);
    expect(p.response_body_offset).toBe(2048);
  });

  it('N-7: configure 分组', () => {
    const p = networkParams({ operation: 'configure', configure: { enabled: false, capture_bodies: 'api' } });
    expect(p.enabled).toBe(false);
    expect(p.capture_bodies).toBe('api');
  });
});

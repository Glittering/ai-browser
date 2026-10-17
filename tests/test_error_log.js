// tests/test_error_log.js — 主进程错误日志（JSONL，滚动，可回读）
//
// 这套用例守的是一条底线：**出事之后必须能查到**。所以除了"能写能读"，
// 还要钉住三件容易做丢的事：
//   1. 日志自身失败不许抛（为了记录崩溃而制造新崩溃是最难查的 bug）；
//   2. 落盘是同步的（异步等 flush，进程崩了就没了）；
//   3. 条目自带最近的调用上下文（只有栈说不清"是哪个调用触发的"）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initErrorLog, recordError, noteCall, recentErrors, getLogPath,
  markShutdown, __resetForTests,
} from '../src/main/error_log.js';

let dir;
function fresh() {
  __resetForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-errlog-'));
  initErrorLog({ dir, meta: { probe: true } });
  return dir;
}
function lines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('error_log — 写入与回读', () => {
  beforeEach(fresh);
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('EL-1 init 后立刻有 boot 标记行（能分辨是哪一次启动）', () => {
    const l = lines(getLogPath());
    expect(l[0].kind).toBe('boot');
    expect(l[0].pid).toBe(process.pid);
    expect(l[0].probe).toBe(true);
  });

  it('EL-2 recordError 同步落盘：调用返回时文件里已经能读到', () => {
    recordError('uncaught_exception', { message: 'boom', stack: 'Error: boom\n at x' });
    const l = lines(getLogPath());
    const hit = l.find((e) => e.kind === 'uncaught_exception');
    expect(hit).toBeTruthy();
    expect(hit.message).toBe('boom');
    expect(hit.stack).toContain('at x');
    expect(typeof hit.ts).toBe('string');
  });

  it('EL-3 Error 对象自动展开成 name/message/stack（不写成 {}）', () => {
    recordError('unhandled_rejection', { error: new TypeError('bad type') });
    const hit = lines(getLogPath()).find((e) => e.kind === 'unhandled_rejection');
    expect(hit.error.name).toBe('TypeError');
    expect(hit.error.message).toBe('bad type');
    expect(hit.error.stack).toContain('bad type');
  });

  it('EL-4 recentErrors 默认不返回 boot/shutdown（它们不是错误）', () => {
    recordError('ws_error', { message: 'e1' });
    markShutdown('test');
    const r = recentErrors(50);
    const kinds = r.items.map((e) => e.kind);
    expect(kinds).toContain('ws_error');
    expect(kinds).not.toContain('boot');
    expect(kinds).not.toContain('shutdown');
  });

  it('EL-5 显式 kind 能查到 shutdown（判断上次是否硬退的依据）', () => {
    markShutdown('cleanup');
    const r = recentErrors(10, 'shutdown');
    expect(r.items.length).toBe(1);
    expect(r.items[0].reason).toBe('cleanup');
  });

  it('EL-6 limit 生效且取的是最新的那几条', () => {
    for (let i = 0; i < 10; i++) recordError('ws_error', { message: 'm' + i });
    const r = recentErrors(3);
    expect(r.items.map((e) => e.message)).toEqual(['m7', 'm8', 'm9']);
  });

  it('EL-7 回执带 path/dir —— 进程一崩内存就没了，文件才是权威历史', () => {
    const r = recentErrors();
    expect(r.path).toBe(path.join(dir, 'error.jsonl'));
    expect(r.dir).toBe(dir);
    expect(fs.existsSync(r.path)).toBe(true);
  });
});

describe('error_log — 崩溃上下文', () => {
  beforeEach(fresh);
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('EL-8 记录错误时附带最近的调用摘要（栈说不清是被哪个调用触发的）', () => {
    noteCall('ui.act', { action: 'upload', target: '#box .the-input', params: { file: '/x.png' } }, 12, true);
    noteCall('ui.get_tree', { tab: 3 }, 5, true);
    recordError('uncaught_exception', { message: 'kaboom' });
    const hit = lines(getLogPath()).find((e) => e.kind === 'uncaught_exception');
    expect(Array.isArray(hit.recent_calls)).toBe(true);
    const methods = hit.recent_calls.map((c) => c.method);
    expect(methods).toContain('ui.act');
    expect(methods).toContain('ui.get_tree');
    const act = hit.recent_calls.find((c) => c.method === 'ui.act');
    expect(act.params.target).toBe('#box .the-input');
    expect(act.ms).toBe(12);
  });

  it('EL-9 大字段（text/html/js）只留长度，不把正文灌进日志', () => {
    const big = 'x'.repeat(50000);
    noteCall('ui.act', { action: 'type', text: big, tab: 1 }, 30, true);
    recordError('ws_error', { message: 'e' });
    const hit = lines(getLogPath()).find((e) => e.kind === 'ws_error');
    const call = hit.recent_calls.find((c) => c.method === 'ui.act');
    expect(call.params.text).toBe('<50000 chars>');
    expect(call.params.tab).toBe(1);
  });

  it('EL-10 调用环形缓冲有上限（不会把内存吃穿）', () => {
    for (let i = 0; i < 200; i++) noteCall('ui.evaluate', { tab: 1, js: 'i=' + i }, 1, true);
    recordError('ws_error', { message: 'e' });
    const hit = lines(getLogPath()).find((e) => e.kind === 'ws_error');
    expect(hit.recent_calls.length).toBeLessThanOrEqual(20);
    expect(hit.recent_calls[hit.recent_calls.length - 1].params.js).toContain('i=199');
  });
});

describe('error_log — 不许反噬', () => {
  beforeEach(fresh);
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('EL-11 目录不可写时 recordError 不抛（丢弃计数如实上报）', () => {
    __resetForTests();
    // 指向一个必然创建不了的位置（普通文件当目录用）
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aib-bad-')), 'file');
    fs.writeFileSync(fake, 'x');
    initErrorLog({ dir: path.join(fake, 'logs') });
    expect(() => recordError('ws_error', { message: 'nope' })).not.toThrow();
    expect(() => noteCall('ui.act', {}, 1, false)).not.toThrow();
    // 写不下去也不该让 recentErrors 炸
    expect(() => recentErrors()).not.toThrow();
    try { fs.rmSync(path.dirname(fake), { recursive: true, force: true }); } catch {}
  });

  it('EL-12 循环引用/函数/超大数组都不会让序列化炸掉', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => recordError('ws_error', {
      message: 'weird',
      circular: a,
      fn: function named() {},
      big: Array.from({ length: 100 }, () => 1),
      undef: undefined,
    })).not.toThrow();
    const hit = lines(getLogPath()).find((e) => e.kind === 'ws_error');
    expect(hit.circular.self).toBeTruthy();          // 展开到深度上限就停，不死循环
    expect(JSON.stringify(hit.circular)).toContain('[object]');
    expect(String(hit.fn)).toContain('function');
    expect(hit.big.length).toBeLessThanOrEqual(13);
  });
});

describe('error_log — 滚动', () => {
  it('EL-13 超过单文件上限时轮转出 .1，当前文件从小开始', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-roll-'));
    __resetForTests();
    // 上限调到 20KB：默认 2MB 要写几百条才轮转，测试没必要跑那么久
    initErrorLog({ dir: d, maxBytes: 20 * 1024 });
    const chunk = 'y'.repeat(2000); // 每条 ~2KB（低于单字段 4000 截断线）
    for (let i = 0; i < 20; i++) recordError('ws_error', { message: 'm' + i, blob: chunk });
    const cur = fs.statSync(path.join(d, 'error.jsonl')).size;
    expect(fs.existsSync(path.join(d, 'error.jsonl.1'))).toBe(true);
    // 轮转后当前文件必须小于上限，否则等于没轮转
    expect(cur).toBeLessThan(20 * 1024);
    // 轮转不能把刚写的那条丢掉
    const last = lines(path.join(d, 'error.jsonl')).filter((e) => e.kind === 'ws_error').pop();
    expect(last.message).toBe('m19');
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });
});

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
  initErrorLog, recordError, recordDiag, noteCall, recentErrors, getLogPath,
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

  it('EL-14 recordDiag 只落盘：不附 recent_calls，也不进错误环（心跳不是错误）', () => {
    // 先塞点调用上下文，验证 recordDiag **不会**把它带进条目
    noteCall('ui.act', { action: 'click', tab: 1 }, 3, true);
    recordDiag('heartbeat', { rss_mb: 123, heap_used_mb: 45, tabs: 2 });
    const h = lines(getLogPath()).find((e) => e.kind === 'heartbeat');
    expect(h).toBeTruthy();
    expect(h.rss_mb).toBe(123);
    expect(h.tabs).toBe(2);
    expect(h.recent_calls).toBeUndefined();
    // 默认的 recentErrors 不该被心跳占位
    expect(recentErrors(50).items.some((e) => e.kind === 'heartbeat')).toBe(false);
    // 心跳**只落盘、不进内存环**：它每 5 分钟一条，进环会把真实错误挤出 200 条上限。
    // 所以内存里的 recentErrors 查不到它 —— 要查心跳请直接读 error.jsonl。
    expect(recentErrors(50, 'heartbeat').items.length).toBe(0);
  });

  it('EL-15 启动时检测到"上次没走 shutdown" → 记一条 previous_run_no_shutdown', () => {
    // 上一次运行：有错误、但**没有** shutdown（模拟崩溃/被 kill）
    recordError('ws_error', { message: 'before-crash' });
    __resetForTests();
    initErrorLog({ dir, meta: { run: 2 } });
    const l = lines(getLogPath());
    const hit = l.find((e) => e.kind === 'previous_run_no_shutdown');
    expect(hit).toBeTruthy();
    expect(hit.prev_kind).toBe('ws_error');
    expect(typeof hit.gap_ms).toBe('number');
    // boot 仍然是首行（硬退记录追加在它后面，不破坏 EL-1 的约定）
    expect(l[0].kind).toBe('boot');
  });

  it('EL-16 上次正常 shutdown → 不误报硬退', () => {
    recordError('ws_error', { message: 'ok' });
    markShutdown('cleanup');
    __resetForTests();
    initErrorLog({ dir, meta: { run: 2 } });
    const l = lines(getLogPath());
    expect(l.find((e) => e.kind === 'previous_run_no_shutdown')).toBeFalsy();
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

describe('error_log — 写不进去时把原因留下来', () => {
  // 2026-11-09 事故：崩溃那一刻起 error.jsonl 一条都写不进去（dropped 涨到 30+），
  // 而旧实现只 `dropped += 1`，事后完全不知道是 fd 耗尽、磁盘满还是进程坏了。
  // 判据：失败必须带 errno/message，且 ui.errors 能读到；没失败时必须是 null。

  it('EL-17 append 失败时记录 errno 与 message（用同名目录逼出 EISDIR）', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-wr-'));
    __resetForTests();
    // 先建一个叫 error.jsonl 的**目录**：appendFileSync 必然失败，且真实、不靠 mock
    fs.mkdirSync(path.join(d, 'error.jsonl'));
    initErrorLog({ dir: d });
    const r = recentErrors(10);
    expect(r.dropped_writes).toBeGreaterThan(0);
    expect(r.write_error).toBeTruthy();
    expect(r.write_error.code).toBeTruthy();
    expect(String(r.write_error.message).length).toBeGreaterThan(0);
    expect(r.write_error.count).toBeGreaterThan(0);
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('EL-18 阳性对照：写得进去时 write_error 必须是 null（别把"正常"报成"坏了"）', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-wr-ok-'));
    __resetForTests();
    initErrorLog({ dir: d });
    recordError('ws_error', { message: 'fine' });
    const r = recentErrors(10);
    expect(r.dropped_writes).toBe(0);
    expect(r.write_error).toBe(null);
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  });
});

// tests/test_download_monitor.js — main/download_monitor.js 单元测试
//
// 这个模块存在的理由（2026-10-12 审计）：src/ 里原先**没有任何** `will-download`
// 处理器，而 Electron 的默认行为是取消下载。于是 agent 点"导出 CSV"会看到
// ui.act 返回 success，然后什么都没有发生 —— 连错误都没有。
// 这是最隐蔽的一类 `success ≠ 做成了`。
//
// 测试全部用假 session + 假 DownloadItem，不起 Electron。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DownloadMonitor } from '../src/main/download_monitor.js';

// 一个可操控的假 DownloadItem：外部调 fire.updated(state) / fire.done(state)。
// 注意用闭包变量而不是 `this` —— 对象字面量里的箭头函数捕获不到 this。
function makeItem({ url = 'https://example.com/a.csv', filename = 'a.csv', mime = 'text/csv', total = 100, webContents = null } = {}) {
  const handlers = { updated: [], done: [] };
  let savePath = null;
  return {
    webContents,
    getFilename: () => filename,
    getURL: () => url,
    getMimeType: () => mime,
    getTotalBytes: () => total,
    getReceivedBytes: () => 0,
    getSavePath: () => savePath,
    setSavePath(p) { savePath = p; },
    on(ev, cb) { (handlers[ev] || []).push(cb); },
    fire(ev, state) { (handlers[ev] || []).forEach((cb) => cb({}, state)); },
  };
}

function makeSession() {
  const listeners = {};
  return {
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    // 真实签名是 (event, item, webContents) —— webContents 是第三个参数，
    // DownloadItem 上没有可靠的等价属性。
    emit(ev, ...a) { (listeners[ev] || []).forEach((cb) => cb({}, ...a)); },
    // 真实签名 (event, item, webContents)。集中成助手，避免各处写错参数位。
    trigger(item, webContents) { this.emit('will-download', item, webContents); },
  };
}

describe('DownloadMonitor', () => {
  let dir;
  let broadcasts;
  let session;
  let mon;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-browser-dl-'));
    broadcasts = [];
    session = makeSession();
    mon = new DownloadMonitor(session, {
      dir,
      broadcast: (type, data) => broadcasts.push({ type, data }),
    });
    mon.install();
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  it('DLM-001: will-download 会落盘到 <dir>/<tabId>/<文件名>，路径可预期', () => {
    const item = makeItem();
    session.trigger(item, item.webContents || 'wc-x');
    expect(item.getSavePath()).toBe(path.join(dir, 'unknown', 'a.csv'));
    expect(fs.existsSync(path.join(dir, 'unknown'))).toBe(true);
  });

  it('DLM-002: 下载完成后记录 state=completed 并带回读的真实路径', () => {
    const item = makeItem();
    session.trigger(item, item.webContents || 'wc-x');
    item.fire('done', 'completed');
    const recs = mon.list('unknown').downloads;
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe('completed');
    expect(recs[0].path).toBe(path.join(dir, 'unknown', 'a.csv'));
    expect(recs[0].filename).toBe('a.csv');
    expect(recs[0].finished_at).toBeTruthy();
  });

  it('DLM-003: cancelled / interrupted 不得伪装成 completed', () => {
    // 只记 completed 会让 agent 拿着一个不存在的路径去读文件。
    for (const state of ['cancelled', 'interrupted']) {
      const item = makeItem({ filename: state + '.csv' });
      session.trigger(item, item.webContents || 'wc-x');
      item.fire('done', state);
    }
    const recs = mon.list('unknown').downloads;
    expect(recs.map((r) => r.state).sort()).toEqual(['cancelled', 'interrupted']);
    expect(recs.filter((r) => r.state === 'completed')).toHaveLength(0);
  });

  it('DLM-004: 完成时广播 download 事件（订阅者由此得知文件在哪儿）', () => {
    const item = makeItem();
    session.trigger(item, item.webContents || 'wc-x');
    item.fire('done', 'completed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe('download');
    expect(broadcasts[0].data.path).toBe(path.join(dir, 'unknown', 'a.csv'));
  });

  it('DLM-005: 文件名里的路径成分被剥掉（不能写到目录外）', () => {
    const item = makeItem({ filename: '../../etc/passwd' });
    session.trigger(item, item.webContents || 'wc-x');
    expect(item.getSavePath()).toBe(path.join(dir, 'unknown', 'passwd'));
  });

  it('DLM-006: 文件名里的控制/危险字符被替换', () => {
    const item = makeItem({ filename: 'a\u0000b:c*d?e"f<g>h|i.csv' });
    session.trigger(item, item.webContents || 'wc-x');
    const base = path.basename(item.getSavePath());
    expect(base).not.toMatch(/[\u0000-\u001f"*/:<>?\\|]/);
    expect(base.startsWith('a')).toBe(true);
  });

  it('DLM-007: 空文件名有兜底（不能拼出目录当文件）', () => {
    const item = makeItem({ filename: '' });
    session.trigger(item, item.webContents || 'wc-x');
    expect(path.basename(item.getSavePath())).toBe('download');
  });

  it('DLM-008: tabId 由注入的解析器决定；解析不出归 unknown 而不丢记录', () => {
    mon._resolveTab = (wc) => (wc === 'wc-7' ? 7 : undefined);
    const a = makeItem({ filename: 'a.csv' });
    const b = makeItem({ filename: 'b.csv' });
    session.trigger(a, 'wc-7');
    session.trigger(b, 'wc-other');
    expect(mon.list(7).downloads.map((d) => d.filename)).toEqual(['a.csv']);
    expect(mon.list('unknown').downloads.map((d) => d.filename)).toEqual(['b.csv']);
  });

  it('DLM-009: 解析器抛错不得让下载记录丢失', () => {
    mon._resolveTab = () => { throw new Error('boom'); };
    const item = makeItem();
    expect(() => session.trigger(item, 'wc-1')).not.toThrow();
    expect(mon.list('unknown').downloads).toHaveLength(1);
  });

  it('DLM-010: clearTab 只清记录；clearAll 清全部', () => {
    mon._resolveTab = () => 3;
    const a = makeItem({ filename: 'a.csv' });
    session.trigger(a, 'wc-3');
    mon._resolveTab = () => 4;
    const b = makeItem({ filename: 'b.csv' });
    session.trigger(b, 'wc-4');
    mon.clearTab(3);
    expect(mon.list(3).downloads).toHaveLength(0);
    expect(mon.list(4).downloads).toHaveLength(1);
    mon.clearAll();
    expect(mon.list(4).downloads).toHaveLength(0);
  });

  it('DLM-011: 单 tab 记录数有上限（长会话不无限累积）', () => {
    mon._resolveTab = () => 9;
    for (let i = 0; i < 260; i++) {
      session.trigger(makeItem({ filename: `f${i}.csv` }), null);
    }
    expect(mon.list(9).downloads.length).toBeLessThanOrEqual(200);
    // 丢的是最旧的，最新的必须还在 —— 否则 agent 找不到刚导出的文件。
    const names = mon.list(9).downloads.map((d) => d.filename);
    expect(names).toContain('f259.csv');
    expect(names).not.toContain('f0.csv');
  });

  it('DLM-012: 不传 tab 时列出全部，并带上目录', () => {
    const item = makeItem();
    session.trigger(item, item.webContents || 'wc-x');
    const all = mon.list();
    expect(all.downloads).toHaveLength(1);
    expect(all.dir).toBe(dir);
  });

  it('DLM-013: install 幂等 —— 重复 install 不会装两遍钩子（否则每条下载记两份）', () => {
    mon.install();
    mon.install();
    session.trigger(makeItem({ filename: 'once.csv' }), null);
    expect(mon.list('unknown').downloads).toHaveLength(1);
  });

  it('DLM-014: 目录不可创建时不抛（落盘失败由 done 状态体现，不炸掉下载）', () => {
    // 指向一个必然创建不出来的路径（父级是文件）
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const m2 = new DownloadMonitor(session, { dir: path.join(blocker, 'sub') });
    m2.install();
    const item = makeItem();
    expect(() => session.trigger(item)).not.toThrow();
    expect(m2.list('unknown').downloads).toHaveLength(1);
  });
});

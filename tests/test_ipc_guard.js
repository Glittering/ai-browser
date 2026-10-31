// tests/test_ipc_guard.js — 攻击用例：跨 tab / 跨连接的结果不能认领别人的 pending。
//
// 背景：`ai:tree` / `ai:action_result` / `ai:evaluate_result` 三个通道此前只按
// `payload.id` 取 pending，不校验 sender。requestId 是 `++` 自增（可枚举），
// 于是任何能发 IPC 的上下文都能"撞号"认领别人的请求。
//
// 判据抽成 shared/ipc_guard.cjs（纯函数），这样能用假对象把每种错配都跑一遍 ——
// 真实 ipcMain 在单测里起不来（PageManager 构造时就 import electron）。
import { describe, it, expect } from 'vitest';
import ipcGuard from '../src/shared/ipc_guard.cjs';

const { acceptResult, eventFromTab } = ipcGuard;

describe('acceptResult：谁能认领一个 pending', () => {
  const pending = { tabId: 7, kind: 'tree' };

  it('G1 同 tab 同 kind → 接受', () => {
    expect(acceptResult({ senderTab: 7, pending, expectedKind: 'tree' })).toBe(true);
  });

  it('G2 别人的 tab 撞号 → 拒绝（这是被利用的那条路）', () => {
    expect(acceptResult({ senderTab: 8, pending, expectedKind: 'tree' })).toBe(false);
  });

  it('G3 kind 不符 → 拒绝（action 的回执不能冒充 tree）', () => {
    expect(acceptResult({ senderTab: 7, pending, expectedKind: 'action' })).toBe(false);
  });

  it('G4 sender 归属不明（已销毁 / 非本应用 webContents）→ 拒绝', () => {
    expect(acceptResult({ senderTab: null, pending, expectedKind: 'tree' })).toBe(false);
    expect(acceptResult({ senderTab: undefined, pending, expectedKind: 'tree' })).toBe(false);
  });

  it('G5 pending 不存在（id 撞空）→ 拒绝，且不抛', () => {
    expect(acceptResult({ senderTab: 7, pending: null, expectedKind: 'tree' })).toBe(false);
    expect(acceptResult({ senderTab: 7, pending: undefined, expectedKind: 'tree' })).toBe(false);
  });

  it('G6 不传 expectedKind 时只校验 tab（ai:event 这类没有 kind 的通道）', () => {
    expect(acceptResult({ senderTab: 7, pending: { tabId: 7 } })).toBe(true);
    expect(acceptResult({ senderTab: 9, pending: { tabId: 7 } })).toBe(false);
  });

  it('G7 0 号 tab 不能被当成"假值"放行（tabId 可能是 0）', () => {
    expect(acceptResult({ senderTab: 0, pending: { tabId: 0, kind: 'tree' }, expectedKind: 'tree' })).toBe(true);
    expect(acceptResult({ senderTab: 1, pending: { tabId: 0, kind: 'tree' }, expectedKind: 'tree' })).toBe(false);
  });
});

describe('eventFromTab：watcher 事件必须带得出发起 tab', () => {
  it('G8 有 sender tab → 返回 tabId', () => {
    expect(eventFromTab({ senderTab: 3 })).toBe(3);
  });

  it('G9 归属不明 → null（主进程不许广播一个不知道来自哪的事件）', () => {
    expect(eventFromTab({ senderTab: null })).toBe(null);
    expect(eventFromTab({ senderTab: undefined })).toBe(null);
  });
});

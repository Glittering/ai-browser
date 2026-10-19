// tests/test_api_budget.js — API 面的成本预算（防回退闸门）
//
// 为什么需要这个文件：
// MCP 客户端**每一轮**都会把完整 tool 列表注入上下文。所以工具 schema 的
// 体积不是"文档问题"，而是**每一轮都在付的固定税**。实测（2026-10-19）：
// 20 个工具 17,502 字节 ≈ 4,730 token/轮；browse_act 单条 4,353 字节、
// 27 个顶层参数，一条占 24.9%。
//
// 这个文件的作用是把成本变成可执行断言。**每次优化提交时手动下调预算**——
// 于是 git 历史本身就是优化进度表，而不是靠文档里一句"我们优化过了"。
// 预算只许往下走：改大必须在这里说明理由，否则 CI 红。
//
// 优化方案见 docs/PLAN_SKILL_API_V2.md。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── 预算 ────────────────────────────────────────────────────────────────
// P0 基线（2026-10-19）：先锁住现状，不许变差。
// P2（参数分组瘦身）完成后应下调为：
//   totalBytes 9,600 · maxToolBytes 1,600 · maxTopLevelParams 12
// P3（工具收敛到 13 个）完成后应下调为：
//   totalBytes 8,200 · maxTools 13
const BUDGET = {
  totalBytes: 17_600,
  maxToolBytes: 4_400,
  maxTopLevelParams: 28,
  maxTools: 20,
};

// 3.7 字节/token：本项目的 schema 全是英文标识符 + 短句，比纯英文略密。
const TOKENS = (bytes) => Math.round(bytes / 3.7);

const measured = MCP_TOOLS.map((t) => ({
  name: t.name,
  bytes: JSON.stringify(t).length,
  params: Object.keys(t.inputSchema?.properties || {}).length,
}));
const totalBytes = measured.reduce((s, m) => s + m.bytes, 0);

describe('API 预算：工具 schema 的每轮固定成本', () => {
  it('打印当前实测（每次跑都有痕迹，便于对比历史）', () => {
    const rows = [...measured].sort((a, b) => b.bytes - a.bytes);
    const lines = [
      '',
      `  工具数 ${MCP_TOOLS.length} · 总计 ${totalBytes} B ≈ ${TOKENS(totalBytes)} token/轮`,
      `  预算   ${BUDGET.maxTools} 个 · ${BUDGET.totalBytes} B ≈ ${TOKENS(BUDGET.totalBytes)} token`,
      '  ---',
      ...rows
        .slice(0, 5)
        .map((r) => `  ${r.name.padEnd(24)} ${String(r.bytes).padStart(6)} B  ${String(r.params).padStart(3)} 参数`),
    ];
    console.log(lines.join('\n'));
    expect(measured.length).toBeGreaterThan(0);
  });

  it('B-1: 工具总数不超预算', () => {
    expect(MCP_TOOLS.length, `工具数 ${MCP_TOOLS.length} > 预算 ${BUDGET.maxTools}`).toBeLessThanOrEqual(
      BUDGET.maxTools
    );
  });

  it('B-2: schema 总字节不超预算（这是每轮都在付的税）', () => {
    expect(totalBytes, `总字节 ${totalBytes} > 预算 ${BUDGET.totalBytes}`).toBeLessThanOrEqual(
      BUDGET.totalBytes
    );
  });

  it('B-3: 单个工具不得成为巨无霸（当前瓶颈是 browse_act）', () => {
    const over = measured.filter((m) => m.bytes > BUDGET.maxToolBytes);
    expect(
      over.map((m) => `${m.name}=${m.bytes}B`),
      `超过单工具预算 ${BUDGET.maxToolBytes}B`
    ).toEqual([]);
  });

  it('B-4: 单个工具的顶层参数不超预算（拍平参数会撞名，见 mcp_server.js dx 事故）', () => {
    const over = measured.filter((m) => m.params > BUDGET.maxTopLevelParams);
    expect(
      over.map((m) => `${m.name}=${m.params}`),
      `超过顶层参数预算 ${BUDGET.maxTopLevelParams}`
    ).toEqual([]);
  });

  it('B-5: 工具名必须带 browse_ 前缀且唯一（客户端靠名字消歧）', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('browse_')).toBe(true);
  });

  it('B-6: 每个工具都必须有 description（agent 只能靠它决定用不用）', () => {
    for (const t of MCP_TOOLS) {
      expect(typeof t.description, `${t.name} 缺 description`).toBe('string');
      expect(t.description.trim().length, `${t.name} 的 description 是空的`).toBeGreaterThan(8);
    }
  });
});

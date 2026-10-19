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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── 预算 ────────────────────────────────────────────────────────────────
// 预算只许往下走。改大必须在这里写明理由，否则 CI 红。
//
// 历史：
//   P0 基线 17,600 B / 单工具 4,400 / 顶层参数 28 / 20 个工具
//   P2 之后 17,100 B / 单工具 4,200 / 顶层参数 14   ← 当前
//
// ⚠️ P2 的实测结论（重要，别自欺）：**参数分组几乎不省字节。**
// browse_act 27→13 个顶层参数、browse_network 23→7，但字节只从 17,502 降到
// 17,033（−2.7%），因为 JSON Schema 的嵌套本身有结构开销（type/properties/
// description 的包装）。分组换来的是**认知负荷减半**，不是 token 减半。
// 字节的账要靠 P3（减少工具数）和描述瘦身来还 —— 那两个阶段完成后再下调。
const BUDGET = {
  totalBytes: 17_450,
  maxToolBytes: 4_200,
  maxTopLevelParams: 14,
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

// ── 技能包预算 ──────────────────────────────────────────────────────────
// 入口文档是"冷启动必须读的那一段"。它一旦膨胀，就会退回到 2026-10 之前那种
// "新会话先读 3,000 token 才知道怎么开始"的状态，所以在这里卡死。
// 深层知识放 references/，按需读，不受这个预算约束。
const ENTRY_BUDGET_BYTES = 2_600;
const MAX_REFERENCES = 6;

const skillsRoot = join(ROOT, 'skills');
const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsRoot, d.name, 'SKILL.md')))
  .map((d) => d.name);

describe('技能包：能否被客户端"装一次、之后自动发现"', () => {
  it('S-1: skills/ 必须随 npm 包分发（曾经漏发，导致用户永远拿不到技能）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files, 'package.json 的 files 里没有 skills —— 用户装不到技能').toContain('skills');
  });

  it('S-2: 至少有一个技能，且每个技能都有合法 frontmatter', () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const s of skillDirs) {
      const md = readFileSync(join(skillsRoot, s, 'SKILL.md'), 'utf8');
      expect(md.startsWith('---'), `${s}/SKILL.md 缺 frontmatter`).toBe(true);
      const fm = md.slice(3, md.indexOf('\n---', 3));
      expect(/^name:\s*\S+/m.test(fm), `${s} 缺 name`).toBe(true);
      expect(/^description:/m.test(fm), `${s} 缺 description`).toBe(true);
      // description 是唯一决定"要不要加载这个技能"的东西，太空就没法触发了
      expect(fm.length, `${s} 的 description 太短，触发不了`).toBeGreaterThan(120);
    }
  });

  it('S-3: 入口 SKILL.md 不超预算（冷启动成本闸门）', () => {
    const entry = join(skillsRoot, 'ai-browser', 'SKILL.md');
    const bytes = readFileSync(entry).length;
    console.log(`\n  入口 SKILL.md ${bytes} B ≈ ${Math.round(bytes / 1.9)} token（预算 ${ENTRY_BUDGET_BYTES} B）`);
    expect(bytes, `入口 SKILL.md ${bytes}B 超过预算 ${ENTRY_BUDGET_BYTES}B`).toBeLessThanOrEqual(
      ENTRY_BUDGET_BYTES
    );
  });

  it('S-4: 入口里链接的 references 必须真实存在（死链会让 agent 卡在半路）', () => {
    const entryDir = join(skillsRoot, 'ai-browser');
    const md = readFileSync(join(entryDir, 'SKILL.md'), 'utf8');
    const links = [...md.matchAll(/references\/[\w.-]+\.md/g)].map((m) => m[0]);
    expect(links.length, '入口没有指向任何 reference，深层知识无处可去').toBeGreaterThan(0);
    for (const rel of links) {
      expect(existsSync(join(entryDir, rel)), `死链：${rel}`).toBe(true);
    }
    const refs = readdirSync(join(entryDir, 'references')).filter((f) => f.endsWith('.md'));
    expect(refs.length, 'references 太多，等于没分层').toBeLessThanOrEqual(MAX_REFERENCES);
  });

  it('S-5: 兜底说明书必须够小（它是应急卡片，不是教程）', () => {
    const p = join(ROOT, 'examples', 'AGENT_INSTRUCTIONS.md');
    const bytes = readFileSync(p).length;
    console.log(`  兜底 AGENT_INSTRUCTIONS.md ${bytes} B ≈ ${Math.round(bytes / 1.9)} token`);
    expect(bytes, `兜底说明书 ${bytes}B 又长回去了（曾经 12,168B）`).toBeLessThanOrEqual(3_200);
  });
});

// tests/test_mcp_forwarding.js — 「schema 声明了，就必须真的转发」的表驱动闸门。
//
// 事故（docs/AUDIT-2026-10-30.md P1-1）：
//   `browse_evaluate` 的 schema 明确写了 frame_ref（"Run inside this cross-process
//   frame"，还解释了为什么字符串拼接会静默失效），但 mcp_server.js 转发时只给了
//   js / tab —— 于是 agent 按文档传 frame_ref，JS 仍在顶层帧跑、对 iframe 内元素
//   返回 null。**不报错、不告警**，调用方只会得出"元素不存在"。
//   这是「同一概念在两层形状/名字不同 → 调用方不报错，只拿不到数据」的第 5 次。
//
// 为什么用表而不是再写一条针对性断言：
//   17 个工具、每个参数都要在 mcp_server 里再抄一遍，抄漏是**必然**会再发生的。
//   把"声明集合"与"转发集合"做成一次比对，任何新参数忘了转发就红。
//
// 三层归一化，避免误报：
//   1. MCP 用 snake_case、WS 用 camelCase（focused_only ↔ focusedOnly），
//      所以比较前统一去下划线 + 小写 —— 比的是"这个概念有没有被转发"，
//      不是"字面是否一致"。
//   2. 分组参数（browse_act 的 click/read/press/wheel/drag、browse_network 的
//      filters/include/body_offset/configure）由 mcp_args.js 单点映射，
//      schema 里的分组名不会出现在 case 块里 —— 从 mcp_args.js 源码提取它接管的键。
//   3. 整包透传（`call('ui.screenshot', args)`）视为全部转发。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const ROOT = process.cwd();
const mcpSrc = readFileSync(join(ROOT, 'src/main/mcp_server.js'), 'utf8');
const argsSrc = readFileSync(join(ROOT, 'src/main/mcp_args.js'), 'utf8');

const norm = (s) => String(s).replace(/_/g, '').toLowerCase();

/** 切出每个 `case 'browse_x': { ... }` 的方法体（到下一个 case 之前）。 */
function caseBlocks(src) {
  const hits = [...src.matchAll(/case '(browse_[a-z_]+)':\s*\{/g)].map((m) => ({
    name: m[1],
    start: m.index,
  }));
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : src.length;
    out[hits[i].name] = src.slice(hits[i].start, end);
  }
  return out;
}

const blocks = caseBlocks(mcpSrc);

/** mcp_args.js 里被映射层接管的参数键（args.x / click.x / filters.x …）。 */
const delegated = new Set(
  [...argsSrc.matchAll(/\b(?:args|click|read|press|wheel|drag|f|inc|off|cfg)\.([a-z_][a-z0-9_]*)/g)]
    .map((m) => norm(m[1]))
);

/**
 * 去掉注释再取标识符。
 * ⚠️ 这一步不是洁癖：本项目的注释里大量出现参数名（"旧版这里只传 js/tab，
 * schema 却承诺了 frame_ref"），不剥注释的话「注释提到过」就能让闸门变绿 ——
 * 实测过一次：删掉真正的转发后，MF-2 仍绿，只有 MF-3 红。
 */
const stripComments = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');

/** 块里的所有标识符（归一化后），用于判断"这个参数有没有被碰到"。 */
const identifiersOf = (block) =>
  new Set([...stripComments(block).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => norm(m[0])));

/** 整包透传：`call('ui.screenshot', args)` / `call('ui.x', args)`. */
const passesWholeArgs = (block) => /call\('ui\.[a-z_]+',\s*args\s*\)/.test(String(block));

describe('MCP 转发闸门 — schema 声明的参数必须真的被送到 RPC', () => {
  it('MF-1: 每个工具有对应的 case 块（阳性对照：解析不到就等于闸门失效）', () => {
    const missing = MCP_TOOLS.map((t) => t.name).filter((n) => !blocks[n]);
    expect(missing, '这些工具在 mcp_server.js 里找不到 case 块').toEqual([]);
    expect(Object.keys(blocks).length).toBeGreaterThanOrEqual(MCP_TOOLS.length);
  });

  it('MF-2: 每个 schema 参数都被转发（case 块里出现，或由 mcp_args 接管，或整包透传）', () => {
    const problems = [];
    for (const tool of MCP_TOOLS) {
      const block = blocks[tool.name];
      if (!block) continue; // MF-1 已经报过
      if (passesWholeArgs(block)) continue;
      const ids = identifiersOf(block);
      const props = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {});
      for (const prop of props) {
        const n = norm(prop);
        if (ids.has(n) || delegated.has(n)) continue;
        problems.push(`${tool.name}: "${prop}" 声明了但没有转发（既不出现、也不在 mcp_args 里）`);
      }
    }
    expect(
      problems,
      '\n' + problems.join('\n') + '\n\n这是 AUDIT-2026-10-30 P1-1 那一类：能力静默失效，不报错。'
    ).toEqual([]);
  });

  it('MF-3: frame_ref 是 P1-1 的回归点 —— browse_evaluate 必须真的把它传下去', () => {
    const block = blocks['browse_evaluate'];
    expect(block, 'browse_evaluate 的 case 块找不到').toBeTruthy();
    // 同时钉住"传给谁"：必须落在 ui.evaluate 的转发对象里，而不是别处提到一次
    const callIdx = block.indexOf("call('ui.evaluate'");
    expect(callIdx, '找不到 ui.evaluate 的转发点').toBeGreaterThanOrEqual(0);
    const callSrc = block.slice(callIdx, callIdx + 400);
    expect(
      /frame_ref\s*:\s*args\.frame_ref/.test(callSrc),
      'frame_ref 必须出现在 ui.evaluate 的转发对象里（AUDIT P1-1 回归点）'
    ).toBe(true);
  });

  it('MF-4: 归一化是真的在做（snake_case ↔ camelCase 不误报）', () => {
    // get_tree 的 schema 是 focused_only，实现里是 focusedOnly
    expect(norm('focused_only')).toBe(norm('focusedOnly'));
    // 反例：两个不同的概念不许被归一化成同一个
    expect(norm('frame_ref')).not.toBe(norm('tab'));
  });
});

// tests/test_skill_param_drift.js — 「文档里写的参数名，schema 里必须真的有」
//
// 为什么需要它（2026-11-25）：
// 现有的闸门只挡住了两级漂移 ——
//   · S-6：技能里提到的 browse_* 工具名必须存在
//   · S-7：技能里提到的 ui.* 方法必须存在
// 但**参数名**没人管。于是文档可以教 agent 传一个 schema 里根本没有的参数，
// 而且三层都不会报错：客户端 schema 校验（宽松的）放过、mcp_server 不转发、
// WS 层当没看见 —— agent 只会得出"这功能没用"。
//
// 实测抓到的那一例：`references/hard-pages.md` 教 `browse_canvas {operation:"configure",
// reload:true}`（canvas hook 对"装之前已画完"的内容无能为力，重载是唯一办法），
// 而 browse_canvas 的 schema 没声明 reload、mcp_server 也没转发 → "现装现读"
// 静默失效。修法是补 schema + 补转发（由 test_mcp_forwarding 继续盯着），
// 而不是把文档改掉 —— 能力本来就在，只是上面两层没接线。
//
// 判据：把文档里所有 `browse_x { ... }` 调用片段按花括号深度解析出来，逐层对照
// inputSchema.properties。允许分组（filters/include/... 是对象就下钻一层）。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const ROOT = process.cwd();
const TOOLS = new Map(MCP_TOOLS.map((t) => [t.name, t.inputSchema?.properties || {}]));

/** 解析文本里每个 `browse_x { ... }` 片段的参数键，逐层对照 schema。 */
function paramDrift(text) {
  const bad = [];
  const re = /(browse_[a-z_]+)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const tool = m[1];
    const props = TOOLS.get(tool);
    if (!props) continue; // 工具名本身的漂移由 S-6 负责，这里只管参数

    let i = re.lastIndex;
    let depth = 1;
    let buf = '';
    const stack = [props];

    while (i < text.length && depth > 0) {
      const ch = text[i];

      // 字符串字面量整段跳过 —— 否则 "https://x" 里的冒号会被当成参数名
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') i++;
          i++;
        }
        buf = '';
        i++;
        continue;
      }

      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) break;
        if (stack.length > 1) stack.pop();
      } else if (ch === ':') {
        const key = buf.trim();
        if (/^[a-zA-Z_]\w*$/.test(key)) {
          const cur = stack[stack.length - 1];
          if (!(key in cur)) {
            bad.push({ tool, key });
          } else if (/^\s*\{/.test(text.slice(i + 1))) {
            const sub = cur[key];
            stack.push(sub?.properties || {});
          }
        }
        buf = '';
      } else if (ch === ',') {
        buf = '';
      } else {
        buf += ch;
      }
      i++;
    }
  }
  return bad;
}

function docFiles() {
  const out = [];
  const skillRoot = join(ROOT, 'skills');
  for (const d of readdirSync(skillRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(skillRoot, d.name);
    const entry = join(dir, 'SKILL.md');
    if (!existsSync(entry)) continue;
    out.push(entry);
    const refDir = join(dir, 'references');
    if (existsSync(refDir)) {
      for (const f of readdirSync(refDir)) if (f.endsWith('.md')) out.push(join(refDir, f));
    }
  }
  for (const rel of ['examples/AGENT_INSTRUCTIONS.md', 'llms-install.md']) {
    const p = join(ROOT, rel);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

describe('技能文档里的参数名不得漂移', () => {
  it('P-1: 每个 browse_* 调用片段里的参数，都必须真的在 schema 里', () => {
    const problems = [];
    for (const f of docFiles()) {
      for (const b of paramDrift(readFileSync(f, 'utf8'))) {
        problems.push(`${f.replace(ROOT + '/', '')}: ${b.tool} 用了不存在的参数 "${b.key}"`);
      }
    }
    expect(
      problems,
      problems.length
        ? '文档教 agent 传 schema 里没有的参数 —— 客户端/服务端都不会报错，agent 只会得出"这功能没用"。\n' +
          '修法二选一：\n' +
          '  a) 参数确实该有 → 补进 mcp_tools.js 的 schema，并在 mcp_server 里转发（test_mcp_forwarding 会接着盯）；\n' +
          '  b) 参数不存在 → 改文档，别教一个做不到的动作。\n' +
          problems.join('\n')
        : ''
    ).toEqual([]);
  });

  it('P-2: 解析器自身要能识破「字符串里的冒号」这种假参数名', () => {
    // 防的是闸门自己失效：曾经把 url 里的 "https:" 当成参数名报假错
    const text = 'browse_navigate {"url":"https://example.com"}';
    expect(paramDrift(text)).toEqual([]);
    const bad = 'browse_navigate {"url":"https://example.com", ssr:true}';
    expect(paramDrift(bad).map((x) => x.key)).toContain('ssr');
  });

  it('P-3: 分组参数要能下钻一级（filters/include 里的键也算数）', () => {
    expect(paramDrift('browse_network {operation:"list", filters:{url_contains:"/api"}}')).toEqual([]);
    expect(
      paramDrift('browse_network {operation:"list", filters:{not_a_real_filter:"x"}}').map((x) => x.key)
    ).toContain('not_a_real_filter');
  });
});

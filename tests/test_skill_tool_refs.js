// tests/test_skill_tool_refs.js — 文档里说的工具名必须真的存在。
//
// 起因（2026-10-19）：两个技能里写着 `browse_subscribe` / `browse_network_body`，
// 而这两个 MCP 工具**根本不存在**（订阅是 WS-only 的能力，从来没做成 MCP 工具）。
// 后果不对称：
//   · 强模型照着调一次，报错，然后自己换工具；
//   · 弱模型调一次报错，就认定"这个能力用不了"，直接放弃 —— 用户看到的就是
//     「它死活认不出来」。
// 所以这类腐坏必须由测试挡住，不能靠人记得同步文档。
//
// 顺便挡第二条：技能里必须有一个**可照抄的字面调用**（`browse_xxx {...}` 或
// `browse_xxx(...)`）。写"你应该读树然后操作"这种散文，弱模型学不会；给它一行
// 能直接改参数的调用，它才学得会。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KNOWN = new Set(MCP_TOOLS.map((t) => t.name));

/** 递归收集某个目录下的 .md 文件。 */
function mdFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p));
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** 文档里提到的所有 browse_* 名字。 */
function toolRefs(text) {
  return [...text.matchAll(/browse_[a-z_]+/g)].map((m) => m[0]);
}

describe('技能 / 文档里提到的工具必须存在', () => {
  const docs = [...mdFiles(join(ROOT, 'skills')), ...mdFiles(join(ROOT, 'examples'))];

  it('R-0: 确实扫到了文档（否则下面的断言会因为"没东西可测"而假绿）', () => {
    expect(docs.length).toBeGreaterThan(3);
  });

  it('R-1: skills/ 与 examples/ 里不出现不存在的 browse_* 工具名', () => {
    const bad = [];
    for (const f of docs) {
      const text = readFileSync(f, 'utf8');
      for (const name of toolRefs(text)) {
        if (!KNOWN.has(name)) bad.push(`${name} ← ${f.replace(ROOT + '/', '')}`);
      }
    }
    // 报错信息里带上全部已知工具名，改的人不用再翻代码
    expect(bad, `不存在的工具被写进文档：\n${bad.join('\n')}\n\n现有工具：${[...KNOWN].join(', ')}`)
      .toEqual([]);
  });
});

describe('技能的形态（决定弱模型能不能用起来）', () => {
  const skillDirs = existsSync(join(ROOT, 'skills'))
    ? readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'skills', d.name, 'SKILL.md')))
      .map((d) => d.name)
    : [];

  function read(name) {
    return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  }

  it('S-1: 每个技能都至少有一个可直接照抄的字面调用（弱模型靠模仿，不靠推理）', () => {
    for (const name of skillDirs) {
      const text = read(name);
      // `browse_xxx {"k":"v"}` / `browse_xxx({ k: v })` / `browse_xxx {k:"v"}` 都算。
      // 判据只有一条：工具名后面紧跟着一段花括号参数 —— 那是"能直接改着用"的信号。
      const literal = /browse_[a-z_]+\s*[({]?[^\n]{0,40}\{/.test(text);
      expect(literal, `${name}/SKILL.md 里没有可照抄的字面调用示例（应有一行形如 browse_x {"k":"v"} 的调用）`)
        .toBe(true);
    }
  });

  it('S-2: description 里必须带中文触发词（客户端靠它做技能匹配）', () => {
    for (const name of skillDirs) {
      const text = read(name);
      const m = text.match(/^---\n[\s\S]*?description:[\s\S]*?\n---/);
      expect(m, `${name}/SKILL.md 缺 frontmatter description`).toBeTruthy();
      expect(/触发词|Use when|用于/.test(m[0]), `${name} 的 description 里没有触发条件`).toBe(true);
    }
  });

  it('S-3: description 不超过 600 字符 —— 越长的描述在弱模型上匹配越糊', () => {
    for (const name of skillDirs) {
      const text = read(name);
      const m = text.match(/description:\s*>-?\s*([\s\S]*?)\n---/);
      const len = (m ? m[1].trim() : '').length;
      expect(len, `${name} 的 description 有 ${len} 字符，超过 600`).toBeLessThanOrEqual(600);
    }
  });
});

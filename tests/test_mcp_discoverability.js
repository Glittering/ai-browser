// tests/test_mcp_discoverability.js — 「新会话里 agent 会不会用上这个工具」的护栏
//
// 起源（2026-11-25）：用户反馈"给新 agent 说用 ai-browser，它不知道是什么东西，
// 找不到相关技能，就不用；非得点名 GitHub 仓库、强调一定要用，它才去查资料"。
//
// 排查结论不是"技能写得差"，而是**发现链断了三处**：
//   1. InitializeResult 没有 instructions —— 协议里唯一能让服务端自我介绍的地方
//      是空的，agent 只看到 17 个名字像通用动词的 browse_*；
//   2. 入口工具的描述是"机制视角"（data-ai-id / subset / milestone），没有一个字
//      说明"用户要干什么时用它"。模型是拿意图去匹配描述的，描述里没有意图词就
//      匹配不上；
//   3. 技能副本会静默停在旧版本（见 tests/test_skill_upgrade.js）。
//
// 这个文件把 1 和 2 钉住。判据很朴素：**只拿到工具清单和 instructions 的模型，
// 能不能判断该不该用、第一步做什么**。文本措辞可以改，这几条不能丢。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';
import { MCP_INSTRUCTIONS } from '../src/main/mcp_instructions.js';

const ROOT = process.cwd();
const INSTRUCTIONS = MCP_INSTRUCTIONS;

// instructions 每个会话注入一次（不是每轮），但它是纯增量成本，仍要卡住。
// 超了先问"这句话是不是 schema 已经说过了"，而不是直接调大。
const MAX_CHARS = 1_500;

describe('MCP instructions：服务端必须能自我介绍', () => {
  it('D-1: 不能为空，且要够长到能说清用途（太短等于没写）', () => {
    expect(typeof INSTRUCTIONS).toBe('string');
    expect(INSTRUCTIONS.trim().length).toBeGreaterThan(300);
  });

  it('D-2: 不超预算（每个会话的固定成本）', () => {
    expect(INSTRUCTIONS.length, `instructions ${INSTRUCTIONS.length} 字符，预算 ${MAX_CHARS}`).toBeLessThanOrEqual(
      MAX_CHARS
    );
  });

  it('D-3: 必须回答"我是什么" —— 真窗口、可被人接管', () => {
    expect(INSTRUCTIONS).toMatch(/real, visible browser/i);
    expect(INSTRUCTIONS, '要说明人可以在窗口里抢鼠标，这是它区别于无头浏览器的地方').toMatch(
      /take over|take the mouse|click and type/i
    );
  });

  it('D-4: 必须回答"什么时候用我" —— 带意图词，不是参数名', () => {
    // 只要求覆盖最常见的几类意图。换措辞可以，但不能退回纯机制描述。
    for (const intent of ['open a page', 'read', 'click', 'fill a form', 'log in', 'download']) {
      expect(INSTRUCTIONS.toLowerCase(), `instructions 缺意图词：${intent}`).toContain(intent);
    }
  });

  it('D-5: 必须给出最小循环（导航 → 读树 → 动作），且三个工具名真实存在', () => {
    const known = new Set(MCP_TOOLS.map((t) => t.name));
    const refs = [...new Set([...INSTRUCTIONS.matchAll(/browse_[a-z][a-z_]*/g)].map((m) => m[0]))];
    expect(refs.length, 'instructions 至少要提到入口工具，否则 agent 不知道从哪开始').toBeGreaterThanOrEqual(3);
    for (const r of refs) {
      expect(known.has(r), `instructions 提到了不存在的工具：${r}`).toBe(true);
    }
    for (const core of ['browse_navigate', 'browse_get_tree', 'browse_act']) {
      expect(INSTRUCTIONS, `最小循环缺 ${core}`).toContain(core);
    }
  });

  it('D-6: 必须带上"success 只代表发出去了"这条硬规矩（否则 agent 会谎报完成）', () => {
    expect(INSTRUCTIONS).toMatch(/success:true means the action was dispatched/i);
    expect(INSTRUCTIONS).toContain('browse_diff');
  });

  it('D-7: mcp_server 必须真的把它交给 Server 选项（写了不接线等于没写）', () => {
    const src = readFileSync(join(ROOT, 'src', 'main', 'mcp_server.js'), 'utf8');
    expect(src, 'mcp_server.js 没有 import MCP_INSTRUCTIONS').toMatch(
      /import\s*\{\s*MCP_INSTRUCTIONS\s*\}\s*from\s*'\.\/mcp_instructions\.js'/
    );
    expect(src, 'Server 选项里没有 instructions —— 客户端收不到自我介绍').toMatch(
      /instructions:\s*MCP_INSTRUCTIONS/
    );
    // 能力声明保持原样：这是 invariants 里钉死的不变量，不能顺手改掉
    expect(src).toMatch(/capabilities:\s*\{\s*tools:\s*\{\},\s*resources:\s*\{\},\s*prompts:\s*\{\}\s*\}/);
  });
});

describe('入口工具描述：先讲"何时用"，再讲机制', () => {
  const core = ['browse_navigate', 'browse_get_tree', 'browse_act'];

  it('D-8: 三个入口工具的描述必须以 "Use" 开头（意图优先）', () => {
    for (const name of core) {
      const t = MCP_TOOLS.find((x) => x.name === name);
      expect(t, `${name} 不存在`).toBeTruthy();
      expect(
        t.description.startsWith('Use'),
        `${name} 的描述又退回机制视角了：「${t.description.slice(0, 60)}…」\n` +
          '模型是拿用户意图去匹配工具描述的；开头不是"什么时候用"，它就匹配不上。'
      ).toBe(true);
    }
  });

  it('D-9: browse_get_tree 的描述必须让人看懂它就是"读页面"（不能只写 semantic tree）', () => {
    const d = MCP_TOOLS.find((x) => x.name === 'browse_get_tree').description;
    expect(d.toLowerCase()).toContain('read the page');
  });

  it('D-10: browse_act 必须点明 target 是树里的 id，不是可见文字（最高频的误用）', () => {
    const d = MCP_TOOLS.find((x) => x.name === 'browse_act').description;
    expect(d).toContain('browse_get_tree');
    expect(d.toLowerCase()).toContain('never'); // "never visible text"
  });
});

// tests/test_bug3_agent_docs.js — Bug 3：agent-facing 文档 / browse_tabs schema
// 不得再残留 pre-Bug-2 / pre-merge 的 stale 语义。
//
// 背景（2026-10-28 修完 Bug 1 / Bug 2 后自查）：
//   · src/main/mcp_tools.js 的 browse_tabs **顶层** description 已改写；
//   · src/main/mcp_server.js 的 switch handler 已改传 show；
//   · skills/ai-browser/references/tasks.md 已改写；
//   · ……
// 但 agent 真正会读到的另一层 —— **schema 里 op property 的 description**，
// 以及 agent 常会优先读的 **README.md / llms-install.md** —— 仍停留在旧规则：
//   · op description 只提 list / switch / window，没提 new / close；
//   · README / llms 还把“省略 tab = active tab”写进工具说明；
//   · browse_tabs 的 op 列表漏掉 window，且 switch 没讲 show:true。
//
// Bug 3 的修法：把这三类 stale 文案全部清掉，使 source of truth 与 agent 文档
// 真正同义，而不是只修了一半。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const browseTabs = MCP_TOOLS.find((t) => t.name === 'browse_tabs');
const navigate = MCP_TOOLS.find((t) => t.name === 'browse_navigate');
const opDesc = browseTabs?.inputSchema?.properties?.op?.description;

describe('Bug 3 — agent-facing tab docs / browse_tabs schema must not stay stale', () => {
  it('BUG3-1: source browse_navigate 描述不得把“省略 tab”定义成 active tab', () => {
    expect(navigate.description, 'browse_navigate 的 description 不应出现 stale 文案').not.toContain(
      'active tab'
    );
    expect(navigate.description, 'browse_navigate 应描述自己的 tab').toContain('your tab');
  });

  it('BUG3-2: browse_tabs.op description 必须覆盖全部五个 op，且不能是旧的“list+switch+window only”写法', () => {
    expect(browseTabs.inputSchema.properties.op.enum, 'op enum').toEqual([
      'list',
      'new',
      'close',
      'switch',
      'window',
    ]);
    expect(opDesc, 'browse_tabs.op description').toContain('new');
    expect(opDesc, 'browse_tabs.op description').toContain('close');
    expect(opDesc, 'browse_tabs.op description').toContain('switch');
    expect(opDesc, 'browse_tabs.op description').toContain('window');
    expect(opDesc, 'browse_tabs.op description').not.toContain('switch = set default; window = hide/show');
  });

  it('BUG3-3: README.md 不得把“省略 tab = active tab”写进 agent 工具说明', () => {
    const readme = read('README.md');
    expect(readme, 'README tool table 仍出现 pre-Bug-2 文案').not.toContain(
      'Load a URL in the active (or given) tab.'
    );
    expect(readme, 'README 默认 tab 解析仍指向 active tab').not.toContain(
      'without it they target the active tab'
    );
  });

  it('BUG3-4: llms-install.md 不得把“省略 tab = active tab”写进最短 agent 入口', () => {
    const llms = read('llms-install.md');
    expect(llms, 'llms-install 仍出现 pre-Bug-2 文案').not.toContain(
      'load a URL in the active or given tab.'
    );
    expect(llms, 'llms-install 的 browse_tabs op 仍缺 window / show 语义').not.toContain(
      '{op: "list" | "new" | "close" | "switch"}'
    );
  });

  it('BUG3-5: agent-facing 文档必须同步新的 own-tab / show:true / window 语义', () => {
    const readme = read('README.md');
    const llms = read('llms-install.md');

    // 新语义的关键锚点：省略 tab = session default（自己这一路）。
    expect(readme, 'README 必须说明省略 tab 打自己工作页').toContain('omit `tab`');
    expect(readme, 'README 必须说明省略 tab 打自己工作页').toContain('your own');

    // browse_tabs 必须完整列出五个 op，且 switch 必须带 show:true 语义。
    expect(readme, 'README browse_tabs 必须包含 window').toContain('`window`');
    expect(readme, 'README browse_tabs switch 必须说明 show:true').toContain('show:true');

    // llms-install 是 agent 最短入口，不能比 source schema 更 stale。
    expect(llms, 'llms-install 必须包含 window op').toContain('"window"');
    expect(llms, 'llms-install 必须说明 switch show:true').toContain('show:true');
  });
});

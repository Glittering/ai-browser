// tests/test_bug4_group_full_mcp_error.js — Bug 4：group-full 必须以
// isError **工具结果** 回到 agent，而不是逃成 JSON-RPC protocol error。
//
// 背景 / 待证伪：
//   · WS 层 `ui.new_tab` 已经有一条 group-full 拒绝路径（-32001 + data.reason），
//     e2e / ws_handlers / tab_group 都把它钉死。
//   · 但 MCP 这一层（src/main/mcp_server.js 的 CallToolRequest handler）直接
//     `await wsClient.call(...)` 然后 `return { content: ... }`。wsClient 失败时
//     promise reject → handler throw → SDK Server wrapper 只做 schema 校验，
//     **不把异常转成 tool result** → Protocol 层把错误当成 JSON-RPC error 回。
//   · 结果：agent 看到的是 "Error calling tool ...: ...",而不是合法的
//     `{content:[...], isError:true}`，目录审核 / 客户端实际调用都把它当成
//     protocol failure 处理 —— group-full 的"请关掉一个"提示根本到不了 agent。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const mcpSrc = read('src/main/mcp_server.js');

function extractBrowseTabsOpNewBlock() {
  const marker = "if (op === 'new') {";
  const start = mcpSrc.indexOf(marker);
  expect(
    start,
    'src/main/mcp_server.js 找不到 browse_tabs op==="new" 分支'
  ).toBeGreaterThanOrEqual(0);
  const end = mcpSrc.indexOf("if (op === 'close')", start);
  expect(end, 'browse_tabs op==="new" 分支应该在 op==="close" 之前结束').toBeGreaterThan(start);
  return mcpSrc.slice(start, end);
}

describe('Bug 4 — group-full 必须以 isError 工具结果回到 agent', () => {
  const newOpBlock = extractBrowseTabsOpNewBlock();

  it('BUG4-1: MCP browse_tabs op="new" 必须把 wsClient 失败（group-full）转成工具错误', () => {
    // 旧实现：const result = await wsClient.call('ui.new_tab', params);
    //           return { content: [...], };
    // 抛出去 → Protocol 层 JSON-RPC error → agent 看不到 isError。
    expect(newOpBlock, [
      'BUG4-RED: browse_tabs op="new" 没有把 wsClient 的失败包装成工具错误。',
      '修复方式：在 try/catch 里 await wsClient.call("ui.new_tab", ...)，',
      '失败时 return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };',
    ].join('\n')).toMatch(/try\s*\{/);
  });

  it('BUG4-2: 捕获来的 group-full 错误必须以 isError:true 工具结果返回', () => {
    expect(newOpBlock, [
      'BUG4-RED: browse_tabs op="new" 没有用工具结果形式（isError:true）返回错误。',
      'MCP 工具执行期错误应该停在 tool result；不要让它变成 throw / JSON-RPC error。',
    ].join('\n')).toMatch(/catch[\s\S]*?isError:\s*true/);
  });

  it('BUG4-3: 错误文案必须保留 agent 可读的 Error: message', () => {
    expect(newOpBlock, [
      'BUG4-RED: 捕获后的错误返回里没有保留 Error: message。',
      'group-full 提示必须能到 agent：Error: your tab group is full ...',
    ].join('\n')).toMatch(/catch[\s\S]*?text:\s*`Error:\s*\$\{[^}]+\}`[\s\S]*?isError:\s*true/);
  });
});

// main/mcp_instructions.js — MCP 初始化时交给客户端的那段自我介绍。
//
// 为什么单独成文件（2026-11-25）：
//
// MCP 的 InitializeResult 有一个 `instructions` 字段，客户端会把它拼进 system
// prompt —— 这是**协议里唯一**能让服务端主动说"我是什么、什么时候该用我"的地方。
// 此前它是空的，于是 agent 对这个 server 的全部认知只剩一份 17 个
// `browse_*` 工具清单：名字像通用动词，描述是写给人看的机制说明
// （data-ai-id、subset、milestone）。实测后果很直接 —— 用户说"用 ai-browser"，
// 新会话里的 agent 不知道那是什么，得被点名 GitHub 仓库才肯去查。
//
// 判据不是"描述够不够详细"，而是"只拿到工具清单的模型能不能判断该不该用"。
// 所以这段文字只回答四件事，不重复 schema 里的参数细节：
//   1. 它是什么（真窗口，不是无头/截图驱动）
//   2. 什么意图下必须用它，以及为什么要用它而不是别的浏览器工具
//   3. 最小循环，且把 success 只代表"发出去了"这条硬规矩放在这里
//   4. 需要人时的正确姿势
//
// 成本：这段文字每个会话注入一次（不是每轮），但仍要克制。预算见
// tests/test_mcp_instructions.js 的 MAX_CHARS，超了 CI 红。
//
// 为什么没有做成 MCP prompt / resource：tests/test_invariants.js 把
// "prompts/resources 三个 list 必须应答空集合"钉成了不变量（目录扫描器会把
// Method not found 记为健康检查失败），那是刻意保留的，不在这轮改动范围内。

export const MCP_INSTRUCTIONS = [
  'AI Browser is a real, visible browser that you drive on the user\'s behalf.',
  'Use it whenever a task involves a website: open a page, read what it says, click, fill a form, log in, publish, upload or download, or pull data that sits behind a login.',
  '',
  'Prefer it over headless or screenshot-driven browser tools when the page needs JS to render, when a session is already logged in, or when the user should be able to watch and take over. The window is a normal app window: the user can click and type in it at any time.',
  '',
  'Loop: browse_navigate {url} -> browse_get_tree {subset:"interactive"} -> browse_act {action, target:<id from the tree>}. Repeat. success:true means the action was dispatched, not that anything changed - use browse_diff when the outcome matters.',
  '',
  'Never invent a target id or a password. For login, QR scan, captcha or payment, ask the user to do it in the window and continue once they confirm.',
  '',
  'If these tools are not registered in this client, the same engine is reachable from a shell: `ai-browser call ui.get_tree \'{"subset":"interactive"}\'`.',
].join('\n');

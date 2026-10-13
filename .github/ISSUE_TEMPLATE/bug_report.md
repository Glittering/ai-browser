---
name: Bug report
about: 浏览器行为不符合预期（崩溃、动作没生效、读错页面、卡死）
title: '[bug] '
labels: bug
assignees: ''
---

## 现象

一句话描述发生了什么，以及你预期应该发生什么。

## 复现步骤

1.
2.
3.

## 环境信息

- OS（macOS / Linux / Windows）：
- Node 版本（`node -v`）：
- ai-browser 版本（commit hash 或 package.json version）：
- 使用方式：MCP（哪个客户端：Claude Code / Cursor / Cline / 其他）还是原始 WebSocket：
- 目标网站 URL：

## 关键证据（尽量贴）

- `browse_get_tree` 返回的相关节点 / `context` 片段（JSON）
- `browse_act` 的完整返回值（特别是 `success` / `error` / `warning` 字段）
- 如果是写操作"报成功但没生效"：贴 `browse_diff` 的 snapshot/diff 结果
- 终端里 MCP server 或 `npm start` 的报错日志

## 排查过的内容（可选）

- [ ] 换 `npm start` 手动常驻后问题依旧
- [ ] 试过 `browse_repaint`（窗口画面陈旧类问题）
- [ ] 查过 README 的 Troubleshooting

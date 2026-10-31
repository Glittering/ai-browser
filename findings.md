# Findings（审计证据与发现）

> 只记录有代码证据的结论；每条含 `file:line`。完整论述见 `docs/audit/pm-2026-10-30/`。

## 基线事实（2026-10-30）

- `src/` 67 个文件 / 约 21.7k 行；最大文件 `src/main/page_manager.js` 5857 行。
- 单测：91 文件 / **1228 条**，`npm test` 实测全绿，23.26s。
- e2e：`e2e:all` 25 套件（34 个 `.cjs` 脚本，部分不在全量）。
- CI：仅 `npm test`（macOS-14 / Node 20），不跑 e2e / lint / 覆盖率。
- 版本 2.4.5：`package.json`、`src/shared/version.js:5`、`server.json` 等 5 处由发布脚本同步。

## P0

- **WS 无认证 / 不校验 Origin / 显式 tab 跨标签**：`ws_server.js:72`（仅 loopback）、
  `:110`（`connection` 忽略 `_req`）、`:176-205`（默认 active tab / explicit 直通）、
  `page_manager.js:693-701`（explicit 无归属校验）、`ws_server.js:426-457`（evaluate）、
  `page_manager.js:1367+`（screenshot）、`mcp_ws.js` 客户端无 token。
  影响：浏览器内任意页面脚本可读/操作所有登录态标签，并可写任意路径。
  先做：拒绝带 `Origin` 的连接 + 启动 token（或 UDS）。

## P1（节选）

- **IPC 结果通道可伪造**：`bridge.cjs:21-23` 暴露 `sendTree/sendDiff`；`page_manager.js:389-427`
  不校验 sender；requestId 全局自增可猜（`:219, 1153`）；`window_open` token 无签发校验
  （`:435-467`）。`sendTree/sendDiff` 在生产代码中无调用方。
- **preload eval 兜底**：`page_manager.js:2482-2487` → `bridge.cjs:112-131` 直接 `eval`；
  guard 正则（`guards.js:6`）可被字符串拼接绕过；preload 有 Node。
- **no-sandbox**：`index.js:460`；每 tab `sandbox:false`（`page_manager.js:3793`）。
- **upload 任意路径**：`mcp_tools.js:55`、`page_manager.js:3229`、`:3256+`，无白名单/大小限制。
- **MCP 15s 传输超时**：`mcp_ws.js:26,154-161`；工具声明 120s/300s（`mcp_tools.js:56,166`）。
- **subset/mode 空转**：`ws_server.js:270-276`、`page_manager.js:1583,1593`。
- **focused_only 空转**：`mcp_tools.js:32` 声明「只返回焦点子树」；`bridge.cjs:70` 调
  `extractTree()` 无参；extractor 无 `focusedOnly`；主进程无过滤。
- **OOPIF 每读必合**：`page_manager.js:1170,1236-1244`；`frame_probe.cjs:39-41` 只要可见帧就为真。
- **PageManager 零行为单测**：`grep -rn "new PageManager" tests e2e` 无结果；CI 不跑 e2e。
- **文档冲突**：README `:35` 说 20 个工具（实际 17）、`:37-38` 说无截图（有
  `browse_screenshot`/`ui.screenshot`）、`:18` badge 658+447（实际 1228）、工具表仅 14 行（`:195-210`）。

## P2（节选）

- `_ensureCdp` 乐观记账：`page_manager.js:5521-5523`（`sendCommand('X.enable')` 未 await）。
- `tabsInGroup` 裸解引用 `webContents`：`page_manager.js:597-608`。
- 布局公式两份：`:708-721` 与 `:5100-5108`。
- `ui.wait` 为 text/url 条件也抽整棵树：`ws_server.js:747-748, 770-790`。
- 未知 condition 静默空转 120s：`ws_server.js:754-790`。
- 解析错误响应缺 `id:null`：`ws_server.js:143-146`。
- `ui.paint_check` 绕过 session 路由：`ws_server.js:369`。
- screenshot `ignored_params` 误报 `tab`：`page_manager.js:1482`。
- cookie 固化延迟退出 + 13 个月持久化：`index.js:1389-1433`。
- 关窗即退出（macOS Cmd+W）：`index.js:900, 1486`。
- 网络抓包/canvas hook 默认全开：`page_manager.js:118-120`、`canvas_monitor.js:282-286`。
- 同名下载是否覆盖：`download_monitor.js:56-90`（待实测确认）。
- `wrapper_hint.js:130` 建议 `subset:"all"`，schema 只有 `interactive|full`（`mcp_tools.js:36`）。
- `shared/protocol.js` 仅测试引用，生产未用于校验。
- `test_imports.js:19-27` 只扫 `.js`，漏 preload `.cjs`。
- 无 lint / 格式化 / 类型检查配置。

## 待确认

- https 页面连接 `ws://127.0.0.1:9223` 是否被 Chrome 混合内容/PNA 拦截（http 页面与本地进程确定可利用）。
- Electron `setSavePath` 同名文件是否自动加 `(1)`。
- npm 页面是否重写 README 的相对 `docs/` 链接。

## 整改映射

以上 P0–P3 已全部映射到 [`docs/PLAN_REMEDIATION.md`](docs/PLAN_REMEDIATION.md) 的 51 张任务卡：
每张卡包含 `file:line` 证据、修复步骤、可执行验收、单测/e2e 文件与关键断言、回滚开关。
建议从 `SEC-01` / `SEC-02` / `SEC-03` / `CORE-00` 四张卡开始（见计划 TL;DR 与附录 D）。

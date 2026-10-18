# 依赖与分发方案评估（2026-10-18）

> 触发问题：「现在装这个项目，感觉需要的依赖太多太多了，非常麻烦。是不是该打包成 dmg / exe / deb 一键安装？」
>
> 本文所有数字都是本机实测，测量方法写在 §1.3。凡属估算而非实测的，都标注了「估算」。
>
> **执行状态（2026-10-18 当日已落地）**：§5 第一步（清理依赖）与第二步（dmg）**都已执行并验证**，
> 实测结果写在各节内。§5 第三步「仍未修」的部分保持原样。

---

## 0. 结论先说

**「依赖过多」这个判断，一半对、一半错。**

**错的一半**：生产依赖只有 **3 个**（`electron` / `ws` / `@modelcontextprotocol/sdk`），
源码里直接 import 的外部包只有 **3 个**。对一个带图形界面 + MCP 服务器 + WebSocket 服务的项目来说，
这个数量算非常精简——问题不在「数量」。（原为 4 个，`jsdom` 已按本文建议移到 devDependencies。）

**对的一半**：一次安装原本会落下 **183 个顶层目录 / 298.8 MB**，其中 **166 个包 / 38.7 MB 在运行时
一次都不会被加载**。而体积的大头（243 MB）是 Electron 本身——它既是「依赖」也是「产品主体」，
这部分在任何方案里都省不掉。

所以真正的问题是三件具体的事，而不是一句「依赖太多」：

| # | 问题 | 规模 | 性质 | 状态 |
|---|---|---|---|---|
| 1 | `jsdom` 放错了位置 | 37 包 / 23.3 MB | 只服务测试，却挂在 `dependencies` 上，**每个用户都在为开发者的单测付费** | ✅ 已修 |
| 2 | 两个死依赖 | `playwright` + `@playwright/test` | 全仓零引用，纯占位 | ✅ 已删 |
| 3 | MCP SDK 的 HTTP 传输栈 | 60 包 / 6.9 MB | express / hono / cors / jose / pkce-challenge / eventsource / express-rate-limit… 全是 HTTP 与 OAuth 传输用的，而本项目**只用 stdio** | ⏸ 未修，见 §3.3 |


**推荐方案**（§5 有分阶段细节）：

- **第一步（零风险，建议立刻做）**：`jsdom` 移到 `devDependencies`、删掉两个死依赖。
  用户侧从 176 包 / 297 MB 降到 **139 包 / ~274 MB**。
- **第二步（低风险，建议做）**：electron-builder 出 macOS `.dmg`，与 npm 渠道**并存**而非替代。
  需要约 20–40 行改动让应用在「打包模式」下能自拉起。
- **不建议现在做**：Windows `.exe`（README 自己写着 Windows 未验证，出安装包等于替一个没测过的平台背书）、
  Linux `.deb`（没有构建矩阵，也没有明确用户群）、Tauri 重写（会毁掉产品核心，§4.5）、
  手搓 MCP 协议（用协议正确性换 15 MB，§4.6）。

---

## 1. 现状实测

### 1.1 声明 vs 实际

```
package.json 声明
├── dependencies (4)      electron, ws, @modelcontextprotocol/sdk, jsdom
└── devDependencies (3)   vitest, playwright, @playwright/test

本机 node_modules
├── 349 MB，215 个顶层目录
└── 发布 tarball：267 KB / 52 个文件（不含 node_modules，很干净）
```

### 1.2 一次安装到底落下什么

| 视角 | 包数 | 体积 |
|---|---|---|
| `npm i -g @glittering0717/ai-browser`（用户） | 176 个 prod 顶层包 | ~297 MB |
| `npm install`（贡献者，含 devDeps） | 215 个顶层包 | 349 MB |
| **运行时真正加载的包** | **12 个** | **258.6 MB** |
| 其中 Electron 二进制 | 1 个 | 243 MB |

### 1.3 「运行时真正加载」是怎么测的

不是猜的，是静态遍历 import 图：从两个入口（`src/main/mcp_server.js`、`src/main/index.js`）出发，
递归跟随所有 `import` / `require` / 动态 `import()`，穿透进 node_modules，收集到的外部包名。
之所以用静态遍历而不是运行时 hook——**ESM 的 `import` 不走 `Module._load`**，运行时钩子只能抓到
CJS 那一半，会严重低估（实测第一版就漏了 `zod`）。工具留在 `tools/_oneoff/dep_closure.cjs`。

结果（两个入口合并去重，已剔除 Node 内置模块）：

```
@modelcontextprotocol/sdk  ajv          ajv-formats   bufferutil*
electron                  fast-deep-equal  fast-uri   json-schema-traverse
utf-8-validate*           ws            zod          zod-to-json-schema
（* = ws 的可选原生加速模块，装不上也能跑）
```

**176 → 12。**

---

## 2. 三类「装了但运行时从不加载」的包

合计 **166 个包 / 38.7 MB**，按来源分三堆：

### 2.1 jsdom 依赖链 —— 37 个包 / 23.3 MB（**纯测试用**）

`jsdom` 本身在 `dependencies` 里，但全仓只有 **10 个测试文件** import 它：

```
tests/test_action_binder.js      tests/test_snapshot_diff.js
tests/test_capability_probe.js   tests/test_state_tracker.js
tests/test_semantic_extractor.js tests/test_hit_point.js
tests/test_floating_layer.js     tests/test_modal_detection.js
tests/test_deep_active.js        tests/test_validation_state.js
```

连带拉进来的：`parse5`、`css-tree`、`tldts`、`undici`、`tough-cookie`、`whatwg-url`、
`lru-cache`、`mdn-data`、`@asamuzakjp/*`、`@csstools/*`、`saxes`、`entities`…

**发布包里并不包含 `tests/`**（`files` 字段只含 `bin`/`scripts`/`src`/`examples` 等），
且随包发布的 `tools/coverage_probe.cjs` 只依赖 `ws`。所以把 `jsdom` 移到 `devDependencies`
**不影响任何用户路径**，只影响贡献者——而贡献者跑 `npm install` 时装的就是全量。

### 2.2 MCP SDK 的 HTTP 传输栈 —— 60 个包 / 6.9 MB

`@modelcontextprotocol/sdk` 声明了 15 个直接依赖，其中大部分是给 HTTP / SSE / OAuth 传输用的：

```
express  hono  @hono/node-server  cors  jose  pkce-challenge
eventsource  eventsource-parser  express-rate-limit  serve-static  body-parser
router  path-to-regexp  raw-body  proxy-addr  ipaddr.js  qs  cross-spawn  which …
```

而 `src/main/mcp_server.js` 只用三条 import：

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ... } from '@modelcontextprotocol/sdk/types.js';
```

**stdio 传输在这个 SDK 里的实现只有 `shared/stdio.js` 一个文件**，不碰上面任何一堆。
也就是说：为了一个 stdio 服务器，装了一整套 HTTP 服务端框架。

### 2.3 Electron 安装期工具链 —— 69 个包 / 8.4 MB

`@electron/get`、`extract-zip`、`yauzl`、`global-agent`、`got`、`semver`…
这些只在 `npm install` 期间负责「下载并解压 Electron 二进制」，装完就再没用处。
但它们是 `electron` 包自己的 `dependencies`，**只要还走 npm 装 Electron，就躲不掉**。
（§4.7 说明为什么这件事反而支持出 dmg。）

### 2.4 附带发现：两个死依赖

全仓 grep `playwright`（排除 node_modules / outputs / lock 文件），代码里**零命中**，
只有 `package.json` 自己和几篇营销文档里提到「别人的项目」（playwright-mcp、stagehand）。
`playwright-core` + `playwright` + `@playwright/test` 合计约 16 MB，只压在贡献者身上。

---

## 3. 逐项处置风险评估

按「收益 / 风险」排序，**前两项我建议做，后两项建议不做**。

### 3.1 `jsdom` → `devDependencies` ｜ 收益 23.3 MB / 37 包 ｜ 风险：极低

- 用户收益：每次安装少 37 个包、23.3 MB。
- 风险点只有一个：**有没有发布物在运行时需要 jsdom**。已核实：
  发布 `files` 白名单 = `bin` / `scripts` / `src` / `tools/coverage_probe.cjs` / `examples` /
  `llms-install.md` / `LICENSE`；其中 `coverage_probe.cjs` 只 `require('ws')`。
- CI 的 `npm ci` 默认装 devDeps，`npm test` 不受影响。

### 3.2 删除 `playwright` + `@playwright/test` ｜ 收益 贡献者少 16 MB ｜ 风险：零

零引用，删掉只需要跑一遍 `npm test` + `npm run e2e:all` 确认。

### 3.3 手搓 MCP stdio 服务器，去掉 `@modelcontextprotocol/sdk` ｜ 收益 ~15 MB / 63 包 ｜ 风险：中高，**不建议**

MCP over stdio 就是「换行分隔的 JSON-RPC 2.0」，协议面很窄：`initialize` / `tools/list` /
`tools/call` / `notifications/initialized` / `ping`，加 17 个工具的 `inputSchema`。
手搓大约 150–250 行，能把 `@modelcontextprotocol/sdk` + `zod` + `ajv` + `ajv-formats`
（约 15 MB / 63 包）全部去掉。

**但不建议，理由是这笔交易不划算**：

- 换回来的是 15 MB——而 Electron 一项就是 243 MB。**总量占比 5%，感知不到。**
- 付出的是「从此自己维护协议合规性」：协议版本协商、能力声明、错误码、`tools/list` 分页、
  SDK 每次发版带来的兼容变化。这是**用正确性换体积**，方向错了。
- SDK 是官方参考实现，出协议问题时它有上游修；手搓版出问题只有我们修。

如果哪天依赖数量本身成了阻塞（比如某个镜像源装不上 SDK），再走这条路，并且要配一套
与真实 MCP 客户端（Claude Desktop / Cursor）的对端测试，不能只靠单测。

### 3.4 jsdom 彻底移除（测试改用 Electron 自带 DOM）｜ 收益：仅贡献者 ｜ 风险：中，**本币不值**

CI 注释已经写着「单测会 import 直接依赖 Electron 运行时的源码模块，所以必须在 macOS 上跑」。
既然测试已经绑在 Electron 上了，理论上可以让 10 个测试文件改用 Electron 的 DOM，彻底去掉 jsdom。
但 devDeps 不影响用户，收益只在贡献者体感，工作量是 10 个文件的迁移。**优先级低。**

---

## 4. 分发方案逐一分析

先给一个贯穿所有方案的事实：**这个产品的 94% 体积是 Chromium，而 Chromium 就是产品本身。**
任何方案都绕不开「用户机器上要有一个完整的 Electron 运行时」，区别只在于
「什么时候、以什么形式、由谁把它放上去」。

### 4.1 方案 A：维持现状（npm 包 + `npx`）

| 维度 | 评价 |
|---|---|
| 用户成本 | 有 Node ≥18 即可；首次启动时下载 Electron（约 110 MB，国内慢，已有 `ELECTRON_MIRROR` 文档） |
| 维护成本 | **最低**，已经是现成的 |
| 对 agent 友好度 | **最高**——`npx -y @glittering0717/ai-browser mcp` 一行配置，版本由 npm 管，无需绝对路径 |
| 主要缺点 | 首次启动要等下载；用户机器上要额外有 Node |

**结论：必须保留，而且是主渠道。** 理由见 §4.2 的最后一段——MCP 用户要的就是「一行命令」，
dmg 反而给不了这个。

### 4.2 方案 B：electron-builder 出 macOS `.dmg`

| 维度 | 评价 |
|---|---|
| 用户成本 | 双击拖到 `/Applications`，无需 Node，无需等下载 |
| 维护成本 | 中：加 electron-builder devDep + 配置文件 + CI 构建步骤 |
| 包体 | **估算** dmg 约 110–130 MB（压缩），装上约 250 MB。比 npm 路径小约 45 MB，但**量级相同** |
| 真实收益 | 不是省空间，是省掉「装 Node」+「等 Electron 下载」这两步，并获得 `/Applications`、聚焦、Spotlight 这些原生体验 |

**技术上要改什么（已定位，共 2 处）：**

1. `scripts/electron_resolve.cjs` 的 `resolveElectronBinary()` 现在靠
   `require.resolve('electron/package.json')` + 读 `path.txt` 找二进制。打包后应用自己的可执行文件
   **就是** Electron，需要加一个分支：检测到处于打包模式（`app.isPackaged` / 无 `electron` 包可解析）时
   直接返回 `process.execPath`。
2. `src/main/mcp_server.js` 的 `ensureElectronRunning()` 用
   `spawn(resolveElectronBinary(), [APP_ROOT])` 拉起浏览器。打包后要改成拉起
   **应用自身的可执行文件**（同样是 `process.execPath`），`APP_ROOT` 参数也不再需要。

**已经确认可打包的部分**（这不是猜测，是查过的）：所有运行时写操作都在包外——
日志在 `~/.ai-browser/logs/`（`config.userDataDir`）、下载在 `~/.ai-browser/downloads/`、
截图在调用方给的路径。asar 只读不影响。

**两个必须说清的代价：**

- **代码签名与公证**。没有付费 Apple 开发者账号（$99/年）时，Gatekeeper 会拦下未公证应用，
  用户必须「右键 → 打开」。能装上，但是真实摩擦，且会变成客服负担。
  有账号则要在 CI 里配签名证书和 notarization。
- **它不解决「依赖太多」**，只是把依赖藏进 app bundle。应用里依然带着
  Electron + MCP SDK + zod + ajv。

**结论：建议做，但定位为「给人用的第二条渠道」，与 npm 并存。**
关键理由：MCP 客户端配置如果指向 `/Applications/AI Browser.app/Contents/MacOS/AI Browser`，
就丢了 `npx` 的三个好处——版本由 npm 管、无需绝对路径、换机器复制配置即可用。
**两个渠道服务两类人，不要互相替代。**

### 4.3 方案 C：Windows `.exe` ｜ 不建议现在做

`llms-install.md` 自己写着「Windows is experimental/untested」。
在这个事实改变之前出 `.exe` 安装包，等于**替一个没有验证过的平台背书**——
用户装完发现不能用，比「装不上」更糟。先把 Windows 跑通（哪怕只在 CI 里跑 smoke），再谈打包。

### 4.4 方案 D：Linux `.deb` ｜ 不建议现在做

README 声称支持 Linux，但：没有构建矩阵、没有 glibc/架构（x64 vs arm64）组合的验证、
没有证据表明有 Linux 用户群。`.deb` 还要处理 root 安装 vs 用户级安装、desktop 文件、图标规范。
**在没有需求信号前做，是纯成本。**

### 4.5 方案 E：Tauri 重写（系统 WebView）｜ 明确不可行

看起来诱人：二进制从 ~100 MB 降到 ~10 MB。但：

- **这是浏览器产品，核心价值就是用真实的、当前的 Chromium 引擎渲染页面**，
  让人看到的和 agent 读到的语义树是同一个页面。Tauri 在 macOS 上用 WKWebView（Safari 引擎），
  版本还随操作系统浮动——同一个页面在不同 macOS 上渲染可能不同。
- CDP 级的可信输入（`Input.dispatchMouseEvent` / `dispatchKeyEvent`）是整套交互的地基，
  换引擎等于把 `src/main/page_manager.js` 的核心推倒重写。
- 工作量是月级，风险是「产品还是不是原来那个产品」。

**省下的 90 MB 换来一个不一样的产品，不划算。**

### 4.6 方案 F：`pkg` / Node SEA 打成单文件 ｜ 不适用

这两个工具是把 Node 脚本打成单文件可执行程序，前提是「不需要 Chromium」。
本项目的 Chromium 是刚需，打不了。且 `pkg` 基本停止维护，文件系统行为有一堆已知坑。

### 4.7 方案 G：拆成「dmg（浏览器）+ 微型 npm 包（MCP 桥）」

一个值得知道但不建议现在做的架构：把 MCP 服务器拆成只依赖 `ws`（196 KB）的独立小包，
浏览器由 dmg 分发，MCP 桥负责找到已安装的 app 并拉起它。

- 好处：agent 侧安装从 297 MB 降到 1 MB 级。
- 代价：多出一条「app 没装 / 装在非常规位置」的失败路径，且 `npx -y ai-browser mcp`
  「开箱即用」的现有体验被破坏——用户必须先装 dmg。
- 判断：**用一个新失败模式换一部分用户的带宽，不划算。** 除非将来出现明确的
  「agent 环境装不下 300 MB」的信号，否则不做。

---

## 5. 执行结果（两步都已落地）

### 第一步：清理 `package.json` —— ✅ 已完成并实测

```diff
- "jsdom": "^29.1.1",              // dependencies → devDependencies
- "@playwright/test": "^1.45.0",   // 删除：全仓零引用
- "playwright": "^1.45.0",         // 删除：全仓零引用
```

**同口径实测**（都用 `git archive HEAD` 取改动前快照 vs 当前工作区，各自
`npm install --omit=dev` 后量 `node_modules`， apples-to-apples）：

| | 顶层目录数 | node_modules 体积 |
|---|---|---|
| 改动前 | 183 | 298.8 MB |
| 改动后 | **157** | **275.8 MB** |
| 减少 | **−26** | **−23.0 MB** |

其余验收：

- `npm pack --dry-run`：**52 个文件、267.0 kB，与改动前逐行一致**（发布物未被碰到）。
- jsdom 在用户侧已不存在；lock 文件里 `"dev": true`。
- `npm test`：**658 通过 / 0 失败**。
- `npm run e2e:all`：**13 套件 / 447 断言 / 0 失败**（清场后的零并发运行，见 §7）。
- 残留处理：`npm install` 会留下一个空的 `node_modules/@playwright/` 目录，已 `rmdir` 清掉。

### 第二步：macOS `.dmg` —— ✅ 已构建并验收，但换了工具链

**先说一个计划外的发现：electron-builder 用不了。**

`app-builder-lib/out/util/packageMetadata.js` 里有一条硬校验：

```js
const deps = ["electron", "electron-prebuilt", "electron-rebuild"];
for (const name of deps) {
  if (name in dependencies) errors.push(`Package "${name}" is only allowed in "devDependencies". ...`);
}
```

`electron` 出现在 `dependencies` 里就直接报错退出，**读源码确认没有任何环境变量能绕过**
（`ALLOW_ELECTRON_BUILDER_AS_PRODUCTION_DEPENDENCY` 只管 `electron-builder` 自己）。

这条校验背后的假设是「Electron 应用不该把 electron 当运行时依赖分发」。而本项目的 npm 渠道
恰恰是这么设计的——`npx -y @glittering0717/ai-browser mcp` 要把 electron 装进 node_modules
再拉起来。**两个渠道对 package.json 的要求是根本冲突的**，这不是配置问题，是架构问题。

所以改用 **`@electron/packager` + macOS 自带 `hdiutil`**（`scripts/build_dmg.cjs`）：

- 眼前要的只是一个**未签名、不自动更新**的 dmg，electron-builder 的核心卖点
  （签名 / 公证 / 自动更新 / NSIS / Squirrel）一个都用不上；
- `hdiutil` 是系统自带，不需要 electron-builder 那套从 GitHub 下载的二进制
  （国内网络下那一步经常卡住）；
- 引入的冲突和外部依赖都更少。

> 如果将来真要签名 + 公证 + 自动更新，正确做法是改用 electron-builder 官方推荐的
> **双 package.json 布局**（根目录放开发依赖、`app/` 子目录放应用清单），而不是在这里加 hack。

**实测产物**（不再是估算）：

| 项 | 数值 |
|---|---|
| dmg 文件 | **109.4 MB**（114,712,106 字节） |
| 解压后占用 | **253 MB**（其中 `AI Browser.app` 244 MB + `LICENSES.chromium.html` 8.7 MB） |
| `app.asar` | 11 MB（src + 生产依赖） |
| `Electron Framework.framework` | 232 MB（Chromium 本体） |
| 压缩比 | 2.3×，与 `gzip -9` 单独压框架的 2.4× 吻合，**合理** |

**内容完整性不是"看起来对"，是校验过的**：挂载 dmg 后，156 MB 的框架二进制与
`app.asar` 的 md5 与源目录**逐字节相同**；asar 里没有重复塞 243 MB 的 electron 发行版
（`src` 里所有 `from 'electron'` 由 Electron 内置模块系统解析，不经过 node_modules）；
框架内的软链全是相对链接，没有一条指回构建机。

**能力验收**（`tools/_oneoff/dmg_verify.cjs`，驱动打包后的 app，同一批夹具页）：

| 检查 | 结果 |
|---|---|
| `ui.new_tab` / `ui.get_tree` | ✅ 语义树报出按钮「点我」与输入框 |
| `ui.act click` | ✅ `clicked_via: "cdp-click"`，页面计数器 `__c: 0 → 1` |
| `ui.act type` | ✅ `method: "cdp-input"`，`value = "dmg"` |
| `ui.evaluate` | ✅ 返回页面真值 |
| 2D canvas 读写 | ✅ 红通道 255 |
| 语义树含 canvas 节点 | ✅ |
| WebGL | ⚠️ `false`，但 **dev 模式同样 `false`**（同环境对照，各 7 条 gles2 错误）——沙箱无 GPU 访问权限，**不是打包回归** |

**两个渠道自动协同，零代码改动**：`AI_BROWSER_PORT=9224 node src/main/mcp_server.js`
的 stderr 只有 `AI Browser MCP server started (stdio, lazy Electron)`——**没有 spawn**。
它通过 `checkPort` 发现打包 app 已在 9224 监听，直接复用。`browse_list_tabs`
返回了打包 app 的真实标签页（含夹具页）。这意味着人用 dmg、agent 用 npx 时，
**不会出现两份 243 MB 的 Electron，且共享同一份登录态**（两者都用 `~/.ai-browser`）。

**原计划里那 2 处改动，实际只需要 0 处。** 我原先判断要改
`electron_resolve.cjs`（打包模式返回 `process.execPath`）和 `mcp_server.js`（改 spawn 目标）。
实测发现 `resolveElectronBinary()` 的两个调用点（`scripts/start.cjs`、`src/main/mcp_server.js`）
**都运行在打包 bundle 之外**，`src/main/index.js` 的自重用的是 `app.relaunch()`
（Electron 原生 API，打包后天然可用）。**先查再改，省掉了两处没有必要改动。**

### 第三步：仍未做（需要你先决策）

| 项 | 状态 |
|---|---|
| CI 打 tag 自动构建 dmg 并挂 GitHub Release | 未做。`ci.yml` 目前只有单测；且 CI 产物同样是未签名/未公证的。1.3.0 的 dmg 目前只在构建机本地 |
| README / `llms-install.md` 写进 dmg 渠道 | ✅ **已完成（2026-10-18）**：README 的 Install 小节已重排为「Option A 安装包（推荐）→ Option B npx（agent 通道）→ Option C 源码（备选）」，并写明右键 → 打开、两渠道协同；`llms-install.md` 补了安装优先级说明 |
| 代码签名 + 公证 | 未做，需要 $99/年 Apple 开发者账号 |
| x64 架构的 dmg | 未构建（当前只打了 arm64）。`node scripts/build_dmg.cjs --arch x64` 可出，但未验证 |
| 应用图标 | ✅ **已完成（2026-10-18）**，见下方第四节。注意：packager **不会**自动拾取 `build/icon.icns`，必须显式传 `icon` 选项 |

### 第四节：应用图标（2026-10-18 初版，2026-10-19 改版）

设计：`build/icon.svg`（1024² 母版）—— 玄墨底上**两个错开的圆角方块**：前面一张宣纸色
（你看得见的页面），后面一张金色（agent 读到的层面），错开 126，后面那张只从左上透出。
产品主张「同一个页面，agent 看到的是它背后那一层」，图标就是这句话的最小解。

两个形状意味着 16px 下剪影只有"深色方块里一个浅色方块，左上透出一道金边"，不塌、
也不需要单独的小尺寸简化版。配色：`#1F1A13` / `#F6F1E4` / `#C9A96A`，金是唯一彩色。

> 1.3.0 的初版画的是"紫色渐变 + 白窗口 + 语义节点树"。改版原因是节点树这个母题做不成标志：
> 细线→通用 sitemap 图标，加粗→被读成"金头小人"，横过来→像插头。三节点树是图标库里
> 既有的"层级"符号，不是属于本产品的形状，所以整套换成两个面。

一键重建链：`scripts/render_icon.cjs`（在 Electron 下运行）——SVG → 2048² PNG → 10 个
iconset 尺寸 → `build/icon.icns`。用项目自带的 Chromium 渲染，零新增依赖；中间位图已进
`.gitignore`，只提交母版 SVG 和 icns。

**两个值得记住的发现：**

1. **`@electron/packager` 不会自动拾取 `build/icon.icns`。** `mac.js` 的 `copyIcon()` 在
   `!this.opts.icon` 时直接 return——v20 早已没有老版 electron-packager 的约定。
   （本文档第三步表格里原来写的"放一个 build/icon.icns 即可被 packager 自动拾取"是**错的**，
   按那条做出来的是默认原子图标。必须显式 `icon: 'build/icon.icns'`。）
2. **`npx asar extract-file <archive> <路径>` 会把文件平铺写到当前目录，静默覆盖同名文件。**
   我为了核对包内版本跑了 `asar extract-file app.asar package.json`，它把 asar 里那份
   **被 packager 按设计净化过的** package.json（删掉 devDependencies/scripts/publishConfig）
   覆盖到了仓库根目录的源文件上。要核对包内文件，先 `cd` 到一个空目录再跑。
   （dmg 本身是在覆盖之前构建的，产物无损；源文件已从 git 恢复。）

### 不做（以及为什么）

| 项 | 理由 |
|---|---|
| 手搓 MCP 协议去 SDK | 用协议正确性换 15 MB（占总量 5%），方向错 |
| Windows `.exe` / Linux `.deb` | 平台未验证，出包等于背书 |
| Tauri 重写 | 毁掉产品核心（真实 Chromium 渲染 + CDP 可信输入） |
| 拆 MCP 桥 + dmg 双包 | 用新失败模式换一部分用户的带宽 |

---

## 6. 顺带发现的两处文档漂移（与依赖无关，但同一天查到）

1. **MCP 工具数：文档写 17，实际 20。** `tools/list` 实测返回 20 个 `browse_*` 工具，
   而 `bin/ai-browser.cjs` 的 `--help` 和 `llms-install.md` 都写着 17。
2. **`llms-install.md` 写「~100 MB for the Electron binary」**：指的是下载的 zip；
   解压后实际是 242 MB（其中 `LICENSES.chromium.html` 一项就 8.7 MB）。建议改口径。

---

## 7. 证据强度分级（含"我错过什么"）

| 论断 | 证据强度 |
|---|---|
| jsdom 只被测试使用、可移 devDeps | **强**：全仓 grep + 发布 `files` 白名单逐一核对 + 用户侧安装实测确认已消失 |
| playwright 零引用 | **强**：全仓 grep，代码零命中 |
| 运行时闭包 12 个包 | **中强**：静态 import 图遍历（方法见 §1.3）；覆盖不到纯运行时 `require()` 的动态路径——本仓没有这种写法，但方法论上不是 100% |
| dmg 109.4 MB / app 253 MB | **强（实测）**：构建产物 `stat` 出的字节数 + `du` + md5 双重校验 |
| 打包 app 能力与 dev 一致 | **中强**：8/9 项通过，唯一未过项（WebGL）在 dev 下同样未过，但只测了一批夹具页，**没有跑真实站点** |
| electron-builder 不可用 | **强**：读到校验源码，无绕过路径 |
| 原计划 2 处改动实际需要 0 处 | **强**：grep 出全部调用点并逐一确认运行上下文 |
| 未公证 dmg 的用户体验 | **强**：macOS 确定行为，非猜测 |

**这一轮我错过的地方，如实记下**：跑全量 e2e 时我在旁边 concurrently 干了两件事——
① 装卸 node_modules；② 又用同一个端口单独跑了一遍 modeldiff。两次都让对应套件 exit=2，
单独重跑却都是 12/12。**还有一个更隐蔽的污染源**：9223 端口上一直挂着一个早先启动的
ai-browser 残留进程（默认 userData），导致 `focus` 套件的「不抢焦点」断言失败。
清场后最终一次零并发运行：**13 套件 / 447 断言 / 0 失败**，modeldiff 从 30.2s 降到 5.7s
（之前的"慢"也是抢资源抢的）。

教训：**e2e 跑起来之后，不能再对 node_modules、端口、GUI 进程做任何事。**
判红之前先问一句"是不是我自己在旁边捣乱"。


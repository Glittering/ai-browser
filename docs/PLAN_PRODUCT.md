# AI Browser 产品方案（v3 · 收窄版）

> 输入：项目所有者原话 ——「这个项目，是 ai 使用的浏览器，但是要让人也能看到。比如需要登录，扫码，滑块等等的时候，很有可能需要人操作。除此以外，你的团队来协作继续完善开发维护这个项目。让它成为一个有用实用稳定的，github 上大家都能用的项目。」
>
> **本文范围已收窄。** 上一版设计的「人机交接协议」（状态机 / `browse_ask_human` / 请求横幅 / 暂停按钮）已整体推翻 —— 那部分不需要存在：
>
> - **AI 是唯一操作者。** 浏览器默认就由 agent 全程驾驶，不存在「控制权在 AI 与人之间转移」的概念。
> - **窗口真实可见，人就在旁边。** 需要登录、扫码、滑块、支付时，人直接伸手用鼠标键盘操作那个真实窗口就是了 —— 当前代码已经就是这个效果，这不是待实现的功能，而是既成事实。
> - **因此本文不设计任何交接协议，不新增任何 MCP 工具，不给人做任何新 UI。**
>
> 要做的事只有三件：**守护住已有的东西不许退化（含唯一一条止血）、让它变成 GitHub 上陌生人敢用能用的项目、把仓库打扫干净。**
>
> 涉及的代码事实：`src/main/index.js`、`src/main/page_manager.js`、`src/main/ws_server.js`、`src/main/mcp_ws.js`、`src/main/mcp_tools.js`（13 个 `browse_*` 工具）、`src/shared/config.js`、`README.md`、`package.json`（v1.1.10）。

---

## 0. 三条硬边界（先定下来，免得又跑偏）

| 边界 | 含义 |
|---|---|
| **不加交接层** | 不引入"AI 交给人 / 人交还 AI"的状态机、不引入"控制权"概念。人对窗口的一切操作都是**直接的、物理的**：他用鼠标点、用键盘敲，浏览器不需要知道这件事正在发生，只需要**不去打扰**。 |
| **不加 MCP 工具** | 工具数锁死在 13。工具清单每轮全量注入 agent 上下文，任何新增都按线性增加所有用户的 token 成本。新信息一律挂进已有的 `browse_get_tree` 的 `context` 字段（它本来存在）。 |
| **不加人的 UI** | 现有 36px tab 条（`src/renderer/tab_bar.html`）就是全部 UI。不做请求横幅、不做状态灯、不做暂停按钮、不做倒计时。理由：窗口就在你面前，你自己看得见 AI 在干什么 —— 那才是这个产品的样子。给一个本来可见的过程再加一层 UI 提示，是把冗余当设计。 |

推论：**人的唯一诉求是「别打断我」。** 所以产品工作的重心从"设计交互"变成"消灭一切会把人赶走的自动化行为"。

> 这句推论有一个必须写死的边界：**"别打断人"靠的是让自动化根本不会被误触发、且出问题时刻关闭，不是靠检测人。**
> 任何"判断人是否在操作"的机制（焦点、OS 空闲时间、全局输入 hook）都在此列 —— 既因为它们会误判（agent 自己就在抢焦点），也因为那等于给一个浏览器加人机协议，而这个项目的定位恰恰是**没有**人机协议。

---

## 1. 定位（维持现状，仅作固化）

> **AI Browser 是一台真实可见、由 AI 独驾的浏览器：agent 从头到尾自己开，人只是坐在旁边能看见，需要身份/意愿（登录、扫码、滑块、支付）时自己伸手操作。页面用语义树表达，因为屏幕是给人看的，DOM 是给 agent 读的。**

三个关键词，都与当前实现一致：

| 关键词 | 当前实现 | 状态 |
|---|---|---|
| **AI 独驾** | 13 个 `browse_*` MCP 工具 + `ui.*` WS JSON-RPC，agent 掌握导航/点击/输入/执行 JS/开新标签/关浏览器全生命周期 | ✅ 已达成 |
| **真实可见** | Electron `BrowserWindow` + `BrowserView` 常规窗口；`index.js:37-39` 三个 anti-backgrounding 开关保证被 IDE 遮挡时渲染与输入仍然工作 | ✅ 已达成 |
| **人可介入** | 窗口就在桌面上，鼠标键盘随时可用；`persist:` 分区让人的登录态跨会话保留（`index.js:15` 在 `app.whenReady` 前设置 userData） | ✅ 已达成 |

**目标用户（唯一）**：在自己电脑上跑 coding agent 的开发者（Claude Code / Cursor / Codex）。他已装 Node、会改 JSON、能接受 `npm install`。所有决策按"一个开发者 + 一个 agent + 一台 Mac"来做。

**明确不做**：验证码破解、headless 模式、多用户/云/远程、账号体系、移动端。这些在上一版已经排除了，判断不变。

---

## 2. 不变量守护（Invariants）

这一节的立场是：**当前架构是对的，真正的风险是被后来的修改或自动化的善意破坏掉。** 所以每条不变量都配一个守护手段（代码修复 / 测试锁定 / 文档约束），而不是设计一个新功能。

> 其中有且只有一条是**止血项**（I1）：它是唯一一处今天就在主动伤害用户的自动化行为。其余都是长期守护。
>
> **守护手段的统一形式**：每条不变量（I1–I7）都配一条 `tests/test_invariants.js` 里的断言——静态源码扫描，零运行时依赖、毫秒级、不起 Electron、进 CI。理由：**不变量的敌人不是设计错误，是三个月后某个"顺手清理"的 PR。** 文档的约束力为零，测试的约束力不为零。该文件的技术设计归 `PLAN_ARCHITECTURE.md` §1.4，本文只声明产品侧的守护要求。

### I1（P0 · 止血）网络看门狗不得在无预警情况下重启浏览器

**事实**：`src/main/index.js:180-198` 的 `StartNetworkWatchdog()` 在 `createWindow()` 末尾立即探测一次，之后每 30s 一次；对 `https://example.com/` 发 HEAD，5s 超时；连续失败 3 次即执行 `app.relaunch(); app.exit(0)`（`index.js:192-193`）。

两个必须修掉的问题：

**① 它会踢掉正在手动操作的人。** `spin()` 在 `createWindow()` 末尾**立即**执行一次（不是等第一个 interval），5s 超时，之后每 30s 一轮 → 三次失败落在 t≈5 / 35 / 65 秒，即**约 65 秒**后整个 app 被 relaunch。人正在扫码、正在输短信验证码、正在支付、正在填一张很长的表单时，窗口会毫无征兆地消失并重开——已填内容、进行中的登录流程、可能的支付窗口全部报废。这是当前代码里最严重的一处体验事故，也是唯一一处**主动伤害用户**的行为。

**② 它对中国用户极度误报。** 探测目标硬编码为 `example.com`（`index.js:47`），不可配置。该域名在国内网络环境下经常慢或被拦，5s 超时很容易命中 → 无限循环的"重启—重启—重启"，且每次重启都重置 failStreak，用户完全无法自救（连修都不知道去哪修）。

**修法：降低误触发 + 可配置 + 可关闭。**（都在这一个函数里，改动极小）

| # | 改动 | 理由 |
|---|---|---|
| ① | **多目标探测**：默认 `https://example.com/` + `https://www.baidu.com/`，**全部失败才计一次失败** | 单一境外目标在国内网络下偶发超时是常态；多目标一致失败才是"网络真的挂了"的可靠信号 |
| ② | **`WATCHDOG_FAIL_LIMIT` 3 → 5**（间隔保持 30s） | 最快重启时间从 **≈65 秒**推迟到 **≈125 秒**（失败落在 t≈5/35/65/95/125），把偶发抖动挡在外面。注：架构文档写的是 90 秒 / 2.5 分钟，偏保守，以这里的实测推导为准 |
| ③ | **探测目标可配置**：`AI_BROWSER_WATCHDOG_URLS`（逗号分隔），放进 `src/shared/config.js` | 用户可指向自己网络下稳定的地址，零成本兜底 |
| ④ | **`AI_BROWSER_WATCHDOG=0` 逃生开关**：为 `0` 时完全禁用看门狗 | 给 GitHub 用户一个自救手段。成本两行，收益是"再也不会被它烦到" |
| ⑤ | **README Troubleshooting 写明**：自愈行为的存在、触发条件、以及上述三个配置项 | 与其让用户猜"为什么浏览器自己重启了"，不如直接告诉他并给开关 |

**明确不做（曾有方案要检测"人是否正在操作"，已撤销）**

不引入 `humanPresent()` 这类启发式——不查 `mainWindow.isFocused()`、不维护 `lastHumanFocusAt`、不调 `powerMonitor.getSystemIdleTime()`。

> **理由**：`isFocused()` 根本不能证明人在用——**agent 自己就在抢焦点**（`page_manager.js` 的 `_inputViaCdp()` / `peek()` 里有 `window.show()/moveTop()/focus()`）。一个在最需要它的时刻必然失效的启发式，不如不做。

**定性（不要含糊）**：**"别打断人"靠的是降低误触发 + 可配置 + 可关闭，不是靠检测人。** 它不是"唯一的产品级不变量"，它只是唯一一条需要改代码的止血项。

**验收**：① 断网 5 分钟 → 不重启；② 长时间真实断网 → 重启一次且只一次，不是循环重启；③ `AI_BROWSER_WATCHDOG_URLS` 生效；④ `AI_BROWSER_WATCHDOG=0` 时断网永不重启。

**守护**：由 `tests/test_invariants.js` 断言——看门狗阈值 ≥ 5、存在 `AI_BROWSER_WATCHDOG` 开关分支。

### I2（P1）登录态持久化不许退化

这是产品价值的一半：人的登录态（`persist:` 分区）要跨会话存活，否则每次都要重新扫码，人的介入成本翻倍。

当前是正确的，但**极其易碎**：`app.setPath('userData', ...)` 必须留在 `app.whenReady()` 之前（`index.js:15` 的注释就是这么写的，说明有人踩过）。任何重构 `index.js` 开头的人都可能把它挪到 `createWindow()` 里，然后登录态静默失效，没人会发现。

守护手段：给 `config.userDataDir` + "setPath 在 ready 前"加一条断言型测试（项目已有 `tests/test_version.js` 这类轻量测试，同一形态）；在 `src/shared/config.js` 顶部加一行注释锁死调用顺序。

**守护（自动化）**：`tests/test_invariants.js` 断言 `index.js` 中 `setPath('userData'` 出现在 `app.whenReady` 之前。

### I3（P1）输入必须是受信输入，不许退化成 JS 合成事件

CDP 的 trusted `mousedown/up/click` + `rawKeyDown→char→keyUp` 是"任何富文本编辑器都能直接写"的唯一原因。后来者遇到某个站点不好点时，最省事的写法是 `el.click()` 或 `page.evaluate` 里塞值——一旦开了这个口子，项目就退化成"一堆 per-site hack"。

守护手段：`CONTRIBUTING.md` 里把这条写成红线 + PR 模板加一个勾选项（见 §3.5）。不写测试（写不出来），靠评审约定。

**守护（自动化）**：`tests/test_invariants.js` 断言 `src/preload/` 与 `src/main/` 中不出现 `el.click()` / `dispatchEvent(new MouseEvent` 这类合成事件回退路径。

### I4（P1）窗口必须始终在可见范围内

"可见"是定位的一部分（`§1`）。当前 `createWindow()` 固定 1280×800 且无 bounds 记忆，不存在跑到屏幕外的情况——但一旦有人加了 bounds 记忆（P1-8 那个量级的功能），就可能出现"窗口坐标指向一台已拔掉的显示器"。

守护手段：bounds 记忆必须在应用前断言 `(x,y)` 落在某个当前存在的 display 的工作区内，否则回落到居中默认。这条约束写进 CONTRIBUTING。

**守护（自动化）**：`tests/test_invariants.js` 断言 `index.js` 中无 `show: false`，且 `src/renderer/tab_bar.html` 存在（tab 条是"人可介入"的既有载体，删了它人就失去了切换标签页的能力）。

### I5（P1）核心保持通用，站点特化只准住在 `skills/`

已有 `skills/`（content-publish / read-webpage / web-network-monitor）和 `tools/`（`_oneoff`、`_tmp_*`）。这个分层是对的，也是 README 里"no per-site hacks"这句话唯一还能站住的理由。

守护手段：仓库目录地图写进 CONTRIBUTING，明确"`src/` 里出现任何站点域名即视为 PR blocker"。同时按 §4 清掉 `tools/` 下的临时脚本，让边界在事实上成立而不只是在文档里成立。

**守护（自动化）**：`tests/test_invariants.js` 断言 `src/` 内不出现具体站点域名（`zhihu`/`csdn`/`bilibili` 等）。

### I6（P1 · 由测试锁定）禁止 headless 化 / 隐藏窗口

窗口真实可见是定位的一部分（§1），不是可以开关的配置项。禁止引入任何 headless 模式、`show:false`、"后台运行"的优化。

**守护（自动化）**：`tests/test_invariants.js` 断言 `index.js` 的 `BrowserWindow` 构造中无 `show: false`。

### I7（P1 · 由测试锁定）防遮挡与稳定性开关不得退化

`index.js:37-39` 的三个开关（`disable-backgrounding-occluded-windows` / `disable-renderer-backgrounding` / `disable-background-timer-throttling`）以及 `index.js:20` 的 `disableHardwareAcceleration()`，是"人能看到、agent 能输入"和"不崩"的前提。

**它们长得极像性能优化的清理对象，是最容易被下一个 PR 顺手删掉的东西**——这正是不变量需要测试锁定而非文档约束的原因。

**守护（自动化）**：`tests/test_invariants.js` 断言这四个 `appendSwitch` / 调用全部存在；同时断言代码中不出现 `not a visual browser` 这类与定位相反的措辞（它会误导后来者以为可以 headless 化）。

---

## 3. GitHub 大众可用（本文重心）

一句话判断：**这个项目目前的服务对象只有作者一个人。README 是给作者自己看的说明兼发稿物料，仓库是一份工作快照。** 让它变成"GitHub 上大家都能用"，本质是把受众从"记得上下文的作者"换成"只有 30 秒耐心的陌生人"。

### 3.1 现状诊断（每一条都有证据）

| # | 问题 | 证据 |
|---|---|---|
| **G1** | **README 数据是错的** | 徽章写 `tests-100 unit + 31 smoke`（README.md:19），正文写 `vitest 100 passed · 5 skipped`（README.md:227）。实测 `npx vitest run` = **16 个文件 / 127 个用例全部通过，0 跳过**。两处都不对，而且是那种"读者一眼能自己验证"的错误——这类错误对可信度的伤害远大于缺功能 |
| **G2** | **README 结构是爆款宣传稿不是文档** | 结构是： hero → "Why not screenshots?" 大对比表 → "How it feels like a human" → "What it sees" → "Real sites verified" → Architecture。Install 排在第五节的天边位置。GitHub 陌生人点进来要的是"怎么装 / 怎么用 / 靠不靠谱 / 出错了怎么办"，不是被说服 |
| **G3** | **未经验证的承诺** | 兼容性表写 `Windows expected to work`（README.md:216）——从未实测，CI 也从未在 Windows 上跑过。诚实降级成 `experimental / untested`，成本为零，收益是读者对整份文档的信任不被一颗老鼠屎坏掉 |
| **G4** | **可以被代码当场证伪的夸大** | "no brittle selectors"——`peek` 和 click-by-url 的存在本身就是为 selector 不稳准备的兜底；"no per-site hacks"——`skills/` 和 `tools/_oneoff/` 里躺着一堆 zhihu/csdn/juejin 专项脚本。这些话被任何一个翻过仓库的人发现，整份 README 就废了。**改成准确的说法："内核不含站点特化代码，站点逻辑放在可选的 skills 里"**——这话既真，又仍然是个卖点 |
| **G5** | **缺 Troubleshooting** | 没有：端口 9223 被占用怎么办 / electron 二进制下载失败怎么办 / macOS 权限 / 窗口被 IDE 遮挡 / 登录态怎么清。这些是真实会撞到的前五个问题 |
| **G6** | **`npm install` 在国内大概率失败** | Electron 二进制 ~100MB 走 GitHub Releases 源，国内失败率极高，且失败信息不可诊断。**这是有没有第二个中国用户的分水岭**，而现在 README 里连一个 FAQ 章节都没有 |
| **G7** | **Contributing 是空的** | 全文四行：「This project is young and hungry」「Want it to blow up?」。没有怎么跑测试、没有目录结构地图、没有 PR 流程、没有"核心 vs skills"边界 |
| **G8** | **安全现实没说** | `ws://localhost:9223` **无鉴权**——本机任何进程（包括一个恶意 npm 包）都能驱动这个浏览器，而浏览器里有持久化的登录态。`ui.evaluate` 是任意 JS 执行。这是真实风险，必须写给读者，不能等他们踩 |
| **G9** | **examples/ 是空目录** | `ls examples` 空。空 examples 目录对陌生人传递的是"我们没示例" |
| **G10** | **`docs/` 混着发稿物料** | `docs/` 下有 `PROMO_CN.md`、`SHOW_HN.md`、`PR_ZHIHU.md`、`PR_BILIBILI.md`、`PR_TOUTIAO.md`、`_tmp_zhihu_body.txt`、`_tmp_toutiao_body.txt` 和三张封面图。陌生人在 GitHub 文件列表里看到 `PR_BILIBILI.md` 的第一反应是：这到底是个产品还是个市场部的网盘 |
| **G11** | **License 文件权限是 600** | `-rw------- LICENSE`。不影响功能，但会让某些打包/复制流程报错，`chmod 644` 是顺手的事 |
| **G12** | **版本号有两个事实源** | `package.json` 的 `version` 与 `src/shared/version.js`。必然漂移，且漂移后 `browse_*` 报的版本和 GitHub 对不上，用户报 issue 时版本号就是错的 |
| **G13** | **文档与实现已经漂移**（未实现的 `ui.screenshot` 死契约散在三处） | `src/shared/protocol.js:58` 的 `VALID_METHODS` 里仍有 `'ui.screenshot'`，`docs/SPEC.md:73` 与 `docs/WHITEPAPER.md:93` 都把它写成可用方法，而实现从未存在。两份文档都已在 git 里跟踪。删 `protocol.js` 而不动这两份，它们立刻变成错误文档 |

### 3.2 新 README 结构（顺序即优先级）

```
# AI Browser
   一句话定位（"AI 独驾，人看得见，需要时自己伸手"）+ 一张窗口截图
## Install                    ← 必须在最前面，镜像命令就地给，不藏在 FAQ
## Connect your agent         ← MCP JSON，能直接复制
## Letting a human step in    ← 核心章节：解释"这是一个真的窗口，
                                 登录/扫码/滑块/支付时你自己伸手操作，
                                 浏览器不需要做任何事，也保证不会打扰你"
## Raw WebSocket API          ← 现有映射表保留
## How it works               ← 架构图保留，篇幅砍一半
## Troubleshooting            ← G5 那五件事
## Test & dev                 ← npm test / npm run smoke / 目录结构地图
## Security                   ← G8 的诚实交代
## Roadmap                    ← P0/P1/P2 公开（来自 §5）
## Contributing / License
```

关键决策：**Install 排在 Why-not-screenshots 之前。** 后半部分的说服内容整体保留（那些对比表写得确实好）但砍掉一半篇幅并后置 —— 说服一个还没装上的人是无效行为。

### 3.3 安装与启动体验

- **P0**：README 第一段就给国内镜像，不是"如果你在中国"的分支：

  ```bash
  npm config set electron_mirror https://npmmirror.com/mirrors/electron/
  ```

- **P0**：写清 Node ≥ 18；`npm start` 失败时给出**可诊断**的错误。当前端口 9223 被占用、electron 二进制缺失这两种情况的报错对陌生人都等于无信息。至少要做到：端口占用 → 报 EADDRINUSE 并提示 `AI_BROWSER_PORT=xxxx` 换端口（这个 env 在 `src/shared/config.js:14` 已经存在，只是没人知道）。
- **P0**：把 G1 的测试数字改成真实的 **127 unit + 31 smoke**，并且在 README 里写"这个数字由 `npm test` 产出"——诚实不是一次性的动作，是让后续不那么容易再失真。
- **P1**：`electron-builder` 打包 dmg / AppImage / zip 挂 GitHub Releases。不做代码签名（没有证书），README 必须写清 macOS 的「右键 → 打开」绕过 Gatekeeper。
- **P2**：Homebrew / winget / scoop。

### 3.4 examples/ 填充（P0）

四个文件，每个都要求能独立跑：

| 文件 | 内容 |
|---|---|
| `examples/mcp-config.json` | README 里那段 MCP 配置的独立副本，带真实绝对路径占位符 |
| `examples/raw-ws.mjs` | 最小 WS JSON-RPC 客户端：连 9223 → navigate → get_tree 打印 |
| `examples/agent-instructions.md` | README 里那段 copy-paste 指令的独立版本，开发者直接粘进 CLAUDE.md / Cursor Rules |
| `examples/realsites-check.sh` | 一键跑 `npm run realsites`，让人自己验证"这些站点真的能过" |

### 3.5 仓库治理清单

| 文件 | 优先级 | 说明 |
|---|---|---|
| `ISSUE_TEMPLATE/bug_report.yml` | P1 | 必填：版本 / OS / Node / 复现步骤 / WS 报文。**第一条就要问版本号**，因为 G12 会让用户自己都说不清版本 |
| `ISSUE_TEMPLATE/site_report.yml` | P1 | **本项目最高频的 issue 一定是"某个站点跑不通"**。给它专属模板：站点 URL、目标流程、`get_tree` 输出片段。这是产品判断——把最可能来的反馈预先结构化了，收集到的东西才有用 |
| `PULL_REQUEST_TEMPLATE.md` | P1 | 三点勾选：是否引入 per-site hack（I5）/ 是否加测试 / `npm test && npm run smoke` 是否都过 |
| `CONTRIBUTING.md` | P1 | 怎么跑测试 · **目录结构地图** · 四条红线（id-matched IPC / guarded evaluate / CDP 引用计数 / **受信输入不退化为 JS 合成事件**）/ **核心 vs skills 的边界**（这条决定项目三年后还能不能维护） |
| `SECURITY.md` | P1 | 见 G8 |
| `CHANGELOG.md` | P1 | Keep a Changelog 格式 |
| `CODE_OF_CONDUCT.md` | P1 | Contributor Covenant 标准版，直接用，不自己写 |
| `README_CN.md` | P1 | 作者与主要用户群是中文；主 README 保持英文要国际化，中文版做附属并在顶部一行互链 |
| `.gitignore` / `LICENSE chmod 644` | P0 | 顺手修，见 §4 |

**SECURITY.md 必须诚实写明**：`ws://localhost:9223` 无鉴权，本机任何进程都能驱动浏览器（含支付流程、含持久化登录态），DNS rebinding 可绕过 localhost 表面上的限制；`ui.evaluate` 是任意 JS 执行。
→ **P1 决策**：加可选 `AI_BROWSER_TOKEN` env，非空时要求握手带 token。理由：这是真实风险不是理论风险。定 P1 是因为它不阻塞"装得上、跑得通"这条主线，但**在修好之前 README 必须写明"不建议在不可信网络环境下使用"**。

### 3.6 版本与发版

- **版本号单一事实源**（G12）：以 `package.json` 为准，`src/shared/version.js` 不再硬编码而从中读取（Electron 主进程可直接读 package.json），并扩展已有的 `tests/test_version.js` 加一条"两处一致"的断言。
- **Semver**：主版本 = 协议破坏性变更（`ui.*` 方法签名 / MCP 工具签名）；次版本 = 新增能力；修订 = 修复。
- **CI**：GitHub Actions 只跑 **macOS + Linux**（`npm test && npm run smoke`）。Windows 在兼容性表里明确降级为 experimental。诚实降级比虚假承诺重要（G3）。
- **发版**：tag + GitHub Release（note 取 CHANGELOG）+ 附平台二进制。`main` 分支保护，CI 不过不许合。

---

## 4. 仓库卫生

这一节全是"没人注意到但陌生人一眼就看见"的东西。对 fork/clone 的第一印象决定陌生人是否继续读第二段。

### 4.1 `e2e/` 已被一次性 probe 脚本淹没

**实测**：`git ls-files e2e` 只有 **6 个**已跟踪文件（`e2e_realsites.cjs` / `realsites/*` / `smoke_ws.cjs` / `zhihu_full.cjs`），而 `git status` 里 `e2e/` 下有 **52 个未跟踪文件**——其中 **48 个是 `.mjs` probe**（`ax_bili_probe.mjs`、`bili_iframe5.mjs`、`bili_oopif_dump.mjs`、`cdp_input_regress.mjs`、`complex_sites.mjs`…），外加 4 个 `.cjs`。

命名本身已经说明了一切：`bili_iframe.mjs`、`bili_iframe2.mjs`…`bili_iframe5.mjs` —— 这是同一个问题的第五次迭代，每次都是一个新文件。

**处置（P0，纯文件操作，零风险）**

| 类别 | 动作 |
|---|---|
| `*.probe.mjs` / `_probe*.cjs` / 明显一次性命名（`*_dbg`、`*_dump`、`bili_frame_*`、`version_bug_probe`） | **直接删除**。信息已在最终实现里，留着只是噪音 |
| 有复用价值的验证脚本（如 `complex_sites.mjs`、`wide_sites.mjs`、`real_platforms.mjs`、`idempotent_input_probe.mjs`） | 并入已跟踪的 `e2e/realsites/`，或直接纳入 `npm run realsites` 的套件，成为**可重复运行**的回归的一部分 |
| 少数仍在用的临时脚本 | 移到 `e2e/_scratch/` 并在 `.gitignore` 里加 `e2e/_scratch/`、`e2e/**/_tmp_*`、`*_probe.cjs` |

**配套规则（这条比清理本身更重要）**：`.gitignore` 加 `e2e/_scratch/` 与 `*_tmp_*`，并在 CONTRIBUTING 写清"调试临时脚本一律放 `e2e/_scratch/`，这条路径已被忽略"。没有规则的话，三个月后又会有 48 个。

### 4.2 根目录躺着四个 `douyin_*.cjs`

`douyin_index.cjs`、`douyin_search.cjs`、`douyin_search2.cjs`、`douyin_search3.cjs` —— 同样是 `*_search2/*_search3` 的迭代痕迹，而且就在 `git clone` 后的第一屏可见位置。

处置：一次性脚本，直接删；若还有价值，进 `tools/_oneoff/`（该目录就是为此存在的）。**P0。**

### 4.3 `tools/` 与 `docs/` 的分类

- `tools/_oneoff/` 已存在，是正确的归宿；里面的 `_tmp_*` 文件按一次性原则删除或收敛。
- `docs/`：清理 README 之外的所有**发稿物料**（G10）。`PROMO_CN.md` / `SHOW_HN.md` / `PR_*.md` / `_tmp_*.txt` / 封面图 → 移到 `docs/marketing/` 并在 README 里只留一行链接；`_tmp_*` 直接删。保留 `SPEC.md` / `TEST_SPEC.md` / `WHITEPAPER.md`（这些是真实工程文档）。**P0。**

> 判断标准写在这里：**陌生人能不能从文件列表里看懂这个项目在干什么。** 看到 `PR_BILIBILI.md` 不能，看到 `SPEC.md` 能。

### 4.4 顺手项（P0）

- `chmod 644 LICENSE`（G11）。
- `examples/` 按 §3.4 填充，不留空目录（G9）。

---

## 5. 优先级

### P0 —— 别伤害用户 + 别劝退陌生人

| # | 事项 | 为什么是这个优先级 | 验收标准 |
|---|---|---|---|
| **P0-1** | **看门狗止血**（`src/main/index.js:180-198`，详见 §2 I1）：多目标探测全部失败才计数 + `FAIL_LIMIT` 3→5 + `AI_BROWSER_WATCHDOG_URLS` 可配 + `AI_BROWSER_WATCHDOG=0` 逃生开关 + README 写明。**不检测"人是否正在操作"** | 这是当前代码里唯一一处主动伤害用户的自动化行为：最快约 60 秒就能把正在扫码/支付/填表的人踢下线；且 `example.com` 在国内误报导致无限重启。它是唯一需要改代码的止血项，所以第一 | ① 断网 5 分钟 → 不重启；② 长时间真实断网 → 重启一次且只一次，不是循环重启；③ `AI_BROWSER_WATCHDOG_URLS` 生效；④ `AI_BROWSER_WATCHDOG=0` 时断网永不重启 |
| **P0-2** | **README 重写**（按 §3.2 结构）+ 改正测试数据为 **127 unit / 31 smoke**（G1）+ Windows 诚实降级为 experimental（G3）+ 把"no brittle selectors / no per-site hacks"改成准确表述（G4）+ 新增 Troubleshooting 五件事（G5）+ 国内镜像前置（G6）+ 补 §3.2 的 Letting-a-human-step-in 章节 | 决定这个项目有没有第二个用户。旧 README 会同时犯两个错：劝退人（结构错）、让人不信（数据错） | 找 2 个没接触过的人照 README 从 clone 到 agent 完成一次导航 ≤ 10 分钟；README 里每个数字都能被一条命令复现 |
| **P0-3** | **仓库卫生**：清 48 个 probe + 根目录 4 个 `douyin_*.cjs`；`docs/` 发稿物料移入 `docs/marketing/`；加 `.gitignore` 规则防复发；`chmod 644 LICENSE` | 陌生人 clone 后第一眼看到的就是这些。70 个未跟踪文件对一个"请大家用的开源项目"是致命的第一印象。成本极低（纯文件操作，零功能风险） | `git status` 干净；`ls` 根目录无临时脚本；`e2e/` 下每个文件都能说出它为什么存在 |
| **P0-4** | **`examples/` 填充**（§3.4 四个文件）+ **版本号单一事实源**（G12，扩展 `tests/test_version.js`） | 空 examples 等于没示例；版本号漂移会让所有人报 issue 时报错版本，污染后续所有反馈 | `examples/` 四个文件均可独立运行（README 里给出确切命令）；人为把两处版本号改成不一致时 `npm test` 失败 |
| **P0-5** | **启动可诊断性**：端口 9223 占用时报明确错误并提示 `AI_BROWSER_PORT`；electron 缺失时提示重跑 `npm install` / 设镜像 | macOS 上常驻了一个旧实例、9223 被别的调试工具占了，都是第一小时会撞到的事，当前报错对陌生人等于无信息 | 人为占住 9223 后 `npm start`，控制台出现"端口占用 + 怎么改"的一行英文/中文提示 |

### P1 —— 别人也装得上、敢用、能贡献

| # | 事项 | 理由 |
|---|---|---|
| P1-1 | **WS 鉴权 token**（`AI_BROWSER_TOKEN`）+ `SECURITY.md`（G8） | 真实安全风险。不阻塞"装得上跑得通"这条主线所以不在 P0，但修好之前 README 必须先写明限制 |
| P1-2 | 打包发布：electron-builder → GitHub Releases（dmg / AppImage / zip），含国内镜像下载说明与 Gatekeeper 绕过指引 | "大家都能用"的真正门槛是"不装 Node 也能用" |
| P1-3 | 仓库治理套件：`bug_report` + **`site_report`** 模板、PR 模板、`CONTRIBUTING.md`（含目录地图与四条红线）、`CHANGELOG.md`、`CODE_OF_CONDUCT.md`（§3.5） | 决定陌生人能不能低摩擦地贡献 |
| P1-4 | CI：GitHub Actions 跑 macOS + Linux（`npm test && npm run smoke`），`main` 分支保护 | 没有 CI 的 reliability 声明都是嘴上说说 |
| P1-5 | 不变量 **I2–I7** 落地：`tests/test_invariants.js` 静态源码断言（由 §3.5 的 CI 在 macOS + Linux 上跑）+ 登录态/受信输入/通用性红线写进 PR 模板 | §2 的长期守护项，趁 P0 期间还没人乱改时固化最便宜 |
| P1-6 | `README_CN.md` | 作者与主要用户群是中文 |
| P1-7 | Windows 实测，或在兼容性表里维持 experimental 标注 | 不能挂着未验证的承诺（G3） |
| P1-8 | 窗口 bounds 记忆（含 I4 的多显示器守护） | 人每次被调用都要重新找窗口拉大小很烦；成本极低 |

### P2 / 明确不做

| 事项 | 处置 |
|---|---|
| **人机交接协议（状态机 / ask_human / 请求横幅 / 暂停按钮）** | **不做。** 已推翻：AI 是唯一操作者，人直接操作真实窗口，不需要任何协议 |
| **给人的新 UI**（状态灯 / 倒计时 / 交还按钮 / 地址栏 / 设置面板） | **不做。** 窗口本身就是 UI |
| **新增 MCP 工具** | **不做。** 工具数锁死 13，新信息进 `get_tree` 的 `context` |
| Scene 检测器（自动识别扫码 / 滑块 / Cloudflare） | **不做。** 没有 ask_human 就没人消费这些信号，做了也是噪音 |
| 验证码破解 / 打码平台 | **不做。** 合规风险 |
| headless 模式 | **不做。** 窗口可见是定位本身 |
| 云托管 / 多用户 / 远程访问 / 手机推送 | **不做。** 本地单机单人 |
| Homebrew / winget / scoop | 延后 |
| 录屏 / 操作回放 / 时间旅行调试 | **不做** |

---

## 6. 一句话总结

AI Browser 的内核已经是对的：**AI 独驾、窗口真实可见、人随时能伸手、登录态跨会话保留。** 现在该做的不是往上面加东西，而是**别让它退化**：今天唯一在伤害用户的东西是那个网络一抖就自我重启、且目标地址写死不可配的网络看门狗（P0-1），今天唯一在伤害潜在用户的是那份数据错误、结构错位、还混着发稿物料的仓库门面（P0-2 / P0-3）。**修一条止血、打扫一次卫生、把 README 写成给陌生人看的文档** —— 这三件事做完，它才从"作者自己的工具"变成"GitHub 上大家都能用的项目"。

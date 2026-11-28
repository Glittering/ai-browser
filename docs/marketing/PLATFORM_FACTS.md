# 平台事实卡（PLATFORM_FACTS）

> **本文件是平台边界的唯一口径。写稿、改稿、发稿前先打开这一页，不要凭记忆写。**
>
> 立项原因（2026-11-28）：OSChina #5（11-27 发布）正文仍写「Windows 目前还是 experimental」，
> CSDN #9 甚至写「我这边没有 Windows 环境」。实际仓库早在 **2026-10-25** 就在 Win10 上跑过
> e2e 并修完平台差异，**2026-11-06** 已把 NSIS 安装包真装真卸验过、README 两个语言版本都写了
> Windows 安装段落。**错不在仓库，在写稿端凭记忆复述了过期口径，没人回仓库核对。**
>
> 规则：本节每行都带证据。**稿子里出现平台边界，只能整段抄本文件；抄完在稿件内部笔记写
> 「平台事实核对：PLATFORM_FACTS.md @ 2026-11-28」。**

---

## 一、三行标准表述（可直接抄进正文）

> - **macOS**：arm64 的 dmg，一个文件双击装完，不用装 Node.js。
> - **Windows**：x64 的 `Setup.exe`，per-user 装到 `%LOCALAPPDATA%\Programs\AI Browser`，自动建开始菜单和桌面快捷方式，不需要管理员权限。
> - **Linux**：没有安装包，走 `npx -y @glittering0717/ai-browser mcp`（macOS 也可以走这条路）。

补充句（需要讲清"可靠性"时用）：

> Windows 这条我不是"应该能跑"——安装、卸载、从快捷方式启动都验过，e2e 套件也在 Win10 上跑过。
> 只有一点要提前知道：CI 只在 macOS 跑单测，所以新版本不会每版都在 Windows 上复测。

---

## 二、事实与证据

| 事实 | 证据（可复核） | 最后核对 |
|---|---|---|
| macOS 安装包只有 **arm64** dmg | `README.md` Option A；`scripts/build_dmg.cjs` | 2026-11-28 |
| Windows **x64** 有 NSIS 安装器 `AI-Browser-<版>-win32-x64-Setup.exe`（~79MB） | `README.md` Option A2；`scripts/build_installer.cjs`；release notes 2.5.5 | 2026-11-28 |
| Windows 安装器**真装真卸验过**：静默装 → 开始菜单+桌面快捷方式出现 → 从快捷方式启动（进程路径为安装副本，UA `ai-browser/2.5.4`）→ 静默卸载 → 目录/快捷方式/注册表全清 → 再装一次全绿 | commit `58ea2af`（2026-11-06）commit body「验收（真装真卸）」 | 2026-11-28 |
| **e2e 套件在 Win10 上跑过**：`userData` 改 `os.tmpdir()`、`taskkill /F /T` 回收进程树、固定等待改轮询、下载路径 `path.join`、5 个 WS 集成用例不再静默 skip | commit `f939411`（2026-10-25）`test(windows): 修复 e2e 在 Win10 上的可移植性与时序问题` | 2026-11-28 |
| Windows 包**没有代码签名**，SmartScreen 会拦一次（更多信息 → 仍要运行） | `README.md` Option A2；`README-CN.md` 第 30 行 | 2026-11-28 |
| 卸载不碰 `~/.ai-browser`（登录态保留） | `README.md` Option A2；`build_installer.cjs` 注释 `deleteAppDataOnUninstall: false` | 2026-11-28 |
| Linux **没有**安装包，只能 `npx` | `README.md` Compatibility | 2026-11-28 |
| `npx` 路径 macOS + Linux 实测跑通 | `README.md` Compatibility；历次发布记录 | 2026-11-28 |
| **CI 只在 macOS 跑单测**，Windows 无自动回归 | `.github/workflows/ci.yml` → `runs-on: macos-14` | 2026-11-28 |
| 首次启动拉 ~110MB Electron，占用 ~245MB | `README.md` Option A / `llms-install.md` | 2026-11-28 |
| 控制端口 `127.0.0.1:9223`，**无鉴权**，不要转发/暴露 | `README.md` Compatibility、`README-CN.md` 诚实边界 | 2026-11-28 |
| npm 包名带作者 ID：`@glittering0717/ai-browser`；仓库是 `Glittering/ai-browser`，两者不同 | `package.json`；`README.md` 安装段 | 2026-11-28 |

---

## 三、禁用句式（出现即打回，不要再写）

- ❌「Windows 还是 experimental / 实验性 / 未测试 / 没人验证过 / 应该能跑但没人试过」
- ❌「我这边没有 Windows 环境，不敢打包票」
- ❌「Windows 和 Linux 都没有安装包」
- ❌「macOS / Linux only」「仅支持 macOS 和 Linux」
- ❌「Windows expected to work」（2026-10 之前的老口径，早已不成立）

以上任一出现，说明作者没看仓库，稿子直接退回重写。

---

## 四、写稿前 2 分钟核对动作

1. 看 `README.md` 的 **Compatibility** 行 + `README-CN.md` 的「诚实边界」第一条，两处必须一致。
2. `git log --oneline -i --grep=windows` 看最近一次 Windows 相关改动日期（比本文件新就以新的为准）。
3. 边界句与 README 冲突时：**以 README 为准**；若 README 才是错的，先改 README，再改稿。
4. 稿子内部笔记留一行：`平台事实核对：PLATFORM_FACTS.md @ <核对日期>`。

---

## 五、历史文件处理

`docs/marketing/` 下 2026-11-28 之前写的 `COPY_*.md`（含 CSDN#5/#6/#9、掘金#3/#4、知乎#3–#6、
简书#3、头条#2、51CTO#3、OSChina#3 等）里的平台边界**一律作废**，仅作已发布内容的历史记录，
不得再被复制进新稿。新稿只从本文件取边界句。

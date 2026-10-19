---
name: ai-browser
description: >-
  Control a real, visible browser to do things on websites: open a page, click, type, fill a form, log in, read page content, download/upload, inspect network requests. Use whenever the user asks to operate a website (打开网页/点一下/填表/登录/发布/提交/抓取/截图/看接口) or to read a page that needs JS to render.
  触发词：打开、点击、填表、输入、登录、扫码、发布、提交、下载、上传、抓取、爬取、截图、看接口、网页操作、browse。
---

# ai-browser

## 两条路，选一条就能干活

工具在就 `browse_navigate {"url":"https://example.com"}`；**不在也不用配任何东西**，走 CLI（同一引擎，装完即用）：

```
ai-browser call ui.get_tree '{"subset":"interactive"}'        # 读页面，拿 e:xxx
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'  # 点它
ai-browser call ui.navigate '{"url":"https://example.com"}'
```

没这个命令就加前缀 `npx -y @glittering0717/ai-browser`。浏览器没开时会自动拉起。

CLI 方法 = 工具名去掉 `browse_` 换 `ui.`（`get_tree` `act` `navigate` … 一一对应）。
不一一对应的 4 个（tabs/network/canvas/diff）见 `references/cli.md`。

## 点东西只认 id

`get_tree` 每个节点有 `id`（形如 `e:a-3`）。`act` 的 `target` **只接受这个 id**，
传页面上的文字会报 `target_not_found`。

## 操作后先看 effect_state

`committed` 已生效 → 继续｜`none` 页面没动 → 换 target 或重读树｜
`unknown` 说不准 → **先重读树再决定**，盲目重试会提交两次。

## 卡住时

| 现象 | 先做什么 |
|---|---|
| 树里没有要点的东西 | 等 `{"condition":"text_contains","text":"关键词"}` 再重读 |
| `target_not_found` + `stale_ref` | 页面变了 → 重读树拿新 id |
| `target_not_found` + `never_seen` | id 本身错 → 别重读，改参数 |
| 点了没反应 | `screenshot` 看画面；`network_list` 看请求 |
| 怀疑掉登录 | `auth_state` |
| 以上都不对 | `errors` |

## 需要人帮忙

登录/扫码/滑块/支付：**请用户在自己的窗口里操作**，他说"好了"再重读树确认。不要编造密码。

## 按需深挖

- `references/cli.md` — CLI 全部方法与参数对照
- `references/troubleshooting.md` — 失败排查顺序
- `references/hard-pages.md` — canvas / 富文本 / iframe / 上传
- `references/network.md` — 抓请求、取结构化数据
- `references/tasks.md` — 发布文章 / 读正文 的配方

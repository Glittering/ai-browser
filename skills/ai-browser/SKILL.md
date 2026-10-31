---
name: ai-browser
description: >-
  Control a real, visible browser to do things on websites: open a page, click, type, fill a form, log in, read page content, download/upload, inspect network requests. Use whenever the user asks to operate a website (打开网页/点一下/填表/登录/发布/提交/抓取/截图/看接口) or to read a page that needs JS to render.
  触发词：打开、点击、填表、输入、登录、扫码、发布、提交、下载、上传、抓取、爬取、截图、看接口、网页操作、browse。
---

# ai-browser

## 两条路

工具在就 `browse_navigate {"url":"https://example.com"}`。不在也不用配，走 CLI（同一引擎）：

```
ai-browser call ui.get_tree '{"subset":"interactive"}'        # 读页面，拿 e:xxx
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'  # 点它
```

没这个命令就加 `npx -y @glittering0717/ai-browser`，浏览器没开会自动拉起。
方法名 = 工具名把 `browse_` 换成 `ui.`（tabs 等例外）。

## 你的标签组

第一次动手会给你一页**空白工作页**，归在你自己的标签组；多 agent 各一组，互不相干。
省略 `tab` 就打它；用户的页不会被碰也不会被顶掉。组有上限，满了先关再开。
看用户的页 / 人登录扫码 / 全程后台：`references/tabs.md`。

## 点东西只认 id

`act` 的 `target` 只认 `get_tree` 给的 id；传文字会报 `target_not_found`。

## 操作后先看 effect_state

`committed` 继续｜`none` 换 target 或重读树｜`unknown` **先重读树**再决定，盲目重试会提交两次。

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

登录扫码滑块支付：回复请人操作，好了再读树；无 chat/一次性会话工具，勿编密码。

## 按需深挖

- `references/tabs.md` — 标签组、上限、把页面交给人的正确姿势
- `references/cli.md` — CLI 全部方法与参数对照
- `references/troubleshooting.md` — 失败排查顺序
- `references/hard-pages.md` — canvas / 富文本 / iframe / 上传
- `references/network.md` — 抓请求、取结构化数据
- `references/tasks.md` — 发布文章 / 读正文 的配方

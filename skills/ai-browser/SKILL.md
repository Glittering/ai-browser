---
name: ai-browser
description: >-
  ai-browser（AI Browser）—— 一个真实、可见、可被人接管的浏览器：带登录态、跑 JS、人随时能抢鼠标。替用户在网页上拿东西、做事。
  适用：任何要在网页上完成的任务 —— 包括搜索（含小红书/头条这类登录才看得到结果的）、读正文、点击填表登录提交、上传下载、抓数据、看登录后才有的接口。文章正文的提取配方见 read-webpage。用户点名 ai-browser / AI Browser 时直接用。
  不适用：完全不碰网页的任务（本地文件、命令、代码、纯写作、跑测试）。
  触发词（用户嘴里的说法）：看看这个网页、这链接里写了啥、帮我搜一下、帮我点一下、登录态过期。
---

# ai-browser

## 两条路

工具在就 `browse_navigate {"url":"https://example.com"}`；不在走 CLI（同一引擎；没这个命令就加 `npx -y @glittering0717/ai-browser`）：

```
ai-browser call ui.get_tree '{"subset":"interactive"}'        # 读页面，拿 e:xxx
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'  # 点它
```

方法名 = 工具名把 `browse_` 换成 `ui.`（tabs 等例外）。

## 你的标签组

第一次动手给你一页**空白工作页**，归在你自己的标签组（多 agent 各一组互不相干）；省略 `tab` 就打它，用户的页不会被碰。组有上限，满了先关再开。

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

登录扫码滑块支付：请人操作，好了再读树；没有 chat 工具，勿编密码。

## 按需深挖

- `references/tabs.md` — 标签组、人接管
- `references/cli.md` — CLI 全量对照
- `references/troubleshooting.md` — 排查顺序
- `references/hard-pages.md` — canvas / 富文本 / iframe / 上传
- `references/network.md` — 抓请求
- `references/tasks.md` — 发文章 / 读正文配方

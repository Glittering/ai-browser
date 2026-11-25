---
name: ai-browser
description: >-
  ai-browser（AI Browser）—— 真实、可见、带登录态、运行 JS、人可随时接管的浏览器，替用户在网页上做事。
  发文章 / 读正文 / 抓接口 → 分别用 content-publish、read-webpage 技能和 references/network.md。
  不适用：完全不碰网页的任务（本地文件、命令、代码、纯写作、跑测试）。
  适用：搜索（含小红书/头条这类登录才可见的）、点击填表登录提交、上传下载、抓数据、看登录后的接口；点名 ai-browser 即用。
  触发词：看看这个网页、这链接里写了啥、帮我搜一下、帮我点一下、登录态过期。
---

# ai-browser

## 兄弟技能（并列，不在本文件里）

- 发文章（CSDN / 知乎 / 掘金 / 公众号）→ `content-publish` 技能
- 提取文章正文 → `read-webpage` 技能
- 抓请求 / 看登录后的接口 → `references/network.md`

## 两条路

工具在就 `browse_navigate {"url":"https://example.com"}`；不在走 CLI（没这命令就加 `npx -y @glittering0717/ai-browser`）：

```
ai-browser call ui.get_tree '{"subset":"interactive"}'        # 读页面
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'  # 点它
```

方法名 = 工具名把 `browse_` 换成 `ui.`（tabs 等例外）。

## 你的标签组

第一次动手给你一页**空白工作页**，归你的标签组；省略 `tab` 就打它，用户的页不会被碰。

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

- `references/tabs.md` — 标签组 / 人接管
- `references/cli.md` — CLI 全量
- `references/troubleshooting.md` — 排查
- `references/hard-pages.md` — 难搞页面
- `references/network.md` — 抓请求 / 接口
- `references/tasks.md` — 发文章 / 读正文

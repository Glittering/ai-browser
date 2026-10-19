---
name: ai-browser
description: >-
  Control a real, visible browser to do things on websites: open a page, click, type, fill a form, log in, read page content, download/upload, inspect network requests. Use whenever the user asks to operate a website (打开网页/点一下/填表/登录/发布/提交/抓取/截图/看接口) or to read a page that needs JS to render.
  触发词：打开、点击、填表、输入、登录、扫码、发布、提交、下载、上传、抓取、爬取、截图、看接口、网页操作、browse。
---

# ai-browser

## 三步（照抄即可）

```
browse_navigate  {"url":"https://example.com"}
browse_get_tree  {"subset":"interactive"}
browse_act       {"action":"click","target":"e:a-3"}
```

`browse_get_tree` 返回的每个节点都有 `id`（形如 `e:a-3`）；`browse_act` 的 `target` **只接受这个 id**，
不接受页面上看到的文字（传文字会报 `target_not_found`）。

## 每次操作后先看 `effect_state`

| 值 | 意思 | 该做什么 |
|---|---|---|
| `committed` | 已生效 | 别重试，继续下一步 |
| `none` | 页面没被动过 | 修掉原因（换 target / 重读树）再试 |
| `unknown` | 说不准（超时等） | **先 `browse_get_tree` 看现状**，盲目重试会提交两次 |

## 卡住时

| 现象 | 先做什么 |
|---|---|
| 树里没有要点的东西 | `browse_wait {"condition":"text_contains","text":"关键词"}` 再重读树 |
| `target_not_found` 且 `stale_ref:true` | 页面变过 → 重读树拿新 id |
| `target_not_found` 且 `ref_diagnosis:"never_seen"` | id 本身错了 → 别重读，改传参 |
| 点了没反应 | `browse_screenshot` 看画面；`browse_network {"operation":"list"}` 看请求 |
| 怀疑掉登录 | `browse_auth_state` |
| 以上都不对 | `browse_errors` |

## 需要人帮忙

登录、扫码、滑块、支付：**在对话里请用户在自己的窗口里操作**，他说"好了"再 `browse_get_tree` 确认。
不要编造账号密码，不要反复重试注定失败的点击。

## 按需深挖（不要一上来就读）

- `references/troubleshooting.md` — 失败排查顺序
- `references/hard-pages.md` — canvas / 富文本 / iframe / 上传
- `references/network.md` — 抓请求、取结构化数据
- `references/tasks.md` — 发布文章 / 读正文 的配方

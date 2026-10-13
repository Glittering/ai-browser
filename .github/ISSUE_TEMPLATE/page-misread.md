---
name: Page misread / semantic tree error
about: 语义树把某个页面读错了（角色/标签/动作误判、元素缺失、iframe 读不到）——本项目最有价值的一类报告
title: '[tree] '
labels: tree-extraction
assignees: ''
---

> 语义树是对 DOM 的启发式抽取，不是规范实现； exotic 页面误判是已知边界。
> 这类报告是我们最需要的——请尽量给出可复现的页面。

## 哪个页面

- URL：
- 是否需要登录：
- 是否在 iframe（尤其是跨域 iframe / OOPIF）里：
- 页面框架（React / Vue / Angular / 其他，不知道可留空）：

## 读错了什么

- [ ] 元素缺失（树上没有，页面上有）
- [ ] role / label / actions 标错
- [ ] 不可交互元素被标成可交互（或反过来）
- [ ] value 不对 / 被截断
- [ ] 弹窗、toast、必填提示等 context 信息缺失或误报
- [ ] 其他：

## 期望的读取结果

这个元素**实际上**是什么、应该被读成什么。

## 证据

请贴 `browse_get_tree`（建议带 `subset: "interactive"`）返回的相关片段，
以及该元素的一段最小 HTML（浏览器开发者工具里复制 outerHTML）。

## 复现稳定性

- [ ] 每次复现
- [ ] 偶发（大概概率：）
- [ ] 只在登录后 / 特定数据状态下出现

// e2e/realsites/sites.js — 真实站测试的站点矩阵（表驱动数据源）
// 加站 = 在此加一行；对简单 base 站点用三件套（navigate / get_tree / title）。
// 触发面分桶见 docs/coverage-20-sites-plan.md。loginWall 站点用"探测到登录墙即通过"
// 的容忍策略（沿用知乎既有做法），不强制登录、不做深度断言。

const BUCKETS = ['search', 'finance', 'media', 'dev', 'ecommerce', 'spa', 'editor', 'marketplace'];

module.exports = [
  // --- A 搜索/入口 ---
  { name: '百度搜索', url: 'https://www.baidu.com/s?wd=AI%20browser', bucket: 'search', minNodes: 6 },
  { name: 'Bing搜索', url: 'https://www.bing.com/search?q=AI%20browser', bucket: 'search', minNodes: 6 },
  { name: '360搜索', url: 'https://www.so.com/s?q=AI%20browser', bucket: 'search', minNodes: 5 },

  // --- B 财经/复杂重页面 ---
  { name: '东方财富', url: 'https://www.eastmoney.com', bucket: 'finance', minNodes: 16 },
  { name: '同花顺', url: 'https://www.10jqka.com.cn', bucket: 'finance', minNodes: 16 },
  { name: '雪球', url: 'https://xueqiu.com', bucket: 'finance', minNodes: 6, loginWall: true },

  // --- C 媒体 / SPA 懒加载 (Phase 2) ---
  { name: '今日头条', url: 'https://www.toutiao.com', bucket: 'media', minNodes: 8 },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com', bucket: 'spa', minNodes: 8 },
  { name: '微博', url: 'https://weibo.com', bucket: 'spa', minNodes: 8, loginWall: true },
  { name: '阿里云', url: 'https://www.aliyun.com', bucket: 'spa', minNodes: 8 },

  // --- 开发平台（Phase 1 仅纳入 base；深化留 Phase 3）---
  { name: 'GitHub', url: 'https://github.com', bucket: 'dev', minNodes: 8 },

  // --- E 电商/反爬对抗（Phase 1 仅首页三件套；深桶留 Phase 3）---
  // 京东反爬强(risk_handler 拦截导航)，接入 antiBot 容忍：探到反爬墙即 PASS
  { name: '京东', url: 'https://www.jd.com', bucket: 'ecommerce', minNodes: 8, antiBot: true },

  // --- E 电商/反爬深桶 (Phase 3；探测即容忍，不人工登录/验证码) ---
  { name: '淘宝', url: 'https://www.taobao.com', bucket: 'marketplace', minNodes: 8, antiBot: true },
  { name: '闲鱼', url: 'https://www.goofish.com', bucket: 'marketplace', minNodes: 8, antiBot: true },
  { name: '亚马逊', url: 'https://www.amazon.com', bucket: 'marketplace', minNodes: 8, antiBot: true },

  // --- D 富编辑器 (Phase 2；进入编辑器需登录态，未登录走登录墙容忍) ---
  { name: '语雀', url: 'https://www.yuque.com', bucket: 'editor', minNodes: 8, loginWall: true },
  { name: '飞书', url: 'https://www.feishu.cn', bucket: 'editor', minNodes: 8, loginWall: true },
];

module.exports.BUCKETS = BUCKETS;
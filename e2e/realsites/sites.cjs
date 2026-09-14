// e2e/realsites/sites.js — 真实站测试的站点矩阵（表驱动数据源）
// 加站 = 在此加一行；对简单 base 站点用三件套（navigate / get_tree / title）。
// 触发面分桶见 docs/coverage-20-sites-plan.md。loginWall 站点用"探测到登录墙即通过"
// 的容忍策略（沿用知乎既有做法），不强制登录、不做深度断言。

const BUCKETS = ['search', 'finance', 'media', 'dev', 'ecommerce'];

module.exports = [
  // --- A 搜索/入口 ---
  { name: '百度搜索', url: 'https://www.baidu.com/s?wd=AI%20browser', bucket: 'search', minNodes: 6 },
  { name: 'Bing搜索', url: 'https://www.bing.com/search?q=AI%20browser', bucket: 'search', minNodes: 6 },
  { name: '360搜索', url: 'https://www.so.com/s?q=AI%20browser', bucket: 'search', minNodes: 5 },

  // --- B 财经/复杂重页面 ---
  { name: '东方财富', url: 'https://www.eastmoney.com', bucket: 'finance', minNodes: 16 },
  { name: '同花顺', url: 'https://www.10jqka.com.cn', bucket: 'finance', minNodes: 16 },
  { name: '雪球', url: 'https://xueqiu.com', bucket: 'finance', minNodes: 6, loginWall: true },

  // --- C 媒体 ---
  { name: '今日头条', url: 'https://www.toutiao.com', bucket: 'media', minNodes: 8 },

  // --- 开发平台（Phase 1 仅纳入 base；深化留 Phase 3）---
  { name: 'GitHub', url: 'https://github.com', bucket: 'dev', minNodes: 8 },

  // --- E 电商/反爬对抗（Phase 1 仅首页三件套；深桶留 Phase 3）---
  { name: '京东', url: 'https://www.jd.com', bucket: 'ecommerce', minNodes: 8 },
];

module.exports.BUCKETS = BUCKETS;
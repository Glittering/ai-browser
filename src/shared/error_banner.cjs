// shared/error_banner.cjs — 主进程异常横幅的文案装配（纯函数，可在 vitest 里直接测）。
//
// 为什么单独一个文件：横幅内容有两条硬要求，都值得被钉住 ——
//   ① **一行**。横幅只有 34px 高，异常消息里带换行（多行栈、带 \n 的 Error.message）
//      会把文字挤没，用户看到一片红却读不到原因。
//   ② **必须带日志路径**。横幅是提醒，不是全部信息：真正的栈在 error.jsonl 里。
//      只写"出错了"等于把人重新推回"点掉之后无从查证"的老问题。
//
// 这些逻辑放在 main/index.js 里就没法测了（那个文件 import electron）。

'use strict';

const MAX_DETAIL = 220;
const MAX_LOG_PATH = 120;

// 压成一行 + 截断。用省略号而不是硬切，读的人才知道后面还有内容。
function oneLine(input, max) {
  const s = String(input === undefined || input === null ? '' : input)
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * @param {{detail?: string, logPath?: string, at?: string, count?: number}} input
 * @returns {{title: string, detail: string, log_path: string, at: string, count: number}}
 */
function buildBannerPayload(input) {
  const src = input || {};
  return {
    title: 'AI Browser 主进程异常',
    detail: oneLine(src.detail, MAX_DETAIL) || '(没有消息)',
    // 路径也压一行：userData 可能被 AI_BROWSER_USER_DATA 指到很深的目录
    log_path: oneLine(src.logPath, MAX_LOG_PATH),
    at: src.at || new Date().toISOString(),
    // 连续报错时横幅不叠加，只把次数写进角标 —— 一屏红块比一行红更烦人
    count: Number(src.count) > 0 ? Math.floor(Number(src.count)) : 1,
  };
}

module.exports = { buildBannerPayload, MAX_DETAIL };

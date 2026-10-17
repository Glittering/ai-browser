// src/main/error_log.js — 主进程错误日志（JSONL，滚动，可回读）。
//
// 存在理由（2026-10-17 实测）：主进程此前**一处错误处理都没有**。任何未捕获
// 异常都走 Electron 的默认路径 —— 弹一个原生对话框（标题就是 "A JavaScript
// error occurred in the main process"），栈只在框里、点掉就没了，进程随即退出。
// 用户看到"弹了个框说 js 崩溃"，而事后**没有任何地方能查到它崩在哪** ——
// 连"刚才是不是真崩过"都证不了。这不是"日志不够详细"，是根本没有。
//
// 三条设计约束：
//   1. **日志本身绝不能再抛异常**。所有磁盘操作 try/catch 吞掉：为了记录崩溃
//      而制造新崩溃，是最难查的那种 bug。
//   2. **同步写**（appendFileSync）。异步写等到 flush 时进程可能已经没了 ——
//      崩溃现场最需要的恰恰是最后一刻那几行。
//   3. **异常条目自带最近的调用上下文**。只有栈是不够的：栈会告诉你崩在
//      `selectorAncestors`，但不会告诉你"是哪个 ui.act 在什么 target 上触发的"。
//      所以维护一个 WS 调用环形缓冲，落盘时把它一并附上。

import fs from 'node:fs';
import path from 'node:path';

// 单文件上限与保留份数。2MB ×(1+4) 对纯文本日志是几个月量级的事件量；
// 再大就说明是循环报错，那种情况靠滚动还不如早点被看见。
// 允许 init 时覆盖：磁盘紧张的环境可以调小，测试也靠它把滚动路径跑起来。
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP = 4;
let maxBytes = DEFAULT_MAX_BYTES;
let keepFiles = DEFAULT_KEEP;
// 内存里留最近多少条，供 ui.errors 直接读（不碰磁盘，快）
const RING_MAX = 200;
// 最近多少次 WS 调用参与"崩溃上下文"
const CALL_RING_MAX = 40;
// 单条日志里字符串字段的截断长度
const FIELD_MAX = 4000;

let logFile = null;
let logDir = null;
let wroteBytes = 0;
let dropped = 0;

const ring = [];
const callRing = [];

/** 把任意值压成"可安全 JSON.stringify 的一行摘要"。 */
function summarize(v, depth = 0) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string') return v.length > FIELD_MAX ? v.slice(0, FIELD_MAX) + '…(' + v.length + ' chars)' : v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'bigint') return String(v);
  if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
  if (t === 'symbol') return String(v);
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: String(v.stack || '').slice(0, 8000) };
  }
  if (depth >= 3) return Array.isArray(v) ? '[array ' + v.length + ']' : '[object]';
  if (Array.isArray(v)) {
    const head = v.slice(0, 12).map((x) => summarize(x, depth + 1));
    return v.length > 12 ? head.concat(['…+' + (v.length - 12)]) : head;
  }
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n++ >= 20) { out['…'] = 'more keys omitted'; break; }
    out[k] = summarize(v[k], depth + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function rotateIfNeeded(nextLen) {
  try {
    if (!logFile) return;
    let size = wroteBytes;
    if (!size) {
      try { size = fs.statSync(logFile).size; } catch { size = 0; }
    }
    if (size + nextLen <= maxBytes) return;
    // error.jsonl → error.jsonl.1 → error.jsonl.2 …
    for (let i = keepFiles - 1; i >= 1; i--) {
      const from = i === 1 ? logFile : logFile + '.' + (i - 1);
      const to = logFile + '.' + i;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
    }
    // 轮转后旧内容已经在 .1，当前文件从零开始
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch {}
    wroteBytes = 0;
  } catch {}
}

function appendLine(obj) {
  const line = JSON.stringify(obj) + '\n';
  rotateIfNeeded(Buffer.byteLength(line));
  try {
    fs.appendFileSync(logFile, line);
    wroteBytes += Buffer.byteLength(line);
  } catch (e) {
    // 写不下去就记账，靠 ui.errors 的 dropped 字段让调用方知道"这里缺了东西"
    dropped += 1;
  }
}

/**
 * 初始化日志目录。**必须在 app ready 之前调用**，否则早期崩溃（最常见的那类）
 * 落不了盘。
 * @param {{dir: string, meta?: object}} opts dir 为日志目录；meta 附在启动行里
 *        （版本、端口、userData…），方便事后分辨"这份日志是哪个实例的"。
 */
export function initErrorLog(opts) {
  const dir = (opts && opts.dir) || null;
  if (!dir) return null;
  logDir = dir;
  if (opts && Number(opts.maxBytes) > 0) maxBytes = Number(opts.maxBytes);
  if (opts && Number(opts.keep) > 0) keepFiles = Math.max(1, Number(opts.keep));
  logFile = path.join(dir, 'error.jsonl');
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { wroteBytes = fs.statSync(logFile).size; } catch { wroteBytes = 0; }
    // 进程边界的标记行：读日志时能一眼看出"这是哪一次启动"，以及上一次
    // 是不是异常结束（没有 shutdown 行就说明是硬退）
    appendLine({
      ts: nowIso(),
      kind: 'boot',
      pid: process.pid,
      node: process.versions && process.versions.node,
      electron: process.versions && process.versions.electron,
      platform: process.platform + ' ' + process.arch,
      ...summarize((opts && opts.meta) || {}),
    });
  } catch {
    logFile = null;
  }
  return logFile;
}

export function getLogPath() {
  return logFile;
}

export function getLogDir() {
  return logDir;
}

/**
 * 记一条错误。永不抛。
 * @param {string} kind 事件类别：uncaught_exception / unhandled_rejection /
 *        render_process_gone / child_process_gone / nav_fail / ws_error / …
 * @param {object} info 任意附加字段（message/stack/url/tab/…）
 */
export function recordError(kind, info) {
  const entry = {
    ts: nowIso(),
    kind: String(kind || 'unknown'),
    pid: process.pid,
    uptime_ms: Math.round(process.uptime() * 1000),
    ...summarize(info || {}),
  };
  // 崩溃上下文：最近若干次 WS 调用。放在条目里而不是另起一行，读的时候
  // 不用自己按时间拼。
  if (callRing.length) entry.recent_calls = callRing.slice(-20);
  ring.push(entry);
  while (ring.length > RING_MAX) ring.shift();
  appendLine(entry);
  return entry;
}

/**
 * 记一次 WS 调用（进环形缓冲，不落盘 —— 只作为崩溃时的上下文）。
 * @param {string} method 方法名
 * @param {object} params 原始参数（内部会摘要化，大字段自动截断）
 * @param {number} ms 耗时
 * @param {boolean|string} outcome true/false 或错误摘要
 */
export function noteCall(method, params, ms, outcome) {
  try {
    const brief = summarize(params || {});
    // 只留能定位的信息：text/html 这类大字段压成"长度"
    const slim = {};
    if (brief && typeof brief === 'object') {
      for (const k of Object.keys(brief)) {
        if (k === 'text' || k === 'html') {
          // 正文类字段只留长度：几十 KB 的稿子灌进日志，一条就把文件写满
          const v = (params || {})[k];
          slim[k] = typeof v === 'string' ? '<' + v.length + ' chars>' : brief[k];
        } else if (k === 'js') {
          // 脚本保留开头：它是定位"崩在哪段注入代码"的关键，只留长度等于没留。
          // 但也不能整段进日志（内联 base64 图片会让一条日志到 MB 级）。
          const v = (params || {})[k];
          slim[k] = typeof v === 'string'
            ? (v.length > 200 ? v.slice(0, 200) + '…<' + v.length + ' chars>' : v)
            : brief[k];
        } else {
          slim[k] = brief[k];
        }
      }
    }
    callRing.push({
      ts: nowIso(),
      method: String(method || ''),
      params: slim,
      ms: typeof ms === 'number' ? ms : null,
      outcome: outcome === undefined ? null : summarize(outcome),
    });
    while (callRing.length > CALL_RING_MAX) callRing.shift();
  } catch {
    /* 记调用上下文失败绝不影响调用本身 */
  }
}

/**
 * 读最近错误（内存里的本次进程记录）。文件才是权威历史 —— 进程一崩，这里
 * 就没了，所以回执里带 path 让调用方自己去翻。
 */
export function recentErrors(limit = 50, kind = null) {
  const n = Math.max(1, Math.min(RING_MAX, Number(limit) || 50));
  // boot / shutdown 是进程边界标记，不是"错误"。只有明确按 kind 查时才返回它们。
  const MARKERS = new Set(['boot', 'shutdown']);
  let items = kind ? ring.filter((e) => e.kind === kind) : ring.filter((e) => !MARKERS.has(e.kind));
  return {
    path: logFile,
    dir: logDir,
    count_in_memory: items.length,
    dropped_writes: dropped,
    items: items.slice(-n),
  };
}

/** 正常退出时补一行收尾 —— 日志里没有 shutdown 行 = 上次是硬退。 */
export function markShutdown(reason) {
  recordError('shutdown', { reason: reason || 'normal' });
}

// 仅供测试：重置模块内状态，避免用例之间互相污染。
export function __resetForTests() {
  logFile = null;
  logDir = null;
  wroteBytes = 0;
  dropped = 0;
  maxBytes = DEFAULT_MAX_BYTES;
  keepFiles = DEFAULT_KEEP;
  ring.length = 0;
  callRing.length = 0;
}

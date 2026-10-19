#!/usr/bin/env node
// scripts/cli_call.cjs — 命令行直接调浏览器，**不用写任何客户端脚本**。
//
// 为什么要有这个（真实抱怨，2026-10-19）：
//   「我看操作这个项目，经常需要写 cjs 代码，这是必须的吗？」
//   不是必须的，但以前确实没有别的办法：对外只有两个入口 —— MCP stdio（给 agent
//   客户端用）和裸 WebSocket JSON-RPC（ws://127.0.0.1:9223）。想从 shell 里问一句
//   "现在有哪些标签页"，就得先 npm i ws、再写一个连上发 JSON 的小脚本、再等回包。
//   一个本来只是一行命令的事情，被迫变成"写代码"。
//
// 所以这里补的是**通道**，不是新能力：它做的就是把一条 JSON-RPC 发出去、把 result
// 打出来。所有能力仍然只有一套实现（page_manager），MCP 和 CLI 都是它的薄壳。
//
// 用法：
//   ai-browser call ui.list_tabs
//   ai-browser call ui.get_tree '{"subset":"interactive"}'
//   ai-browser call ui.navigate '{"url":"https://example.com"}'
//   echo '{"url":"https://example.com"}' | ai-browser call ui.navigate -
//   ai-browser call ui.act '{"action":"click","target":"e:a-1"}'
//   ai-browser status
//
// 选项：
//   --port <n>       默认 9223（也读 AI_BROWSER_WS_PORT）
//   --timeout <ms>   默认 30000
//   --compact        单行输出（默认就是紧凑 JSON，加这个只是显式）
//   --pretty         缩进输出（给人看时用）
'use strict';

const WS_PORT_DEFAULT = 9223;
const TIMEOUT_DEFAULT = 30000;

function parseArgs(argv) {
  const out = { port: null, timeout: TIMEOUT_DEFAULT, pretty: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { out.port = Number(argv[++i]); continue; }
    if (a === '--timeout') { out.timeout = Number(argv[++i]); continue; }
    if (a === '--pretty') { out.pretty = true; continue; }
    if (a === '--compact') { out.pretty = false; continue; }
    out.rest.push(a);
  }
  if (!out.port || !Number.isFinite(out.port)) {
    const envPort = Number(process.env.AI_BROWSER_WS_PORT);
    out.port = Number.isFinite(envPort) && envPort > 0 ? envPort : WS_PORT_DEFAULT;
  }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) out.timeout = TIMEOUT_DEFAULT;
  return out;
}

/** 把命令行里的 JSON 载荷解析成对象；空/缺省 → {}。 */
function parsePayload(text) {
  if (text === undefined) return {};
  const t = String(text).trim();
  if (!t) return {};
  let val;
  try {
    val = JSON.parse(t);
  } catch (e) {
    const err = new Error(`payload is not valid JSON: ${e.message}\n  got: ${t.slice(0, 120)}`);
    err.code = 'bad_json';
    throw err;
  }
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    const err = new Error('payload must be a JSON object, e.g. {"url":"https://example.com"}');
    err.code = 'bad_json';
    throw err;
  }
  return val;
}

/**
 * 发一条 JSON-RPC 并等回包。**不在这里做重试/重连** —— CLI 是同步语义：
 * 一条命令一个结果，失败就把原因原样报出来，别替调用方猜。
 */
function rpcCall({ port, timeout, method, params }) {
  // require 放在函数里：只有真的要连的时候才需要 ws（--help 之类不该加载它）。
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} fn(arg); } };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      done(reject, Object.assign(new Error(`no reply from ${method} within ${timeout}ms`), { code: 'timeout' }));
    }, timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (_) { return; }  // 事件广播不是回包，忽略
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) {
        // 带上方法名：服务端只会说 "Method not found"，不带名字的话调用方还得自己
        // 回想刚才打的是哪个（一条命令里可能有变量拼出来的方法名）。
        const why = msg.error.message || 'rpc error';
        done(reject, Object.assign(new Error(`${why} (${method})`), { code: 'rpc_error', rpc: msg.error }));
      } else {
        done(resolve, msg.result);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      const hint = /ECONNREFUSED/i.test(e.message)
        ? `浏览器没在 127.0.0.1:${port} 上跑。先 \`ai-browser start\`（MCP 客户端会自己拉起），或用 --port 指定别的端口。`
        : e.message;
      done(reject, Object.assign(new Error(hint), { code: 'connect_failed' }));
    });
  });
}

function printResult(result, pretty) {
  if (result === undefined) { process.stdout.write('null\n'); return; }
  const text = pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  process.stdout.write(text + '\n');
}

async function runCall(argv) {
  const opt = parseArgs(argv);
  const method = opt.rest[0];
  if (!method) {
    process.stderr.write('usage: ai-browser call <method> [json|-] [--port n] [--timeout ms] [--pretty]\n'
      + '  e.g. ai-browser call ui.list_tabs\n'
      + '       ai-browser call ui.get_tree \'{"subset":"interactive"}\'\n');
    return 2;
  }
  let params;
  try {
    const raw = opt.rest[1] === '-' ? readStdin() : opt.rest[1];
    params = parsePayload(raw);
  } catch (e) {
    process.stderr.write(`[ai-browser] ${e.message}\n`);
    return 2;
  }
  try {
    const result = await rpcCall({ port: opt.port, timeout: opt.timeout, method, params });
    printResult(result, opt.pretty);
    return 0;
  } catch (e) {
    process.stderr.write(`[ai-browser] ${e.message}\n`);
    return 1;
  }
}

async function runStatus(argv) {
  const opt = parseArgs(argv);
  try {
    const info = await rpcCall({ port: opt.port, timeout: Math.min(opt.timeout, 5000), method: 'ui.server_info', params: {} });
    let tabs = null;
    try { tabs = await rpcCall({ port: opt.port, timeout: Math.min(opt.timeout, 5000), method: 'ui.list_tabs', params: {} }); } catch (_) {}
    const out = {
      running: true,
      port: opt.port,
      pid: info && info.pid,
      started_at: info && info.started_at,
      platform: info && info.platform,
      tabs: tabs && tabs.tabs ? tabs.tabs.map((t) => ({ id: t.id, active: t.active, title: t.title, url: t.url })) : null,
    };
    printResult(out, opt.pretty);
    return 0;
  } catch (e) {
    // 没跑**不是错误状态**：这是用户最常问的第一个问题，答案要清楚、可执行。
    printResult({ running: false, port: opt.port, reason: e.message }, opt.pretty);
    return 1;
  }
}

// stdin 读成字符串（供 `... | ai-browser call ui.navigate -` 用）
function readStdin() {
  try {
    return require('node:fs').readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

module.exports = { runCall, runStatus, parsePayload, parseArgs, rpcCall, WS_PORT_DEFAULT };

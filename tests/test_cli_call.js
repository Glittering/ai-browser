// tests/test_cli_call.js — `ai-browser call` / `ai-browser status` 的端到端行为。
//
// 这两个命令存在的理由是消除"想调一个方法就得先写脚本"的摩擦（用户原话：
// 「经常需要写 cjs 代码，这是必须的吗？」）。所以测试的重点不是内部实现，
// 而是**命令行契约**：退出码、stdout/stderr 分工、以及"没在跑"时给不给得出
// 可执行的下一步。
//
// 起一个真的 WS server（ephemeral 端口）+ 真的 spawn 子进程，不 mock socket：
// 这条链路上最容易坏的就是"两个进程之间那段"，mock 掉就等于没测。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWSServer } from '../src/main/ws_server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'bin', 'ai-browser.cjs');

let server;
let pm;
let port;

function makePageManager() {
  return {
    activeTab: 1,
    _lastActParams: null,
    getTree: async () => ({ tree: { id: 'e:body-0', role: 'generic', children: [] }, context: { modals: [] } }),
    executeAction: async (action, target, params) => { this._lastActParams = params; return { success: true, action, target }; },
    listTabs: () => [{ id: 1, url: 'https://example.com/', title: 'Example', active: true }],
    navigate: async () => ({ ok: true }),
    registerClient: () => {},
    unregisterClient: () => {},
    addSubscription: () => {},
    removeSubscription: () => {},
    newTab: () => 2,
    closeTab: () => true,
    setActive: () => true,
    getFocused: async () => null,
    getNetworkBody: async () => null,
  };
}

/** 跑一次 CLI，收集 stdout/stderr/exitCode。 */
function run(args, { input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  pm = makePageManager();
  server = startWSServer(pm, 0);
  await server.ready;
  port = String(server.port);
});

afterAll(async () => {
  if (server) server.close();
});

describe('ai-browser call', () => {
  it('CLI-1: 无参数方法 → stdout 只有那一行 JSON，退出码 0', async () => {
    const r = await run(['call', 'ui.list_tabs', '--port', port]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tabs[0].title).toBe('Example');
    expect(r.stderr).toBe('');
  });

  it('CLI-2: JSON 载荷原样送到服务端（不是被丢掉的）', async () => {
    const r = await run(['call', 'ui.get_tree', '{"subset":"interactive"}', '--port', port]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tree.id).toBe('e:body-0');
  });

  it('CLI-3: `-` 从 stdin 读载荷（长 JSON 不用跟 shell 引号搏斗）', async () => {
    const r = await run(['call', 'ui.navigate', '-', '--port', port], { input: '{"url":"https://example.com"}' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true });
  });

  it('CLI-4: 坏 JSON → 退出码 2，错误进 stderr，stdout 保持干净（可安全管道给 jq）', async () => {
    const r = await run(['call', 'ui.navigate', '{bad}', '--port', port]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/not valid JSON/);
    expect(r.stderr).toMatch(/\{bad\}/);   // 把收到的原样回显，便于对照
  });

  it('CLI-5: 载荷不是对象（数组/字符串）也拒绝 —— 服务端只认对象', async () => {
    const r = await run(['call', 'ui.get_tree', '[1,2]', '--port', port]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/must be a JSON object/);
  });

  it('CLI-6: 不给方法名 → 用法说明，退出码 2', async () => {
    const r = await run(['call', '--port', port]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: ai-browser call/);
  });

  it('CLI-7: 服务端返回 JSON-RPC error → 退出码 1，原因透传不吞', async () => {
    const r = await run(['call', 'ui.no_such_method', '--port', port]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Method not found \(ui\.no_such_method\)/);
  });

  it('CLI-8: 端口上没东西 → 退出码 1，且提示"下一步做什么"而不是 ECONNREFUSED 原文', async () => {
    const r = await run(['call', 'ui.list_tabs', '--port', '9']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/没在 127\.0\.0\.1:9 上跑/);
    expect(r.stderr).toMatch(/ai-browser start/);
  });
});

describe('ai-browser status', () => {
  it('ST-1: 在跑 → running:true + pid/port/tabs', async () => {
    const r = await run(['status', '--port', port]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.running).toBe(true);
    expect(typeof out.pid).toBe('number');
    expect(out.port).toBe(Number(port));
    expect(out.tabs[0].id).toBe(1);
  });

  it('ST-2: 没在跑 → running:false，但仍输出 JSON 且退出码 1（可被脚本判断）', async () => {
    const r = await run(['status', '--port', '9']);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.running).toBe(false);
    expect(out.reason).toMatch(/ai-browser start/);
  });

  it('ST-3: --pretty 只影响排版，不改变内容', async () => {
    const r = await run(['status', '--port', port, '--pretty']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('{')).toBe(true);
    expect(r.stdout).toContain('\n');       // 缩进过
    expect(JSON.parse(r.stdout).running).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

describe('MCP tool list (token-cost guard)', () => {
  const names = MCP_TOOLS.map((t) => t.name);

  it('keeps exactly 15 tools', () => {
    // browse_subscribe 与 browse_network_body 已换出：
    // - browse_subscribe：MCP 路径收不到 server→client 通知（mcp_ws.js 丢弃无 id
    //   的推送），订阅对它毫无作用；且网络采集已改为默认开启，它"启动采集"的
    //   副作用也不再需要。
    // - browse_network_body：被 browse_network 严格超集替代。
    //
    // 13 → 15（有意变更，理由如下）。工具数每增加 1 都会抬高每轮上下文成本，
    // 因此这个数字必须是**有意**变更。
    //   + browse_diff：把"动作 → 回读 → 比对"变成一次调用。这是本项目的硬规矩
    //     （success ≠ 做成了），而此前每次都要手写站点专属的比对 JS —— 实测
    //     因此两次量错了对象（拿 serialize() 字节数当指纹、拿视口变化当数据变化），
    //     得出过自信的假结论。少写一次比对逻辑，就少一次谎报的机会。
    //   + browse_capabilities：把"这一页该怎么操作"从几小时的手工探查变成一次
    //     调用。已在两类截然不同的真实页面上验证结论与手工排查一致。
    // 两者都是**减少** agent 的往返与出错面，总 token 成本是下降的。
    expect(MCP_TOOLS).toHaveLength(15);
  });

  it('新增的两个工具都保持精简描述（护栏：描述长度是每轮都要付的成本）', () => {
    for (const name of ['browse_diff', 'browse_capabilities']) {
      const t = MCP_TOOLS.find((x) => x.name === name);
      expect(t, name + ' must exist').toBeTruthy();
      expect(t.description.length).toBeLessThan(200);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('browse_diff 走 operation 风格（与 browse_network / browse_canvas 一致，不新增工具位）', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'browse_diff');
    expect(t.inputSchema.properties.operation.enum).toEqual(['snapshot', 'diff']);
    expect(t.inputSchema.required).toEqual(['operation']);
  });

  it('换出的两个工具不再出现在 MCP 清单里', () => {
    // raw WS 层的 ui.subscribe / ui.network_body 仍然保留，只是不再暴露给 MCP
    expect(names).not.toContain('browse_subscribe');
    expect(names).not.toContain('browse_network_body');
  });

  it('exposes browse_network and nothing else new', () => {
    expect(names).toContain('browse_network');
    const op = MCP_TOOLS.find((t) => t.name === 'browse_network');
    expect(op.inputSchema.properties.operation.enum).toEqual(['list', 'get', 'clear', 'configure']);
    expect(op.inputSchema.required).toEqual(['operation']);
  });

  it('exposes browse_canvas with list/read/configure/capture', () => {
    expect(names).toContain('browse_canvas');
    const op = MCP_TOOLS.find((t) => t.name === 'browse_canvas');
    expect(op.inputSchema.properties.operation.enum).toEqual(['list', 'read', 'configure', 'capture']);
    expect(op.inputSchema.required).toEqual(['operation']);
  });

  it('browse_act exposes the read-only get_value action', () => {
    const act = MCP_TOOLS.find((t) => t.name === 'browse_act');
    expect(act.inputSchema.properties.action.enum).toContain('get_value');
    expect(act.inputSchema.properties.offset).toBeTruthy();
    expect(act.inputSchema.properties.limit).toBeTruthy();
  });

  it('has unique tool names', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('always keeps the core read-think-act primitives', () => {
    for (const core of ['browse_navigate', 'browse_get_tree', 'browse_act', 'browse_evaluate', 'browse_wait']) {
      expect(names).toContain(core);
    }
  });

  it('does NOT re-expose browse_read_article (moved to skills/read-webpage)', () => {
    expect(names).not.toContain('browse_read_article');
  });

  it('keeps runtime-exclusive network tools + lifecycle + tab mgmt', () => {
    for (const kept of [
      'browse_quit',
      'browse_list_tabs',
      'browse_new_tab',
      'browse_close_tab',
      'browse_set_active_tab',
      'browse_scroll'
    ]) {
      expect(names).toContain(kept);
    }
  });

  it('every tool has a non-empty minimal description and an object inputSchema', () => {
    for (const t of MCP_TOOLS) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThan(200); // keep per-message cost low
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.name).toBe('string');
      expect(t.name.startsWith('browse_')).toBe(true);
    }
  });
});
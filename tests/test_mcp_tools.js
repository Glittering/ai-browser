import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

describe('MCP tool list (token-cost guard)', () => {
  const names = MCP_TOOLS.map((t) => t.name);

  it('keeps exactly 17 tools', () => {
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
    //
    // 15 → 16（有意变更）：
    //   + browse_repaint："窗口显示的是旧画面"这个故障**没有任何可观测状态**
    //     （DOM 树和 evaluate 早就报新页面了，只有屏幕是旧的），所以 agent 唯一
    //     的手段就是显式要求重绘。此前它只在 raw WS 上暴露，而 MCP 是 agent 的
    //     主通路 —— 恰好是这个功能最需要的地方够不着。描述压到 139 字符。
    //   + browse_downloads：此前 src/ 里**没有任何** will-download 处理器，
    //     Electron 默认取消下载。agent 点"导出 CSV"只看到 success，然后什么都没有，
    //     连错误都没有 —— 最隐蔽的一类 success ≠ done。这个工具是让 agent 能问到
    //     "文件在哪儿"的唯一入口。下载是异步的，塞进 click 返回值会让 agent 在错的
    //     时间点看到空列表，所以必须是独立查询。
    // 19 → 20（有意变更）：
    //   + browse_errors：2026-10-17 亲眼看到的现象 —— 界面弹一个原生框说
    //     "A JavaScript error occurred in the main process"，用户点掉之后
    //     **没有任何地方**能查到它崩在哪（主进程当时一处错误处理都没有，栈只活在
    //     那个框里）。事故的核心不是"缺日志"，而是"事后无法证明发生过什么"。
    //     现在异常同步落盘到 ~/.ai-browser/logs/error.jsonl，这个工具是让 agent
    //     自己就能问到"刚才报过什么错"的入口 —— 从"靠人复述"变成"可自查"。
    // 20 → 17（2026-10-19，有意变更）：
    //   browse_list_tabs / new_tab / close_tab / set_active_tab 合并为 browse_tabs{op}
    //   它们操作同一个实体、每个只承载一个动词，是工具膨胀里最没有道理的一种。
    //   参数只剩 op / tab / url 三个。
    //   没有顺手删 browse_repaint：它 400B，但删掉并不修掉渲染 bug，只会拿掉
    //   agent 唯一的恢复手段 —— 用稳定性换 token 是笔不划算的买卖。
    expect(MCP_TOOLS).toHaveLength(17);
  });

  it('新增的两个工具都保持精简描述（护栏：描述长度是每轮都要付的成本）', () => {
    for (const name of ['browse_diff', 'browse_capabilities', 'browse_screenshot']) {
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

  it('exposes browse_repaint (the "window shows a stale page" fallback)', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'browse_repaint');
    expect(t, 'browse_repaint must exist').toBeTruthy();
    // optional tab → no required fields
    expect(t.inputSchema.required).toBeUndefined();
    expect(t.inputSchema.properties.tab.type).toBe('integer');
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
    // 2026-10-19：get_value 的 offset/limit 收进 read 分组（顶层参数 27→13）。
    // 分组只是"读起来更省"；旧的扁平 offset/limit 仍被 mcp_args.actParams 接受，
    // 见 tests/test_mcp_args.js 的 G-1。
    expect(act.inputSchema.properties.read.properties.offset).toBeTruthy();
    expect(act.inputSchema.properties.read.properties.limit).toBeTruthy();
    expect(act.inputSchema.properties.offset).toBeUndefined();
  });

  it('browse_act 的 enum 必须覆盖处理层支持的每个动作（曾漏掉 setContent）', () => {
    const act = MCP_TOOLS.find((t) => t.name === 'browse_act');
    const verbs = act.inputSchema.properties.action.enum;
    // page_manager._executeActionInner 里逐个分支处理的动作
    for (const v of ['click', 'type', 'setContent', 'clear', 'focus', 'hover', 'scroll_to', 'upload', 'get_value', 'drag', 'press', 'wheel', 'paste']) {
      expect(verbs, `enum 缺少 ${v}，严格校验的客户端会拒绝这个动作`).toContain(v);
    }
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
      'browse_tabs',
      'browse_scroll'
    ]) {
      expect(names).toContain(kept);
    }
    // 合并后不再有这四个单动词工具
    for (const gone of ['browse_list_tabs', 'browse_new_tab', 'browse_close_tab', 'browse_set_active_tab']) {
      expect(names).not.toContain(gone);
    }
  });

  it('browse_tabs 的 op 覆盖四种标签页操作', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'browse_tabs');
    expect(t.inputSchema.properties.op.enum).toEqual(['list', 'new', 'close', 'switch']);
    expect(t.inputSchema.required).toEqual(['op']);
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

  it('every tool carries MCP annotations（目录/客户端渲染徽标，且是 Smithery 扫描项）', () => {
    for (const t of MCP_TOOLS) {
      expect(t.title, `${t.name} 需要 title`).toBeTruthy();
      expect(t.title.length, `${t.name} title 保持简短`).toBeLessThan(40);
      const a = t.annotations;
      expect(a, `${t.name} 需要 annotations`).toBeTruthy();
      for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof a[k], `${t.name}.annotations.${k}`).toBe('boolean');
      }
    }
  });

  it('读类工具标 readOnly；写/生命周期类不标', () => {
    const readOnly = MCP_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).toContain('browse_get_tree');
    expect(readOnly).toContain('browse_diff');
    expect(readOnly).toContain('browse_capabilities');
    expect(readOnly).toContain('browse_downloads');
    expect(readOnly).not.toContain('browse_navigate');
    expect(readOnly).not.toContain('browse_act');
    expect(readOnly).not.toContain('browse_evaluate');
    // browse_tabs 合并了 list（只读）与 new/close（写），整体不能标只读 ——
    // 否则客户端会把"关闭标签页"渲染成安全操作。
    expect(readOnly).not.toContain('browse_tabs');
  });

  it('只有 quit 标 destructive（close 合并进 browse_tabs 后不再单独标）', () => {
    const destructive = MCP_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    // 合并的语义代价：browse_tabs 里 close 是破坏性的，但同一个工具也做 list，
    // 只能整体标 false，把破坏性写在 description 里。代价记在这里，别忘。
    expect(destructive.sort()).toEqual(['browse_quit']);
  });

  it('触达远程页面的工具标 openWorld，纯本地生命周期/标签管理不标', () => {
    const open = new Set(MCP_TOOLS.filter((t) => t.annotations.openWorldHint).map((t) => t.name));
    expect(open.has('browse_navigate')).toBe(true);
    expect(open.has('browse_act')).toBe(true);
    expect(open.has('browse_evaluate')).toBe(true);
    expect(open.has('browse_quit')).toBe(false);
    expect(open.has('browse_tabs')).toBe(false);
  });
});
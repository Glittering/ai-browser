import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../src/main/mcp_tools.js';

describe('MCP tool list (token-cost guard)', () => {
  const names = MCP_TOOLS.map((t) => t.name);

  it('keeps exactly 13 tools', () => {
    expect(MCP_TOOLS).toHaveLength(13);
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
      'browse_subscribe',
      'browse_network_body',
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
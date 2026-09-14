// tests/test_config.js — unit tests for shared/config.js
// Verifies centralized defaults are byte-identical to legacy hardcoded values,
// that env overrides win, and that wsUrl() derives from config.wsPort.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('shared/config defaults', () => {
  // snapshot current env so we tear down any AI_BROWSER_* we inject
  const saved = {};
  const SAFE_KEYS = ['AI_BROWSER_PORT', 'AI_BROWSER_USER_DATA', 'AI_BROWSER_UA'];

  beforeEach(() => {
    for (const k of SAFE_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SAFE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('C-1: default wsPort is 9223 (legacy hardcoded value)', async () => {
    const { config } = await import('../src/shared/config.js?c1');
    expect(config.wsPort).toBe(9223);
  });

  it('C-2: default UA matches the legacy Chrome-130 spoof exactly', async () => {
    const { config } = await import('../src/shared/config.js?c2');
    expect(config.userAgent).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
  });

  it('C-3: default userDataDir points under the user home', async () => {
    const { config } = await import('../src/shared/config.js?c3');
    expect(config.userDataDir).toMatch(/\.ai-browser$/);
  });

  it('C-4: AI_BROWSER_PORT env override wins', async () => {
    process.env.AI_BROWSER_PORT = '9999';
    const { config } = await import('../src/shared/config.js?c4');
    expect(config.wsPort).toBe(9999);
  });

  it('C-5: AI_BROWSER_UA env override wins', async () => {
    process.env.AI_BROWSER_UA = 'Custom-UA/1.0';
    const { config } = await import('../src/shared/config.js?c5');
    expect(config.userAgent).toBe('Custom-UA/1.0');
  });

  it('C-6: wsUrl() uses config.wsPort by default, or an explicit port', async () => {
    const { config, wsUrl } = await import('../src/shared/config.js?c6');
    expect(wsUrl()).toBe(`ws://localhost:${config.wsPort}`);
    expect(wsUrl(9223)).toBe('ws://localhost:9223');
  });
});
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

  it('C-2: 默认 UA 按真实平台与真实内核版本算出来（不再有写死的 Mac 串）', async () => {
    const { config } = await import('../src/shared/config.js?c2');
    const ua = config.userAgent;
    // 写死 Mac 的那条是这次事故的根因：UA 说 Macintosh，而 navigator.platform /
    // sec-ch-ua-platform / GPU 后端全说 Windows，风控读到的是"UA 被改过"。
    const TOKENS = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7', linux: 'X11; Linux x86_64' };
    const token = TOKENS[process.platform] || TOKENS.linux;
    expect(ua, `UA 里的平台段必须是本机那一套（${process.platform}）`).toContain(token);
    for (const other of Object.values(TOKENS)) {
      if (other !== token) expect(ua, `UA 混进了别的平台的 token：${other}`).not.toContain(other);
    }
    const major = String(process.versions.chrome || '0').split('.')[0];
    if (major !== '0') expect(ua, 'UA 自称的 Chrome 大版本必须就是内核版本').toContain(`Chrome/${major}.0.0.0`);
    expect(ua, 'UA 里不许出现 Electron token').not.toMatch(/electron/i);
    // 身份不只是一条 UA 串：UA-CH 元数据必须与它同源，否则 header 与页面 JS 又各说一套。
    expect(config.identity.userAgent, 'config.userAgent 与 identity 必须是同一份').toBe(ua);
    expect(config.identity.metadata.platform).toBe(config.identity.platform);
    const brands = config.identity.metadata.brands.map((b) => b.brand);
    expect(brands, '品牌列表必须含 Google Chrome —— 只有 Chromium 品牌是 Google 报"浏览器不可信"的直接原因')
      .toContain('Google Chrome');
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

  it('C-5: AI_BROWSER_UA env override wins，且 UA-CH 跟着这条 UA 的平台走', async () => {
    process.env.AI_BROWSER_UA = 'Custom-UA/1.0';
    const { config } = await import('../src/shared/config.js?c5');
    expect(config.userAgent).toBe('Custom-UA/1.0');
    expect(config.identity.userAgent).toBe('Custom-UA/1.0');

    // 自定义 UA 写了别的平台时，client hints 必须跟着改口 —— 否则"改了 UA"这件事
    // 又会以 UA 与 sec-ch-ua-platform 不一致的形态重新出现。
    process.env.AI_BROWSER_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const mac = await import('../src/shared/config.js?c5b');
    expect(mac.config.identity.metadata.platform, 'UA 说 Mac，hints 就不能再说 Windows')
      .toBe('macOS');
  });

  it('C-6: wsUrl() uses config.wsPort by default, or an explicit port', async () => {
    const { config, wsUrl } = await import('../src/shared/config.js?c6');
    expect(wsUrl()).toBe(`ws://localhost:${config.wsPort}`);
    expect(wsUrl(9223)).toBe('ws://localhost:9223');
  });
});
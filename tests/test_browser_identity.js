// tests/test_browser_identity.js — 身份必须**自成一套**：UA、UA-CH 品牌、平台、Accept-Language 同源。
//
// 为什么单独一个文件（2026-11-01 的实测事故）：UA 写死成 macOS 的 Chrome/130，
// 而 navigator.platform=Win32、sec-ch-ua-platform="Windows"、WebGL 报 Intel D3D11。
// 真 Chrome 在同一台机器上是 Windows + Chrome/156 + "Google Chrome" 品牌。
// 也就是说：我们本来想藏指纹，结果造了一个"UA 被改过"的新指纹。
// 这里的断言只盯一件事 —— **任何两个字段不许互相打脸**。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const id = require('../src/shared/browser_identity.cjs');

describe('browser_identity — UA 与 client hints 同源', () => {
  const TOKENS = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    linux: 'X11; Linux x86_64',
  };

  it('ID-1: 每个平台的 UA 段与 UA-CH platform 成对出现', () => {
    const cases = [
      ['win32', 'Windows'],
      ['darwin', 'macOS'],
      ['linux', 'Linux'],
    ];
    for (const [platform, chPlatform] of cases) {
      const built = id.buildIdentity({ platform, chromeVersion: '130.0.6723.191', release: '10.0.19045', arch: 'x64' });
      expect(built.userAgent, `${platform} 的 UA 必须用本平台 token`).toContain(TOKENS[platform]);
      expect(built.metadata.platform, `${platform} 的 sec-ch-ua-platform`).toBe(chPlatform);
      expect(built.platform).toBe(chPlatform);
      for (const [other, token] of Object.entries(TOKENS)) {
        if (other === platform) continue;
        expect(built.userAgent, `${platform} 的 UA 混进了 ${other} 的 token`).not.toContain(token);
      }
    }
  });

  it('ID-2: Chrome 大版本进 UA，完整版本进 fullVersionList，两处不许差版本', () => {
    const built = id.buildIdentity({ platform: 'win32', chromeVersion: '130.0.6723.191', release: '10.0.19045' });
    expect(built.userAgent).toContain('Chrome/130.0.0.0');
    expect(built.chromeMajor).toBe('130');
    const chromium = built.metadata.fullVersionList.find((b) => b.brand === 'Chromium');
    expect(chromium.version).toBe('130.0.6723.191');
    // 短品牌（brands）里的大版本必须就是完整版本的第一段，否则 sec-ch-ua 与
    // sec-ch-ua-full-version-list 互相矛盾 —— 又是一个可判定的不一致。
    const shortChromium = built.metadata.brands.find((b) => b.brand === 'Chromium');
    expect(shortChromium.version).toBe(chromium.version.split('.')[0]);
  });

  it('ID-3: 品牌列表带 Google Chrome，GREASE 那项停在内核自己的值上', () => {
    const built = id.buildIdentity({ platform: 'win32', chromeVersion: '130.0.6723.191', release: '10.0.19045' });
    const names = built.metadata.brands.map((b) => b.brand);
    expect(names).toContain('Google Chrome');
    expect(names).toContain('Chromium');
    expect(names.filter((n) => /^Not\?A_Brand$/.test(n))).toHaveLength(1);
    // GREASE 品牌是随内核版本冻结的（Chromium 130 = "99"），不许顺手编一个。
    expect(built.metadata.brands.find((b) => b.brand === 'Not?A_Brand').version).toBe('99');
    expect(built.metadata.mobile).toBe(false);
  });

  it('ID-4: architecture 用 CPU 家族名，不是 process.arch', () => {
    const x64 = id.buildIdentity({ platform: 'win32', chromeVersion: '130.0.0.0', release: '10.0.19045', arch: 'x64' });
    expect(x64.metadata.architecture, 'Chrome 在 x64 Windows 上报 x86，64 位由 bitness 表达').toBe('x86');
    const arm = id.buildIdentity({ platform: 'darwin', chromeVersion: '130.0.0.0', release: '24.0.0', arch: 'arm64' });
    expect(arm.metadata.architecture).toBe('arm');
  });

  it('ID-5: platformVersion 按 OS 算，Windows 用 NT 版本、macOS 从 Darwin 版本推', () => {
    expect(id.platformVersionOf('win32', '10.0.19045')).toBe('10.0.0');
    expect(id.platformVersionOf('win32', '10.0.22631')).toBe('10.0.0');
    expect(id.platformVersionOf('darwin', '24.1.0')).toBe('15.0.0');
    expect(id.platformVersionOf('darwin', '23.6.0')).toBe('14.0.0');
    expect(id.platformVersionOf('linux', '6.5.0-14-generic')).toBe('6.5.0-14-generic');
    // 拿不到 release 时不许抛错，也不许编一个小版本号。
    expect(id.platformVersionOf('win32', '')).toBe('10.0.0');
  });

  it('ID-6: 自定义 UA 时 hints 跟着 UA 里的平台走', () => {
    const macUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    // 注意这里**不**传 platform：让函数自己在真实运行时的机器上按 UA 判平台。
    const built = id.buildIdentity({ userAgent: macUa, release: '23.4.0' });
    expect(built.userAgent).toBe(macUa);
    expect(built.metadata.platform, 'AI_BROWSER_UA 谎报 Mac 时，hints 必须一起改口，否则矛盾回来了').toBe('macOS');
    const winUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(id.buildIdentity({ userAgent: winUa, release: '10.0.19045' }).metadata.platform).toBe('Windows');
    // UA 里没有可辨认的平台 token（比如 Custom-UA/1.0）→ 退回本机平台，不许留空。
    const plain = id.buildIdentity({ userAgent: 'Custom-UA/1.0', release: '10.0.19045' });
    expect(['Windows', 'macOS', 'Linux']).toContain(plain.metadata.platform);
  });

  it('ID-7: Accept-Language 首选列表不带 q —— CDP 那一个字段同时进 header 和 navigator.languages', () => {
    // 带 q 的写法会让内核在 header 上叠出 `;q=0.9;q=0.9`，并把 `zh;q=0.9`
    // 当成一个语言标签塞进 navigator.languages（假 BCP47，站点一拆就穿帮）。
    expect(id.acceptLanguageOf('zh-CN')).toBe('zh-CN,zh');
    expect(id.acceptLanguageOf('en-US')).toBe('en-US,en');
    expect(id.acceptLanguageOf('zh_TW')).toBe('zh-TW,zh');
    expect(id.acceptLanguageOf('zh')).toBe('zh,en');
    expect(id.acceptLanguageOf('')).toBe('');
    for (const v of ['zh-CN', 'en-US', 'zh-TW']) {
      for (const tag of id.acceptLanguageOf(v).split(',')) {
        expect(/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag), `不是合法 BCP47：${tag}`).toBe(true);
      }
    }
  });

  it('ID-8: 导航用的 critical hints 与真 Chrome 同形，值来自同一份 metadata', () => {
    const built = id.buildIdentity({ platform: 'win32', chromeVersion: '130.0.6723.191', release: '10.0.19045', arch: 'x64' });
    const h = id.uaClientHintsOf(built.metadata);
    // Chrome 的写法：引号包品牌、;v="版本"、逗号 + 空格分隔。
    expect(h['sec-ch-ua']).toBe('"Not?A_Brand";v="99", "Chromium";v="130", "Google Chrome";v="130"');
    expect(h['sec-ch-ua-platform']).toBe('"Windows"');
    expect(h['sec-ch-ua-mobile']).toBe('?0');
    // 与 UA 同源：大版本、平台两处必须一致（这条是整个修复的立身之本）。
    expect(h['sec-ch-ua']).toContain(`;v="${built.chromeMajor}"`);
    expect(built.userAgent).toContain(`Chrome/${built.chromeMajor}.0.0.0`);
    expect(id.uaClientHintsOf({ ...built.metadata, mobile: true })['sec-ch-ua-mobile']).toBe('?1');
  });

  it('ID-9: isEnabledByDefault 只认显式的关闭值（该默认开的东西不能默认关）', () => {
    for (const v of ['0', 'off', 'OFF', 'false', 'no']) expect(id.isEnabledByDefault(v), String(v)).toBe(false);
    for (const v of ['1', 'on', 'true', 'yes', '', '   ']) expect(id.isEnabledByDefault(v), String(v)).toBe(true);
    expect(id.isEnabledByDefault(undefined)).toBe(true);
    expect(id.isEnabledByDefault(null)).toBe(true);
  });
});

describe('browser_identity — 页面 world 补丁的开关表', () => {
  it('SW-1: 解析三种取值（关 / 全开 / 域名列表）', () => {
    expect(id.parseHostSwitch(undefined)).toEqual({ mode: 'off', hosts: [] });
    expect(id.parseHostSwitch('')).toEqual({ mode: 'off', hosts: [] });
    expect(id.parseHostSwitch(' 0 ')).toEqual({ mode: 'off', hosts: [] });
    expect(id.parseHostSwitch('OFF')).toEqual({ mode: 'off', hosts: [] });
    for (const v of ['1', 'on', 'TRUE', 'yes', 'all']) expect(id.parseHostSwitch(v).mode, v).toBe('all');
    const list = id.parseHostSwitch(' A.com , b.io ');
    expect(list.mode).toBe('hosts');
    expect(list.hosts).toEqual(['a.com', 'b.io']);
  });

  it('SW-2: host 匹配按域边界，不做子串', () => {
    expect(id.hostMatches('excalidraw.com', ['excalidraw.com'])).toBe(true);
    expect(id.hostMatches('m.excalidraw.com', ['excalidraw.com'])).toBe(true);
    expect(id.hostMatches('evil-excalidraw.com', ['excalidraw.com']), '子串命中等于把白名单交给攻击者')
      .toBe(false);
    expect(id.hostMatches('excalidraw.com.evil.io', ['excalidraw.com'])).toBe(false);
    expect(id.hostMatches('', ['a.com'])).toBe(false);
    expect(id.hostMatches('a.com', [])).toBe(false);
  });
});

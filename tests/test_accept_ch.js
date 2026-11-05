// tests/test_accept_ch.js — UA-CH 授权这一半的钉子。
//
// 立此存照的实测（2026-11-05，同一台 Win10 机器、一个本地 https 回声服务，
// 读的是**服务器收到的请求头**）：
//   真 Chrome 156：文档响应带 Accept-CH 之后，同 origin 的 fetch 带 11 个 sec-ch-ua* 头；
//   Electron 45（内核同为 156.0.8078.80）：只带 3 个；CDP 下发再完整的
//   userAgentMetadata 也还是 3 个 —— 发高熵头的代码在 Chrome 浏览器层，Electron 没有。
// 所以授权记录与出口补头必须我们自己实现，这里钉的就是它的语义：
// **没授权不许多发，授权了才按 origin 发**。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acceptCh = require('../src/shared/accept_ch.cjs');

describe('accept_ch — 从响应头里读授权', () => {
  it('AC-1: Accept-CH 逗号清单，大小写归一 + 去重', () => {
    expect(acceptCh.parseGrant({
      'Accept-CH': 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness, sec-ch-ua-model',
    })).toEqual(['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model']);
    expect(acceptCh.parseGrant({
      'accept-ch': 'Sec-CH-UA-Arch, Sec-CH-UA-Arch',
    })).toEqual(['sec-ch-ua-arch']);
  });

  it('AC-2: HTTP/2 全小写键、数组值都能读；没有授权就是空', () => {
    expect(acceptCh.parseGrant({ 'accept-ch': ['Sec-CH-UA-Model', 'Sec-CH-UA-WoW64'] }))
      .toEqual(['sec-ch-ua-model', 'sec-ch-ua-wow64']);
    expect(acceptCh.parseGrant({ 'content-type': 'text/html' })).toEqual([]);
    expect(acceptCh.parseGrant(null)).toEqual([]);
    expect(acceptCh.parseGrant({})).toEqual([]);
  });

  it('AC-3: Link rel="accept-ch" 的 ch= 参数也算授权', () => {
    expect(acceptCh.parseGrant({
      link: '</style.css>; rel=preload, <https://a./>; rel="accept-ch"; ch="Sec-CH-UA-Form-Factors, Sec-CH-UA-Platform-Version"',
    })).toEqual(['sec-ch-ua-form-factors', 'sec-ch-ua-platform-version']);
    // rel 不是 accept-ch 的那条不许被当成授权。
    expect(acceptCh.parseGrant({ link: '</x.css>; rel=stylesheet' })).toEqual([]);
  });

  it('AC-4: 两种来源同时出现时合并去重（真站点的文档响应就是同时带）', () => {
    const names = acceptCh.parseGrant({
      'accept-ch': 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
      link: '<x>; rel="accept-ch"; ch="Sec-CH-UA-Bitness, Sec-CH-UA-Model"',
    });
    expect(names).toEqual(['sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model']);
  });
});

describe('accept_ch — origin 桶', () => {
  it('AC-5: origin 键含端口，默认端口归一；明文连接不参与', () => {
    // 默认端口写法两种都要落到同一个桶（443 省略 == 显式写 443）。
    expect(acceptCh.originKeyOf('https://accounts.google.com/v3/signin/identifier?x=1')).toBe('https://accounts.google.com');
    expect(acceptCh.originKeyOf('https://accounts.google.com:443/')).toBe('https://accounts.google.com');
    expect(acceptCh.originKeyOf('https://example.com:8443/a')).toBe('https://example.com:8443');
    expect(acceptCh.originKeyOf('wss://realtime.example/sock')).toBe('wss://realtime.example');
    expect(acceptCh.originKeyOf('http://127.0.0.1:8731/doc')).toBe('');
    expect(acceptCh.originKeyOf('not-a-url')).toBe('');
    expect(acceptCh.originKeyOf('')).toBe('');
  });

  it('AC-6: 授权只对**同一 origin**生效，别处一律不发（多发也是指纹）', () => {
    const store = acceptCh.createGrantStore(8);
    store.add('https://accounts.google.com/v3/signin/identifier', ['sec-ch-ua-arch']);
    expect(Array.from(store.grantedFor('https://accounts.google.com/x'))).toEqual(['sec-ch-ua-arch']);
    expect(store.grantedFor('https://www.google.com/')).toBe(null);
    expect(store.grantedFor('https://accounts.google.com:8443/')).toBe(null);
    expect(store.grantedFor('http://accounts.google.com/')).toBe(null);
  });

  it('AC-7: 多次授权累积，不互相抹掉', () => {
    const store = acceptCh.createGrantStore(8);
    store.add('https://a.example/', ['sec-ch-ua-arch']);
    store.add('https://a.example/', ['Sec-CH-UA-Model']);
    expect(Array.from(store.grantedFor('https://a.example/x')).sort())
      .toEqual(['sec-ch-ua-arch', 'sec-ch-ua-model']);
  });

  it('AC-8: 存储有界，超出按最早写入淘汰（长跑不涨）', () => {
    const store = acceptCh.createGrantStore(3);
    for (const host of ['a', 'b', 'c', 'd']) store.add(`https://${host}.example/`, ['sec-ch-ua-arch']);
    expect(store.size()).toBe(3);
    expect(store.grantedFor('https://a.example/')).toBe(null);
    expect(store.grantedFor('https://d.example/')).not.toBe(null);
  });

  it('AC-9: 非法 url / 空头不写桶，也不炸', () => {
    const store = acceptCh.createGrantStore(4);
    expect(store.add('http://plain.example/', ['sec-ch-ua-arch'])).toBe(false);
    expect(store.add('garbage', ['sec-ch-ua-arch'])).toBe(false);
    expect(store.add('https://ok.example/', [null, '', 'sec-ch-ua-model'])).toBe(true);
    expect(Array.from(store.grantedFor('https://ok.example/'))).toEqual(['sec-ch-ua-model']);
    expect(store.size()).toBe(1);
  });
});

// src/shared/auth_wall.cjs 的单测。
//
// 用例全部来自 2026-10-17 那次真实事故的现场数据，不是假想输入：
//   - CSDN 未登录时的真实 cookie 串（含 csrfToken —— 旧实现就是被它骗的）
//   - CSDN 登录墙的真实跳转目标 URL
//   - 掘金/B站/知乎正常工作页的真实 URL
// 这些是回归防线：谁再把 cookie 判定改回子串匹配，这里会红。

import { describe, it, expect } from 'vitest';
import {
  isAuthCookieName,
  parseCookieNames,
  detectAuthWall,
  looksLoggedIn,
} from '../src/shared/auth_wall.cjs';

// CSDN 未登录态下 document.cookie 的真实内容（2026-10-17 抓取）。
// 注意：有 csrfToken，没有 UserName / UserInfo / UserToken。
const CSDN_LOGGED_OUT_COOKIE =
  'uuid_tt_dd=10_288272290-1758000000000-123456; ' +
  'fid=20_abc123; ' +
  'UN=x_x_x; ' +
  'BT=1758000000000; ' +
  'p_uid=U123456; ' +
  'csrfToken=9f8e7d6c5b4a39281706fedcba0987654321';

// 同一台机器登录 CSDN 之后的 cookie（有真鉴权项）。
const CSDN_LOGGED_IN_COOKIE =
  'UserName=weixin_39287419; ' +
  'UserInfo=abc123def456; ' +
  'UserToken=eyJhbGciOiJIUzI1NiJ9.payload.sig; ' +
  'csrfToken=9f8e7d6c5b4a39281706fedcba0987654321';

describe('isAuthCookieName — cookie 名判定（旧实现的坑在这里）', () => {
  it('csrfToken 不算登录证据 —— 这正是 CSDN 误判的直接原因', () => {
    expect(isAuthCookieName('csrfToken')).toBe(false);
    expect(isAuthCookieName('XSRF-TOKEN')).toBe(false);
    expect(isAuthCookieName('_csrf')).toBe(false);
  });

  it('真鉴权 cookie 名算证据', () => {
    expect(isAuthCookieName('UserName')).toBe(true);
    expect(isAuthCookieName('UserToken')).toBe(true);
    expect(isAuthCookieName('UserInfo')).toBe(true);
    expect(isAuthCookieName('session')).toBe(true);
    expect(isAuthCookieName('SESSIONID')).toBe(true);
    expect(isAuthCookieName('jwt')).toBe(true);
    expect(isAuthCookieName('access_token')).toBe(true);
  });

  it('裸名整体匹配才算，子串不算', () => {
    // 旧实现 document.cookie.indexOf("token") 会把下面这个判成已登录
    expect(isAuthCookieName('mytokenstore_v2')).toBe(false);
    expect(isAuthCookieName('tokenizer_config')).toBe(false);
  });

  it('空名/垃圾输入不炸', () => {
    expect(isAuthCookieName('')).toBe(false);
    expect(isAuthCookieName(null)).toBe(false);
    expect(isAuthCookieName(undefined)).toBe(false);
  });
});

describe('parseCookieNames', () => {
  it('拆出名字，忽略值', () => {
    const names = parseCookieNames(CSDN_LOGGED_OUT_COOKIE);
    expect(names).toContain('csrfToken');
    expect(names).toContain('p_uid');
    expect(names).not.toContain('10_288272290-1758000000000-123456');
  });

  it('空串返回空数组', () => {
    expect(parseCookieNames('')).toEqual([]);
    expect(parseCookieNames(undefined)).toEqual([]);
  });
});

describe('detectAuthWall — URL 判定', () => {
  it('CSDN 登录墙真实跳转目标：passport 主机命中', () => {
    const r = detectAuthWall({ url: 'https://passport.csdn.net/login?code=applets' });
    expect(r.detected).toBe(true);
    expect(r.reason).toBe('auth_host');
    expect(r.matched).toBe('passport');
  });

  it('常见登录路径命中', () => {
    for (const url of [
      'https://example.com/login',
      'https://example.com/signin?next=/post/123',
      'https://example.com/sign-in',
      'https://example.com/passport/callback',
      'https://sso.example.com/oauth/authorize?client_id=x',
      'https://example.com/cas/login',
    ]) {
      expect(detectAuthWall({ url }).detected, url).toBe(true);
    }
  });

  it('正常工作页不误判 —— 讲登录的文章/文档页不能算登录墙', () => {
    for (const url of [
      'https://juejin.cn/post/7697024318929633320',
      'https://zhuanlan.zhihu.com/p/2094594014632793355',
      'https://www.bilibili.com/opus/1259878383752314888',
      'https://www.toutiao.com/article/7697326423064773160/',
      'https://example.com/blog/login-best-practices',
      'https://example.com/docs/oauth-intro',
      'https://editor.csdn.net/md/',
      'https://www.csdn.net/',
    ]) {
      expect(detectAuthWall({ url }).detected, url).toBe(false);
    }
  });

  it('密码输入框是独立硬事实', () => {
    const r = detectAuthWall({ url: 'https://example.com/weird/entry', hasPasswordInput: true });
    expect(r.detected).toBe(true);
    expect(r.reason).toBe('password_field');
  });

  it('没有 URL 也不炸', () => {
    expect(detectAuthWall({}).detected).toBe(false);
    expect(detectAuthWall(undefined).detected).toBe(false);
  });

  it('畸形 URL 退化成字符串匹配而不是静默放过', () => {
    const r = detectAuthWall({ url: 'not a url at all /login' });
    expect(r.detected).toBe(true);
  });
});

describe('looksLoggedIn — 收紧后的启发式', () => {
  it('CSDN 未登录：cookie 里有 csrfToken，必须判未登录', () => {
    // 旧实现在这一条上返回 true（谎报），是整次误判的起点
    const r = looksLoggedIn({
      url: 'https://www.csdn.net/',
      cookieString: CSDN_LOGGED_OUT_COOKIE,
    });
    expect(r.logged_in).toBe(false);
    expect(r.evidence).toEqual([]);
  });

  it('CSDN 已登录：UserName/UserToken 在，判已登录', () => {
    const r = looksLoggedIn({
      url: 'https://editor.csdn.net/md/',
      cookieString: CSDN_LOGGED_IN_COOKIE,
    });
    expect(r.logged_in).toBe(true);
    expect(r.evidence).toContain('auth_cookie');
  });

  it('auth_wall 是硬否决：哪怕 cookie 看着像登录的', () => {
    const r = looksLoggedIn({
      url: 'https://passport.csdn.net/login?code=applets',
      cookieString: CSDN_LOGGED_IN_COOKIE,
    });
    expect(r.logged_in).toBe(false);
    expect(r.evidence).toEqual(['auth_wall:auth_host']);
  });

  it('头像也算证据（没有 cookie 权限时的兜底）', () => {
    const r = looksLoggedIn({
      url: 'https://www.bilibili.com/',
      hasAvatar: true,
      cookieString: '',
    });
    expect(r.logged_in).toBe(true);
    expect(r.evidence).toContain('avatar');
  });

  it('cookieNames 直传与 cookieString 等价', () => {
    const a = looksLoggedIn({ url: 'https://x.com/', cookieString: CSDN_LOGGED_OUT_COOKIE });
    const b = looksLoggedIn({
      url: 'https://x.com/',
      cookieNames: parseCookieNames(CSDN_LOGGED_OUT_COOKIE),
    });
    expect(a).toEqual(b);
  });
});

// ---- P1-1 验收中抓到的误报：CSDN 文章页有视觉隐藏的登录表单 ----
// 纯函数层的契约：调用方（extractor）负责只把**可见**密码框报上来。
// 这里锁死"没有密码框 → 不判登录墙"，防止有人再把探测放宽回去。
describe('password_field 只应由可见密码框触发', () => {
  it('AW-PWD-1: 无密码框时不判登录墙（已登录工作页的常态）', () => {
    const r = detectAuthWall({ url: 'https://blog.csdn.net/weixin_39287419/article/details/168241019', hasPasswordInput: false });
    expect(r.detected).toBe(false);
  });

  it('AW-PWD-2: 有可见密码框才判（调用方已过滤隐藏表单）', () => {
    const r = detectAuthWall({ url: 'https://example.com/some/page', hasPasswordInput: true });
    expect(r.detected).toBe(true);
    expect(r.reason).toBe('password_field');
  });

  it('AW-PWD-3: URL 命中登录域时无需密码框也判（优先级高于一切）', () => {
    const r = detectAuthWall({ url: 'https://passport.csdn.net/login', hasPasswordInput: false });
    expect(r.detected).toBe(true);
    expect(r.reason).toBe('auth_host');
  });
});

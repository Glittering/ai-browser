// 登录墙 / 登录态探测。
//
// 为什么需要它（来自一次真实事故，不是假想）：
//   2026-10-17 往 CSDN 发文章，会话早已失效，editor.csdn.net/md/ 被 302 到
//   passport.csdn.net/login?code=applets。此时 ui.get_tree / ui.evaluate / ui.act
//   全部照常返回、毫无异常，操作在这个状态下继续了很久，最后失败被归因到
//   bizapi 的 401 上 —— 而那只是会话失效的下游表现。排查顺序从最基础的
//   "我还登着吗"就已经偏了。
//
// 更糟的是 context.session.logged_in 当时**主动说了谎**。它的 cookie 判定是：
//       document.cookie.indexOf("token") >= 0
//   CSDN 未登录时 cookie 串里照样有 csrfToken —— 子串命中 "token"，于是判定
//   logged_in = true。一个本该报警的字段，变成了掩护。
//
// 所以这里做三件事：
//   1. cookie 判定按**名字**匹配，并显式排除 csrf/xsrf 类（它们恰恰在未登录时也存在）；
//   2. 提供显式的 auth_wall 信号 —— URL 命中登录域 / 页面上有密码输入框。它必须是
//      一眼可见的前置信号，而不是埋在 context 里的某个小字段；
//   3. logged_in 收紧：去掉"正文超过 1000 字就算登录"这种没有信息量的兜底
//      （CSDN 登录页正文远超 1000 字，而误判方向是"说有登录"——代价最高的方向）。
//
// 诚实边界：这些都是启发式，权威信号只有 auth_wall.detected（URL / 密码框是硬事实）。
// logged_in 的语义是"看着像登录态"，宁紧勿松 —— 误报未登录只会让调用方多验一次，
// 误报已登录会让它带着错误假设走完整条流程。

/** 主机名里的登录/鉴权服务标识。 */
const AUTH_HOST_RE = /(^|\.)(passport|login|signin|sso|auth|accounts|id)\./i;

/**
 * 路径段里的登录墙标识。按**段边界**匹配，不是全文 indexOf ——
 * `/blog/login-tips` 这种讲登录的文章页不该被判成登录墙。
 */
const LOGIN_PATH_RE =
  /(^|\/)(login|log-in|signin|sign-in|passport|sso|oauth|authorize|cas)(\/|$|[?#.])/i;

/**
 * cookie 名表示"已登录"的白名单（按完整名字/段匹配，不是任意子串）。
 *
 * 踩过的坑（都是真实数据，不是假想）：
 *   - `uid` / `userid` **不能**进白名单：CSDN 未登录时的 `p_uid` 是埋点 partner id，
 *     旧口径放它进去会让未登录态被判成已登录 —— 正是要防的那类误判；
 *   - `UserName` / `UserInfo` / `UserToken` 必须进：它们是 CSDN 的真鉴权项，
 *     而 "token" 前后没有分隔符，靠 (^|_)token(_|$) 这种段匹配抓不到。
 */
const AUTH_COOKIE_NAME_RE =
  /(^|_|-)(token|auth|session|sessionid|sid|jwt|login|loggedin|logged_in|access_token|refresh_token|username|userinfo|usertoken|nickname|uname)(_|$|-)/i;

/**
 * cookie 名排除项。csrf/xsrf token 是防跨站用的，未登录时照样存在 ——
 * 把它算进登录证据，正是 CSDN 那次误判的直接原因。
 */
const CSRF_COOKIE_NAME_RE = /csrf|xsrf|_stm|stm_/i;

/**
 * 这个 cookie 名能不能作为"已登录"的证据。
 * @param {string} name cookie 名（不含值）
 * @returns {boolean}
 */
function isAuthCookieName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (CSRF_COOKIE_NAME_RE.test(n)) return false;
  if (AUTH_COOKIE_NAME_RE.test(n)) return true;
  // 一些站点用裸名，如 `TOKEN` / `SESSION` / `Auth` / `UserName`。整体匹配才算，
  // 避免 `csrfToken` 这类复合名靠子串蒙混过关。
  return /^(token|auth|session|sessionid|sid|jwt|username|userinfo|usertoken|nickname|uname|login|loggedin)$/.test(n);
}

/**
 * 把 `document.cookie` 串拆成名字列表。只需要名字，不解析值
 * （值可能含 base64 的 '='，按第一个 '=' 切就够了）。
 * @param {string} cookieString
 * @returns {string[]}
 */
function parseCookieNames(cookieString) {
  return String(cookieString || '')
    .split(';')
    .map((kv) => kv.split('=')[0].trim())
    .filter(Boolean);
}

/**
 * 登录墙探测。命中任一硬事实即 detected：
 *   - URL 的 host 命中登录/鉴权服务域名（passport.csdn.net、sso.example.com…）
 *   - URL 的 path 命中登录墙路径段（/login、/signin、/passport、/oauth/authorize…）
 *   - 页面上存在可见的密码输入框
 *
 * 纯文本"登录"字样**不**作为独立触发条件：大量正常页面都含这两个字
 * （登录引导按钮、文档标题…），拿它当证据会把 auth_wall 变成噪音，
 * 而噪音信号比没有信号更糟 —— 调用方会学会忽略它。
 *
 * @param {{url?: string, hasPasswordInput?: boolean}} input
 * @returns {{detected: boolean, reason: string|null, matched: string|null}}
 */
function detectAuthWall(input) {
  const url = String((input && input.url) || '');
  const hasPasswordInput = !!(input && input.hasPasswordInput);

  let host = '';
  let path = '';
  try {
    const u = new URL(url, 'http://relative.invalid');
    host = u.hostname || '';
    path = u.pathname || '';
  } catch (e) {
    // URL 解析失败时退化成字符串匹配，总比静默不判好。
    host = url;
    path = url;
  }

  const hostMatch = host.match(AUTH_HOST_RE);
  if (hostMatch) {
    // 去掉首尾的点：matched 要能直接读（"passport" 而不是 "passport."）。
    return { detected: true, reason: 'auth_host', matched: hostMatch[0].replace(/^\.+|\.+$/g, '') };
  }
  const pathMatch = path.match(LOGIN_PATH_RE);
  if (pathMatch) {
    return { detected: true, reason: 'login_path', matched: pathMatch[0] };
  }
  if (hasPasswordInput) {
    return { detected: true, reason: 'password_field', matched: null };
  }
  return { detected: false, reason: null, matched: null };
}

/**
 * "看着像登录态吗"——收紧过的启发式。
 *
 * 与旧实现的差别：
 *   - 删掉 `bodyText.length > 1000`（没有信息量，且误判方向是"说有登录"）；
 *   - cookie 按名字判，csrf 类显式排除；
 *   - auth_wall.detected 是硬否决项：已经在登录墙上，不可能同时是登录态。
 *
 * @param {{url?: string, hasPasswordInput?: boolean, hasAvatar?: boolean,
 *          cookieString?: string, cookieNames?: string[]}} input
 * @returns {{logged_in: boolean, evidence: string[]}}
 */
function looksLoggedIn(input) {
  const url = String((input && input.url) || '');
  const wall = detectAuthWall({ url, hasPasswordInput: input && input.hasPasswordInput });
  const evidence = [];

  if (wall.detected) {
    return { logged_in: false, evidence: ['auth_wall:' + wall.reason] };
  }

  let cookieNames = (input && input.cookieNames) || parseCookieNames(input && input.cookieString);
  const hasAuthCookie = cookieNames.some(isAuthCookieName);
  if (hasAuthCookie) evidence.push('auth_cookie');
  if (input && input.hasAvatar) evidence.push('avatar');

  return { logged_in: hasAuthCookie || !!(input && input.hasAvatar), evidence };
}

module.exports = {
  AUTH_HOST_RE,
  LOGIN_PATH_RE,
  isAuthCookieName,
  parseCookieNames,
  detectAuthWall,
  looksLoggedIn,
};
